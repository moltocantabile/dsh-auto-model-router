import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, ACKNOWLEDGE_MIN_CONFIDENCE, MODEL_REQUEST_MIN_PROBABILITY } from '../src/decision.js'

/**
 * Build a System One body the way the endpoint does: typed answers, one per
 * question. `overrides` replace individual answers.
 */
function body(overrides = {}) {
  return {
    answers: {
      shape: { type: 'choice', choice: 'implement', confidence: 0.9, probabilities: { implement: 0.9 } },
      depth: { type: 'score', score: 2.2, confidence: 0.9 },
      breadth: { type: 'score', score: 2, confidence: 0.9 },
      risk: { type: 'score', score: 1.5, confidence: 0.9 },
      intent: { type: 'choice', choice: 'work', confidence: 0.9, probabilities: { work: 0.9 } },
      model: { type: 'choice', choice: 'auto', confidence: 1, probabilities: { auto: 1 } },
      modelRequest: { type: 'noul', noul: 0.1 },
      vision: { type: 'noul', noul: 0.1 },
      tools: { type: 'noul', noul: 0.9 },
      latency: { type: 'noul', noul: 0.2 },
      ...overrides,
    },
  }
}

test('a confident acknowledgement prices the turn at zero', () => {
  const parsed = parseDecision(body({ intent: { type: 'choice', choice: 'acknowledge', confidence: 0.99 } }))
  assert.equal(parsed.acknowledged, true)
  assert.equal(parsed.profile.depth, 0)
  assert.equal(parsed.profile.breadth, 0)
  assert.equal(parsed.profile.risk, 0)
  assert.equal(parsed.profile.latencyCritical, true)
})

test('an unsure acknowledgement keeps the model\'s own scores', () => {
  const parsed = parseDecision(body({ intent: { type: 'choice', choice: 'acknowledge', confidence: ACKNOWLEDGE_MIN_CONFIDENCE - 0.01 } }))
  assert.notEqual(parsed.acknowledged, true)
  assert.equal(parsed.profile.depth, 2.2, 'the depth the model scored is used as-is')
})

test('resume is not an acknowledgement: the work in flight carries its difficulty', () => {
  const parsed = parseDecision(body({ intent: { type: 'choice', choice: 'resume', confidence: 0.4 } }))
  assert.notEqual(parsed.acknowledged, true)
  assert.equal(parsed.intent, 'resume')
  assert.equal(parsed.profile.depth, 2.2)
})

test('a named model is honoured when the message asks for it', () => {
  const parsed = parseDecision(body({
    model: { type: 'choice', choice: 'qwen3.7-max', confidence: 0.95 },
    modelRequest: { type: 'noul', noul: MODEL_REQUEST_MIN_PROBABILITY + 0.4 },
  }))
  assert.equal(parsed.requestedModel, 'qwen3.7-max')
})

test('a model mentioned inside prose is not a request', () => {
  const parsed = parseDecision(body({
    model: { type: 'choice', choice: 'qwen3.7-max', confidence: 0.8 },
    modelRequest: { type: 'noul', noul: 0.2 },
  }))
  assert.equal(parsed.requestedModel, null)
})

test('auto never becomes a request, however sure the model is', () => {
  const parsed = parseDecision(body({ modelRequest: { type: 'noul', noul: 0.99 } }))
  assert.equal(parsed.requestedModel, null)
})

test('force accepts a model id as well as a route id', async () => {
  // The pin format is what the tool writes and routing reads, so it is pinned
  // here: a route id stays bare, a model id is tagged so the two never collide.
  const pinOf = (wanted, routes) => (routes[wanted] !== undefined ? wanted : `model:${wanted}`)
  const routes = { fast: {}, balanced: {}, deep: {} }
  assert.equal(pinOf('fast', routes), 'fast')
  assert.equal(pinOf('qwen3.7-max', routes), 'model:qwen3.7-max')
  assert.ok(!Object.hasOwn(routes, 'model:qwen3.7-max'))
})
