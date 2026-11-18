import assert from 'node:assert/strict'
import { test } from 'node:test'

import { profileDemand, selectForTier, tierFor, withinEnvelope } from '../src/select.js'

/**
 * Tier envelopes: a tier is a ceiling on what the router may buy, and the model
 * inside it is still chosen on measured capability. These tests pin both halves
 * — the mapping from task profile to tier, and the filter that decides which
 * models a tier admits.
 */
const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 } },
}

const model = (id, { cost, latency, quality }) => ({
  provider: 'p',
  model: id,
  info: {
    // Price chosen so costIndex lands near the intended band; see costIndex's
    // log scale over roughly 0.4-60 CNY blended.
    price: { input: cost, output: cost * 3 },
    latency,
    quality,
    scores: { overall: quality ?? 50, coding: quality ?? 50, reasoning: quality ?? 50, math: 50, knowledge: 50, agentic: 50, longContext: 50, vision: 0, speed: 70 },
    evidence: {},
  },
})

const CHEAP_FAST = model('cheap-fast', { cost: 0.5, latency: 'fast', quality: 45 })
const MID_FAST = model('mid-fast', { cost: 2, latency: 'fast', quality: 62 })
const STRONG_FAST = model('strong-fast', { cost: 2, latency: 'fast', quality: 70 })
const SLOW_STRONG = model('slow-strong', { cost: 12, latency: 'slow', quality: 72 })
const UNMEASURED = model('unmeasured', { cost: 2, latency: 'fast', quality: null })
const POOL = [CHEAP_FAST, MID_FAST, STRONG_FAST, SLOW_STRONG, UNMEASURED]

test('demand rises with depth, breadth and risk', () => {
  const low = profileDemand({ depth: 0, breadth: 0, risk: 0 })
  const high = profileDemand({ depth: 4, breadth: 4, risk: 4 })
  assert.ok(low < high)
})

test('latency-critical caps demand only for small, low-risk work', () => {
  // A waiting user is answered cheaply when the turn really is small.
  assert.equal(profileDemand({ depth: 1, breadth: 1, risk: 1, latencyCritical: true }), 1)
  // Risk is never traded for speed: a wrong fast answer costs more than a slow one.
  assert.equal(profileDemand({ depth: 4, breadth: 4, risk: 4, latencyCritical: true }), 4)
  assert.ok(Math.abs(profileDemand({ depth: 3, breadth: 2, risk: 2, latencyCritical: true }) - 2.35) < 1e-9)
  // Nor is depth: "Continue" is shallow-risk and deep work, and capping on risk
  // alone sent it to the cheapest model in the pool.
  assert.equal(profileDemand({ depth: 3.5, breadth: 0.5, risk: 1.9, latencyCritical: true }), 2.25)
})

test('tierFor maps a profile onto a tier that exists, and honours the default', () => {
  assert.equal(tierFor({ depth: 1, breadth: 1, risk: 0 }, ROUTES, 'balanced'), 'fast')
  assert.equal(tierFor({ depth: 2, breadth: 2, risk: 2 }, ROUTES, 'balanced'), 'balanced')
  assert.equal(tierFor({ depth: 4, breadth: 4, risk: 4 }, ROUTES, 'balanced'), 'deep')
  // A latency-critical task is served cheaply when the work is small...
  assert.equal(tierFor({ depth: 1, breadth: 1, risk: 1, latencyCritical: true }, ROUTES, 'balanced'), 'fast')
  // ...but risk is never traded for speed.
  assert.equal(tierFor({ depth: 4, breadth: 4, risk: 4, latencyCritical: true }, ROUTES, 'balanced'), 'deep')
  // Custom route ids fall back to the configured default.
  assert.equal(tierFor({ depth: 4, risk: 4 }, { only: {} }, 'only'), 'only')
})

test('withinEnvelope enforces each ceiling independently', () => {
  const envelope = { maxCost: 55, maxLatency: 'fast', minQuality: 55 }
  assert.equal(withinEnvelope(MID_FAST.info, envelope), true)
  assert.equal(withinEnvelope(STRONG_FAST.info, envelope), true)
  // Too slow.
  assert.equal(withinEnvelope(SLOW_STRONG.info, envelope), false)
  // Quality floor: an unmeasured model cannot prove it clears one.
  assert.equal(withinEnvelope(UNMEASURED.info, envelope), false)
  // Cost ceiling.
  assert.equal(withinEnvelope(model('pricey', { cost: 40, latency: 'fast', quality: 80 }).info, envelope), false)
  // A missing envelope admits everything, and zero means "no ceiling".
  assert.equal(withinEnvelope(SLOW_STRONG.info, {}), true)
  assert.equal(withinEnvelope(SLOW_STRONG.info, { minQuality: 0, maxCost: 0 }), true)
})

test('selection stays inside the tier it chose', () => {
  const result = selectForTier({ depth: 0, breadth: 0, risk: 0 }, POOL, ROUTES, { defaultRoute: 'balanced' })
  assert.equal(result.tier, 'fast')
  assert.equal(result.widened, false)
  assert.ok(result.ranking.ranked.every((row) => row.model !== 'slow-strong'), 'slow models cannot win a fast tier')
  assert.ok(result.ranking.ranked.every((row) => row.model !== 'unmeasured'), 'an unmeasured model cannot clear a quality floor')
})

test('an over-tight envelope widens to the default tier and says so', () => {
  const tight = { fast: { envelope: { maxCost: 1, maxLatency: 'fast', minQuality: 99 } }, balanced: { envelope: { maxCost: 100, minQuality: 0 } } }
  const result = selectForTier({ depth: 0, risk: 0 }, POOL, tight, { defaultRoute: 'balanced' })
  assert.equal(result.tier, 'balanced', 'falls back to the default tier')
  assert.equal(result.widened, true, 'and reports the widening')
  assert.ok(result.selected !== null)
})

test('an empty pool selects nothing instead of inventing a model', () => {
  const result = selectForTier({ depth: 4, risk: 4 }, [], ROUTES, { defaultRoute: 'balanced' })
  assert.equal(result.selected, null)
  assert.equal(result.eligible, 0)
})
test('each tier orders its pool differently, so deep is not balanced again', async () => {
  const { selectForTier, TIER_COST_FACTORS } = await import('../src/select.js')
  const { DEFAULT_ROUTES } = await import('../src/decision.js')
  // Synthetic pool: one model only `deep` admits (strong, slow, dear) and one only
  // `balanced` admits (adequate, cheap). Live data made this assertion drift with
  // every refresh, which is not what the test is about.
  const dims = (value) => ({ overall: value, coding: value, reasoning: value, math: value, knowledge: value, agentic: value, longContext: value, vision: value, speed: value })
  const evidence = { overall: 2, coding: 2, reasoning: 2, math: 2, knowledge: 2, agentic: 2, longContext: 1, vision: 1, speed: 1 }
  const candidate = (model, quality, price, latency) => ({
    tier: 'auto', provider: 'p', model, configured: true,
    info: { label: model, quality, scores: dims(quality), evidence, price: { input: price, output: price }, latency, contextWindow: 400000, modalities: ['text'], toolCalling: true },
  })
  const candidates = [candidate('deep-strong', 88, 40, 'slow'), candidate('balanced-mid', 72, 3, 'balanced')]
  const base = { vision: false, tools: true, latencyCritical: false }
  const mid = selectForTier({ ...base, shape: 'debug', depth: 3.2, breadth: 1.4, risk: 1.5 }, candidates, DEFAULT_ROUTES, { costWeight: 0.35, defaultRoute: 'balanced' })
  const hard = selectForTier({ ...base, shape: 'refactor', depth: 3.7, breadth: 3.6, risk: 3.3 }, candidates, DEFAULT_ROUTES, { costWeight: 0.35, defaultRoute: 'balanced' })
  assert.equal(mid.tier, 'balanced')
  assert.equal(hard.tier, 'deep')
  assert.equal(mid.selected.model, 'balanced-mid')
  assert.equal(hard.selected.model, 'deep-strong')
  assert.ok(hard.selected.quality > mid.selected.quality, `deep ${hard.selected.quality} must beat balanced ${mid.selected.quality}`)
  assert.ok(TIER_COST_FACTORS.fast > 1 && TIER_COST_FACTORS.deep < 1)
})

test('tierCostFactor in the config overrides the built-in ordering', async () => {
  const { selectForTier } = await import('../src/select.js')
  const { DEFAULT_ROUTES } = await import('../src/decision.js')
  // Synthetic candidates, so the assertion does not move when the shipped catalog
  // is refreshed: one strong-and-dear model, one adequate-and-cheap model.
  const dims = (value) => ({ overall: value, coding: value, reasoning: value, math: value, knowledge: value, agentic: value, longContext: value, vision: value, speed: value })
  const evidence = { overall: 2, coding: 2, reasoning: 2, math: 2, knowledge: 2, agentic: 2, longContext: 1, vision: 1, speed: 1 }
  const candidate = (model, quality, price) => ({
    tier: 'auto', provider: 'p', model, configured: true,
    info: { label: model, quality, scores: dims(quality), evidence, price: { input: price, output: price }, latency: 'slow', contextWindow: 400000, modalities: ['text'], toolCalling: true },
  })
  const candidates = [candidate('strong-dear', 88, 60), candidate('adequate-cheap', 74, 1)]
  const profile = { shape: 'refactor', depth: 3.9, breadth: 3.6, risk: 3.3, vision: false, tools: true, latencyCritical: false }
  const flat = selectForTier(profile, candidates, DEFAULT_ROUTES, { costWeight: 0.35, defaultRoute: 'deep', tierFactors: { deep: 1 } })
  const shaped = selectForTier(profile, candidates, DEFAULT_ROUTES, { costWeight: 0.35, defaultRoute: 'deep' })
  assert.notEqual(flat.selected.model, shaped.selected.model, 'the override changes the winner')
})
