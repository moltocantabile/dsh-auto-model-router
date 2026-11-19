/**
 * Evidence-weighted ranking over the compiled model catalog.
 *
 * The catalog currently compresses five leaderboard passes into nine 0-100
 * scores with one `buildDataset()` pass. That merge is opaque at the point of
 * use: `scores.coding` may be a BenchGecko category mean, a CompassRank board
 * after a median-shift alignment, a hand-written family prior, or an
 * Artificial Analysis index linearly mapped through a scale fit, with no record
 * of which. `select.js` can only see the single number and one integer sample
 * count, so it cannot tell a two-source consensus from a one-benchmark guess.
 *
 * This module re-derives every dimension from the leaf measurements the catalog
 * still carries, on one explicitly defined axis, and keeps the provenance:
 *
 * - **Axis owner** — BenchGecko's normalized per-benchmark values. BenchGecko
 *   publishes per-category 0-100 means; its raw benchmark table is stored on the
 *   entry as `benchmarks` and is the only source already on the common axis.
 * - **Channels that need alignment** — CompassRank boards, Artificial Analysis
 *   per-benchmark percentages, llmleaderboard tracks. Each channel's raw scores
 *   sit on their own scale, so each (channel, dimension) is aligned to the axis
 *   with an affine fit on the models both sides measured. Below three overlaps
 *   the channel is *uncalibrated* and its observations are reported, never
 *   merged. Offset-only equating under eight overlaps; a least-squares slope
 *   shrunk halfway to 1 at or above eight, to stop small-n fits from rewriting
 *   the scale.
 * - **One benchmark, one vote** — sources republish each other's benchmarks.
 *   BenchGecko's table contains rows labelled `Artificial Analysis · …` and
 *   `LiveBench · …`; CompassRank's Terminal-Bench is Artificial Analysis' too.
 *   Observations are keyed by canonical benchmark id, aligned, and averaged
 *   *within* that id, so three republishers of GPQA contribute one unit of
 *   evidence, not three. Evidence is therefore the integer count of distinct
 *   benchmarks that measured the dimension.
 * - **Never blended** — Epoch's ECI is an interval scale, Artificial Analysis'
 *   intelligence index is its own scale, and the catalog's `quality` is a
 *   composite of other scores. None of them enters a per-dimension mean. ECI and
 *   AA's index are used only for cross-source agreement diagnostics, and AA's
 *   index alone (after a fit to the merged composite) is a *provisional*
 *   overall estimate for a model that has no per-dimension measurement at all.
 *
 * The output is a plain data table: no I/O, no network, no host imports. It
 * takes the catalog as objects and returns objects. `toCatalogPatch()` turns it
 * back into the `scores`/`evidence` shape the selector reads, and
 * `derivedEnvelopes()` + `planTiers()` answer the other half of the job: instead
 * of fixed price ceilings, tier membership is derived from the pool's own cost
 * and capability distribution, while `fast`/`balanced`/`deep` remain the stable
 * operator-facing names and explicit envelopes still win.
 *
 * Honesty rules enforced by construction:
 *
 * - an estimate always carries an integer `evidence` count of at least 1; a
 *   value with nothing behind it is `null`, not a score;
 * - a compiled score whose `evidence[dim]` is 0 is a prior, so it is not used;
 * - only BenchGecko leaves, CompassRank boards, AA percentages and
 *   llmleaderboard tracks produce evidence — latencies, context windows,
 *   modality flags, prices and the AA/Epoch scales never do;
 * - a model with no per-dimension measurement is `provisional` (AA index only)
 *   or `unmeasured`; `planTiers()` does not place either by default;
 * - dominance-based switching stays *inside a model family*: this module exposes
 *   the cross-vendor Pareto view for display, but never disables a model because
 *   another vendor's model is cheaper and stronger.
 */

import { DIMENSIONS, PRICE_CNY_PER_USD, costIndex } from './select.js'
import { TIER_IDS, familyOf } from './tiers.js'

export { PRICE_CNY_PER_USD, TIER_IDS }

/** The five dimensions the router's capability composite is built from. */
export const CORE_DIMENSIONS = Object.freeze(['coding', 'reasoning', 'math', 'knowledge', 'agentic'])

/**
 * Weights of the capability composite. They are the router's own statement of
 * what a general coding agent values, not a measurement; keeping them here (and
 * out of any source's numbers) is what stops a vendor's index from deciding the
 * composite. Renormalized over the dimensions a model actually has measured.
 */
export const COMPOSITE_WEIGHTS = Object.freeze({
  coding: 0.25,
  reasoning: 0.25,
  math: 0.15,
  knowledge: 0.15,
  agentic: 0.2,
})

/** Below this many overlap models a channel/dimension alignment is a guess. */
export const MIN_ALIGN_OVERLAP = 3
/** At or above this many overlaps the alignment fits a slope as well as an offset. */
export const MIN_SLOPE_OVERLAP = 8
/**
 * Overlap floor for the *dimension-level* fallback, which is weaker than equating
 * the same benchmark: it equates whole-dimension means across models whose
 * benchmark mix differs, so four overlapping models can shift a dimension by
 * tens of points (measured residual RMS 16-18). The same-benchmark path keeps the
 * lower floor because a shared benchmark really is comparable.
 */
export const MIN_DIMENSION_OVERLAP = 6
/** Weight of the neutral prior when a dimension rests on few benchmarks. */
export const EVIDENCE_PRIOR_WEIGHT = 2
/** Fraction of a fitted slope's distance from 1 that is kept (shrinkage). */
export const SLOPE_SHRINK = 0.5
/** Two independent sources further apart than this are reported as disagreeing. */
export const DISAGREEMENT_POINTS = 12
/** Minimum measured models before derived envelopes are computed at all. */
export const MIN_DERIVED_ENVELOPE_SAMPLE = 4
/** Minimum overlap before the AA index is used as a provisional overall estimate. */
export const MIN_INDEX_FIT = 8
/**
 * Lower-bound charge for each core dimension a model does not have measured.
 * Missing coverage is structural, not noise: a composite built from two of five
 * dimensions is not comparable to one built from all five, even if both have
 * plenty of samples on the dimensions they did measure.
 */
export const MISSING_DIMENSION_PENALTY = 8
/** An alignment residual above this (points RMS) marks the merged evidence as weakly calibrated. */
export const WEAK_CALIBRATION_RMS = 15
/** Cost-index margin a same-family model must clear to switch another one off. */
export const DOMINANCE_COST_MARGIN = 10

/** Same tier names, same order: operator-facing and intentionally stable. */
const TIER_COST_FACTOR = Object.freeze({ fast: 1.6, balanced: 1, deep: 0.05 })
const LATENCY_RANK = Object.freeze({ fast: 0, balanced: 1, slow: 2 })

export const STATUS = Object.freeze({ MEASURED: 'measured', PROVISIONAL: 'provisional', UNMEASURED: 'unmeasured' })

const DEFAULTS = Object.freeze({
  analysis: null,
  cnyPerUsd: PRICE_CNY_PER_USD,
  minAlignOverlap: MIN_ALIGN_OVERLAP,
  minSlopeOverlap: MIN_SLOPE_OVERLAP,
  minDimensionOverlap: MIN_DIMENSION_OVERLAP,
  evidencePriorWeight: EVIDENCE_PRIOR_WEIGHT,
  slopeShrink: SLOPE_SHRINK,
  disagreementPoints: DISAGREEMENT_POINTS,
  minIndexFit: MIN_INDEX_FIT,
  missingDimensionPenalty: MISSING_DIMENSION_PENALTY,
})

// ── small numeric helpers ───────────────────────────────────────────────────

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const int = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0)
const round1 = (value) => Math.round(value * 10) / 10
const round2 = (value) => Math.round(value * 100) / 100
const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function rms(values) {
  if (values.length === 0) return null
  return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
}

/** Linear-interpolated quantile on an unsorted numeric list. */
export function quantile(values, p) {
  const sorted = values.filter((value) => num(value) !== null).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const at = clamp(p, 0, 1) * (sorted.length - 1)
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** Average-rank ranks, 1-based, so ties share a rank. */
function ranksOf(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const ranks = new Array(values.length).fill(0)
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j += 1
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[sorted[k].index] = rank
    i = j + 1
  }
  return ranks
}

/** Spearman's rank correlation over paired values ([[x, y], …]). */
export function spearman(pairs) {
  if (pairs.length < 3) return null
  const xs = ranksOf(pairs.map(([x]) => x))
  const ys = ranksOf(pairs.map(([, y]) => y))
  const mx = mean(xs)
  const my = mean(ys)
  let numerator = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - mx) * (ys[i] - my)
    dx += (xs[i] - mx) ** 2
    dy += (ys[i] - my) ** 2
  }
  if (dx === 0 || dy === 0) return null
  return round2(numerator / Math.sqrt(dx * dy))
}

const normalizeName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

const bareId = (key) => {
  const slash = String(key ?? '').lastIndexOf('/')
  return slash >= 0 ? String(key).slice(slash + 1) : String(key)
}



// ── the benchmark registry ──────────────────────────────────────────────────
//
// Every benchmark this module is willing to score, and the single dimension it
// scores. The registry is editorial: benchmark choice is a judgement about
// construct validity, so it is written down once, here, rather than inferred
// from a publisher's category labels. Two properties matter:
//
// - `canonical` is the *underlying* benchmark, shared by every publisher. GPQA
//   is `gpqa` whether it arrives from BenchGecko, Artificial Analysis or
//   llmleaderboard, which is what makes one-benchmark-one-vote possible.
// - a benchmark missing from this table is reported as `unknown` and never
//   scored. Silently dropping it would understate evidence; silently guessing a
//   dimension would manufacture it.
//
// The mapping is also the honest limit of the exercise: `hle` is filed under
// reasoning, `gpqa` under knowledge, `gdpval` under knowledge. Another reviewer
// could move them without changing the arithmetic, and the audit doc says so.

const DIM_RULES = [
  // coding
  ['swe-bench-pro', 'coding', /^swe-?bench-pro/],
  ['swe-bench', 'coding', /^swe-?bench/],
  ['deepswe', 'coding', /^deepswe/],
  ['frontierswe', 'coding', /^frontierswe/],
  ['frontiercode', 'coding', /^frontiercode/],
  ['livecodebench', 'coding', /^livecodebench/],
  ['scicode', 'coding', /^scicode/],
  ['weirdml', 'coding', /^weirdml/],
  ['mirrorcode', 'coding', /^mirrorcode/],
  ['livebench-coding', 'coding', /^(livebench-coding|livebench-2-coding|coding)$/],
  // reasoning
  ['arc-agi', 'reasoning', /^arc-agi/],
  ['hle', 'reasoning', /^(hle|hle-diamond|humanity-?s?-last-exam|humanitys-last-exam)$/],
  ['livebench-reasoning', 'reasoning', /^(livebench-reasoning|livebench-2-reasoning|reasoning)$/],
  ['livebench-data-analysis', 'reasoning', /^(livebench-data-analysis|livebench-2-data-analysis|data-analysis)$/],
  ['simplebench', 'reasoning', /^simplebench/],
  ['critpt', 'reasoning', /^critpt/],
  // Puzzle and game benchmarks measure novel-problem reasoning, not knowledge.
  ['chess-puzzles', 'reasoning', /^chess-puzzles?$/],
  ['mystery-game-puzzles', 'reasoning', /^mystery-game/],
  // math
  ['aime', 'math', /^(aime|aime-2025|otis-mock-aime)/],
  ['frontiermath', 'math', /^frontiermath/],
  ['livebench-mathematics', 'math', /^(livebench-mathematics|livebench-2-mathematics|mathematics|math)$/],
  ['proofbench', 'math', /^proofbench/],
  // knowledge
  ['gpqa', 'knowledge', /^gpqa/],
  ['simpleqa', 'knowledge', /^simpleqa/],
  // Omniscience publishes two different quantities: raw accuracy and the
  // non-hallucination rate. They are separate constructs and must not be
  // averaged into one benchmark.
  ['omniscience-accuracy', 'knowledge', /^omniscience-accuracy$/],
  ['omniscience-non-hallucination', 'knowledge', /^omniscience-non-hallucination$/],
  ['omniscience', 'knowledge', /^omniscience/],
  ['healthbench', 'knowledge', /^healthbench/],
  // GDPval (economically valuable tasks) and GDP.pdf (document analysis) are
  // different benchmarks that a label prefix would conflate.
  ['gdpval', 'knowledge', /^gdpval/],
  ['gdp-pdf', 'knowledge', /^gdp-pdf/],
  ['livebench-language', 'knowledge', /^(livebench-language|livebench-2-language|language)$/],
  // Instruction-following boards live under both channels; they measure the same
  // skill, so they share one canonical benchmark instead of voting twice.
  ['ifbench', 'knowledge', /^ifbench$/],
  ['livebench-if', 'knowledge', /^(if|ifbench)$/],
  // agentic
  ['terminal-bench-science', 'agentic', /^terminal-bench-science/],
  ['terminal-bench', 'agentic', /^terminal-?bench/],
  ['apex-agents', 'agentic', /^apex-agents/],
  ['tau2', 'agentic', /^tau2/],
  ['tau3', 'agentic', /^tau3/],
  ['itbench', 'agentic', /^itbench/],
  ['osworld', 'agentic', /^osworld/],
  ['remote-labor-index', 'agentic', /^remote-labor-index/],
  ['furniture-assembly', 'agentic', /^furniture-assembly/],
  ['automationbench', 'agentic', /^automationbench/],
  ['enterprise-ops-gym', 'agentic', /^enterprise-ops-gym/],
  ['analyst-agent', 'agentic', /^(aa-)?analyst-agent/],
  ['harvey-lab', 'agentic', /^harvey-lab/],
  ['vials', 'agentic', /^vials/],
  ['livebench-agentic', 'agentic', /^(livebench-agentic|livebench-2-agentic|agentic|agentic-coding)$/],
  // vision / long context: measured only when a benchmark measured them
  ['mmmu', 'vision', /^mmmu/],
  ['long-context-reasoning', 'longContext', /^(long-context-reasoning|mlcr|mlcr-aa)$/],
  // LMCA is a long-memory comprehension assessment: a long-context measurement.
  ['lmca', 'longContext', /^lmca$/],
]

/**
 * Artificial Analysis' `scores` object is not uniformly percentages: the
 * `gdpval-*-normalized`, `aa-briefcase`, `aa-3d` and `code2video-aa` rows are
 * index-scaled values (hundreds, sometimes negative). They are their own scale
 * and must never be multiplied by 100 or averaged into a percentage. They are
 * reported as index signals instead.
 */
const AA_INDEX_IDS = /^(aa-3d|aa-briefcase|code2video-aa|gdpval-aa-normalized)$/

const normalizeLabel = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function matchDim(bare) {
  for (const [canonical, dim, test] of DIM_RULES) {
    if (test.test(bare)) return { canonical, dim }
  }
  return null
}

function benchgeckoFamily(normalized) {
  if (normalized.startsWith('artificial-analysis-')) return { family: 'aa', bare: normalized.slice('artificial-analysis-'.length) }
  if (normalized.startsWith('livebench-')) return { family: 'livebench', bare: normalized.slice('livebench-'.length) }
  if (normalized.startsWith('chatbot-arena-elo-')) return { family: 'arena', bare: normalized.slice('chatbot-arena-elo-'.length) }
  // BenchGecko is an aggregator, not a benchmark author. Its raw capture labels
  // every non-prefixed row's origin as the Epoch AI Benchmarking Hub (the three
  // prefixed origins above are Artificial Analysis, LiveBench and LMArena). So a
  // "BenchGecko vs AA" agreement check would otherwise be partly comparing AA
  // with itself; the origin family records whose measurement it actually is.
  return { family: 'epoch-bench', bare: normalized }
}

/**
 * Classify one raw benchmark label into a canonical benchmark and dimension.
 *
 * @param {string} name - raw label as the source reports it
 * @param {'benchgecko'|'aa'|'llm'|'compass'} channel
 * @returns {{kind: 'dimension'|'index'|'unknown', family: string, canonical: string, dim?: string}}
 */
export function classifyBenchmark(name, channel = 'benchgecko') {
  const normalized = normalizeLabel(name)
  if (channel === 'benchgecko') {
    const { family, bare } = benchgeckoFamily(normalized)
    if (family === 'aa' && /(index|elo)$/.test(bare)) return { kind: 'index', family, canonical: `aa-${bare}` }
    if (family === 'arena' && bare === 'overall') return { kind: 'index', family, canonical: 'arena-overall' }
    if (family === 'livebench' && bare === 'overall') return { kind: 'index', family, canonical: 'livebench-overall' }
    const hit = matchDim(bare)
    if (hit === null) return { kind: 'unknown', family, canonical: normalized }
    // LiveBench and Chatbot Arena rows are scored per track; keep the publisher
    // in the canonical id so their "coding" does not collide with the plain one.
    const canonical = family === 'livebench' ? `livebench-${bare}` : family === 'arena' ? `arena-${bare}` : hit.canonical
    return { kind: 'dimension', family, canonical, dim: hit.dim }
  }
  if (channel === 'aa') {
    if (AA_INDEX_IDS.test(normalized)) return { kind: 'index', family: 'aa', canonical: normalized }
    // AA's long-context id carries the same "artificial-analysis-" prefix as the
    // BenchGecko republished row.
    const bare = normalized.startsWith('artificial-analysis-') ? normalized.slice('artificial-analysis-'.length) : normalized
    const hit = matchDim(bare)
    if (hit === null) return { kind: 'unknown', family: 'aa', canonical: normalized }
    return { kind: 'dimension', family: 'aa', canonical: hit.canonical, dim: hit.dim }
  }
  if (channel === 'llm') {
    const bare = normalized.replace(/^livebench-2-/, 'livebench-')
    const hit = matchDim(bare)
    if (hit === null) return { kind: 'unknown', family: 'llm', canonical: normalized }
    return { kind: 'dimension', family: 'llm', canonical: hit.canonical, dim: hit.dim }
  }
  if (channel === 'compass') {
    const hit = matchDim(normalized)
    if (hit === null) return { kind: 'unknown', family: 'compass', canonical: normalized }
    return { kind: 'dimension', family: 'compass', canonical: hit.canonical, dim: hit.dim }
  }
  return { kind: 'unknown', family: String(channel), canonical: normalized }
}

/**
 * CompassRank fields the compiler stores on `crossChecks.compassRank`, mapped
 * to the dimension each board measures.
 *
 * The stored cross-check is narrower than the source: it keeps ability
 * `Average`, `Knowledge`, `Reasoning`, `Abstraction`, `Agent` and bench
 * `SWE-bench Pro Verified`, `Terminal-Bench 4.0`, `HLE-Diamond` only. The
 * compiler used `QuantitativeReasoning`, `Programming.Average`,
 * `Science.Average` and `KnowledgeWork.Average` too, then threw them away. The
 * fields below that are absent today will start contributing as soon as
 * `refresh.js` stores them (no change needed here).
 */
export const COMPASS_FIELDS = Object.freeze({
  average: { kind: 'index', canonical: 'compass-average', table: 'ability' },
  knowledge: { canonical: 'compass-knowledge', dim: 'knowledge', table: 'ability' },
  reasoning: { canonical: 'compass-reasoning', dim: 'reasoning', table: 'ability' },
  abstraction: { canonical: 'compass-abstraction', dim: 'reasoning', table: 'ability' },
  agent: { canonical: 'compass-agent', dim: 'agentic', table: 'ability' },
  swePro: { canonical: 'swe-bench-pro', dim: 'coding', table: 'bench' },
  terminalBench: { canonical: 'terminal-bench', dim: 'agentic', table: 'bench' },
  hle: { canonical: 'hle', dim: 'reasoning', table: 'bench' },
  quantitativeReasoning: { canonical: 'compass-quantitative', dim: 'math', table: 'ability' },
  programmingAverage: { canonical: 'compass-programming', dim: 'coding', table: 'bench' },
  scienceAverage: { canonical: 'compass-science', dim: 'knowledge', table: 'bench' },
  knowledgeWorkAverage: { canonical: 'compass-knowledge-work', dim: 'agentic', table: 'bench' },
})

// ── price ───────────────────────────────────────────────────────────────────

/**
 * Price facts for one entry, in CNY per 1M tokens.
 *
 * The catalog's `price` is CNY (Bailian list prices). Artificial Analysis quotes
 * USD; its price is used only when the entry has no catalog price, is converted
 * at `cnyPerUsd`, and is flagged `converted: true` so a reader can tell a listed
 * price from a cross-referenced one. The blended number is the same 1:2
 * input:output weighting `select.js` uses, kept for comparability; the raw
 * components and the cache-hit price are reported separately so a cache-heavy
 * workload can price itself instead of inheriting the blend.
 *
 * @param {object} entry
 * @param {{cnyPerUsd?: number}} [options]
 */
export function priceOf(entry, options = {}) {
  const cnyPerUsd = num(options.cnyPerUsd) ?? PRICE_CNY_PER_USD
  const price = entry?.price ?? {}
  const input = num(price.input) !== null && price.input >= 0 ? price.input : null
  const output = num(price.output) !== null && price.output >= 0 ? price.output : null
  const cache = num(price.cacheHitInput) !== null && price.cacheHitInput >= 0 ? price.cacheHitInput : null
  if (input !== null || output !== null) {
    const i = input ?? (output ?? 0) / 3
    const o = output ?? i * 3
    return {
      input,
      output,
      cacheHitInput: cache,
      blended: round2((i + 2 * o) / 3),
      source: 'catalog',
      currency: 'CNY',
      converted: false,
      unpriced: false,
      partial: input === null || output === null,
      cacheRatio: cache !== null && i > 0 ? round2(cache / i) : null,
    }
  }
  const aa = entry?.crossChecks?.artificialAnalysis
  const aaIn = num(aa?.priceIn)
  const aaOut = num(aa?.priceOut)
  if (aaIn !== null && aaIn >= 0) {
    const i = aaIn * cnyPerUsd
    const o = (aaOut !== null ? aaOut : aaIn) * cnyPerUsd
    return {
      input: round2(i),
      output: round2(o),
      cacheHitInput: null,
      blended: round2((i + 2 * o) / 3),
      source: 'artificial-analysis',
      currency: 'CNY',
      converted: true,
      usd: { input: aaIn, output: aaOut },
      unpriced: false,
      partial: aaOut === null,
      cacheRatio: null,
    }
  }
  return {
    input: null,
    output: null,
    cacheHitInput: null,
    blended: null,
    source: null,
    currency: 'CNY',
    converted: false,
    unpriced: true,
    partial: false,
    cacheRatio: null,
  }
}

/**
 * Blended price at a given cache-hit rate on input tokens.
 *
 * The 1:2 blend prices every input token at the list rate; a workload that
 * repeats a preamble is cheaper than that whenever the provider bills a cache
 * hit. This is a calculator, not a ranking input: applying it needs the
 * operator's cache-hit rate, which no source knows.
 *
 * @param {ReturnType<typeof priceOf>} price
 * @param {number} cacheHitRate - 0..1 share of input tokens served from cache
 */
export function cacheAdjustedPrice(price, cacheHitRate = 0.5) {
  if (price === null || price === undefined || num(price.blended) === null) return null
  if (num(price.cacheHitInput) === null || num(price.input) === null) return price.blended
  const rate = clamp(num(cacheHitRate) ?? 0.5, 0, 1)
  const input = price.input * (1 - rate) + price.cacheHitInput * rate
  return round2((input + 2 * (price.output ?? price.input * 3)) / 3)
}

// ── measured serving speed ──────────────────────────────────────────────────

/**
 * 0-100 speed from measured TTFT and output tokens/s.
 *
 * The mapping is monotone and documented rather than fitted: 300 output
 * tokens/s is full marks, 0.3s to first token is full marks, and each halves
 * logarithmically. Speed is a serving property (provider-dependent), not a
 * model property, so the catalog's coarse `latency` class is kept as an
 * operator-facing filter and this number is only produced from measured rows.
 */
export function speedScore(ttftSeconds, tokensPerSecond) {
  const ttft = num(ttftSeconds) !== null && ttftSeconds > 0 ? ttftSeconds : null
  const tps = num(tokensPerSecond) !== null && tokensPerSecond > 0 ? tokensPerSecond : null
  if (ttft === null && tps === null) return null
  const tpsPart = tps === null ? 0.5 : clamp(Math.log10(tps) / Math.log10(300), 0, 1)
  const ttftPart = ttft === null ? 0.5 : clamp(1 - Math.log2(ttft / 0.3) / 4, 0, 1)
  return round1(clamp((0.6 * tpsPart + 0.4 * ttftPart) * 100, 0, 100))
}

/** Long-context capacity 0-100 from a context window (log scale, derived fact). */
export function contextScore(contextWindow) {
  const tokens = num(contextWindow)
  if (tokens === null || tokens <= 0) return null
  const lo = Math.log2(8000)
  const hi = Math.log2(1_048_576)
  return round1(clamp(((Math.log2(tokens) - lo) / (hi - lo)) * 100, 0, 100))
}

function servingOf(entry) {
  const llm = entry?.crossChecks?.llmLeaderboard
  const aa = entry?.crossChecks?.artificialAnalysis
  const serving = []
  if (num(llm?.ttftSeconds) !== null || num(llm?.tokensPerSecond) !== null) {
    serving.push({ channel: 'llm', family: 'llm', ttftSeconds: num(llm?.ttftSeconds), tokensPerSecond: num(llm?.tokensPerSecond) })
  }
  if (num(aa?.ttft) !== null || num(aa?.speed) !== null) {
    serving.push({ channel: 'aa', family: 'aa', ttftSeconds: num(aa?.ttft), tokensPerSecond: num(aa?.speed) })
  }
  return serving
}

function speedDimension(entry) {
  const serving = servingOf(entry)
  const scored = serving
    .map((row) => ({ ...row, score: speedScore(row.ttftSeconds, row.tokensPerSecond) }))
    .filter((row) => row.score !== null)
  if (scored.length === 0) {
    return {
      estimate: null,
      evidence: 0,
      confidence: 0,
      band: null,
      low: null,
      high: null,
      sources: [],
      families: {},
      spread: 0,
      flags: ['no-measurement'],
      derived: entry?.latency === undefined ? null : 'latency-class',
    }
  }
  const estimate = round1(mean(scored.map((row) => row.score)))
  const families = [...new Set(scored.map((row) => row.family))]
  return {
    estimate,
    evidence: scored.length,
    confidence: round2(clamp(0.4 + 0.2 * scored.length, 0, 0.9)),
    band: round1(clamp(12 / Math.sqrt(scored.length), 6, 18)),
    low: round1(clamp(estimate - 12 / Math.sqrt(scored.length), 0, 100)),
    high: round1(clamp(estimate + 12 / Math.sqrt(scored.length), 0, 100)),
    sources: scored.map((row) => ({ channel: row.channel, family: row.family, canonical: 'serving', raw: row.score, aligned: row.score })),
    families: Object.fromEntries(families.map((family) => [family, round1(mean(scored.filter((row) => row.family === family).map((row) => row.score)))])),
    spread: families.length >= 2 ? round1(Math.max(...scored.map((row) => row.score)) - Math.min(...scored.map((row) => row.score))) : 0,
    flags: families.length >= 2 ? [] : ['single-source'],
    derived: null,
  }
}

// ── source observations ─────────────────────────────────────────────────────

/**
 * Pull every leaf measurement an entry carries, per channel.
 *
 * Channels are kept separate because they need separate alignment: BenchGecko's
 * values are already on the axis, CompassRank/AA/llmleaderboard values are not.
 * Families are kept separate from channels because the *origin* of a benchmark
 * decides agreement: BenchGecko republishing an Artificial Analysis row is an
 * AA measurement on BenchGecko's axis.
 *
 * @param {object} entry - catalog entry
 * @param {object|null} analysisRow - matched row from a raw Artificial Analysis table
 */
export function sourceObservations(entry, analysisRow = null) {
  const list = []
  const indexes = []
  const unknown = []
  const zero = []

  // BenchGecko leaf table. `benchmarks` is BenchGecko's raw benchmark → score map,
  // already on BenchGecko's normalized scale; a 0 means "no sample", per the
  // extractor comment, so it is counted but not scored.
  for (const [label, value] of Object.entries(entry?.benchmarks ?? {})) {
    const score = num(value)
    if (score === null) continue
    if (score <= 0) {
      zero.push({ channel: 'benchgecko', label, raw: score })
      continue
    }
    const hit = classifyBenchmark(label, 'benchgecko')
    if (hit.kind === 'dimension') list.push({ channel: 'benchgecko', family: hit.family, canonical: hit.canonical, dim: hit.dim, raw: score })
    else if (hit.kind === 'index') indexes.push({ channel: 'benchgecko', family: hit.family, canonical: hit.canonical, raw: score })
    else unknown.push({ channel: 'benchgecko', label, raw: score })
  }

  // CompassRank boards, as the compiler stored them on crossChecks.
  const compass = entry?.crossChecks?.compassRank
  for (const [field, mapping] of Object.entries(COMPASS_FIELDS)) {
    const value = num(compass?.[field])
    if (value === null || value <= 0) continue
    if (mapping.kind === 'index') indexes.push({ channel: 'compass', family: 'compass', canonical: mapping.canonical, raw: value })
    else list.push({ channel: 'compass', family: 'compass', canonical: mapping.canonical, dim: mapping.dim, table: mapping.table, raw: value })
  }

  // Artificial Analysis per-benchmark scores. Preferred source: a refreshed
  // catalog entry, which stores percentages under crossChecks; fallback: the raw
  // scraped table passed via options.analysis, whose rows carry 0-1 fractions
  // (and a handful of index-scaled fields that are reported, not scored).
  const aaStored = entry?.crossChecks?.artificialAnalysis?.benchmarks
  if (aaStored !== null && typeof aaStored === 'object') {
    for (const [id, value] of Object.entries(aaStored)) {
      const score = num(value)
      // A zero is "the benchmark did not run", not "the model scored nothing".
      // Averaging those zeros into a dimension understated every model AA did not
      // test in full -- `coding = mean(livecodebench 97.2, scicode 0, ...) = 36`
      // is an artefact, not a measurement. The extractor keeps them out too; this
      // is the consumer-side guard for catalogs written before that change.
      if (score === null || score <= 0 || score > 100) {
        if (score !== null && score > 100) indexes.push({ channel: 'aa', family: 'aa', canonical: normalizeLabel(id), raw: score })
        continue
      }
      const hit = classifyBenchmark(id, 'aa')
      if (hit.kind === 'dimension') list.push({ channel: 'aa', family: 'aa', canonical: hit.canonical, dim: hit.dim, raw: score })
      else if (hit.kind === 'index') indexes.push({ channel: 'aa', family: 'aa', canonical: hit.canonical, raw: score })
      else unknown.push({ channel: 'aa', label: id, raw: score })
    }
  } else if (analysisRow !== null && typeof analysisRow === 'object') {
    for (const [id, value] of Object.entries(analysisRow.scores ?? {})) {
      const raw = num(value)
      if (raw === null || raw <= 0) continue
      // AA's `scores` mixes 0-1 percentages with index-scaled point values
      // (gdpval-normalized ~1e3, aa-3d ~1e3, sometimes negative). Only in-range
      // fractions are percentages; everything else is an index signal.
      if (raw > 1) {
        indexes.push({ channel: 'aa', family: 'aa', canonical: normalizeLabel(id), raw })
        continue
      }
      const score = round1(raw * 100)
      const hit = classifyBenchmark(id, 'aa')
      if (hit.kind === 'dimension') list.push({ channel: 'aa', family: 'aa', canonical: hit.canonical, dim: hit.dim, raw: score })
      else if (hit.kind === 'index') indexes.push({ channel: 'aa', family: 'aa', canonical: hit.canonical, raw: score })
      else unknown.push({ channel: 'aa', label: id, raw: score })
    }
  }

  // llmleaderboard benchmark tracks: independent per-track scores, fastest
  // serving measurement kept by the extractor.
  for (const [track, value] of Object.entries(entry?.crossChecks?.llmLeaderboard?.benchmarks ?? {})) {
    const score = num(value)
    if (score === null || score <= 0) continue
    const hit = classifyBenchmark(track, 'llm')
    if (hit.kind === 'dimension') list.push({ channel: 'llm', family: 'llm', canonical: hit.canonical, dim: hit.dim, raw: score })
    else if (hit.kind === 'index') indexes.push({ channel: 'llm', family: 'llm', canonical: hit.canonical, raw: score })
    else unknown.push({ channel: 'llm', label: track, raw: score })
  }

  return { list, indexes, unknown, zero }
}

// ── alignment ───────────────────────────────────────────────────────────────

/**
 * Fit the affine map from one channel/dimension's raw scale onto the axis.
 *
 * `pairs` are `[axisValue, sourceValue]`. With fewer than `minOverlap` pairs
 * the fit is refused: a two-point calibration is a guess and would silently put
 * one source's scale into every model. With fewer than `minSlopeOverlap` pairs
 * only the median offset is fitted — a slope through four points is noise, and
 * the current compiler learned that too. Above the slope threshold the
 * least-squares slope is shrunk halfway to 1 (`slopeShrink`) so that a handful
 * of outliers cannot rewrite the axis; the offset is then chosen so the fit
 * passes through the pair means.
 *
 * @param {Array<[number, number]>} pairs
 * @param {{minOverlap?: number, minSlopeOverlap?: number, slopeShrink?: number}} [options]
 */
export function fitAlignment(pairs, options = {}) {
  // Explicit `number` checks (not `num`): `Infinity` is a meaningful request to
  // disable slope fitting for a caller whose pairs are not independent.
  const minOverlap = typeof options.minOverlap === 'number' ? options.minOverlap : MIN_ALIGN_OVERLAP
  const minSlopeOverlap = typeof options.minSlopeOverlap === 'number' ? options.minSlopeOverlap : MIN_SLOPE_OVERLAP
  const shrink = clamp(typeof options.slopeShrink === 'number' ? options.slopeShrink : SLOPE_SHRINK, 0, 1)
  const usable = pairs.filter(([axis, source]) => num(axis) !== null && num(source) !== null)
  const n = usable.length
  if (n < minOverlap) return null
  const xs = usable.map(([, source]) => source)
  const ys = usable.map(([axis]) => axis)
  if (n < minSlopeOverlap) {
    const offset = median(usable.map(([axis, source]) => axis - source))
    return {
      status: 'calibrated',
      mode: 'offset',
      offset: round2(offset),
      slope: 1,
      n,
      residualRms: round2(rms(usable.map(([axis, source]) => axis - (source + offset)))),
    }
  }
  const mx = mean(xs)
  const my = mean(ys)
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - mx) * (ys[i] - my)
    denominator += (xs[i] - mx) ** 2
  }
  const rawSlope = denominator > 0 ? numerator / denominator : 1
  const slope = clamp(1 + (rawSlope - 1) * shrink, 0.2, 5)
  const offset = my - slope * mx
  return {
    status: 'calibrated',
    mode: 'linear-shrunk',
    offset: round2(offset),
    slope: round2(slope),
    n,
    residualRms: round2(rms(usable.map(([axis, source]) => axis - (slope * source + offset)))),
  }
}

/** Anchor values the axis owner (BenchGecko) supplies: per model, by dimension and by canonical benchmark. */
function axisAnchors(entries) {
  const byDimension = new Map()
  const byBenchmark = new Map()
  for (const row of entries) {
    const dims = {}
    const benchmarks = {}
    for (const observation of row.observations.list) {
      if (observation.channel !== 'benchgecko') continue
      if (dims[observation.dim] === undefined) dims[observation.dim] = []
      dims[observation.dim].push(observation.raw)
      if (benchmarks[observation.canonical] === undefined) benchmarks[observation.canonical] = []
      benchmarks[observation.canonical].push(observation.raw)
    }
    for (const [dim, values] of Object.entries(dims)) dims[dim] = mean(values)
    for (const [canonical, values] of Object.entries(benchmarks)) benchmarks[canonical] = mean(values)
    if (Object.keys(dims).length > 0) byDimension.set(row.key, dims)
    if (Object.keys(benchmarks).length > 0) byBenchmark.set(row.key, benchmarks)
  }
  return { byDimension, byBenchmark }
}

/**
 * `fitAlignment`'s option names, taken from the ranking settings.
 *
 * The settings call these thresholds `minAlignOverlap`/`minSlopeOverlap` while
 * `fitAlignment` reads `minOverlap`/`minSlopeOverlap`; passing the settings object
 * straight through left both undefined, so every fit silently used the hard-coded
 * default. That is why raising the threshold changed nothing.
 */
function alignmentOptions(settings, minOverlap = settings.minAlignOverlap) {
  return {
    minOverlap,
    minSlopeOverlap: settings.minSlopeOverlap,
    slopeShrink: settings.slopeShrink,
  }
}

function fitChannels(entries, settings) {
  const anchors = axisAnchors(entries)
  const benchmarkFits = new Map()
  const groupFits = new Map()
  const dimFits = new Map()
  const calibration = {
    benchgecko: { axis: 'owner' },
    compass: {},
    aa: {},
    llm: {},
    benchmarks: { compass: {}, aa: {}, llm: {} },
    groups: { compass: {} },
  }

  for (const channel of ['compass', 'aa', 'llm']) {
    // 1. Equate the *same benchmark* across channels where both sides measured it.
    //    This is the strongest calibration available, and it is what stops
    //    CompassRank's ability table (frontier near 78) from being applied as if
    //    it were its benchmark table (frontier much lower).
    const canonicals = new Set()
    for (const row of entries) {
      for (const observation of row.observations.list) if (observation.channel === channel) canonicals.add(observation.canonical)
    }
    for (const canonical of canonicals) {
      const pairs = []
      for (const row of entries) {
        const axis = anchors.byBenchmark.get(row.key)?.[canonical]
        if (num(axis) === null) continue
        const values = row.observations.list
          .filter((observation) => observation.channel === channel && observation.canonical === canonical)
          .map((observation) => observation.raw)
        if (values.length === 0) continue
        pairs.push([axis, mean(values)])
      }
      const fit = fitAlignment(pairs, alignmentOptions(settings))
      if (fit !== null) {
        benchmarkFits.set(`${channel}:${canonical}`, fit)
        calibration.benchmarks[channel][canonical] = { ...fit }
      } else if (pairs.length > 0) {
        calibration.benchmarks[channel][canonical] = { status: 'insufficient-overlap', n: pairs.length }
      }
    }

    // 2. Dimension-level fallback: mean-shift equating against the axis, used
    //    only for observations' benchmark that has no direct equivalent. This is
    //    the pre-existing method, kept and reported as the weaker option.
    for (const dim of DIMENSIONS) {
      if (dim === 'overall') continue
      const pairs = []
      for (const row of entries) {
        const axis = anchors.byDimension.get(row.key)?.[dim]
        if (num(axis) === null) continue
        const values = row.observations.list
          .filter((observation) => observation.channel === channel && observation.dim === dim)
          .map((observation) => observation.raw)
        if (values.length === 0) continue
        pairs.push([axis, mean(values)])
      }
      const fit = fitAlignment(pairs, alignmentOptions(settings, settings.minDimensionOverlap ?? MIN_DIMENSION_OVERLAP))
      if (fit !== null) {
        dimFits.set(`${channel}:${dim}`, fit)
        calibration[channel][dim] = { ...fit, mode: 'dimension' }
      } else {
        calibration[channel][dim] = {
          status: pairs.length === 0 ? 'no-observations' : 'insufficient-overlap',
          n: pairs.length,
          mode: 'dimension',
        }
      }
    }
  }

  // 3. CompassRank publishes two tables on different scales (`ability` and
  //    `bench`), so a board's position cannot be equated by a single dimension
  //    offset that mixes them. Fit one location shift per (table, dimension),
  //    offset-only: the pairs are not independent (one model contributes several
  //    boards) and a scale fit would be over-confident.
  for (const table of ['ability', 'bench']) {
    calibration.groups.compass[table] = {}
    for (const dim of DIMENSIONS) {
      if (dim === 'overall') continue
      const pairs = []
      for (const row of entries) {
        const axis = anchors.byDimension.get(row.key)?.[dim]
        if (num(axis) === null) continue
        const values = row.observations.list
          .filter((observation) => observation.channel === 'compass' && observation.table === table && observation.dim === dim)
          .map((observation) => observation.raw)
        if (values.length === 0) continue
        pairs.push([axis, mean(values)])
      }
      const fit = fitAlignment(pairs, { ...settings, minSlopeOverlap: Number.POSITIVE_INFINITY })
      if (fit !== null) {
        groupFits.set(`compass:${table}:${dim}`, fit)
        calibration.groups.compass[table][dim] = { ...fit, mode: 'group' }
      } else {
        calibration.groups.compass[table][dim] = {
          status: pairs.length === 0 ? 'no-observations' : 'insufficient-overlap',
          n: pairs.length,
          mode: 'group',
        }
      }
    }
  }

  return { benchmarkFits, groupFits, dimFits, calibration }
}

/**
 * The alignment one observation gets, best first: same-benchmark equating, then
 * a publisher table's group offset (CompassRank), then the dimension mean shift,
 * then nothing.
 */
function alignmentFor(observation, fits) {
  if (observation.channel === 'benchgecko') return { offset: 0, slope: 1, mode: 'axis' }
  const benchmarkFit = fits.benchmarkFits.get(`${observation.channel}:${observation.canonical}`)
  if (benchmarkFit !== undefined) return { ...benchmarkFit, mode: 'benchmark' }
  if (observation.channel === 'compass' && observation.table !== undefined) {
    const groupFit = fits.groupFits.get(`compass:${observation.table}:${observation.dim}`)
    if (groupFit !== undefined) return { ...groupFit, mode: 'group' }
  }
  const dimFit = fits.dimFits.get(`${observation.channel}:${observation.dim}`)
  if (dimFit !== undefined) return { ...dimFit, mode: 'dimension' }
  return null
}

// ── merging one model ───────────────────────────────────────────────────────

function familyMeans(observations) {
  const byFamily = {}
  for (const observation of observations) {
    if (byFamily[observation.family] === undefined) byFamily[observation.family] = []
    byFamily[observation.family].push(observation.aligned)
  }
  return Object.fromEntries(Object.entries(byFamily).map(([family, values]) => [family, round1(mean(values))]))
}

function mergedDimension(dim, canonicalItems, observations, settings) {
  const values = canonicalItems.map((item) => item.value)
  const evidence = canonicalItems.length
  // Shrink a thin estimate toward the neutral prior. One benchmark is an opinion
  // about a dimension, not a measurement of it: without shrinkage a model with a
  // single high score (say livecodebench 97 aligned) got a whole-dimension value
  // of 97 and could outrank fully measured models. Weight 2 means one observation
  // counts a third, ten count five sixths -- and nothing is hidden: the evidence
  // count and `prior-shrunk` flag travel with the estimate.
  const observed = mean(values)
  const priorWeight = num(settings.evidencePriorWeight, EVIDENCE_PRIOR_WEIGHT)
  const estimate = round1((evidence * observed + priorWeight * 50) / (evidence + priorWeight))
  const families = familyMeans(observations)
  const familyKeys = Object.keys(families)
  const spread = familyKeys.length >= 2 ? round1(Math.max(...Object.values(families)) - Math.min(...Object.values(families))) : 0
  const flags = []
  if (familyKeys.length < 2) flags.push('single-source')
  else if (spread > settings.disagreementPoints) flags.push('disagreement')
  const weak = observations.some((observation) => observation.channel !== 'benchgecko' && num(observation.alignmentRms) !== null && observation.alignmentRms > WEAK_CALIBRATION_RMS)
  if (weak) flags.push('weak-calibration')
  if (evidence <= 2) flags.push('prior-shrunk')
  const band = round1(clamp(6 / Math.sqrt(evidence) + spread / 2, 2, 30))
  const agreementFactor = familyKeys.length >= 2 ? (spread <= settings.disagreementPoints ? 1 : 0.6) : 0.7
  const confidence = round2(clamp((evidence / (evidence + 3)) * agreementFactor * (weak ? 0.85 : 1), 0.05, 1))
  return {
    estimate,
    evidence,
    confidence,
    band,
    low: round1(clamp(estimate - band, 0, 100)),
    high: round1(clamp(estimate + band, 0, 100)),
    sources: observations.map((observation) => ({
      channel: observation.channel,
      family: observation.family,
      canonical: observation.canonical,
      raw: round1(observation.raw),
      aligned: round1(observation.aligned),
      alignment: observation.alignment,
    })),
    families,
    spread,
    flags,
    derived: null,
  }
}

function compiledDimension(dim, score, evidence) {
  return {
    estimate: round1(score),
    evidence,
    confidence: round1(clamp(0.2 + 0.05 * evidence, 0, 0.55)),
    band: 15,
    low: round1(clamp(score - 15, 0, 100)),
    high: round1(clamp(score + 15, 0, 100)),
    sources: [{ channel: 'compiled', family: 'compiled', canonical: `compiled:${dim}`, raw: round1(score), aligned: round1(score) }],
    families: { compiled: round1(score) },
    spread: 0,
    flags: ['compiled-composite', 'not-decomposed'],
    derived: null,
  }
}

function mergeModelDimensions(row, fits, settings) {
  const dims = {}
  const aligned = []
  const uncalibrated = []
  const byDim = {}

  for (const observation of row.observations.list) {
    const fit = alignmentFor(observation, fits)
    if (fit === null) {
      uncalibrated.push({ channel: observation.channel, canonical: observation.canonical, dim: observation.dim })
      continue
    }
    const alignedValue = clamp(observation.raw * fit.slope + fit.offset, 0, 100)
    const record = { ...observation, aligned: round1(alignedValue), alignment: fit.mode ?? 'dimension', alignmentRms: fit.residualRms ?? null }
    aligned.push(record)
    if (byDim[observation.dim] === undefined) byDim[observation.dim] = []
    byDim[observation.dim].push(record)
  }

  for (const dim of DIMENSIONS) {
    if (dim === 'overall' || dim === 'speed') continue
    const observations = byDim[dim] ?? []
    const grouped = new Map()
    for (const observation of observations) {
      if (grouped.has(observation.canonical)) grouped.get(observation.canonical).push(observation)
      else grouped.set(observation.canonical, [observation])
    }
    const canonicalItems = [...grouped.entries()].map(([canonical, list]) => ({
      canonical,
      value: round1(mean(list.map((observation) => observation.aligned))),
    }))
    if (canonicalItems.length > 0) {
      dims[dim] = mergedDimension(dim, canonicalItems, observations, settings)
      continue
    }
    // A compiled score is a legitimate measurement when the leaf table cannot be
    // decomposed, but only if the compiler recorded at least one sample. An
    // evidence count of 0 means the number is a hand-written prior; it is never
    // promoted here.
    const compiledEvidence = int(row.entry?.evidence?.[dim])
    const compiledScore = num(row.entry?.scores?.[dim])
    if (compiledEvidence > 0 && compiledScore !== null) dims[dim] = compiledDimension(dim, compiledScore, compiledEvidence)
  }
  return { dims, aligned, uncalibrated }
}

// ── model features ──────────────────────────────────────────────────────────

function featuresOf(entry, settings) {
  const modalities = Array.isArray(entry?.modalities) ? [...entry.modalities] : null
  const serving = servingOf(entry)
  return {
    contextWindow: num(entry?.contextWindow),
    maxOutput: num(entry?.maxOutput),
    modalities,
    hasVision: modalities === null ? null : modalities.some((modality) => modality === 'image' || modality === 'video'),
    reasoning: typeof entry?.reasoning === 'boolean' ? entry.reasoning : null,
    toolCalling: typeof entry?.toolCalling === 'boolean' ? entry.toolCalling : null,
    structuredOutput: typeof entry?.structuredOutput === 'boolean' ? entry.structuredOutput : null,
    parallelTools: typeof entry?.parallelTools === 'boolean' ? entry.parallelTools : null,
    mcp: typeof entry?.mcp === 'boolean' ? entry.mcp : null,
    explicitCache: typeof entry?.explicitCache === 'boolean' ? entry.explicitCache : null,
    retired: entry?.retired === true,
    preview: entry?.preview === true,
    sunsetAt: typeof entry?.sunsetAt === 'string' ? entry.sunsetAt : null,
    latencyClass: ['fast', 'balanced', 'slow'].includes(entry?.latency) ? entry.latency : null,
    serving,
    speed: speedDimension(entry),
    price: priceOf(entry, settings),
  }
}

function derivedDimension(kind, estimate, evidenceNote) {
  if (estimate === null) {
    return { estimate: null, evidence: 0, confidence: 0, band: null, low: null, high: null, sources: [], families: {}, spread: 0, flags: ['no-measurement'], derived: evidenceNote }
  }
  return {
    estimate: round1(estimate),
    evidence: 0,
    confidence: 0.3,
    band: null,
    low: null,
    high: null,
    sources: [],
    families: {},
    spread: 0,
    flags: ['derived', 'no-benchmark'],
    derived: kind,
  }
}

function overallDimension(dims, settings) {
  const parts = CORE_DIMENSIONS.filter((dim) => num(dims[dim]?.estimate) !== null)
  if (parts.length === 0) return null
  const weightSum = parts.reduce((sum, dim) => sum + COMPOSITE_WEIGHTS[dim], 0)
  const composite = round1(parts.reduce((sum, dim) => sum + COMPOSITE_WEIGHTS[dim] * dims[dim].estimate, 0) / weightSum)
  const evidence = parts.reduce((sum, dim) => sum + dims[dim].evidence, 0)
  const coverage = parts.length / CORE_DIMENSIONS.length
  const missingPenalty = (CORE_DIMENSIONS.length - parts.length) * (settings.missingDimensionPenalty ?? MISSING_DIMENSION_PENALTY)
  const band = round1(
    parts.reduce((sum, dim) => sum + COMPOSITE_WEIGHTS[dim] * (dims[dim].band ?? 12), 0) / weightSum
    + missingPenalty,
  )
  const confidence = round2(clamp(
    parts.reduce((sum, dim) => sum + COMPOSITE_WEIGHTS[dim] * dims[dim].confidence, 0) / weightSum
    * (0.6 + 0.4 * coverage),
    0.05,
    1,
  ))
  return {
    estimate: composite,
    evidence,
    confidence,
    band,
    low: round1(clamp(composite - band, 0, 100)),
    high: round1(clamp(composite + band, 0, 100)),
    sources: [],
    families: {},
    spread: 0,
    flags: [],
    derived: null,
    coverage: round2(coverage),
  }
}

// ── Artificial Analysis rows (optional raw scraped table) ───────────────────

/**
 * Match raw Artificial Analysis rows to catalog keys.
 *
 * The join is deliberately narrow: a row matches a key only when its normalized
 * name equals the normalized model id (or the id after the provider/reseller
 * prefix). The refresh path's fuzzy `matchAnalysisRow` is not reused because it
 * demonstrably mis-joined some ids in the shipped runtime catalog; identity is
 * `provider/model` and the join should not invent it. Rows that match nothing
 * are reported, not dropped.
 */
function buildAnalysisRows(entries, analysis) {
  const map = new Map()
  const report = { provided: 0, joined: 0, unmatched: 0, variants: 0 }
  if (!Array.isArray(analysis) || analysis.length === 0) return { map, report }
  report.provided = analysis.length
  const keysByName = new Map()
  const add = (name, key) => {
    const normalized = normalizeName(name)
    if (normalized.length === 0) return
    const list = keysByName.get(normalized) ?? []
    if (!list.includes(key)) list.push(key)
    keysByName.set(normalized, list)
  }
  for (const row of entries) {
    add(row.key, row.key)
    add(bareId(row.key), row.key)
  }
  const byKey = new Map()
  for (const row of analysis) {
    if (row === null || typeof row !== 'object' || typeof row.name !== 'string') continue
    const names = [row.name, String(row.name).replace(/\([^)]*\)/g, ' ')]
    const matched = new Set()
    for (const name of names) for (const key of keysByName.get(normalizeName(name)) ?? []) matched.add(key)
    if (matched.size === 0) {
      report.unmatched += 1
      continue
    }
    report.joined += 1
    for (const key of matched) {
      const list = byKey.get(key) ?? []
      list.push(row)
      byKey.set(key, list)
    }
  }
  // Several AA rows can describe one catalog id: reasoning-effort variants
  // ("(Non-reasoning)", "(High)", "(Max)"). Keep one deterministically — the row
  // with the most benchmark scores, then the highest index, then lexicographic
  // name — because blending variants would average across inference settings.
  for (const [key, rows] of byKey) {
    const chosen = [...rows].sort((a, b) => {
      const countA = Object.keys(a.scores ?? {}).length
      const countB = Object.keys(b.scores ?? {}).length
      if (countA !== countB) return countB - countA
      return (num(b.intelligenceIndex) ?? -1) - (num(a.intelligenceIndex) ?? -1) || String(a.name).localeCompare(String(b.name))
    })[0]
    if (rows.length > 1) report.variants += rows.length - 1
    map.set(key, chosen)
  }
  return { map, report }
}

// ── the table ───────────────────────────────────────────────────────────────

function rowSignals(entry, analysisRow) {
  const epoch = entry?.crossChecks?.epoch
  const aa = entry?.crossChecks?.artificialAnalysis
  const compassAverage = num(entry?.crossChecks?.compassRank?.average)
  return {
    epoch: num(epoch?.eci) !== null ? { eci: num(epoch.eci), date: epoch?.date ?? null } : null,
    aaIndex: num(aa?.intelligenceIndex) !== null && aa.intelligenceIndex > 0 ? aa.intelligenceIndex : null,
    compassAverage,
    analysisIndex: num(analysisRow?.intelligenceIndex) !== null && analysisRow.intelligenceIndex > 0 ? analysisRow.intelligenceIndex : null,
    llmServing: entry?.crossChecks?.llmLeaderboard ?? null,
    artificialAnalysis: aa ?? null,
  }
}

function compareModels(a, b) {
  if (a.status !== b.status) {
    const order = { [STATUS.MEASURED]: 0, [STATUS.PROVISIONAL]: 1, [STATUS.UNMEASURED]: 2 }
    return order[a.status] - order[b.status]
  }
  // Rank on the conservative lower bound, not the point estimate: a model whose
  // two measured dimensions happen to be its best ones must not outrank a model
  // measured on all five. The band already charges for missing coverage and for
  // source disagreement, so the lower bound is where those facts bite.
  if (a.rankValue !== b.rankValue) return (b.rankValue ?? -1) - (a.rankValue ?? -1)
  if (a.composite !== b.composite) return (b.composite ?? -1) - (a.composite ?? -1)
  if (a.evidence !== b.evidence) return b.evidence - a.evidence
  const priceA = a.features?.price?.blended ?? Number.POSITIVE_INFINITY
  const priceB = b.features?.price?.blended ?? Number.POSITIVE_INFINITY
  if (priceA !== priceB) return priceA - priceB
  return a.key.localeCompare(b.key)
}

/**
 * Build the ranking table for a catalog.
 *
 * @param {Record<string, object>} dataset - catalog keyed by `provider/model`
 * @param {{analysis?: object[]|null, cnyPerUsd?: number, minAlignOverlap?: number, disagreementPoints?: number, minIndexFit?: number}} [options]
 * @returns {object} table
 */
export function rankTable(dataset, options = {}) {
  const settings = { ...DEFAULTS, ...options }
  const entries = []
  for (const [key, entry] of Object.entries(dataset ?? {})) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    entries.push({ key, entry })
  }

  const { map: analysisRows, report: analysisReport } = buildAnalysisRows(entries, settings.analysis)
  for (const row of entries) {
    row.analysis = analysisRows.get(row.key) ?? null
    row.signals = rowSignals(row.entry, row.analysis)
    row.observations = sourceObservations(row.entry, row.analysis)
    row.features = featuresOf(row.entry, settings)
  }

  // 1. Align every non-axis channel onto BenchGecko's axis.
  const channels = fitChannels(entries, settings)
  const calibration = channels.calibration
  const fits = { benchmarkFits: channels.benchmarkFits, groupFits: channels.groupFits, dimFits: channels.dimFits }

  // 2. Merge per dimension, then fill measurement-free dimensions from facts.
  for (const row of entries) {
    const merged = mergeModelDimensions(row, fits, settings)
    row.dims = merged.dims
    row.aligned = merged.aligned
    row.uncalibrated = merged.uncalibrated
    if (row.dims.longContext === undefined) {
      row.dims.longContext = derivedDimension('context-window', contextScore(row.features.contextWindow), 'context-window')
    }
    if (row.dims.vision === undefined) {
      const hasVision = row.features.hasVision
      row.dims.vision = hasVision === null
        ? derivedDimension('modalities', null, 'modalities')
        : derivedDimension('modalities', hasVision ? 100 : 0, 'modalities')
    }
    row.dims.speed = row.features.speed
    const overall = overallDimension(row.dims, settings)
    if (overall !== null) row.dims.overall = overall
  }

  // 3. Provisional overall from AA's index, only for entries with no dimension
  //    measurement at all. The index is fitted to the composite of measured
  //    models (affine, its own scale), used alone, and marked provisional.
  const indexPairs = entries
    .filter((row) => row.dims.overall !== undefined && row.signals.aaIndex !== null)
    .map((row) => [row.dims.overall.estimate, row.signals.aaIndex])
  const indexFit = indexPairs.length >= settings.minIndexFit
    ? fitAlignment(indexPairs, {
        minOverlap: settings.minIndexFit,
        minSlopeOverlap: settings.minIndexFit,
        slopeShrink: SLOPE_SHRINK,
      })
    : null
  // `fitAlignment` maps source → axis; the pair is [composite, index], so its
  // slope and offset map an AA index onto the composite axis, which is exactly
  // what the provisional fallback needs.
  for (const row of entries) {
    if (row.dims.overall !== undefined) continue
    const legacyQuality = num(row.entry?.quality)
    const index = row.signals.aaIndex ?? row.signals.analysisIndex
    if (index !== null && indexFit !== null) {
      const composite = round1(clamp(indexFit.slope * index + indexFit.offset, 0, 100))
      row.dims.overall = {
        estimate: composite,
        evidence: 1,
        confidence: 0.15,
        band: 20,
        low: round1(clamp(composite - 20, 0, 100)),
        high: round1(clamp(composite + 20, 0, 100)),
        sources: [{ channel: 'aa-index', family: 'aa', canonical: 'intelligence-index', raw: index, aligned: composite }],
        families: { aa: composite },
        spread: 0,
        flags: ['index-only', 'provisional'],
        derived: 'aa-index-calibrated',
        provisional: true,
      }
    }
    row.legacyQuality = legacyQuality
  }

  // 4. Cost percentiles are derived from the pool, not from a fixed 0.4-60 CNY
  //    log window. The absolute cost index stays available for the *explicit*
  //    envelopes, which are documented in those terms; the percentile is the
  //    data-derived axis `derivedEnvelopes()` uses.
  const priced = entries.filter((row) => num(row.features.price.blended) !== null)
  const sortedPrices = priced.map((row) => row.features.price.blended).sort((a, b) => a - b)
  for (const row of entries) {
    const blended = row.features.price.blended
    row.costPercentile = blended === null || sortedPrices.length === 0
      ? null
      : round1(percentileRank(sortedPrices, blended))
    const absolute = blended === null ? null : costIndex({ price: { input: row.features.price.input, output: row.features.price.output } })
    row.features.costIndex = absolute
    row.features.costPercentile = row.costPercentile
  }

  // 5. Status, ranks, dim quantiles.
  for (const row of entries) {
    const overall = row.dims.overall
    row.measured = overall !== undefined && overall.provisional !== true && overall.evidence > 0
    row.provisional = overall !== undefined && overall.provisional === true
    row.status = row.measured ? STATUS.MEASURED : row.provisional ? STATUS.PROVISIONAL : STATUS.UNMEASURED
    row.composite = overall?.estimate ?? null
    row.compositeBand = overall?.band ?? null
    row.compositeLow = overall?.low ?? null
    row.compositeHigh = overall?.high ?? null
    row.confidence = overall?.confidence ?? 0
    row.evidence = overall?.evidence ?? 0
    row.coverage = overall?.coverage ?? 0
    row.rankValue = row.measured ? (row.compositeLow ?? row.composite) : null
    row.decomposable = Object.values(row.dims).some((dim) => dim.evidence > 0 && dim.flags.includes('not-decomposed') === false)
    row.provider = typeof row.entry.provider === 'string' ? row.entry.provider : null
    row.model = bareId(row.key)
    row.family = familyOf(row.key)
    row.label = typeof row.entry.label === 'string' && row.entry.label.length > 0 ? row.entry.label : row.model
    row.rank = null
    row.dimRanks = {}
    row.dimBands = {}
    row.notes = []
    if (row.provisional) row.notes.push('provisional: AA index only')
    if (row.status === STATUS.UNMEASURED && num(row.entry?.quality) !== null) row.notes.push('legacy quality ignored: no measured evidence')
    if (CORE_DIMENSIONS.some((dim) => row.dims[dim]?.flags?.includes('not-decomposed'))) row.notes.push('compiled composite fallback')
    if (row.measured && row.coverage < 1) row.notes.push(`partial coverage ${Math.round(row.coverage * CORE_DIMENSIONS.length)}/${CORE_DIMENSIONS.length}`)
  }

  const measuredRows = entries.filter((row) => row.measured && row.composite !== null).sort(compareModels)
  measuredRows.forEach((row, index) => { row.rank = index + 1 })

  const dimQuantiles = {}
  for (const dim of DIMENSIONS) {
    if (dim === 'overall') continue // the composite has its own quantiles block
    const values = entries
      .filter((row) => row.dims[dim] !== undefined && row.dims[dim].evidence > 0 && num(row.dims[dim].estimate) !== null)
      .map((row) => row.dims[dim].estimate)
    if (values.length === 0) continue
    dimQuantiles[dim] = {
      q25: round1(quantile(values, 0.25)),
      q50: round1(quantile(values, 0.5)),
      q75: round1(quantile(values, 0.75)),
      n: values.length,
    }
    const ranked = entries
      .filter((row) => row.dims[dim] !== undefined && row.dims[dim].evidence > 0 && num(row.dims[dim].estimate) !== null)
      .sort((a, b) => b.dims[dim].estimate - a.dims[dim].estimate || a.key.localeCompare(b.key))
    ranked.forEach((row, index) => {
      row.dimRanks[dim] = index + 1
      row.dimBands[dim] = row.dims[dim].estimate < dimQuantiles[dim].q25 ? 'low' : row.dims[dim].estimate < dimQuantiles[dim].q75 ? 'mid' : 'high'
    })
  }

  // 6. Cross-vendor Pareto view for display only (never used to disable a model).
  const pareto = paretoLayers(measuredRows
    .filter((row) => num(row.features.price.blended) !== null)
    .map((row) => ({ key: row.key, value: row.rankValue, cost: row.features.price.blended })))
  for (const row of entries) {
    row.paretoLayer = pareto.layerOf[row.key] ?? null
    row.onParetoFrontier = row.paretoLayer === 0
    row.dominatedByRank = pareto.dominatedBy[row.key] ?? null
  }

  // 7. Source agreement diagnostics. Epoch and AA's index are ordinal/own-scale
  //    signals: they are compared by rank, never averaged into a score.
  const compositePairs = (pick) => entries
    .filter((row) => row.measured && row.composite !== null && pick(row) !== null)
    .map((row) => [row.composite, pick(row)])
  const epochPairs = compositePairs((row) => row.signals.epoch?.eci ?? null)
  const aaPairs = compositePairs((row) => row.signals.aaIndex ?? row.signals.analysisIndex)
  const compassPairs = compositePairs((row) => row.signals.compassAverage)
  const sourceAgreement = {
    epoch: { n: epochPairs.length, spearman: spearman(epochPairs), note: 'interval scale: rank agreement only, never blended' },
    aaIndex: { n: aaPairs.length, spearman: spearman(aaPairs), note: "own index scale: used for provisional fallback and agreement, never blended" },
    compassAverage: { n: compassPairs.length, spearman: spearman(compassPairs) },
    indexFit: indexFit === null ? { status: 'insufficient-overlap', n: indexPairs.length } : { ...indexFit, pairs: indexPairs.length },
  }

  // 8. Coverage and unmapped-benchmark report. A benchmark we do not score is a
  //    known gap, so it is surfaced rather than hidden.
  const coverage = {}
  const unknown = new Map()
  const indexes = new Map()
  const uncalibrated = new Map()
  const alignmentModes = { axis: 0, benchmark: 0, group: 0, dimension: 0 }
  let uncalibratedCount = 0
  for (const row of entries) {
    uncalibratedCount += row.uncalibrated.length
    for (const item of row.uncalibrated) {
      const key = `${item.channel}:${item.canonical}:${item.dim}`
      const record = uncalibrated.get(key) ?? { channel: item.channel, canonical: item.canonical, dim: item.dim, models: [] }
      record.models.push(row.key)
      uncalibrated.set(key, record)
    }
    for (const observation of row.observations.list) {
      const entry = coverage[observation.channel] ??= { models: 0, observations: 0, dimensions: {} }
      entry.observations += 1
      entry.dimensions[observation.dim] = (entry.dimensions[observation.dim] ?? 0) + 1
    }
    for (const observation of row.aligned) {
      if (alignmentModes[observation.alignment] !== undefined) alignmentModes[observation.alignment] += 1
    }
    for (const item of row.observations.unknown) {
      const key = `${item.channel}:${item.label}`
      const record = unknown.get(key) ?? { channel: item.channel, label: item.label, models: [] }
      record.models.push(row.key)
      unknown.set(key, record)
    }
    for (const item of row.observations.indexes) {
      const key = `${item.channel}:${item.canonical}`
      const record = indexes.get(key) ?? { channel: item.channel, family: item.family, canonical: item.canonical, models: [] }
      record.models.push(row.key)
      indexes.set(key, record)
    }
  }
  for (const channel of Object.keys(coverage)) {
    coverage[channel].models = entries.filter((row) => row.observations.list.some((observation) => observation.channel === channel)).length
    coverage[channel].uncalibrated = entries.filter((row) => row.uncalibrated.some((item) => item.channel === channel)).length
  }

  const table = {
    models: entries,
    byKey: Object.fromEntries(entries.map((row) => [row.key, row])),
    calibration,
    quantiles: {
      composite: measuredRows.length === 0 ? null : {
        q25: round1(quantile(measuredRows.map((row) => row.composite), 0.25)),
        q50: round1(quantile(measuredRows.map((row) => row.composite), 0.5)),
        q75: round1(quantile(measuredRows.map((row) => row.composite), 0.75)),
        n: measuredRows.length,
      },
      rankValue: measuredRows.length === 0 ? null : {
        q25: round1(quantile(measuredRows.map((row) => row.rankValue), 0.25)),
        q50: round1(quantile(measuredRows.map((row) => row.rankValue), 0.5)),
        q75: round1(quantile(measuredRows.map((row) => row.rankValue), 0.75)),
        n: measuredRows.length,
      },
      dims: dimQuantiles,
    },
    pareto: { layerOf: pareto.layerOf, dominatedBy: pareto.dominatedBy, frontier: pareto.frontier },
    sourceAgreement,
    coverage: {
      channels: coverage,
      uncalibratedObservations: uncalibratedCount,
      uncalibrated: [...uncalibrated.values()],
      alignment: alignmentModes,
      analysisRows: analysisReport,
    },
    unknownBenchmarks: [...unknown.values()],
    indexSignals: [...indexes.values()],
    provisional: entries.filter((row) => row.provisional).map((row) => row.key),
    unmeasured: entries.filter((row) => row.status === STATUS.UNMEASURED).map((row) => row.key),
    measured: measuredRows.map((row) => row.key),
    settings: {
      cnyPerUsd: settings.cnyPerUsd,
      minAlignOverlap: settings.minAlignOverlap,
      minSlopeOverlap: settings.minSlopeOverlap,
      slopeShrink: settings.slopeShrink,
      disagreementPoints: settings.disagreementPoints,
      minIndexFit: settings.minIndexFit,
      missingDimensionPenalty: settings.missingDimensionPenalty,
    },
  }
  return table
}

/** Percentile rank (0-100) of a value inside an already sorted array. */
function percentileRank(sorted, value) {
  if (sorted.length <= 1) return 50
  const first = sorted.indexOf(value)
  const last = sorted.lastIndexOf(value)
  const position = (first + last) / 2
  return (position / (sorted.length - 1)) * 100
}

/**
 * Non-dominated layers of a cost/capability scatter.
 *
 * Layer 0 is the Pareto frontier (no other point is at least as capable and at
 * least as cheap, with one strict improvement), layer 1 is the frontier of the
 * remainder, and so on. Used for the visible ranking of the board; it compares
 * vendors, so it is deliberately never fed to the disabling rule.
 *
 * @param {Array<{key: string, value: number, cost: number}>} points
 */
export function paretoLayers(points) {
  const usable = points.filter((point) => num(point.value) !== null && num(point.cost) !== null)
  const dominates = (other, point) => other.key !== point.key
    && other.value >= point.value
    && other.cost <= point.cost
    && (other.value > point.value || other.cost < point.cost)
  const remaining = [...usable]
  const layerOf = {}
  let layer = 0
  while (remaining.length > 0) {
    const frontier = remaining.filter((point) => !remaining.some((other) => dominates(other, point)))
    for (const point of frontier) layerOf[point.key] = layer
    if (frontier.length === 0) break
    for (const point of frontier) remaining.splice(remaining.indexOf(point), 1)
    layer += 1
  }
  // Report the actual dominator from the full set, not only from the points that
  // happen to share the loser's layer.
  const dominatedBy = {}
  for (const point of usable) {
    if (layerOf[point.key] === 0) continue
    const dominator = usable.find((other) => dominates(other, point))
    if (dominator !== undefined) dominatedBy[point.key] = dominator.key
  }
  return { layerOf, dominatedBy, frontier: Object.keys(layerOf).filter((key) => layerOf[key] === 0) }
}

// ── tier grouping derived from the data ─────────────────────────────────────

/**
 * Envelopes whose cost and quality ceilings are quantiles of the current pool.
 *
 * The shipped envelopes (maxCost 55/85/100, minQuality 40/55/66) are constants
 * from a catalog that no longer exists: a refresh adds models, prices move, and
 * a fixed cost index still admits the same count. Deriving the thresholds from
 * the pool makes a tier mean "the cheap/median/strong end of what is actually
 * routable", and recomputing on every refresh is the point.
 *
 * `maxCost` is a *percentile*, not `select.js`'s absolute log cost index:
 * `costAxis: 'percentile'` tells the envelope check which axis to read.
 * `minQuality` is the merged composite (0-100) — the same axis `select.js`
 * already uses for `minQuality`. Latency classes are not fitted: the class is an
 * operator-facing filter and a measured TTFT is exposed separately.
 *
 * @param {object} table - result of {@link rankTable}
 * @param {{quantiles?: object}} [options]
 */
export function derivedEnvelopes(table, options = {}) {
  const quantiles = options.quantiles ?? {
    maxCost: { fast: 0.4, balanced: 0.75, deep: 1 },
    minQuality: { fast: 0.25, balanced: 0.5, deep: 0.75 },
    maxLatency: { fast: 'fast', balanced: 'balanced', deep: 'slow' },
  }
  const measured = table.models.filter((row) => row.measured && row.composite !== null && row.features?.price?.blended !== null)
  if (measured.length < MIN_DERIVED_ENVELOPE_SAMPLE) {
    return { valid: false, reason: `only ${measured.length} measured, priced models`, envelopes: {}, sample: measured.length }
  }
  // The envelope check reads the conservative lower bound, so the thresholds are
  // quantiles of that same distribution; otherwise "fast admits the bottom
  // quartile" would silently become a different share.
  const composites = measured.map((row) => row.rankValue ?? row.composite)
  const envelopes = {}
  let previousQuality = -1
  let previousCost = -1
  for (const tier of TIER_IDS) {
    // `maxCost` is a percentile by construction: on the percentile axis the
    // threshold *is* the target share of the pool the tier may buy.
    const maxCost = round1(clamp(quantiles.maxCost[tier], 0, 1) * 100)
    const minQuality = Math.round(quantile(composites, quantiles.minQuality[tier]))
    // Tiers are ordered ceilings; enforce monotonicity so "cheapest that admits"
    // can never place a model by accident of a flat quantile.
    const safeCost = Math.max(previousCost, maxCost)
    const safeQuality = Math.max(previousQuality + 1, minQuality)
    envelopes[tier] = {
      maxCost: safeCost,
      maxLatency: quantiles.maxLatency[tier],
      minQuality: safeQuality,
      costAxis: 'percentile',
      source: 'derived',
      sample: measured.length,
    }
    previousCost = safeCost
    previousQuality = safeQuality
  }
  return { valid: true, sample: measured.length, envelopes }
}

/**
 * Model passes one envelope.
 *
 * Unknown cost fails a cost ceiling and unknown latency fails a latency ceiling:
 * an unpriced model cannot prove it is cheap, and the old "treat unpriced as
 * mid-priced" fallback put unknown prices into a tier by assumption.
 *
 * `minQuality` is compared against the conservative lower bound by default
 * (`qualityBasis: 'low'`), matching the "a model that cannot prove it clears
 * the floor does not clear it" rule the router already has. `'point'` restores
 * comparison against the point estimate for operators who prefer it.
 *
 * @param {object} model
 * @param {object} envelope
 * @param {{qualityBasis?: 'low'|'point'}} [options]
 */
export function fitsEnvelope(model, envelope, options = {}) {
  if (envelope === null || envelope === undefined) return true
  const { maxCost, maxLatency, minQuality, costAxis } = envelope
  if (num(maxCost) !== null && maxCost > 0) {
    const cost = costAxis === 'percentile' ? model.features?.costPercentile : model.features?.costIndex
    if (cost === null || cost === undefined || cost > maxCost) return false
  }
  if (typeof maxLatency === 'string' && LATENCY_RANK[maxLatency] !== undefined) {
    const rank = LATENCY_RANK[model.features?.latencyClass]
    if (rank === undefined || rank > LATENCY_RANK[maxLatency]) return false
  }
  if (num(minQuality) !== null && minQuality > 0) {
    const quality = options.qualityBasis === 'point' ? model.composite : (model.rankValue ?? model.composite)
    if (num(quality) === null || quality < minQuality) return false
  }
  return true
}

/** Cheapest tier whose envelope admits the model, or null. */
export function autoTierForModel(model, envelopes, options = {}) {
  for (const tier of TIER_IDS) {
    const envelope = envelopes?.[tier]
    if (envelope === undefined || envelope === null) continue
    if (fitsEnvelope(model, envelope, options)) return tier
  }
  return null
}

/**
 * Place the table into the three stable tier names.
 *
 * Precedence is unchanged from `tiers.js`, because operators already reason with
 * it: disabled > hand-assigned tier > measured > cheapest admitting envelope >
 * dominated. What changes:
 *
 * - the envelope may be derived from the data (`envelopeMode: 'derived'|'merge'`)
 *   instead of the fixed shipped ceilings, while explicit operator values win
 *   field by field in `merge`;
 * - a provisional (AA-index-only) or unmeasured model is not auto-placed; it is
 *   listed separately, and only `allowProvisional` lets the calibration place it;
 * - dominance is still same-family only, so no vendor is switched off because
 *   another vendor is cheaper. The cross-vendor Pareto ranking lives on the
 *   table for display, not in this function;
 * - each group carries a visible `ranking` (tier-aware score) and `band`, which
 *   is the ranking the operator could not previously see.
 *
 * `force <tier>`, `defaultRoute` and the selector contract are untouched: they
 * pick a *group* by name, and the groups here have the same three names.
 *
 * @param {object} table - result of {@link rankTable}
 * @param {{routes?: object, overrides?: object, disabled?: string[], mode?: 'auto'|'manual', envelopeMode?: 'explicit'|'merge'|'derived', derived?: ReturnType<typeof derivedEnvelopes>, allowProvisional?: boolean, dominance?: boolean}} [options]
 */
export function planTiers(table, options = {}) {
  const routes = options.routes ?? {}
  const mode = options.mode === 'manual' ? 'manual' : 'auto'
  const overrides = options.overrides ?? {}
  const disabled = new Set(Array.isArray(options.disabled) ? options.disabled : [])
  const envelopeMode = options.envelopeMode ?? 'explicit'
  const derived = options.derived ?? derivedEnvelopes(table)
  const allowProvisional = options.allowProvisional === true
  const dominance = options.dominance !== false
  const qualityBasis = options.qualityBasis === 'point' ? 'point' : 'low'

  const envelopes = {}
  const envelopeSource = {}
  for (const tier of TIER_IDS) {
    const explicit = routes[tier]?.envelope
    if (envelopeMode === 'derived') {
      envelopes[tier] = derived.valid ? derived.envelopes[tier] : null
      envelopeSource[tier] = derived.valid ? 'derived' : 'none'
    } else if (envelopeMode === 'merge') {
      const base = derived.valid ? derived.envelopes[tier] : undefined
      envelopes[tier] = base === undefined ? (explicit ?? null) : { ...base, ...(explicit ?? {}) }
      envelopeSource[tier] = base === undefined ? (explicit === undefined ? 'none' : 'explicit') : 'merged'
      if (explicit !== undefined && num(explicit.maxCost) !== null) envelopes[tier].costAxis = 'absolute'
    } else {
      envelopes[tier] = explicit ?? null
      envelopeSource[tier] = explicit === undefined ? 'none' : 'explicit'
    }
  }

  const groups = Object.fromEntries(TIER_IDS.map((tier) => [tier, []]))
  groups.off = []
  const tierOf = {}
  const providerOf = {}
  const modelOf = {}
  const overridden = []
  const unassigned = []
  const unmeasured = []
  const provisional = []
  const dominated = []
  const placed = []

  for (const model of table.models) {
    const key = model.key
    modelOf[key] = model.model
    if (model.provider !== null) providerOf[key] = model.provider
    if (disabled.has(key)) {
      groups.off.push(key)
      tierOf[key] = 'off'
      continue
    }
    const override = overrides[key]
    if (TIER_IDS.includes(override)) {
      groups[override].push(key)
      tierOf[key] = override
      overridden.push(key)
      continue
    }
    if (mode === 'manual') {
      groups.off.push(key)
      tierOf[key] = 'off'
      unassigned.push(key)
      continue
    }
    if (!model.measured) {
      if (model.provisional) {
        provisional.push(key)
        // A provisional model has one calibrated index, not a measured
        // dimension; it is listed but not auto-placed unless the operator asks.
        if (!(allowProvisional && num(model.composite) !== null)) continue
      } else {
        unmeasured.push(key)
        continue
      }
    }
    const tier = autoTierForModel(model, envelopes, { qualityBasis })
    if (tier === null) {
      groups.off.push(key)
      tierOf[key] = 'off'
      unassigned.push(key)
      continue
    }
    groups[tier].push(key)
    tierOf[key] = tier
    placed.push(model)
  }

  if (mode === 'auto' && dominance) {
    for (const model of placed) {
      const winner = placed.find((other) => (
        other.key !== model.key
        && other.family === model.family
        && num(other.rankValue) !== null
        && num(model.rankValue) !== null
        && other.rankValue > model.rankValue
        && num(other.features.costIndex) !== null
        && num(model.features.costIndex) !== null
        && other.features.costIndex <= model.features.costIndex - DOMINANCE_COST_MARGIN
      ))
      if (winner === undefined) continue
      const tier = tierOf[model.key]
      const members = groups[tier]
      const position = members.indexOf(model.key)
      if (position >= 0) members.splice(position, 1)
      groups.off.push(model.key)
      tierOf[model.key] = 'off'
      dominated.push({
        key: model.key,
        by: winner.key,
        composite: model.composite,
        rankValue: model.rankValue,
        winnerComposite: winner.composite,
        winnerRankValue: winner.rankValue,
        cost: model.features.costIndex,
        winnerCost: winner.features.costIndex,
      })
    }
  }

  // Visible ranking inside each tier: a tier is a budget and the order inside it
  // answers "which model does this budget actually buy?". The cost factor mirrors
  // select.js's tier cost weights, but this is a display order; selection still
  // computes its own utility.
  const ranking = {}
  const rankOf = {}
  for (const tier of TIER_IDS) {
    const members = groups[tier]
      .map((key) => table.byKey[key])
      .filter((model) => model !== undefined)
      .map((model) => ({
        key: model.key,
        // Rank on the conservative lower bound for the same reason as the global
        // rank: a tier's ordering should not reward missing coverage.
        score: round2((model.rankValue ?? model.composite ?? 0) - 0.15 * TIER_COST_FACTOR[tier] * (model.features.costIndex ?? 55)),
      }))
      .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    ranking[tier] = members.map((entry, index) => ({ ...entry, rank: index + 1 }))
    for (const entry of ranking[tier]) rankOf[entry.key] = entry.rank
  }

  return {
    mode,
    groups,
    tierOf,
    rankOf,
    ranking,
    providerOf,
    modelOf,
    overridden,
    dominated,
    disabled: [...disabled],
    unassigned,
    unmeasured,
    provisional,
    envelopes,
    envelopeSource,
    derivedSample: derived.valid ? derived.sample : 0,
  }
}

// ── catalog patch ───────────────────────────────────────────────────────────

/**
 * Turn the table into the `scores`/`evidence`/`quality` shape `select.js` reads.
 *
 * Every measured or derived dimension is written with its integer evidence
 * count. A dimension the table could not measure keeps the entry's previous
 * score (so the selector's existing behaviour is preserved) but *zeroes its
 * evidence*, which is what tells `select.js`'s uncertainty penalty that the
 * weight is unverified. This is the one place where an old number survives a
 * re-measurement, and it survives as a declared unknown rather than as new
 * evidence.
 *
 * @param {object} table
 * @returns {Record<string, {scores: Record<string, number|null>, evidence: Record<string, number>, quality: number|null, status: string}>}
 */
export function toCatalogPatch(table) {
  const patch = {}
  for (const model of table.models) {
    const scores = {}
    const evidence = {}
    for (const dim of DIMENSIONS) {
      const dimension = model.dims?.[dim]
      const estimate = num(dimension?.estimate)
      if (estimate !== null && dimension.evidence > 0) {
        scores[dim] = round1(estimate)
        evidence[dim] = int(dimension.evidence)
      } else if (estimate !== null) {
        // Derived fact (context window / modalities) or a calibrated index: a
        // number the selector may display, but not a measured dimension.
        scores[dim] = round1(estimate)
        evidence[dim] = 0
      } else {
        const legacy = num(model.entry?.scores?.[dim])
        scores[dim] = legacy === null ? null : round1(legacy)
        evidence[dim] = 0
      }
    }
    patch[model.key] = {
      scores,
      evidence,
      quality: model.composite === null ? null : round1(model.composite),
      qualityLow: model.compositeLow === null ? null : round1(model.compositeLow),
      status: model.status,
    }
  }
  return patch
}
