/**
 * System One decision client + routing policy for the auto model router.
 *
 * This module is dependency-free on purpose: it is loaded inside the DSH host
 * process, where the plugin package only has its own files. The decision model
 * is Alibaba Bailian's `decision-model-preview`, which speaks the TypeSafe
 * System One protocol: one forward pass over `state` plus typed `questions`
 * (choice / noul / score) returns typed answers and probabilities, never text.
 * Docs: https://docs.bailian.console.aliyun.com/zh/model-studio/decision-model-api
 */

import { DIMENSIONS, PROFILES, SHAPE_WEIGHTS } from './select.js'

/** Default route catalog. All entries are provider/model ids already configured in the profile. */
export const DEFAULT_ROUTES = {
  fast: {
    provider: 'bailian-tokenplan',
    model: 'qwen3.8-flash',
    envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 },
    description:
      'Reading and reporting: a single known lookup or command, renames, formatting, an edit whose location is already known, short summaries. Not for multi-file changes, new features, or debugging unexplained behaviour.',
  },
  balanced: {
    provider: 'bailian-tokenplan',
    model: 'deepseek-v4.1-flash-1017',
    envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 },
    description:
      'Implementing and fixing: code across a few files, adding a feature, standard debugging with a known reproduction, tests beside the change, tool-heavy multi-step work.',
  },
  deep: {
    provider: 'bailian-tokenplan',
    model: 'qwen3.7-max',
    envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 },
    description:
      'Design and hard problems: architecture, refactors across modules or layers, debugging without a known cause, migrations and other risky changes, reasoning over many constraints at once.',
  },
}

/**
 * How much certainty each judgement needs before it changes routing.
 *
 * `acknowledge` is the only intent that makes a turn cheap, so it needs the
 * model's confidence: measured on this model, acknowledgements score 0.47-0.99
 * while real work scores 0.86-0.97, and a threshold in between keeps "ok" from
 * being priced as a greeting it was not.
 *
 * A model request needs both a stated model and the judgement that the name in
 * the message is a request: on this model, explicit requests score 0.94-0.98 on
 * `modelRequest` while the same model ids quoted from logs scored 0.20.
 */
export const ACKNOWLEDGE_MIN_CONFIDENCE = 0.6
export const MODEL_REQUEST_MIN_PROBABILITY = 0.5
export const MODEL_REQUEST_MIN_CONFIDENCE = 0.5

export const DEFAULT_DECISION = {
  baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  credentialRef: 'BAILIAN_TOKENPLAN_API_KEY',
  model: 'decision-model-preview',
  timeoutMs: 3500,
  maxMessages: 10,
  maxStateChars: 12000,
  maxMessageChars: 2000,
}

export const DEFAULT_POLICY = {
  // A choice below either floor is treated as too weak to trust outright. Half
  // the mass is the point where a choice stops being better than the score: on
  // the decision model's short requests confidence clusters around 0.3-0.5, so
  // a lower floor would let a coin flip outrank the complexity axis.
  minConfidence: 0.5,
  minProbability: 0.5,
  // How sure the decision model must be that a message only acknowledges before
  // the turn is priced at zero, and that a model name is a request rather than a
  // mention. Both are measured: acknowledgements score 0.47-0.99 while real work
  // scores 0.86-0.97, and explicit model requests score 0.94-0.98 on
  // `modelRequest` where the same ids quoted from logs score 0.20.
  acknowledgeConfidence: ACKNOWLEDGE_MIN_CONFIDENCE,
  modelRequestConfidence: MODEL_REQUEST_MIN_PROBABILITY,
  // Changing the route mid-session needs at least this much confidence.
  switchConfidence: 0.4,
}

const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const SKIP_SOURCE_KINDS = new Set(['runtime-context', 'model-selection', 'system-prompt'])

/** Trim one string to `max` characters with an explicit ellipsis marker. */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Flatten one message's content blocks into a compact role-labelled line. */
export function messageText(message, maxChars = 2000) {
  const parts = []
  for (const block of message.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'tool-call') parts.push(`[tool-call ${block.name ?? '?'} ${clip(String(block.arguments ?? ''), 500)}]`)
    else if (block?.type === 'tool-result') parts.push(`[tool-result ${block.isError === true ? 'error' : 'ok'}]`)
    else if (block?.type === 'image' || block?.type === 'image_url') parts.push('[image]')
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim()
  return `${message.role ?? 'user'}: ${clip(text, maxChars)}`
}

function stateFromMessages(messages, claimed, config, meta) {
  const { maxMessages = 10, maxStateChars = 12000, maxMessageChars = 2000 } = config.decision ?? config
  const recent = Array.isArray(messages) ? messages.slice(-maxMessages) : []
  const filtered = recent.filter((m) => m.source?.kind !== 'runtime-context')
  const claimedList = Array.isArray(claimed) ? claimed.filter((m) => m !== null && m !== undefined) : []
  const claimedLines = claimedList.map((m) => messageText(m, maxMessageChars))
  const lines = [...filtered.map((m) => messageText(m, maxMessageChars)), ...claimedLines]
  const tools = Array.isArray(meta?.toolNames) ? meta.toolNames.slice(0, 12) : []
  const agent = meta?.agentKind ?? 'main'
  const session = claimedList.length > 0 ? 'steered' : 'no steering'

  // The session digest frames the recent messages: it says which task these
  // steps belong to, so a one-line edit inside a migration is not read as a
  // one-line edit on a fresh request.
  const rawDigest = typeof meta?.digest === 'string' && meta.digest.trim().length > 0 ? meta.digest.trim() : null
  // Even a misconfigured digest cannot crowd out the messages being routed: it
  // is capped at a third of the state budget, with the remainder for the turns.
  const digestCap = Math.max(200, Math.floor(maxStateChars / 3))
  const digest = rawDigest === null ? null : clip(rawDigest, digestCap)
  // Framing matters more than the digest itself: without this line the model
  // scores the session described above, so a mid-task step inherits the session's
  // difficulty and every turn looks equally hard.
  const digestBlock =
    digest === null
      ? ''
      : `[session-digest]\n${digest}\n[end-session-digest]\n` +
        `Score depth and breadth for the request being routed (the last user message below), not for the session above. ` +
        `Use the digest only to judge risk and the constraints that must hold.\n`

  // Budget overflow must drop the oldest turns, not the newest: the newest
  // message is the request being routed. The digest is charged against the same
  // budget so the whole state stays one bounded string.
  const body = lines.join('\n')
  const budget = Math.max(1500, maxStateChars - digestBlock.length)
  const bounded = body.length <= budget ? body : `…${body.slice(body.length - budget)}`
  const text =
    meta !== undefined
      ? `[router] agent=${agent} | ${session} | tools=${tools.length}${tools.length > 0 ? ` (${tools.join(',')})` : ''}\n${digestBlock}${bounded}`
      : bounded

  // Extract the last non-runtime user message as the "task" for logging
  const lastUser = [...filtered, ...(Array.isArray(claimed) ? claimed : [])].findLast((m) => m?.role === 'user')
  const task = lastUser ? clip(lastUser.content?.[0]?.text ?? '', 100) : ''

  // Build message IDs for signature
  const messageIds = `${filtered.length}:${lastUser?.content?.[0]?.text?.length ?? 0}`

  return { text, task, messageIds }
}

export function buildState(messages, claimed, config, meta) {
  return stateFromMessages(messages, claimed, config, meta)
}

/**
 * Build the typed questions the decision model answers.
 *
 * System One takes ONE object keyed by question id. `choice` questions carry a
 * `criteria` map whose keys are the allowed answers (the model's option
 * descriptions are its only way to know what an answer means); `score`
 * questions carry `criteria` as an ordered list where list position IS the
 * score, so five anchors give a 0-4 scale; `noul` questions are a single
 * probability and take no criteria.
 *
 * @param {object} routes - route catalog (unused; the profile names no model).
 * @param {{notes?: Record<string,string>}} options
 * @returns {object} questions object for the System One protocol.
 */
export function buildQuestions(routes, options = {}) {
  const shapeCriteria = {}
  for (const profile of PROFILES) shapeCriteria[profile.id] = profile.hint

  return {
    shape: {
      type: 'choice',
      criteria: shapeCriteria,
      instructions:
        'Pick the ONE shape that describes what the user wants done, not the tool they would use. ' +
        'A request to change code in a known place is edit; a request that adds capability that does not exist yet is implement. ' +
        'A request to find out why something misbehaves is debug even when the answer is a one-line fix. ' +
        'A request to judge work that exists is review. A request that asks how something should be built is design. ' +
        'When two shapes fit, pick the one that names the hardest part of the work.',
    },
    depth: {
      type: 'score',
      criteria: [
        'acknowledgement: an answer of one word or one sentence, a greeting, an instruction to just reply — no reasoning at all',
        'single step: one lookup, one known edit, one command; nothing to decide',
        'a few steps: several files or one small design choice; the approach is still obvious',
        'genuinely hard: cross-module change, non-obvious debugging, or a tool chain whose steps depend on each other',
        'hardest: architecture, long-horizon planning, a risky migration, or reasoning that must hold many constraints at once',
      ],
      instructions:
        'Score the hardest step this request implies, not the average step. ' +
        'A request whose first step is easy but whose last step needs cross-module reasoning scores by the last step. ' +
        'Score the work, not the wording: a short request can be deep ("make it thread-safe") and a long one shallow. ' +
        'Be strict about the bottom of the scale — most conversational messages are 0 (acknowledgements, one-line answers, "reply OK") or 1 (a single lookup or edit). ' +
        'Reserve 3 for work you could not finish in one pass, and 4 for work you would plan before starting.',
    },
    breadth: {
      type: 'score',
      criteria: [
        'one fact, one file, or nothing at all (a reply that needs no code)',
        'one module or one directory',
        'two or three files that must agree',
        'several modules or a large transcript',
        'most of the repository, or a document longer than the context window',
      ],
      instructions:
        'Score how much of the codebase or conversation must be held at once to do the work correctly. ' +
        'A request that only asks for an answer, an acknowledgement, or a status reply scores 0: no file is in play.',
    },
    risk: {
      type: 'score',
      criteria: [
        'none: nothing is changed; a wrong answer costs a retry, and an acknowledgement cannot be wrong',
        'trivial: an edit so small that a mistake is obvious immediately and costs one line to fix',
        'moderate: breaks tests, blocks a teammate, or needs a revert',
        'high: breaks a live system, loses data, or ships a regression',
        'critical: security, irreversible migration, or a change others depend on',
      ],
      instructions:
        'Score the cost of the model being wrong, not the likelihood. ' +
        'Read-only analysis and conversational replies are 0 even when they are hard; a one-line production change can be 3 even when it is easy.',
    },
    intent: {
      type: 'choice',
      criteria: {
        acknowledge: 'the message only acknowledges, thanks, confirms, or says the user is done — nothing is asked to be done, and no work is in flight',
        resume: 'the message tells the assistant to carry on, continue, proceed, or do the next step of work that is already in progress',
        work: 'the message asks for something specific: a question, a change, a check, a decision',
      },
      instructions:
        'Decide what the message asks of the assistant right now. ' +
        '`acknowledge` is only for messages that request no action at all — a bare ok, thanks, or acknowledgement. ' +
        'If the session shows work in progress (tool calls, an unfinished plan, a task the assistant already started) then a short word like "ok" or "continue" is `resume`, not `acknowledge`: the assistant is expected to keep working. ' +
        'When a message could be either a courtesy and an instruction, treat it as an instruction — the cost of continuing work is lower than the cost of silently stopping.',
    },
    ...(Array.isArray(options.models) && options.models.length > 0
      ? {
          model: {
            type: 'choice',
            criteria: Object.fromEntries([
              ['auto', 'no model was named; let the router choose from the request itself'],
              ...options.models.map((id) => [id, `the request names or clearly asks for ${id}`]),
            ]),
            instructions:
              'Answer `auto` unless the user explicitly names a model or says which model to use for this request. ' +
              'A named model is an instruction, not a suggestion: choosing anything else overrides the user. ' +
              'A model name that merely appears in code, logs, or discussion of past work is not a request.',
          },
          modelRequest: {
            type: 'noul',
            instructions:
              'Is the user asking the assistant to handle THIS request with a particular model? ' +
              'A request says what to use now, in the user\'s own words ("use X", "switch to X", "answer with X"). ' +
              'Mentions are not requests: a model name inside a log line, an error message, a config file, a code snippet, or a discussion about past behaviour scores 0. ' +
              'Answer the probability that the user is instructing a change.',
          },
        }
      : {}),
    vision: {
      type: 'noul',
      instructions:
        'Does answering correctly require reading pixels — a screenshot, diagram, chart, or UI state that only an image conveys? ' +
        'Text describing an image does not count. Answer the probability that the task cannot be done from text alone.',
    },
    tools: {
      type: 'noul',
      instructions:
        'Does the task require tool calls — running commands, reading or writing files, or calling external systems — ' +
        'rather than only producing prose? Answer the probability.',
    },
    latency: {
      type: 'noul',
      instructions:
        'Is the user waiting interactively for this answer, so that a multi-second first token would be felt? ' +
        'Batch jobs, background refactors, and overnight analysis are not interactive. Answer the probability.',
    },
  }
}

function normalizeAnswers(body) {
  const answers = body?.answers
  if (!answers || typeof answers !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(answers)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = { value, confidence: 1 }
      continue
    }
    if (typeof value !== 'object') continue
    // Idempotent: a already-normalized answer ({ value, confidence }) passes through.
    if (value.value !== undefined) {
      out[key] = { value: value.value, probability: value.probability, confidence: num(value.confidence, 1) }
      continue
    }
    if (typeof value.choice === 'string') {
      const probabilities = value.probabilities ?? {}
      out[key] = { value: value.choice, confidence: num(value.confidence, probabilities[value.choice] ?? 0.7) }
    } else if (typeof value.score === 'number') {
      out[key] = { value: value.score, confidence: num(value.confidence, 1) }
    } else if (typeof value.noul === 'number') {
      // Confidence in the derived boolean is how far the probability sits from a
      // coin flip, on the side it landed.
      // Threshold above 0.5 on purpose: a false positive removes every text-only
      // model from the pool, which is a much worse error than missing a
      // marginal image.
      const threshold = key === 'vision' ? 0.6 : 0.5
      out[key] = { value: value.noul >= threshold, probability: value.noul, confidence: Math.max(value.noul, 1 - value.noul) }
    } else if (typeof value.answer === 'string' || typeof value.answer === 'number') {
      out[key] = { value: value.answer, confidence: num(value.confidence, 0.7) }
    }
  }
  return out
}

/**
 * Parse the decision model's reply into a task profile.
 * @param {object} raw - raw response body from System One.
 * @param {object} routes - current route catalog (unused, kept for compatibility).
 * @returns {{profile: import('./select.js').TaskProfile, confidence: number, source: string}}
 */
export function parseDecision(raw, routes, policy) {
  // `raw` may be the System One body ({ answers: {...} }) or an already
  // normalized map. Normalizing twice used to silently drop every answer, so
  // the two shapes are handled explicitly here rather than relying on
  // idempotence.
  const normalized =
    raw?.answers !== undefined
      ? normalizeAnswers(raw)
      : Object.fromEntries(
          Object.entries(raw ?? {}).filter(([, value]) => value !== null && typeof value === 'object' && 'value' in value),
        )
  const shape = typeof normalized.shape?.value === 'string' ? normalized.shape.value : 'implement'
  const clampScore = (value, fallback) => {
    const n = typeof value === 'number' ? value : fallback
    return Math.max(0, Math.min(4, Math.round(n * 10) / 10))
  }
  const profile = {
    shape,
    depth: clampScore(normalized.depth?.value, 2),
    breadth: clampScore(normalized.breadth?.value, 2),
    risk: clampScore(normalized.risk?.value, 1.5),
    vision: normalized.vision?.value === true,
    tools: normalized.tools?.value === true,
    latencyCritical: normalized.latency?.value === true,
  }
  const confidences = Object.values(normalized).map((v) => v.confidence ?? 1)
  const confidence = confidences.length > 0 ? Math.min(...confidences) : 1

  // What the message asks of the assistant. `acknowledge` is the only value that
  // prices a turn cheap, and only when the model is sure; a low-confidence answer
  // falls through to the profile's own scores, which err high.
  const intent = typeof normalized.intent?.value === 'string' ? normalized.intent.value : null
  const intentConfidence = num(normalized.intent?.confidence, 1)
  const acknowledgeFloor = num(policy?.acknowledgeConfidence, ACKNOWLEDGE_MIN_CONFIDENCE)
  if (intent === 'acknowledge' && intentConfidence >= acknowledgeFloor) {
    return {
      profile: { ...profile, depth: 0, breadth: 0, risk: 0, latencyCritical: true },
      confidence,
      intent,
      acknowledged: true,
      source: 'system-one',
    }
  }

  // A model the user asked for by name. Both halves must hold: the model must be
  // a real choice (not `auto`) and the message must be a request rather than a
  // mention — a model id quoted from a log line scores high on the first and low
  // on the second.
  const requestedName = typeof normalized.model?.value === 'string' && normalized.model.value !== 'auto' ? normalized.model.value : null
  const requestProbability = num(normalized.modelRequest?.probability, normalized.modelRequest?.value === true ? 1 : 0)
  const requestConfidence = num(normalized.model?.confidence, 0)
  const requestFloor = num(policy?.modelRequestConfidence, MODEL_REQUEST_MIN_PROBABILITY)
  const modelRequest = requestedName !== null && requestProbability >= requestFloor && requestConfidence >= MODEL_REQUEST_MIN_CONFIDENCE
    ? requestedName
    : null

  return { profile, confidence, intent, requestedModel: modelRequest, source: 'system-one' }
}

export async function callDecisionModel({ baseURL, apiKey, model = DEFAULT_DECISION.model, state, timeoutMs = DEFAULT_DECISION.timeoutMs, signal, notes, models, fetchImpl }) {
  if (!apiKey) throw new Error('apiKey not set')
  const fetch = fetchImpl ?? globalThis.fetch
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this runtime')
  const url = `${baseURL.replace(/\/$/, '')}/systemone`
  const timeout = AbortSignal.timeout(Math.max(50, timeoutMs))
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions: buildQuestions({}, { notes, models }) }),
    signal: requestSignal,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`decision model HTTP ${response.status}: ${clip(text, 300)}`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`decision model returned non-JSON body: ${clip(text, 300)}`)
  }
  return body
}
