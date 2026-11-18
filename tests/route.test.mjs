import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { selectRoute, selectionFor } from '../src/route.js'

function fakeAgent() {
  const calls = []
  return {
    calls,
    model: {
      select(selection) {
        calls.push(selection)
      },
    },
  }
}

test('selectRoute records the route on the agent', () => {
  const agent = fakeAgent()
  const recorded = selectRoute(agent, { id: 'deep', provider: 'p', model: 'm' }, null)
  assert.deepEqual(recorded, { provider: 'p', model: 'm' })
  assert.deepEqual(agent.calls, [{ provider: 'p', model: 'm' }])
})

test('selectRoute carries reasoning effort only when the route sets it', () => {
  const agent = fakeAgent()
  assert.deepEqual(selectionFor({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(selectionFor({ provider: 'p', model: 'm', reasoningEffort: 'high' }), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  selectRoute(agent, { provider: 'p', model: 'm', reasoningEffort: 'high' }, null)
  assert.equal(agent.calls[0].reasoningEffort, 'high')
})

test('selectRoute does nothing when the route is already in effect', () => {
  const agent = fakeAgent()
  const previous = { provider: 'p', model: 'm' }
  assert.equal(selectRoute(agent, { provider: 'p', model: 'm' }, previous), null)
  assert.equal(agent.calls.length, 0, 'no duplicate model/selection event')
})

test('selectRoute moves the agent when only the model changes', () => {
  const agent = fakeAgent()
  const recorded = selectRoute(agent, { provider: 'p', model: 'other' }, { provider: 'p', model: 'm' })
  assert.deepEqual(recorded, { provider: 'p', model: 'other' })
  assert.equal(agent.calls.length, 1)
})

test('an agent without a selectable model is left alone, not broken', () => {
  assert.equal(selectRoute({}, { provider: 'p', model: 'm' }, null), null)
  assert.equal(selectRoute(undefined, { provider: 'p', model: 'm' }, null), null)
  assert.equal(selectRoute({ model: {} }, { provider: 'p', model: 'm' }, null), null)
})

// ── the contract this plugin broke once, kept as a source lock ──────────────
test('the plugin never changes provider/model in the deprecated agent/request waterfall', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.ok(!/ctx\.on\(\s*['"]agent\/request['"]/.test(src), 'agent/request may not propose a model: the harness throws after step preparation')
  assert.ok(/agent\/model['"`]|model\.select\(/.test(src) || src.includes('recordSelection('), 'selection goes through agent.model.select()')
  assert.ok(src.includes("'agent/inbox/inserted'"), "the first step of a turn is pre-selected when the message lands")
})