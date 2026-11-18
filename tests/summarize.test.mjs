import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildState, messageText } from '../src/decision.js'
import {
  DEFAULT_SUMMARIZER,
  buildDigestPrompt,
  callChatModel,
  createDigestCache,
  transcriptOf,
} from '../src/summarize.js'

/**
 * The digest is what makes a routing decision see the task rather than one step,
 * so these pin the two things that can silently break it: the prompt stops
 * demanding the four sections, or the cache starts blocking / re-summarizing on
 * every step.
 */

const message = (role, text, kind = 'user') => ({ role, source: { kind }, content: [{ type: 'text', text }] })

test('the digest prompt asks for the four sections and caps the length', () => {
  const { system, user } = buildDigestPrompt({ transcript: 'user: do the thing', maxChars: 500 })
  for (const section of ['GOAL', 'DONE', 'NOW', 'RISK']) assert.ok(system.includes(section), `prompt names ${section}`)
  assert.ok(system.includes('500'), 'the character cap reaches the model')
  assert.ok(system.includes('unclear'), 'an unestablished fact is not guessed')
  assert.ok(user.includes('do the thing'))
  assert.ok(!user.includes('Previous digest'), 'a first pass carries no previous digest')
})

test('a refresh carries the previous digest as an input to update', () => {
  const { user } = buildDigestPrompt({ previous: 'GOAL: ship the migration', transcript: 'user: next step' })
  assert.ok(user.includes('Previous digest'))
  assert.ok(user.indexOf('GOAL: ship the migration') < user.indexOf('user: next step'), 'previous digest precedes the new transcript')
})

test('transcriptOf skips runtime scaffolding and keeps the newest content when bounded', () => {
  const messages = [
    message('system', 'you are an agent', 'system-prompt'),
    message('user', 'the original request'),
    message('assistant', 'working on it'),
    message('user', 'latest instruction'),
  ]
  const full = transcriptOf(messages, 10_000)
  assert.ok(full.includes('the original request'))
  assert.ok(!full.includes('you are an agent'), 'system prompt is not part of the session being summarized')
  const clipped = transcriptOf(messages, 20)
  assert.ok(clipped.startsWith('…'), 'overflow is marked')
  assert.ok(clipped.includes('latest'), 'the newest message survives the clip')
})

test('callChatModel sends a chat completion and returns the content', async () => {
  let seen = null
  const digest = await callChatModel({
    baseURL: 'https://example.test/v1/',
    apiKey: 'k',
    model: 'cheap',
    system: 'S',
    user: 'U',
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization }
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'GOAL: x\nDONE: y' } }] }) } }
    },
  })
  assert.equal(seen.url, 'https://example.test/v1/chat/completions')
  assert.equal(seen.auth, 'Bearer k')
  assert.equal(seen.body.model, 'cheap')
  assert.equal(seen.body.messages[0].role, 'system')
  assert.ok(digest.includes('GOAL: x'), 'the digest is returned verbatim')
})

test('callChatModel rejects empty content and HTTP failures', async () => {
  await assert.rejects(
    () => callChatModel({ baseURL: 'https://x', apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ choices: [] }) } }) }),
    /empty digest/,
  )
  await assert.rejects(
    () => callChatModel({ baseURL: 'https://x', apiKey: 'k', model: 'm', system: 's', user: 'u', fetchImpl: async () => ({ ok: false, status: 429, async text() { return 'slow down' } }) }),
    /HTTP 429/,
  )
})

test('the cache summarizes once, reuses the digest, and refreshes only after the threshold', async () => {
  let calls = 0
  const cache = createDigestCache({
    summarize: async ({ previous }) => {
      calls += 1
      return previous === null ? 'GOAL: migrate\nDONE: none\nNOW: reading\nRISK: data loss' : `${previous}\nDONE: more`
    },
    refreshEvery: 3,
    minMessages: 2,
  })
  const key = {}
  const history = [message('user', 'a'), message('assistant', 'b')]

  await cache.ensure(key, history)
  assert.equal(calls, 1, 'the first pass starts as a background call, not an awaited one')

  const first = await cache.ensure(key, history, { waitForFirst: true })
  assert.ok(String(first).includes('GOAL: migrate'))
  assert.equal(calls, 1, 'the in-flight pass was reused rather than repeated')

  const same = await cache.ensure(key, history)
  assert.equal(same, first, 'an unchanged transcript returns the cached digest')
  assert.equal(calls, 1, 'no call is made while the digest is fresh')

  const grown = [...history, message('user', 'c'), message('user', 'd'), message('user', 'e')]
  await cache.ensure(key, grown)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls, 2, 'a transcript past the threshold refreshes once')
  assert.ok(cache.peek(key).includes('DONE: more'), 'the refresh builds on the previous digest')
})

test('a failing summarizer keeps the previous digest instead of dropping it', async () => {
  const calls = []
  const cache = createDigestCache({
    summarize: async ({ previous }) => {
      calls.push(previous)
      if (calls.length === 1) return 'GOAL: stable\nDONE: a\nNOW: b\nRISK: c'
      throw new Error('model unavailable')
    },
    refreshEvery: 1,
    minMessages: 1,
  })
  const key = {}
  const first = await cache.ensure(key, [message('user', 'a')], { waitForFirst: true })
  assert.ok(String(first).includes('GOAL: stable'))
  const after = await cache.ensure(key, [message('user', 'a'), message('user', 'b')])
  assert.equal(after, first, 'the old digest survives a failed refresh')
  assert.equal(cache.stats().failures, 1)
})

test('buildState frames the recent messages with the session digest inside one budget', () => {
  const messages = [message('user', 'step 40: bump the version field')]
  const digest = 'GOAL: migrate persistence to SQLite\nDONE: 12 callers\nNOW: version bump\nRISK: rollback'
  const withDigest = buildState(messages, [], { maxMessages: 10, maxStateChars: 4000, maxMessageChars: 2000 }, { agentKind: 'main', toolNames: [], digest })
  assert.ok(withDigest.text.includes('[session-digest]'), 'the digest is labelled')
  assert.ok(withDigest.text.indexOf('GOAL: migrate') < withDigest.text.indexOf('step 40'), 'the task frames the step')
  assert.ok(withDigest.text.includes('[end-session-digest]'))

  const withoutDigest = buildState(messages, [], { maxMessages: 10, maxStateChars: 4000, maxMessageChars: 2000 }, { agentKind: 'main', toolNames: [] })
  assert.ok(!withoutDigest.text.includes('[session-digest]'), 'no digest block when there is no digest')

  const tight = buildState(messages, [], { maxMessages: 10, maxStateChars: 1200, maxMessageChars: 2000 }, { agentKind: 'main', toolNames: [], digest: 'X'.repeat(2000) })
  assert.ok(tight.text.length <= 1400, 'an oversized digest cannot push the state past its budget')
})

test('messageText is shared with the digest so both see the same transcript', () => {
  const line = messageText({ role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{"cmd":"ls"}' }, { type: 'text', text: 'listing' }] }, 200)
  assert.ok(line.startsWith('assistant: '))
  assert.ok(line.includes('[tool-call bash'))
  assert.ok(line.includes('listing'))
})

test('DEFAULT_SUMMARIZER keeps the digest bounded and cheap', () => {
  assert.ok(DEFAULT_SUMMARIZER.maxChars <= 1200, 'the digest stays small next to the 12k decision budget')
  assert.ok(DEFAULT_SUMMARIZER.minMessages >= 2, 'short sessions are not summarized at all')
  assert.ok(DEFAULT_SUMMARIZER.refreshEvery >= 2, 'a digest is not regenerated on every step')
})
test('the built plugin loads and applies against a minimal host', async () => {
  // Boot is the one moment a mistake here is invisible: a throw in `apply` leaves
  // the plugin registered with no fiber, which is what a reload hang looks like
  // from outside. This mounts the real built module on a stub context.
  const { apply, name, inject } = await import('../lib/index.js')
  assert.equal(name, '@dsh-external/dsh-auto-model-router')
  assert.ok(Array.isArray(inject) && inject.length > 0, 'the plugin declares its injected services')

  const listeners = []
  const tools = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(key) {
      if (key === 'llm') return { listProviders: () => [{ id: 'bailian-tokenplan', name: 'Bailian' }], listModels: async () => [] }
      if (key === 'tools') return { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) }
      return undefined
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    effect(fn) {
      const result = typeof fn === 'function' ? fn() : undefined
      return () => (typeof result === 'function' ? result() : undefined)
    },
    tools: { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) },
    // Cordis only calls back once every requested service exists; this host has
    // no web server, so the transport callback is skipped exactly as at boot.
    inject(names, callback) {
      if (names.includes('webServer')) return
      return callback(Object.create(ctx))
    },
  }
  const noop = () => {}
  // Disposal is context-scoped (ctx.effect / ctx.on), so apply itself returns
  // nothing; what matters is that it completes and registers its surfaces.
  assert.doesNotThrow(() =>
    apply(ctx, {
      mode: 'shadow',
      routes: { balanced: { provider: 'bailian-tokenplan', model: 'deepseek-v4.1-flash-1017' } },
    }),
  )
  assert.ok(tools.has('model_router'), 'the router tool is registered')
  assert.ok(listeners.length > 0, 'the router subscribes to agent events')
  assert.ok(
    listeners.some((entry) => String(entry.event).includes('inbox')) &&
      listeners.some((entry) => String(entry.event).includes('assemble')),
    'both routing hooks are subscribed',
  )
})

test('a background digest is not cancelled by the step that triggered it', async () => {
  // The bug this pins: forwarding the routing step's abort signal into the
  // summarizer cancelled every refresh the moment the decision returned, so the
  // digest stayed empty forever while nothing errored visibly.
  let abortSeen = null
  const cache = createDigestCache({
    summarize: async (input) => {
      // The caller's signal must not reach the summarizer.
      abortSeen = input.signal === undefined ? null : 'signal forwarded'
      return input.previous ?? 'GOAL: survives\nDONE: a\nNOW: b\nRISK: c'
    },
    refreshEvery: 1,
    minMessages: 1,
  })
  const controller = new AbortController()
  controller.abort()
  const key = {}
  const first = await cache.ensure(key, [message('user', 'a')], { waitForFirst: true, signal: controller.signal })
  assert.ok(String(first).includes('GOAL: survives'), 'an aborted caller signal does not stop the digest')
  const grown = [message('user', 'a'), message('user', 'b')]
  const second = await cache.ensure(key, grown, { signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(String(second).includes('GOAL: survives'), 'refreshes keep working after the caller aborted')
  assert.equal(abortSeen, null)
})

test('a failing refresh reports through onError and keeps the digest', async () => {
  const seen = []
  const cache = createDigestCache({
    summarize: async ({ previous }) => {
      if (previous === null) return 'GOAL: keep\nDONE: a\nNOW: b\nRISK: c'
      throw new Error('summarizer 500')
    },
    refreshEvery: 1,
    minMessages: 1,
    onError: (error) => seen.push(String(error.message)),
  })
  const key = {}
  await cache.ensure(key, [message('user', 'a')], { waitForFirst: true })
  const after = await cache.ensure(key, [message('user', 'a'), message('user', 'b')])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(String(after).includes('GOAL: keep'), 'the digest survives')
  assert.deepEqual(seen, ['summarizer 500'], 'the failure is reported once')
})

test('the summarizer disables thinking, and retries without the flag on a 400', async () => {
  const bodies = []
  const respond = (payload) => ({ ok: true, status: 200, async text() { return JSON.stringify(payload) } })
  const okBody = { choices: [{ message: { content: 'GOAL: a\nDONE: b\nNOW: c\nRISK: d' } }] }

  await callChatModel({
    baseURL: 'https://x/v1', apiKey: 'k', model: 'm', system: 's', user: 'u',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return respond(okBody)
    },
  })
  assert.equal(bodies[0].enable_thinking, false, 'thinking is off for a reading task')

  const retried = []
  const digest = await callChatModel({
    baseURL: 'https://x/v1', apiKey: 'k', model: 'm', system: 's', user: 'u',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body)
      retried.push(body)
      if (retried.length === 1) {
        return { ok: false, status: 400, async text() { return '{"error":{"message":"unknown parameter: enable_thinking"}}' } }
      }
      return respond(okBody)
    },
  })
  assert.equal(retried.length, 2, 'the call is retried without the unsupported flag')
  assert.equal(retried[1].enable_thinking, undefined)
  assert.ok(digest.includes('GOAL: a'))
})

test('the digest timeout leaves room for a long transcript', () => {
  // Measured: 46k chars with thinking off answers in ~2.2s; the deadline must
  // sit well above that rather than at the 8s that used to abort the call.
  assert.ok(DEFAULT_SUMMARIZER.timeoutMs >= 10_000)
})

test('entries reports every held digest, newest first, with its session', async () => {
  let at = 1000
  const cache = createDigestCache({
    summarize: async ({ previous }) => `${previous ?? 'GOAL: first'}\nDONE: more`,
    refreshEvery: 1,
    minMessages: 1,
    now: () => (at += 1000),
  })
  const first = { session: { id: 'session-a' } }
  const second = { session: { id: 'session-b' } }
  await cache.ensure(first, [message('user', 'a')], { waitForFirst: true })
  await cache.ensure(second, [message('user', 'b')], { waitForFirst: true })
  const list = cache.entries()
  assert.deepEqual(list.map((entry) => entry.sessionId), ['session-b', 'session-a'], 'ordered by recency')
  assert.ok(list[0].digest.includes('GOAL: first'), 'each digest is returned in full')
  assert.equal(cache.peek(first).length, list[1].digest.length)
})
