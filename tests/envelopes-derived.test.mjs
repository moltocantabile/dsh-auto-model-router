import test from 'node:test'
import assert from 'node:assert/strict'
import { derivedRouteEnvelopes, mergeEnvelopes } from '../src/refresh.js'
import { rankTable } from '../src/rank.js'

const dims = (value) => ({ overall: value, coding: value, reasoning: value, math: value, knowledge: value, agentic: value, longContext: value, vision: value, speed: value })
const evidence = { overall: 2, coding: 2, reasoning: 2, math: 2, knowledge: 2, agentic: 2, longContext: 1, vision: 1, speed: 1 }

/** A measured catalog spread over price and quality. */
function catalog() {
  const out = {}
  const spec = [
    ['cheap-weak', 45, 0.3], ['cheap-mid', 58, 0.6], ['mid', 66, 2],
    ['mid-strong', 72, 5], ['strong', 80, 12], ['strong-dear', 86, 30],
  ]
  for (const [id, quality, price] of spec) {
    out[id] = {
      label: id, quality,
      scores: dims(quality), evidence,
      price: { input: price, output: price }, latency: 'fast', contextWindow: 200000,
      modalities: ['text'], toolCalling: true,
      benchmarks: { 'GPQA diamond': quality, "Humanity's Last Exam": quality - 6, 'Terminal-Bench': quality - 4, 'LiveCodeBench': quality - 5, 'MMLU-Pro': quality - 2 },
      benchmarkSources: ['benchgecko'],
      sources: ['https://example.test'], bestFor: [], weaknesses: [],
    }
  }
  return out
}

const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 } },
}

test('derived envelopes translate the cost percentile into a cost index', () => {
  const table = rankTable(catalog())
  const derived = derivedRouteEnvelopes(table)
  assert.equal(derived.valid, true)
  // Cost cut-offs are ordered and on the same 0-100 axis the selector compares.
  assert.ok(derived.envelopes.fast.maxCost <= derived.envelopes.balanced.maxCost)
  assert.ok(derived.envelopes.balanced.maxCost <= derived.envelopes.deep.maxCost)
  assert.ok(derived.envelopes.fast.minQuality < derived.envelopes.deep.minQuality)
  for (const tier of ['fast', 'balanced', 'deep']) {
    const envelope = derived.envelopes[tier]
    assert.ok(envelope.maxCost >= 0 && envelope.maxCost <= 100, `${tier} maxCost ${envelope.maxCost}`)
    assert.ok(envelope.minQuality >= 0 && envelope.minQuality <= 100)
    // Persisted and reloaded as a file: the count the status text reports has to
    // travel with the envelope, not on a sibling key the save drops.
    assert.equal(envelope.sample, derived.sample)
  }
})

test('too small a catalog refuses to derive envelopes', () => {
  const table = rankTable({ tiny: catalog()['mid'] })
  const derived = derivedRouteEnvelopes(table)
  assert.equal(derived.valid, false)
})

test('merge keeps an operator ceiling and fills what it omits', () => {
  const base = {
    fast: { envelope: { maxCost: 30 } },
    balanced: { envelope: { maxLatency: 'slow' } },
    deep: { envelope: { maxCost: 100, minQuality: 66, maxLatency: 'slow' } },
  }
  const derived = {
    fast: { maxCost: 48, minQuality: 45, maxLatency: 'fast' },
    balanced: { maxCost: 78, minQuality: 60, maxLatency: 'balanced' },
    deep: { maxCost: 100, minQuality: 80, maxLatency: 'slow' },
  }
  const merged = mergeEnvelopes(base, derived, 'merge')
  assert.equal(merged.fast.envelope.maxCost, 30, 'the operator ceiling wins')
  assert.equal(merged.fast.envelope.minQuality, 45, 'the omitted field is filled')
  assert.equal(merged.balanced.envelope.maxLatency, 'slow', 'an operator latency choice wins')
  assert.equal(merged.balanced.envelope.maxCost, 78)
})

test('derived mode takes the data cut-offs and keeps the operator latency policy', () => {
  const base = { fast: { envelope: { maxCost: 5, minQuality: 90, maxLatency: 'fast' } } }
  const derived = { fast: { maxCost: 48, minQuality: 45, maxLatency: 'balanced' } }
  const merged = mergeEnvelopes(base, derived, 'derived')
  assert.equal(merged.fast.envelope.maxCost, 48)
  assert.equal(merged.fast.envelope.minQuality, 45)
  assert.equal(merged.fast.envelope.maxLatency, 'fast')
})

test('explicit mode ignores the data and no data means no change', () => {
  const base = { fast: { envelope: { maxCost: 5 } } }
  const derived = { fast: { maxCost: 48, minQuality: 45, maxLatency: 'fast' } }
  assert.deepEqual(mergeEnvelopes(base, derived, 'explicit').fast.envelope, { maxCost: 5 })
  assert.deepEqual(mergeEnvelopes(base, null, 'merge').fast.envelope, { maxCost: 5 })
})
