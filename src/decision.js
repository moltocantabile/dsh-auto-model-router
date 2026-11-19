/**
 * System One decision client + routing policy for the auto model router.
 *
 * This module is dependency-free on purpose: it is loaded inside the DSH host
 * process, where the plugin package only has its own files.
 *
 * The decision model is any HTTP endpoint that speaks the System One protocol:
 * one forward pass over `state` plus typed `questions` (choice / noul / score)
 * returns typed answers with probabilities, never free text. The endpoint, the
 * model and the credential reference are operator config — nothing here names a
 * vendor, because a router that only routes inside one catalog is a catalog
 * feature, not a router.
 */

import { DIMENSIONS, PROFILES, SHAPE_WEIGHTS } from './select.js'

/** Default route catalog. All entries are provider/model ids already configured in the profile. */
export const DEFAULT_ROUTES = {
  fast: {
    // None: the router fills this from the routable pool. A tier is an envelope,
    // not a model, so naming one here would make the default route a vendor
    // default.
    provider: null,
    model: null,
    envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 },
    description:
      'Reading and reporting: a single known lookup or command, renames, formatting, an edit whose location is already known, short summaries. Not for multi-file changes, new features, or debugging unexplained behaviour.',
  },
  balanced: {
    provider: null,
    model: null,
    envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 },
    description:
      'Implementing and fixing: code across a few files, adding a feature, standard debugging with a known reproduction, tests beside the change, tool-heavy multi-step work.',
  },
  deep: {
    provider: null,
    model: null,
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
  // Empty on purpose: an unconfigured decision endpoint must leave routing off
  // rather than silently call one vendor's service. Set all three to enable.
  baseURL: '',
  credentialRef: '',
  model: '',
  timeoutMs: 3500,
  maxMessages: 10,
  maxStateChars: 12000,
  maxMessageChars: 2000,
}

export const DEFAULT_POLICY = {
  // Kept because the settings page and README expose the "confidence policy"
  // fields: the ranked decision path reads only the two gates below. They stay
  // here so an existing patch keeps them instead of showing undefined.
  minConfidence: 0.5,
  minProbability: 0.5,
  // How sure the decision model must be that a message only acknowledges before
  // the turn is priced at zero, and that a model name is a request rather than a
  // mention. Both are measured: acknowledgements score 0.47-0.99 while real work
  // scores 0.86-0.97, and explicit model requests score 0.94-0.98 on
  // `modelRequest` where the same ids quoted from logs score 0.20.
  acknowledgeConfidence: ACKNOWLEDGE_MIN_CONFIDENCE,
  modelRequestConfidence: MODEL_REQUEST_MIN_PROBABILITY,
  // Also kept for the config surface. The router switches via `agent.model.select`
  // with sticky default, so no decision path compares against this value.
  switchConfidence: 0.4,
}

const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/**
 * Messages the harness injects into the transcript for the model to read. They
 * are not what the user asked for, and two of them are actively misleading:
 *
 * - `model-selection` is the notice that a previous turn ran on another model.
 *   It names both models, so reading it as the request lets the router answer
 *   its own output: the notice scores as a task about a model, and the next
 *   switch writes another notice about that model.
 * - `time-context` is the clock block appended before a turn. It is a `user`
 *   message with no request in it, and it is often the newest message, so it
 *   would win the "what is being asked" slot even though it asks nothing.
 */
export const NOISE_SOURCE_KINDS = new Set([
  'runtime-context',
  'model-selection',
  'system-prompt',
  'time-context',
  'skill-catalog',
  'tool-registry',
  'compact-checkpoint',
])

/**
 * Whether a message may stand in as the request being routed. Only what the
 * user typed qualifies: a synthetic message (no source kind) is allowed so
 * tests and hosts can pass plain messages.
 *
 * @param {object|undefined} message
 */
export function isRoutableMessage(message) {
  if (NOISE_SOURCE_KINDS.has(message?.source?.kind)) return false
  if (message?.role !== 'user') return false
  return message.source?.kind === undefined || message.source?.kind === 'user'
}

/**
 * Whether a message belongs in the state at all. Assistant and tool messages
 * are context — they are what the work looked like — so only injected noise is
 * dropped here.
 *
 * @param {object|undefined} message
 */
export function isContextMessage(message) {
  return !NOISE_SOURCE_KINDS.has(message?.source?.kind)
}

/** Trim one string to `max` characters with an explicit ellipsis marker. */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Short content fingerprint for the decision-reuse signature.
 *
 * The signature used to be built from message counts and lengths, so a new
 * request of the same length as the previous one reused the previous decision
 * for up to `DECISION_REUSE_MS` without asking the model. The identity of a
 * prompt is its text, so the signature is derived from the text.
 */
function fingerprint(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
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
  const whole = Array.isArray(messages) ? messages : []
  // The window counts messages the decision model may read. Slicing the raw
  // tail and filtering afterwards let injected notices (runtime context, the
  // clock, the skill catalog) spend the window and push the real turns out of
  // it, so the step was scored from a transcript missing the work it follows.
  const recent = whole.filter(isContextMessage).slice(-maxMessages)
  const claimedList = Array.isArray(claimed) ? claimed.filter((m) => m !== null && m !== undefined && isRoutableMessage(m)) : []
  const claimedLines = claimedList.map((m) => messageText(m, maxMessageChars))
  const windowLines = [...recent.map((m) => messageText(m, maxMessageChars)), ...claimedLines]

  // The request being routed must be in the state even when it fell out of the
  // window: deep into a turn the window is mostly tool results, and scoring
  // those instead of the request is how a step inherits the wrong difficulty.
  const lastUser = [...whole, ...claimedList].findLast(isRoutableMessage) ?? null
  const requestLine = lastUser === null ? null : `request: ${messageText(lastUser, maxMessageChars).replace(/^user: /, '')}`
  const lines = requestLine !== null && !windowLines.includes(messageText(lastUser, maxMessageChars))
    ? [...windowLines, requestLine]
    : windowLines
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
  // The task label names the request being routed, so it is found across the
  // whole transcript: inside a long turn the newest user message is further back
  // than the state window, and the window itself is mostly tool results. The
  // text comes from the first text block, since a message may open with an
  // image or an attached file.
  const task = lastUser ? clip((lastUser.content ?? []).find((block) => block?.type === 'text')?.text ?? '', 100) : ''


  // The prompt's identity is its text: the caller reuses a decision only when
  // this value and the text length agree, so a different request cannot inherit
  // the previous one just because both were the same size.
  const messageIds = fingerprint(`${text}\u0000${task}`)

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
 * @param {{models?: string[]}} options - model ids the user may name.
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
    // A bare value is an answer with no stated confidence. It is still usable
    // as a profile field, but it is not evidence that the endpoint is sure, so
    // it must not clear a confidence gate.
    if (typeof value === 'string' || typeof value === 'number') {
      out[key] = { value, confidence: 0 }
      continue
    }
    if (typeof value !== 'object') continue
    // Idempotent: a already-normalized answer ({ value, confidence }) passes through.
    if (value.value !== undefined) {
      out[key] = { value: value.value, probability: value.probability, confidence: num(value.confidence, 0) }
      continue
    }
    if (typeof value.choice === 'string') {
      const probabilities = value.probabilities ?? {}
      // The chosen option's probability is the evidence. A choice with no
      // confidence and no mass on itself has none: defaulting it to 0.7 let a
      // bare `{choice:"acknowledge"}` clear the acknowledgement gate.
      out[key] = { value: value.choice, confidence: num(value.confidence, num(probabilities[value.choice], 0)) }
    } else if (typeof value.score === 'number') {
      out[key] = { value: value.score, confidence: num(value.confidence, 0) }
    } else if (typeof value.noul === 'number') {
      // Confidence in the derived boolean is how far the probability sits from a
      // coin flip, on the side it landed.
      // Threshold above 0.5 on purpose: a false positive removes every text-only
      // model from the pool, which is a much worse error than missing a
      // marginal image.
      const threshold = key === 'vision' ? 0.6 : 0.5
      out[key] = { value: value.noul >= threshold, probability: value.noul, confidence: Math.max(value.noul, 1 - value.noul) }
    } else if (typeof value.answer === 'string' || typeof value.answer === 'number') {
      out[key] = { value: value.answer, confidence: num(value.confidence, 0) }
    }
  }
  return out
}

/**
 * Answers every prompt asks for. A response that omits one still yields a
 * profile, because the fallbacks below are the safe reading, but it cannot
 * report the confidence of a complete decision.
 */
const REQUIRED_ANSWERS = ['shape', 'depth', 'breadth', 'risk', 'intent', 'vision', 'tools', 'latency']
const SHAPE_IDS = new Set(PROFILES.map((profile) => profile.id))

/**
 * Parse the decision model's reply into a task profile.
 *
 * A question the prompt asked but the reply did not answer is not a confident
 * answer. The fallbacks (implement / depth 2 / breadth 2 / risk 1.5 / no pixels
 * / no tools / not latency-critical) keep the router working, and the reported
 * confidence drops to zero so a partial reply is visible in the decision log
 * instead of reading as a full decision.
 *
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
  const rawShape = normalized.shape?.value
  const shape = typeof rawShape === 'string' && SHAPE_IDS.has(rawShape) ? rawShape : 'implement'
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
  // The weakest required answer, with a missing or malformed one counting as no
  // confidence at all. An empty answer set used to score 1.0 here, which made a
  // malformed reply look like the most certain decision in the log.
  const confidence = Math.min(
    ...REQUIRED_ANSWERS.map((id) => {
      if (id === 'shape' && shape !== rawShape) return 0
      return num(normalized[id]?.confidence, 0)
    }),
  )

  // What the message asks of the assistant. `acknowledge` is the only value that
  // prices a turn cheap, and only when the model is sure; a low-confidence answer
  // falls through to the profile's own scores, which err high.
  const intent = typeof normalized.intent?.value === 'string' ? normalized.intent.value : null
  const intentConfidence = num(normalized.intent?.confidence, 0)
  const acknowledgeFloor = num(policy?.acknowledgeConfidence, ACKNOWLEDGE_MIN_CONFIDENCE)

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

  if (intent === 'acknowledge' && intentConfidence >= acknowledgeFloor) {
    // The acknowledgement prices the scored work away, but an explicit model
    // request still rides with it: dropping the name here let "ok, use X for
    // this" fall through to a heuristic selection that overrode the user.
    return {
      profile: { ...profile, depth: 0, breadth: 0, risk: 0, latencyCritical: true },
      confidence,
      intent,
      acknowledged: true,
      requestedModel: modelRequest,
      source: 'system-one',
    }
  }

  return { profile, confidence, intent, requestedModel: modelRequest, source: 'system-one' }
}

export async function callDecisionModel({ baseURL, apiKey, model = DEFAULT_DECISION.model, state, timeoutMs = DEFAULT_DECISION.timeoutMs, signal, models, fetchImpl }) {
  if (!baseURL) throw new Error('decision endpoint not configured (decision.baseURL)')
  if (!model) throw new Error('decision model not configured (decision.model)')
  const fetch = fetchImpl ?? globalThis.fetch
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this runtime')
  const url = `${baseURL.replace(/\/$/, '')}/systemone`
  // A non-finite deadline used to reach AbortSignal.timeout as NaN and throw
  // before the request was even sent; the default is the honest fallback.
  const timeout = AbortSignal.timeout(Math.max(50, num(timeoutMs, DEFAULT_DECISION.timeoutMs)))
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetch(url, {
    method: 'POST',
    // An unauthenticated endpoint (a local model server) simply omits the header.
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify({ model, state, questions: buildQuestions({}, { models }) }),
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
  // An HTTP 200 with no answered question is not a decision: parsing it produced
  // a full default profile, so it read in the log as a successful decision. A
  // partial answer is still parsed (the parser reports zero confidence for it);
  // an empty one is rejected here, where the caller already has an error path.
  const answers = body?.answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).length === 0) {
    throw new Error(`decision model returned no answers: ${clip(text, 300)}`)
  }
  // The protocol reports these as `usage.input_tokens` and `latency_ms`; the
  // decision record reads `inputTokens` and `serverLatencyMs`. Fill the names the
  // record needs instead of logging two always-undefined fields.
  if (typeof body.inputTokens !== 'number' && typeof body.usage?.input_tokens === 'number') body.inputTokens = body.usage.input_tokens
  if (typeof body.serverLatencyMs !== 'number' && typeof body.latency_ms === 'number') body.serverLatencyMs = body.latency_ms
  return body
}
