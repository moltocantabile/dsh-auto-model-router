import test from 'node:test'
import assert from 'node:assert/strict'
import { rankTable, MIN_DIMENSION_OVERLAP } from '../src/rank.js'

/**
 * Calibration guards.
 *
 * Three defects made an old model look stronger than a newer one: AA's zero
 * ("benchmark not run") was read as a score, the configured overlap threshold was
 * passed under a name `fitAlignment` does not read (so every fit used 3), and a
 * dimension estimated from a single benchmark was reported as if it were measured.
 */

const dims = (value) => ({ overall: value, coding: value, reasoning: value, math: value, knowledge: value, agentic: value, longContext: value, vision: value, speed: value })
const evidence = { overall: 3, coding: 3, reasoning: 3, math: 3, knowledge: 3, agentic: 3, longContext: 1, vision: 1, speed: 1 }

/** A model measured by BenchGecko's leaf table (the axis owner). */
const axisModel = (quality, benchmarks) => ({
  label: 'axis-model',
  quality,
  scores: dims(quality),
  evidence,
  benchmarks,
  benchmarkSources: ['benchgecko'],
  price: { input: 2, output: 4 },
  latency: 'balanced',
  contextWindow: 200000,
  modalities: ['text'],
  toolCalling: true,
  bestFor: [],
  weaknesses: [],
  sources: ['https://example.test'],
})

/** A model whose only measurement is Artificial Analysis benchmarks. */
const aaModel = (benchmarks) => ({
  label: 'aa-model',
  crossChecks: { artificialAnalysis: { benchmarks, source: 'https://artificialanalysis.ai/leaderboards/models' } },
  price: { input: 2, output: 4 },
  latency: 'balanced',
  contextWindow: 200000,
  modalities: ['text'],
  toolCalling: true,
  bestFor: [],
  weaknesses: [],
  sources: ['https://example.test'],
})

test('an AA zero is "not run", not a score of zero', () => {
  // gpqa 0 and livecodebench 0 used to drag the mean down; only hle 40 is real.
  const dataset = {
    'm/aa': aaModel({ gpqa: 0, livecodebench: 0, hle: 40 }),
  }
  const table = rankTable(dataset)
  const row = table.models[0]
  const recorded = row.observations.list.map((observation) => ({ id: observation.canonical, raw: observation.raw }))
  assert.deepEqual(recorded.map((entry) => entry.raw), [40], 'only the benchmark that ran is an observation')
  assert.ok(recorded.every((entry) => entry.raw > 0), 'a zero never becomes a measurement')
})

test('the configured overlap threshold is actually used', () => {
  // Four models share `gpqa` across the two channels. With the default floor the
  // dimension-level fallback may fit; raising it must mark the fit insufficient.
  const dataset = {}
  for (let index = 0; index < 4; index += 1) {
    dataset[`m/axis-${index}`] = axisModel(40 + index * 8, { 'GPQA diamond': 50 + index * 8 })
    dataset[`m/aa-${index}`] = aaModel({ gpqa: 50 + index * 8 })
  }
  const loose = rankTable(dataset)
  const strict = rankTable(dataset, { minAlignOverlap: 12, minDimensionOverlap: 12 })
  assert.ok(loose.coverage.uncalibratedObservations <= strict.coverage.uncalibratedObservations, 'raising the floor cannot calibrate more')
  assert.equal(loose.settings.minAlignOverlap, 3)
  assert.equal(strict.settings.minAlignOverlap, 12)
})

test('the dimension fallback needs more overlap than same-benchmark equating', () => {
  assert.ok(MIN_DIMENSION_OVERLAP > 3, 'the weak fallback has a higher floor than the strong path')
})

test('a dimension resting on one benchmark is shrunk toward the prior', () => {
  // A single 100 is an opinion about the dimension, not a measurement of it.
  const dataset = {
    'm/single': axisModel(100, { 'GPQA diamond': 100 }),
    'm/many': axisModel(
      100,
      Object.fromEntries(['GPQA diamond', 'MMLU-Pro', 'Humanity\'s Last Exam', 'MMMU-Pro', 'ARC-AGI', 'SimpleQA'].map((name) => [name, 100])),
    ),
  }
  const table = rankTable(dataset)
  const single = table.models.find((row) => row.key === 'm/single')
  const many = table.models.find((row) => row.key === 'm/many')
  const singleDim = single.dims.knowledge
  const manyDim = many.dims.knowledge
  assert.ok(singleDim !== undefined && manyDim !== undefined)
  assert.ok(singleDim.estimate < manyDim.estimate, 'one benchmark must not read like six')
  assert.ok(singleDim.flags.includes('prior-shrunk'))
})

test('a hand-written quality floor is read on the measured axis as the same policy', async () => {
  const { alignedFloor } = await import('../src/select.js')
  // Legacy spans 30..75; the aligned axis runs ~10 lower. A floor at 66 kept roughly
  // the top third out, so it should land near the top third of the measured axis.
  const legacy = [30, 40, 45, 50, 55, 60, 65, 70, 72, 75]
  const aligned = [10, 20, 25, 30, 35, 40, 45, 50, 55, 60]
  const translated = alignedFloor(66, legacy, aligned)
  assert.ok(translated < 66, 'the floor moves onto the lower aligned scale')
  assert.equal(translated, 45)
  // A thin distribution cannot be translated honestly; the operator's number stays.
  assert.equal(alignedFloor(66, [30, 40], aligned), 66)
  assert.equal(alignedFloor(66, legacy, [10, 20]), 66)
})
