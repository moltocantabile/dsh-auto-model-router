import assert from 'node:assert/strict'
/** Raw merging: no evidence shrinkage, so these tests assert the merge itself. */
const RAW = { evidencePriorWeight: 0 }

import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  CORE_DIMENSIONS,
  MIN_ALIGN_OVERLAP,
  MISSING_DIMENSION_PENALTY,
  PRICE_CNY_PER_USD,
  STATUS,
  autoTierForModel,
  cacheAdjustedPrice,
  classifyBenchmark,
  contextScore,
  derivedEnvelopes,
  fitAlignment,
  fitsEnvelope,
  paretoLayers,
  planTiers,
  priceOf,
  quantile,
  rankTable,
  sourceObservations,
  spearman,
  speedScore,
  toCatalogPatch,
} from '../src/rank.js'

/**
 * These tests pin the two halves of the prototype:
 *
 * 1. the arithmetic of the merge — one benchmark is one vote, alignment is
 *    fitted and refuses to guess below the overlap threshold, and the scales
 *    that must never be blended (AA's index, Epoch's ECI, the catalog's
 *    composite) never enter a dimension;
 * 2. the tier behaviour — stable names, explicit envelopes unchanged, derived
 *    envelopes monotone, provisional/unmeasured models not auto-placed, and
 *    cross-vendor Pareto ranking never used to disable a model.
 *
 * Fixtures are deliberately small and hand-computable. The shipped runtime
 * catalog is exercised separately at the end for invariants that must hold on
 * real data.
 */

// ── fixture helpers ─────────────────────────────────────────────────────────

/** One BenchGecko leaf per core dimension, so a fixture model is "fully measured". */
const DIM_BENCHMARK = {
  coding: 'SWE-Bench verified',
  reasoning: 'ARC-AGI',
  math: 'OTIS Mock AIME 2024-2025',
  knowledge: 'GPQA diamond',
  agentic: 'APEX-Agents',
}

function fullBenchmarks(values = {}) {
  const merged = { coding: 60, reasoning: 60, math: 60, knowledge: 60, agentic: 60, ...values }
  return Object.fromEntries(CORE_DIMENSIONS.map((dim) => [DIM_BENCHMARK[dim], merged[dim]]))
}

function model(key, options = {}) {
  const label = options.label ?? key
  return {
    label,
    contextWindow: options.contextWindow ?? 128_000,
    price: 'price' in options ? options.price : { input: 2, output: 8 },
    modalities: options.modalities ?? ['text'],
    toolCalling: options.toolCalling ?? true,
    reasoning: options.reasoning ?? true,
    latency: 'latency' in options ? options.latency : 'balanced',
    quality: options.quality ?? null,
    scores: options.scores ?? {},
    evidence: options.evidence ?? {},
    benchmarks: options.benchmarks ?? {},
    crossChecks: options.crossChecks ?? {},
    ...(options.retired === true ? { retired: true } : {}),
  }
}

function datasetOf(models) {
  return Object.fromEntries(models.map(([key, entry]) => [key, entry]))
}

/** A measured model at `value` on every core dimension. */
function measuredModel(key, value, options = {}) {
  return model(key, {
    ...options,
    benchmarks: options.benchmarks ?? fullBenchmarks({ coding: value, reasoning: value, math: value, knowledge: value, agentic: value }),
  })
}

// ── alignment arithmetic ────────────────────────────────────────────────────

test('fitAlignment refuses fewer than three overlap models', () => {
  // Two points through a line is a guess with a slope; the module's contract is
  // that a channel without enough overlap is reported, not merged.
  assert.equal(fitAlignment([[50, 30], [60, 40]]), null)
  const fit = fitAlignment([[50, 30], [60, 40], [70, 50]])
  assert.notEqual(fit, null)
  assert.equal(fit.slope, 1, 'offset-only under the slope threshold')
  assert.equal(fit.mode, 'offset')
  assert.equal(fit.offset, 20)
  assert.equal(fit.n, 3)
})

test('fitAlignment fits and shrinks a slope only with enough overlap', () => {
  // y = 0.5x + 20 with 8 pairs: the raw slope is 0.5, shrunk halfway to 1 => 0.75.
  const pairs = []
  for (let x = 0; x < 8; x += 1) pairs.push([0.5 * (x * 10 + 20), x * 10 + 20])
  const fit = fitAlignment(pairs)
  assert.notEqual(fit, null)
  assert.equal(fit.mode, 'linear-shrunk')
  assert.ok(fit.slope > 0.5 && fit.slope < 1, `slope was shrunk toward 1 (${fit.slope})`)
  assert.equal(fit.n, 8)
})

test('quantile interpolates and ignores non-numbers', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([1, null, 3], 0.5), 2)
  assert.equal(quantile([], 0.5), null)
})

test('spearman is 1 for a monotone pair list and null when degenerate', () => {
  assert.equal(spearman([[1, 10], [2, 20], [3, 30]]), 1)
  assert.equal(spearman([[5, 1], [5, 2], [5, 3]]), null)
})

// ── benchmark registry ──────────────────────────────────────────────────────

test('one canonical benchmark is one vote, whichever publishers report it', () => {
  // GPQA arrives three times: as the Epoch-hub row BenchGecko republishes, as
  // Artificial Analysis' own GPQA row (also republished by BenchGecko), and as
  // llmleaderboard's GPQA track. Three publications, one benchmark.
  const models = []
  for (let i = 0; i < 3; i += 1) {
    // Overlap models equate llmleaderboard's GPQA track onto the axis: its raw
    // value is 20 points lower than BenchGecko's.
    models.push([`p/anchor-${i}`, model(`p/anchor-${i}`, {
      benchmarks: { 'GPQA diamond': 60 + i * 5 },
      crossChecks: { llmLeaderboard: { benchmarks: { 'gpqa-diamond-aa': 40 + i * 5 } } },
    })])
  }
  const entry = model('p/one', {
    benchmarks: {
      'GPQA diamond': 80,
      'Artificial Analysis · GPQA Diamond': 82,
      'SWE-Bench verified': 60,
    },
    crossChecks: {
      llmLeaderboard: { benchmarks: { 'gpqa-diamond-aa': 58 } },
    },
  })
  models.push(['p/one', entry])
  const table = rankTable(datasetOf(models), RAW)
  const row = table.byKey['p/one']
  assert.equal(row.dims.knowledge.evidence, 1, 'GPQA is one unit of evidence, not three')
  assert.equal(row.dims.knowledge.sources.length, 3, 'all three observations are still recorded')
  assert.equal(row.dims.knowledge.estimate, 80, 'published values 80, 82, and 58+20 average to 80')
  assert.deepEqual(Object.keys(row.dims.knowledge.families).sort(), ['aa', 'epoch-bench', 'llm'])
})

test('a benchmark the registry does not know is reported, never scored', () => {
  const entry = model('p/odd', { benchmarks: { 'My Private Benchmark': 99 } })
  const table = rankTable(datasetOf([['p/odd', entry]]))
  const row = table.byKey['p/odd']
  assert.equal(row.status, STATUS.UNMEASURED)
  assert.equal(row.composite, null)
  const unknown = table.unknownBenchmarks.find((item) => item.label === 'My Private Benchmark')
  assert.ok(unknown, 'the unmapped benchmark is surfaced')
  assert.deepEqual(unknown.models, ['p/odd'])
})

test('AA benchmarks are classified by construct, and its mixed scales are excluded', () => {
  assert.equal(classifyBenchmark('gpqa-diamond', 'aa').canonical, 'gpqa')
  assert.equal(classifyBenchmark('gdp-pdf', 'aa').canonical, 'gdp-pdf')
  assert.equal(classifyBenchmark('gdpval-aa-normalized', 'aa').canonical, 'gdpval-aa-normalized')
  assert.equal(classifyBenchmark('omniscience-accuracy', 'aa').canonical, 'omniscience-accuracy')
  assert.equal(classifyBenchmark('omniscience-non-hallucination', 'aa').canonical, 'omniscience-non-hallucination')
  assert.notEqual(
    classifyBenchmark('omniscience-accuracy', 'aa').canonical,
    classifyBenchmark('omniscience-non-hallucination', 'aa').canonical,
    'accuracy and non-hallucination are different quantities',
  )
  // The AA table holds ~1e3 point values in the same `scores` object as 0-1
  // fractions; they must be treated as index signals, not percentages.
  assert.equal(classifyBenchmark('aa-3d', 'aa').kind, 'index')
  assert.equal(classifyBenchmark('gdpval-aa-normalized', 'aa').kind, 'index')
})

test('AA scores outside 0-1 are reported as index signals, never multiplied by 100', () => {
  const analysis = [{
    name: 'Fixture One',
    intelligenceIndex: 30,
    scores: { 'gpqa-diamond': 0.8, 'gdpval-aa-normalized': 1045.88, 'aa-3d': 900 },
  }]
  const entry = model('p/fixture-one', { benchmarks: fullBenchmarks({ knowledge: 70 }), crossChecks: {} })
  const table = rankTable(datasetOf([['p/fixture-one', entry]]), { analysis, ...RAW })
  const row = table.byKey['p/fixture-one']
  assert.equal(row.dims.knowledge.estimate, 70, 'the 0-1 GPQA row is a percentage; the 1e3 rows are not')
  assert.ok(table.indexSignals.some((item) => item.canonical === 'gdpval-aa-normalized'))
  assert.ok(table.indexSignals.some((item) => item.canonical === 'aa-3d'))
})

// ── merging, evidence and the scales that must not blend ────────────────────

test('a score with evidence 0 is a prior and never becomes a measurement', () => {
  const entry = model('p/prior-only', {
    quality: 91,
    scores: { overall: 91, coding: 95, reasoning: 95, math: 95, knowledge: 95, agentic: 95 },
    evidence: { overall: 0, coding: 0, reasoning: 0, math: 0, knowledge: 0, agentic: 0 },
  })
  const table = rankTable(datasetOf([['p/prior-only', entry]]))
  const row = table.byKey['p/prior-only']
  assert.equal(row.status, STATUS.UNMEASURED)
  assert.equal(row.composite, null)
  assert.ok(row.notes.some((note) => note.includes('legacy quality ignored')))
})

test('a compiled score with samples is a legitimate, marked fallback', () => {
  const entry = model('p/compiled', {
    quality: 64,
    scores: { overall: 64, coding: 64, reasoning: 64, math: 64, knowledge: 64, agentic: 64, longContext: 90, vision: 0, speed: 70 },
    evidence: { overall: 1, coding: 2, reasoning: 2, math: 2, knowledge: 2, agentic: 2, longContext: 0, vision: 0, speed: 0 },
  })
  const table = rankTable(datasetOf([['p/compiled', entry]]))
  const row = table.byKey['p/compiled']
  assert.equal(row.status, STATUS.MEASURED)
  assert.equal(row.dims.coding.estimate, 64)
  assert.equal(row.dims.coding.evidence, 2)
  assert.ok(row.dims.coding.flags.includes('not-decomposed'))
  assert.ok(row.notes.some((note) => note.includes('compiled composite fallback')))
})

test('measured channels are aligned by the same benchmark when one exists', () => {
  // Four models give the axis owner and llmleaderboard a common DeepSwe sample.
  // llmleaderboard reports 20 points lower; the fitted offset must recover it.
  const models = []
  for (let i = 0; i < 4; i += 1) {
    const value = 40 + i * 10
    models.push([`p/anchor-${i}`, model(`p/anchor-${i}`, {
      benchmarks: { Deepswe: value },
      crossChecks: { llmLeaderboard: { benchmarks: { 'deepswe-v1-1': value - 20 } } },
    })])
  }
  models.push(['p/target', model('p/target', {
    crossChecks: { llmLeaderboard: { benchmarks: { 'deepswe-v1-1': 45 } } },
  })])
  const table = rankTable(datasetOf(models), RAW)
  const fit = table.calibration.benchmarks.llm.deepswe
  assert.equal(fit.mode, 'offset')
  assert.equal(fit.offset, 20)
  const row = table.byKey['p/target']
  assert.equal(row.dims.coding.estimate, 65, '45 + 20')
  assert.equal(row.dims.coding.sources[0].alignment, 'benchmark')
})

test('a channel with too little overlap is reported, not merged', () => {
  const models = []
  for (let i = 0; i < MIN_ALIGN_OVERLAP - 1; i += 1) {
    models.push([`p/anchor-${i}`, model(`p/anchor-${i}`, {
      benchmarks: { Deepswe: 50 + i * 10 },
      crossChecks: { llmLeaderboard: { benchmarks: { 'deepswe-v1-1': 30 + i * 10 } } },
    })])
  }
  models.push(['p/target', model('p/target', {
    crossChecks: { llmLeaderboard: { benchmarks: { 'deepswe-v1-1': 40 } } },
  })])
  const table = rankTable(datasetOf(models))
  assert.equal(table.calibration.benchmarks.llm.deepswe.status, 'insufficient-overlap')
  const row = table.byKey['p/target']
  assert.equal(row.dims.coding, undefined, 'the uncalibrated observation contributes no score')
  assert.ok(table.coverage.uncalibrated.some((item) => item.channel === 'llm' && item.dim === 'coding'))
})

test("AA's intelligence index and Epoch's ECI never enter a dimension", () => {
  const measured = measuredModel('p/model', 62, {
    crossChecks: {
      artificialAnalysis: { intelligenceIndex: 44, priceIn: 1, priceOut: 4 },
      epoch: { eci: 170, date: '2026-01-01' },
    },
  })
  const plain = measuredModel('p/model', 62)
  const withSignals = rankTable(datasetOf([['p/model', measured]]))
  const withoutSignals = rankTable(datasetOf([['p/model', plain]]))
  assert.deepEqual(
    CORE_DIMENSIONS.map((dim) => withSignals.byKey['p/model'].dims[dim].estimate),
    CORE_DIMENSIONS.map((dim) => withoutSignals.byKey['p/model'].dims[dim].estimate),
    'per-dimension estimates are identical with and without the interval signals',
  )
  const row = withSignals.byKey['p/model']
  for (const dim of CORE_DIMENSIONS) {
    for (const source of row.dims[dim].sources) {
      assert.ok(!['epoch', 'aa-index'].includes(source.channel), `${dim} must not source ${source.channel}`)
    }
  }
  assert.equal(row.signals.epoch.eci, 170, 'the ECI is still carried for agreement/reporting')
  assert.equal(row.signals.aaIndex, 44)
})

test('disagreement between sources is flagged and widens the band', () => {
  // Four anchors equate compass `swePro` onto BenchGecko's coding axis. The
  // target then reports 70 via BenchGecko and 40 via CompassRank: the same
  // construct measured 30 points apart.
  const models = []
  const compass = [60, 60, 60, 60]
  for (let i = 0; i < 4; i += 1) {
    models.push([`p/anchor-${i}`, model(`p/anchor-${i}`, {
      benchmarks: { 'SWE-Bench verified': 40 + i * 10 },
      crossChecks: { compassRank: { swePro: compass[i] } },
    })])
  }
  models.push(['p/agree', model('p/agree', {
    benchmarks: { 'SWE-Bench verified': 70 },
    crossChecks: { compassRank: { swePro: 75 } },
  })])
  models.push(['p/disagree', model('p/disagree', {
    benchmarks: { 'SWE-Bench verified': 70 },
    crossChecks: { compassRank: { swePro: 40 } },
  })])
  const table = rankTable(datasetOf(models))
  const agree = table.byKey['p/agree'].dims.coding
  const disagree = table.byKey['p/disagree'].dims.coding
  assert.ok(disagree.spread > 12)
  assert.ok(disagree.flags.includes('disagreement'))
  assert.ok(!agree.flags.includes('disagreement'))
  assert.ok(disagree.band > agree.band, 'disagreement widens the uncertainty band')
  assert.ok(disagree.confidence < agree.confidence)
  // SWE-bench Verified and SWE-bench Pro are different benchmarks, so they are
  // two observation units even though both are "coding".
  assert.equal(disagree.evidence, 2)
})

test('missing dimensions are charged as structural uncertainty, not imputed', () => {
  const thin = model('p/thin', {
    benchmarks: {
      'GPQA diamond': 80,
      'OTIS Mock AIME 2024-2025': 80,
    },
  })
  const full = measuredModel('p/full', 60)
  const table = rankTable(datasetOf([['p/thin', thin], ['p/full', full]]), RAW)
  const thinRow = table.byKey['p/thin']
  const fullRow = table.byKey['p/full']
  assert.equal(thinRow.composite, 80)
  assert.equal(thinRow.coverage, 2 / 5)
  assert.ok(thinRow.compositeBand >= 3 * MISSING_DIMENSION_PENALTY, 'three missing dimensions are charged')
  assert.ok(thinRow.rankValue < fullRow.rankValue, 'a two-dimension composite does not outrank a fully measured one')
  assert.ok(thinRow.notes.some((note) => note.includes('partial coverage')))
})

test('the composite is renormalized over measured dimensions, never over the legacy quality', () => {
  const entry = model('p/composite', {
    quality: 90,
    benchmarks: {
      'SWE-Bench verified': 50,
      'ARC-AGI': 70,
      'OTIS Mock AIME 2024-2025': 60,
      'GPQA diamond': 40,
      'APEX-Agents': 30,
    },
  })
  const table = rankTable(datasetOf([['p/composite', entry]]), RAW)
  const row = table.byKey['p/composite']
  const expected = 0.25 * 50 + 0.25 * 70 + 0.15 * 60 + 0.15 * 40 + 0.2 * 30
  assert.ok(Math.abs(row.composite - expected) < 0.15, `${row.composite} vs ${expected}`)
  assert.notEqual(row.composite, 90)
})

test('speeds are measured from serving data, never from the catalog speed prior', () => {
  const measured = model('p/speed-measured', {
    benchmarks: fullBenchmarks(),
    scores: { speed: 78 },
    evidence: { speed: 0 },
    crossChecks: { llmLeaderboard: { ttftSeconds: 1.2, tokensPerSecond: 100 } },
  })
  const prior = model('p/speed-prior', {
    benchmarks: fullBenchmarks(),
    scores: { speed: 78 },
    evidence: { speed: 0 },
  })
  const table = rankTable(datasetOf([['p/speed-measured', measured], ['p/speed-prior', prior]]))
  const m = table.byKey['p/speed-measured'].dims.speed
  const p = table.byKey['p/speed-prior'].dims.speed
  assert.equal(m.estimate, speedScore(1.2, 100))
  assert.equal(m.evidence, 1)
  assert.equal(m.sources[0].channel, 'llm')
  assert.equal(p.estimate, null, 'the prior is not a measurement')
  assert.equal(p.evidence, 0)
  assert.ok(p.flags.includes('no-measurement'))
})

test('long context and vision are derived facts with zero evidence when unbenchmarked', () => {
  const entry = model('p/derived', {
    contextWindow: 1_048_576,
    modalities: ['text', 'image'],
    benchmarks: fullBenchmarks(),
  })
  const table = rankTable(datasetOf([['p/derived', entry]]))
  const row = table.byKey['p/derived']
  assert.equal(row.dims.longContext.estimate, 100)
  assert.equal(row.dims.longContext.evidence, 0)
  assert.equal(row.dims.longContext.derived, 'context-window')
  assert.equal(row.dims.vision.estimate, 100)
  assert.equal(row.dims.vision.evidence, 0)
  assert.equal(row.dims.vision.derived, 'modalities')
  assert.equal(row.features.hasVision, true)
})

test('a measured long-context benchmark supersedes the context-window derivation', () => {
  const entry = model('p/long', {
    contextWindow: 128_000,
    benchmarks: { ...fullBenchmarks(), 'Artificial Analysis · Long Context Reasoning': 66 },
  })
  const table = rankTable(datasetOf([['p/long', entry]]), RAW)
  const row = table.byKey['p/long']
  assert.equal(row.dims.longContext.estimate, 66)
  assert.equal(row.dims.longContext.evidence, 1)
  assert.equal(row.dims.longContext.derived, null)
})

// ── price ───────────────────────────────────────────────────────────────────

test('prices stay in CNY; an AA USD price is converted and flagged', () => {
  const catalog = model('p/catalog', { price: { input: 2, output: 8, cacheHitInput: 0.04 } })
  const aaOnly = model('p/aa', {
    price: { input: null, output: null },
    crossChecks: { artificialAnalysis: { priceIn: 1, priceOut: 4 } },
  })
  const unpriced = model('p/unpriced', { price: null })
  const table = rankTable(datasetOf([['p/catalog', catalog], ['p/aa', aaOnly], ['p/unpriced', unpriced]]))

  const catalogPrice = table.byKey['p/catalog'].features.price
  assert.equal(catalogPrice.blended, 6)
  assert.equal(catalogPrice.cacheHitInput, 0.04)
  assert.equal(catalogPrice.source, 'catalog')
  assert.equal(catalogPrice.converted, false)

  const aaPrice = table.byKey['p/aa'].features.price
  assert.equal(aaPrice.input, 1 * PRICE_CNY_PER_USD)
  assert.equal(aaPrice.output, 4 * PRICE_CNY_PER_USD)
  assert.equal(aaPrice.converted, true)
  assert.equal(aaPrice.source, 'artificial-analysis')

  const unpricedPrice = table.byKey['p/unpriced'].features.price
  assert.equal(unpricedPrice.unpriced, true)
  assert.equal(unpricedPrice.blended, null)
  assert.equal(table.byKey['p/unpriced'].features.costIndex, null)
  assert.equal(table.byKey['p/unpriced'].costPercentile, null)
})

test('cache-adjusted price uses the cache-hit rate instead of the blend', () => {
  const price = priceOf({ price: { input: 2, output: 8, cacheHitInput: 0.04 } })
  assert.equal(cacheAdjustedPrice(price, 0), 6)
  assert.equal(cacheAdjustedPrice(price, 0.5), 5.67)
  assert.equal(cacheAdjustedPrice(price, 1), 5.35)
  assert.equal(cacheAdjustedPrice(priceOf({ price: null }), 0.5), null)
})

test('cost percentile is derived from the pool rather than a fixed log window', () => {
  const models = [
    ['p/cheap', model('p/cheap', { price: { input: 0.2, output: 0.8 }, benchmarks: fullBenchmarks() })],
    ['p/mid', model('p/mid', { price: { input: 4, output: 12 }, benchmarks: fullBenchmarks() })],
    ['p/dear', model('p/dear', { price: { input: 20, output: 60 }, benchmarks: fullBenchmarks() })],
  ]
  const table = rankTable(datasetOf(models))
  assert.equal(table.byKey['p/cheap'].costPercentile, 0)
  assert.equal(table.byKey['p/mid'].costPercentile, 50)
  assert.equal(table.byKey['p/dear'].costPercentile, 100)
  assert.ok(table.byKey['p/cheap'].features.costIndex < table.byKey['p/dear'].features.costIndex)
})

// ── provisional / index-only models ─────────────────────────────────────────

/** Eight fully measured models whose AA index rises with their composite. */
function measuredWithIndexes() {
  const models = []
  for (let i = 0; i < 8; i += 1) {
    const value = 40 + i * 4
    const key = `p/anchor-${i}`
    models.push([key, measuredModel(key, value, {
      crossChecks: { artificialAnalysis: { intelligenceIndex: value / 2 } },
    })])
  }
  return models
}

test('AA index 0 is "not ranked", not a zero-capability measurement', () => {
  // The shipped refresh path treated a finite index of 0 through the calibration
  // fit, inventing a quality for models AA never ranked. A finite index of 0 is
  // not evidence of anything.
  const entry = model('p/zero', {
    quality: 27.4,
    scores: { overall: 27.4, coding: 27.4, reasoning: 27.4, math: 27.4, knowledge: 27.4, agentic: 27.4 },
    evidence: { overall: 0, coding: 0, reasoning: 0, math: 0, knowledge: 0, agentic: 0 },
    crossChecks: { artificialAnalysis: { intelligenceIndex: 0 } },
  })
  const table = rankTable(datasetOf([['p/zero', entry]]))
  const row = table.byKey['p/zero']
  assert.equal(row.status, STATUS.UNMEASURED)
  assert.equal(row.composite, null)
  assert.equal(row.signals.aaIndex, null)
})

test('an index-only model is provisional: calibrated, marked, and not auto-placed', () => {
  const models = measuredWithIndexes()
  models.push(['p/index-only', model('p/index-only', {
    crossChecks: { artificialAnalysis: { intelligenceIndex: 30, priceIn: 1, priceOut: 3 } },
  })])
  const table = rankTable(datasetOf(models))
  const row = table.byKey['p/index-only']
  assert.equal(row.status, STATUS.PROVISIONAL)
  assert.equal(row.evidence, 1)
  assert.equal(row.measured, false)
  assert.ok(row.dims.overall.flags.includes('index-only'))
  assert.ok(row.dims.overall.flags.includes('provisional'))
  assert.equal(row.notes.includes('provisional: AA index only'), true)

  const routes = { deep: { envelope: { maxLatency: 'slow', minQuality: 0 } } }
  const blocked = planTiers(table, { routes })
  assert.ok(blocked.provisional.includes('p/index-only'))
  assert.ok(!Object.values(blocked.groups).some((group) => group.includes('p/index-only')))

  const allowed = planTiers(table, { routes, allowProvisional: true })
  assert.ok(allowed.groups.deep.includes('p/index-only'))
})

test('the provisional fit refuses fewer than eight measured pairs', () => {
  const models = measuredWithIndexes().slice(0, 4)
  models.push(['p/index-only', model('p/index-only', { crossChecks: { artificialAnalysis: { intelligenceIndex: 30 } } })])
  const table = rankTable(datasetOf(models))
  assert.equal(table.byKey['p/index-only'].status, STATUS.UNMEASURED)
  assert.equal(table.sourceAgreement.indexFit.status, 'insufficient-overlap')
})

// ── ranking ─────────────────────────────────────────────────────────────────

test('ranking uses the conservative lower bound, with the cost/efficiency view on top', () => {
  const table = rankTable(datasetOf([
    ['p/alpha', measuredModel('p/alpha', 65, { price: { input: 6, output: 18 } })],
    ['p/beta', measuredModel('p/beta', 60, { price: { input: 0.6, output: 2 } })],
    ['p/gamma', measuredModel('p/gamma', 55, { price: { input: 12, output: 36 } })],
  ]))
  assert.deepEqual(table.measured.slice(0, 2), ['p/alpha', 'p/beta'])
  assert.equal(table.byKey['p/alpha'].rank, 1)
  assert.equal(table.byKey['p/beta'].rank, 2)
  // Pareto: alpha is the capability frontier, beta the price frontier, gamma is
  // dominated by both.
  assert.equal(table.byKey['p/alpha'].onParetoFrontier, true)
  assert.equal(table.byKey['p/beta'].onParetoFrontier, true)
  assert.equal(table.byKey['p/gamma'].onParetoFrontier, false)
})

test('per-dimension ranks and bands are exposed, and rank ties are deterministic', () => {
  const table = rankTable(datasetOf([
    ['p/one', measuredModel('p/one', 70)],
    ['p/two', measuredModel('p/two', 60)],
    ['p/three', measuredModel('p/three', 60)],
  ]))
  assert.equal(table.byKey['p/one'].dimRanks.coding, 1)
  assert.equal(table.byKey['p/one'].dimBands.coding, 'high')
  assert.equal(table.byKey['p/two'].dimBands.coding, 'mid')
  assert.equal(table.byKey['p/three'].dimBands.coding, 'mid')
  assert.equal(table.byKey['p/one'].rank, 1)
  assert.ok(table.byKey['p/three'].rank < table.byKey['p/two'].rank, 'ties break by key, deterministically')
})

// ── tiers ───────────────────────────────────────────────────────────────────

const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 0 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 0 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 0 } },
}

test('explicit envelopes keep the current precedence: disabled > override > measured > cheapest', () => {
  const models = [
    ['alpha/alpha-cheap', measuredModel('alpha/alpha-cheap', 50, { price: { input: 0.5, output: 1.5 }, latency: 'fast' })],
    ['alpha/alpha-mid', measuredModel('alpha/alpha-mid', 60, { price: { input: 4, output: 12 }, latency: 'balanced' })],
    ['alpha/alpha-strong', measuredModel('alpha/alpha-strong', 75, { price: { input: 20, output: 60 }, latency: 'slow' })],
    ['beta/beta-prior', model('beta/beta-prior', { quality: 80, scores: { coding: 80 }, evidence: { coding: 0 } })],
  ]
  const table = rankTable(datasetOf(models))
  const plan = planTiers(table, {
    routes: ROUTES,
    disabled: ['alpha/alpha-mid'],
    overrides: { 'alpha/alpha-strong': 'fast' },
  })
  assert.equal(plan.tierOf['alpha/alpha-mid'], 'off')
  assert.equal(plan.tierOf['alpha/alpha-strong'], 'fast', 'a hand assignment wins over the envelope')
  assert.deepEqual(plan.overridden, ['alpha/alpha-strong'])
  assert.equal(plan.tierOf['alpha/alpha-cheap'], 'fast')
  assert.ok(plan.unmeasured.includes('beta/beta-prior'))
  assert.equal(plan.tierOf['beta/beta-prior'], undefined)
})

test('derived envelopes are monotone, data-relative, and keep the stable tier names', () => {
  const models = []
  for (let i = 0; i < 8; i += 1) {
    models.push([`p/model-${i}`, measuredModel(`p/model-${i}`, 40 + i * 4, {
      price: { input: 0.5 + i, output: 2 + i * 3 },
      latency: i < 3 ? 'fast' : i < 6 ? 'balanced' : 'slow',
    })])
  }
  const table = rankTable(datasetOf(models))
  const derived = derivedEnvelopes(table)
  assert.equal(derived.valid, true)
  assert.ok(derived.sample >= 4)
  assert.deepEqual(Object.keys(derived.envelopes), ['fast', 'balanced', 'deep'])
  const { fast, balanced, deep } = derived.envelopes
  assert.equal(fast.costAxis, 'percentile')
  assert.ok(fast.maxCost <= balanced.maxCost && balanced.maxCost <= deep.maxCost)
  assert.ok(fast.minQuality < balanced.minQuality && balanced.minQuality < deep.minQuality)
  assert.equal(fast.maxLatency, 'fast')
  assert.equal(deep.maxLatency, 'slow')
  // A model joins the cheapest tier that admits it.
  const plan = planTiers(table, { routes: ROUTES, envelopeMode: 'derived' })
  assert.deepEqual(Object.keys(plan.groups).sort(), ['balanced', 'deep', 'fast', 'off'])
  assert.equal(plan.envelopeSource.fast, 'derived')
})

test('merge mode lets each explicit field win over the derived one', () => {
  const models = []
  for (let i = 0; i < 6; i += 1) {
    models.push([`p/model-${i}`, measuredModel(`p/model-${i}`, 45 + i * 5, {
      price: { input: 0.5 + i, output: 2 + i * 3 },
      latency: i < 2 ? 'fast' : i < 4 ? 'balanced' : 'slow',
    })])
  }
  const table = rankTable(datasetOf(models))
  const routes = { fast: { envelope: { minQuality: 0 } } }
  const plan = planTiers(table, { routes, envelopeMode: 'merge' })
  const derived = derivedEnvelopes(table)
  assert.equal(plan.envelopes.fast.minQuality, 0, 'the explicit floor wins')
  assert.equal(plan.envelopes.fast.maxCost, derived.envelopes.fast.maxCost, 'the derived cost ceiling fills the gap')
  assert.equal(plan.envelopeSource.fast, 'merged')
})

test('same-family dominance switches a model off; cross-vendor dominance does not', () => {
  const models = [
    ['alpha/alpha-strong', measuredModel('alpha/alpha-strong', 72, { price: { input: 1, output: 3 }, latency: 'fast' })],
    ['alpha/alpha-weak', measuredModel('alpha/alpha-weak', 52, { price: { input: 15, output: 45 }, latency: 'slow' })],
    ['beta/beta-weak', measuredModel('beta/beta-weak', 52, { price: { input: 15, output: 45 }, latency: 'slow' })],
  ]
  const table = rankTable(datasetOf(models))
  const plan = planTiers(table, { routes: ROUTES })
  assert.equal(plan.tierOf['alpha/alpha-weak'], 'off')
  assert.ok(plan.dominated.some((item) => item.key === 'alpha/alpha-weak' && item.by === 'alpha/alpha-strong'))
  assert.notEqual(plan.tierOf['beta/beta-weak'], 'off', 'another vendor being cheaper and stronger is not a replacement')
  assert.ok(!plan.dominated.some((item) => item.key === 'beta/beta-weak'))
})

test('unknown cost or latency fails an envelope rather than being assumed mid-priced', () => {
  const unknownCost = model('p/no-price', {
    price: null,
    benchmarks: fullBenchmarks(),
  })
  const table = rankTable(datasetOf([['p/no-price', unknownCost]]))
  const row = table.byKey['p/no-price']
  assert.equal(fitsEnvelope(row, ROUTES.fast.envelope), false)
  assert.equal(fitsEnvelope(row, { maxLatency: 'slow', minQuality: 0 }), true)
  const noLatency = model('p/no-latency', { latency: 'unknown-class', benchmarks: fullBenchmarks() })
  const table2 = rankTable(datasetOf([['p/no-latency', noLatency]]))
  assert.equal(fitsEnvelope(table2.byKey['p/no-latency'], { maxLatency: 'slow' }), false)
  assert.equal(autoTierForModel(table2.byKey['p/no-latency'], { deep: { maxLatency: 'slow', minQuality: 0 } }), null)
})

// ── catalog patch ───────────────────────────────────────────────────────────

test('the catalog patch keeps integer evidence and never promotes a prior', () => {
  const models = [
    ['p/measured', measuredModel('p/measured', 64, {
      contextWindow: 200_000,
      modalities: ['text', 'image'],
      crossChecks: { llmLeaderboard: { ttftSeconds: 0.9, tokensPerSecond: 120 } },
    })],
    ['p/prior', model('p/prior', {
      quality: 80,
      scores: { overall: 80, coding: 80, reasoning: 80, math: 80, knowledge: 80, agentic: 80, longContext: 90, vision: 0, speed: 80 },
      evidence: { overall: 0, coding: 0, reasoning: 0, math: 0, knowledge: 0, agentic: 0, longContext: 0, vision: 0, speed: 0 },
    })],
  ]
  const table = rankTable(datasetOf(models))
  const patch = toCatalogPatch(table)
  for (const [key, value] of Object.entries(patch)) {
    assert.equal(typeof value.scores, 'object', key)
    for (const evidence of Object.values(value.evidence)) assert.ok(Number.isInteger(evidence) && evidence >= 0)
    for (const [dim, score] of Object.entries(value.scores)) {
      if (score !== null) assert.ok(Number.isFinite(score) && score >= 0 && score <= 100, `${key}.${dim}=${score}`)
    }
  }
  assert.ok(patch['p/measured'].evidence.coding >= 1)
  assert.ok(patch['p/measured'].evidence.speed >= 1)
  assert.equal(patch['p/measured'].evidence.longContext, 0, 'context capacity is derived, not measured')
  assert.equal(patch['p/measured'].evidence.vision, 0)
  assert.equal(patch['p/prior'].evidence.coding, 0, 'a prior keeps zero evidence even if kept for compatibility')
  assert.equal(patch['p/prior'].quality, null)
})

// ── Pareto helper ───────────────────────────────────────────────────────────

test('paretoLayers peels the non-dominated frontier and records who dominates', () => {
  const { layerOf, dominatedBy } = paretoLayers([
    { key: 'cheap-weak', value: 40, cost: 1 },
    { key: 'cheap-strong', value: 70, cost: 2 },
    { key: 'dear-strong', value: 80, cost: 9 },
    { key: 'dominated', value: 50, cost: 8 },
  ])
  // A cheap weak model is on the frontier too: nothing is cheaper AND stronger.
  assert.equal(layerOf['cheap-weak'], 0)
  assert.equal(layerOf['cheap-strong'], 0)
  assert.equal(layerOf['dear-strong'], 0)
  assert.equal(layerOf['dominated'], 1)
  assert.equal(dominatedBy['dominated'], 'cheap-strong')
})

// ── the shipped catalog ─────────────────────────────────────────────────────

const RUNTIME = JSON.parse(readFileSync(new URL('../data/model-info-runtime.json', import.meta.url), 'utf8'))

function shippedTable() {
  return rankTable(RUNTIME)
}

test('the shipped catalog satisfies the ranking invariants', () => {
  const table = shippedTable()
  assert.ok(table.models.length >= 40)
  assert.ok(table.measured.length > 0)
  assert.equal(table.models.length, table.measured.length + table.provisional.length + table.unmeasured.length)

  for (const row of table.models) {
    if (row.status === STATUS.MEASURED) {
      assert.ok(Number.isFinite(row.composite), `${row.key} has a composite`)
      assert.ok(Number.isInteger(row.evidence) && row.evidence >= 1, `${row.key} evidence is an integer ≥ 1`)
      assert.ok(Number.isFinite(row.rankValue))
      assert.ok(row.compositeLow <= row.composite && row.composite <= row.compositeHigh)
    }
    for (const dim of CORE_DIMENSIONS) {
      const value = row.dims[dim]
      if (value === undefined) continue
      assert.equal(Number.isInteger(value.evidence), true, `${row.key}.${dim} evidence is integer`)
      if (value.evidence > 0) {
        assert.ok(Number.isFinite(value.estimate) && value.estimate >= 0 && value.estimate <= 100)
        for (const source of value.sources) assert.ok(!['epoch', 'aa-index'].includes(source.channel))
      } else {
        assert.ok(value.flags.includes('not-decomposed') || value.derived !== null)
      }
    }
  }
})

test('the shipped catalog: an AA index of 0 does not become a quality', () => {
  const table = shippedTable()
  const zeroIndex = table.models.filter((row) => {
    const aa = row.entry?.crossChecks?.artificialAnalysis
    return aa !== undefined && aa.intelligenceIndex === 0
  })
  // The extractor refuses `intelligenceIndex: 0`, so a refreshed catalog may have
  // no such row at all; the per-row rule below is what must hold either way.
  for (const row of zeroIndex) {
    assert.equal(row.signals.aaIndex, null)
    // A zero index can still be measured by an actual benchmark; what it must
    // never do is create quality on its own.
    const hasBenchmarkEvidence = row.observations.list.length > 0
      || CORE_DIMENSIONS.some((dim) => Number(row.entry?.evidence?.[dim]) > 0)
    if (!hasBenchmarkEvidence) {
      assert.notEqual(row.status, STATUS.MEASURED, `${row.key} is not measured from an index of 0`)
      assert.notEqual(row.status, STATUS.PROVISIONAL, `${row.key} is not provisional from an index of 0`)
    }
  }
})

test('the shipped catalog: measurable gaps are reported, not hidden', () => {
  const table = shippedTable()
  assert.ok(table.unknownBenchmarks.length > 0, 'unmapped benchmark labels are surfaced')
  assert.ok(table.coverage.uncalibrated.length > 0, 'channels/models that could not be aligned are surfaced')
  assert.ok(table.sourceAgreement.epoch.n >= 3, 'Epoch ECI is compared with the composite')
  assert.ok(Number.isFinite(table.sourceAgreement.epoch.spearman))
  // Agreement is reported as an ordinal diagnostic and never becomes a score.
  for (const row of table.models) {
    for (const dim of CORE_DIMENSIONS) {
      for (const source of row.dims[dim]?.sources ?? []) {
        assert.ok(['benchgecko', 'compass', 'aa', 'llm', 'compiled'].includes(source.channel), `${source.channel} is a measurement channel`)
      }
    }
  }
})

test('the shipped catalog: tier planning keeps the stable names and refuses priors', () => {
  const table = shippedTable()
  const plan = planTiers(table, { routes: ROUTES })
  assert.deepEqual(Object.keys(plan.groups).sort(), ['balanced', 'deep', 'fast', 'off'])
  for (const tier of ['fast', 'balanced', 'deep']) {
    for (const key of plan.groups[tier]) {
      const row = table.byKey[key]
      assert.equal(row.measured, true, `${key} placed in ${tier} is measured`)
    }
  }
  // The prior-only/legacy-quality entries in the runtime catalog must not be
  // silently routed: they are listed with the unmeasured models.
  const priorOnly = table.models.filter((row) => row.status === STATUS.UNMEASURED && row.entry.quality !== null)
  for (const row of priorOnly) {
    assert.ok(!Object.values(plan.groups).some((group) => group.includes(row.key)), row.key)
  }
})
