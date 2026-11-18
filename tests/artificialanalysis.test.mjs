import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFICIAL_ANALYSIS_URL,
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
