import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_POLICY,
  DEFAULT_ROUTES,
  buildQuestions,
  buildState,
  isContextMessage,
  isRoutableMessage,
  callDecisionModel,
  parseDecision,
} from '../src/decision.js'
import { PROFILES, selectBest, rankModels } from '../src/select.js'

const message = (id, role, text, sourceKind) => ({
  id,
  role,
  content: [{ type: 'text', text }],
  source: sourceKind === undefined ? { kind: role } : { kind: sourceKind },
})

test('buildState drops runtime context, keeps the newest turns, and captures the user task', () => {
  const messages = [
    message('a', 'user', 'old request'),
    message('b', 'assistant', 'old answer'),
    message('c', 'user', 'runtime noise', 'runtime-context'),
    message('d', 'user', 'current request'),
  ]
  const claimed = [message('e', 'user', 'claimed steering')]
  const state = buildState(messages, claimed, { maxMessages: 10, maxStateChars: 12000, maxMessageChars: 2000 })
  assert.ok(!state.text.includes('runtime noise'))
  assert.ok(state.text.includes('current request'))
  assert.ok(state.text.includes('claimed steering'))
  assert.equal(state.task, 'claimed steering')
})

test('buildState keeps the newest entries when the character budget overflows', () => {
  const messages = [
    message('a', 'user', 'a'.repeat(1000)),
    message('b', 'user', 'b'.repeat(1000)),
    message('c', 'user', 'c'.repeat(1000)),
  ]
  const state = buildState(messages, [], { maxMessages: 10, maxStateChars: 1500, maxMessageChars: 1000 })
  assert.ok(!state.text.includes('aaaa'))
  assert.ok(state.text.includes('cccc'))
})

test('buildQuestions emits a task profile keyed by question id', () => {
  const questions = buildQuestions(DEFAULT_ROUTES)
  assert.deepEqual(Object.keys(questions), ['shape', 'depth', 'breadth', 'risk', 'intent', 'vision', 'tools', 'latency'])
  assert.equal(questions.shape.type, 'choice')
  assert.equal(questions.depth.type, 'score')
  assert.equal(questions.vision.type, 'noul')
  // score criteria are ordered, so the list position is the score
  assert.equal(questions.depth.criteria.length, 5)
  assert.equal(questions.breadth.criteria.length, 5)
  assert.equal(questions.intent.type, 'choice')
  assert.deepEqual(Object.keys(questions.intent.criteria), ['acknowledge', 'resume', 'work'])
  // The model may only be offered a real choice when a pool is supplied.
  const withModels = buildQuestions(DEFAULT_ROUTES, { models: ['qwen3.7-max'] })
  assert.equal(withModels.model.type, 'choice')
  assert.deepEqual(Object.keys(withModels.model.criteria), ['auto', 'qwen3.7-max'])
  assert.equal(withModels.modelRequest.type, 'noul')
  assert.equal(questions.risk.criteria.length, 5)
  // every choice option needs a description or the model cannot answer
  assert.deepEqual(Object.keys(questions.shape.criteria), PROFILES.map((p) => p.id))
})

test('parseDecision extracts a task profile from System One responses', () => {
  const raw = {
    answers: {
      shape: { type: 'choice', choice: 'implement', confidence: 0.85, probabilities: { implement: 0.85, debug: 0.15 } },
      depth: { type: 'score', score: 3, confidence: 0.9 },
      breadth: { type: 'score', score: 2, confidence: 0.8 },
      risk: { type: 'score', score: 2, confidence: 0.9 },
      vision: { type: 'noul', noul: 0.1 },
      tools: { type: 'noul', noul: 0.9 },
      latency: { type: 'noul', noul: 0.2 },
    },
  }
  const parsed = parseDecision(raw, DEFAULT_ROUTES)
  assert.equal(parsed.profile.shape, 'implement')
  assert.equal(parsed.profile.depth, 3)
  assert.equal(parsed.profile.breadth, 2)
  assert.equal(parsed.profile.risk, 2)
  assert.equal(parsed.profile.vision, false)
  assert.equal(parsed.profile.tools, true)
  assert.equal(parsed.profile.latencyCritical, false)
  assert.equal(parsed.source, 'system-one')
  assert.ok(parsed.confidence >= 0.8)
})

test('selectBest picks the highest-utility candidate', () => {
  const profile = { shape: 'implement', depth: 3, breadth: 3, risk: 2, vision: false, tools: true, latencyCritical: false }
  const candidates = [
    { tier: 'fast', provider: 'p1', model: 'flash', info: { scores: { coding: 50, reasoning: 50 }, evidence: { coding: 5, reasoning: 5 }, price: { input: 0.5, output: 1 } } },
    { tier: 'balanced', provider: 'p1', model: 'pro', info: { scores: { coding: 80, reasoning: 80 }, evidence: { coding: 5, reasoning: 5 }, price: { input: 5, output: 10 } } },
  ]
  const result = selectBest(profile, candidates)
  assert.equal(result.selected.model, 'pro')
  assert.ok(result.selected.utility > 0)
  assert.equal(result.source, 'ranked')
})

test('rankModels excludes models that fail hard requirements', () => {
  const profile = { shape: 'inspect', depth: 1, breadth: 1, risk: 1, vision: true, tools: false, latencyCritical: false }
  const candidates = [
    { tier: 'fast', provider: 'p1', model: 'text-only', info: { scores: { coding: 90 }, modalities: ['text'] } },
    { tier: 'balanced', provider: 'p1', model: 'vision', info: { scores: { coding: 70 }, modalities: ['text', 'image'] } },
  ]
  const ranking = rankModels(profile, candidates)
  assert.equal(ranking.ranked.length, 1)
  assert.equal(ranking.ranked[0].model, 'vision')
  assert.equal(ranking.excluded.length, 1)
  assert.equal(ranking.excluded[0].model, 'text-only')
  assert.match(ranking.excluded[0].reason, /vision/)
})

test('callDecisionModel posts the System One body and normalizes typed answers', async () => {
  let captured
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) }
    return new Response(
      JSON.stringify({
        model: 'decision-model-preview',
        request_id: 'req-1',
        answers: {
          shape: { type: 'choice', choice: 'implement', confidence: 0.85, probabilities: { implement: 0.85 } },
          depth: { type: 'score', score: 3, confidence: 0.9 },
          breadth: { type: 'score', score: 2, confidence: 0.8 },
          risk: { type: 'score', score: 2, confidence: 0.9 },
          vision: { type: 'noul', noul: 0.1 },
          tools: { type: 'noul', noul: 0.9 },
          latency: { type: 'noul', noul: 0.2 },
        },
        usage: { input_tokens: 42 },
        latency_ms: 51.2,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const body = await callDecisionModel({
    baseURL: 'https://example.test/compatible-mode/v1/',
    apiKey: 'sk-test',
    model: 'decision-model-preview',
    state: 'refactor the parser',
    timeoutMs: 2000,
    signal: undefined,
    fetchImpl: fakeFetch,
  })
  assert.equal(captured.url, 'https://example.test/compatible-mode/v1/systemone')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test')
  assert.equal(captured.body.model, 'decision-model-preview')
  assert.equal(captured.body.state, 'refactor the parser')
  const parsed = parseDecision(body, DEFAULT_ROUTES)
  assert.equal(parsed.profile.shape, 'implement')
  assert.equal(parsed.profile.depth, 3)
  assert.equal(parsed.profile.tools, true)
})

test('callDecisionModel rejects an HTTP error', async () => {
  await assert.rejects(
    callDecisionModel({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'decision-model-preview',
      state: 'x',
      timeoutMs: 1000,
      fetchImpl: async () => new Response('quota exceeded', { status: 429 }),
    }),
    /HTTP 429/,
  )
})

test('buildState prefixes the routing context and keeps the transcript intact', () => {
  const messages = [message('a', 'user', 'add a flag to the parser')]
  const plain = buildState(messages, [], { maxMessages: 10, maxStateChars: 12000, maxMessageChars: 2000 })
  assert.ok(!plain.text.startsWith('[router]'))

  const withMeta = buildState(messages, [], { maxMessages: 10, maxStateChars: 12000, maxMessageChars: 2000 }, {
    agentKind: 'subagent',
    toolNames: ['bash', 'read', 'write'],
  })
  assert.ok(withMeta.text.startsWith('[router] agent=subagent'))
  assert.ok(withMeta.text.includes('tools=3 (bash,read,write)'))
  assert.ok(withMeta.text.includes('user: add a flag to the parser'))
  assert.equal(withMeta.task, 'add a flag to the parser')
})

test('a digest is framed so scoring stays with the step, not the session', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'add a session digest to the router' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'implementing the cache' }] },
    { role: 'user', content: [{ type: 'text', text: 'wire it into the settings page' }] },
  ]
  const decision = { maxMessages: 10, maxStateChars: 12000, maxMessageChars: 2000 }
  const withDigest = buildState(messages, [], decision, { digest: 'GOAL: add a digest\nRISK: do not block turns' })
  assert.ok(withDigest.text.includes('[session-digest]'))
  assert.match(withDigest.text, /Score depth and breadth for the request being routed/)
  assert.match(withDigest.text, /only to judge risk/)
  const without = buildState(messages, [], decision, { digest: null })
  assert.ok(!without.text.includes('[session-digest]'), 'no framing line when there is no digest')
})

test('callDecisionModel sends the model question when a pool is supplied', async () => {
  let sent = null
  await callDecisionModel({
    baseURL: 'https://x/v1',
    apiKey: 'k',
    model: 'decision-model-preview',
    state: 'user: use qwen3.7-max for this',
    models: ['qwen3.7-max', 'qwen3.8-flash'],
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, async text() { return JSON.stringify({ answers: { model: { type: 'choice', choice: 'qwen3.7-max', confidence: 0.95 }, modelRequest: { type: 'noul', noul: 0.96 } } }) } }
    },
  })
  assert.ok(sent.questions.model !== undefined, 'the pool reaches the endpoint')
  assert.deepEqual(Object.keys(sent.questions.model.criteria), ['auto', 'qwen3.7-max', 'qwen3.8-flash'])
  assert.equal(sent.questions.modelRequest.type, 'noul')
})

test('no pool means no model question', async () => {
  let sent = null
  await callDecisionModel({
    baseURL: 'https://x/v1', apiKey: 'k', model: 'decision-model-preview', state: 'user: hi',
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, async text() { return JSON.stringify({ answers: {} }) } }
    },
  })
  assert.equal(sent.questions.model, undefined)
  assert.equal(sent.questions.modelRequest, undefined)
  assert.ok(sent.questions.intent !== undefined, 'intent is always asked')
})

test('harness-injected messages are not read as the request', () => {
  const notice = {
    role: 'user',
    source: { kind: 'model-selection', form: 'notice', summary: 'a → b' },
    content: [{ type: 'text', text: '[model changed: assistant turns above this point were generated by qwen3.8-flash; the session continues with deepseek-v4.1-flash-1017]' }],
  }
  const ask = { role: 'user', content: [{ type: 'text', text: 'rename the router field' }] }

  assert.equal(isRoutableMessage(notice), false, 'a switch notice carries no request')
  assert.equal(isRoutableMessage(ask), true)

  // The notice must not reach the state a decision is made from: it names model
  // ids, so reading it lets the router answer its own output and keep switching.
  const state = buildState([ask, notice], [notice], {}, {})
  assert.ok(!state.text.includes('model changed'), state.text)
  assert.ok(state.text.includes('rename the router field'))
})

test('the clock block and the switch notice both stay out of the request slot', () => {
  const clock = { role: 'user', source: { kind: 'time-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 30: 22:51' }] }
  const ask = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the router' }] }
  const assistant = { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'working on it' }] }

  // Context: the clock block is noise, the assistant turn is real context.
  assert.equal(isContextMessage(clock), false)
  assert.equal(isContextMessage(assistant), true)

  // Request: only what the user typed, whichever message happens to be newest.
  assert.equal(isRoutableMessage(clock), false)
  assert.equal(isRoutableMessage(ask), true)
  const state = buildState([assistant, ask, clock], [], {}, {})
  assert.equal(state.task, 'fix the router')
  assert.ok(!state.text.includes('Time sampled'), state.text)
  assert.ok(state.text.includes('working on it'), 'assistant context is kept')
})

test('a request outside the message window still reaches the state', () => {
  const ask = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fix the routing hooks' }] }
  const tail = Array.from({ length: 12 }, (_, index) => ({
    role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: `step ${index}` }],
  }))
  const state = buildState([ask, ...tail], [], {}, {})
  assert.equal(state.task, 'fix the routing hooks')
  assert.ok(state.text.includes('fix the routing hooks'), 'the routed request is part of the state')
})

test('a request inside the window is not duplicated', () => {
  const ask = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'rename the field' }] }
  const state = buildState([ask], [], {}, {})
  assert.equal((state.text.match(/rename the field/g) ?? []).length, 1)
})

test('the decision endpoint is operator config, not a vendor constant', async () => {
  // No hard-coded host: an unconfigured client says so instead of calling one.
  await assert.rejects(
    callDecisionModel({ state: 'x', fetchImpl: async () => new Response('{}') }),
    /decision endpoint not configured/,
  )
  await assert.rejects(
    callDecisionModel({ baseURL: 'https://example.test/v1', state: 'x', fetchImpl: async () => new Response('{}') }),
    /decision model not configured/,
  )
  // A local server that wants no credential gets no authorization header.
  let sent = null
  await callDecisionModel({
    baseURL: 'https://example.test/v1',
    model: 'm',
    state: 'x',
    fetchImpl: async (_url, init) => {
      sent = init
      return new Response(JSON.stringify({ answers: {} }), { status: 200 })
    },
  })
  assert.equal(sent.headers.authorization, undefined)
})
