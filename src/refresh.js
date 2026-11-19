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
import {
  aaSlugCandidates,
  bareId,
  claimAll,
  idsAt,
  idsForName,
  inheritFact,
  labelAgrees,
  labelForId,
  matchAnalysisRow,
  modelStem,
  nameIndexAll,
  normalizeName,
  reconciledLabel,
  sameModelName,
  slugOf,
} from './identity.js'
import { derivedEnvelopes as rankDerivedEnvelopes, rankTable } from './rank.js'
import { costIndex, PRICE_CNY_PER_USD } from './select.js'
import { fetchOpenRouterUsage } from './openrouter.js'
import { DIMENSIONS } from './select.js'

// Identity moved to its own module; the names stay exported here as well because
// the refresh tests and the ranking engine already imported them from this file.
export {
  aaSlugCandidates,
  idsForName,
  matchAnalysisRow,
  modelStem,
  nameIndex,
  nameIndexAll,
  normalizeName,
  slugOf,
  splitVariant,
} from './identity.js'

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
export const CNY_PER_USD = PRICE_CNY_PER_USD
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

/**
 * Artificial Analysis task-type indexes: the industry/domain index pages.
 *
 * Each page publishes one `weightedIndex` per model plus its component
 * `subScores` (`knowledge`, `reasoning`, `longContext`, agentic tool use, …).
 * The index is a composite of six-plus evaluations, so it is stored as an index
 * signal and never blended into a dimension (same rule as the intelligence
 * index). The subScores are domain-conditioned versions of the same evidence and
 * are kept for audit; they are not merged either.
 */
export const AA_TASK_INDEX_PAGES = [
  ['economics', 'economics'], ['engineering', 'engineering'],
  ['finance-and-accounting', 'finance-and-accounting'],
  ['healthcare-and-medical', 'healthcare-and-medical'],
  ['legal', 'legal'], ['strategy-and-ops', 'strategy-and-ops'],
]
export const ARTIFICIAL_ANALYSIS_INDEX_URL = (slug) => `https://artificialanalysis.ai/indexes/${slug}`

/**
 * OpenRouter's own task benchmarks. These are single-benchmark leaderboards that
 * OpenRouter runs itself and reports as the median accuracy across providers, so
 * each one is one benchmark vote for a dimension. The `*-search` boards are
 * deliberately absent: they measure a model+search-engine configuration, not a
 * model, and our catalog cannot name that configuration.
 */
export const OPENROUTER_BENCHMARK_PAGES = [
  ['gpqa-diamond', 'knowledge', 'gpqa'],
  ['tau2-bench-airline', 'agentic', 'tau2'],
  ['vgi-bench', 'vision', 'vgi-bench'],
]
export const OPENROUTER_BENCHMARK_URL = (slug) => `https://openrouter.ai/benchmarks/${slug}`
export const OPENROUTER_TASK_SPEND_URL = 'https://openrouter.ai/api/frontend/v1/rankings/task-spend'

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
    // A zero is "the benchmark did not run", not a score of zero: BenchGecko
    // publishes it for a model it has no sample for. It must not enter a category
    // mean (a math mean read 39.5 instead of 49.3 on one zero), and it is not
    // stored in the leaf map either -- both consumers treat their maps as scores.
    if (score.score <= 0) continue
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
  // The API also publishes the OpenRouter price it checked and its own small
  // test battery. The compiled catalog does not read them, but they are part of
  // the capture the committed `data/benchgecko-extracted.json` records, so the
  // extractor keeps them and the capture stays reproducible.
  const priceUsd = raw.pricing !== null && typeof raw.pricing === 'object'
    ? {
        input: typeof raw.pricing.input === 'number' && Number.isFinite(raw.pricing.input) ? raw.pricing.input : null,
        output: typeof raw.pricing.output === 'number' && Number.isFinite(raw.pricing.output) ? raw.pricing.output : null,
      }
    : undefined
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
    ...(priceUsd === undefined ? {} : { priceUsd }),
    ...(raw.gecko_tests !== null && typeof raw.gecko_tests === 'object' ? { geckoTests: raw.gecko_tests } : {}),
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
      // A zero sample is "not run", so it is not evidence either.
      if (score.score <= 0) continue
      tally[score.category] = (tally[score.category] ?? 0) + 1
    }
    counts[extraction.slug] = tally
  }
  return counts
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
export async function refreshCatalog({
  base,
  wanted = [],
  fetchImpl = fetch,
  signal,
  now = new Date(),
  /**
   * Use the family spellings (release date / effort suffix stripped) for the
   * Artificial Analysis join too, not only for Epoch/llmleaderboard. Off by
   * default: measurement joins should name the model the catalog names. Exposed
   * so the two policies can be built and compared before one is chosen.
   */
  joinFamilyForAnalysis = false,
  /**
   * BenchGecko's per-model API is occasionally slow (25s+ observed); the default
   * 15s cap aborted whole rebuilds. This pass only, so a slow source cannot hold
   * up the others.
   */
  benchgeckoTimeoutMs = 30_000,
} = {}) {
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
      const raw = await fetchJson(BENCHGECKO_MODEL_URL(slug), { fetchImpl, signal, timeoutMs: benchgeckoTimeoutMs })
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
  // Every name-based source pass resolves a row to all catalog ids that name the
  // model; the per-id passes (BenchGecko slugs, CompassRank's table) are unchanged.
  const index = nameIndexAll(base, wanted)
  // The two extra passes source a model by name and need the family spelling of
  // an advertised id (see `nameIndexAll`); the Artificial Analysis join keeps
  // the exact spelling so it does not change the observation set the ranking
  // calibrates on.
  const sourceIndex = nameIndexAll(base, wanted, { family: true })
  let epoch = {}
  let llm = {}
  try {
    const csv = await fetchText(EPOCH_ECI_URL, { fetchImpl, signal })
    epoch = extractEpochEci(csv, sourceIndex, base)
  } catch (error) {
    errors.push(`epoch eci: ${String(error?.message ?? error)}`)
  }
  try {
    const comparison = await fetchText(LLM_COMPARISON_URL, { fetchImpl, signal })
    llm = extractLlmComparison(comparison, sourceIndex, base)
  } catch (error) {
    errors.push(`llmleaderboard comparison: ${String(error?.message ?? error)}`)
  }
  const boards = []
  for (const [page, dimension, track] of LLM_BENCHMARK_PAGES) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    try {
      const html = await fetchText(`${LLM_LEADERBOARD}/benchmarks/${page}`, { fetchImpl, signal })
      boards.push({ page, dimension, track, scores: extractLlmBenchmarkPage(html, track, sourceIndex, base) })
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
    analysis = extractArtificialAnalysis(html, joinFamilyForAnalysis ? sourceIndex : index, base)
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
        const found = extractArtificialAnalysisModelPage(html, joinFamilyForAnalysis ? sourceIndex : index, base)
        for (const [key, value] of Object.entries(found)) {
          // The leaderboard row is the primary record: a page embeds rows for many
          // models, so an unconditional write replaced a table row that carries the
          // published index with the page's index-less copy.
          if (key.startsWith('\u0000page:')) {
            const name = key.slice('\u0000page:'.length)
            if (!analysis.byName.has(name)) analysis.byName.set(name, value)
          } else if (analysis.byId[key] === undefined) {
            analysis.byId[key] = value
          }
        }
        if (matchAnalysisRow([normalizeName(id), normalizeName(bare)], analysis.byName) !== undefined) break
      } catch {
        // a 404 slug is normal: AA names do not follow one rule
      }
    }
  }
  analysis.pagesFetched = pagesFetched

  // Task-type indexes. Artificial Analysis publishes domain indexes (composite
  // per industry) whose weighted value is an index signal; OpenRouter publishes
  // single-benchmark leaderboards (one vote per benchmark) and a task-spend
  // ranking (adoption, never capability).
  const aaTaskIndexes = {}
  for (const [slug, domain] of AA_TASK_INDEX_PAGES) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    try {
      const html = await fetchText(ARTIFICIAL_ANALYSIS_INDEX_URL(slug), { fetchImpl, signal })
      const rows = extractArtificialAnalysisTaskIndexes(html, domain)
      if (rows.length > 0) aaTaskIndexes[domain] = rows
    } catch (error) {
      errors.push(`artificialanalysis index ${slug}: ${String(error?.message ?? error)}`)
    }
  }
  const orBenchmarks = {}
  for (const [slug, dimension, canonical] of OPENROUTER_BENCHMARK_PAGES) {
    if (signal?.aborted === true) throw new Error('refresh aborted')
    try {
      const html = await fetchText(OPENROUTER_BENCHMARK_URL(slug), { fetchImpl, signal })
      const rows = extractOpenRouterBenchmarkPage(html).map((row) => ({ ...row, canonical, dimension }))
      if (rows.length > 0) orBenchmarks[slug] = rows
    } catch (error) {
      errors.push(`openrouter benchmark ${slug}: ${String(error?.message ?? error)}`)
    }
  }
  let orTaskUsage = null
  try {
    orTaskUsage = extractOpenRouterTaskUsage(await fetchJson(OPENROUTER_TASK_SPEND_URL, { fetchImpl, signal }))
  } catch (error) {
    errors.push(`openrouter task spend: ${String(error?.message ?? error)}`)
  }

  const dataset = buildDataset({
    base,
    benchgecko: extractions,
    compass,
    counts: countsOf(extractions, raws),
  })
  // Artificial Analysis runs first because it is also the pass that creates an
  // entry for an advertised model the catalog has never described. The joined
  // cross-checks are keyed by catalog id, so they must run after that creation or
  // a newly created entry silently loses its Epoch / llmleaderboard row.
  const artificialAnalysis = attachArtificialAnalysis(dataset, { analysis, wanted, now })
  const attached = attachCrossChecks(dataset, { epoch, llm })
  // Real usage: OpenRouter's weekly ranking. Popularity is not capability, but at
  // equal measured quality it says which model is battle-tested in production.
  let openrouter = { matched: 0, rows: 0 }
  try {
    const usage = await fetchOpenRouterUsage({ fetchImpl, signal })
    openrouter = attachUsage(dataset, usage)
  } catch (error) {
    errors.push(`openrouter usage: ${String(error?.message ?? error)}`)
  }

  // Identity reconciliation: an entry whose stored label names a different model
  // than its own id is repaired from the id, and the repair travels in the
  // refresh summary. Without it a label written by an old bad join survived every
  // rebuild, so the board kept describing one model with another's name.
  const reconciled = []
  for (const [id, entry] of Object.entries(dataset)) {
    if (entry === null || typeof entry !== 'object') continue
    const label = reconciledLabel(id, entry.label)
    if (label !== entry.label) {
      reconciled.push({ id, from: typeof entry.label === 'string' ? entry.label : null, to: label })
      entry.label = label
    }
  }

  // Task signals are attached last so the adoption merge cannot be undone by the
  // weekly-usage pass: indexes stay signals, OpenRouter benchmarks become
  // observations, task spend stays adoption.
  const taskSignals = attachTaskSignals(dataset, { aaTaskIndexes, orBenchmarks, orTaskUsage, now })

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
      reconciled,
      taskSignals: {
        ...taskSignals,
        taskIndexes: Object.keys(aaTaskIndexes).length,
        benchmarks: Object.keys(orBenchmarks).length,
        usageTasks: orTaskUsage === null ? 0 : Object.keys(orTaskUsage.models).length,
      },
      sources: [COMPASS_ABILITY_URL, COMPASS_BENCH_URL, 'https://benchgecko.ai', EPOCH_ECI_URL, LLM_LEADERBOARD, ARTIFICIAL_ANALYSIS_URL, 'https://artificialanalysis.ai/indexes', 'https://openrouter.ai/benchmarks'],
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
      // The status text reports how many models the cut-offs were derived from;
      // a per-envelope count survives being persisted and reloaded, which the
      // separate top-level `sample` above does not.
      sample: costs.length,
    }
  }
  return { valid: true, sample: costs.length, envelopes }
}

// Envelope composition moved to the capability-basis owner; keep the names
// exported from here for the refresh tests and the host.
export { effectiveEnvelopes, mergeEnvelopes } from './basis.js'

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

  // Write the rows first, without a percentile. Several catalog entries can be
  // one OpenRouter model (the same id through different providers), and one
  // catalog key can be matched by several rows (an exact id, then a reseller
  // stem) where the last row wins -- so the list of fetched rows is not the set
  // of ranks the catalog actually carries. The percentile is a property of the
  // final per-entry ranks, computed after the writes.
  for (const { key, row } of matches) {
    dataset[key] = {
      ...dataset[key],
      usage: {
        source: 'openrouter-top-weekly',
        rank: row.weeklyRank,
        ...(row.weeklyTokens === undefined ? {} : { tokens: Math.round(row.weeklyTokens) }),
        ...(row.weeklyShare === undefined ? {} : { share: Math.round(row.weeklyShare * 10000) / 10000 }),
        percentile: null,
      },
    }
  }
  // Percentile from unique ranks: several catalog entries can be one OpenRouter
  // model, and counting the duplicates spread the percentiles over a list that
  // was not the ranking.
  const ranks = [...new Set(Object.values(dataset).map((entry) => entry?.usage?.rank).filter((rank) => Number.isInteger(rank)))].sort((a, b) => a - b)
  const percentileOf = (rank) => {
    const position = ranks.indexOf(rank)
    return ranks.length <= 1 ? 100 : Math.round((1 - position / (ranks.length - 1)) * 1000) / 10
  }
  for (const key of new Set(matches.map(({ key }) => key))) {
    const entry = dataset[key]
    if (entry?.usage !== undefined) entry.usage.percentile = percentileOf(entry.usage.rank)
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
      // Observations no alignment fit covered: the board renders this count as a
      // warning badge, so the field has to be written here or the badge is dead.
      ...(row.uncalibrated.length === 0 ? {} : { uncalibrated: row.uncalibrated.length }),
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
      // Task-type coverage: composite indexes (index signals), OpenRouter
      // single-benchmark observations, and per-task adoption.
      taskIndexes: table.models.filter((row) => row.signals?.taskIndexes !== null && row.signals?.taskIndexes !== undefined).length,
      openrouterBenchmarks: table.models.filter((row) => row.entry?.crossChecks?.openrouterBenchmarks !== undefined).length,
      taskUsage: table.models.filter((row) => row.signals?.taskUsage !== null).length,
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
 * @param {Record<string, object>|null} [base] - catalog, for the label check
 */
export function extractArtificialAnalysis(html, index, base = null) {
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
  // Why a row, not just which: a catalog id can be claimed by a row that names
  // it exactly and by a broader family row (`DeepSeek V4.1 Flash` claiming the
  // `...-1017` snapshot). The exact spelling wins, then the higher index --
  // payload order must not decide what a model is described by.
  const outRank = new Map()
  const byName = new Map()
  // Names that are a row's own name (not a qualifier-stripped alias). A stripped
  // spelling is only a fallback: letting it overwrite the exact row turned the
  // later-emitted effort variant into the model's name and measurements.
  const exactNames = new Set()
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
    const exact = normalizeName(row.name)
    byName.set(exact, value)
    exactNames.add(exact)
    const withoutQualifier = normalizeName(String(row.name).replace(/\([^)]*\)/g, ' '))
    if (!exactNames.has(withoutQualifier)) byName.set(withoutQualifier, value)
    // A prefix match alone is not identity: every join applies the model-stem
    // guard, and the label must name the same model too (a mislabelled entry
    // called "V3.2" must not inherit the other generation's measurements).
    const ownSpelling = normalizeName(row.name)
    const aliasSpelling = normalizeName(String(row.name).replace(/\([^)]*\)/g, ' '))
    for (const id of claimAll(row.name, index)) {
      if (!sameModelName(id, row.name)) continue
      if (!labelAgrees(base, id, row.name)) continue
      // 2 = the row's own name is the id, 1 = only the qualifier-free spelling is.
      const idSpellings = [normalizeName(id), normalizeName(bareId(id))]
      const exact = idSpellings.includes(ownSpelling) ? 2 : idSpellings.includes(aliasSpelling) ? 1 : 0
      const rank = [exact, Number.isFinite(value.intelligenceIndex) ? value.intelligenceIndex : -1]
      const previous = outRank.get(id)
      if (previous !== undefined && (previous[0] > rank[0] || (previous[0] === rank[0] && previous[1] >= rank[1]))) continue
      outRank.set(id, rank)
      out[id] = value
    }
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
 * Read the benchmark scores out of one AA model page.
 *
 * The page row is richer than the leaderboard table row: it carries the capacity
 * and serving facts under their own field names (`contextWindowTokens`,
 * `headline.timeToFirstToken`, `headline.outputSpeed`) and the effort variant
 * under `isReasoning`. Reading only the benchmark table left page-created
 * entries claiming a context window of 0 and no latency measurement at all.
 *
 * @param {string} html
 * @param {Map<string, string>} index
 * @param {Record<string, object>|null} [base] - catalog, for the label check
 */
/**
 * Input modalities from an Artificial Analysis model-page row.
 *
 * Returns null when the row carries no modality flags: unknown is not "text only".
 *
 * @param {object} row
 * @returns {string[]|null}
 */
function modalityFlags(row) {
  const text = row.inputModalityText
  const image = row.inputModalityImage
  const speech = row.inputModalitySpeech
  const video = row.inputModalityVideo
  if (text === undefined && image === undefined && speech === undefined && video === undefined) return null
  const modalities = []
  if (text === true) modalities.push('text')
  if (image === true) modalities.push('image')
  if (speech === true) modalities.push('audio')
  if (video === true) modalities.push('video')
  return modalities.length === 0 ? null : modalities
}

export function extractArtificialAnalysisModelPage(html, index, base = null) {
  const out = {}
  for (const text of decodeFlightChunks(html)) {
    let at = text.indexOf('{"id":"')
    while (at >= 0) {
      const row = readJsonObjectAt(text, at)
      if (row !== null && typeof row.name === 'string') {
        const scores = {}
        for (const key of MODEL_PAGE_BENCHMARKS) {
          const value = Number(row[key])
          // Zero means "not run" on a model page as well; keeping it would let the
          // ranking engine average a non-test into the dimension.
          if (Number.isFinite(value) && value > 0 && value <= 1) scores[key] = Math.round(value * 1000) / 10
        }
        if (Object.keys(scores).length >= 4) {
          const value = { source: ARTIFICIAL_ANALYSIS_URL, name: row.name, benchmarks: scores }
          const priceIn = Number(row.price1mInputTokens)
          const priceOut = Number(row.price1mOutputTokens)
          if (Number.isFinite(priceIn)) value.priceIn = priceIn
          if (Number.isFinite(priceOut)) value.priceOut = priceOut
          const ttft = Number(row.timeToFirstToken ?? row.headline?.timeToFirstToken)
          const speed = Number(row.outputSpeed ?? row.headline?.outputSpeed)
          if (Number.isFinite(ttft)) value.ttft = ttft
          if (Number.isFinite(speed)) value.speed = speed
          const context = Number(row.contextWindowTokens)
          if (Number.isFinite(context) && context > 0) value.contextTokens = context
          if (row.isReasoning === true || row.isReasoning === false) value.reasoning = row.isReasoning
          const releaseDate = typeof row.releaseDate === 'string' ? row.releaseDate : row.release?.releaseDate
          if (typeof releaseDate === 'string') value.releaseDate = releaseDate
          const cacheHitPrice = Number(row.cacheHitPrice)
          if (Number.isFinite(cacheHitPrice)) value.cacheHitPrice = cacheHitPrice
          if (typeof row.creator === 'string') value.creator = row.creator
          // AA publishes input modality flags on the model page; they are the one
          // non-measurement fact it does carry, and a created entry has no baseline
          // to inherit them from.
          const modalities = modalityFlags(row)
          if (modalities !== null) value.modalities = modalities
          for (const idFromIndex of idsAt(index, normalizeName(row.name))) {
            if (!sameModelName(idFromIndex, row.name)) continue
            if (!labelAgrees(base, idFromIndex, row.name)) continue
            out[idFromIndex] = value
          }
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
 * AA contributes three things the catalog cannot get elsewhere: the
 * per-benchmark percentages the ranking engine reads as observations, a measured
 * USD price for entries that have no catalog price (converted at one stated
 * rate), and a serving measurement from which a latency class is derived. It
 * writes no capability score: AA's intelligence index is its own scale, and
 * `rank.js` already fits it onto the measured composite for entries with no
 * dimension measurement (status `provisional`). A second fit here, against the
 * demoted legacy `quality`, compared two bases and made an old, stale compiled
 * score the yardstick for AA's numbers.
 *
 * @param {Record<string, object>} dataset
 * @param {{base?: Record<string, object>, analysis: object, wanted?: Array, now?: Date}} input
 */
export function attachArtificialAnalysis(dataset, { base = {}, analysis = {}, wanted = [], now = new Date() } = {}) {
  // `base` is not read for scores any more (the index is fitted against the
  // ranking in rank.js); it is the source of facts a created entry may inherit.
  const byId = analysis.byId ?? {}
  const byName = analysis.byName ?? new Map()

  /** Latency class from whatever serving facts a row carries; null when unmeasured. */
  const latencyOf = (value) => {
    const ttft = Number.isFinite(value.ttft) ? value.ttft : null
    const speed = Number.isFinite(value.speed) ? value.speed : null
    if (ttft === null && speed === null) return null
    const seconds = ttft ?? 99
    const tokensPerSecond = speed ?? 0
    return seconds <= 1 && tokensPerSecond >= 100 ? 'fast' : seconds <= 3 ? 'balanced' : 'slow'
  }

  /** Whether a row carries a measurement the ranking or the tier board can use. */
  const isMeasured = (value) =>
    (Number.isFinite(value.intelligenceIndex) && value.intelligenceIndex > 0) ||
    Object.keys(value.benchmarks ?? {}).length >= 4

  let measuredCount = 0
  let filledPrice = 0
  let filledLatency = 0
  for (const [id, value] of Object.entries(byId)) {
    const entry = dataset[id] ?? dataset[id.toLowerCase()]
    if (entry === undefined) continue
    if (isMeasured(value)) measuredCount += 1
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

    // A zero price is a real price (a free model), not a missing one; only a
    // missing field may be filled from Artificial Analysis.
    const hasPrice = Number.isFinite(Number(entry.price?.input)) && Number(entry.price.input) >= 0
    if (!hasPrice && Number.isFinite(value.priceIn)) {
      entry.price = {
        input: round1(value.priceIn * CNY_PER_USD),
        output: round1((value.priceOut ?? value.priceIn) * CNY_PER_USD),
        ...(entry.price?.cacheHitInput === undefined ? {} : { cacheHitInput: entry.price.cacheHitInput }),
      }
      filledPrice += 1
    }
    if (entry.latency === undefined) {
      const latency = latencyOf(value)
      if (latency !== null) {
        entry.latency = latency
        filledLatency += 1
      }
    }
  }
  // Models the provider advertises but the catalog has never described: AA is the
  // only source that knows them, so they get an entry built from its row rather
  // than staying invisible to the router forever.
  let created = 0
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
    // The match decides the label and the numbers, so the identity rule must
    // apply here too: a name prefix alone joined `vanchin/deepseek-v3` to a
    // "DeepSeek V3.2 (Reasoning)" row and shipped that row's label under the
    // V3 id, after which the id's own 2024 Epoch row made the entry look
    // consistent while its label named the next generation.
    if (!sameModelName(id, value.name)) continue
    const entryKey = id.toLowerCase()
    const existing = dataset[id] ?? dataset[entryKey]
    if (existing !== undefined) continue
    if (!isMeasured(value) && !Number.isFinite(value.priceIn)) continue
    const price = Number.isFinite(value.priceIn)
      ? { input: round1(value.priceIn * CNY_PER_USD), output: round1((value.priceOut ?? value.priceIn) * CNY_PER_USD) }
      : undefined
    // A capacity AA never published is unknown, not zero: `0` read as a window
    // that is too small for long-context work, while `null` is left to the
    // selector's uncertainty penalty.
    const contextWindow = Number.isFinite(value.contextTokens) && value.contextTokens > 0 ? value.contextTokens : null
    dataset[entryKey] = {
      label: labelForId(id, value.name ?? bare),
      ...(provider === undefined ? {} : { provider }),
      contextWindow,
      ...(price === undefined ? {} : { price }),
      // Facts AA does not publish stay unknown unless another entry describes the
      // same model: `modalities` comes from the AA model page when it lists the
      // flags, otherwise from the baseline catalog by identity, otherwise it is
      // absent (unknown is not "text only"). Tool support has no source at all, so
      // an AA-created entry states nothing about it.
      ...(Array.isArray(value.modalities) ? { modalities: value.modalities } : inheritFact(base, id, 'modalities')),
      ...inheritFact(base, id, 'toolCalling'),
      reasoning: value.reasoning === true,
      latency: latencyOf(value) ?? 'balanced',
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
        ...(value.contextTokens === undefined ? {} : { contextTokens: value.contextTokens }),
        ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
        source: ARTIFICIAL_ANALYSIS_URL,
      } },
    }
    created += 1
  }

  // Every entry leaves here complete: the selector scores all nine dimensions and
  // the knowledge tests require integers for evidence. Dimensions with nothing
  // behind them are placeholders (0, evidence 0): the ranking carries the
  // measured values, and a placeholder must never be read as a score.
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
    // Optional facts are present-but-null when unknown, so a reader can tell
    // "not known" from "field never existed" without inventing a value.
    for (const field of ['contextWindow', 'price', 'reasoning', 'latency']) {
      if (entry[field] === undefined) entry[field] = null
    }
  }

  return {
    models: Object.keys(byId).length,
    created,
    measured: measuredCount,
    // The refresh status line prints this field as "measured"; since AA no longer
    // fills a capability score, it counts the entries AA actually measured
    // (a published index above zero, or enough benchmarks to be evidence).
    filledQuality: measuredCount,
    filledPrice,
    filledLatency,
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
 * @param {Record<string, object>|null} [base] - catalog, for the label check
 */
export function extractEpochEci(csv, index, base = null) {
  const rows = parseCsv(csv)
  const header = rows[0] ?? []
  const column = (name) => header.indexOf(name)
  const nameAt = column('Display name')
  const eciAt = column('eci')
  const dateAt = column('date')
  const out = {}
  for (const row of rows.slice(1)) {
    const name = row[nameAt]
    if (name === undefined) continue
    const eci = Number(row[eciAt])
    if (!Number.isFinite(eci)) continue
    const date = row[dateAt] ?? null
    for (const id of idsForName(index, name)) {
      if (!sameModelName(id, name)) continue
      // A row only owns an entry whose label names the same model: a V3.2 label
      // on a V3 id must not collect the 2024 V3 ECI.
      if (!labelAgrees(base, id, name)) continue
      // One row per model; on duplicates keep the newer evaluation date.
      const previous = out[id]
      if (previous !== undefined && String(previous.date) > String(date)) continue
      out[id] = { eci: round1(eci), date, source: EPOCH_ECI_URL }
    }
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
 * @param {Record<string, object>|null} [base] - catalog, for the label check
 */
export function extractLlmComparison(csv, index, base = null) {
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
    const name = modelAt === -1 ? undefined : row[modelAt]
    if (name === undefined) continue
    const ttft = Number(row[ttftAt])
    const speed = Number(row[speedAt])
    if (!Number.isFinite(speed) || speed <= 0) continue
    for (const id of idsForName(index, name)) {
      if (!sameModelName(id, name)) continue
      if (!labelAgrees(base, id, name)) continue
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
 * @param {Record<string, object>|null} [base] - catalog, for the label check
 */
export function extractLlmBenchmarkPage(html, track, index, base = null) {
  const out = {}
  if (track === null) return out
  const rowPattern = /<tr data-benchmark-track="([^"]+)" data-benchmark-model="([^"]+)" data-score="([^"]+)"/g
  for (const match of String(html ?? '').matchAll(rowPattern)) {
    if (match[1] !== track) continue
    const name = match[2]
    const score = Number(match[3])
    if (!Number.isFinite(score)) continue
    for (const id of idsForName(index, name)) {
      if (!sameModelName(id, name)) continue
      if (!labelAgrees(base, id, name)) continue
      out[id] = round1(score)
    }
  }
  return out
}

const round3 = (value) => Math.round(value * 1000) / 1000

/**
 * Read the per-model rows of one Artificial Analysis index page.
 *
 * The page server-renders the index chart rows inside its RSC flight stream:
 * `{ name, weightedIndex, subScores: { knowledge, reasoning, longContext, … } }`.
 * Values are stored as published (0-100 composite scale).
 *
 * @param {string} html
 * @param {string} domain - index slug, recorded as the key
 * @returns {Array<{name: string, domain: string, index: number, subScores: object}>}
 */
export function extractArtificialAnalysisTaskIndexes(html, domain) {
  const text = decodeFlightChunks(html).join('')
  const rows = []
  let at = text.indexOf('{"id":"')
  while (at >= 0) {
    const row = readJsonObjectAt(text, at)
    if (row !== null && typeof row.name === 'string' && typeof row.weightedIndex === 'number' && Number.isFinite(row.weightedIndex)) {
      const subScores = {}
      for (const [key, value] of Object.entries(row.subScores ?? {})) {
        if (typeof value === 'number' && Number.isFinite(value)) subScores[key] = round1(value)
      }
      rows.push({ name: row.name, domain, index: round1(row.weightedIndex), subScores })
    }
    at = text.indexOf('{"id":"', at + 1)
  }
  return rows
}

/**
 * Read one OpenRouter benchmark leaderboard page.
 *
 * The server-rendered page embeds a `models` array; each entry carries the
 * model's name/slug and a `median` provider result with `accuracy` as a 0-1
 * fraction. The fraction is stored as published.
 *
 * @param {string} html
 * @returns {Array<{name: string, slug: string, accuracy: number}>}
 */
export function extractOpenRouterBenchmarkPage(html) {
  const text = decodeFlightChunks(html).join('')
  const marker = '"models":['
  const at = text.indexOf(marker)
  if (at < 0) return []
  const start = at + marker.length - 1
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return []
  let models
  try { models = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  const out = []
  for (const model of Array.isArray(models) ? models : []) {
    const accuracy = Number(model?.median?.accuracy)
    if (typeof model?.modelName !== 'string' || !Number.isFinite(accuracy) || accuracy <= 0) continue
    out.push({ name: model.modelName, slug: String(model.modelSlug ?? ''), accuracy })
  }
  return out
}

/**
 * Reduce OpenRouter's task-spend ranking to per-model task shares.
 *
 * `spend`/`tokens` each carry the same 39 task tags with a model list ordered by
 * that task's share. This is adoption, not capability: it is stored on the
 * entry's `usage` and never blended into a dimension.
 *
 * @param {{data?: object}} payload - response of the task-spend endpoint
 * @returns {{windowDays: number|null, models: Record<string, Array<{tag: string, macroCategory: string, share: number, rank: number}>>}}
 */
export function extractOpenRouterTaskUsage(payload) {
  const spend = payload?.data?.spend ?? {}
  const byModel = {}
  for (const task of Array.isArray(spend.tasks) ? spend.tasks : []) {
    if (typeof task?.tag !== 'string') continue
    const models = Array.isArray(task.models) ? task.models : []
    models.forEach((model, position) => {
      if (typeof model?.model !== 'string') return
      ;(byModel[model.model] ??= []).push({
        tag: task.tag,
        macroCategory: typeof task.macroCategory === 'string' ? task.macroCategory : null,
        share: typeof model.share === 'number' ? Math.round(model.share * 10000) / 10000 : null,
        rank: position + 1,
      })
    })
  }
  for (const tasks of Object.values(byModel)) tasks.sort((a, b) => a.rank - b.rank)
  return { windowDays: typeof spend.windowDays === 'number' ? spend.windowDays : null, models: byModel }
}

/** Strip the source's author prefix from a model name/slug. */
function bareSourceName(value) {
  const text = String(value ?? '')
  if (text.includes(': ')) return text.slice(text.indexOf(': ') + 2)
  if (text.includes('/')) return text.slice(text.lastIndexOf('/') + 1)
  return text
}

/** Every dataset id naming the same model as a source row. */
function idsNamingModel(dataset, name) {
  const ids = []
  for (const id of Object.keys(dataset)) {
    if (!sameModelName(id, name)) continue
    if (!labelAgrees(dataset, id, name)) continue
    ids.push(id)
  }
  return ids
}

/**
 * Attach the task-type signals without turning adoption into capability.
 *
 * - `aaTaskIndexes` (domain indexes) and their sub-scores are composite
 *   evidence: stored under `crossChecks.taskIndexes` as an index signal.
 * - `orBenchmarks` are single benchmark accuracies: stored under
 *   `crossChecks.openrouterBenchmarks` for the ranking engine, which treats them
 *   as one benchmark vote per canonical id.
 * - `orTaskUsage` is per-task adoption: merged into `usage.tasks` and never
 *   blended into a dimension.
 *
 * @param {Record<string, object>} dataset
 * @param {{aaTaskIndexes?: Record<string, Array>, orBenchmarks?: Record<string, Array>, orTaskUsage?: object|null, now?: Date}} input
 */
export function attachTaskSignals(dataset, { aaTaskIndexes = {}, orBenchmarks = {}, orTaskUsage = null, now = new Date() } = {}) {
  const checkedAt = now.toISOString().slice(0, 10)
  let indexModels = 0
  for (const [domain, rows] of Object.entries(aaTaskIndexes)) {
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const id of idsNamingModel(dataset, row.name)) {
        const entry = dataset[id]
        const taskIndexes = (entry.crossChecks ??= {}).taskIndexes ??= { source: 'https://artificialanalysis.ai/indexes', checkedAt, indexes: {}, subScores: {} }
        if (taskIndexes.indexes[domain] === undefined) indexModels += 1
        taskIndexes.indexes[domain] = row.index
        if (Object.keys(row.subScores ?? {}).length > 0) taskIndexes.subScores[domain] = row.subScores
      }
    }
  }
  let benchmarkModels = 0
  for (const rows of Object.values(orBenchmarks)) {
    for (const row of Array.isArray(rows) ? rows : []) {
      const canonical = typeof row.canonical === 'string' ? row.canonical : null
      if (canonical === null) continue
      const name = bareSourceName(row.name)
      for (const id of idsNamingModel(dataset, name)) {
        const entry = dataset[id]
        const block = (entry.crossChecks ??= {}).openrouterBenchmarks ??= { source: 'https://openrouter.ai/benchmarks', checkedAt, accuracy: {} }
        if (block.accuracy[canonical] === undefined) benchmarkModels += 1
        block.accuracy[canonical] = Math.round(row.accuracy * 10000) / 10000
      }
    }
  }
  let usageModels = 0
  if (orTaskUsage !== null && orTaskUsage !== undefined) {
    for (const [model, tasks] of Object.entries(orTaskUsage.models ?? {})) {
      for (const id of idsNamingModel(dataset, bareSourceName(model))) {
        const entry = dataset[id]
        entry.usage = { ...(entry.usage ?? {}), source: entry.usage?.source ?? 'openrouter-task-spend', tasks: tasks.slice(0, 12), windowDays: orTaskUsage.windowDays ?? null }
        usageModels += 1
      }
    }
  }
  return { indexModels, benchmarkModels, usageModels }
}

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
