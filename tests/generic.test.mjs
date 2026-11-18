import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DEFAULT_DECISION, DEFAULT_ROUTES } from '../src/decision.js'

const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('no default names a provider, a model, or a vendor host', () => {
  assert.equal(DEFAULT_DECISION.baseURL, '', 'an unconfigured endpoint must not be a vendor endpoint')
  assert.equal(DEFAULT_DECISION.credentialRef, '', 'no vendor credential name is baked in')
  assert.equal(DEFAULT_DECISION.model, '')
  for (const [tier, route] of Object.entries(DEFAULT_ROUTES)) {
    assert.equal(route.provider, null, `${tier} is an envelope, not a provider`)
    assert.equal(route.model, null, `${tier} is an envelope, not a model`)
    assert.ok(route.envelope !== undefined, `${tier} still carries its envelope`)
  }
})

test('the decision client and the router carry no vendor identifiers', () => {
  for (const file of ['decision.js', 'index.js', 'select.js']) {
    const source = read(file).toLowerCase()
    for (const vendor of ['bailian', 'aliyuncs', 'token-plan', 'qwen', 'deepseek-v4', 'glm-']) {
      assert.ok(!source.includes(vendor), `${file} mentions "${vendor}"`)
    }
  }
})

test('an envelope-only route is still a route', () => {
  // Guards the regression that made the generic default unusable: `configure`
  // used to reject every route without a provider and a model, which is exactly
  // what the shipped defaults are.
  const source = read('index.js')
  assert.ok(source.includes('const pinned = provider.length > 0 && model.length > 0'))
  assert.ok(!source.includes("if (provider.length === 0 || model.length === 0) continue"))
})

test('sticky routing keeps a chosen model but still routes a default one', () => {
  // The harness writes a model/selection event at startup for the configured
  // default; treating that as a choice would leave every session unrouted.
  const source = read('index.js')
  const body = source.slice(source.indexOf('function committedSelection'), source.indexOf('function selectRoute'))
  assert.ok(body.includes('agent.options'), 'the startup selection is compared against the agent options')
  assert.ok(body.includes('return null'), 'a selection equal to the configured default is not a commitment')
})
