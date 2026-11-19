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

test('the composer toggle and the tier board are wired to real slots', () => {
  const client = read('client.js')
  assert.ok(client.includes("name: 'conversation.input.left'"), 'the toggle sits in the composer tool row')
  assert.ok(client.includes('function ComposerToggle'), 'the toggle is a component')
  assert.ok(client.includes('function TierBoard'), 'the board is a component')
  // Drag and click are the two gestures the design promises; both must exist.
  assert.ok(client.includes('onDragStart') && client.includes('onDrop'), 'capsules can be dragged between tiers')
  assert.ok(
    client.includes("off ? followAuto(key) : move(key, 'off')"),
    'clicking a capsule disables it',
  )
})

test('tier membership is computed on the host, not in the page', () => {
  const host = read('index.js')
  assert.ok(host.includes('assignTiers('), 'the host computes the assignment')
  assert.ok(host.includes('board,'), 'the snapshot carries the computed board')
  // The page reads `snap.board`; it must not re-derive membership itself.
  const client = read('client.js')
  assert.ok(client.includes('snap.board'), 'the page renders the host board')
  assert.ok(!client.includes('autoTierFor('), 'the page does not duplicate the assignment rule')
})

test('a failed decision never moves a session', () => {
  // A broken decision endpoint used to fall back to the default route and apply
  // it, which moved a running session onto another model and fought the
  // harness's own provider fallback.
  const source = read('index.js')
  assert.ok(
    source.includes("if (decision.source === 'error') return resolved"),
    'the error path must leave the selection alone',
  )
})

test('sticky routing treats the model that actually served as the commitment', () => {
  const source = read('index.js')
  assert.ok(source.includes('function servedSelection'), 'the request header is consulted')
  assert.ok(
    source.includes('committedSelection(agent) ?? servedSelection(agent)'),
    'sticky falls back to what actually ran before it considers re-routing',
  )
})

test('the client half never gates registration on page-wide state', () => {
  // A page-wide latch blocked a freshly loaded bundle in a warm page: the old
  // instance still held it, so the new UI never registered and nothing changed.
  // Duplicate registration is the injector's business, not the bundle's.
  const client = read('client.js')
  assert.ok(!client.includes('__autoModelRouterRegistered'), 'no cross-instance registration latch')
})

test('the tier board is computed even when the decision endpoint is down', () => {
  // The boards explains what routing would do; a dead endpoint must not blank it.
  const source = read('index.js')
  const assemble = source.slice(source.indexOf("ctx.on(\n    'system-prompt/assemble'"), source.indexOf("ctx.on('agent/inbox/inserted')"))
  assert.ok(assemble.includes('await assignedTiers()'), 'membership is refreshed before the decision')
  assert.ok(assemble.indexOf('await assignedTiers()') < assemble.indexOf('decideFor('), 'and before the decision runs')
})

test('a configure without a defaultRoute keeps the running one', () => {
  const source = read('index.js')
  assert.ok(
    source.includes('routes[config.defaultRoute] !== undefined'),
    'the previous default is preferred over the first route id',
  )
})

test('an empty catalog answer never shrinks the board', () => {
  const source = read('index.js')
  // The transient-empty case: adapters re-register after a reload and list every
  // provider as empty, which once collapsed the board to the tokenplan routes.
  assert.ok(source.includes('empty answer'), 'an empty list is treated as a failed refresh')
  assert.ok(source.includes('keeping the previous tier board'), 'a collapsed pool keeps the previous board')
  assert.ok(source.includes('SHARED.pool'), 'the pool behind the board is retained for that fallback')
  assert.ok(source.includes('catalogs.clear()'), 'a collapsed pool retries the catalog instead of trusting it')
})

test('a collapsed pool never becomes the published board', () => {
  const source = read('index.js')
  // Startup order puts the plugin before the provider adapters; the route-anchor
  // fallback must not be published as if it were a catalog.
  assert.ok(source.includes('COLLAPSED_POOL'), 'a collapsed pool is recognised')
  assert.ok(source.includes('scheduleBoardRetry'), 'the board retries while providers register')
  assert.ok(source.includes("if (walked === null) return resolved"), 'no decision is taken without a board')
})


test('derived envelope values never reach the operator config', () => {
  const source = read('index.js')
  // The translated floor is written to the routing copy only: writing it into
  // config.routes made a form round-trip persist a derived number as authored.
  assert.ok(source.includes('const routingRoutes'), 'the routing copy exists')
  assert.ok(source.includes('routingRoutes[id] = { ...routingRoutes[id], envelope: route.envelope }'))
  assert.ok(!/routes\[id\]\.envelope\s*=/.test(source), 'the operator config is not mutated')
  assert.ok(source.includes('Object.assign(routingRoutes, JSON.parse(JSON.stringify(merged.routes)))'), 'configure syncs the routing copy')
})

test('a forced tier constrains the selector instead of pinning an absent model', () => {
  const source = read('index.js')
  // Shipped routes carry only envelopes: the old branch selected undefined
  // provider/model and the force was inert.
  assert.ok(source.includes('forcesPin(forceId)'), 'force distinguishes a pinned model from a tier')
  assert.ok(source.includes('defaultRoute: forceTier ?? config.defaultRoute'), 'a tier force reaches the selector')
})

test('the shadow decision record carries the evidence an audit needs', () => {
  const source = read('index.js')
  // A shadow decision is only reviewable if the log holds the answer and what was
  // parsed from it; the log used to omit both.
  assert.ok(source.includes('answer: String(JSON.stringify(raw)).slice(0, 1500)'))
  assert.ok(source.includes('intent: parsed.intent'))
  assert.ok(source.includes('acknowledged: parsed.acknowledged === true'))
  assert.ok(source.includes('requestedModel: parsed.requestedModel'))
  // The shortlist must carry provider identity and include pinned route models.
  assert.ok(source.includes('offerModelIds(pool, routes)'))
  assert.ok(source.includes('offerModelIds(candidates, routes)'))
})
