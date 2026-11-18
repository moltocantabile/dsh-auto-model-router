import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attachRanking } from '../src/refresh.js'

/** A tiny catalog with two measured models and one that has nothing behind it. */
function dataset() {
  const mk = (quality, dims, evidence) => ({
    label: 'x',
    quality,
    price: { input: 1, output: 2 },
    latency: 'fast',
    contextWindow: 200000,
    modalities: ['text'],
    toolCalling: true,
    reasoning: false,
    scores: { overall: quality, ...dims },
    evidence: { overall: evidence, ...evidence },
    // The engine ranks from raw source observations, not from the compiled
    // scores: a leaf benchmark map is what makes an entry measurable.
    benchmarks: {
      'GPQA diamond': quality,
      "Humanity's Last Exam": Math.max(0, quality - 8),
      'Terminal-Bench': Math.max(0, quality - 4),
      'LiveCodeBench': Math.max(0, quality - 6),
      'MMLU-Pro': Math.max(0, quality - 2),
    },
    benchmarkSources: ['benchgecko'],
    sources: ['https://example.test'],
    bestFor: [],
    weaknesses: [],
  })
  return {
    'p/strong': mk(78, { coding: 80, reasoning: 82, math: 70, knowledge: 74, agentic: 76 }, 2),
    'p/weak': mk(52, { coding: 50, reasoning: 48, math: 45, knowledge: 55, agentic: 50 }, 2),
    'p/empty': {
      label: 'empty',
      price: { input: 1, output: 2 },
      modalities: ['text'],
      contextWindow: 100000,
      bestFor: [],
      weaknesses: [],
      sources: ['https://example.test'],
    },
  }
}

test('ranking lands on every entry with status, composite, rank and per-dimension evidence', () => {
  const data = dataset()
  const { summary } = attachRanking(data)
  for (const entry of Object.values(data)) {
    assert.ok(entry.ranking !== undefined, 'every entry carries a ranking')
    assert.ok(['measured', 'provisional', 'unmeasured'].includes(entry.ranking.status))
    assert.ok(Number.isInteger(entry.ranking.dims.coding?.evidence ?? entry.ranking.dims.overall?.evidence ?? 0))
  }
  assert.ok(data['p/strong'].ranking.rank <= data['p/weak'].ranking.rank, 'stronger model ranks first')
  assert.equal(summary.measured + summary.provisional + summary.unmeasured, Object.keys(data).length)
})

test('the better model ranks higher and its composite is higher', () => {
  const data = dataset()
  attachRanking(data)
  assert.ok(data['p/strong'].ranking.composite > data['p/weak'].ranking.composite)
})

test('a model with no measurement is not given a rank', () => {
  const data = dataset()
  attachRanking(data)
  assert.equal(data['p/empty'].ranking.rank, null)
  assert.notEqual(data['p/empty'].ranking.status, 'measured')
})

test('the shipped runtime catalog ranks without inventing measurements', () => {
  const raw = JSON.parse(readFileSync(new URL('../data/model-info-runtime.json', import.meta.url), 'utf8'))
  const { summary, table } = attachRanking(raw)
  assert.ok(summary.measured > 0, 'some models are measured')
  // Every measured rank is unique and starts at 1.
  const ranks = table.models.filter((row) => Number.isInteger(row.rank)).map((row) => row.rank).sort((a, b) => a - b)
  assert.equal(ranks[0], 1)
  assert.equal(new Set(ranks).size, ranks.length)
})

test('the compact ranking carries the uncalibrated count the board badge reads', () => {
  // One model is not enough overlap to calibrate CompassRank onto the axis, so
  // its observation is reported as uncalibrated. The board renders that count;
  // before the producer wrote it the badge could never appear.
  const data = {
    'p/lonely': {
      label: 'lonely',
      quality: 60,
      price: { input: 1, output: 2 },
      latency: 'fast',
      contextWindow: 200000,
      modalities: ['text'],
      toolCalling: true,
      scores: { overall: 60 },
      evidence: { overall: 1 },
      benchmarks: { 'GPQA diamond': 70, LiveCodeBench: 68, 'MMLU-Pro': 66 },
      benchmarkSources: ['benchgecko'],
      crossChecks: { compassRank: { reasoning: 80 } },
      sources: ['https://example.test'],
      bestFor: [],
      weaknesses: [],
    },
  }
  const { table } = attachRanking(data)
  const row = table.byKey['p/lonely']
  assert.ok(row.uncalibrated.length > 0, 'the observation could not be aligned')
  assert.equal(data['p/lonely'].ranking.uncalibrated, row.uncalibrated.length)
})
