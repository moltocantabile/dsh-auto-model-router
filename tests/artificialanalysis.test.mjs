import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFICIAL_ANALYSIS_URL,
  aaSlugCandidates,
  extractArtificialAnalysisModelPage,
  CNY_PER_USD,
  attachArtificialAnalysis,
  decodeFlightChunks,
  extractArtificialAnalysis,
  nameIndex,
} from '../src/refresh.js'

/** One Next.js RSC flight chunk carrying an array of model rows. */
function page(rows) {
  const payload = JSON.stringify(rows)
  return `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`
}

const ROWS = [
  {
    id: 'row-1',
    name: 'Qwen3.8 Flash',
    price1mInputTokens: 0.8,
    price1mOutputTokens: 2.7,
    intelligenceIndex: 40,
    timeToFirstToken: 0.4,
    outputSpeed: 180,
    contextWindowTokens: 1000000,
    scores: { gpqa: 0.62, 'terminalbench-hard': 0.31 },
  },
  {
    id: 'row-2',
    name: 'DeepSeek V4 Pro (Non-reasoning)',
    price1mInputTokens: 2,
    price1mOutputTokens: 8,
    intelligenceIndex: null,
    scores: {},
  },
]

const BASE = {
  'qwen3.8-flash': { label: 'Qwen3.8 Flash', quality: 60.1 },
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', quality: 70 },
}

test('the flight stream is decoded without a browser', () => {
  const chunks = decodeFlightChunks(page(ROWS))
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].includes('Qwen3.8 Flash'))
})

test('rows are matched to catalog ids, tolerant of qualifiers', () => {
  const analysis = extractArtificialAnalysis(page(ROWS), nameIndex(BASE))
  assert.ok(analysis.byId['qwen3.8-flash'] !== undefined, 'matched by label')
  assert.equal(analysis.byId['qwen3.8-flash'].intelligenceIndex, 40)
  assert.equal(analysis.byId['qwen3.8-flash'].priceIn, 0.8)
  // AA appends "(Non-reasoning)"; the row still belongs to the catalog model.
  assert.ok(analysis.byId['deepseek-v4-pro'] !== undefined, 'parenthesis ignored')
})

test('a row missing every measurement is skipped, not guessed at', () => {
  const analysis = extractArtificialAnalysis(page([{ id: 'r', name: 'Qwen3.8 Flash' }]), nameIndex(BASE))
  assert.equal(Object.keys(analysis.byId).length, 0)
})

test('prices convert to the catalog currency at one stated rate', () => {
  const dataset = { 'qwen3.8-flash': { label: 'Qwen3.8 Flash', quality: 60.1 } }
  const analysis = extractArtificialAnalysis(page(ROWS), nameIndex(BASE))
  attachArtificialAnalysis(dataset, { base: BASE, analysis })
  const entry = dataset['qwen3.8-flash']
  assert.equal(entry.price.input, Math.round(0.8 * CNY_PER_USD * 10) / 10)
  assert.equal(entry.price.output, Math.round(2.7 * CNY_PER_USD * 10) / 10)
  assert.equal(entry.crossChecks.artificialAnalysis.intelligenceIndex, 40)
  assert.equal(entry.quality, 60.1, 'an existing measurement is not overwritten')
})

test('a model nothing measured gets a quality from the calibrated index', () => {
  const dataset = { 'qwen3.8-flash': { label: 'Qwen3.8 Flash', quality: 60.1 }, 'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', quality: 70 } }
  const analysis = extractArtificialAnalysis(page(ROWS), nameIndex(BASE))
  const summary = attachArtificialAnalysis(dataset, { base: BASE, analysis })
  assert.equal(dataset['qwen3.8-flash'].quality, 60.1)
  assert.ok(summary.calibration.pairs >= 1)
})

test('an advertised model the catalog never described gets an entry', () => {
  const dataset = {}
  const rows = [{ id: 'r2', name: 'MiMo V2.6 Pro', price1mInputTokens: 0.5, price1mOutputTokens: 2, intelligenceIndex: 45, timeToFirstToken: 1.5, outputSpeed: 60 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const summary = attachArtificialAnalysis(dataset, {
    base: {},
    analysis,
    wanted: [{ model: 'mimo-v2-6-pro', provider: 'bailian-aliyun' }],
  })
  assert.equal(summary.created, 1)
  const entry = dataset['mimo-v2-6-pro']
  assert.equal(entry.label, 'MiMo V2.6 Pro')
  assert.equal(entry.provider, 'bailian-aliyun')
  assert.ok(entry.quality > 0)
  assert.equal(entry.latency, 'balanced')
  assert.deepEqual(entry.sources, [ARTIFICIAL_ANALYSIS_URL])
})

test('an advertised model with no AA row stays absent', () => {
  const dataset = {}
  const summary = attachArtificialAnalysis(dataset, {
    base: {},
    analysis: { byId: {}, byName: new Map() },
    wanted: [{ model: 'unheard-of', provider: 'p' }],
  })
  assert.equal(summary.created, 0)
  assert.deepEqual(dataset, {})
})

test('a provider-prefixed id matches the bare model name', () => {
  const dataset = {}
  const rows = [{ id: 'r3', name: 'GLM-5.3', price1mInputTokens: 1, price1mOutputTokens: 4, intelligenceIndex: 50 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  attachArtificialAnalysis(dataset, {
    base: {},
    analysis,
    wanted: [{ model: 'ZHIPU/GLM-5.3', provider: 'bailian-aliyun' }],
  })
  // Stored under the lower-case key the catalog lookup derives, so the mixed-case
  // provider spelling still resolves.
  assert.ok(dataset['zhipu/glm-5.3'] !== undefined)
})

test('variant rows of one model resolve to the best-evaluated variant', () => {
  const rows = [
    { id: 'v1', name: 'DeepSeek V4 Pro 0813 (Low)', price1mInputTokens: 2, price1mOutputTokens: 8, intelligenceIndex: 20 },
    { id: 'v2', name: 'DeepSeek V4 Pro 0813 (Max)', price1mInputTokens: 2, price1mOutputTokens: 8, intelligenceIndex: 30 },
  ]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, {
    base: {},
    analysis,
    wanted: [{ model: 'deepseek-v4-pro-0813', provider: 'bailian-tokenplan' }],
  })
  const entry = dataset['deepseek-v4-pro-0813']
  assert.ok(entry !== undefined)
  assert.equal(entry.crossChecks.artificialAnalysis.intelligenceIndex, 30, 'the evaluated variant is kept')
})

test('a reseller or speed suffix still matches its model', () => {
  const rows = [{ id: 's1', name: 'GLM-5.3-Flash', price1mInputTokens: 0.2, price1mOutputTokens: 1, intelligenceIndex: 40 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [{ model: 'cmaas-glm-5.3', provider: 'bailian-aliyun' }] })
  assert.ok(dataset['cmaas-glm-5.3'] !== undefined, 'the reseller prefix does not block the match')
})

test('every merged entry leaves complete, whatever route it took', () => {
  // Created entries, filled entries and untouched ones must all carry the nine
  // dimensions and integer evidence, or the knowledge-base contract breaks.
  const dataset = {
    'known-partial': { label: 'Known Partial', scores: { overall: 50 }, evidence: { overall: 0 } },
    'known-empty': { label: 'Known Empty' },
  }
  const rows = [
    { id: 'a', name: 'Known Partial', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 35 },
    { id: 'b', name: 'Brand New', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 55 },
  ]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [{ model: 'brand-new', provider: 'p' }] })

  for (const[ id, entry] of Object.entries(dataset)) {
    for (const dim of ['overall', 'coding', 'reasoning', 'math', 'knowledge', 'agentic', 'longContext', 'vision', 'speed']) {
      assert.equal(typeof entry.scores[dim], 'number', `${id}.${dim} missing`)
      assert.ok(Number.isInteger(entry.evidence[dim]), `${id}.${dim} evidence is not an integer`)
    }
  }
})

test('a benchmarked model without an index still gets a measured quality', () => {
  // AA publishes benchmark scores for rows it never indexes. Those rows were being
  // stored as a cross-check and ignored, so the model read as unmeasured.
  const fraction = (value) => ({ gpqa: value, hle: value, 'mmlu-pro': value, aime25: value, 'livecodebench': value })
  const indexed = Array.from({ length: 10 }, (_, position) => ({
    id: `i${position}`,
    name: `Indexed ${position}`,
    intelligenceIndex: 10 + position * 3,
    price1mInputTokens: 1,
    scores: fraction(0.3 + position * 0.04),
  }))
  const unindexed = { id: 'u1', name: 'Kimi K2.7 Code', price1mInputTokens: 0.95, scores: fraction(0.55) }
  const dataset = { 'kimi-k2.7-code': { label: 'Kimi K2.7 Code' } }
  const analysis = extractArtificialAnalysis(page([...indexed, unindexed]), nameIndex(dataset))
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [] })
  const entry = dataset['kimi-k2.7-code']
  assert.ok(Number.isFinite(entry.quality) && entry.quality > 0, `derived quality ${entry.quality}`)
})

test('a model with too few benchmark fractions is not guessed at', () => {
  const dataset = { 'thin-row': { label: 'Thin Row' } }
  const analysis = extractArtificialAnalysis(page([{ id: 'thin', name: 'Thin Row', scores: { gpqa: 0.5 } }]), nameIndex(dataset))
  attachArtificialAnalysis(dataset, { base: {}, analysis })
  assert.equal(dataset['thin-row'].quality, undefined, 'no measurement invented from one benchmark')
})

test('a model dropped from the table is still readable from its own page', () => {
  // AA keeps /models/<slug> for models it no longer ranks; the page carries the
  // benchmark scores, which is where GLM-5.1 and MiniMax-M2.7 live.
  const page = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({
    id: 'p1',
    name: 'GLM-5.1',
    gpqa: 0.867,
    hle: 0.301,
    terminalbenchHard: 0.432,
    livecodebench: 0.55,
    scicode: 0.6,
    price1mInputTokens: 1.19,
  }))}])</script>`
  const found = extractArtificialAnalysisModelPage(page, new Map([['glm51', 'glm-5.1']]))
  assert.ok(found['glm-5.1'] !== undefined, 'matched by name')
  assert.ok(Object.keys(found['glm-5.1'].benchmarks).length >= 4)
  assert.ok(found['glm-5.1'].benchmarks.gpqa > 80, 'fractions become 0-100 scores')
})

test('slug candidates follow AA spelling', () => {
  assert.deepEqual(aaSlugCandidates('glm-5.1').slice(0, 1), ['glm-5-1'])
  assert.ok(aaSlugCandidates('MiniMax/MiniMax-M2.7').includes('minimax-m2-7'))
  assert.ok(aaSlugCandidates('cmaas-glm-5.3').some((slug) => slug.startsWith('glm-5-3')))
})

test('zero benchmark scores are "not run", not a floor measurement', () => {
  // Averaging zeros gave seven unrelated models the same "quality" (the fit's
  // intercept) with evidence 0, which ranked them on an artifact.
  const zeroed = { id: 'z1', name: 'Empty Benchmarks', price1mInputTokens: 0.2, scores: { gpqa: 0, hle: 0, 'terminalbench-hard': 0, scicode: 0, 'mmlu-pro': 0 } }
  const analysis = extractArtificialAnalysis(page([zeroed]), nameIndex({ 'empty-benchmarks': { label: 'Empty Benchmarks' } }))
  const dataset = { 'empty-benchmarks': { label: 'Empty Benchmarks' } }
  const summary = attachArtificialAnalysis(dataset, { base: {}, analysis })
  assert.equal(dataset['empty-benchmarks'].quality, undefined)
  assert.equal(summary.filledQuality, 0)
})

test('only percentages become benchmark scores, not Elo or raw scales', () => {
  const rows = [{ id: 'x', name: 'Qwen3.8 Flash', intelligenceIndex: 0, scores: { gpqa: 0.62, 'aa-3d': 1100, 'gdpval-aa-normalized': 1500 } }]
  const analysis = extractArtificialAnalysis(page(rows), nameIndex({ 'qwen3.8-flash': { label: 'Qwen3.8 Flash' } }))
  const scores = analysis.byId['qwen3.8-flash'].benchmarks
  assert.deepEqual(Object.keys(scores), ['gpqa'], 'Elo and raw scales are excluded')
  assert.equal(scores.gpqa, 62)
  assert.equal(analysis.byId['qwen3.8-flash'].intelligenceIndex, undefined, 'index 0 is unranked')
})

test('a fuzzy neighbour cannot relabel a different model', () => {
  // `siliconflow/deepseek-v3-0324` matched a V4.1 row and shipped its label and
  // quality. Different stems must not join.
  const rows = [{ id: 'r', name: 'DeepSeek V4.1 Flash 1017 (Max)', intelligenceIndex: 40, price1mInputTokens: 2, price1mOutputTokens: 8 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, {
    base: {},
    analysis,
    wanted: [{ model: 'siliconflow/deepseek-v3-0324', provider: 'bailian-aliyun' }],
  })
  assert.deepEqual(dataset, {}, 'no entry is created for an unrelated model')
})
