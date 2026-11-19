import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DIMENSIONS,
  alignedFloor,
  alignedOperatorFloors,
  boardMetaOf,
  capabilityQuality,
  dimensionBasis,
  effectiveEnvelopes,
  envelopeQuality,
  hasMeasuredQuality,
  legacyQuality,
  qualityBasis,
} from '../src/basis.js'
import { profileWeights, withinEnvelope } from '../src/select.js'
import { assignTiers } from '../src/tiers.js'

/**
 * One capability basis, one owner.
 *
 * These are host-seam tests: the entry is made once and the floor, the tier
 * placement, the dominance rule and the board card are each asked for its
 * number. They must all be the measured (ranking) value; using the legacy
 * compiled score in any one of them is the class of bug that produced the
 * `deepseek-v3` artefact and C1.
 */

const dims = (value, evidence = 3) =>
  Object.fromEntries(DIMENSIONS.map((dim) => [dim, { value, evidence }]))

const ranked = (low, composite, legacy, price, rankings = {}) => ({
  quality: legacy,
  latency: 'fast',
  price: { input: price, output: price },
  contextWindow: 200_000,
  modalities: ['text'],
  toolCalling: true,
  ranking: { status: 'measured', composite, low, rank: 1, dims: dims(low), ...rankings },
})

test('floor, placement, dominance and card read the same measured basis', () => {
  const weights = profileWeights({ shape: 'implement', depth: 2, breadth: 2, risk: 1 }).weights
  // Same family, so dominance compares them. The legacy scores invert the
  // measured order on purpose: a rule that reads the legacy value gives the
  // opposite answer.
  const alpha = ranked(60, 75, 90, 2)
  const beta = ranked(50, 62, 95, 12)

  // 1. The scalar basis and the per-dimension basis are the measured values.
  assert.equal(qualityBasis(alpha), 60)
  assert.equal(dimensionBasis(alpha).quality, 60)
  assert.equal(dimensionBasis(alpha).source, 'ranking')
  assert.ok(Math.abs(capabilityQuality(alpha, weights) - 60) < 1e-9, 'the profile-weighted measured value')
  assert.equal(legacyQuality(alpha), 90)
  assert.equal(hasMeasuredQuality(alpha), true)

  // 2. The card reports the number the tier rules compare, not the point estimate.
  assert.equal(boardMetaOf(alpha).quality, 60)
  assert.equal(boardMetaOf(alpha).composite, 75)
  assert.equal(boardMetaOf(beta).quality, 50)

  // 3. A derived floor is compared on the measured axis; a hand-written floor
  //    keeps its authored (legacy) axis by provenance.
  assert.equal(withinEnvelope(alpha, { minQuality: 65, derived: true }), false)
  assert.equal(withinEnvelope(alpha, { minQuality: 55, derived: true }), true)
  assert.equal(withinEnvelope(alpha, { minQuality: 70 }), true, 'the legacy score clears a legacy floor')
  assert.equal(envelopeQuality(alpha, { minQuality: 55, derived: true }), qualityBasis(alpha))

  // 4. Dominance places and prunes on the measured basis: alpha is cheaper and
  //    measured-stronger, so beta is superseded -- the legacy order says the
  //    reverse and must not win.
  const assigned = assignTiers(
    [
      { provider: 'p', model: 'deepseek-alpha', key: 'p/deepseek-alpha', info: alpha },
      { provider: 'p', model: 'deepseek-beta', key: 'p/deepseek-beta', info: beta },
    ],
    { fast: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 0 } } },
    {},
  )
  assert.equal(assigned.tierOf['p/deepseek-alpha'], 'fast', 'the measured-stronger model keeps its tier')
  assert.equal(assigned.tierOf['p/deepseek-beta'], 'off', 'the measured-weaker model is superseded')
  assert.deepEqual(assigned.dominated.map((entry) => [entry.key, entry.by]), [['p/deepseek-beta', 'p/deepseek-alpha']])
  assert.equal(assigned.dominated[0].quality, 50, 'dominance reports the measured basis, like the card')
})

test('an operator floor is translated onto the measured axis and keeps its provenance', () => {
  const entries = [30, 40, 45, 50, 55, 60, 65, 70, 75, 80].map((legacy, index) => ({
    quality: legacy,
    ranking: { low: 10 + index * 5 },
  }))
  const routes = { fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 66 } } }
  // 66 sits above 7 of the 10 legacy values (70%), so the measured floor is the
  // same share of the measured values, not the same number.
  assert.equal(alignedFloor(66, entries.map((entry) => entry.quality), entries.map((entry) => entry.ranking.low)), 40)
  const operator = alignedOperatorFloors(routes, entries)
  assert.equal(operator.fast.envelope.minQuality, 40)
  assert.equal(operator.fast.envelope.operatorMinQuality, 66, 'the authored number is kept for the operator')
  assert.equal(operator.fast.envelope.derived, true)
  assert.equal(operator.fast.envelope.source, 'derived')

  const fallback = { fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 10 } } }
  const merged = effectiveEnvelopes(operator, null, fallback, 'explicit')
  const measure = (low, legacy) => ({ quality: legacy, latency: 'fast', price: { input: 1, output: 1 }, contextWindow: 200_000, modalities: ['text'], toolCalling: true, ranking: { status: 'measured', low, composite: low + 10, dims: dims(low) } })
  // The translated floor is read on the measured axis, not against stale legacy.
  assert.equal(withinEnvelope(measure(41, 20), merged.fast.envelope), true)
  assert.equal(withinEnvelope(measure(39, 90), merged.fast.envelope), false)
  // An already-derived floor is left alone (translation is not re-applied).
  const derivedRoutes = { fast: { envelope: { minQuality: 40, derived: true } } }
  assert.equal(alignedOperatorFloors(derivedRoutes, entries).fast, derivedRoutes.fast)
})

test('effective envelopes take absent fields from the data before the shipped defaults', () => {
  const operator = { fast: { envelope: { maxLatency: 'fast' } } }
  const derived = { fast: { maxCost: 67, minQuality: 15, maxLatency: 'balanced', derived: true, sample: 10 } }
  const fallback = { fast: { envelope: { maxCost: 55, minQuality: 40, maxLatency: 'fast' } } }

  const merged = effectiveEnvelopes(operator, derived, fallback, 'merge')
  assert.equal(merged.fast.envelope.maxCost, 67, 'a field the operator omitted comes from the data')
  assert.equal(merged.fast.envelope.minQuality, 15)
  assert.equal(merged.fast.envelope.derived, true, 'the filled floor keeps its provenance')
  assert.equal(merged.fast.envelope.maxLatency, 'fast', 'the operator latency choice wins')

  const explicit = effectiveEnvelopes(operator, derived, fallback, 'explicit')
  assert.equal(explicit.fast.envelope.maxCost, 55, 'explicit mode ignores the data cut-offs')
  assert.equal(explicit.fast.envelope.minQuality, 40)
  assert.equal(explicit.fast.envelope.derived, undefined)

  const dataOnly = effectiveEnvelopes(operator, derived, fallback, 'derived')
  assert.equal(dataOnly.fast.envelope.maxCost, 67)
  assert.equal(dataOnly.fast.envelope.minQuality, 15)
  assert.equal(dataOnly.fast.envelope.maxLatency, 'fast', 'the operator latency policy survives')
  assert.equal(dataOnly.fast.envelope.source, 'derived')
})
