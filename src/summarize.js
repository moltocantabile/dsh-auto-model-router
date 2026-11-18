/**
 * Session digest for the decision model.
 *
 * The decision model used to see only the last few messages, clipped from the
 * end. On a long task that slice describes the current step and nothing about
 * the task it belongs to: a step that edits one line of a half-finished
 * migration looks exactly like a step that edits one line of a fresh request, and
 * the profile (and therefore the tier) follows the slice rather than the work.
 *
 * So the session is summarized once and kept up to date incrementally: a cheap
 * model reads the transcript and writes a bounded digest — goal, what is done,
 * what is happening now, what constrains it — and that digest rides along with
 * the recent messages, which stay verbatim because they are the thing being
 * routed.
 *
 * Two properties matter more than summary quality:
 *
 * - **The digest never blocks a routing decision.** A stale digest is returned
 *   immediately and refreshed in the background; only the very first digest on a
 *   long session is awaited, and even that is bounded by its own timeout.
 * - **A failed summary is not a failed route.** Any error leaves the previous
 *   digest (or none) in place; the decision proceeds on the recent messages.
 */

import { messageText, NOISE_SOURCE_KINDS } from './decision.js'

export const DEFAULT_SUMMARIZER = {
  enabled: true,
  // A flash model with a 1M window: this is a reading task, not a reasoning one.
  model: 'qwen3.8-flash',
  timeoutMs: 12_000,
  maxChars: 900,
  // Below this many messages the transcript is already shorter than the digest
  // would be, and summarizing it only loses detail.
  minMessages: 6,
  // Re-summarize once this many new messages have arrived since the last pass.
  refreshEvery: 6,
  maxInputChars: 48000,
}

export const DIGEST_SECTIONS = ['GOAL', 'DONE', 'NOW', 'RISK']

const clip = (text, max) => (typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : typeof text === 'string' ? text : '')

/**
 * Flatten a transcript into labelled lines, newest-biased when it overflows.
 *
 * @param {Array<object>} messages
 * @param {number} maxChars
 */
export function transcriptOf(messages, maxChars = DEFAULT_SUMMARIZER.maxInputChars) {
  const lines = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (NOISE_SOURCE_KINDS.has(message?.source?.kind)) continue
    const text = messageText(message, 1500)
    if (text.length > 0) lines.push(text)
  }
  const body = lines.join('\n')
  return body.length <= maxChars ? body : `…${body.slice(body.length - maxChars)}`
}

/**
 * The summarizer's instructions and the user turn that carries the transcript.
 *
 * The previous digest is an *input* on refresh, so the model updates a document
 * instead of rewriting the session from scratch — that is what makes the digest
 * stable across steps rather than drifting each time it is regenerated.
 *
 * @param {{previous?: string|null, transcript: string, maxChars?: number, messageCount?: number}} input
 */
export function buildDigestPrompt({ previous = null, transcript, maxChars = DEFAULT_SUMMARIZER.maxChars, messageCount = 0 }) {
  const system = [
    'You maintain a compact working-state digest of one agent session, for a router that must decide how much capability the next step needs.',
    'Write for that reader: what the task is, how far it has got, what the next step is doing, and what makes it risky.',
    `Answer with exactly these four lines, each on one line, no preamble, no markdown, at most ${maxChars} characters total:`,
    ...DIGEST_SECTIONS.map((section) => `${section}: <one sentence>`),
    'GOAL is the user\'s actual objective, not the current step. Keep it stable once known.',
    'DONE lists completed work as short verbs with the files or areas touched.',
    'NOW is the step in progress and what it is trying to establish.',
    'RISK names the mistake that would hurt (data loss, broken API, wrong assumption) and the constraint that must hold.',
    'If the transcript does not establish something, say "unclear" rather than guessing.',
  ].join('\n')

  const parts = []
  if (typeof previous === 'string' && previous.trim().length > 0) {
    parts.push('Previous digest (update it; keep what is still true):', previous.trim(), '')
  }
  parts.push(`Transcript (last ${messageCount} messages):`, transcript)
  return { system, user: parts.join('\n') }
}

/**
 * Plain chat completion against the same OpenAI-compatible endpoint the decision
 * model uses. The decision model speaks the System One question protocol, which
 * cannot express "summarize this", so this does not reuse `callDecisionModel`.
 *
 * @param {object} input
 * @returns {Promise<string>} the message content, trimmed
 */
export async function callChatModel({ baseURL, apiKey, model, system, user, timeoutMs = DEFAULT_SUMMARIZER.timeoutMs, signal, fetchImpl }) {
  if (!apiKey) throw new Error('apiKey not set')
  const fetch = fetchImpl ?? globalThis.fetch
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this runtime')
  const url = `${String(baseURL).replace(/\/$/, '')}/chat/completions`
  const timeout = AbortSignal.timeout(Math.max(50, timeoutMs))
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const payloadOf = (thinkingOff) => JSON.stringify({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: 400,
    stream: false,
    // Summarizing is a reading task. With thinking on, a 46k-character
    // transcript spends its budget deliberating and misses the deadline; the
    // same prompt answers in ~2s with thinking off.
    ...(thinkingOff ? { enable_thinking: false } : {}),
  })

  const send = (thinkingOff) => fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: payloadOf(thinkingOff),
    signal: requestSignal,
  })

  let response = await send(true)
  let text = await response.text()
  // Not every OpenAI-compatible endpoint knows this field; a plain 400 asking
  // about parameters means retry without it rather than lose the digest.
  if (!response.ok && response.status === 400 && /param|unknown|unsupported/i.test(text)) {
    response = await send(false)
    text = await response.text()
  }
  if (!response.ok) throw new Error(`summarizer HTTP ${response.status}: ${clip(text, 200)}`)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`summarizer returned non-JSON body: ${clip(text, 200)}`)
  }
  const content = body?.choices?.[0]?.message?.content
  const flat = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : ''
  const normalized = flat.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim()
  if (normalized.length === 0) throw new Error('summarizer returned an empty digest')
  return clip(normalized, DEFAULT_SUMMARIZER.maxChars * 2)
}

/**
 * Per-session digest cache with incremental refresh.
 *
 * @param {object} options
 * @param {(input: {previous: string|null, transcript: string, messageCount: number}) => Promise<string>} options.summarize
 * @param {{refreshEvery?: number, refreshMs?: number, minMessages?: number, maxInputChars?: number, now?: () => number}} [options]
 */
export function createDigestCache({ summarize, refreshEvery = DEFAULT_SUMMARIZER.refreshEvery, refreshMs = 60_000, minMessages = DEFAULT_SUMMARIZER.minMessages, maxInputChars = DEFAULT_SUMMARIZER.maxInputChars, now = Date.now, onError }) {
  /** @type {Map<object, {digest: string|null, covered: number, at: number, inflight: Promise<string|null>|null}>} */
  const sessions = new Map()
  const limits = { refreshEvery, refreshMs, minMessages, maxInputChars }
  let calls = 0
  let failures = 0

  const stateOf = (key) => {
    let state = sessions.get(key)
    if (state === undefined) {
      state = { digest: null, covered: 0, at: 0, inflight: null }
      sessions.set(key, state)
    }
    return state
  }

  // Deliberately no caller signal: a digest outlives the step that asked for it.
  // Forwarding the step's abort signal here cancels every refresh the moment the
  // decision returns, which reads from outside as "summaries never run".
  const refresh = (key, messages) => {
    const state = stateOf(key)
    if (state.inflight !== null) return state.inflight
    const transcript = transcriptOf(messages.slice(state.covered), limits.maxInputChars)
    calls += 1
    const run = (async () => {
      try {
        const digest = await summarize({ previous: state.digest, transcript, messageCount: messages.length })
        if (typeof digest === 'string' && digest.trim().length > 0) {
          state.digest = digest.trim()
          state.covered = messages.length
          state.at = now()
          return state.digest
        }
        failures += 1
        return state.digest
      } catch (error) {
        // Keep the previous digest: an older description of the task is still
        // more useful than none, and the route must not wait on this failing.
        failures += 1
        if (typeof onError === 'function') {
          try {
            onError(error)
          } catch {
            // A failing error reporter must not turn into a failing refresh.
          }
        }
        return state.digest
      } finally {
        state.inflight = null
      }
    })()
    state.inflight = run
    return run
  }

  return {
    /**
     * The digest to use right now, and the work to keep it current.
     *
     * @param {object} key - the agent (used as a map key; no string ids needed)
     * @param {Array<object>} messages - full session transcript
     * @param {{waitForFirst?: boolean}} [options]
     */
    async ensure(key, messages, options = {}) {
      const state = stateOf(key)
      if (!Array.isArray(messages) || messages.length < limits.minMessages) return state.digest
      const behind = messages.length - state.covered
      if (state.digest !== null && behind < limits.refreshEvery && now() - state.at < limits.refreshMs) return state.digest
      if (state.digest !== null) {
        // Stale but present: hand it over now and refresh behind the decision.
        void refresh(key, messages)
        return state.digest
      }
      if (options.waitForFirst !== true) {
        void refresh(key, messages)
        return null
      }
      return refresh(key, messages)
    },
    /** Apply changed thresholds after a config edit; digests are kept. */
    configure(next = {}) {
      for (const key of ['refreshEvery', 'refreshMs', 'minMessages', 'maxInputChars']) {
        const value = Number(next[key])
        if (Number.isFinite(value) && value > 0) limits[key] = Math.floor(value)
      }
    },
    /** Current digest without triggering work (tests and status output). */
    peek(key) {
      return sessions.get(key)?.digest ?? null
    },
    /**
     * Every digest held, newest first, each with the session it belongs to.
     *
     * A reader without an agent context (the settings page, a tool call made by
     * the harness itself) would otherwise see nothing while digests exist.
     */
    entries() {
      const list = []
      for (const [key, state] of sessions) {
        if (typeof state.digest !== 'string' || state.digest.length === 0) continue
        list.push({ sessionId: key?.session?.id ?? null, digest: state.digest, covered: state.covered, at: state.at })
      }
      return list.sort((a, b) => b.at - a.at)
    },
    stats() {
      return { calls, failures, sessions: sessions.size }
    },
    forget(key) {
      sessions.delete(key)
    },
  }
}