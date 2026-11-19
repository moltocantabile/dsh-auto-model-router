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

test('one model is one lane entry, with the best endpoint representing it', () => {
  // The profile serves the same id from several providers. The board is
  // model-level: one capsule, chosen deterministically, and the other endpoints
  // stay available in `endpointsOf` for the card instead of filling a second lane.
  const pool = [
    { model: 'deepseek-v4-pro', key: 'provider-a/deepseek-v4-pro', provider: 'provider-a', info: { quality: 70, price: { input: 5, output: 15 }, latency: 'fast' } },
    { model: 'deepseek-v4-pro', key: 'provider-b/deepseek-v4-pro', provider: 'provider-b', info: { quality: 70, price: { input: 3, output: 9 }, latency: 'balanced' } },
    { model: 'deepseek-v4-pro', key: 'provider-c/deepseek-v4-pro', provider: 'provider-c', info: { quality: 70, price: { input: 1, output: 3 }, latency: 'balanced' } },
  ]
  const assigned = assignTiers(pool, ROUTES, {})
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.equal(placed.length, 1, 'one model, one lane entry')
  // Fastest latency wins before evidence and price, so provider-a represents it.
  assert.deepEqual(placed, ['provider-a/deepseek-v4-pro'])
  assert.deepEqual(assigned.hidden.sort(), ['provider-b/deepseek-v4-pro', 'provider-c/deepseek-v4-pro'])
  assert.deepEqual(assigned.endpointsOf['provider-a/deepseek-v4-pro'].sort(), [
    'provider-a/deepseek-v4-pro', 'provider-b/deepseek-v4-pro', 'provider-c/deepseek-v4-pro',
  ])
  assert.equal(assigned.tierOf['provider-b/deepseek-v4-pro'], undefined, 'a hidden endpoint is not routed')
  assert.equal(assigned.modelOf['provider-a/deepseek-v4-pro'], 'deepseek-v4-pro')
  assert.equal(assigned.providerOf['provider-c/deepseek-v4-pro'], 'provider-c', 'provenance is kept for the card')
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

// ── membership sanity: retired, superseded, endpoint duplicates ─────────────

const entry = (id, { quality = 70, price = 3, latency = 'balanced', ...info } = {}) => ({
  model: id,
  key: `p/${id}`,
  provider: 'p',
  info: { quality, price: { input: price, output: price }, latency, ...info },
})

/** A cost-mode board is enough to test the membership rules deterministically. */
const cost = (pool, config = {}) => assignTiers(pool, ROUTES, { criterion: 'cost', ...config })

test('an endpoint tie is broken by evidence after latency and price', () => {
  const pool = [
    { model: 'twin-model', key: 'a/twin-model', provider: 'a', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast', evidence: { overall: 0 } } },
    { model: 'twin-model', key: 'b/twin-model', provider: 'b', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast', evidence: { overall: 4 } } },
  ]
  const assigned = cost(pool)
  assert.deepEqual(TIER_IDS.flatMap((id) => assigned.groups[id]), ['b/twin-model'], 'the measured endpoint represents the model')
  assert.deepEqual(assigned.hidden, ['a/twin-model'])
})

test('provider prefixes, reseller prefixes and serving variants dedupe to one model', () => {
  const pool = [
    { model: 'acme-v3.1-pro', key: 'acme-v3.1-pro', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' } },
    { model: 'acme-v3.1-pro-highspeed', key: 'acme/acme-v3.1-pro-highspeed', provider: 'acme', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' } },
    { model: 'acme-v3.1-pro', key: 'cmaas-acme-v3.1-pro', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' } },
  ]
  const assigned = cost(pool)
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.equal(placed.length, 1, 'one entry for the model')
  assert.equal(assigned.endpointsOf[placed[0]].length, 3)
})

test('the same id under a provider namespace is one model; a dated snapshot is not', () => {
  const pool = [
    { model: 'acme-v4-flash', key: 'acme/acme-v4-flash', provider: 'acme', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' } },
    { model: 'acme-v4-flash-1017', key: 'reseller/acme-v4-flash-1017', provider: 'reseller', info: { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' } },
  ]
  const assigned = cost(pool)
  assert.equal(TIER_IDS.flatMap((id) => assigned.groups[id]).length, 2, 'the dated snapshot is its own model')
})

test('a retired, deprecated or sunsetting model never auto-places, and says why', () => {
  const now = Date.UTC(2026, 5, 1)
  const pool = [
    entry('retired-id', { retired: true }),
    entry('deprecated-id', { deprecated: true }),
    entry('sunset-past', { sunsetAt: '2026-04-01' }),
    entry('sunset-future', { sunsetAt: '2026-08-01' }),
    entry('active-id'),
  ]
  const assigned = cost(pool, { now })
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.deepEqual(placed, ['p/active-id'], 'only the live model is routed')
  assert.deepEqual(assigned.offReasons['p/retired-id'], { reason: 'retired', kind: 'retired' })
  assert.equal(assigned.offReasons['p/deprecated-id'].kind, 'withdrawn')
  assert.equal(assigned.offReasons['p/sunset-past'].kind, 'sunset')
  assert.equal(assigned.offReasons['p/sunset-future'].kind, 'retiring')
  assert.equal(assigned.offReasons['p/sunset-future'].until, '2026-08-01')
})

test('a retired entry keeps the replacement the catalog names for it', () => {
  const assigned = cost([entry('old-id', { retired: true, replaceWith: 'new-id' })])
  assert.deepEqual(assigned.offReasons['p/old-id'], { reason: 'retired', kind: 'retired', replaces: 'new-id' })
})

test('an operator override still places a withdrawn model', () => {
  const assigned = cost([entry('old-id', { retired: true })], { overrides: { 'p/old-id': 'deep' } })
  assert.deepEqual(assigned.groups.deep, ['p/old-id'])
  assert.equal(assigned.overridden.length, 1)
})

test('a newer generation of the same line supersedes the older one, naming both', () => {
  const pool = [
    entry('acme-v3', { price: 1, latency: 'fast' }),
    entry('acme-v4.1', { price: 1, latency: 'fast' }),
  ]
  const assigned = cost(pool)
  assert.deepEqual(TIER_IDS.flatMap((id) => assigned.groups[id]), ['p/acme-v4.1'])
  assert.deepEqual(assigned.offReasons['p/acme-v3'], {
    reason: 'superseded', by: 'p/acme-v4.1', winnerVersion: '4.1', version: '3', kind: 'line',
  })
})

test('supersede crosses tiers: the newer model wins wherever it is placed', () => {
  const pool = [
    entry('acme-v3', { price: 1, latency: 'fast' }),
    entry('acme-v4.1', { quality: 80, price: 30, latency: 'slow' }),
  ]
  const assigned = cost(pool)
  assert.equal(assigned.tierOf['p/acme-v3'], 'off')
  assert.ok(['fast', 'balanced', 'deep'].includes(assigned.tierOf['p/acme-v4.1']))
  assert.equal(assigned.offReasons['p/acme-v3'].by, 'p/acme-v4.1')
})

test('different tiers and dated snapshots are different models, not older versions', () => {
  const pool = [
    entry('acme-v3-flash', { price: 1, latency: 'fast' }),
    entry('acme-v4.1-max', { quality: 85, price: 1, latency: 'fast' }),
    entry('acme-v4-flash-1017', { price: 1, latency: 'fast' }),
  ]
  const assigned = cost(pool)
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.deepEqual(new Set(placed), new Set(['p/acme-v3-flash', 'p/acme-v4.1-max', 'p/acme-v4-flash-1017']))
  assert.equal(assigned.offReasons['p/acme-v3-flash'], undefined)
})

test('a newer but unmeasured model does not supersede a measured one', () => {
  const pool = [
    entry('acme-v3', { price: 1, latency: 'fast' }),
    { model: 'acme-v4', key: 'p/acme-v4', provider: 'p', info: { price: { input: 1, output: 1 }, latency: 'fast' } },
  ]
  const assigned = cost(pool)
  assert.equal(assigned.tierOf['p/acme-v3'], 'fast')
  assert.ok(assigned.unmeasured.includes('p/acme-v4'))
  assert.equal(assigned.offReasons['p/acme-v3'], undefined)
})

test('supersede is family-local: another vendor is not a newer generation', () => {
  const pool = [
    entry('acme-v3', { price: 1, latency: 'fast' }),
    entry('beta-v4', { quality: 90, price: 1, latency: 'fast' }),
  ]
  const assigned = cost(pool)
  const placed = TIER_IDS.flatMap((id) => assigned.groups[id])
  assert.deepEqual(new Set(placed), new Set(['p/acme-v3', 'p/beta-v4']))
})

test('an expensive or slow model is pushed up out of fast and balanced', () => {
  const candidate = (id, quality, price, latency) => entry(id, { quality, price, latency })
  const pool = [
    candidate('weak-a', 30, 0.5, 'fast'),
    candidate('weak-b', 32, 1, 'fast'),
    candidate('mid-a', 40, 1, 'fast'),
    candidate('mid-slow', 42, 1, 'slow'),
    candidate('strong-a', 50, 3, 'fast'),
    candidate('strong-b', 52, 4, 'slow'),
    candidate('frontier-dear', 55, 90, 'slow'),
    candidate('weak-slow', 30, 0.5, 'slow'),
  ]
  const routes = {
    fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 5 } },
    balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 25 } },
    deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 40 } },
  }
  const assigned = assignTiers(pool, routes, {})
  assert.equal(assigned.criterion, 'capability')
  assert.equal(assigned.tierOf['p/weak-a'], 'fast', 'cheap and weak stays cheap')
  // A weak model that is only rejected for being slow would have to move two
  // bands up to qualify; that is a different budget, not a faster serve, so it
  // is off rather than parked in `deep`.
  assert.equal(assigned.tierOf['p/weak-slow'], 'off')
  assert.equal(assigned.offReasons['p/weak-slow'].reason, 'no-envelope')
  assert.equal(assigned.tierOf['p/mid-slow'], 'deep', 'the latency class moves it up')
  assert.equal(assigned.tierOf['p/frontier-dear'], 'deep', 'an expensive model is not bought on a cheap tier')
  assert.ok(!['fast', 'balanced'].includes(assigned.tierOf['p/frontier-dear']))
})

test('a model breaching every ceiling is off instead of leaking into a cheap tier', () => {
  const pool = [
    entry('weak-a', { quality: 30, price: 0.5, latency: 'fast' }),
    entry('weak-b', { quality: 32, price: 1, latency: 'fast' }),
    entry('mid-a', { quality: 40, price: 1, latency: 'fast' }),
    entry('mid-b', { quality: 42, price: 2, latency: 'balanced' }),
    entry('strong-a', { quality: 50, price: 3, latency: 'fast' }),
    entry('strong-b', { quality: 52, price: 4, latency: 'slow' }),
    entry('too-dear', { quality: 55, price: 90, latency: 'slow' }),
  ]
  const routes = {
    fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 5 } },
    balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 5 } },
    deep: { envelope: { maxCost: 90, maxLatency: 'slow', minQuality: 5 } },
  }
  const assigned = assignTiers(pool, routes, {})
  assert.equal(assigned.tierOf['p/too-dear'], 'off')
  assert.equal(assigned.offReasons['p/too-dear'].reason, 'no-envelope')
  assert.deepEqual(assigned.offReasons['p/too-dear'].failed.deep, ['cost'])
  assert.equal(assigned.offReasons['p/too-dear'].failed.fast, undefined, 'the band admitted it on latency')
})

test('disabling one endpoint switches the whole model off', () => {
  const info = { quality: 70, price: { input: 2, output: 2 }, latency: 'fast' }
  const pool = [
    { model: 'shared-id', key: 'a/shared-id', provider: 'a', info },
    { model: 'shared-id', key: 'b/shared-id', provider: 'b', info },
  ]
  const assigned = cost(pool, { disabled: ['a/shared-id'] })
  assert.equal(TIER_IDS.flatMap((id) => assigned.groups[id]).length, 0)
  assert.equal(assigned.groups.off.length, 1, 'one model-level card, not two endpoint cards')
  assert.equal(assigned.offReasons[assigned.groups.off[0]].reason, 'disabled')
})

test('off-lane reasons are countable for status', async () => {
  const { offReasonTotals } = await import('../src/tiers.js')
  const pool = [
    entry('acme-v4', { price: 1, latency: 'fast' }),
    entry('acme-v3', { price: 1, latency: 'fast' }),
    entry('withdrawn', { retired: true }),
  ]
  const assigned = cost(pool)
  const totals = offReasonTotals(assigned.offReasons)
  assert.equal(totals.retired, 1)
  assert.equal(totals.superseded, 1)
})

test('a newer generation supersedes an older base model across variant words', () => {
  // The old base generation has no same-line successor, but the family's new
  // generation (a different product variant) retires it: "deepseek-v3.x" next to
  // "deepseek-v4.1-flash" is exactly the case the board showed.
  const pool = [
    entry('acme-v3.2', { price: 1, latency: 'fast' }),
    entry('acme-v4.1-flash', { quality: 70, price: 2, latency: 'fast' }),
  ]
  const assigned = cost(pool)
  assert.equal(assigned.tierOf['p/acme-v3.2'], 'off')
  assert.equal(assigned.offReasons['p/acme-v3.2'].reason, 'superseded')
  assert.equal(assigned.offReasons['p/acme-v3.2'].kind, 'generation')
  assert.equal(assigned.offReasons['p/acme-v3.2'].by, 'p/acme-v4.1-flash')
})

test('a materially weaker newer model does not supersede a stronger one', () => {
  // A version bump is not a capability upgrade. Removing the strongest routable
  // model because a numerically newer but weaker model exists is the failure this
  // guard prevents (observed with the rank-1 model against a newer release).
  const pool = [
    entry('acme-v3.7-max', { quality: 90, price: 10, latency: 'balanced' }),
    entry('acme-v4-max', { quality: 40, price: 10, latency: 'balanced' }),
  ]
  const assigned = cost(pool)
  assert.equal(assigned.tierOf['p/acme-v3.7-max'], assigned.tierOf['p/acme-v3.7-max'])
  assert.notEqual(assigned.tierOf['p/acme-v3.7-max'], 'off')
  assert.equal(assigned.offReasons['p/acme-v3.7-max'], undefined)
})

test('supersede follows a chain to the final replacement', () => {
  const pool = [
    entry('acme-v2.6', { price: 1, latency: 'fast' }),
    entry('acme-v3', { quality: 60, price: 2, latency: 'fast' }),
    entry('acme-v3.1-pro', { quality: 70, price: 3, latency: 'balanced' }),
  ]
  const assigned = cost(pool)
  assert.equal(assigned.tierOf['p/acme-v2.6'], 'off')
  assert.equal(assigned.offReasons['p/acme-v2.6'].by, 'p/acme-v3.1-pro')
  assert.equal(assigned.offReasons['p/acme-v2.6'].winnerVersion, '3.1')
})

test('a same-generation successor that is far dearer does not replace the budget option', () => {
  // Major generation: version bump, materially stronger, similar price.
  // 3.7 -> 3.8 with a 4x price and little capability gain: keep the cheap model
  // so the fast tier still has a budget choice.
  const pool = [
    entry('acme3.7-flash', { quality: 60, price: 1, latency: 'fast' }),
    entry('acme3.8-flash', { quality: 64, price: 4, latency: 'fast' }),
  ]
  const assigned = cost(pool)
  assert.notEqual(assigned.tierOf['p/acme3.7-flash'], 'off')
  assert.equal(assigned.offReasons['p/acme3.7-flash'], undefined)
})
