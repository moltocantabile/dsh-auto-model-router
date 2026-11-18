import test from 'node:test'
import assert from 'node:assert/strict'
import { TIER_IDS, assignTiers, autoTierFor, membershipOf } from '../src/tiers.js'
import { selectForTier, tierFor } from '../src/select.js'

const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 } },
}

const model = (id, { price, quality, latency }) => ({
  model: id,
  key: `p/${id}`,
  provider: 'p',
  info: {
    price: { input: price, output: price },
    scores: { composite: quality },
    quality,
    latency,
  },
})

const K = (id) => `p/${id}`

const POOL = [
  model('cheap-weak', { price: 0.2, quality: 48, latency: 'fast' }),
  model('cheap-good', { price: 0.8, quality: 60, latency: 'fast' }),
  model('mid-good', { price: 3, quality: 70, latency: 'balanced' }),
  model('expensive-strong', { price: 12, quality: 78, latency: 'slow' }),
]

test('auto tier is the cheapest envelope the model satisfies', () => {
  // Nothing is asked of the operator: a model joins the first tier that admits it.
  const cheap = autoTierFor(POOL[0].info, ROUTES)
  assert.equal(cheap, 'fast')
  const strong = autoTierFor(POOL[3].info, ROUTES)
  assert.equal(strong, 'deep', 'a slow, expensive model cannot serve the cheaper tiers')
})

test('every model lands in exactly one tier', () => {
  const assigned = assignTiers(POOL, ROUTES, {})
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.equal(placed.length, POOL.length)
  assert.equal(new Set(placed).size, POOL.length, 'no model appears twice')
  assert.deepEqual(new Set(placed), new Set(POOL.map((entry) => K(entry.model))))
})

test('an override moves a model and is reported as hand-assigned', () => {
  const assigned = assignTiers(POOL, ROUTES, { overrides: { [K('cheap-good')]: 'deep' } })
  assert.ok(assigned.groups.deep.includes(K('cheap-good')))
  assert.ok(!assigned.groups.fast.includes(K('cheap-good')), 'a model is in one tier only')
  assert.deepEqual(assigned.overridden, [K('cheap-good')])
  assert.equal(assigned.mode, 'auto', 'an override does not switch the whole board to manual')
})

test('a disabled model leaves routing but stays visible in the off group', () => {
  const assigned = assignTiers(POOL, ROUTES, { disabled: [K('mid-good')] })
  assert.equal(assigned.tierOf[K('mid-good')], 'off')
  assert.deepEqual(assigned.groups.off, [K('mid-good')])
  assert.ok(!TIER_IDS.some((id) => assigned.groups[id].includes(K('mid-good'))))
})

test('manual mode routes only what the operator assigned', () => {
  const assigned = assignTiers(POOL, ROUTES, { mode: 'manual', overrides: { [K('mid-good')]: 'balanced' } })
  assert.deepEqual(assigned.groups.balanced, [K('mid-good')])
  assert.deepEqual(new Set(assigned.unassigned), new Set([K('cheap-weak'), K('cheap-good'), K('expensive-strong')]))
})

test('an override wins over auto placement even in manual mode', () => {
  const assigned = assignTiers(POOL, ROUTES, { mode: 'manual', overrides: { [K('expensive-strong')]: 'fast' } })
  assert.deepEqual(assigned.groups.fast, [K('expensive-strong')])
})

test('a model fitting no envelope is off, not quietly routed', () => {
  // Below every quality floor: not expensive-but-good (the cost index is capped
  // at 100, so price alone can never disqualify a model from `deep`), just weak.
  const impossible = model('too-weak', { price: 400, quality: 30, latency: 'slow' })
  const assigned = assignTiers([impossible], ROUTES, {})
  assert.equal(assigned.tierOf[K('too-weak')], 'off')
  assert.deepEqual(assigned.unassigned, [K('too-weak')])
})

test('membership restricts selection to the tier it names', () => {
  const assigned = assignTiers(POOL, ROUTES, {})
  const membership = membershipOf(assigned)
  for (const id of TIER_IDS) {
    assert.ok(membership[id] instanceof Set)
    assert.deepEqual([...membership[id]], assigned.groups[id])
  }

  // A profile that wants `deep` never reaches a model the assignment kept in fast.
  const profile = { shape: 'implement', depth: 3.8, breadth: 3.5, risk: 3.2, vision: false, tools: true }
  assert.equal(tierFor(profile, ROUTES), 'deep')
  const result = selectForTier(profile, POOL, ROUTES, { defaultRoute: 'balanced', membership })
  assert.ok(assigned.groups.deep.includes(K(result.selected.model)), `selected ${result.selected.model}`)
})

test('an empty tier widens to the default instead of ranking the whole pool', () => {
  const assigned = assignTiers(POOL, ROUTES, { disabled: [K('expensive-strong')] })
  const membership = membershipOf(assigned)
  assert.equal(membership.deep.size, 0)
  const profile = { shape: 'implement', depth: 3.8, breadth: 3.5, risk: 3.2, vision: false, tools: true }
  const result = selectForTier(profile, POOL, ROUTES, { defaultRoute: 'balanced', membership })
  assert.equal(result.tier, 'balanced', 'it widened rather than serving deep work from nowhere')
  assert.equal(result.widened, true)
  assert.notEqual(result.selected.model, 'expensive-strong', 'the disabled model never comes back')
})
test('a model with no measurement is not placed and not routed', () => {
  // A provider can advertise hundreds of ids nobody measured. Placing them in a
  // tier would rank them on a prior; listing them under `off` would bury the
  // models the operator switched off on purpose.
  const unmeasured = { model: 'unknown-model', key: 'p/unknown-model', provider: 'p', info: null }
  const assigned = assignTiers([...POOL, unmeasured], ROUTES, {})
  assert.equal(assigned.tierOf[K('unknown-model')], undefined)
  assert.deepEqual(assigned.unmeasured, [K('unknown-model')])
  assert.deepEqual(assigned.groups.off, [], 'the off lane stays for deliberate switches')
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.ok(!placed.includes(K('unknown-model')))
})

test('manual mode still routes an unmeasured model the operator placed by hand', () => {
  const unmeasured = { model: 'unknown-model', key: 'p/unknown-model', provider: 'p', info: null }
  const assigned = assignTiers([unmeasured], ROUTES, { mode: 'manual', overrides: { 'p/unknown-model': 'balanced' } })
  assert.deepEqual(assigned.groups.balanced, [K('unknown-model')])
})

test('the assignment records which provider each model came from', () => {
  // Two providers can serve the same id; the board labels capsules
  // `provider/model`, so membership without provenance is not enough.
  const pool = [
    { model: 'shared-id', provider: 'provider-a', info: { quality: 70, price: { input: 1, output: 2 }, latency: 'fast' } },
    { model: 'cheap-weak', provider: 'provider-b', info: { quality: 48, price: { input: 0.2, output: 0.2 }, latency: 'fast' } },
  ]
  const assigned = assignTiers(pool, ROUTES, {})
  assert.equal(assigned.providerOf['provider-a/shared-id'], 'provider-a')
  assert.equal(assigned.providerOf['provider-b/cheap-weak'], 'provider-b')
  assert.equal(assigned.modelOf['provider-a/shared-id'], 'shared-id')
})

test('the same model id on two providers is two entries, not one', () => {
  // deepseek-v4-pro is served by three of this profile's providers; collapsing
  // them would hide endpoints and mislabel the capsule.
  const info = { quality: 70, price: { input: 3, output: 9 }, latency: 'balanced' }
  const pool = [
    { model: 'deepseek-v4-pro', key: 'provider-a/deepseek-v4-pro', provider: 'provider-a', info },
    { model: 'deepseek-v4-pro', key: 'provider-b/deepseek-v4-pro', provider: 'provider-b', info },
  ]
  const assigned = assignTiers(pool, ROUTES, {})
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.equal(placed.length, 2)
  assert.deepEqual(new Set(placed), new Set(['provider-a/deepseek-v4-pro', 'provider-b/deepseek-v4-pro']))
  assert.equal(assigned.modelOf['provider-a/deepseek-v4-pro'], 'deepseek-v4-pro')
})
