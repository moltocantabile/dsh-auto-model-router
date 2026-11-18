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
  provider: 'p',
  info: {
    price: { input: price, output: price },
    scores: { composite: quality },
    quality,
    latency,
  },
})

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
  assert.deepEqual(new Set(placed), new Set(POOL.map((entry) => entry.model)))
})

test('an override moves a model and is reported as hand-assigned', () => {
  const assigned = assignTiers(POOL, ROUTES, { overrides: { 'cheap-good': 'deep' } })
  assert.ok(assigned.groups.deep.includes('cheap-good'))
  assert.ok(!assigned.groups.fast.includes('cheap-good'), 'a model is in one tier only')
  assert.deepEqual(assigned.overridden, ['cheap-good'])
  assert.equal(assigned.mode, 'auto', 'an override does not switch the whole board to manual')
})

test('a disabled model leaves routing but stays visible in the off group', () => {
  const assigned = assignTiers(POOL, ROUTES, { disabled: ['mid-good'] })
  assert.equal(assigned.tierOf['mid-good'], 'off')
  assert.deepEqual(assigned.groups.off, ['mid-good'])
  assert.ok(!TIER_IDS.some((id) => assigned.groups[id].includes('mid-good')))
})

test('manual mode routes only what the operator assigned', () => {
  const assigned = assignTiers(POOL, ROUTES, { mode: 'manual', overrides: { 'mid-good': 'balanced' } })
  assert.deepEqual(assigned.groups.balanced, ['mid-good'])
  assert.deepEqual(new Set(assigned.unassigned), new Set(['cheap-weak', 'cheap-good', 'expensive-strong']))
})

test('an override wins over auto placement even in manual mode', () => {
  const assigned = assignTiers(POOL, ROUTES, { mode: 'manual', overrides: { 'expensive-strong': 'fast' } })
  assert.deepEqual(assigned.groups.fast, ['expensive-strong'])
})

test('a model fitting no envelope is off, not quietly routed', () => {
  // Below every quality floor: not expensive-but-good (the cost index is capped
  // at 100, so price alone can never disqualify a model from `deep`), just weak.
  const impossible = model('too-weak', { price: 400, quality: 30, latency: 'slow' })
  const assigned = assignTiers([impossible], ROUTES, {})
  assert.equal(assigned.tierOf['too-weak'], 'off')
  assert.deepEqual(assigned.unassigned, ['too-weak'])
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
  assert.ok(assigned.groups.deep.includes(result.selected.model), `selected ${result.selected.model}`)
})

test('an empty tier widens to the default instead of ranking the whole pool', () => {
  const assigned = assignTiers(POOL, ROUTES, { disabled: ['expensive-strong'] })
  const membership = membershipOf(assigned)
  assert.equal(membership.deep.size, 0)
  const profile = { shape: 'implement', depth: 3.8, breadth: 3.5, risk: 3.2, vision: false, tools: true }
  const result = selectForTier(profile, POOL, ROUTES, { defaultRoute: 'balanced', membership })
  assert.equal(result.tier, 'balanced', 'it widened rather than serving deep work from nowhere')
  assert.equal(result.widened, true)
  assert.notEqual(result.selected.model, 'expensive-strong', 'the disabled model never comes back')
})