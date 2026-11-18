/**
 * Compile the two benchmark passes into the catalog the router reads.
 *
 * This module is the single place where measurements become scores: the build
 * script feeds it files captured by hand, and the runtime refresh action feeds
 * it live responses. Both go through the same arithmetic, so a refreshed
 * catalog cannot drift in method from a committed one.
 *
 * @param {object} input
 * @param {Record<string, object>} input.base - previous catalog (carries price, limits, modalities, notes)
 * @param {Record<string, object>} input.benchgecko - BenchGecko extractions by model id
 * @param {Record<string, object>} input.compass - CompassRank entries by leaderboard key
 * @param {Record<string, Record<string, number>>} [input.counts] - benchmark sample counts by slug then dimension
 * @returns {Record<string, object>} catalog keyed by model id
 */
export const COMPASS_ID = {
  'qwen3.8-max': 'qwen3.8-max',
  'qwen3.8-flash': 'qwen3.8-flash',
  'qwen4-max': 'qwen4-max',
  'glm-5.3': 'glm-5.3',
  'deepseek-flash': 'deepseek-v4.1-flash-1017',
  'kimi-k3': 'kimi-k3',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro-0813',
}
const K = 1.5
const DIMS = ['coding', 'reasoning', 'math', 'knowledge', 'agentic']

// Manual priors per model: what we believe before benchmarks, from vendor cards
// and sibling behaviour. Only used where BenchGecko has no samples, and always
// blended down by evidence.
const PRIOR = {
  'qwen3.8-flash':            { coding: 52, reasoning: 48, math: 50, knowledge: 44, agentic: 52, speed: 85 },
  'qwen3.8-max':              { coding: 68, reasoning: 66, math: 68, knowledge: 62, agentic: 66, speed: 60 },
  'qwen4-max':                { coding: 74, reasoning: 72, math: 74, knowledge: 70, agentic: 72, speed: 50 },
  'qwen4-max-preview':        { coding: 74, reasoning: 72, math: 74, knowledge: 70, agentic: 72, speed: 50 },
  'qwen3.7-plus':             { coding: 55, reasoning: 58, math: 60, knowledge: 55, agentic: 58, speed: 62 },
  'qwen3.7-flash':            { coding: 45, reasoning: 45, math: 47, knowledge: 44, agentic: 45, speed: 80 },
  'qwen3.6-flash':            { coding: 45, reasoning: 42, math: 40, knowledge: 40, agentic: 42, speed: 80 },
  'qwen3.7-max':              { coding: 68, reasoning: 73, math: 71, knowledge: 61, agentic: 55, speed: 45 },
  'deepseek-v4.1-flash-1017': { coding: 52, reasoning: 80, math: 70, knowledge: 50, agentic: 65, speed: 78 },
  'deepseek-v4.1-flash':      { coding: 50, reasoning: 72, math: 62, knowledge: 48, agentic: 45, speed: 78 },
  'deepseek-v4-pro-0813':     { coding: 50, reasoning: 74, math: 64, knowledge: 62, agentic: 50, speed: 35 },
  'deepseek-v4-pro':          { coding: 54, reasoning: 76, math: 60, knowledge: 56, agentic: 45, speed: 50 },
  'deepseek-v4-flash-0731':   { coding: 45, reasoning: 62, math: 55, knowledge: 50, agentic: 42, speed: 75 },
  'deepseek-v4-flash':        { coding: 45, reasoning: 62, math: 55, knowledge: 50, agentic: 42, speed: 75 },
  'glm-5.2':                  { coding: 56, reasoning: 60, math: 65, knowledge: 50, agentic: 48, speed: 55 },
  'glm-5.3':                  { coding: 58, reasoning: 60, math: 64, knowledge: 50, agentic: 57, speed: 55 },
  'kimi-k3':                  { coding: 55, reasoning: 69, math: 71, knowledge: 46, agentic: 48, speed: 55 },
}

const QUAL = {
  'deepseek-v4.1-flash-1017': {
    bestFor: ['agentic tool loops: long multi-step runs with recovery', 'reasoning-heavy review and root-cause analysis at flash price', 'vision input where the screenshot is the evidence', 'bulk implementation where 2/8 pricing compounds'],
    weaknesses: ['no coding benchmark published: SWE-style work is unmeasured', 'knowledge depth is mid (50.6); weak on niche factual recall', 'implicit cache only, so repeated preambles are not free'],
    distinguishing: ['384K max output covers whole-repo refactor rounds', 'off-peak bills at half price (1/4)'],
    latency: 'fast',
  },
  'deepseek-v4.1-flash': {
    bestFor: ['same lane as the 1017 snapshot but slightly weaker', 'vision input at flash price', 'tasks where the harness pins a stable alias, not a date'],
    weaknesses: ['reasoning and agentic trail the 1017 snapshot by 5-10 points', 'knowledge depth mid-low (47.8)', 'no coding benchmark evidence'],
    distinguishing: ['rolling alias: always the newest V4.1 Flash build'],
    latency: 'fast',
  },
  'deepseek-v4-flash-0731': {
    bestFor: ['legacy pin only; prefer deepseek-v4.1-flash-1017'],
    weaknesses: ['retired and unconfigured in this profile', 'coding 40.9, the weakest of the family', 'no cache-hit price'],
    distinguishing: ['cheapest DeepSeek build if a workload is frozen to it'],
    latency: 'fast',
  },
  'deepseek-v4-flash': {
    bestFor: ['legacy alias resolution; route to deepseek-v4.1-flash-1017 instead'],
    weaknesses: ['legacy name, superseded by the V4.1 line', 'no distinct capability'],
    distinguishing: ['resolves to the V4 flash family for old configs'],
    latency: 'fast',
  },
  'deepseek-v4-pro-0813': {
    bestFor: ['knowledge-heavy analysis where latency does not matter', 'long reasoning over dense documents', 'factual/spec questions needing recall'],
    weaknesses: ['speed 24.9: the slowest model in this catalog by a wide margin', 'coding 42.7 is poor for its price', 'text only'],
    distinguishing: ['knowledge 62.9, joint highest of the reasoning-first models'],
    latency: 'slow',
  },
  'deepseek-v4-pro': {
    bestFor: ['reasoning depth when the answer matters more than the wait', 'architectural critique and tradeoff analysis', 'text-only pipelines that must stay cheap-ish'],
    weaknesses: ['no vision', 'agentic tool use is unmeasured and weak in practice', '12 in / 24 out costs more than the newer 0813 for less'],
    distinguishing: ['reasoning 78.6 with no output-token penalty tier'],
    latency: 'balanced',
  },
  'qwen3.7-max': {
    bestFor: ['hardest coding: multi-file refactors, architecture, tricky debugging', 'math and quantitative reasoning that must be right', 'long-horizon autonomy with 1M context and 262K thinking'],
    weaknesses: ['slowest first token of the flagships (speed 47.5)', 'priciest text model here at 12 / 36', 'text only, no screenshot input'],
    distinguishing: ['262K reasoning budget in thinking mode', '5M TPM headroom for parallel agents'],
    latency: 'balanced',
  },
  'qwen3.7-plus': {
    bestFor: ['vision plus coding: UI screenshots, charts, GUI automation', 'mid-cost multimodal work at 2 / 8', 'long documents under 256K'],
    weaknesses: ['coding evidence is a single noisy benchmark (10.2)', '6 / 24 above 256K input', 'no published SWE-bench or agentic scores'],
    distinguishing: ['cheapest multimodal entry with full agent skills'],
    latency: 'balanced',
  },
  'qwen3.7-flash': {
    bestFor: ['cheapest possible text or vision pass at 0.2 / 0.8', 'classification, extraction and routing pre-passes', 'high-volume tagging with 10M TPM'],
    weaknesses: ['math 53.5 and general 6.4: not a reasoning model', 'superseded by qwen3.8-flash at similar price', 'thin benchmark coverage'],
    distinguishing: ['lowest input price in the catalog'],
    latency: 'fast',
  },
  'qwen3.6-flash': {
    bestFor: ['legacy compatibility only; prefer qwen3.8-flash'],
    weaknesses: ['reasoning 48.0, math 39.5: the weakest reasoning here', 'undercut by newer flash models', '64K output cap'],
    distinguishing: ['spatial vision for object detection and UI grounding'],
    latency: 'fast',
  },
  'qwen3.8-flash': {
    bestFor: ['cheap general workhorse: reads, edits with known location, summaries', 'vision input at 0.8 / 2.7', 'high-volume agent steps where cost dominates'],
    weaknesses: ['no third-party benchmarks yet: scores are vendor claims', 'reasoning depth well below the max tier', 'agentic coding claims are unverified externally'],
    distinguishing: ['0.8 / 2.7 with 1M context and vision, the cheapest capable multimodal'],
    latency: 'fast',
  },
  'qwen3.8-max': {
    bestFor: ['reasoning-heavy work when Qwen3.7-Max is unavailable', 'multimodal analysis of video and long documents', 'mid-priced balanced default'],
    weaknesses: ['no third-party benchmarks', 'same price band as qwen3.7-max with weaker coding evidence', 'vision input raises token cost'],
    distinguishing: ['video modality at max tier'],
    latency: 'balanced',
  },
  'qwen4-max': {
    bestFor: ['newest-generation reasoning and coding when price is secondary', 'long transcripts up to 1M with vision', 'the hardest single-shot problems'],
    weaknesses: ['expensive at 10 / 30 and slow (AA: 155s to first token)', 'very little independent benchmark coverage', 'overkill for routine edits'],
    distinguishing: ['AA Intelligence 43, the highest of any model in this catalog'],
    latency: 'slow',
  },
  'qwen4-max-preview': {
    bestFor: ['evaluation only: unpriced and scheduled to sunset 2026-11-25'],
    weaknesses: ['no published price and no benchmarks', 'preview id can change without notice', 'sunset in one week'],
    distinguishing: ['preview of Qwen4-Max; must not be used for durable routes'],
    latency: 'slow',
  },
  'glm-5.3': {
    bestFor: ['agentic workflows with structured output and function calling', 'mid-cost balanced default at 8 / 28', 'long-context tasks up to 1M'],
    weaknesses: ['coding 53.7 trails deepseek flash at 4x the price', 'knowledge 50.2 mid', 'text only'],
    distinguishing: ['APEX-Agents 56.6, strong agentic for its price', '1M context with explicit cache'],
    latency: 'balanced',
  },
  'glm-5.2': {
    bestFor: ['legacy pin; glm-5.3 supersedes it at the same price', 'code generation where the 5.3 behaviour regressed'],
    weaknesses: ['same price as glm-5.3 but weaker reasoning and agentic', 'text only', 'no vision'],
    distinguishing: ['coding 58.1 slightly above glm-5.3 in BenchGecko samples'],
    latency: 'balanced',
  },
  'kimi-k3': {
    bestFor: ['math-heavy and general reasoning that must be right', 'long-form writing and instruction following', '1M-context document work'],
    weaknesses: ['20 / 100 is 5-10x peers with similar scores', 'knowledge 45.5 is low for a flagship', 'agentic 47.8 trails cheaper models'],
    distinguishing: ['general 59.0, the highest general score in this catalog'],
    latency: 'balanced',
  },
}

export function buildDataset({ base, benchgecko, compass, counts }) {
const longContextOf = (ctx) => {
  if (typeof ctx !== 'number' || ctx <= 0) return 50
  const lo = Math.log2(8000), hi = Math.log2(1_048_576)
  return Math.round(Math.max(0, Math.min(100, ((Math.log2(ctx) - lo) / (hi - lo)) * 100)))
}

const blend = (observed, n, prior, quality) => {
  let score
  if (observed === undefined || observed === null) {
    score = prior
  } else {
    score = (n * observed + K * prior) / (n + K)
  }
  // A single benchmark category cannot be far above the model's normalized
  // composite: when it is, the benchmark set is narrow rather than the model
  // being uniformly excellent. Cap at +12, floor at -35 of the composite.
  if (typeof quality === 'number' && quality > 0) {
    score = Math.max(quality - 35, Math.min(quality + 12, score))
  }
  return { score: Math.round(score * 10) / 10, n }
}

// ── CompassRank → our nine dimensions ───────────────────────────────────────
// Each dimension is assembled from the CompassRank table that measures it:
// programming is SWE-bench Pro + Terminal-Bench, agentic pulls the Agent board
// plus Terminal-Bench and the knowledge-work suite, and so on. `null` when the
// model was not run on that board yet.
const mean = (vals) => {
  const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length
}
// BenchGecko reports 0 for a model it has no benchmark samples for; 0 is not a
// score in either source, so it never enters an alignment.
const positive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
const median = (vals) => {
  const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2
}

function compassDims(entry) {
  if (!entry) return null
  const a = entry.ability ?? {}
  const b = entry.bench ?? {}
  return {
    coding: mean([positive(b['Programming.Average']), positive(b['Programming.SWE-bench Pro Verified'])]),
    reasoning: mean([a.Reasoning, a.Abstraction]),
    math: mean([a['QuantitativeReasoning']]),
    knowledge: mean([a.Knowledge, positive(b['Science.Average'])]),
    agentic: mean([a.Agent, positive(b['Programming.Terminal-Bench 4.0']), positive(b['KnowledgeWork.Average'])]),
    overall: mean([a.Average]),
  }
}

// CompassRank runs on its own 0-100 scale (its frontier sits near 78 average,
// BenchGecko's near 68), so raw values cannot be averaged with BenchGecko's.
// Align per dimension by the mean shift observed on the models both sources
// measured, which keeps the ordering CompassRank found without importing its
// scale. Offset only: with four or so overlap points a slope fit is noise.
const COMPASS_W = 1.0
const alignOffset = (dim) => {
  const pairs = []
  for (const [cid, id] of Object.entries(COMPASS_ID)) {
    const c = compassDims(compass[cid])
    const g = positive(dim === 'overall' ? benchgecko[id]?.avg : benchgecko[id]?.scores?.[dim])
    const cv = positive(c?.[dim])
    if (g !== null && cv !== null) pairs.push([g, cv])
  }
  if (pairs.length < 2) return null
  // Median shift, not mean: with a handful of overlap models one outlier
  // decides a mean and the whole dimension inherits it.
  return median(pairs.map(([g, c]) => g - c))
}

const alignCount = (dim) => {
  let n = 0
  for (const [cid, id] of Object.entries(COMPASS_ID)) {
    const c = compassDims(compass[cid])
    const g = positive(dim === 'overall' ? benchgecko[id]?.avg : benchgecko[id]?.scores?.[dim])
    if (positive(c?.[dim]) !== null && g !== null) n += 1
  }
  return n
}

const OFFSET_RAW = {
  coding: alignOffset('coding'),
  reasoning: alignOffset('reasoning'),
  math: alignOffset('math'),
  knowledge: alignOffset('knowledge'),
  agentic: alignOffset('agentic'),
  overall: alignOffset('overall'),
}
// A dimension aligned from fewer than three overlapping models is not a
// calibration, it is a guess; those fall back to the overall shift.
const OFFSET = Object.fromEntries(
  Object.entries(OFFSET_RAW).map(([dim, v]) => [dim, alignCount(dim) >= 3 ? v : null]),
)
const overallOffset = OFFSET_RAW.overall ?? 0
const fallbackOffset = mean(Object.values(OFFSET).filter((v) => v !== null)) ?? overallOffset
// Scale alignment only: overall is the most robust anchor and every other
// dimension leans on it when its own evidence is thin.
const offsetOf = (dim) => (typeof OFFSET[dim] === 'number' ? OFFSET[dim] : (typeof OFFSET.overall === 'number' ? OFFSET.overall : fallbackOffset))

const alignedCompass = {}
for (const [cid, id] of Object.entries(COMPASS_ID)) {
  const dims = compassDims(compass[cid])
  if (!dims) continue
  alignedCompass[id] = Object.fromEntries(
    Object.entries(dims).map(([d, v]) => [d, typeof v === 'number' ? v + offsetOf(d) : v]),
  )
}

const COMPASS_REV = Object.fromEntries(Object.entries(COMPASS_ID).map(([c, i]) => [i, c]))
const compassKeyOf = (id) => COMPASS_REV[id]

const out = {}
for (const [id, old] of Object.entries(base)) {
  const ex = benchgecko[id]
  const prior = PRIOR[id]
  if (!prior) { out[id] = old; continue }
  const scores = {}
  const evidence = {}
  for (const dim of DIMS) {
    const obs = ex?.scores?.[dim]
    const n = ex?.scores?.[dim] !== undefined ? Math.max(1, (ex?.benchmarks ? countCat(ex, dim) : 1)) : 0
    const b = blend(obs, n, prior[dim], ex?.avg)
    const c = alignedCompass[id]?.[dim]
    if (typeof c === 'number') {
      // Both sources measured this dimension: weight by sample count, with the
      // CompassRank pass counted as COMPASS_W samples (each of its categories
      // is itself an average over many benchmark items).
      const total = n + COMPASS_W
      let merged = (n * b.score + COMPASS_W * c) / total
      const anchor = typeof ex?.avg === 'number' && ex.avg > 0 ? ex.avg : null
      if (anchor !== null) merged = Math.max(anchor - 35, Math.min(anchor + 14, merged))
      scores[dim] = Math.round(merged * 10) / 10
      evidence[dim] = Math.round(n + COMPASS_W)
    } else {
      scores[dim] = b.score
      evidence[dim] = b.n
    }
  }
  // `overall` is the model's normalized composite, the only cross-model-comparable
  // number we have; the selector anchors every shape on it.
  const compassOverall = alignedCompass[id]?.overall
  scores.overall = typeof ex?.avg === 'number' && ex.avg > 0
    ? (typeof compassOverall === 'number' ? Math.round(((ex.avg + COMPASS_W * compassOverall) / (1 + COMPASS_W)) * 10) / 10 : ex.avg)
    : typeof compassOverall === 'number'
      ? Math.round(compassOverall * 10) / 10
      : Math.round(DIMS.reduce((sum, d) => sum + scores[d], 0) / DIMS.length)
  evidence.overall = typeof compassOverall === 'number' ? COMPASS_W : 0
  scores.longContext = longContextOf(old.contextWindow)
  evidence.longContext = 0
  const hasImage = (old.modalities ?? []).some((m) => m === 'image' || m === 'video')
  scores.vision = hasImage ? 100 : 0
  evidence.vision = 0
  scores.speed = ex?.scores?.speed !== undefined
    ? blend(ex.scores.speed, Math.max(1, countCat(ex, 'speed')), prior.speed, ex?.avg).score
    : prior.speed
  evidence.speed = ex?.scores?.speed !== undefined ? Math.max(1, countCat(ex, 'speed')) : 0
  const q = QUAL[id] ?? {}
  out[id] = {
    label: old.label,
    contextWindow: old.contextWindow,
    maxOutput: old.maxOutput,
    price: old.price,
    modalities: old.modalities,
    toolCalling: old.toolCalling ?? true,
    reasoning: old.reasoning ?? true,
    structuredOutput: old.structuredOutput ?? true,
    parallelTools: old.parallelTools ?? false,
    mcp: old.mcp ?? false,
    explicitCache: (old.price?.cacheHitInput ?? null) !== null,
    latency: q.latency ?? old.latency ?? 'balanced',
    // The composite on BenchGecko's scale: its own average where we have one,
    // otherwise CompassRank's average through the same alignment offset.
    quality:
      typeof ex?.avg === 'number' && ex.avg > 0
        ? ex.avg
        : typeof compassOverall === 'number'
          ? Math.round(compassOverall * 10) / 10
          : null,
    scores,
    evidence,
    benchmarks: ex?.benchmarks ?? null,
    // Which passes actually contributed numbers, so a reader can tell a
    // two-source model from a prior-only one without diffing files.
    benchmarkSources: [
      ...(ex && typeof ex.avg === 'number' && ex.avg > 0 ? ['benchgecko'] : []),
      ...(typeof compassOverall === 'number' ? ['opencompass-compassrank'] : []),
    ],
    bestFor: q.bestFor ?? old.bestFor ?? [],
    weaknesses: q.weaknesses ?? old.weaknesses ?? [],
    distinguishing: q.distinguishing ?? [],
    crossChecks: compass[compassKeyOf(id)]
      ? {
          compassRank: {
            average: compass[compassKeyOf(id)].ability.Average ?? null,
            knowledge: compass[compassKeyOf(id)].ability.Knowledge ?? null,
            reasoning: compass[compassKeyOf(id)].ability.Reasoning ?? null,
            abstraction: compass[compassKeyOf(id)].ability.Abstraction ?? null,
            agent: compass[compassKeyOf(id)].ability.Agent ?? null,
            swePro: compass[compassKeyOf(id)].bench['Programming.SWE-bench Pro Verified'] ?? null,
            terminalBench: compass[compassKeyOf(id)].bench['Programming.Terminal-Bench 4.0'] ?? null,
            hle: compass[compassKeyOf(id)].bench['General.HLE-Diamond'] ?? null,
            evaluated: compass[compassKeyOf(id)].released ?? null,
            board: 'https://rank.opencompass.org.cn/leaderboard/llm',
          },
        }
      : undefined,
    sources: [...new Set([...(old.sources ?? []), ...(ex ? ['https://benchgecko.ai/model/' + ex.slug] : []), ...(compass[compassKeyOf(id)] ? ['https://rank.opencompass.org.cn/leaderboard/llm'] : [])])],
    notes: old.notes ?? null,
    ...(old.retired ? { retired: true, replaceWith: old.replaceWith } : {}),
    ...(old.preview ? { preview: true } : {}),
    ...(old.sunsetAt ? { sunsetAt: old.sunsetAt } : {}),
  }
}

function countCat(entry, dim) {
  const n = counts?.[entry?.slug]?.[dim]
  return typeof n === 'number' && n > 0 ? n : 1
}
  return out
}
