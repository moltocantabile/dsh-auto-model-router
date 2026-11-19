import assert from 'node:assert/strict'
import { test } from 'node:test'
import zlib from 'node:zlib'

import {
  attachUsage,
  extractBenchGecko,
  extractCompass,
  extractEpochEci,
  extractLlmBenchmarkPage,
  extractLlmComparison,
  fetchJson,
  nameIndex,
  parseCsv,
  refreshCatalog,
  slugOf,
  countsOf,
} from '../src/refresh.js'

/**
 * Refresh path, checked without the network.
 *
 * The two response shapes are pinned from real payloads, because the failure
 * mode here is silent: a renamed column produces `null` cross-checks rather
 * than an error, and a catalog full of nulls still routes.
 */

/** A gzip body served without a `content-encoding` header, as the CDN does. */
const gzipResponse = (payload) => ({
  ok: true,
  status: 200,
  async arrayBuffer() {
    return zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'))
  },
})

const jsonResponseText = (text) => ({
  ok: true,
  status: 200,
  async arrayBuffer() {
    return Buffer.from(text, 'utf8')
  },
})

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  async arrayBuffer() {
    return Buffer.from(JSON.stringify(payload), 'utf8')
  },
})

test('fetchJson inflates gzip bytes the CDN serves without an encoding header', async () => {
  const payload = { OverallTable: [{ key: 'm', Average: 70 }] }
  const parsed = await fetchJson('https://cdn.example/x.json', { fetchImpl: async () => gzipResponse(payload) })
  assert.deepEqual(parsed, payload)
})

test('fetchJson also accepts plain JSON and rejects HTTP errors', async () => {
  const parsed = await fetchJson('https://cdn.example/x.json', { fetchImpl: async () => jsonResponse({ a: 1 }) })
  assert.deepEqual(parsed, { a: 1 })
  await assert.rejects(
    () => fetchJson('https://cdn.example/x.json', { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  )
})

test('extractCompass flattens both boards into ability and prefixed bench columns', () => {
  const ability = {
    OverallTable: [{ key: 'deepseek-flash', model: 'DeepSeek Flash', release_date: '2026/10/17', Average: 61.73, Knowledge: 68, Abstraction: 72.5, Reasoning: 82.5, Agent: 61.73, responseTokenCost: 164690 }],
    AgentTable: [{ key: 'deepseek-flash', Average: 61.73 }],
  }
  const bench = {
    ProgrammingTable: [{ key: 'deepseek-flash', Average: 55.2, 'SWE-bench Pro Verified': 48.1, responseTokenCost: 99 }],
    GeneralTable: [{ key: 'deepseek-flash', 'HLE-Diamond': 31.4 }],
  }
  const compass = extractCompass(ability, bench)
  const entry = compass['deepseek-flash']
  assert.equal(entry.ability.Reasoning, 82.5)
  assert.equal(entry.ability.responseTokenCost, 164690, 'numeric ability columns are kept')
  assert.equal(entry.released, '2026/10/17')
  assert.equal(entry.bench['Programming.Average'], 55.2)
  assert.equal(entry.bench['Programming.SWE-bench Pro Verified'], 48.1)
  assert.equal(entry.bench['General.HLE-Diamond'], 31.4)
  assert.equal(entry.bench['Programming.responseTokenCost'], undefined, 'token cost is not a benchmark')
})

test('extractBenchGecko reproduces the extraction the catalog was built from', () => {
  const raw = {
    slug: 'deepseek-v4-1-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    context_window: 1048576,
    model_type: 'multimodal',
    is_open_source: true,
    status: 'active',
    release_date: '2026-10-17',
    avg_score: 68.2,
    benchgecko_score: { rank: 49, of: 327 },
    scores: [
      { benchmark: 'GPQA diamond', score: 94.7, category: 'knowledge' },
      { benchmark: 'ARC-AGI', score: 94.5, category: 'knowledge' },
      { benchmark: 'OTIS Mock AIME', score: 99.44, category: 'math' },
      { benchmark: 'APEX-Agents', score: 69.8, category: 'agentic' },
    ],
  }
  const extracted = extractBenchGecko(raw)
  assert.equal(extracted.avg, 68.2)
  assert.equal(extracted.scores.knowledge, 94.6, 'category means, rounded once')
  assert.equal(extracted.scores.math, 99.4)
  assert.equal(extracted.benchgeckoRank, 49)
  assert.equal(extracted.context, 1048576)
  assert.deepEqual(countsOf({ m: extracted }, { m: raw }), { 'deepseek-v4-1-flash-1017': { knowledge: 2, math: 1, agentic: 1 } })
})

test('slugOf reads the BenchGecko slug back out of an entry source', () => {
  assert.equal(slugOf({ sources: ['https://benchgecko.ai/model/deepseek-v4-1-flash-1017'] }), 'deepseek-v4-1-flash-1017')
  assert.equal(slugOf({ sources: ['https://rank.opencompass.org.cn/leaderboard/llm'] }), null)
  assert.equal(slugOf({}), null)
})

test('refreshCatalog compiles a catalog and reports one unreachable source without discarding the other', async () => {
  const base = {
    'qwen3.8-flash': {
      label: 'Qwen3.8 Flash',
      contextWindow: 100000,
      price: { input: 1, output: 2 },
      modalities: ['text'],
      sources: ['https://benchgecko.ai/model/model-a'],
      scores: { coding: 1, reasoning: 1, math: 1, knowledge: 1, agentic: 1 },
    },
  }
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('epoch.ai')) {
      return jsonResponseText('Model,Display name,eci,eci_ci_low,eci_ci_high,date\nQwen3.8 Flash,Qwen3.8 Flash,150,145,155,2026-11-10\n')
    }
    if (href.includes('comparison.csv')) {
      return jsonResponseText('model,provider,configuration,ttft_seconds,output_tokens_per_second\n"Qwen3.8 Flash",Co,"Qwen3.8 Flash",0.4,900\n')
    }
    if (href.includes('/benchmarks/')) {
      return jsonResponseText('<tr data-benchmark-track="terminal-bench-4-0" data-benchmark-model="qwen3.8-flash" data-score="33.3">')
    }
    if (String(url).includes('ability_official')) {
      return gzipResponse({ OverallTable: [{ key: 'qwen3.8-flash', Average: 70, Reasoning: 80, Knowledge: 60, Abstraction: 65, Agent: 70, release_date: '2026/11/17' }] })
    }
    if (String(url).includes('ability_benchmark')) throw new Error('boom')
    return jsonResponse({ slug: 'model-a', name: 'Model A', avg_score: 66, scores: [{ benchmark: 'X', score: 50, category: 'math' }] })
  }
  const result = await refreshCatalog({ base, fetchImpl, now: new Date('2026-11-18T00:00:00Z') })
  assert.equal(result.summary.checkedAt, '2026-11-18')
  assert.equal(result.summary.models, 1)
  assert.equal(result.summary.benchgecko, 1)
  assert.equal(result.summary.compass, 1)
  // `ability_benchmark` throws on purpose; the OpenRouter usage endpoint is also
  // unreachable in this stub. Both are reported and neither is fatal.
  assert.ok(result.summary.errors.length >= 1, 'the failed board is reported, not fatal')
  assert.ok(result.summary.errors.some((error) => error.includes('compass benchmark')), 'the deliberate failure is named')
  assert.equal(result.summary.epoch, 1)
  assert.equal(result.summary.llmLeaderboard, 1)
  assert.equal(result.dataset['qwen3.8-flash'].crossChecks.epoch.eci, 150)
  assert.equal(result.dataset['qwen3.8-flash'].crossChecks.llmLeaderboard.tokensPerSecond, 900)
  assert.equal(result.dataset['qwen3.8-flash'].crossChecks.llmLeaderboard.benchmarks['terminal-bench-4-0'], 33.3)
  assert.ok(result.dataset['qwen3.8-flash'].scores.reasoning > 0)
  assert.equal(result.dataset['qwen3.8-flash'].price.input, 1, 'facts the sources do not carry are preserved')
})

test('parseCsv keeps commas and newlines inside quoted fields', () => {
  const rows = parseCsv('a,b,c\n1,"x,y","line\nbreak"\n')
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x,y', 'line\nbreak']])
})

test('extractEpochEci maps the display name through the catalog index', () => {
  const index = nameIndex({ 'qwen3.8-max': { label: 'Qwen3.8 Max' } })
  const csv = [
    'Model,Display name,eci,eci_ci_low,eci_ci_high,date,Organization',
    'Qwen3.8 Max,Qwen3.8 Max (0902),158.2,150,166,2026-11-10,Alibaba',
    'Unrelated,Unrelated Model,10,9,11,2026-11-10,Someone',
  ].join('\n')
  const epoch = extractEpochEci(csv, index)
  assert.deepEqual(epoch, { 'qwen3.8-max': { eci: 158.2, date: '2026-11-10', source: 'https://epoch.ai/data/eci_scores.csv' } })
})

test('extractLlmComparison keeps the fastest offer per model', () => {
  const index = nameIndex({ 'deepseek-v4.1-flash-1017': { label: 'DeepSeek V4.1 Flash 1017' } })
  const csv = [
    'model,provider,configuration,ttft_seconds,output_tokens_per_second',
    '"DeepSeek V4.1 Flash 1017",SlowCo,"DeepSeek V4.1 Flash 1017 (max)",1.9,120.5',
    '"DeepSeek V4.1 Flash 1017",FastCo,"DeepSeek V4.1 Flash 1017 (max)",1.3,1075.3',
    '"Other",Co,"Other",2.0,10',
  ].join('\n')
  const llm = extractLlmComparison(csv, index)
  assert.equal(llm['deepseek-v4.1-flash-1017'].provider, 'FastCo')
  assert.equal(llm['deepseek-v4.1-flash-1017'].tokensPerSecond, 1075.3)
  assert.equal(llm['deepseek-v4.1-flash-1017'].ttftSeconds, 1.3)
})

test('extractLlmBenchmarkPage keeps only the named track', () => {
  const index = nameIndex({ 'qwen4-max': { label: 'Qwen4 Max' } })
  const html = [
    '<tr data-benchmark-track="terminal-bench-4-0" data-benchmark-model="qwen4-max" data-score="41.2">',
    '<tr data-benchmark-track="terminal-bench-2-1-aa" data-benchmark-model="qwen4-max" data-score="70">',
    '<tr data-benchmark-track="terminal-bench-4-0" data-benchmark-model="someone-else" data-score="55">',
  ].join('\n')
  assert.deepEqual(extractLlmBenchmarkPage(html, 'terminal-bench-4-0', index), { 'qwen4-max': 41.2 })
  assert.deepEqual(extractLlmBenchmarkPage(html, null, index), {})
})

test('usage percentiles describe the ranks the catalog actually carries', () => {
  // Two rows can match one catalog key (an exact id, then a reseller spelling);
  // the last write wins. The percentile used to be computed over every fetched
  // row, so a rank no entry ended up carrying widened the denominator and every
  // entry's percentile was understated.
  const dataset = { 'p/glm-5.3': { label: 'GLM-5.3' }, 'p/other': { label: 'Other' } }
  const result = attachUsage(dataset, [
    { id: 'zhipu/glm-5.3', weeklyRank: 1 },
    { id: 'reseller/glm-5.3', weeklyRank: 9 },
    { id: 'someone/other', weeklyRank: 2 },
  ])
  assert.equal(dataset['p/glm-5.3'].usage.rank, 9, 'the last matching row wins')
  assert.equal(result.uniqueRanks, 2, 'the stale rank is not part of the ranking')
  assert.equal(dataset['p/glm-5.3'].usage.percentile, 0)
  assert.equal(dataset['p/other'].usage.percentile, 100)
})

test('a model created from an AA row still receives its Epoch and llmleaderboard cross-checks', async () => {
  // The entry-creation pass is part of the same refresh: name-based source passes
  // run before it, so unless the advertised ids are in the name index too, a
  // newly created entry silently loses the rows Epoch and llmleaderboard published
  // for it.
  const rows = [{
    id: 'r',
    name: 'Kimi K3.1 Pro',
    price1mInputTokens: 1,
    price1mOutputTokens: 2,
    intelligenceIndex: 50,
    scores: { gpqa: 0.7, hle: 0.4, livecodebench: 0.5, 'terminalbench-hard': 0.3 },
  }]
  const flight = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(rows))}])</script>`
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('ability_official')) return gzipResponse({ OverallTable: [] })
    if (href.includes('ability_benchmark')) throw new Error('no benchmark board')
    if (href.includes('epoch.ai')) return jsonResponseText('Model,Display name,eci,eci_ci_low,eci_ci_high,date\nKimi K3.1 Pro,Kimi K3.1 Pro,161.36,158,164,2026-10-23\n')
    if (href.includes('comparison.csv')) return jsonResponseText('model,provider,configuration,ttft_seconds,output_tokens_per_second\n"Kimi K3.1 Pro",Kimi,default,0.8,120\n')
    if (href.includes('llmleaderboard.com/benchmarks/')) return jsonResponseText('<tr data-benchmark-track="terminal-bench-4-0" data-benchmark-model="Kimi K3.1 Pro" data-score="60">')
    if (href.includes('artificialanalysis.ai')) return jsonResponseText(flight)
    throw new Error(`unexpected ${href}`)
  }
  const result = await refreshCatalog({ base: {}, wanted: [{ model: 'kimi-k3.1-pro', provider: 'p' }], fetchImpl })
  const entry = result.dataset['kimi-k3.1-pro']
  assert.ok(entry !== undefined, 'AA created the entry')
  assert.equal(entry.crossChecks.epoch.eci, 161.4)
  assert.equal(entry.crossChecks.epoch.date, '2026-10-23')
  assert.equal(entry.crossChecks.llmLeaderboard.tokensPerSecond, 120)
})

test('a BenchGecko zero is "not run": no mean, no leaf score, no evidence', () => {
  // The publisher writes 0 for a benchmark it has no sample for. Averaging it
  // into a category mean understated the dimension, storing it in the leaf map
  // made a non-measurement look like a score, and counting it inflated evidence.
  const raw = {
    slug: 'm',
    name: 'M',
    avg_score: 50,
    scores: [
      { benchmark: 'A', score: 80, category: 'math' },
      { benchmark: 'B', score: 0, category: 'math' },
      { benchmark: 'C', score: 60, category: 'knowledge' },
    ],
  }
  const extracted = extractBenchGecko(raw)
  assert.equal(extracted.scores.math, 80, 'the zero is not averaged in')
  assert.equal(extracted.benchmarks.B, undefined, 'the zero is not stored as a score')
  assert.equal(extracted.benchmarks.A, 80)
  assert.deepEqual(countsOf({ m: extracted }, { m: raw }), { m: { math: 1, knowledge: 1 } })
})

test('a model page does not overwrite the leaderboard row for a model it happens to embed', async () => {
  // AA model pages embed rows for other models too. Those rows lack the published
  // index and used to replace the table row of a model that was already matched,
  // erasing its index (and, before the label fix, its name).
  const table = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify([
    { id: 'k3', name: 'Kimi K3', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: 55, contextWindowTokens: 100000, scores: { gpqa: 0.7, hle: 0.4, livecodebench: 0.5, 'terminalbench-hard': 0.3 } },
  ]))}])</script>`
  const otherPage = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify([
    { id: 'p', name: 'Kimi K3', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: null, contextWindowTokens: 200000, scores: { gpqa: 0.6, hle: 0.3, livecodebench: 0.4, 'terminalbench-hard': 0.2 } },
    { id: 'p2', name: 'Other Model', price1mInputTokens: 1, price1mOutputTokens: 2, intelligenceIndex: null, scores: { gpqa: 0.6, hle: 0.3, livecodebench: 0.4, 'terminalbench-hard': 0.2 } },
  ]))}])</script>`
  const fetchImpl = async (url) => {
    const href = String(url)
    if (href.includes('epoch.ai') || href.includes('comparison.csv') || href.includes('llmleaderboard.com/benchmarks/')) throw new Error('unavailable')
    if (href.includes('openrouter')) throw new Error('unavailable')
    if (href.includes('ability_official') || href.includes('ability_benchmark')) throw new Error('unavailable')
    if (href.endsWith('/leaderboards/models')) return jsonResponseText(table)
    if (href.includes('/models/')) return jsonResponseText(otherPage)
    throw new Error(`unexpected ${href}`)
  }
  const result = await refreshCatalog({
    base: {},
    wanted: [{ model: 'kimi-k3', provider: 'p' }, { model: 'other-model', provider: 'p' }],
    fetchImpl,
  })
  assert.equal(result.dataset['kimi-k3'].crossChecks.artificialAnalysis.intelligenceIndex, 55, 'the table row keeps the index')
})
