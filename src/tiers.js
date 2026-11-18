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
import { withinEnvelope } from './select.js'

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
export function assignTiers(pool, routes, config = {}) {
  const mode = config.mode === 'manual' ? 'manual' : 'auto'
  const overrides = config.overrides ?? {}
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : [])
  const groups = { fast: [], balanced: [], deep: [], off: [] }
  const tierOf = {}
  const overridden = []
  const unassigned = []

  for (const candidate of Array.isArray(pool) ? pool : []) {
    const model = candidate?.model
    if (typeof model !== 'string' || model.length === 0) continue
    if (disabled.has(model)) {
      groups.off.push(model)
      tierOf[model] = OFF
      continue
    }
    const override = overrides[model]
    if (TIER_IDS.includes(override)) {
      groups[override].push(model)
      tierOf[model] = override
      overridden.push(model)
      continue
    }
    // `manual` means the operator has taken over: an unassigned model is not
    // routed rather than guessed at, which is what makes the mode predictable.
    const tier = autoTierFor(candidate.info ?? null, routes)
    if (tier === null || mode === 'manual') {
      groups.off.push(model)
      tierOf[model] = OFF
      unassigned.push(model)
      continue
    }
    groups[tier].push(model)
    tierOf[model] = tier
  }

  return { mode, groups, tierOf, overridden, disabled: [...disabled], unassigned }
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