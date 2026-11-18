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

const CDN = 'https://cdn.opencompass.org.cn/assets/lm'
export const COMPASS_ABILITY_URL = `${CDN}/data-lm-ability_official.json`
export const COMPASS_BENCH_URL = `${CDN}/data-lm-ability_benchmark.json`
export const BENCHGECKO_MODEL_URL = (slug) => `https://benchgecko.ai/api/v1/models/${encodeURIComponent(slug)}`
export const EPOCH_ECI_URL = 'https://epoch.ai/data/eci_scores.csv'
export const LLM_LEADERBOARD = 'https://llmleaderboard.com'
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
export async function refreshCatalog({ base, fetchImpl = fetch, signal, now = new Date() }) {
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

  const dataset = buildDataset({
    base,
    benchgecko: extractions,
    compass,
    counts: countsOf(extractions, raws),
  })
  const attached = attachCrossChecks(dataset, { epoch, llm })

  return {
    dataset,
    summary: {
      checkedAt: now.toISOString().slice(0, 10),
      models: Object.keys(dataset).length,
      benchgecko: Object.values(extractions).filter((entry) => typeof entry.avg === 'number' && entry.avg > 0).length,
      // Count what actually landed in the catalog, not what was fetched: a
      // leaderboard row for a model outside the alignment map changes nothing.
      compass: Object.values(dataset).filter((entry) => entry?.crossChecks?.compassRank !== undefined).length,
      epoch: attached.epoch,
      llmLeaderboard: attached.llmLeaderboard,
      sources: [COMPASS_ABILITY_URL, COMPASS_BENCH_URL, 'https://benchgecko.ai', EPOCH_ECI_URL, LLM_LEADERBOARD],
      errors,
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
