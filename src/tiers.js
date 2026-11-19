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
import { familyOf } from './identity.js'
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

export function assignTiers(pool, routes, config = {}) {
  const mode = config.mode === 'manual' ? 'manual' : 'auto'
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
  const placed = []

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
      continue
    }
    // `manual` means the operator has taken over: an unassigned model is not
    // routed rather than guessed at, which is what makes the mode predictable.
    const tier = autoTierFor(candidate.info ?? null, routes)
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
          // Same family only: a cheaper, stronger model from another vendor is a
          // different product line, not a replacement for this one.
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
    disabled: [...disabled],
    unassigned,
    unmeasured,
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