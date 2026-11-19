import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DIMENSIONS,
  blendedPrice,
  capabilityQuality,
  costIndex,
  dimensionBasis,
  evidenceConfidence,
  hasMeasuredQuality,
  modelsByQuality,
  profileWeights,
  qualityBasis,
  qualityFloor,
  qualityFloorPlan,
  rankModels,
  scoreCandidate,
  selectForTier,
  withinEnvelope,
} from '../src/select.js'
import { assignTiers, boardMetaOf } from '../src/tiers.js'
import { mergeEnvelopes } from '../src/refresh.js'
import { priceOf } from '../src/rank.js'
import { offerModelIds } from '../src/index.js'

/**
 * One basis, one comparison.
 *
 * The catalog carries two measures of capability: the aligned per-dimension
 * estimates the ranking engine produces (`ranking.dims`) and the legacy compiled
 * `scores` the earlier compiler wrote. Every test here pins a site that used to
 * read one of them while the rule it belongs to read the other; each asserted
 * invariant fails before the unification and is the point of the test.
 */

const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 } },
}

const LEGACY_DIMS = Object.fromEntries(DIMENSIONS.map((dim) => [dim, 88]))
const LEGACY_EVIDENCE = Object.fromEntries(DIMENSIONS.map((dim) => [dim, 9]))

/** Per-dimension ranking estimates from a `value`/`evidence` table. */
const rankedDims = (spec) =>
  Object.fromEntries(DIMENSIONS.filter((dim) => spec[dim] !== undefined).map((dim) => [dim, { value: spec[dim][0], evidence: spec[dim][1] ?? 3 }]))

const info = (overrides = {}) => ({
  price: { input: 2, output: 4 },
  latency: 'balanced',
  contextWindow: 200000,
  modalities: ['text'],
  toolCalling: true,
  ...overrides,
})

const rankedInfo = (dims, overrides = {}) =>
  info({
    // A deliberately high legacy score: any rule that still reads it produces a
    // visibly different answer.
    quality: 88,
    scores: LEGACY_DIMS,
    evidence: LEGACY_EVIDENCE,
    ranking: { status: 'measured', composite: 55, low: 40, rank: 3, dims },
    ...overrides,
  })

const candidate = (model, candidateInfo) => ({ provider: 'p', model, key: `p/${model}`, info: candidateInfo })

const weightedMean = (values, weights) => {
  let sum = 0
  let total = 0
  for (const dim of DIMENSIONS) {
    const weight = weights[dim] ?? 0
    if (weight === 0) continue
    total += weight
    sum += weight * (typeof values[dim] === 'number' ? values[dim] : 50)
  }
  return total === 0 ? 0 : sum / total
}

test('selection scores the ranking dims, not the legacy compiled scores', () => {
  const dims = rankedDims({
    overall: [55, 10],
    coding: [40],
    reasoning: [50],
    math: [45],
    knowledge: [60],
    agentic: [55],
    longContext: [70, 0],
    vision: [0, 0],
    speed: [60, 2],
  })
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 1 }
  const { weights } = profileWeights(profile)
  const scored = scoreCandidate(candidate('ranked', rankedInfo(dims)), weights, profile)
  const expected = weightedMean(Object.fromEntries(DIMENSIONS.map((dim) => [dim, dims[dim].value])), weights)
  assert.equal(scored.basis, 'ranking')
  assert.ok(Math.abs(scored.quality - Math.round(expected * 10) / 10) <= 0.11, `quality ${scored.quality} vs ranking mean ${expected.toFixed(1)}`)
  assert.ok(scored.quality < 70, `a legacy 88 must not leak into a ranking-basis score (got ${scored.quality})`)
  // The explanation cites the same numbers the score used.
  const { ranked } = rankModels(profile, [candidate('ranked', rankedInfo(dims))], {})
  assert.ok(ranked[0].reasons.includes(`coding ${dims.coding.value}`), `reasons ${ranked[0].reasons.join(', ')} cite the ranking dims`)
  // An entry the ranking has never seen still reads the legacy compiled basis:
  // the fallback is for an unranked catalog, not a per-dimension mix.
  const legacyScored = scoreCandidate(candidate('legacy', info({ quality: 70, scores: LEGACY_DIMS, evidence: LEGACY_EVIDENCE })), weights, profile)
  assert.equal(legacyScored.basis, 'legacy')
  assert.equal(legacyScored.quality, 88, 'the legacy compiled scores are the basis when no ranking exists')
})

test('a dimension the ranking did not measure keeps the neutral prior, never the legacy score', () => {
  // `coding` is absent from the ranking (not measured); the legacy entry claims
  // 95. Using it would score the decisive dimension on the other basis.
  const dims = rankedDims({ overall: [50], reasoning: [50], math: [50], knowledge: [50], agentic: [50], longContext: [50, 0], vision: [0, 0], speed: [50, 1] })
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 1 }
  const { weights } = profileWeights(profile)
  const basis = dimensionBasis(rankedInfo(dims))
  assert.equal(basis.values.coding, undefined, 'the ranking has no coding estimate')
  const scored = scoreCandidate(candidate('ranked', rankedInfo(dims)), weights, profile)
  // Prior 50 for coding, not the legacy 88/95: the score stays near the prior.
  assert.ok(scored.quality < 60, `quality ${scored.quality} stayed near the prior`)
})

test('confidence and the unverified charge read the ranking evidence, not the legacy counts', () => {
  const dims = rankedDims({ overall: [60, 10], coding: [60, 0], reasoning: [60, 4], math: [60, 2], knowledge: [60, 0], agentic: [60, 0], longContext: [50, 0], vision: [0, 0], speed: [50, 0] })
  const profile = { shape: 'implement', depth: 3, breadth: 2, risk: 2 }
  const { weights } = profileWeights(profile)
  const scored = scoreCandidate(candidate('thin', rankedInfo(dims)), weights, profile)
  // The legacy `evidence` claims nine samples on every dimension; the ranking
  // says the decisive ones have none. The old code believed the legacy counts
  // and reported confidence 1 with zero unverified weight.
  assert.ok(scored.confidence < 0.5, `confidence ${scored.confidence} came from the ranking evidence`)
  assert.ok(scored.unverified >= (weights.coding ?? 0) - 1e-9, `coding weight (${weights.coding}) is charged as unverified, got ${scored.unverified}`)
  // A fully measured entry is more certain on the same weights.
  const full = rankedDims({ overall: [60, 10], coding: [60, 3], reasoning: [60, 3], math: [60, 3], knowledge: [60, 3], agentic: [60, 3], longContext: [50, 0], vision: [0, 0], speed: [50, 1] })
  const confident = scoreCandidate(candidate('full', rankedInfo(full)), weights, profile)
  assert.ok(confident.confidence > scored.confidence, 'more measured dims means more confidence')
  assert.equal(confident.unverified, 0)
})

test('the risk floor is compared against the same weighted quality the capability term uses', () => {
  const dims = rankedDims({ overall: [60, 10], coding: [60], reasoning: [60], math: [60], knowledge: [60], agentic: [60], longContext: [50, 0], vision: [0, 0], speed: [50, 1] })
  const profile = { shape: 'implement', depth: 3, breadth: 3, risk: 3 }
  const { weights } = profileWeights(profile)
  const hard = scoreCandidate(candidate('ranked', rankedInfo(dims)), weights, profile)
  assert.equal(hard.floor, 63)
  assert.ok(hard.quality > 55, `the floor penalty starts from the ranking-basis quality (${hard.quality})`)
  // gap 3 at risk 3 costs 3 * (1.5 + 0.8*3); a legacy 88 would have cleared the
  // floor outright and a legacy 30 would have been charged ~4x as much.
  assert.ok(hard.floorPenalty > 0 && hard.floorPenalty < 20, `floorPenalty ${hard.floorPenalty}`)

  const easy = { shape: 'implement', depth: 1, breadth: 1, risk: 0 }
  const easyWeights = profileWeights(easy).weights
  const clears = scoreCandidate(candidate('ranked', rankedInfo(dims)), easyWeights, easy)
  assert.equal(clears.floor, 36)
  assert.equal(clears.floorPenalty, 0, 'a ranking-basis 60 clears the trivial floor even though the legacy score is 88')
})

test('an entry the ranking calls unmeasured is not routed on its legacy quality', () => {
  const unmeasured = info({
    quality: 75,
    scores: LEGACY_DIMS,
    evidence: LEGACY_EVIDENCE,
    ranking: {
      status: 'unmeasured',
      composite: null,
      low: null,
      rank: null,
      dims: rankedDims({ longContext: [100, 0], vision: [0, 0] }),
    },
  })
  // The ranking refused to decompose it: the legacy score is not a measurement.
  assert.equal(qualityBasis(unmeasured), null)
  assert.equal(hasMeasuredQuality(unmeasured), false)
  const assigned = assignTiers([candidate('ghost', unmeasured)], ROUTES, {})
  assert.equal(assigned.tierOf['p/ghost'], undefined, 'no tier membership')
  assert.deepEqual(assigned.unmeasured, ['p/ghost'], 'listed as unmeasured, not silently placed')
})

test('dominance compares measured quality only: an unmeasured legacy score cannot supersede a measured model', () => {
  const measured = info({
    quality: 60,
    scores: { ...LEGACY_DIMS, coding: 60 },
    evidence: LEGACY_EVIDENCE,
    latency: 'fast',
    price: { input: 2, output: 2 },
    ranking: {
      status: 'measured',
      composite: 55,
      low: 40,
      rank: 4,
      dims: rankedDims({ overall: [55, 10], coding: [55], reasoning: [55], math: [55], knowledge: [55], agentic: [55], longContext: [80, 0], vision: [0, 0], speed: [55, 1] }),
    },
  })
  const legacyOnly = info({
    quality: 75,
    scores: LEGACY_DIMS,
    evidence: LEGACY_EVIDENCE,
    latency: 'fast',
    price: { input: 0.5, output: 0.5 },
    ranking: { status: 'unmeasured', composite: null, low: null, rank: null, dims: rankedDims({ longContext: [100, 0], vision: [0, 0] }) },
  })
  const assigned = assignTiers([candidate('deepseek-measured', measured), candidate('deepseek-legacy', legacyOnly)], ROUTES, {})
  assert.ok(assigned.groups.fast.includes('p/deepseek-measured'), 'the measured model keeps its tier')
  assert.deepEqual(assigned.unmeasured, ['p/deepseek-legacy'], 'the legacy-only entry is not placed')
  assert.deepEqual(assigned.dominated, [], 'and therefore dominates nothing')
})

test('a derived floor filled in by a merge keeps its provenance', () => {
  const merged = mergeEnvelopes(
    { fast: { envelope: { maxCost: 55, maxLatency: 'fast' } } },
    { fast: { maxCost: 61, minQuality: 80, maxLatency: 'fast', derived: true } },
    'merge',
  )
  assert.equal(merged.fast.envelope.derived, true, 'the filled floor is a quantile of the conservative value')
  const strong = info({
    // The legacy score is far below the derived floor; the ranking's low bound is
    // above it. The floor must be compared against the scale its source used.
    quality: 30,
    price: { input: 1, output: 1 },
    latency: 'fast',
    ranking: { status: 'measured', composite: 95, low: 90, rank: 1, dims: rankedDims({ overall: [95, 10] }) },
  })
  assert.equal(withinEnvelope(strong, merged.fast.envelope), true)
  // A hand-written floor keeps reading the legacy score (its authored scale).
  assert.equal(withinEnvelope(strong, { minQuality: 40 }), false)
})

test('board metadata reports the basis the rules used, and the producer keys they read', () => {
  const meta = boardMetaOf(
    rankedInfo(rankedDims({ coding: [52, 4] }), {
      quality: 70,
      usage: { percentile: 90 },
      ranking: {
        status: 'measured',
        composite: 60,
        low: 44,
        rank: 7,
        uncalibrated: 2,
        dims: rankedDims({ coding: [52, 4] }),
      },
    }),
  )
  assert.equal(meta.quality, 44, 'the card headline is the low bound the board ranks and prunes on')
  assert.equal(meta.low, 44)
  assert.equal(meta.composite, 60, 'the point estimate stays a separate, labelled value')
  assert.equal(meta.rank, 7)
  assert.equal(meta.usage, 90)
  assert.equal(meta.uncalibrated, 2, 'the badge count the client renders')
  assert.equal(meta.status, 'measured')
})

test('the decision model is offered ids ordered by the capability basis, not the legacy score', () => {
  const legacyHigh = candidate('legacy-high', {
    quality: 90,
    ranking: { status: 'measured', composite: 45, low: 30, rank: 9, dims: rankedDims({ coding: [30] }) },
  })
  const rankedHigh = candidate('ranked-high', {
    quality: 50,
    ranking: { status: 'measured', composite: 70, low: 65, rank: 2, dims: rankedDims({ coding: [65] }) },
  })
  const unmeasured = candidate('unmeasured', { quality: 99, ranking: { status: 'unmeasured', composite: null, low: null, rank: null, dims: rankedDims({ longContext: [100, 0] }) } })
  assert.deepEqual(offerModelIds([legacyHigh, rankedHigh, unmeasured], 10), ['ranked-high', 'legacy-high', 'unmeasured'])
  assert.deepEqual(modelsByQuality([legacyHigh, rankedHigh, unmeasured], 2), ['ranked-high', 'legacy-high'])
  // Two providers serving one id are one choice for the decision model.
  assert.deepEqual(modelsByQuality([rankedHigh, { ...rankedHigh, key: 'q/ranked-high' }], 10), ['ranked-high'])
})

test('selection and the ranking price a model the same way, including AA-only quotes', () => {
  const aaOnly = info({
    crossChecks: { artificialAnalysis: { priceIn: 2, priceOut: 8 } },
    // No catalog price: the ranking's priceOf converts the AA quote, and the
    // selector must convert it the same way instead of calling it mid-priced.
    price: undefined,
  })
  const price = priceOf(aaOnly)
  assert.equal(price.converted, true)
  assert.ok(Math.abs(blendedPrice(aaOnly) - price.blended) < 0.01, `${blendedPrice(aaOnly)} vs ${price.blended}`)
  const sameNotion = costIndex({ price: { input: price.input, output: price.output } })
  assert.equal(costIndex(aaOnly), sameNotion)
  assert.notEqual(costIndex(aaOnly), 55, 'an AA-priced model is not "unpriced, mid-range"')
})

test('the speed dimension uses measured serving data, not the legacy speed prior', () => {
  const profile = { shape: 'lookup', depth: 0, breadth: 0, risk: 0 }
  const { weights } = profileWeights(profile)
  const measured = rankedInfo(
    rankedDims({ overall: [50], coding: [50], reasoning: [50], math: [50], knowledge: [50], agentic: [50], longContext: [50, 0], vision: [0, 0], speed: [40, 2] }),
    { scores: { ...LEGACY_DIMS, speed: 90 }, evidence: { ...LEGACY_EVIDENCE, speed: 9 } },
  )
  const scored = scoreCandidate(candidate('measured-speed', measured), weights, profile)
  // Lookup weights speed heavily (0.3 + 0.12 + 0.06 before normalisation); the
  // legacy prior claims 90, the measured value is 40.
  const expected = weightedMean(Object.fromEntries(DIMENSIONS.map((dim) => [dim, measured.ranking.dims[dim]?.value ?? 50])), weights)
  assert.ok(Math.abs(scored.quality - Math.round(expected * 10) / 10) <= 0.11, `quality ${scored.quality} vs measured mean ${expected.toFixed(1)}`)
  assert.ok(scored.quality < 60, `the legacy 90 speed prior must not pull the score up (got ${scored.quality})`)

  // With no measured speed, the dimension is a prior, not the legacy invented one.
  const derivedOnly = { overall: [50, 0], coding: [50, 0], reasoning: [50, 0], math: [50, 0], knowledge: [50, 0], agentic: [50, 0], longContext: [50, 0], vision: [0, 0] }
  const noMeasurement = rankedInfo(rankedDims(derivedOnly), {
    scores: { ...LEGACY_DIMS, speed: 90 },
    evidence: { ...LEGACY_EVIDENCE, speed: 9 },
  })
  const prior = scoreCandidate(candidate('prior-speed', noMeasurement), weights, profile)
  assert.ok(prior.quality < 60, `no measurement is a neutral prior, not 90 (got ${prior.quality})`)
  assert.ok(prior.unverified > 0, 'the unverified speed weight is charged')
  // The two paths agree with `evidenceConfidence`'s signature: weights optional,
  // but the profile's own weights give the same answer the scorer used.
  assert.ok(evidenceConfidence(noMeasurement, weights) < 0.2)
})

test('the dominance margin of 10 is cost-index points, the same cost axis the tier check uses', () => {
  // Both models are measured and same-family, so only the price/quality rule can
  // switch one off. Prices are chosen so the cost-index gap is 9 in the first
  // pair and 11 in the second; a margin expressed in blended CNY (1.57x / 1.72x
  // price, i.e. 4.6 / 5.8 price points) would refuse both and stop pruning.
  const strong = (price) =>
    candidate('deepseek-strong', info({
      price: { input: price, output: price },
      latency: 'slow',
      quality: 80,
      scores: { ...LEGACY_DIMS, coding: 80 },
      evidence: LEGACY_EVIDENCE,
      ranking: {
        status: 'measured',
        composite: 64,
        low: 62,
        rank: 2,
        dims: rankedDims({ overall: [64, 10], coding: [62], reasoning: [62], math: [62], knowledge: [62], agentic: [62], longContext: [80, 0], vision: [0, 0], speed: [60, 1] }),
      },
    }))
  const weak = (price) =>
    candidate('deepseek-weak', info({
      price: { input: price, output: price },
      latency: 'slow',
      quality: 80,
      scores: { ...LEGACY_DIMS, coding: 78 },
      evidence: LEGACY_EVIDENCE,
      ranking: {
        status: 'measured',
        composite: 62,
        low: 60,
        rank: 3,
        dims: rankedDims({ overall: [62, 10], coding: [60], reasoning: [60], math: [60], knowledge: [60], agentic: [60], longContext: [80, 0], vision: [0, 0], speed: [60, 1] }),
      },
    }))
  const below = assignTiers([strong(8.1), weak(12.7)], ROUTES, {})
  assert.deepEqual(below.dominated, [], 'a 9-point cheaper rival is a trade, not a dominance')

  const above = assignTiers([strong(8.1), weak(13.9)], ROUTES, {})
  assert.deepEqual(above.dominated.map((entry) => entry.key), ['p/deepseek-weak'], 'an 11-point gap on the cost index is dominated')
  assert.equal(above.dominated[0].by, 'p/deepseek-strong')
})

/** A 100-model pool whose legacy risk floors sat at the documented shares. */
const LEGACY_SHAPED = [
  ...Array(4).fill(30), ...Array(8).fill(40), ...Array(8).fill(50),
  ...Array(26).fill(60), ...Array(45).fill(70), ...Array(9).fill(80),
]
const shareBelow = (values, floor) => values.filter((value) => value < floor).length / values.length

test('a pool-derived risk floor reproduces the legacy share of the pool', () => {
  // 45/54/63/72 had 12/20/46/91% of the legacy distribution below them. On the
  // aligned axis the numbers change but the policy must not.
  for (const [risk, target] of [[1, 0.12], [2, 0.2], [3, 0.46], [4, 0.91]]) {
    const plan = qualityFloorPlan({ risk }, { basis: LEGACY_SHAPED, mode: 'pool' })
    assert.equal(plan.mode, 'pool')
    assert.equal(plan.sample, LEGACY_SHAPED.length)
    assert.ok(Math.abs(shareBelow(LEGACY_SHAPED, plan.floor) - target) <= 0.02, `risk ${risk}: floor ${plan.floor} leaves ${shareBelow(LEGACY_SHAPED, plan.floor)} below, target ${target}`)
    assert.ok(plan.percentile > 0 && plan.percentile < 100)
    assert.equal(plan.note, null)
  }
  // Risk 0 keeps the old ladder's top-end spacing: just below risk 1.
  const easy = qualityFloorPlan({ risk: 0 }, { basis: LEGACY_SHAPED, mode: 'pool' })
  assert.ok(easy.floor < qualityFloorPlan({ risk: 1 }, { basis: LEGACY_SHAPED, mode: 'pool' }).floor)
})

test('a pool too small for a quantile falls back to the explicit ladder and says so', () => {
  const plan = qualityFloorPlan({ risk: 2 }, { basis: [40, 50, 60, 70], mode: 'pool' })
  assert.equal(plan.mode, 'absolute')
  assert.equal(plan.floor, 54, 'the authored 36 + 9 x risk ladder')
  assert.match(plan.note, /pool too small/)
  // Asking for the ladder outright is a choice, not a fallback: no note.
  const absolute = qualityFloorPlan({ risk: 2 }, { basis: LEGACY_SHAPED, mode: 'absolute' })
  assert.equal(absolute.mode, 'absolute')
  assert.equal(absolute.floor, 54)
  assert.equal(absolute.note, null)
  // The number-returning form keeps the old contract.
  assert.equal(qualityFloor({ risk: 2 }), 54)
})

test('the pool floor is a quantile of the same weighted quality scoreCandidate compares against', () => {
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 2 }
  const { weights } = profileWeights(profile)
  const candidates = Array.from({ length: 12 }, (_, position) => {
    const value = 35 + position * 3
    return candidate(`model-${position}`, rankedInfo(rankedDims({
      overall: [value, 10], coding: [value], reasoning: [value], math: [value], knowledge: [value], agentic: [value],
      longContext: [50, 0], vision: [0, 0], speed: [50, 1],
    })))
  })
  const expectedBasis = candidates.map((entry) => capabilityQuality(entry.info, weights))
  const expectedPlan = qualityFloorPlan(profile, { basis: expectedBasis, mode: 'pool' })
  const { ranked, floor, floorPlan } = rankModels(profile, candidates, { floorMode: 'pool' })
  assert.equal(floorPlan.mode, 'pool')
  assert.equal(floor, expectedPlan.floor, 'the floor is a quantile of the reported quality values')
  for (const row of ranked) {
    assert.ok(Math.abs(row.quality - Math.round(capabilityQuality(candidates.find((entry) => entry.model === row.model).info, weights) * 10) / 10) <= 0.11)
    const gap = Math.max(0, floor - row.quality)
    const expectedPenalty = Math.round(gap * (1.5 + 0.8 * 2) * 10) / 10
    assert.ok(Math.abs(row.floorPenalty - expectedPenalty) <= 0.2, `${row.model}: floorPenalty ${row.floorPenalty} vs ${expectedPenalty}`)
  }
})

test('one pool floor is derived for the run, not re-derived per tier', () => {
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 2 }
  const candidates = Array.from({ length: 12 }, (_, position) => {
    const value = 35 + position * 3
    return candidate(`model-${position}`, rankedInfo(rankedDims({
      overall: [value, 10], coding: [value], reasoning: [value], math: [value], knowledge: [value], agentic: [value],
      longContext: [50, 0], vision: [0, 0], speed: [50, 1],
    })))
  })
  const result = selectForTier(profile, candidates, ROUTES, { defaultRoute: 'balanced', floorMode: 'pool' })
  assert.equal(result.floorPlan.mode, 'pool')
  assert.equal(result.floorPlan.sample, candidates.length, 'the plan saw the whole pool')
  assert.equal(result.ranking.floorPlan.floor, result.floorPlan.floor, 'the tier ranked against that one floor')
})

test('a free model is priced as free, an untagged one as unknown', () => {
  assert.equal(costIndex({ price: { input: 0, output: 0 } }), 0, 'free is the cheapest, not mid-range')
  assert.equal(costIndex({}), 55, 'unknown prices stay mid-range so they cannot win on cost')
})

test('the last-resort widening never selects an unmeasured model', () => {
  // Every candidate here has a ranking that says unmeasured: the selector must
  // report no selection rather than route on the neutral prior.
  const unmeasured = (model) => ({
    provider: 'p', model, configured: true,
    info: { label: model, ranking: { status: 'unmeasured', composite: null, low: null, dims: {} }, price: { input: 1, output: 2 }, latency: 'balanced', contextWindow: 200000, modalities: ['text'], toolCalling: true },
  })
  const result = selectForTier({ shape: 'edit', depth: 1, breadth: 1, risk: 1, vision: false, tools: true }, [unmeasured('a'), unmeasured('b')], ROUTES, { defaultRoute: 'balanced' })
  assert.equal(result.selected, null)
})

test('the board card reports how much of the composite is measured', async () => {
  const { boardMetaOf } = await import('../src/tiers.js')
  const full = boardMetaOf({ ranking: { status: 'measured', rank: 1, composite: 60, low: 50, dims: { coding: { value: 60 }, reasoning: { value: 60 }, math: { value: 60 }, knowledge: { value: 60 }, agentic: { value: 60 } } } })
  assert.equal(full.dimsCovered, 5)
  const partial = boardMetaOf({ ranking: { status: 'measured', rank: 2, composite: 55, low: 45, dims: { coding: { value: 55 }, knowledge: { value: 55 } } } })
  assert.equal(partial.dimsCovered, 2)
  assert.equal(partial.dimsTotal, 5)
  // An unmeasured entry states nothing rather than "0/5 measured".
  assert.equal(boardMetaOf({}).dimsCovered, null)
})
