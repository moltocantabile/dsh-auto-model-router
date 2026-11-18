/**
 * Live refresh of the model knowledge base.
 *
 * The committed catalog is produced by `scripts/build-model-info.mjs` from two
 * captures in `data/`. This module performs the same two fetches at run time so
 * the settings page can pick up a leaderboard refresh without a rebuild:
 *
 * - **CompassRank** (OpenCompass) publishes both boards as static JSON on its
 *   CDN. The files are served gzip-encoded *without* a `content-encoding`
 *   header, so a plain `fetch().json()` fails; the bytes must be inflated when
 *   they start with the gzip magic.
 * - **BenchGecko** exposes one JSON document per model slug
 *   (`/api/v1/models/<slug>`); the slug for each id is already recorded in that
 *   entry's `sources`, so no separate mapping table can go stale.
 *
 * Both results are compiled by `model-data-build.js` — the same arithmetic the
 * build script uses — so a refresh cannot change method, only inputs.
 *
 * The refreshed catalog is written next to the bundled one and also swapped into
 * memory, so the effect is visible immediately and survives a restart.
 */

import zlib from 'node:zlib'
import { buildDataset, COMPASS_ID } from './model-data-build.js'
import { derivedEnvelopes as rankDerivedEnvelopes, rankTable } from './rank.js'
import { costIndex } from './select.js'
import { fetchOpenRouterUsage } from './openrouter.js'
import { DIMENSIONS } from './select.js'

const CDN = 'https://cdn.opencompass.org.cn/assets/lm'
export const COMPASS_ABILITY_URL = `${CDN}/data-lm-ability_official.json`
export const COMPASS_BENCH_URL = `${CDN}/data-lm-ability_benchmark.json`
export const BENCHGECKO_MODEL_URL = (slug) => `https://benchgecko.ai/api/v1/models/${encodeURIComponent(slug)}`
export const EPOCH_ECI_URL = 'https://epoch.ai/data/eci_scores.csv'
export const LLM_LEADERBOARD = 'https://llmleaderboard.com'
export const ARTIFICIAL_ANALYSIS_URL = 'https://artificialanalysis.ai/leaderboards/models'
/**
 * Yuan per US dollar, for sources that quote prices in USD.
 *
 * The catalog stores prices in the currency of the provider that bills for the
 * models (CNY for the Bailian deployments this profile uses), so a USD source
 * has to be converted at one stated rate instead of silently mixing units.
 */
export const CNY_PER_USD = 7.2
/** How many per-model AA pages one refresh may fetch (only for unmeasured ids). */
const MAX_MODEL_PAGES = 60
export const LLM_COMPARISON_URL = `${LLM_LEADERBOARD}/api/models/comparison.csv`
/**
 * Benchmark pages to read. Each board is server-rendered as table rows carrying
 * `data-benchmark-model` and `data-score`, and a page can hold several tracks
 * (the same benchmark evaluated by different harnesses); the third element names
 * the track kept, so the number always means the same thing refresh to refresh.
 *
 * Its JSON API only serves `hle` and a top-5 `highlights` board, so the pages are
 * the only complete route to the rest.
 */
export const LLM_BENCHMARK_PAGES = [
  ['terminal-bench', 'agentic', 'terminal-bench-4-0'],
  ['livebench-agentic', 'agentic', 'livebench-2-agentic'],
  ['deepswe', 'coding', 'deepswe-v1-1'],
  ['livebench-coding', 'coding', 'livebench-2-coding'],
  ['gpqa-diamond', 'knowledge', 'gpqa-diamond-aa'],
  ['gdp-pdf', 'knowledge', 'gdp-pdf-aa'],
  ['livebench-reasoning', 'reasoning', 'livebench-2-reasoning'],
]

/** Benchmark board tables, and the prefix their columns carry in the catalog. */
const BENCH_TABLES = [
  ['KnowledgeWorkTable', 'KnowledgeWork'],
  ['ProgrammingTable', 'Programming'],
  ['ScienceTable', 'Science'],
  ['GeneralTable', 'General'],
]

const round1 = (value) => Math.round(value * 10) / 10

/** CompassRank key -> catalog id, inverted for lookups by catalog id. */
const COMPASS_ID_REVERSE = Object.fromEntries(Object.entries(COMPASS_ID).map(([key, id]) => [id, key]))

/**
 * Fetch one JSON document, inflating it when the CDN serves gzip bytes without
 * saying so.
 *
 * @param {string} url
 * @param {{fetchImpl?: Function, signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    let text = null
    // 0x1f 0x8b is the gzip magic; the CDN omits the encoding header.
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      try {
        text = zlib.gunzipSync(buffer).toString('utf8')
      } catch {
        text = null
      }
    }
    if (text === null) text = buffer.toString('utf8')
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', forwardAbort)
  }
}

/**
 * Fetch a text document (CSV) with the same gzip tolerance as `fetchJson`.
 *
 * @param {string} url
 * @param {{fetchImpl?: Function, signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function fetchText(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const gzipped = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
    if (!gzipped) return buffer.toString('utf8')
    try {
      return zlib.gunzipSync(buffer).toString('utf8')
    } catch {
      return buffer.toString('utf8')
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener?.('abort', forwardAbort)
  }
}

/**
 * Compile the two CompassRank boards into the catalog's cross-check shape.
 *
 * @param {object} ability - `data-lm-ability_official.json`
 * @param {object} bench - `data-lm-ability_benchmark.json`
 * @returns {Record<string, {name: string, released: string|null, ability: object, bench: object}>}
 */
export function extractCompass(ability, bench) {
  const out = {}
  for (const row of ability?.OverallTable ?? []) {
    const key = row?.key
    if (typeof key !== 'string' || key.length === 0) continue
    const abilities = {}
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'number' && Number.isFinite(value)) abilities[column] = value
    }
    out[key] = {
      name: row.model ?? key,
      org: row.org ?? null,
      released: row.release_date ?? null,
      ability: abilities,
      bench: {},
    }
  }
  for (const [table, prefix] of BENCH_TABLES) {
    for (const row of bench?.[table] ?? []) {
      const key = row?.key
      if (typeof key !== 'string' || out[key] === undefined) continue
      for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        if (column.endsWith('TokenCost') || column === 'rank_change') continue
        out[key].bench[`${prefix}.${column}`] = value
      }
    }
  }
  return out
}

/**
 * Reduce one BenchGecko model document to the extraction shape the compiler
 * expects: its normalized average, per-category means, and the raw benchmark
 * table (kept so the UI can show what fed a score).
 *
 * @param {object} raw - response from `/api/v1/models/<slug>`
 */
export function extractBenchGecko(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const byCategory = {}
  const benchmarks = {}
  for (const score of raw.scores ?? []) {
    if (typeof score?.score !== 'number' || !Number.isFinite(score.score)) continue
    if (typeof score.category === 'string' && score.category.length > 0) {
      ;(byCategory[score.category] ??= []).push(score.score)
    }
    if (typeof score.benchmark === 'string') benchmarks[score.benchmark] = round1(score.score)
  }
  const scores = {}
  for (const [category, values] of Object.entries(byCategory)) {
    scores[category] = round1(values.reduce((sum, value) => sum + value, 0) / values.length)
  }
  const avg = typeof raw.avg_score === 'number' && raw.avg_score > 0 ? raw.avg_score : null
  return {
    slug: String(raw.slug ?? ''),
    name: String(raw.name ?? raw.slug ?? ''),
    context: typeof raw.context_window === 'number' ? raw.context_window : null,
    type: typeof raw.model_type === 'string' ? raw.model_type : null,
    openSource: raw.is_open_source === true,
    status: typeof raw.status === 'string' ? raw.status : null,
    released: typeof raw.release_date === 'string' ? raw.release_date : null,
    avg,
    benchgeckoRank: typeof raw.benchgecko_score?.rank === 'number' ? raw.benchgecko_score.rank : null,
    of: typeof raw.benchgecko_score?.of === 'number' ? raw.benchgecko_score.of : null,
    scores,
    benchmarks,
  }
}

/** Sample counts per slug and category, so evidence stays interpretable. */
export function countsOf(extractions, raws) {
  const counts = {}
  for (const [id, extraction] of Object.entries(extractions)) {
    const raw = raws[id]
    if (extraction?.slug === undefined || raw === undefined) continue
    const tally = {}
    for (const score of raw.scores ?? []) {
      if (typeof score?.category !== 'string' || typeof score?.score !== 'number') continue
      tally[score.category] = (tally[score.category] ?? 0) + 1
    }
    counts[extraction.slug] = tally
  }
  return counts
}

/** The BenchGecko slug recorded in an entry's `sources`, if any. */
export function slugOf(entry) {
  for (const source of entry?.sources ?? []) {
    const match = /^https:\/\/benchgecko\.ai\/model\/([^/?#]+)$/.exec(String(source))
    if (match !== null) return decodeURIComponent(match[1])
  }
  return null
}

/**
 * Fetch both sources, then compile a fresh catalog.
 *
 * Failures are collected rather than thrown: one unreachable source must not
 * discard the other. If *both* sources fail the result says so and the caller
 * keeps the current catalog.
 *
 * @param {object} input
 * @param {Record<string, object>} input.base - current catalog
 * @param {Function} [input.fetchImpl]
 * @param {AbortSignal} [input.signal]
 * @param {Date} [input.now]
 */
export async function refreshCatalog({ base, wanted = [], fetchImpl = fetch, signal, now = new Date() }) {
  const errors = []
  let ability = null
  let bench = null
  try {
    ability = await fetchJson(COMPASS_ABILITY_URL, { fetchImpl, signal })
  } catch (error) {
    errors.push(`compass ability: ${String(error?.message ?? error)}`)
  }
  try {
    bench = await fetchJson(COMPASS_BENCH_URL, { fetchImpl, signal })
  } catch (error) {
    errors.push(`compass benchmark: ${String(error?.message ?? error)}`)
  }

  const compass = ability === null ? {} : extractCompass(ability, bench)

  const extractions = {}
  const raws = {}
  const slugs = new Map()
  for (const [id, entry] of Object.entries(base)) {
    const slug = slugOf(entry)
    if (slug !== null) slugs.set(id, slug)
  }
  for (const [id, slug] of slugs) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    try {
      const raw = await fetchJson(BENCHGECKO_MODEL_URL(slug), { fetchImpl, signal })
      const extraction = extractBenchGecko(raw)
      if (extraction !== null) {
        extractions[id] = extraction
        raws[id] = raw
      }
    } catch (error) {
      errors.push(`benchgecko ${slug}: ${String(error?.message ?? error)}`)
    }
  }


  // Two more passes, both independent of the first two: Epoch's fitted index
  // and llmleaderboard's measured serving data plus its benchmark boards.
  const index = nameIndex(base)
  let epoch = {}
  let llm = {}
  try {
    const csv = await fetchText(EPOCH_ECI_URL, { fetchImpl, signal })
    epoch = extractEpochEci(csv, index)
  } catch (error) {
    errors.push(`epoch eci: ${String(error?.message ?? error)}`)
  }
  try {
    const comparison = await fetchText(LLM_COMPARISON_URL, { fetchImpl, signal })
    llm = extractLlmComparison(comparison, index)
  } catch (error) {
    errors.push(`llmleaderboard comparison: ${String(error?.message ?? error)}`)
  }
  const boards = []
  for (const [page, dimension, track] of LLM_BENCHMARK_PAGES) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    try {
      const html = await fetchText(`${LLM_LEADERBOARD}/benchmarks/${page}`, { fetchImpl, signal })
      boards.push({ page, dimension, track, scores: extractLlmBenchmarkPage(html, track, index) })
    } catch (error) {
      errors.push(`llmleaderboard ${page}: ${String(error?.message ?? error)}`)
    }
  }
  for (const board of boards) {
    for (const [id, score] of Object.entries(board.scores)) {
      const entry = (llm[id] ??= {})
      const scores = (entry.scores ??= {})
      scores[board.track] = score
    }
  }

  let analysis = {}
  try {
    const html = await fetchText(ARTIFICIAL_ANALYSIS_URL, { fetchImpl, signal })
    analysis = extractArtificialAnalysis(html, index)
  } catch (error) {
    errors.push(`artificialanalysis: ${String(error?.message ?? error)}`)
  }

  // Second pass: models the comparison table dropped still have a page with their
  // benchmark scores. Only unmeasured ids are fetched, so this costs a few dozen
  // requests on a refresh, not one per model in the catalog.
  const pageBudget = { left: MAX_MODEL_PAGES }
  const missingIds = []
  for (const raw of wanted) {
    const id = typeof raw === 'string' ? raw : raw?.model
    if (typeof id !== 'string' || id.length === 0) continue
    const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
    const keys = [normalizeName(id), normalizeName(bare), normalizeName(bare.replace(/^cmaas-/i, ''))]
    if (matchAnalysisRow(keys, analysis.byName) !== undefined) continue
    if (Number(base[id]?.quality) > 0) continue
    missingIds.push({ id, bare })
  }
  let pagesFetched = 0
  for (const { id, bare } of missingIds) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    if (pageBudget.left <= 0) break
    for (const slug of aaSlugCandidates(id).slice(0, 2)) {
      if (pageBudget.left <= 0) break
      try {
        const html = await fetchText(`${ARTIFICIAL_ANALYSIS_URL.replace('/leaderboards/models', '')}/models/${slug}`, { fetchImpl, signal })
        pageBudget.left -= 1
        pagesFetched += 1
        const found = extractArtificialAnalysisModelPage(html, index)
        for (const [key, value] of Object.entries(found)) {
          if (key.startsWith('\u0000page:')) analysis.byName.set(key.slice('\u0000page:'.length), value)
          else analysis.byId[key] = value
        }
        if (matchAnalysisRow([normalizeName(id), normalizeName(bare)], analysis.byName) !== undefined) break
      } catch {
        // a 404 slug is normal: AA names do not follow one rule
      }
    }
  }
  analysis.pagesFetched = pagesFetched

  const dataset = buildDataset({
    base,
    benchgecko: extractions,
    compass,
    counts: countsOf(extractions, raws),
  })
  const attached = attachCrossChecks(dataset, { epoch, llm })
  const artificialAnalysis = attachArtificialAnalysis(dataset, { base, analysis, wanted, now })
  // Real usage: OpenRouter's weekly ranking. Popularity is not capability, but at
  // equal measured quality it says which model is battle-tested in production.
  let openrouter = { matched: 0, rows: 0 }
  try {
    const usage = await fetchOpenRouterUsage({ fetchImpl, signal })
    openrouter = attachUsage(dataset, usage)
  } catch (error) {
    errors.push(`openrouter usage: ${String(error?.message ?? error)}`)
  }

  // Phase 1 of the data-utilisation design: rank the whole catalog and record the
  // result per entry. Nothing routes on it yet -- the decision log shows the diff.
  const ranked = attachRanking(dataset)
  const derived = derivedRouteEnvelopes(ranked.table)

  return {
    dataset,
    derived: derived.valid === true ? derived.envelopes : null,
    summary: {
      checkedAt: now.toISOString().slice(0, 10),
      models: Object.keys(dataset).length,
      benchgecko: Object.values(extractions).filter((entry) => typeof entry.avg === 'number' && entry.avg > 0).length,
      // Count what actually landed in the catalog, not what was fetched: a
      // leaderboard row for a model outside the alignment map changes nothing.
      compass: Object.values(dataset).filter((entry) => entry?.crossChecks?.compassRank !== undefined).length,
      epoch: attached.epoch,
      llmLeaderboard: attached.llmLeaderboard,
      artificialAnalysis,
      ranking: ranked.summary,
      envelopes: derived.valid === true ? { sample: derived.sample, ...derived.envelopes } : { valid: false, reason: derived.reason ?? 'not enough measured models' },
      openrouter,
      sources: [COMPASS_ABILITY_URL, COMPASS_BENCH_URL, 'https://benchgecko.ai', EPOCH_ECI_URL, LLM_LEADERBOARD, ARTIFICIAL_ANALYSIS_URL],
      errors,
    },
  }
}

/**
 * Tier envelopes derived from the measured catalog.
 *
 * `rank.derivedEnvelopes` states its cost cut-off as a percentile of the pool;
 * the selector compares a cost *index*. Both are 0-100 but they are different
 * axes, so each percentile is translated into the cost index at that quantile --
 * otherwise "the cheapest 40%" would be compared against a price scale.
 *
 * @param {object} table - result of `rankTable`
 * @returns {{valid: boolean, reason?: string, sample?: number, envelopes?: object}}
 */
export function derivedRouteEnvelopes(table) {
  const derived = rankDerivedEnvelopes(table)
  if (derived.valid !== true) return { valid: false, reason: derived.reason, sample: derived.sample ?? 0 }
  const measured = table.models.filter((row) => row.measured === true && Number.isFinite(row.features?.price?.blended))
  const costs = measured.map((row) => costIndex({ price: { input: row.features.price.blended, output: row.features.price.blended } })).sort((a, b) => a - b)
  if (costs.length === 0) return { valid: false, reason: 'no priced measured models', sample: 0 }
  const costAt = (percentile) => {
    const position = Math.min(costs.length - 1, Math.max(0, Math.round(((percentile / 100) * (costs.length - 1)))))
    return costs[position]
  }
  const envelopes = {}
  for (const tier of ['fast', 'balanced', 'deep']) {
    const source = derived.envelopes[tier]
    envelopes[tier] = {
      maxCost: costAt(source.maxCost),
      minQuality: source.minQuality,
      maxLatency: source.maxLatency,
      derived: true,
    }
  }
  return { valid: true, sample: costs.length, envelopes }
}

/**
 * Combine operator envelopes with derived ones.
 *
 * `explicit` trusts the operator only, `merge` fills fields the operator left out
 * (a hand-set ceiling always wins), `derived` takes the data's cut-offs and keeps
 * only the operator's latency class, which is a policy choice rather than a
 * measurement.
 *
 * @param {Record<string, {envelope?: object}>} routes
 * @param {Record<string, object>|null} derived
 * @param {'explicit'|'merge'|'derived'} mode
 * @returns {Record<string, {envelope?: object}>}
 */
export function mergeEnvelopes(routes, derived, mode = 'merge') {
  if (mode === 'explicit' || derived === null || derived === undefined) return routes
  const out = {}
  for (const [id, route] of Object.entries(routes ?? {})) {
    const base = route?.envelope ?? {}
    const data = derived[id]
    if (data === undefined) {
      out[id] = route
      continue
    }
    const envelope = mode === 'derived'
      ? { maxCost: data.maxCost, minQuality: data.minQuality, maxLatency: base.maxLatency ?? data.maxLatency }
      : {
          maxCost: base.maxCost ?? data.maxCost,
          minQuality: base.minQuality ?? data.minQuality,
          maxLatency: base.maxLatency ?? data.maxLatency,
          ...(data.source === undefined ? {} : { source: data.source }),
          ...(data.sample === undefined ? {} : { sample: data.sample }),
        }
    out[id] = { ...route, envelope }
  }
  return out
}

/**
 * Match OpenRouter's weekly usage rows onto the catalog and record the rank.
 *
 * A usage row is `author/model`. The catalog id may be that, or the bare model
 * with the author implied by its provider, so identity is checked by normalized
 * id and by model stem -- the same discipline that keeps a fuzzy name from
 * relabelling a different model.
 *
 * @param {Record<string, object>} dataset
 * @param {Array<{id: string, weeklyRank: number, weeklyTokens?: number, weeklyShare?: number}>} usage
 * @returns {{rows: number, matched: number}}
 */
export function attachUsage(dataset, usage) {
  const entries = Object.entries(dataset ?? {})
  const exact = new Map()
  const byStem = new Map()
  for (const [key] of entries) {
    const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key
    for (const candidate of new Set([normalizeName(key), normalizeName(bare)])) exact.set(candidate, (exact.get(candidate) ?? []).concat(key))
    const stem = modelStem(bare)
    if (stem.length >= 4) byStem.set(stem, (byStem.get(stem) ?? []).concat(key))
  }

  const matches = []
  for (const row of Array.isArray(usage) ? usage : []) {
    const id = String(row?.id ?? '')
    if (id.length === 0 || !Number.isFinite(row?.weeklyRank)) continue
    const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
    // Prefer an exact id: a reseller copy of the same model should not steal the
    // rank from the canonical entry, and the stem fallback would attach to both.
    const exactKeys = exact.get(normalizeName(id)) ?? exact.get(normalizeName(bare)) ?? []
    const keys = exactKeys.length > 0 ? exactKeys : byStem.get(modelStem(bare)) ?? []
    for (const key of new Set(keys)) matches.push({ key, row })
  }
  if (matches.length === 0) return { rows: Array.isArray(usage) ? usage.length : 0, matched: 0, uniqueRanks: 0 }

  // Percentile from unique ranks: several catalog entries can be one OpenRouter
  // model (same id through different providers), and counting the duplicates
  // spread the percentiles over a list that was not the ranking.
  const ranks = [...new Set(matches.map(({ row }) => row.weeklyRank))].sort((a, b) => a - b)
  const percentileOf = (rank) => {
    const position = ranks.indexOf(rank)
    return ranks.length <= 1 ? 100 : Math.round((1 - position / (ranks.length - 1)) * 1000) / 10
  }
  for (const { key, row } of matches) {
    dataset[key] = {
      ...dataset[key],
      usage: {
        source: 'openrouter-top-weekly',
        rank: row.weeklyRank,
        ...(row.weeklyTokens === undefined ? {} : { tokens: Math.round(row.weeklyTokens) }),
        ...(row.weeklyShare === undefined ? {} : { share: Math.round(row.weeklyShare * 10000) / 10000 }),
        percentile: percentileOf(row.weeklyRank),
      },
    }
  }
  return { rows: Array.isArray(usage) ? usage.length : 0, matched: matches.length, uniqueRanks: ranks.length }
}

/**
 * Rank every model across all sources and record the result on the entry.
 *
 * The ranking engine works on a whole catalog at once because its channels are
 * calibrated against each other; the compact result it leaves on each entry is
 * what the selector and the board read: status, composite with its uncertainty
 * band, rank, and the per-dimension estimates with their evidence counts.
 *
 * @param {Record<string, object>} dataset
 * @param {object} [options] - passed to `rankTable`
 * @returns {{ table: object, summary: object }}
 */
export function attachRanking(dataset, options = {}) {
  const table = rankTable(dataset, options)
  const dims = ['coding', 'reasoning', 'math', 'knowledge', 'agentic', 'longContext', 'vision', 'speed', 'overall']
  const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null)
  for (const row of table.models) {
    const entry = dataset[row.key]
    if (entry === null || typeof entry !== 'object') continue
    const compact = {}
    for (const dim of dims) {
      const value = row.dims?.[dim]
      if (value === undefined || value === null) continue
      const estimate = round(value.estimate ?? value.value)
      if (estimate === null) continue
      compact[dim] = {
        value: estimate,
        evidence: Number.isInteger(value.evidence) ? value.evidence : Number(value.evidence) || 0,
        ...(value.derived === true ? { derived: true } : {}),
      }
    }
    entry.ranking = {
      status: row.status,
      composite: round(row.composite),
      low: round(row.compositeLow ?? null),
      rank: Number.isInteger(row.rank) ? row.rank : null,
      dims: compact,
    }
  }
  const top = table.models
    .filter((row) => Number.isInteger(row.rank) && row.rank <= 5)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => ({ key: row.key, rank: row.rank, composite: round(row.composite) }))
  return {
    table,
    summary: {
      measured: table.measured.length,
      provisional: table.provisional.length,
      unmeasured: table.unmeasured.length,
      calibratedChannels: table.coverage?.channels ?? null,
      uncalibratedObservations: table.coverage?.uncalibratedObservations ?? 0,
      unknownBenchmarks: (table.unknownBenchmarks ?? []).length,
      top,
    },
  }
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += char
      continue
    }
    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') field += char
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Compare model names across sources: case, spacing and punctuation differ. */
export const normalizeName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Extra spellings a source uses for a catalog model, keyed by catalog id. */
const NAME_ALIASES = {
  'qwen3.8-max': ['Qwen3.8 Max (0902)'],
  'qwen4-max': ['Qwen 4 Max', 'Qwen4 Max'],
  'qwen4-max-preview': ['Qwen 4 Max Preview'],
  'deepseek-v4-flash-0731': ['DeepSeek V4 Flash 0731'],
  'kimi-k3': ['Kimi K3'],
  'glm-5.3': ['GLM-5.3'],
  'glm-5.2': ['GLM-5.2'],
}

/**
 * Index one catalog's labels (and known aliases) by normalized name.
 *
 * @param {Record<string, object>} base
 * @returns {Map<string, string>} normalized name -> catalog id
 */
export function nameIndex(base) {
  const index = new Map()
  for (const [id, entry] of Object.entries(base)) {
    index.set(normalizeName(entry?.label ?? id), id)
    index.set(normalizeName(id), id)
    for (const alias of NAME_ALIASES[id] ?? []) index.set(normalizeName(alias), id)
  }
  return index
}

/** Decode every `self.__next_f.push([1, "…"])` string in a Next.js RSC page. */
export function decodeFlightChunks(html) {
  const marker = 'self.__next_f.push([1,'
  const chunks = []
  let start = 0
  for (;;) {
    const at = String(html ?? '').indexOf(marker, start)
    if (at < 0) break
    let index = at + marker.length
    if (html[index] !== '"') {
      start = index
      continue
    }
    const begin = index
    index += 1
    let escaped = false
    for (; index < html.length; index += 1) {
      const char = html[index]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    try {
      chunks.push(JSON.parse(html.slice(begin, index + 1)))
    } catch {
      // not a plain string literal: no table rows inside
    }
    start = index + 1
  }
  return chunks
}

/**
 * Words that distinguish a variant from a different model: AA ships one row per
 * reasoning effort, serving mode, or reseller, and all of them describe the same
 * catalog model. A name difference made only of these is not a different model.
 */
const VARIANT_WORDS = new Set([
  'max', 'high', 'low', 'medium', 'min', 'mini', 'thinking', 'nonreasoning', 'reasoning',
  // Speed tiers and lightweight variants: the same weights, a different serving
  // offer. They are only ignored when the base model name already lines up.
  'flash', 'flashlite', 'turbo', 'air', 'speed', 'lite', 'next',
  'default', 'fallback', 'preview', 'prime', 'highspeed', 'ultraspeed', 'vision', 'flashx',
  'reasoningmedium', 'reasoninglow', 'reasoninghigh', 'cmaas', 'based', 'on', 'instruct',
])

/** Split a normalized name into its leading model tokens and variant tokens. */
export function splitVariant(normalized) {
  let index = normalized.length
  for (;;) {
    const digits = /(\d+)$/.exec(normalized.slice(0, index))
    if (digits !== null) {
      const head = normalized.slice(0, index - digits[1].length)
      // Version numbers ("3.8" -> 38, "122B" -> 122) are part of the name; four
      // or more digits are a date or a parameter count bolted on as a variant.
      if (digits[1].length >= 4) {
        index = head.length
        continue
      }
      break
    }
    const word = /([a-z]+)$/.exec(normalized.slice(0, index))
    if (word !== null && VARIANT_WORDS.has(word[1])) {
      index = normalized.slice(0, index).length - word[1].length
      continue
    }
    break
  }
  return { model: normalized.slice(0, index), variant: normalized.slice(index) }
}

/**
 * Model stem without its suffix tokens, computed from the original separators.
 *
 * `splitVariant` works on a punctuation-stripped string, where a version and a
 * release date become one digit run (`deepseekv3` + `0324` -> `deepseekv30324`)
 * and both get stripped together, leaving `deepseekv`. Identity checks need the
 * separators, so this walks the original tokens.
 *
 * @param {string} text
 * @returns {string}
 */
export function modelStem(text) {
  const tokens = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (/^\d{4,8}$/.test(last) || VARIANT_WORDS.has(last)) {
      tokens.pop()
      continue
    }
    break
  }
  return tokens.join('')
}

/**
 * Find the analysis row for one advertised id.
 *
 * Tries exact keys first, then a model-name prefix whose remainder is only
 * variants. When several rows qualify (AA has one per reasoning effort) the row
 * with the highest intelligence index wins: the variant that was actually
 * evaluated is the one worth recording.
 */
export function matchAnalysisRow(keys, byName) {
  for (const key of keys) {
    const exact = byName.get(key)
    if (exact !== undefined) return exact
  }
  // Four characters is the shortest useful stem ("glm5", "kimi"); shorter than
  // that a prefix match would join unrelated models.
  const wanted = keys.map((key) => splitVariant(key)).filter(({ model }) => model.length >= 4)
  let best = null
  for (const [name, row] of byName) {
    const { model } = splitVariant(name)
    for (const candidate of wanted) {
      const shares = model === candidate.model || model.startsWith(candidate.model) || candidate.model.startsWith(model)
      if (!shares) continue
      const extra = model.length > candidate.model.length ? model.slice(candidate.model.length) : candidate.model.slice(model.length)
      const extraOk = extra.length === 0 || VARIANT_WORDS.has(extra) || /^\d{1,2}$/.test(extra) || /-\d{4}-\d{2}-\d{2}$/.test(extra)
      if (!extraOk) continue
      const score = (Number.isFinite(row.intelligenceIndex) ? row.intelligenceIndex : 0) + (Number.isFinite(row.priceIn) ? 1 : 0)
      if (best === null || score > best.score) best = { row, score }
    }
  }
  return best === null ? undefined : best.row
}

/** Read one balanced `{…}` object at an offset, tolerating NaN/Infinity literals. */
function readJsonObjectAt(text, at) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = at; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(at, index + 1).replace(/\b(NaN|Infinity|-Infinity)\b/g, 'null'))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const isArtificialAnalysisRow = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  ('price1mInputTokens' in value || 'intelligenceIndex' in value || 'scores' in value)

/**
 * Artificial Analysis' public model table.
 *
 * The page is Next.js and ships its rows inside the RSC flight stream, so the
 * table is readable without a browser — which is what makes it usable from the
 * plugin at run time: a headless browser cannot run inside the host.
 *
 * Rows are matched to the catalog by name, tolerant of the qualifiers AA adds
 * ("(Non-reasoning)", "(Medium, Default Fallback)").
 *
 * @param {string} html
 * @param {Map<string, string>} index - normalized name -> catalog id
 */
export function extractArtificialAnalysis(html, index) {
  const rows = new Map()
  for (const text of decodeFlightChunks(html)) {
    let at = text.indexOf('{"id":"')
    while (at >= 0) {
      const row = readJsonObjectAt(text, at)
      if (isArtificialAnalysisRow(row)) {
        const key = typeof row.id === 'string' && row.id.length > 0 ? row.id : String(row.name)
        rows.set(key, { ...(rows.get(key) ?? {}), ...row })
      }
      at = text.indexOf('{"id":"', at + 1)
    }
  }

  const out = {}
  const byName = new Map()
  const claim = (name) => {
    const plain = normalizeName(name)
    if (index.has(plain)) return index.get(plain)
    // Drop AA's qualifier parenthesis, then trailing variant words.
    const stripped = normalizeName(String(name).replace(/\([^)]*\)/g, ' '))
    if (index.has(stripped)) return index.get(stripped)
    const trimmed = stripped.replace(/(non)?reasoning$/, '')
    if (index.has(trimmed)) return index.get(trimmed)
    // Longest catalog key that prefixes the source name (dated ids, "-preview").
    let best = null
    for (const [key, id] of index) {
      if (key.length >= 6 && trimmed.startsWith(key) && (best === null || key.length > best.length)) best = key
    }
    return best === null ? undefined : index.get(best)
  }

  for (const row of rows.values()) {
    const value = { source: ARTIFICIAL_ANALYSIS_URL }
    const index0 = Number(row.intelligenceIndex)
    // AA leaves the field null for unranked models and, in some payloads, zero;
    // zero is not a score -- the fit turned it into a floor every such model shared.
    if (Number.isFinite(index0) && index0 > 0) value.intelligenceIndex = round1(index0)
    const priceIn = Number(row.price1mInputTokens)
    const priceOut = Number(row.price1mOutputTokens)
    if (Number.isFinite(priceIn)) value.priceIn = priceIn
    if (Number.isFinite(priceOut)) value.priceOut = priceOut
    const ttft = Number(row.timeToFirstToken)
    if (Number.isFinite(ttft)) value.ttft = ttft
    const speed = Number(row.outputSpeed)
    if (Number.isFinite(speed)) value.speed = speed
    const context = Number(row.contextWindowTokens)
    if (Number.isFinite(context)) value.contextTokens = context
    // AA mixes scales in one `scores` map: percentages (0-1), Elo ratings
    // (aa-3d, aa-briefcase, code2video) and raw normalised scores
    // (gdpval-aa-normalized, -402..1866). Only percentages are comparable, so the
    // engine gets those; everything is retained as published in `rawScores` so a
    // later consumer can use a scale we have not decided how to read yet.
    const scores = {}
    const rawScores = {}
    for (const [benchmark, raw] of Object.entries(row.scores ?? {})) {
      const number = Number(raw)
      if (!Number.isFinite(number)) continue
      rawScores[benchmark] = number
      if (number > 0 && number <= 1) scores[benchmark] = Math.round(number * 1000) / 10
    }
    if (Object.keys(scores).length > 0) value.benchmarks = scores
    if (Object.keys(rawScores).length > 0) value.rawScores = rawScores
    for (const [field, key] of [
      ['contextWindowTokens', 'contextTokens'],
      ['isReasoning', 'reasoning'],
      ['isOpenWeights', 'openWeights'],
      ['cacheHitPrice', 'cacheHitPrice'],
      ['omniscienceAccuracy', 'omniscienceAccuracy'],
      ['omniscienceHallucinationRate', 'omniscienceHallucination'],
    ]) {
      if (row[field] !== undefined && row[field] !== null) value[key] = row[field]
    }
    const releaseDate = typeof row.releaseDate === 'string' ? row.releaseDate : row.release?.releaseDate
    if (typeof releaseDate === 'string') value.releaseDate = releaseDate
    if (typeof row.modelCreatorName === 'string') value.creator = row.modelCreatorName
    if (!(Number.isFinite(value.intelligenceIndex) || Object.keys(scores).length > 0 || Number.isFinite(priceIn))) continue
    value.name = row.name
    byName.set(normalizeName(row.name), value)
    byName.set(normalizeName(String(row.name).replace(/\([^)]*\)/g, ' ')), value)
    const id = claim(row.name)
    if (id !== undefined) out[id] = value
  }
  return { byId: out, byName }
}

/** Benchmark-ish fields AA exposes per model page, as 0-1 fractions. */
const MODEL_PAGE_BENCHMARKS = [
  'gpqa', 'hle', 'terminalbenchHard', 'terminalBench21', 'terminalBench40', 'terminalBenchScience',
  'livecodebench', 'scicode', 'tau2', 'itBenchSre', 'tauBanking', 'mmmuPro', 'aime25',
  'critpt', 'analystAgent', 'automationBenchPartialScore', 'frontierCode', 'frontierCode20',
  'ifbench', 'mkaClimbWsr', 'vialsScore', 'healthbench', 'gdpval', 'omniscienceAccuracy',
]

/**
 * Slugs to try for a model's own AA page.
 *
 * AA keeps a page per model even when it drops the model from the comparison
 * table, and that page carries the benchmark scores -- which is where GLM-5.1 and
 * MiniMax-M2.7 live today.
 *
 * @param {string} id - catalog model id, possibly provider- or reseller-prefixed
 * @returns {string[]}
 */
export function aaSlugCandidates(id) {
  let bare = String(id ?? '')
  const slash = bare.lastIndexOf('/')
  if (slash >= 0) bare = bare.slice(slash + 1)
  bare = bare.replace(/^cmaas-/i, '').toLowerCase()
  const dotted = bare.replace(/[^a-z0-9.]+/g, '-').replace(/\./g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const flat = bare.replace(/[^a-z0-9]+/g, '')
  const undotted = flat.replace(/^([a-z]+)(\d)(\d+)/, '$1-$2-$3')
  return [...new Set([dotted, flat, undotted])].filter((slug) => slug.length > 0)
}

/** Read the benchmark scores out of one AA model page. */
export function extractArtificialAnalysisModelPage(html, index) {
  const out = {}
  for (const text of decodeFlightChunks(html)) {
    let at = text.indexOf('{"id":"')
    while (at >= 0) {
      const row = readJsonObjectAt(text, at)
      if (row !== null && typeof row.name === 'string') {
        const scores = {}
        for (const key of MODEL_PAGE_BENCHMARKS) {
          const value = Number(row[key])
          if (Number.isFinite(value) && value >= 0 && value <= 1) scores[key] = Math.round(value * 1000) / 10
        }
        if (Object.keys(scores).length >= 4) {
          const value = { source: ARTIFICIAL_ANALYSIS_URL, name: row.name, benchmarks: scores }
          const priceIn = Number(row.price1mInputTokens)
          const priceOut = Number(row.price1mOutputTokens)
          if (Number.isFinite(priceIn)) value.priceIn = priceIn
          if (Number.isFinite(priceOut)) value.priceOut = priceOut
          const ttft = Number(row.timeToFirstToken)
          if (Number.isFinite(ttft)) value.ttft = ttft
          const idFromIndex = index.get(normalizeName(row.name))
          if (idFromIndex !== undefined) out[idFromIndex] = value
          out[`\u0000page:${normalizeName(row.name)}`] = value
        }
      }
      at = text.indexOf('{"id":"', at + 1)
    }
  }
  return out
}

/**
 * Fold Artificial Analysis into the catalog.
 *
 * Two rules keep this honest: it fills what the catalog is missing (quality,
 * price, latency) and never overwrites a measured value that a primary source
 * supplied; and its intelligence index is mapped through a fit to the models
 * both sources know, because AA's index is its own scale, not a 0-100 score.
 *
 * @param {Record<string, object>} dataset
 * @param {{base?: Record<string, object>, analysis: Record<string, object>}} input
 */
export function attachArtificialAnalysis(dataset, { base = {}, analysis = {}, wanted = [], now = new Date() } = {}) {
  const byId = analysis.byId ?? {}
  const byName = analysis.byName ?? new Map()
  // Calibrate AA index -> catalog quality on the models measured by both.
  const pairs = []
  for (const [id, value] of Object.entries(byId)) {
    if (!Number.isFinite(value.intelligenceIndex)) continue
    const quality = Number(base[id]?.quality)
    if (Number.isFinite(quality)) pairs.push([value.intelligenceIndex, quality])
  }
  let slope = 1.6
  let intercept = 20
  if (pairs.length >= 5) {
    const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length
    const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length
    let numerator = 0
    let denominator = 0
    for (const [x, y] of pairs) {
      numerator += (x - meanX) * (y - meanY)
      denominator += (x - meanX) ** 2
    }
    if (denominator > 0) {
      slope = numerator / denominator
      intercept = meanY - slope * meanX
    }
  }
  const qualityOf = (value) => Math.max(0, Math.min(100, Math.round((slope * value.intelligenceIndex + intercept) * 10) / 10))

  // Not every model AA ran on benchmarks gets a published intelligence index, but
  // the per-benchmark scores are there. A benchmark mean, calibrated against the
  // rows that have both, is a real measurement of those models rather than a
  // family guess -- 160 rows of the table were being stored and never used.
  const fractionMean = (value) => {
    // A zero is "the benchmark did not run", not "the model scored nothing" -- the
    // same rule the BenchGecko extractor uses. Averaging zeros produced one floor
    // value that seven unrelated models then shared as if it were a measurement.
    const fractions = Object.values(value.benchmarks ?? {}).filter((score) => score > 0 && score <= 100)
    if (fractions.length < 4) return null
    return fractions.reduce((sum, score) => sum + score, 0) / fractions.length
  }
  // Calibrate on every row that has both, not only the rows this catalog matched:
  // the fit is about AA's own scales, and restricting it to our ids throws away
  // most of the evidence.
  const benchPairs = []
  for (const value of new Set(byName.values())) {
    if (!Number.isFinite(value.intelligenceIndex)) continue
    const mean = fractionMean(value)
    if (mean !== null) benchPairs.push([mean, value.intelligenceIndex])
  }
  let benchSlope = 0
  let benchIntercept = 0
  if (benchPairs.length >= 8) {
    const meanX = benchPairs.reduce((sum, [x]) => sum + x, 0) / benchPairs.length
    const meanY = benchPairs.reduce((sum, [, y]) => sum + y, 0) / benchPairs.length
    let numerator = 0
    let denominator = 0
    for (const [x, y] of benchPairs) {
      numerator += (x - meanX) * (y - meanY)
      denominator += (x - meanX) ** 2
    }
    if (denominator > 0) {
      benchSlope = numerator / denominator
      benchIntercept = meanY - benchSlope * meanX
    }
  }
  /** AA quality for one row: its index when published, else its benchmark mean. */
  const analysisQuality = (value) => {
    if (Number.isFinite(value.intelligenceIndex)) return qualityOf(value)
    const mean = fractionMean(value)
    if (mean === null || benchPairs.length < 8) return null
    const index = benchSlope * mean + benchIntercept
    return Math.max(0, Math.min(100, Math.round((slope * index + intercept) * 10) / 10))
  }

  let filledQuality = 0
  let filledPrice = 0
  let filledLatency = 0
  for (const [id, value] of Object.entries(byId)) {
    const entry = dataset[id] ?? dataset[id.toLowerCase()]
    if (entry === undefined) continue
    entry.crossChecks = { ...(entry.crossChecks ?? {}), artificialAnalysis: {
      intelligenceIndex: value.intelligenceIndex ?? null,
      priceIn: value.priceIn ?? null,
      priceOut: value.priceOut ?? null,
      ttft: value.ttft ?? null,
      speed: value.speed ?? null,
      // The per-benchmark percentages are kept: the ranking engine reads them as
      // observations, and dropping them here was why AA barely moved any score.
      ...(value.benchmarks === undefined ? {} : { benchmarks: value.benchmarks }),
      // Everything else AA published, as published. The router does not read these
      // yet, but discarding them loses measurements no other source carries.
      ...(value.rawScores === undefined ? {} : { rawScores: value.rawScores }),
      ...(value.contextTokens === undefined ? {} : { contextTokens: value.contextTokens }),
      ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
      ...(value.openWeights === undefined ? {} : { openWeights: value.openWeights }),
      ...(value.cacheHitPrice === undefined ? {} : { cacheHitPrice: value.cacheHitPrice }),
      ...(value.omniscienceAccuracy === undefined ? {} : { omniscienceAccuracy: value.omniscienceAccuracy }),
      ...(value.omniscienceHallucination === undefined ? {} : { omniscienceHallucination: value.omniscienceHallucination }),
      ...(value.releaseDate === undefined ? {} : { releaseDate: value.releaseDate }),
      ...(value.creator === undefined ? {} : { creator: value.creator }),
      source: ARTIFICIAL_ANALYSIS_URL,
    } }

    const hasQuality = Number.isFinite(Number(entry.quality)) && Number(entry.quality) > 0
    const derived = analysisQuality(value)
    if (!hasQuality && derived !== null) {
      const quality = derived
      entry.quality = quality
      entry.scores = { ...(entry.scores ?? {}), overall: quality }
      entry.evidence = { ...(entry.evidence ?? {}), overall: 0 }
      filledQuality += 1
    }
    const hasPrice = Number.isFinite(Number(entry.price?.input)) && Number(entry.price.input) > 0
    if (!hasPrice && Number.isFinite(value.priceIn)) {
      entry.price = {
        input: round1(value.priceIn * CNY_PER_USD),
        output: round1((value.priceOut ?? value.priceIn) * CNY_PER_USD),
        ...(entry.price?.cacheHitInput === undefined ? {} : { cacheHitInput: entry.price.cacheHitInput }),
      }
      filledPrice += 1
    }
    if (entry.latency === undefined && (Number.isFinite(value.ttft) || Number.isFinite(value.speed))) {
      const ttft = Number.isFinite(value.ttft) ? value.ttft : 99
      const speed = Number.isFinite(value.speed) ? value.speed : 0
      entry.latency = ttft <= 1 && speed >= 100 ? 'fast' : ttft <= 3 ? 'balanced' : 'slow'
      filledLatency += 1
    }
  }
  // Models the provider advertises but the catalog has never described: AA is the
  // only source that knows them, so they get an entry built from its row rather
  // than staying invisible to the router forever.
  let created = 0
  const latencyOf = (value) => {
    const ttft = Number.isFinite(value.ttft) ? value.ttft : 99
    const speed = Number.isFinite(value.speed) ? value.speed : 0
    return ttft <= 1 && speed >= 100 ? 'fast' : ttft <= 3 ? 'balanced' : 'slow'
  }
  for (const raw of wanted) {
    const id = typeof raw === 'string' ? raw : raw?.model
    if (typeof id !== 'string' || id.length === 0) continue
    const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
    const provider = typeof raw?.provider === 'string' ? raw.provider : undefined
    const lookupKeys = [
      normalizeName(id),
      normalizeName(bare),
      normalizeName(bare.replace(/-\d{4}-\d{2}-\d{2}$/, '')),
      normalizeName(bare.replace(/^cmaas-/, '')),
    ]
    const value = matchAnalysisRow(lookupKeys, byName)
    if (value === undefined) continue
    // The match decides the label and the numbers, so the model stems must agree:
    // a name prefix alone joined `siliconflow/deepseek-v3-0324` to a V4.1 row and
    // shipped its label and quality under the wrong id.
    const ourStem = modelStem(bare.replace(/^cmaas-/i, ''))
    const theirStem = modelStem(value.name ?? '')
    if (!theirStem.startsWith(ourStem) && !ourStem.startsWith(theirStem)) continue
    const entryKey = id.toLowerCase()
    const existing = dataset[id] ?? dataset[entryKey]
    if (existing !== undefined) continue
    const quality = analysisQuality(value)
    if (quality === null && !Number.isFinite(value.priceIn)) continue
    const price = Number.isFinite(value.priceIn)
      ? { input: round1(value.priceIn * CNY_PER_USD), output: round1((value.priceOut ?? value.priceIn) * CNY_PER_USD) }
      : undefined
    // Artificial Analysis measures a composite, not per-dimension scores. Every
    // dimension is filled with that composite and evidence 0, so the entry is a
    // complete prior the selector can rank instead of a partial one it would
    // treat as an error; nothing claims a dimension was measured.
    const scores = {}
    const evidence = {}
    for (const dim of DIMENSIONS) {
      scores[dim] = quality ?? 0
      evidence[dim] = 0
    }
    dataset[entryKey] = {
      label: value.name ?? bare,
      ...(provider === undefined ? {} : { provider }),
      contextWindow: Number.isFinite(value.contextTokens) ? value.contextTokens : 0,
      ...(price === undefined ? {} : { price }),
      modalities: ['text'],
      toolCalling: true,
      reasoning: value.reasoning === true,
      latency: latencyOf(value),
      ...(quality === null ? {} : { quality }),
      scores,
      evidence,
      bestFor: [],
      weaknesses: [],
      sources: [ARTIFICIAL_ANALYSIS_URL],
      checkedAt: now.toISOString().slice(0, 10),
      crossChecks: { artificialAnalysis: {
        intelligenceIndex: value.intelligenceIndex ?? null,
        priceIn: value.priceIn ?? null,
        priceOut: value.priceOut ?? null,
        ttft: value.ttft ?? null,
        speed: value.speed ?? null,
        ...(value.benchmarks === undefined ? {} : { benchmarks: value.benchmarks }),
        source: ARTIFICIAL_ANALYSIS_URL,
      } },
    }
    created += 1
  }

  // Every entry leaves here complete: the selector scores all nine dimensions and
  // the knowledge tests require integers for evidence. An AA-only model has no
  // per-dimension measurement, so its dimensions mirror the composite with
  // evidence 0 -- a prior the selector can rank, not a claim it was measured.
  for (const entry of Object.values(dataset)) {
    if (entry === null || typeof entry !== 'object') continue
    const scores = { ...(entry.scores ?? {}) }
    const evidence = { ...(entry.evidence ?? {}) }
    for (const dim of DIMENSIONS) {
      if (!Number.isFinite(Number(scores[dim]))) scores[dim] = Number(entry.quality) > 0 ? Number(entry.quality) : 0
      if (!Number.isInteger(evidence[dim])) evidence[dim] = 0
    }
    entry.scores = scores
    entry.evidence = evidence
  }

  return {
    models: Object.keys(byId).length,
    created,
    filledQuality,
    filledPrice,
    filledLatency,
    calibration: {
      pairs: pairs.length,
      slope: Math.round(slope * 100) / 100,
      intercept: Math.round(intercept * 100) / 100,
      benchmarkPairs: benchPairs.length,
    },
  }
}

/**
 * Epoch Capabilities Index, one row per model with a confidence interval.
 *
 * ECI is an interval scale (roughly 0-175 today) fitted across benchmarks, so it
 * orders models without being comparable to a 0-100 percentage; it is stored as
 * a cross-check, never averaged into the scores.
 *
 * @param {string} csv
 * @param {Map<string, string>} index
 */
export function extractEpochEci(csv, index) {
  const rows = parseCsv(csv)
  const header = rows[0] ?? []
  const column = (name) => header.indexOf(name)
  const nameAt = column('Display name')
  const eciAt = column('eci')
  const dateAt = column('date')
  const out = {}
  for (const row of rows.slice(1)) {
    const name = row[nameAt]
    const id = name === undefined ? undefined : index.get(normalizeName(name))
    if (id === undefined) continue
    const eci = Number(row[eciAt])
    if (!Number.isFinite(eci)) continue
    // One row per model; on duplicates keep the newer evaluation date.
    const previous = out[id]
    const date = row[dateAt] ?? null
    if (previous !== undefined && String(previous.date) > String(date)) continue
    out[id] = { eci: round1(eci), date, source: EPOCH_ECI_URL }
  }
  return out
}

/**
 * llmleaderboard.com: measured serving characteristics plus independent
 * benchmark scores (its `/api/benchmarks/<id>` endpoints).
 *
 * The comparison CSV has one row per provider offering, so a model can appear
 * many times; the row kept is the fastest serving offer, which is the number
 * that matters when comparing models rather than providers.
 *
 * @param {string} csv
 * @param {Map<string, string>} index
 */
export function extractLlmComparison(csv, index) {
  const rows = parseCsv(csv)
  const header = rows[0] ?? []
  const column = (name) => header.indexOf(name)
  const modelAt = column('model')
  const providerAt = column('provider')
  const configAt = column('configuration')
  const ttftAt = column('ttft_seconds')
  const speedAt = column('output_tokens_per_second')
  const out = {}
  for (const row of rows.slice(1)) {
    const id = modelAt === -1 ? undefined : index.get(normalizeName(row[modelAt]))
    if (id === undefined) continue
    const ttft = Number(row[ttftAt])
    const speed = Number(row[speedAt])
    if (!Number.isFinite(speed) || speed <= 0) continue
    const previous = out[id]
    if (previous !== undefined && previous.tokensPerSecond >= speed) continue
    out[id] = {
      provider: row[providerAt] ?? null,
      configuration: row[configAt] ?? null,
      ttftSeconds: Number.isFinite(ttft) && ttft > 0 ? round3(ttft) : null,
      tokensPerSecond: round1(speed),
      source: LLM_COMPARISON_URL,
    }
  }
  return out
}

/**
 * Read one benchmark page's score table.
 *
 * Rows look like
 * `<tr data-benchmark-track="terminal-bench-4-0" data-benchmark-model="qwen4-max" data-score="41.2">`.
 * A model can appear more than once per track (several versions), so the last
 * row wins — pages list the newest report first.
 *
 * @param {string} html
 * @param {string} track - the track id to keep
 * @param {Map<string, string>} index - normalized name -> catalog id
 */
export function extractLlmBenchmarkPage(html, track, index) {
  const out = {}
  if (track === null) return out
  const rowPattern = /<tr data-benchmark-track="([^"]+)" data-benchmark-model="([^"]+)" data-score="([^"]+)"/g
  for (const match of String(html ?? '').matchAll(rowPattern)) {
    if (match[1] !== track) continue
    const id = index.get(normalizeName(match[2]))
    const score = Number(match[3])
    if (id === undefined || !Number.isFinite(score)) continue
    out[id] = round1(score)
  }
  return out
}

const round3 = (value) => Math.round(value * 1000) / 1000

/** Merge the two extra passes into a compiled catalog as cross-checks. */
export function attachCrossChecks(dataset, { epoch, llm }) {
  let epochCount = 0
  let llmCount = 0
  for (const [id, entry] of Object.entries(dataset)) {
    const eci = epoch?.[id]
    const serving = llm?.[id]
    const board = llm?.[id]?.scores
    if (eci === undefined && serving === undefined && board === undefined) continue
    const crossChecks = (entry.crossChecks ??= {})
    if (eci !== undefined) {
      crossChecks.epoch = { eci: eci.eci, date: eci.date, board: 'https://epoch.ai/eci' }
      epochCount += 1
    }
    if (serving !== undefined || board !== undefined) {
      crossChecks.llmLeaderboard = {
        ttftSeconds: serving?.ttftSeconds ?? null,
        tokensPerSecond: serving?.tokensPerSecond ?? null,
        provider: serving?.provider ?? null,
        benchmarks: board ?? {},
        board: LLM_LEADERBOARD,
      }
      llmCount += 1
    }
  }
  return { epoch: epochCount, llmLeaderboard: llmCount }
}
