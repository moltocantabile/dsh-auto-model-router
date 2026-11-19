/**
 * Automatic tier assignment.
 *
 * A tier is an envelope — a cost ceiling, a latency ceiling, a quality floor.
 * Asking the operator to also point every tier at a named model means choosing
 * twice for the same decision, and the named model then wins even when a better
 * one enters the catalog tomorrow. So membership is computed from measurement:
 * a model joins the cheapest tier whose envelope it satisfies, which puts the
 * strong-and-cheap models where the router can actually use them and leaves
 * `deep` for what cannot be served any cheaper.
 *
 * The operator still overrules the computation, per model: drag one to another
 * tier, or switch it off. Those overrides are the only hand-made assignments.
 */
import { boardMetaOf, hasMeasuredQuality, legacyQuality, qualityBasis } from './basis.js'
import { bareId, familyOf } from './identity.js'
import { costIndex, withinEnvelope } from './select.js'

export { boardMetaOf } from './basis.js'
export { familyOf } from './identity.js'

/** How much cheaper a model must be to justify a lower quality by "dominance". */
const DOMINANCE_COST_MARGIN = 10

/** Measured quality of a candidate on the same basis the tiers are fitted on. */
const qualityOf = (info) => {
  const quality = qualityBasis(info)
  return quality === null ? 0 : quality
}

/**
 * Which field of each envelope rejected a model, per tier.
 *
 * Mirrors `withinEnvelope` exactly, including the provenance rule (a derived
 * floor is compared with the measured basis, a hand-written one with the legacy
 * score), so the card's explanation cannot disagree with the assignment.
 *
 * @param {object|null} info
 * @param {{[tier: string]: {envelope?: object}}} routes
 * @returns {{[tier: string]: string[]}}
 */
function failedEnvelopes(info, routes) {
  const failed = {}
  const cost = costIndex(info)
  for (const tier of TIER_IDS) {
    const envelope = routes?.[tier]?.envelope
    if (envelope === null || envelope === undefined) continue
    const fields = []
    if (typeof envelope.maxCost === 'number' && envelope.maxCost > 0 && cost > envelope.maxCost) fields.push('cost')
    if (typeof envelope.maxLatency === 'string') {
      const rank = { fast: 0, balanced: 1, slow: 2 }[String(info?.latency ?? '')]
      const limit = { fast: 0, balanced: 1, slow: 2 }[envelope.maxLatency]
      if (rank === undefined || (limit !== undefined && rank > limit)) fields.push('latency')
    }
    if (typeof envelope.minQuality === 'number' && envelope.minQuality > 0) {
      const derivedFloor = envelope.derived === true || envelope.source === 'derived'
      const quality = derivedFloor ? qualityBasis(info) : legacyQuality(info)
      if (quality === null || quality < envelope.minQuality) fields.push('quality')
    }
    if (fields.length > 0) failed[tier] = fields
  }
  return failed
}

/** Tiers from cheapest to most capable. */
export const TIER_IDS = ['fast', 'balanced', 'deep']

/** Where a model goes when it is neither assigned nor disabled. */
export const OFF = 'off'

/**
 * The cheapest tier that admits this model, or null when none does.
 *
 * Cheapest-first on purpose: a model that fits `fast` is doing no harm there,
 * and reserving it for a deeper tier only makes cheap work expensive. Tiers are
 * intervals on the same axis, not exclusive castes.
 *
 * @param {object|null} info - measured knowledge entry for the model
 * @param {Record<string, {envelope?: object}>} routes
 * @returns {string|null}
 */
export function autoTierFor(info, routes) {
  for (const id of TIER_IDS) {
    const envelope = routes?.[id]?.envelope
    if (envelope === undefined) continue
    if (withinEnvelope(info, envelope)) return id
  }
  return null
}

/**
 * Assign a candidate pool to tiers.
 *
 * @param {Array<{model: string, provider?: string, info?: object|null}>} pool
 * @param {Record<string, {envelope?: object}>} routes
 * @param {{mode?: string, overrides?: Record<string, string>, disabled?: string[]}} [config]
 * @returns {{
 *   mode: 'auto'|'manual',
 *   groups: Record<string, string[]>,
 *   tierOf: Record<string, string>,
 *   overridden: string[],
 *   disabled: string[],
 *   unassigned: string[],
 * }}
 */
/**
 * Identity of one routable model.
 *
 * A model id alone is not unique across providers: this profile serves
 * `deepseek-v4-pro` from three of them. Everything the operator edits (tier
 * membership, a disabled switch) is keyed by `provider/model`, so two endpoints
 * offering the same id stay two entries.
 *
 * @param {{key?: string, provider?: string, model?: string}} candidate
 * @returns {string}
 */
export function modelKeyOf(candidate) {
  if (typeof candidate?.key === 'string' && candidate.key.length > 0) return candidate.key
  const provider = typeof candidate?.provider === 'string' ? candidate.provider : ''
  const model = typeof candidate?.model === 'string' ? candidate.model : ''
  return provider.length > 0 ? `${provider}/${model}` : model
}

/**
 * Model capability on the router's basis, for the capability criterion.
 *
 * The conservative ranking bound first (the number dominance and derived floors
 * use), the legacy score only for a catalog with no ranking.
 */
const capabilityOf = (info) => {
  const basis = qualityBasis(info)
  if (basis !== null) return basis
  return legacyQuality(info)
}

/** The five dimensions the composite is built from. */
const CORE_DIMENSIONS = ['coding', 'reasoning', 'math', 'knowledge', 'agentic']

/**
 * How many of the composite's five dimensions an entry actually measured.
 *
 * A composite renormalised over two dimensions is not comparable with one over
 * five: the two-dimension model can look strong while most of its profile is
 * unknown (measured examples scored 55 with only knowledge+agentic). Band
 * grouping only uses entries that cover at least three core dimensions; entries
 * from a catalog with no ranking keep the legacy rule.
 */
function coreCoverage(info) {
  const dims = info?.ranking?.dims
  if (dims === null || dims === undefined) return null
  let covered = 0
  for (const dim of CORE_DIMENSIONS) {
    const value = dims[dim]
    if (value !== null && value !== undefined && Number.isFinite(Number(value.value))) covered += 1
  }
  return covered
}

/** Interpolated quantile over a sorted numeric list. */
function quantileOf(values, p) {
  if (values.length === 0) return null
  const at = Math.min(values.length - 1, Math.max(0, p * (values.length - 1)))
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return values[lo] + (values[hi] - values[lo]) * (at - lo)
}

export function assignTiers(pool, routes, config = {}) {
  const mode = config.mode === 'manual' ? 'manual' : 'auto'
  /**
   * How a model is placed into a tier.
   *
   * `capability` (default) groups by measured capability bands first and uses the
   * envelope as a guardrail (cost/latency ceilings, quality floor) — the tier
   * says how hard the work is. `cost` is the old rule: the cheapest envelope that
   * admits the model, which makes a strong-and-cheap model land in `fast` because
   * it also clears that tier's floor.
   */
  const criterion = config.criterion === 'cost' ? 'cost' : 'capability'
  const overrides = config.overrides ?? {}
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : [])
  const groups = { fast: [], balanced: [], deep: [], off: [] }
  const tierOf = {}
  const overridden = []
  const unassigned = []
  /** Provider each placed model belongs to, so the UI can label and colour it. */
  const providerOf = {}
  /** Model id behind each key, so the UI can show `provider/model` without parsing. */
  const modelOf = {}
  /** Models the catalog offers but nothing measured: never routed, never shown as a choice. */
  const unmeasured = []
  /** Placed models another model beats on both quality and price. */
  const dominated = []
  /**
   * Why each model sits in `off`, so its card can say it.
   *
   * Three distinct causes: the operator switched it off; the catalog cannot place
   * it because no envelope admits it (with the failing field per tier); or another
   * model of its family is stronger and at least `DOMINANCE_COST_MARGIN` cheaper.
   */
  const offReasons = {}
  /** Why an entry is in the unmeasured lane: no measurement, or too thin to compare. */
  const unmeasuredReasons = {}
  const placed = []

  // Capability bands are derived from the pool being assigned, one entry per
  // *model*: a model offered by several providers is one capability, and counting
  // its endpoints separately pulled the band edges around and let two endpoints of
  // the same model land in different tiers. Disabled models are excluded (an
  // operator switch must not move the edges for everything else).
  // The model behind the endpoint key: the provider segment and any vendor
  // namespace are dropped, so `vanchin/deepseek-v4.1-flash` and
  // `deepseek-v4.1-flash` are one model while `…-1017` stays its own (bareId keeps
  // the date, which is part of the identity).
  const canonicalOf = (candidate) => bareId(modelKeyOf(candidate)).toLowerCase()
  const latencyRankOf = (info) => ({ fast: 0, balanced: 1, slow: 2 }[String(info?.latency ?? '')] ?? 3)
  const models = new Map()
  if (criterion === 'capability') {
    for (const candidate of Array.isArray(pool) ? pool : []) {
      if (candidate === null || candidate === undefined) continue
      if (disabled.has(modelKeyOf(candidate))) continue
      if (!hasMeasuredQuality(candidate.info ?? null)) continue
      const coverage = coreCoverage(candidate.info ?? null)
      if (coverage !== null && coverage < 3) continue
      const capability = capabilityOf(candidate.info ?? null)
      if (capability === null) continue
      const canonical = canonicalOf(candidate)
      const seen = models.get(canonical)
      if (seen === undefined) {
        models.set(canonical, { capability, latency: latencyRankOf(candidate.info ?? null) })
        continue
      }
      // The best evidence across endpoints describes the model; the fastest
      // serving class decides whether a tier may serve it at all.
      seen.capability = Math.max(seen.capability, capability)
      seen.latency = Math.min(seen.latency, latencyRankOf(candidate.info ?? null))
    }
  }
  const capabilityValues = [...models.values()].map((model) => model.capability).sort((a, b) => a - b)
  const canUseCapability = criterion === 'capability' && capabilityValues.length >= 6
  const bandEdges = canUseCapability
    ? { fastMax: quantileOf(capabilityValues, 1 / 3), balancedMax: quantileOf(capabilityValues, 2 / 3) }
    : null
  /** The criterion actually in force: bands need enough measured models. */
  const effectiveCriterion = canUseCapability ? 'capability' : 'cost'

  /**
   * Tier for one model: its capability band, decided from the best evidence
   * across its endpoints, so every endpoint of that model follows.
   *
   * Placement uses capability only. Cost and latency are measurements the
   * selector weighs inside a tier (and the old cost criterion remains available),
   * but as placement gates they produced the artefact this criterion was meant to
   * remove: `GLM-5.3-Flash` (capability 34.0) was pushed from `balanced` to `deep`
   * by its serving class while `deepseek-v4.1-flash` (31.3) stayed `balanced`, so
   * a faster classification read as a higher grade. A serving class is not a
   * capability grade.
   */
  const tierForModel = (canonical) => {
    const model = models.get(canonical)
    if (model === undefined || bandEdges === null) return null
    if (model.capability <= bandEdges.fastMax) return 'fast'
    if (model.capability <= bandEdges.balancedMax) return 'balanced'
    return 'deep'
  }

  for (const candidate of Array.isArray(pool) ? pool : []) {
    const model = candidate?.model
    if (typeof model !== 'string' || model.length === 0) continue
    const key = modelKeyOf(candidate)
    modelOf[key] = model
    if (typeof candidate.provider === 'string' && candidate.provider.length > 0) providerOf[key] = candidate.provider
    if (disabled.has(key)) {
      groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = { reason: 'disabled' }
      continue
    }
    const override = overrides[key]
    if (TIER_IDS.includes(override)) {
      groups[override].push(key)
      tierOf[key] = override
      overridden.push(key)
      continue
    }
    // Routing is measurement-driven: a model with no measured quality cannot be
    // ranked, so it is not placed in a tier. The ranking's own status decides
    // what "measured" means once it exists -- an entry whose legacy compiled
    // quality the ranking refused to decompose is not routable, even though the
    // old field is still present. A profile that exposes a provider with hundreds
    // of unmeasured ids must not turn the tier board into a list of everything
    // the provider can bill for.
    const measured = hasMeasuredQuality(candidate.info ?? null)
    if (mode === 'auto' && !measured) {
      unmeasured.push(key)
      unmeasuredReasons[key] = 'no-measurement'
      continue
    }
    // Capability grouping needs a comparable profile; a thin entry is listed as
    // unmeasured (with its own reason) instead of entering a band on a fragment.
    const coverage = coreCoverage(candidate.info ?? null)
    if (mode === 'auto' && canUseCapability && coverage !== null && coverage < 3) {
      unmeasured.push(key)
      unmeasuredReasons[key] = 'insufficient-coverage'
      continue
    }
    // `manual` means the operator has taken over: an unassigned model is not
    // routed rather than guessed at, which is what makes the mode predictable.
    let tier = null
    if (mode === 'manual') {
      tier = null
    } else if (canUseCapability) {
      tier = tierForModel(canonicalOf(candidate))
    } else {
      tier = autoTierFor(candidate.info ?? null, routes)
    }
    if (tier === null || mode === 'manual') {
      groups.off.push(key)
      tierOf[key] = OFF
      unassigned.push(key)
      offReasons[key] = tier === null
        ? { reason: 'no-envelope', failed: failedEnvelopes(candidate.info ?? null, routes) }
        : { reason: 'manual' }
      continue
    }
    groups[tier].push(key)
    tierOf[key] = tier
    placed.push({ key, tier, quality: qualityOf(candidate.info), cost: costIndex(candidate.info), family: familyOf(key) })
  }

  // A model that another one beats on both axes is not worth routing: it pays
  // more for less. Automatic placement ignores that competition because it only
  // asks "does this fit an envelope", so the losers are turned off here -- the
  // operator can still drag one back and take it as a deliberate choice.
  if (mode === 'auto') {
    for (const candidate of placed) {
      const winner = placed.find(
        (other) =>
          other.key !== candidate.key &&
          // Under the capability criterion a cheaper sibling belongs to a lower
          // tier by design, so dominance is scoped to the same tier ("paying more
          // for less inside one budget"). In cost mode the tiers are price bands,
          // where a cheaper-strength model anywhere makes the dearer one pointless,
          // so the original cross-tier rule stands.
          (effectiveCriterion !== 'capability' || other.tier === candidate.tier) &&
          canonicalOf(other) !== canonicalOf(candidate) &&
          other.family === candidate.family &&
          other.quality > candidate.quality &&
          other.cost <= candidate.cost - DOMINANCE_COST_MARGIN,
      )
      if (winner === undefined) continue
      const tier = tierOf[candidate.key]
      const members = groups[tier]
      const position = members.indexOf(candidate.key)
      if (position >= 0) members.splice(position, 1)
      groups.off.push(candidate.key)
      tierOf[candidate.key] = OFF
      const record = { key: candidate.key, by: winner.key, quality: candidate.quality, winnerQuality: winner.quality, cost: candidate.cost, winnerCost: winner.cost }
      dominated.push(record)
      offReasons[candidate.key] = { reason: 'dominated', ...record, margin: Math.round(candidate.cost - winner.cost) }
    }
  }

  return {
    mode,
    groups,
    tierOf,
    providerOf,
    modelOf,
    overridden,
    dominated,
    offReasons,
    criterion: effectiveCriterion,
    bands: bandEdges === null ? null : {
      fastMax: Math.round(bandEdges.fastMax * 10) / 10,
      balancedMax: Math.round(bandEdges.balancedMax * 10) / 10,
      sample: capabilityValues.length,
      models: models.size,
    },
    disabled: [...disabled],
    unassigned,
    unmeasured,
    unmeasuredReasons,
  }
}

/**
 * Membership sets for the selector: which models a tier may serve.
 *
 * An empty set is returned as an empty array rather than dropped, so the
 * selector can tell "this tier has nothing" from "this tier is unrestricted" and
 * widen instead of silently ranking the whole pool.
 *
 * @param {ReturnType<typeof assignTiers>} assigned
 * @returns {Record<string, Set<string>>}
 */
export function membershipOf(assigned) {
  const membership = {}
  for (const id of TIER_IDS) membership[id] = new Set(assigned.groups[id] ?? [])
  return membership
}