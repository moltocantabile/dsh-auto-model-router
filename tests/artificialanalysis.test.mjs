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
  extractEpochEci,
  extractLlmBenchmarkPage,
  extractLlmComparison,
  attachCrossChecks,
  attachRanking,
  nameIndex,
  nameIndexAll,
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

test('an AA index does not invent a legacy quality', () => {
  // The index is AA's own scale. It used to be fitted to the demoted legacy
  // `quality` field -- and with fewer than five overlap models it fell back to
  // hard-coded slope/intercept defaults, which minted a legacy score for every
  // entry AA had measured (`kimi-k3.1-pro` read 95.4 while its measured
  // composite was ~50). `rank.js` fits the index to the measured composite for
  // provisional entries; this pass stores measurements, not capability scores.
  const dataset = { 'qwen3.8-flash': { label: 'Qwen3.8 Flash', quality: 60.1 }, 'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', quality: 70 } }
  const analysis = extractArtificialAnalysis(page(ROWS), nameIndex(BASE))
  const summary = attachArtificialAnalysis(dataset, { base: BASE, analysis })
  assert.equal(dataset['qwen3.8-flash'].quality, 60.1, 'an existing legacy score is left alone')
  assert.equal(dataset['deepseek-v4-pro'].quality, 70, 'no calibrated number is written into the legacy field')
  assert.equal(summary.measured, 1, 'AA reports what it measured')
  assert.equal(summary.filledQuality, 1, 'the status-line count is AA measurements, not invented scores')
  assert.equal(summary.calibration, undefined, 'the legacy-quality calibration is gone')
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
  assert.equal(entry.quality, undefined, 'no capability score is minted from the index')
  assert.equal(entry.latency, 'balanced', 'derived from the measured TTFT, not assumed')
  assert.equal(entry.contextWindow, null, 'an unpublished capacity is unknown, not zero')
  assert.ok(entry.price.input > 0)
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

test('a reseller prefix matches the same model, a speed tier does not', () => {
  const rows = [
    { id: 's1', name: 'GLM-5.3', price1mInputTokens: 1.4, price1mOutputTokens: 4, intelligenceIndex: 40 },
    { id: 's2', name: 'GLM-5.3-Flash', price1mInputTokens: 0.15, price1mOutputTokens: 0.5, intelligenceIndex: 30 },
  ]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [{ model: 'cmaas-glm-5.3', provider: 'bailian-aliyun' }] })
  assert.ok(dataset['cmaas-glm-5.3'] !== undefined, 'the reseller prefix does not block the match')
  assert.equal(dataset['cmaas-glm-5.3'].label, 'GLM-5.3', 'a reseller matches the base model')

  // With only the Flash row on offer the base model must stay unmatched rather
  // than borrow a different model's price and score.
  const flashOnly = extractArtificialAnalysis(page([rows[1]]), new Map())
  const other = {}
  attachArtificialAnalysis(other, { base: {}, analysis: flashOnly, wanted: [{ model: 'cmaas-glm-5.3', provider: 'bailian-aliyun' }] })
  assert.deepEqual(other, {}, 'a speed tier is a different model, not a variant of the base')
})

test('a version digit is not a variant tail', () => {
  // `deepseek-v4` against `DeepSeek-V4.1` used to pass the one-or-two-digit rule.
  const rows = [{ id: 'd1', name: 'DeepSeek-V4.1', price1mInputTokens: 0.3, price1mOutputTokens: 1.2, intelligenceIndex: 40 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [{ model: 'deepseek-v4', provider: 'bailian-aliyun' }] })
  assert.deepEqual(dataset, {}, 'a different version is a different model')
})

test('an effort variant still matches its base model', () => {
  // AA publishes one row per reasoning effort; those describe one catalog model.
  const rows = [{ id: 'g1', name: 'GLM-5.3 Reasoning', price1mInputTokens: 1.4, price1mOutputTokens: 4, intelligenceIndex: 40 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, { base: {}, analysis, wanted: [{ model: 'glm-5.3', provider: 'bailian-aliyun' }] })
  assert.ok(dataset['glm-5.3'] !== undefined, 'effort variants are the same model')
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

test('a benchmarked model without an index keeps its observations and gets no invented score', () => {
  // AA publishes benchmark scores for rows it never indexes. They are evidence
  // the ranking engine consumes as observations -- not a reason to write a
  // legacy quality onto the entry. Without a channel to calibrate them against,
  // the honest result is "unmeasured", not a guessed number.
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
  assert.equal(entry.quality, undefined, 'no legacy quality is derived from the benchmark mean')
  assert.equal(Object.keys(entry.crossChecks.artificialAnalysis.benchmarks).length, 5, 'the observations are stored')
  assert.equal(attachRanking(dataset).summary.measured, 0, 'nothing can place them on the axis yet')
  assert.equal(entry.ranking.status, 'unmeasured', 'no score is invented to fill the gap')
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

test('the raw mixed-scale scores and metadata are retained, not discarded', () => {
  // The router reads percentages; the rest is kept as published so a later
  // consumer (or the decision model) can use what we have not decided to read.
  const rows = [{
    id: 'r', name: 'GLM-5.3', intelligenceIndex: 31,
    price1mInputTokens: 1.4, price1mOutputTokens: 4,
    contextWindowTokens: 200000, isReasoning: true, isOpenWeights: false,
    release: { releaseDate: '2026-10-01' }, modelCreatorName: 'Z AI', cacheHitPrice: 0.02,
    scores: { gpqa: 0.866, 'aa-3d': 1187.5, 'gdpval-aa-normalized': -400 },
  }]
  const dataset = { 'glm-5.3': { label: 'GLM-5.3' } }
  const analysis = extractArtificialAnalysis(page(rows), nameIndex(dataset))
  attachArtificialAnalysis(dataset, { base: {}, analysis })
  const aa = dataset['glm-5.3'].crossChecks.artificialAnalysis
  assert.equal(aa.benchmarks.gpqa, 86.6, 'percentages are scaled for the engine')
  assert.equal(aa.rawScores['aa-3d'], 1187.5, 'Elo is retained as published')
  assert.equal(aa.rawScores['gdpval-aa-normalized'], -400)
  assert.equal(aa.contextTokens, 200000)
  assert.equal(aa.reasoning, true)
  assert.equal(aa.releaseDate, '2026-10-01')
  assert.equal(aa.creator, 'Z AI')
  assert.equal(aa.cacheHitPrice, 0.02)
})

const measuredEntry = (label) => ({
  label,
  quality: 70,
  price: { input: 2, output: 8 },
  latency: 'balanced',
  contextWindow: 200000,
  modalities: ['text'],
  toolCalling: true,
  bestFor: [],
  weaknesses: [],
  sources: [],
})

const AA_FRACTIONS = { gpqa: 0.8, hle: 0.3, livecodebench: 0.6, 'terminalbench-hard': 0.4, 'mmlu-pro': 0.78 }

test('twin catalog ids for one model share a single AA row', () => {
  // `ZHIPU/GLM-5.3`, `cmaas-glm-5.3` and `glm-5.3` are three endpoints for one
  // model. AA's row names the model, so every id must receive it; the old
  // single-id `claim()` filled whichever id won the name index and left the
  // twins with no per-dimension measurement.
  const base = {
    'ZHIPU/GLM-5.3': { label: 'GLM-5.3 (Max)', quality: 60.4 },
    'cmaas-glm-5.3': { label: 'GLM-5.3 (Max)', quality: 62.6 },
    'glm-5.3': { label: 'GLM-5.3', quality: 63 },
  }
  const row = { id: 'r', name: 'GLM-5.3', price1mInputTokens: 1, price1mOutputTokens: 4, intelligenceIndex: 50, scores: AA_FRACTIONS }
  const analysis = extractArtificialAnalysis(page([row]), nameIndexAll(base))
  for (const id of Object.keys(base)) {
    assert.ok(analysis.byId[id] !== undefined, `${id} received the row`)
    assert.equal(analysis.byId[id].benchmarks.gpqa, 80)
  }
  const dataset = JSON.parse(JSON.stringify(base))
  attachArtificialAnalysis(dataset, { base, analysis })
  for (const id of Object.keys(base)) {
    assert.ok(dataset[id].crossChecks?.artificialAnalysis?.benchmarks?.gpqa > 0, `${id} kept the benchmark observations`)
  }
})

test('the stem guard keeps a mislabelled neighbour out of a multi-id fill', () => {
  // A wrong label on `siliconflow/deepseek-v3-0324` must not let a V4.1 row
  // attach: the id names a different model even though its label does not.
  const base = {
    'deepseek-v4.1-flash-1017': { label: 'DeepSeek-V4.1-Flash-1017', quality: 67.4 },
    'siliconflow/deepseek-v3-0324': { label: 'DeepSeek V4.1 Flash 1017', quality: 60 },
  }
  const rows = [{ id: 'r', name: 'DeepSeek V4.1 Flash 1017', price1mInputTokens: 2, price1mOutputTokens: 8, intelligenceIndex: 40, scores: AA_FRACTIONS }]
  const analysis = extractArtificialAnalysis(page(rows), nameIndexAll(base))
  assert.ok(analysis.byId['deepseek-v4.1-flash-1017'] !== undefined, 'the real id gets the row')
  assert.equal(analysis.byId['siliconflow/deepseek-v3-0324'], undefined, 'the different model does not')
})

test('llmleaderboard and Epoch rows reach every catalog id for the model', () => {
  const base = { 'kimi/kimi-k3.1-pro': measuredEntry('Kimi K3.1 Pro'), 'kimi-k3.1-pro': measuredEntry('Kimi K3.1 Pro') }
  const index = nameIndexAll(base)
  const csv = [
    'model,provider,configuration,ttft_seconds,output_tokens_per_second',
    'Kimi K3.1 Pro,Inco,default,0.8,120',
  ].join('\n')
  const llm = extractLlmComparison(csv, index)
  assert.deepEqual(Object.keys(llm).sort(), ['kimi-k3.1-pro', 'kimi/kimi-k3.1-pro'])
  const html = '<tr data-benchmark-track="coding" data-benchmark-model="Kimi K3.1 Pro" data-score="67.5">'
  const board = extractLlmBenchmarkPage(html, 'coding', index)
  assert.deepEqual(Object.keys(board).sort(), ['kimi-k3.1-pro', 'kimi/kimi-k3.1-pro'])
  const epoch = extractEpochEci(['Display name,eci,date', 'Kimi K3.1 Pro,44.2,2026-11-01'].join('\n'), index)
  assert.deepEqual(Object.keys(epoch).sort(), ['kimi-k3.1-pro', 'kimi/kimi-k3.1-pro'])
})

test('twin ids become rankable together once they share a measurement', () => {
  // The measured single id is measured from its own AA row; the twin can only be
  // measured if the same row reaches it. Four anchored models give the AA channel
  // enough overlap to calibrate, exactly as the real catalog does.
  const base = {}
  const rows = []
  for (let n = 1; n <= 4; n += 1) {
    const id = `anchor-${n}`
    const value = 40 + n * 8
    base[id] = {
      ...measuredEntry(`Anchor ${n}`),
      benchmarks: { 'GPQA diamond': value, LiveCodeBench: value - 4, 'Terminal-Bench': value - 6, 'MMLU-Pro': value - 2 },
      benchmarkSources: ['benchgecko'],
    }
    rows.push({
      id: `a${n}`,
      name: `Anchor ${n}`,
      price1mInputTokens: 1,
      intelligenceIndex: value,
      scores: { gpqa: value / 100, livecodebench: (value - 4) / 100, 'mmlu-pro': (value - 2) / 100, 'terminalbench-hard': (value - 6) / 100 },
    })
  }
  const twinIds = { 'zhipu/glm-5.3': 'GLM-5.3 (Max)', 'glm-5.3': 'GLM-5.3' }
  for (const [id, label] of Object.entries(twinIds)) base[id] = measuredEntry(label)
  rows.push({ id: 'glm', name: 'GLM-5.3', price1mInputTokens: 1, intelligenceIndex: 55, scores: AA_FRACTIONS })

  const analysis = extractArtificialAnalysis(page(rows), nameIndexAll(base))
  const dataset = JSON.parse(JSON.stringify(base))
  attachArtificialAnalysis(dataset, { base, analysis })
  attachRanking(dataset)
  for (const id of Object.keys(twinIds)) {
    assert.equal(dataset[id].ranking.status, 'measured', `${id} is measured`)
    assert.ok(Number.isInteger(dataset[id].ranking.rank), `${id} has a rank`)
  }
  // Both twins describe one model, so the shared row gives them the same AA
  // observations even though their own ids differ.
  assert.deepEqual(
    Object.keys(dataset['glm-5.3'].crossChecks.artificialAnalysis.benchmarks).sort(),
    Object.keys(dataset['zhipu/glm-5.3'].crossChecks.artificialAnalysis.benchmarks).sort(),
  )
})

test('nameIndexAll resolves one model name to every id behind it', () => {
  const index = nameIndexAll({
    'ZHIPU/GLM-5.3': { label: 'GLM-5.3 (Max)' },
    'cmaas-glm-5.3': { label: 'Zhipu GLM 5.3' },
    'glm-5.3': { label: 'GLM-5.3' },
    'glm-5': { label: 'GLM-5' },
  })
  assert.deepEqual([...index.get('glm53')].sort(), ['ZHIPU/GLM-5.3', 'cmaas-glm-5.3', 'glm-5.3'])
  assert.deepEqual(index.get('glm5'), ['glm-5'])
  // The single-id index keeps its contract for callers that need one answer.
  assert.equal(nameIndex({ 'glm-5.3': { label: 'GLM-5.3' } }).get('glm53'), 'glm-5.3')
})

// ── cross-generation joins (deferred defect) ────────────────────────────────

/**
 * The shipped catalog carried `vanchin/deepseek-v3` labelled "DeepSeek V3.2
 * (Reasoning)": a V3 id wearing a V3.2 name. Every name-based source pass wrote
 * by id, so the entry collected the 2024 V3 Epoch row, the V3 serving data and
 * the V3 board scores while its label named the next generation. The id is the
 * identity; a row may only attach when the label names the same model too.
 */
const MISLABELLED = {
  'p/deepseek-v3': { label: 'DeepSeek V3.2 (Reasoning)', quality: 71.9 },
  'p/deepseek-v3.2': { label: 'DeepSeek V3.2 (Reasoning)', quality: 71.9 },
}
const MISLABELLED_INDEX = nameIndexAll(MISLABELLED)

test('Epoch does not hand a mislabelled entry another generation\'s ECI', () => {
  const csv = [
    'Model,Display name,eci,eci_ci_low,eci_ci_high,date',
    'DeepSeek-V3,DeepSeek-V3,131.71,129.14,134.01,2024-12-26',
    'DeepSeek-V3.2,DeepSeek-V3.2,146.26,144.75,147.75,2025-12-01',
  ].join('\n')
  const epoch = extractEpochEci(csv, MISLABELLED_INDEX, MISLABELLED)
  assert.equal(epoch['p/deepseek-v3'], undefined, 'a V3.2 label does not own the 2024 V3 ECI')
  assert.equal(epoch['p/deepseek-v3.2'].eci, 146.3, 'the correctly labelled V3.2 entry keeps its row')
  assert.equal(epoch['p/deepseek-v3.2'].date, '2025-12-01')
})

test('llmleaderboard does not attach a cross-generation serving row', () => {
  const csv = [
    'model,provider,configuration,ttft_seconds,output_tokens_per_second',
    'DeepSeek-V3,SlowCo,default,1.2,40',
    'DeepSeek-V3.2,FastCo,default,0.6,120',
  ].join('\n')
  const llm = extractLlmComparison(csv, MISLABELLED_INDEX, MISLABELLED)
  assert.equal(llm['p/deepseek-v3'], undefined, 'the 2024 V3 row does not land under a V3.2 label')
  assert.equal(llm['p/deepseek-v3.2'].tokensPerSecond, 120)
})

test('a benchmark board row follows the same generation guard', () => {
  const html = [
    '<tr data-benchmark-track="t" data-benchmark-model="DeepSeek-V3" data-score="70">',
    '<tr data-benchmark-track="t" data-benchmark-model="DeepSeek-V3.2" data-score="80">',
  ].join('\n')
  assert.deepEqual(extractLlmBenchmarkPage(html, 't', MISLABELLED_INDEX, MISLABELLED), { 'p/deepseek-v3.2': 80 })
})

test('the AA multi-id fill applies the same label guard', () => {
  // `p/deepseek-v3` is labelled V3.2; an AA row that names V3 must not fill it.
  const row = { id: 'r', name: 'DeepSeek-V3', price1mInputTokens: 0.3, price1mOutputTokens: 1.2, intelligenceIndex: 40 }
  const analysis = extractArtificialAnalysis(page([row]), MISLABELLED_INDEX, MISLABELLED)
  assert.equal(analysis.byId['p/deepseek-v3'], undefined)
  assert.ok(analysis.byId['p/deepseek-v3.2'] === undefined, 'the V3 row does not match the V3.2 id either')
})

test('a different generation is never created under an id that names another', () => {
  // The advertised id is `vanchin/deepseek-v3`; AA's row names V3.2. A prefix
  // guard accepted it ("deepseekv32" starts with "deepseekv3") and shipped the
  // wrong label; the identity guard refuses.
  const rows = [{ id: 'r', name: 'DeepSeek V3.2 (Reasoning)', price1mInputTokens: 0.3, price1mOutputTokens: 1.2, intelligenceIndex: 45, scores: AA_FRACTIONS }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  const summary = attachArtificialAnalysis(dataset, {
    base: {},
    analysis,
    wanted: [{ model: 'vanchin/deepseek-v3', provider: 'bailian-aliyun' }],
  })
  assert.equal(summary.created, 0)
  assert.deepEqual(dataset, {}, 'no entry is created with a label the id does not name')
})

test('a serving-tier suffix is the same model, a model tier is not', () => {
  // Same weights on a faster endpoint (`-highspeed`) is a serving variant; the
  // label may drop it. A tier word (`-flash`, `-max`) names a different model.
  const base = { 'kimi/kimi-k3.1-pro-highspeed': { label: 'Kimi K3.1 Pro' } }
  const index = nameIndexAll(base)
  const csv = 'model,provider,configuration,ttft_seconds,output_tokens_per_second\nKimi K3.1 Pro,Kimi,default,0.7,130'
  const llm = extractLlmComparison(csv, index, base)
  assert.equal(llm['kimi/kimi-k3.1-pro-highspeed'].tokensPerSecond, 130, 'same model, faster endpoint')

  const tiered = { 'glm-5.3-flash': { label: 'GLM-5.3' } }
  const tieredIndex = nameIndexAll(tiered)
  const row = 'model,provider,configuration,ttft_seconds,output_tokens_per_second\nGLM-5.3,Z.ai,default,0.7,130'
  assert.deepEqual(extractLlmComparison(row, tieredIndex, tiered), {}, 'a Flash entry is not the base model')
})

// ── model-page metadata ────────────────────────────────────────────────────

test('a page-created entry carries the capacity and serving facts the page publishes', () => {
  // The table row carries `contextWindowTokens`/`timeToFirstToken`; the model
  // page carries the same facts under `headline`. Reading only the benchmark
  // table left page-created entries with context 0 and no serving measurement.
  const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({
    id: 'p1',
    name: 'GLM-5.1 (Reasoning)',
    gpqa: 0.867,
    hle: 0.301,
    terminalbenchHard: 0.432,
    livecodebench: 0.55,
    scicode: 0.6,
    price1mInputTokens: 1.19,
    price1mOutputTokens: 3.74,
    contextWindowTokens: 200000,
    isReasoning: true,
    releaseDate: '2026-04-07',
    headline: { timeToFirstToken: 3.6, outputSpeed: 64.7 },
  }))}])</script>`
  const found = extractArtificialAnalysisModelPage(html, new Map([['glm51reasoning', 'glm-5.1']]))
  const value = found['glm-5.1']
  assert.equal(value.contextTokens, 200000)
  assert.equal(value.reasoning, true)
  assert.equal(value.releaseDate, '2026-04-07')
  assert.equal(value.ttft, 3.6)
  assert.equal(value.speed, 64.7)
})

test('a dated snapshot only describes the id that pins it', () => {
  // A snapshot date is part of the model identity. `vanchin/deepseek-v4.1-flash`
  // and `...-1017` are advertised as two ids, so the 1017 row must not become the
  // undated alias's measurements (both ids used to share one AA row, same price,
  // same dimensions and same evidence).
  const rows = [{ id: 'r', name: 'DeepSeek V4.1 Flash 1017 (Max)', price1mInputTokens: 0.3, price1mOutputTokens: 1.2, intelligenceIndex: 40, scores: AA_FRACTIONS }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const dataset = {}
  attachArtificialAnalysis(dataset, {
    analysis,
    wanted: [
      { model: 'vanchin/deepseek-v4.1-flash', provider: 'bailian-aliyun' },
      { model: 'vanchin/deepseek-v4.1-flash-1017', provider: 'bailian-aliyun' },
    ],
  })
  assert.equal(dataset['vanchin/deepseek-v4.1-flash'], undefined, 'the undated alias is not the 1017 snapshot')
  assert.equal(dataset['vanchin/deepseek-v4.1-flash-1017'].label, 'DeepSeek V4.1 Flash 1017')
})

test('an effort variant does not replace the model\'s own row as the name match', () => {
  // The qualifier-stripped spelling ("Kimi K3 (Low)" -> "kimik3") is a fallback.
  // When it overwrote the row actually named "Kimi K3", the later-emitted variant
  // became the entry's label and its measurements.
  const rows = [
    { id: 'plain', name: 'Kimi K3', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 55 },
    { id: 'low', name: 'Kimi K3 (Low)', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 40 },
  ]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  assert.equal(analysis.byName.get('kimik3').intelligenceIndex, 55)
  const dataset = { 'kimi-k3': { label: 'Kimi-K3' } }
  attachArtificialAnalysis(dataset, { analysis, wanted: [{ model: 'kimi/kimi-k3', provider: 'p' }] })
  assert.equal(dataset['kimi/kimi-k3'].label, 'Kimi K3')
  assert.equal(dataset['kimi/kimi-k3'].crossChecks.artificialAnalysis.intelligenceIndex, 55)
})

test('a serving suffix joins by name; a snapshot date does not', () => {
  // Effort/serving qualifiers are the same model; a snapshot date is its own
  // model. `kimi/kimi-k3.1-pro-highspeed` still finds "Kimi K3.1 Pro", while
  // `qwen3.7-plus-2026-05-26` is not "Qwen3.7 Plus".
  const base = { 'qwen3.7-plus': { label: 'Qwen3.7-Plus' } }
  const advertised = [
    { model: 'qwen3.7-plus-2026-05-26', provider: 'p' },
    { model: 'kimi/kimi-k3.1-pro-highspeed', provider: 'p' },
  ]
  const strict = nameIndexAll(base, advertised)
  assert.deepEqual(strict.get('qwen37plus'), ['qwen3.7-plus'], 'the Artificial Analysis join keeps the exact spelling')
  const index = nameIndexAll(base, advertised, { family: true })
  assert.deepEqual(index.get('qwen37plus'), ['qwen3.7-plus'], 'the dated snapshot is not the undated model')
  assert.deepEqual(index.get('kimik31pro'), ['kimi/kimi-k3.1-pro-highspeed'])
  const epoch = extractEpochEci('Model,Display name,eci,eci_ci_low,eci_ci_high,date\nQwen3.7-Plus,Qwen3.7-Plus,147.95,146,149,2026-06-02', index, {})
  assert.ok(epoch['qwen3.7-plus'] !== undefined)
  assert.equal(epoch['qwen3.7-plus-2026-05-26'], undefined)
})

test('a dated id never borrows an undated row (and vice versa)', () => {
  // Epoch publishes `DeepSeek-V3` without a snapshot date. The dated catalog id
  // `deepseek-v3-0324` is its own model, so neither that row nor the
  // "(Mar 2025)" spelling may be attached to it by stripping the date.
  const advertised = [{ model: 'siliconflow/deepseek-v3-0324', provider: 'p' }]
  const index = nameIndexAll({}, advertised, { family: true })
  const csv = [
    'Model,Display name,eci,eci_ci_low,eci_ci_high,date',
    'DeepSeek-V3,DeepSeek-V3,131.71,129.14,134.01,2024-12-26',
    'DeepSeek-V3 (Mar 2025),DeepSeek-V3 (Mar 2025),135.28,133.12,137.34,2025-03-24',
  ].join('\n')
  const epoch = extractEpochEci(csv, index, {})
  assert.equal(epoch['siliconflow/deepseek-v3-0324'], undefined, 'no cross-generation join')
})

test('the row naming the id exactly describes it, whatever the payload order', () => {
  // An effort variant's stripped spelling also resolves the base id. The base
  // model's own row must describe it; a later, higher-index variant row must not
  // overwrite the measurement of the model itself.
  const rows = [
    { id: 'plain', name: 'Kimi K3', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 55 },
    { id: 'low', name: 'Kimi K3 (Low)', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 60 },
  ]
  const analysis = extractArtificialAnalysis(page(rows), nameIndexAll({ 'kimi-k3': { label: 'Kimi-K3' } }))
  assert.equal(analysis.byId['kimi-k3'].intelligenceIndex, 55, 'the base row owns the base id')
})

test('an AA-created entry states modalities only when a source or the baseline has them', () => {
  const rows = [{ id: 'm', name: 'Mystery Model', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 40 }]
  const analysis = extractArtificialAnalysis(page(rows), new Map())
  const unknown = {}
  attachArtificialAnalysis(unknown, { base: {}, analysis, wanted: [{ model: 'mystery-model', provider: 'p' }] })
  assert.equal(unknown['mystery-model'].modalities, undefined, 'no source says it, so it is unknown')
  assert.equal(unknown['mystery-model'].toolCalling, undefined)

  // A baseline entry for the same model is another source: inherit, do not invent.
  const inherited = {}
  attachArtificialAnalysis(inherited, {
    base: { 'mystery-model': { label: 'Mystery Model', modalities: ['text', 'image'], toolCalling: true } },
    analysis,
    wanted: [{ model: 'mystery-model', provider: 'p' }],
  })
  assert.deepEqual(inherited['mystery-model'].modalities, ['text', 'image'])
  assert.equal(inherited['mystery-model'].toolCalling, true)
})



test('a curated alias passes the identity guard', () => {
  // The alias table exists for sources that spell a model differently. The name
  // guard must honour it, otherwise the alias is indexed but the row is dropped
  // before it can be claimed. Fixture uses a shipped alias entry, not new logic.
  const base = { 'qwen3.8-max': { label: 'Qwen3.8-Max' } }
  const index = nameIndexAll(base)
  const rows = [{ id: 'r', name: 'Qwen3.8 Max (0902)', price1mInputTokens: 2, price1mOutputTokens: 6, intelligenceIndex: 66, scores: AA_FRACTIONS }]
  const analysis = extractArtificialAnalysis(page(rows), index)
  const dataset = { 'qwen3.8-max': { label: 'Qwen3.8-Max' } }
  attachArtificialAnalysis(dataset, { analysis, base, wanted: [] })
  assert.equal(dataset['qwen3.8-max'].crossChecks.artificialAnalysis.intelligenceIndex, 66)
})
