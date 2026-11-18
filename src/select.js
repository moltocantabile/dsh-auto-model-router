/**
 * Capability-based model selection.
 *
 * Three tiers (`fast`/`balanced`/`deep`) answer one question: how much model do
 * we buy? That is the wrong question at the boundary. Two models can sit in the
 * same price band and fail in opposite directions — one has the coding scores
 * but no vision, the other reads screenshots but cannot hold a refactor. A tier
 * name cannot express that, so this module does not use tiers to choose.
 *
 * The split of responsibility is deliberate:
 *
 * - The decision model is good at the part benchmarks cannot measure: reading a
 *   request and saying what *shape* of work it is, how deep it goes, how much of
 *   the codebase it touches, how much being wrong would cost, and whether the
 *   request needs sight or tools or speed. It emits a task *profile*.
 * - Choosing the model from that profile is arithmetic over measured capability
 *   scores. It is deterministic, explainable, and auditable — the operator can
 *   see exactly why a model won and by how much.
 *
 * Tiers still exist, because operators need to pin a ceiling and because a
 * routed model must have a name the harness can apply. They are a constraint on
 * the candidate set, not the decision.
 */

/**
 * Capability dimensions carried by every knowledge entry. Scores are 0-100 and
 * comparable across models within a dimension; they are *not* comparable across
 * dimensions (a 70 in coding is not a 70 in speed).
 */
export const DIMENSIONS = ['overall', 'coding', 'reasoning', 'math', 'knowledge', 'agentic', 'longContext', 'vision', 'speed']

/**
 * What each shape of work cares about, before the profile adjusts it.
 * Weights are relative and get normalized; a dimension absent here is 0.
 */
export const SHAPE_WEIGHTS = {
  // Read one thing and report it. Almost nothing matters except being fast,
  // being cheap, and having the fact somewhere in weights.
  lookup: { overall: 0.1, knowledge: 0.3, speed: 0.3, longContext: 0.1, coding: 0.05, reasoning: 0.1 },
  // Change one known place. Editing precision, not insight.
  edit: { overall: 0.15, coding: 0.4, speed: 0.2, knowledge: 0.1, reasoning: 0.1 },
  // Build something that does not exist yet. Coding plus a little design depth.
  implement: { overall: 0.2, coding: 0.4, reasoning: 0.22, agentic: 0.12, longContext: 0.1 },
  // Find a cause. Reasoning dominates; the code is evidence, not the task.
  debug: { overall: 0.2, reasoning: 0.36, coding: 0.28, agentic: 0.12, longContext: 0.1 },
  // Restructure without changing behaviour. Breadth and precision.
  refactor: { overall: 0.2, coding: 0.36, reasoning: 0.22, longContext: 0.18, agentic: 0.1 },
  // Decide how something should be built. Reasoning and knowledge over code.
  design: { overall: 0.25, reasoning: 0.4, knowledge: 0.18, coding: 0.18, longContext: 0.1 },
  // Judge existing work. Reasoning plus breadth, little generation.
  review: { overall: 0.2, reasoning: 0.36, coding: 0.22, knowledge: 0.14, longContext: 0.14 },
  // Write tests. Coding with breadth of the thing under test.
  test: { overall: 0.15, coding: 0.38, reasoning: 0.22, longContext: 0.15, agentic: 0.1 },
  // Explain or document. Fluency and knowledge, breadth of context.
  docs: { overall: 0.15, knowledge: 0.28, reasoning: 0.18, longContext: 0.2, speed: 0.15 },
  // Quantitative or logical analysis over data or a spec.
  analyze: { overall: 0.2, reasoning: 0.32, math: 0.22, longContext: 0.18, knowledge: 0.1 },
  // Read pixels: screenshots, diagrams, charts, UI states.
  inspect: { overall: 0.15, vision: 0.55, reasoning: 0.18, knowledge: 0.1 },
}

/**
 * How each tier weighs cost relative to capability. `fast` discounts the
 * expensive end, `deep` discounts price in favour of quality, `balanced` uses
 * the operator's costWeight as given.
 */
export const TIER_COST_FACTORS = { fast: 1.6, balanced: 1, deep: 0.05 }

export const PROFILES = [
  { id: 'lookup', label: 'lookup', hint: 'one fact, file, or line to read and report' },
  { id: 'edit', label: 'edit', hint: 'a change in a known place, no design decision' },
  { id: 'implement', label: 'implement', hint: 'build something new across a few files' },
  { id: 'debug', label: 'debug', hint: 'find why something is broken' },
  { id: 'refactor', label: 'refactor', hint: 'restructure existing code without changing behaviour' },
  { id: 'design', label: 'design', hint: 'decide how something should be built' },
  { id: 'review', label: 'review', hint: 'judge existing work for defects or risk' },
  { id: 'test', label: 'test', hint: 'write or repair tests' },
  { id: 'docs', label: 'docs', hint: 'explain, document, or summarise' },
  { id: 'analyze', label: 'analyze', hint: 'quantitative or logical analysis of data or a spec' },
  { id: 'inspect', label: 'inspect', hint: 'read pixels: screenshots, charts, UI state' },
]

/**
 * The task profile the decision model emits.
 * @typedef {object} TaskProfile
 * @property {string} shape - one of {@link PROFILES} ids.
 * @property {number} depth - 0-4 reasoning depth.
 * @property {number} breadth - 0-4 how much of the codebase is in play.
 * @property {number} risk - 0-4 cost of being wrong.
 * @property {boolean} vision - pixels must be read.
 * @property {boolean} tools - tool calling must work.
 * @property {boolean} latencyCritical - the user is waiting interactively.
 */

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

/**
 * Turn a profile into normalized dimension weights.
 *
 * The adjustments are the substance of the fine-grained routing: they are what
 * makes "implement, depth 3, breadth 3, high risk" prefer a different model than
 * "implement, depth 1, breadth 1, low risk" even though both are `implement`.
 *
 * @param {TaskProfile} profile
 * @returns {{weights: Record<string, number>, notes: string[]}}
 */
export function profileWeights(profile) {
  const shape = SHAPE_WEIGHTS[profile?.shape] ?? SHAPE_WEIGHTS.implement
  const weights = { ...shape }
  const notes = []
  const add = (dim, delta) => {
    weights[dim] = Math.max(0, (weights[dim] ?? 0) + delta)
  }

  const depth = clamp(num(profile?.depth, 2), 0, 4)
  const breadth = clamp(num(profile?.breadth, 2), 0, 4)
  const risk = clamp(num(profile?.risk, 1), 0, 4)

  // Depth: a shallow version of a task is an execution problem, a deep one is a
  // thinking problem. Move weight from hands to head as depth climbs.
  if (depth <= 1) {
    add('speed', 0.12)
    add('reasoning', -0.08)
  } else if (depth >= 3) {
    add('reasoning', 0.12 + 0.05 * (depth - 3))
    add('speed', -0.08)
    notes.push(`depth ${depth}: reasoning weighted up`)
  }

  // Breadth: one file can be held in one context; ten cannot.
  if (breadth >= 3) {
    add('longContext', 0.1 + 0.04 * (breadth - 3))
    add('agentic', 0.04)
    notes.push(`breadth ${breadth}: long-context weighted up`)
  } else if (breadth <= 1) {
    add('longContext', -0.15)
    add('speed', 0.06)
  }

  // Risk does not only add weight — it also raises the quality floor later. Here
  // it sharpens the shape's own primary dimensions.
  if (risk >= 2) {
    const primary = Object.entries(shape).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (primary !== undefined) add(primary, 0.08 * (risk - 1))
    notes.push(`risk ${risk}: ${primary} weighted up`)
  }

  if (profile?.latencyCritical === true) {
    add('speed', 0.18)
    notes.push('interactive: speed weighted up')
  }

  if (profile?.vision === true) {
    // A filtered candidate set does not need vision weighted too; keep it small
    // so it does not drown the dimension the work is actually about.
    weights.vision = Math.max(weights.vision ?? 0, 0.05)
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0)
  if (total > 0) for (const key of Object.keys(weights)) weights[key] = weights[key] / total
  return { weights, notes }
}

/**
 * Blended price per 1M tokens. Output tokens dominate real spend, so weight them
 * at the usual agent ratio of one in to two out.
 */
export function blendedPrice(info) {
  const input = info?.price?.input
  const output = info?.price?.output
  if (typeof input !== 'number' && typeof output !== 'number') return null
  const i = typeof input === 'number' ? input : (output ?? 0) / 3
  const o = typeof output === 'number' ? output : i * 3
  return (i * 1 + o * 2) / 3
}

/**
 * Cost index 0-100, log-scaled over the catalog's actual spread (roughly 0.4 to
 * 60 CNY blended). Cheap models crowd near 0 so that a 2x price difference
 * between two cheap models does not dominate a 5-point capability gap.
 */
export function costIndex(info) {
  const blended = blendedPrice(info)
  if (blended === null || blended <= 0) return 55
  const lo = Math.log2(0.4)
  const hi = Math.log2(60)
  return Math.round(clamp(((Math.log2(blended) - lo) / (hi - lo)) * 100, 0, 100))
}

/** How much evidence stands behind a model's scores, 0-1. */
export function evidenceConfidence(info) {
  const evidence = info?.evidence ?? {}
  const total = DIMENSIONS.reduce((sum, dim) => sum + num(evidence[dim], 0), 0)
  // 12 benchmark samples across dimensions is enough to trust the shape.
  return clamp(total / 12, 0, 1)
}

/**
 * Requirement floors implied by risk. A high-risk request should not land on a
 * model whose measured quality is poor just because it is cheap; this is the
 * "never the cheapest tier that can finish" rule expressed as arithmetic.
 */
export function qualityFloor(profile) {
  const risk = clamp(num(profile?.risk, 1), 0, 4)
  // The floor is "good enough for this risk", not "as good as possible". A
  // trivial task clears 36; a critical one needs 72. Above that floor extra
  // capability is worth only a fraction of its points (see scoreCandidate).
  return 36 + risk * 9
}

/**
 * Score one candidate against a profile.
 *
 * utility = weighted capability − cost penalty − risk penalty
 *
 * @param {object} candidate - {provider, model, info}
 * @param {object} weights - normalized dimension weights
 * @param {TaskProfile} profile
 * @param {{costWeight?: number, floor?: number}} options
 */
export function scoreCandidate(candidate, weights, profile, options = {}) {
  const info = candidate.info ?? {}
  const scores = info.scores ?? {}
  const costWeight = clamp(num(options.costWeight, 0.35), 0, 1)
  const floor = num(options.floor, qualityFloor(profile))

  let quality = 0
  let known = 0
  for (const dim of DIMENSIONS) {
    const w = num(weights[dim], 0)
    if (w === 0) continue
    const score = num(scores[dim], 50)
    quality += w * score
    known += w
  }
  if (known > 0) quality = quality / known

  const risk = clamp(num(profile?.risk, 1), 0, 4)

  // Capability is worth full credit up to the floor and only a fraction beyond
  // it, so "adequate and cheap" beats "strongest and dearest" on easy work.
  // The surplus rate rises with risk: when being wrong is expensive, headroom
  // above the floor starts to pay properly.
  const surplus = Math.max(0, quality - floor)
  const qualityTerm = Math.min(quality, floor) + surplus * (0.3 + 0.15 * risk)

  const cost = costIndex(info)
  // Cheap-ness matters most when the stakes are low: a trivial task should be
  // served by the cheapest adequate model, not the best one.
  const riskScale = 1 + (4 - risk) / 4
  const costPenalty = costWeight * riskScale * 0.4 * cost

  const gap = Math.max(0, floor - quality)
  const floorPenalty = gap * (1.5 + 0.8 * risk)
  const confidence = evidenceConfidence(info)
  // A model can look strong on the decisive dimension only because an unmeasured
  // dimension got a prior. Charge for that: the weight we could not verify is
  // weight we are guessing about on exactly the axis the task cares about.
  const evidence = info?.evidence ?? {}
  let unverified = 0
  for (const dim of DIMENSIONS) {
    const w = num(weights[dim], 0)
    if (w === 0) continue
    if (dim === 'vision' || dim === 'longContext' || dim === 'overall') continue
    if (num(evidence[dim], 0) === 0) unverified += w
  }
  const uncertaintyPenalty = (1 - confidence) * risk * 7 + unverified * (3 + 2 * risk)

  const utility = qualityTerm - costPenalty - floorPenalty - uncertaintyPenalty

  return {
    utility: Math.round(utility * 100) / 100,
    quality: Math.round(quality * 10) / 10,
    cost,
    costPenalty: Math.round(costPenalty * 10) / 10,
    floorPenalty: Math.round(floorPenalty * 10) / 10,
    uncertaintyPenalty: Math.round(uncertaintyPenalty * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    unverified: Math.round(unverified * 100) / 100,
    floor,
  }
}

/** Hard requirements a candidate must satisfy regardless of utility. */
function passesRequirements(candidate, profile, weights) {
  const info = candidate.info ?? {}
  if (profile?.vision === true) {
    const hasVision = (info.modalities ?? []).some((m) => m === 'image' || m === 'video')
    if (!hasVision) return 'needs vision'
  }
  if (profile?.tools === true && info.toolCalling === false) return 'needs tool calling'
  // Only drop a model for context when its window is *known* to be too small; an
  // unknown window is handled by the uncertainty penalty instead of a silent
  // exclusion (an entry we never measured should not look disqualified).
  if ((weights.longContext ?? 0) >= 0.12 && typeof info.contextWindow === 'number' && info.contextWindow < 200_000) {
    return 'needs long context'
  }
  if (info.retired === true) return 'retired'
  return null
}

/**
 * Rank candidates for a profile.
 *
 * @param {TaskProfile} profile
 * @param {Array<{provider: string, model: string, info: object|null, configured?: boolean}>} candidates
 * @param {{costWeight?: number, limit?: number}} [options]
 * @returns {{ranked: object[], weights: Record<string, number>, floor: number, excluded: object[]}}
 */
export function rankModels(profile, candidates, options = {}) {
  const { weights, notes } = profileWeights(profile)
  const floor = qualityFloor(profile)
  const costWeight = clamp(num(options.costWeight, 0.35), 0, 1)
  const ranked = []
  const excluded = []

  for (const candidate of candidates) {
    const reason = passesRequirements(candidate, profile, weights)
    if (reason !== null) {
      excluded.push({ provider: candidate.provider, model: candidate.model, reason })
      continue
    }
    const scored = scoreCandidate(candidate, weights, profile, { costWeight, floor })
    ranked.push({
      provider: candidate.provider,
      model: candidate.model,
      label: candidate.info?.label ?? candidate.model,
      configured: candidate.configured !== false,
      ...scored,
      reasons: explainCandidate(candidate, weights, scored, floor),
    })
  }

  // Utility first; ties break toward more evidence, then cheaper, then id for
  // determinism (a router that changes its mind on equal input is untestable).
  ranked.sort((a, b) => {
    if (Math.abs(b.utility - a.utility) > 0.05) return b.utility - a.utility
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    if (a.cost !== b.cost) return a.cost - b.cost
    return a.model.localeCompare(b.model)
  })

  const limit = num(options.limit, ranked.length)
  return { ranked: ranked.slice(0, limit), weights, floor, excluded, notes }
}

/** Short, human-readable justifications for one scored candidate. */
function explainCandidate(candidate, weights, scored, floor) {
  const info = candidate.info ?? {}
  const scores = info.scores ?? {}
  const reasons = []

  const top = Object.entries(weights)
    .filter(([, w]) => w > 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
  for (const [dim] of top) {
    const value = scores[dim]
    if (typeof value === 'number') reasons.push(`${dim} ${value}`)
  }
  if (scored.cost <= 20) reasons.push('cheap')
  else if (scored.cost >= 75) reasons.push('expensive')
  if (scored.floorPenalty > 0) reasons.push(`below quality floor ${Math.round(floor)}`)
  if (scored.confidence < 0.4) reasons.push('thin benchmark evidence')
  if (info.retired === true) reasons.push('retired')
  return reasons
}

/**
 * One-line summary of a ranking, for the tool, the log, and the config page.
 * @param {{ranked: object[], weights: Record<string,number>}} result
 */
export function describeRanking(result) {
  const winner = result?.ranked?.[0]
  if (winner === undefined) return 'no candidate satisfies the profile'
  const runnerUp = result.ranked[1]
  const margin = runnerUp === undefined ? null : Math.round((winner.utility - runnerUp.utility) * 100) / 100
  const parts = [`${winner.model} (utility ${winner.utility})`]
  if (runnerUp !== undefined) parts.push(`over ${runnerUp.model} by ${margin}`)
  if (winner.reasons.length > 0) parts.push(winner.reasons.join(', '))
  return parts.join(' · ')
}

/**
 * High-level entry point: rank candidates and pick the winner.
 *
 * @param {TaskProfile} profile - task profile from the decision model
 * @param {Array<{provider: string, model: string, info: object|null, configured?: boolean}>} candidates - model pool
 * @param {{costWeight?: number}} options
 * @returns {{selected: object|null, ranking: object, source: string}}
 */
export function selectBest(profile, candidates, options = {}) {
  const ranking = rankModels(profile, candidates, options)
  const winner = ranking.ranked[0]
  if (winner === undefined) {
    return { selected: null, ranking, source: 'no-candidates' }
  }
  return {
    selected: {
      provider: winner.provider,
      model: winner.model,
      label: winner.label,
      tier: winner.tier,
      reasons: winner.reasons,
      utility: winner.utility,
      quality: winner.quality,
      cost: winner.cost,
    },
    ranking,
    source: 'ranked',
  }
}
// ── tier envelopes ──────────────────────────────────────────────────────────
//
// A tier is a *ceiling*, not a model. Each one declares what it is willing to
// spend and what it insists on getting:
//
//   maxCost     cost index (0-100, see costIndex) the tier will not exceed
//   maxLatency  slowest latency class the tier tolerates: fast < balanced < slow
//   minQuality  measured quality a model must reach to be considered
//
// The router picks the tier from the task profile, then ranks the models that
// fit inside it — so the tier answers "how much model is worth buying here",
// and the model is still chosen on measured capability, never by pinning an id.

/** Latency classes, slowest last. */
export const LATENCY_RANK = { fast: 0, balanced: 1, slow: 2 }

/**
 * Demand score for a task, 0-4, on the same scale as the profile's own fields.
 * Risk dominates because being wrong on a risky task costs more than being slow
 * on a trivial one.
 *
 * `latencyCritical` pulls a cheap interactive turn down to the fastest tier, but
 * only while the task is genuinely small: low risk *and* shallow. Either alone
 * is not enough — a wrong answer from a fast model is worse than a slow answer
 * from a capable one, and "Continue" after a long task scores shallow risk while
 * being deep work. Capping on risk alone sent it to the cheapest model in the
 * pool; the profile's own scores stand above these limits, and interactive work
 * still prefers faster models within the tier it earned (see the speed weight
 * boost in `profileWeights`).
 */
export function profileDemand(profile) {
  const depth = clamp(num(profile?.depth, 1), 0, 4)
  const breadth = clamp(num(profile?.breadth, 1), 0, 4)
  const risk = clamp(num(profile?.risk, 1), 0, 4)
  const demand = 0.35 * depth + 0.15 * breadth + 0.5 * risk
  const mayDowngrade = profile?.latencyCritical === true && risk < 2 && depth <= 2
  return mayDowngrade ? Math.min(demand, 1) : demand
}

/**
 * Pick the tier a profile should be served from.
 *
 * @param {TaskProfile} profile
 * @param {Record<string, {envelope?: object}>} routes
 * @param {string} defaultRoute
 * @returns {string} tier id that exists in `routes`
 */
export function tierFor(profile, routes, defaultRoute = 'balanced') {
  const ids = Object.keys(routes ?? {})
  if (ids.length === 0) return defaultRoute
  const demand = profileDemand(profile)
  const ordered = demand <= 1.1 ? ['fast', 'balanced', 'deep'] : demand <= 2.5 ? ['balanced', 'deep', 'fast'] : ['deep', 'balanced', 'fast']
  for (const id of ordered) if (ids.includes(id)) return id
  return routes[defaultRoute] === undefined ? ids[0] : defaultRoute
}

/**
 * Whether a model fits a tier's envelope. A missing field means "no ceiling";
 * a model with no quality measurement fails a quality floor it cannot prove it
 * clears, and an unpriced model is treated as mid-priced (see `costIndex`).
 *
 * @param {object|null} info - knowledge entry for the model
 * @param {{maxCost?: number, maxLatency?: string, minQuality?: number}} envelope
 */
export function withinEnvelope(info, envelope) {
  if (envelope === null || envelope === undefined) return true
  const { maxCost, maxLatency, minQuality } = envelope
  if (typeof maxCost === 'number' && maxCost > 0 && costIndex(info) > maxCost) return false
  if (typeof maxLatency === 'string' && LATENCY_RANK[maxLatency] !== undefined) {
    const rank = LATENCY_RANK[info?.latency]
    if (rank === undefined || rank > LATENCY_RANK[maxLatency]) return false
  }
  if (typeof minQuality === 'number' && minQuality > 0) {
    const quality = num(info?.quality, null)
    if (quality === null || quality < minQuality) return false
  }
  return true
}

/**
 * Choose a tier, then select the best model inside it.
 *
 * Widening is explicit: if the chosen tier admits nothing, the default route's
 * tier is tried, and only then the unfiltered pool. The result says which
 * happened, so an over-tight envelope degrades into a logged fact rather than a
 * silent failure.
 *
 * @param {TaskProfile} profile
 * @param {Array<object>} candidates - the full pool
 * @param {Record<string, {envelope?: object}>} routes
 * @param {{costWeight?: number, defaultRoute?: string, membership?: Record<string, Set<string>>}} options
 * @returns {{selected: object|null, ranking: object, tier: string, widened: boolean, eligible: number}}
 */
export function selectForTier(profile, candidates, routes, options = {}) {
  const tier = tierFor(profile, routes, options.defaultRoute ?? 'balanced')
  // Each tier orders its pool by what it is for. Inside `fast` a strong model
  // that costs six times more is not a better answer, so cost weighs heavier
  // there; inside `deep` the operator has already said the work is hard, so
  // quality leads. Without this the whole pool ranks by one cost weight, the
  // cheapest model that clears the floor wins everywhere, and the tier label
  // stops meaning anything.
  const factors = options.tierFactors === undefined ? TIER_COST_FACTORS : { ...TIER_COST_FACTORS, ...options.tierFactors }
  const tierFactor = factors[tier] ?? 1
  const scoped = { ...options, costWeight: (options.costWeight ?? 0.35) * tierFactor }
  const order = [...new Set([tier, options.defaultRoute, null])]
  let lastRanking = { ranked: [], excluded: [] }
  let fallback = tier
  // Tier membership, when the router has assigned models to tiers. Membership
  // replaces the envelope filter rather than joining it: the assignment already
  // decided which envelope a model answers to, and intersecting the two would
  // drop a model the operator deliberately dragged into a tighter tier.
  const membership = options.membership ?? null
  for (const id of order) {
    const envelope = id === null ? null : routes?.[id]?.envelope
    const allowed = id === null || membership === null ? null : membership[id]
    const eligible = allowed !== null && allowed !== undefined
      ? candidates.filter((candidate) => allowed.has(candidate.key ?? candidate.model))
      : envelope === null || envelope === undefined
        ? candidates
        : candidates.filter((candidate) => withinEnvelope(candidate.info, envelope))
    if (eligible.length === 0) continue
    const ranking = rankModels(profile, eligible, scoped)
    const winner = ranking.ranked[0]
    if (winner === undefined) {
      lastRanking = ranking
      continue
    }
    return {
      selected: {
        provider: winner.provider,
        model: winner.model,
        label: winner.label,
        tier: id ?? tier,
        reasons: winner.reasons,
        utility: winner.utility,
        quality: winner.quality,
        cost: winner.cost,
      },
      ranking,
      tier: id ?? tier,
      widened: id !== tier,
      eligible: eligible.length,
      ...(allowed === null || allowed === undefined ? {} : { membership: allowed.size }),
    }
  }
  return { selected: null, ranking: lastRanking, tier: fallback, widened: true, eligible: 0 }
}
