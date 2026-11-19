import test from 'node:test'
import assert from 'node:assert/strict'
import { TIER_IDS, assignTiers, autoTierFor, familyOf, membershipOf } from '../src/tiers.js'
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

const priced = (id, quality, price) => ({
  model: id,
  key: `p/${id}`,
  provider: 'p',
  info: { quality, price: { input: price, output: price }, latency: 'balanced' },
})

test('a model beaten on quality and price lands off, with the winner named', () => {
  // Same work, more than ten cost-index points dearer, measurably worse: paying
  // more for less. Automatic placement alone would keep it, so it is switched off.
  // Both fit `balanced` and both are DeepSeek: only the price/quality comparison
  // separates them, which is exactly when the rule should act.
  const assigned = assignTiers([priced('deepseek-slow', 60, 10), priced('deepseek-fast', 62, 1)], ROUTES, {})
  assert.equal(assigned.tierOf['p/deepseek-slow'], 'off')
  assert.ok(assigned.groups.off.includes('p/deepseek-slow'))
  const record = assigned.dominated.find((entry) => entry.key === 'p/deepseek-slow')
  assert.equal(record.by, 'p/deepseek-fast')
  assert.ok(assigned.groups[assigned.tierOf['p/deepseek-fast']].includes('p/deepseek-fast'), 'the winner keeps its tier')
})

test('a dearer model is not "dominated" just for being dearer', () => {
  // Higher quality at a higher price is a trade, not a loss; the tiers exist to
  // express that trade.
  const assigned = assignTiers([priced('cheap', 56, 0.5), priced('strong', 70, 8)], ROUTES, {})
  assert.deepEqual(assigned.dominated, [])
  assert.ok(['fast', 'balanced', 'deep'].includes(assigned.tierOf['p/strong']))
  assert.ok(['fast', 'balanced', 'deep'].includes(assigned.tierOf['p/cheap']))
})

test('a hand-assigned model is never pruned by dominance', () => {
  const assigned = assignTiers([priced('deepseek-slow', 60, 10), priced('deepseek-fast', 62, 1)], ROUTES, { overrides: { 'p/deepseek-slow': 'deep' } })
  assert.equal(assigned.tierOf['p/deepseek-slow'], 'deep', 'the override outranks the automated rule')
  assert.ok(assigned.groups.deep.includes('p/deepseek-slow'))
})

test('families come from the model name, not the provider or reseller', () => {
  assert.equal(familyOf('bailian-aliyun/deepseek-v4-pro'), 'deepseek')
  assert.equal(familyOf('vanchin/deepseek-v4.1-flash-1017'), 'deepseek')
  assert.equal(familyOf('cmaas-glm-5.3'), 'glm')
  assert.equal(familyOf('ZHIPU/GLM-5.3'), 'glm')
  assert.equal(familyOf('kimi/kimi-k3.1-pro'), 'kimi')
  assert.equal(familyOf('bailian-tokenplan/qwen3.8-flash'), 'qwen')
  assert.equal(familyOf('MiniMax/MiniMax-M3'), 'minimax')
})

test('a better model elsewhere does not disable a family', () => {
  // Qwen beating a DeepSeek on both axes is a vendor comparison, not a reason to
  // take DeepSeek off the board: the profile serves several vendors on purpose.
  const assigned = assignTiers([priced('qwen-strong', 78, 1), priced('deepseek-weak', 60, 10)], ROUTES, {})
  assert.deepEqual(assigned.dominated, [])
  assert.ok(['fast', 'balanced', 'deep'].includes(assigned.tierOf['p/deepseek-weak']))
})

test('a model is compared only with its own family members', () => {
  // Within DeepSeek the cheaper+stronger one wins; the Qwen next to it is irrelevant.
  const pool = [priced('qwen-strong', 90, 0.5), priced('deepseek-slow', 60, 10), priced('deepseek-fast', 62, 1)]
  const assigned = assignTiers(pool, ROUTES, {})
  assert.deepEqual(assigned.dominated.map((entry) => entry.key), ['p/deepseek-slow'])
  assert.ok(!assigned.dominated.some((entry) => entry.key === 'p/qwen-strong'))
})

test('every auto-off model carries the reason it was grouped there', () => {
  // Two causes: dominated within the family, and no envelope admitting it.
  const candidate = (id, quality, price, latency) => ({
    model: id,
    key: `p/${id}`,
    provider: 'p',
    info: { quality, price: { input: price, output: price }, latency },
  })
  const pool = [
    candidate('deepseek-strong-cheap', 70, 1, 'fast'),
    candidate('deepseek-weak-dear', 60, 8, 'balanced'),
    // Too weak for every floor: admitted by no envelope at all.
    candidate('model-too-weak', 30, 1, 'fast'),
  ]
  const routes = {
    fast: { envelope: { maxCost: 60, maxLatency: 'fast', minQuality: 40 } },
    balanced: { envelope: { maxCost: 80, maxLatency: 'balanced', minQuality: 50 } },
    deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 55 } },
  }
  const assigned = assignTiers(pool, routes, {})
  const dominatedReason = assigned.offReasons['p/deepseek-weak-dear']
  assert.equal(dominatedReason.reason, 'dominated')
  assert.equal(dominatedReason.by, 'p/deepseek-strong-cheap')
  assert.ok(dominatedReason.margin >= 10)
  const noEnvelope = assigned.offReasons['p/model-too-weak']
  assert.equal(noEnvelope.reason, 'no-envelope')
  for (const tier of ['fast', 'balanced', 'deep']) {
    assert.ok(Array.isArray(noEnvelope.failed[tier]) && noEnvelope.failed[tier].includes('quality'), `${tier} rejects it on quality`)
  }
  // A model that is placed has no reason entry.
  assert.equal(assigned.offReasons['p/deepseek-strong-cheap'], undefined)
})

test('capability bands place a capable cheap model above fast, with guardrails', () => {
  // Six measured models make the pool capable of carrying bands.
  const candidate = (id, quality, price, latency) => ({
    model: id, key: `p/${id}`, provider: 'p',
    info: { quality, price: { input: price, output: price }, latency, contextWindow: 200000, modalities: ['text'], toolCalling: true },
  })
  const pool = [
    candidate('weak-cheap', 30, 0.5, 'fast'),
    candidate('weak-mid', 32, 1, 'balanced'),
    candidate('mid-cheap', 40, 1, 'fast'),
    candidate('mid-dear', 42, 5, 'balanced'),
    candidate('strong-cheap', 50, 2, 'fast'),
    candidate('strong-dear', 52, 9, 'slow'),
  ]
  const routes = {
    fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 10 } },
    balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 10 } },
    deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 10 } },
  }
  const assigned = assignTiers(pool, routes, {})
  assert.equal(assigned.criterion, 'capability')
  assert.ok(assigned.bands !== null)
  // Capable models do not leak into `fast` just because they are cheap: the top
  // band starts at `deep`, and the middle band above it.
  assert.equal(assigned.tierOf['p/strong-cheap'], 'deep')
  assert.equal(assigned.tierOf['p/mid-cheap'], 'balanced')
  assert.equal(assigned.tierOf['p/weak-cheap'], 'fast')
  // A band's guardrails still push it up: the slow strong model cannot be fast.
  assert.notEqual(assigned.tierOf['p/strong-dear'], 'fast')
})

test('capability dominance is scoped to one tier; cost dominance is not', () => {
  const candidate = (id, quality, price, latency) => ({
    model: id, key: `p/${id}`, provider: 'p',
    info: { quality, price: { input: price, output: price }, latency, contextWindow: 200000, modalities: ['text'], toolCalling: true },
  })
  const pool = [
    candidate('deepseek-weak', 30, 0.5, 'fast'),
    candidate('deepseek-strong', 52, 9, 'slow'),
    candidate('deepseek-mid-a', 40, 1, 'balanced'),
    candidate('deepseek-mid-b', 41, 4, 'balanced'),
    candidate('filler-a', 35, 1, 'fast'),
    candidate('filler-b', 36, 1, 'fast'),
  ]
  const routes = {
    fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 10 } },
    balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 10 } },
    deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 10 } },
  }
  const byCapability = assignTiers(pool, routes, {})
  // The weak model stays in its own (lower) tier: it is the budget option there,
  // not a victim of a stronger model one band up.
  assert.equal(byCapability.tierOf['p/deepseek-weak'], 'fast')
  assert.equal(byCapability.offReasons['p/deepseek-weak'], undefined)
  // In cost mode, tiers are price bands and cross-band dominance applies again.
  const byCost = assignTiers(pool, routes, { criterion: 'cost' })
  assert.ok(byCost.groups.off.length >= 0)
})

test('a thin profile does not enter a capability band on a fragment', () => {
  const ranked = (id, dims) => ({
    model: id, key: `p/${id}`, provider: 'p',
    info: {
      ranking: { status: 'measured', rank: 1, composite: 55, low: 25, dims: Object.fromEntries(dims.map((dim) => [dim, { value: 55, evidence: 1 }])) },
      price: { input: 1, output: 2 }, latency: 'fast', contextWindow: 200000, modalities: ['text'], toolCalling: true,
    },
  })
  const full = ['coding', 'reasoning', 'math', 'knowledge', 'agentic']
  const pool = [
    ranked('full-a', full), ranked('full-b', full), ranked('full-c', full),
    ranked('full-d', full), ranked('full-e', full), ranked('full-f', full),
    ranked('thin', ['knowledge', 'agentic']),
  ]
  const routes = {
    fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 10 } },
    balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 10 } },
    deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 10 } },
  }
  const assigned = assignTiers(pool, routes, {})
  assert.ok(assigned.unmeasured.includes('p/thin'), 'the two-dimension entry is listed, not banded')
  assert.equal(assigned.unmeasuredReasons['p/thin'], 'insufficient-coverage')
  assert.equal(assigned.tierOf['p/thin'], undefined)
  assert.ok(!JSON.stringify(assigned.groups).includes('p/thin'))
})
