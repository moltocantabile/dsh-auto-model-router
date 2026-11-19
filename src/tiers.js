/**
 * Automatic tier assignment.
 *
 * A tier is an envelope — a cost ceiling, a latency ceiling, a quality floor.
 * Asking the operator to also point every tier at a named model means choosing
 * twice for the same decision, and the named model then wins even when a better
 * one enters the catalog tomorrow. So membership is computed from measurement:
 * a model is graded into capability bands, guardrailed by the tier's cost and
 * latency ceilings, and the board lists one entry per model rather than one per
 * provider endpoint.
 *
 * The assignment is model-level, not endpoint-level: a model can be advertised
 * from several providers, and the board shows the deterministic best offering
 * (`fastest latency, most evidence, cheapest`, then key). The other endpoints
 * stay in `endpointsOf` for the card, never in a second lane. Withdrawn models,
 * superseded generations and duplicates are off the lanes with a reason the page
 * can show; the operator can still override any of it by hand.
 */
import { boardMetaOf, hasMeasuredQuality, legacyQuality, qualityBasis } from './basis.js'
import { canonicalModelOf, compareModelVersions, familyOf, modelLineOf } from './identity.js'
import { costIndex, withinEnvelope } from './select.js'

export { boardMetaOf } from './basis.js'
export { familyOf } from './identity.js'

/** How much cheaper a model must be to justify a lower quality by "dominance". */
const DOMINANCE_COST_MARGIN = 10

/** Latency classes, fastest first; an unclassified model is the slowest class. */
const LATENCY_RANK = { fast: 0, balanced: 1, slow: 2 }

/** Tiers from cheapest to most capable. */
export const TIER_IDS = ['fast', 'balanced', 'deep']

/** Where a model goes when it is neither assigned nor disabled. */
export const OFF = 'off'

/** Measured quality of a candidate on the conservative basis (cost criterion). */
const qualityOf = (info) => {
  const quality = qualityBasis(info)
  return quality === null ? 0 : quality
}

/** Latency rank of a candidate; an unknown class sorts after every known one. */
const latencyRankOf = (info) => LATENCY_RANK[String(info?.latency ?? '')] ?? 3

/**
 * Benchmarks behind an entry, for the endpoint tie-break: a measured endpoint
 * outranks an unmeasured one even when both claim the same model.
 */
function evidenceOf(info) {
  const overall = info?.ranking?.dims?.overall?.evidence
  if (Number.isFinite(Number(overall))) return Number(overall)
  let total = 0
  for (const value of Object.values(info?.ranking?.dims ?? {})) total += Number(value?.evidence) || 0
  for (const value of Object.values(info?.evidence ?? {})) total += Number(value) || 0
  return total
}

/**
 * Why a candidate must not be auto-placed, or null when it may be.
 *
 * `retired` is the explicit marker; `withdrawn`/`deprecated` are the other
 * spellings a catalog uses; a `sunsetAt` date means the model is on its way out
 * (past or announced), and the board should not keep routing to it by default.
 */
function withdrawalOf(info, now) {
  const replacedBy = typeof info?.replaceWith === 'string' && info.replaceWith.length > 0 ? info.replaceWith : undefined
  const withdrawn = (kind) => ({ reason: 'retired', kind, ...(replacedBy === undefined ? {} : { replaces: replacedBy }) })
  if (info?.retired === true) return withdrawn('retired')
  if (info?.deprecated === true || info?.withdrawn === true) return withdrawn('withdrawn')
  if (typeof info?.sunsetAt === 'string' && info.sunsetAt.length > 0) {
    const sunset = Date.parse(info.sunsetAt)
    if (!Number.isFinite(sunset) || sunset <= now) return { reason: 'retired', kind: 'sunset', until: info.sunsetAt, ...(replacedBy === undefined ? {} : { replaces: replacedBy }) }
    return { reason: 'retired', kind: 'retiring', until: info.sunsetAt, ...(replacedBy === undefined ? {} : { replaces: replacedBy }) }
  }
  return null
}

/** Cost/latency ceilings of one envelope that a candidate breaches. */
function ceilingBreaches(info, envelope) {
  const fields = []
  if (envelope === null || envelope === undefined) return fields
  if (typeof envelope.maxCost === 'number' && envelope.maxCost > 0 && costIndex(info) > envelope.maxCost) fields.push('cost')
  if (typeof envelope.maxLatency === 'string' && LATENCY_RANK[envelope.maxLatency] !== undefined) {
    const rank = latencyRankOf(info)
    if (rank > LATENCY_RANK[envelope.maxLatency]) fields.push('latency')
  }
  return fields
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
  for (const tier of TIER_IDS) {
    const envelope = routes?.[tier]?.envelope
    if (envelope === null || envelope === undefined) continue
    const fields = ceilingBreaches(info, envelope)
    if (typeof envelope.minQuality === 'number' && envelope.minQuality > 0) {
      const derivedFloor = envelope.derived === true || envelope.source === 'derived'
      const quality = derivedFloor ? qualityBasis(info) : legacyQuality(info)
      if (quality === null || quality < envelope.minQuality) fields.push('quality')
    }
    if (fields.length > 0) failed[tier] = fields
  }
  return failed
}

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
 * Identity of one routable endpoint.
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
  // Grade on the capability point estimate, like the rank does: the conservative
  // bound is an evidence-width artefact (AA-index agreement 0.86 vs 0.33) and
  // using it here put capable-but-thinly-measured models a grade below models the
  // independent boards place below them. The coverage gate below still keeps
  // fragments out of the bands.
  const composite = info?.ranking?.composite
  if (Number.isFinite(Number(composite)) && composite !== null) return Number(composite)
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

/** Sort position of an endpoint: fastest latency, most evidence, cheapest, key. */
function endpointRank(entry) {
  const info = entry.candidate.info ?? null
  return [latencyRankOf(info), -evidenceOf(info), costIndex(info), entry.key]
}

function compareEndpointRank(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return left[3].localeCompare(right[3])
}

/** A fixed clock for the withdrawal/sunset rule; tests inject one. */
function clockOf(value) {
  if (Number.isFinite(Number(value))) return Number(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/** Version as `4.1` for a card. */
const versionLabel = (version) => (Array.isArray(version) ? version.join('.') : '')

/**
 * Off-lane reasons by kind, for `status`.
 *
 * @param {Record<string, {reason?: string}>} offReasons
 * @returns {Record<string, number>}
 */
export function offReasonTotals(offReasons) {
  const totals = {}
  for (const reason of Object.values(offReasons ?? {})) {
    const kind = reason?.reason
    if (typeof kind !== 'string' || kind.length === 0) continue
    totals[kind] = (totals[kind] ?? 0) + 1
  }
  return totals
}

/**
 * Assign a candidate pool to tiers.
 *
 * Order of precedence: disabled > hand override > withdrawn > unmeasured >
 * capability band (cost/latency guardrail) > superseded generation > same-family
 * dominance. Membership is model-level: one endpoint represents the model per
 * lane, chosen deterministically from the endpoints offered.
 *
 * @param {Array<{model: string, provider?: string, info?: object|null}>} pool
 * @param {Record<string, {envelope?: object}>} routes
 * @param {{mode?: string, criterion?: 'capability'|'cost', overrides?: Record<string, string>, disabled?: string[], now?: number|string}} [config]
 * @returns {{
 *   mode: 'auto'|'manual',
 *   groups: Record<string, string[]>,
 *   tierOf: Record<string, string>,
 *   overridden: string[],
 *   disabled: string[],
 *   unassigned: string[],
 *   unmeasured: string[],
 *   offReasons: Record<string, object>,
 *   endpointsOf: Record<string, string[]>,
 *   hidden: string[],
 * }}
 */
export function assignTiers(pool, routes, config = {}) {
  const mode = config.mode === 'manual' ? 'manual' : 'auto'
  const criticalCriterion = config.criterion === 'cost' ? 'cost' : 'capability'
  const overrides = config.overrides ?? {}
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : [])
  const now = clockOf(config.now)

  const entries = []
  const providerOf = {}
  const modelOf = {}
  for (const candidate of Array.isArray(pool) ? pool : []) {
    if (candidate === null || candidate === undefined) continue
    if (typeof candidate.model !== 'string' || candidate.model.length === 0) continue
    const key = modelKeyOf(candidate)
    if (typeof key !== 'string' || key.length === 0) continue
    entries.push({ candidate, key, canonical: canonicalModelOf(key) })
    providerOf[key] = typeof candidate.provider === 'string' ? candidate.provider : undefined
    modelOf[key] = candidate.model
  }

  // The board is model-level: disabling any endpoint is the operator switching
  // the model off, so the whole model leaves routing rather than falling through
  // to another provider's copy of the same id.
  const disabledCanonicals = new Set(entries.filter((entry) => disabled.has(entry.key)).map((entry) => entry.canonical))

  const groupsByCanonical = new Map()
  for (const entry of entries) {
    const group = groupsByCanonical.get(entry.canonical) ?? []
    group.push(entry)
    groupsByCanonical.set(entry.canonical, group)
  }

  // One representative endpoint per model. An override names the endpoint the
  // operator picked; otherwise the deterministic best offering wins: a live
  // (non-withdrawn) endpoint first, then fastest latency, most evidence, cheapest.
  const representativeOf = new Map()
  for (const [canonical, endpoints] of groupsByCanonical) {
    const overridden = endpoints.filter((entry) => TIER_IDS.includes(overrides[entry.key]))
    const candidates = overridden.length > 0
      ? overridden
      : endpoints.filter((entry) => withdrawalOf(entry.candidate.info ?? null, now) === null)
    const poolForChoice = candidates.length > 0 ? candidates : endpoints
    const best = [...poolForChoice].sort((left, right) => compareEndpointRank(endpointRank(left), endpointRank(right)))[0]
    representativeOf.set(canonical, best.key)
  }
  const endpointsOf = {}
  const hidden = []
  for (const entry of entries) {
    endpointsOf[entry.key] = (groupsByCanonical.get(entry.canonical) ?? []).map((item) => item.key)
    if (representativeOf.get(entry.canonical) !== entry.key) hidden.push(entry.key)
  }

  // Capability bands over the live, measured, sufficiently covered models; a
  // model counts once, at its best endpoint's capability and fastest latency.
  const models = new Map()
  if (criticalCriterion === 'capability') {
    for (const entry of entries) {
      const info = entry.candidate.info ?? null
      if (disabledCanonicals.has(entry.canonical)) continue
      if (withdrawalOf(info, now) !== null) continue
      if (!hasMeasuredQuality(info)) continue
      const coverage = coreCoverage(info)
      if (coverage !== null && coverage < 3) continue
      const capability = capabilityOf(info)
      if (capability === null) continue
      const previous = models.get(entry.canonical)
      if (previous === undefined) models.set(entry.canonical, { capability, latency: latencyRankOf(info) })
      else {
        previous.capability = Math.max(previous.capability, capability)
        previous.latency = Math.min(previous.latency, latencyRankOf(info))
      }
    }
  }
  const capabilityValues = [...models.values()].map((model) => model.capability).sort((left, right) => left - right)
  const canUseBands = criticalCriterion === 'capability' && capabilityValues.length >= 6
  const bandEdges = canUseBands
    ? { fastMax: quantileOf(capabilityValues, 1 / 3), balancedMax: quantileOf(capabilityValues, 2 / 3) }
    : null
  const tierForModel = (canonical) => {
    const model = models.get(canonical)
    if (model === undefined || bandEdges === null) return null
    if (model.capability <= bandEdges.fastMax) return 'fast'
    if (model.capability <= bandEdges.balancedMax) return 'balanced'
    return 'deep'
  }

  const effectiveCriterion = canUseBands ? 'capability' : 'cost'
  const groups = { fast: [], balanced: [], deep: [], off: [] }
  const tierOf = {}
  const offReasons = {}
  const unmeasured = []
  const unmeasuredReasons = {}
  const overridden = []
  const unassigned = []
  const placed = []
  /**
   * Every measured auto-assignable model (placed or not), as model-level entries.
   * Superseding reads this, not `placed`: a newer generation that no envelope
   * admits still replaces the older one it descends from.
   */
  const assignable = []

  for (const entry of entries) {
    const { key, canonical } = entry
    const info = entry.candidate.info ?? null

    // A model with several endpoints gets one lane entry; only the representative
    // is listed. The others stay in `endpointsOf` for the card.
    if (representativeOf.get(canonical) !== key) continue

    if (disabledCanonicals.has(canonical)) {
      groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = { reason: 'disabled' }
      continue
    }

    const overrideTier = overrides[key]
    if (TIER_IDS.includes(overrideTier)) {
      groups[overrideTier].push(key)
      tierOf[key] = overrideTier
      overridden.push(key)
      placed.push({
        key,
        tier: overrideTier,
        canonical,
        overridden: true,
        capability: capabilityOf(info) ?? 0,
        quality: qualityOf(info),
        cost: costIndex(info),
        version: modelLineOf(key).version,
      })
      continue
    }

    const withdrawal = withdrawalOf(info, now)
    if (withdrawal !== null) {
      groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = withdrawal
      continue
    }

    if (mode === 'manual') {
      groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = { reason: 'manual' }
      unassigned.push(key)
      continue
    }

    if (mode === 'auto' && !hasMeasuredQuality(info)) {
      unmeasured.push(key)
      unmeasuredReasons[key] = 'no-measurement'
      continue
    }
    const coverage = coreCoverage(info)
    if (mode === 'auto' && canUseBands && coverage !== null && coverage < 3) {
      unmeasured.push(key)
      unmeasuredReasons[key] = 'insufficient-coverage'
      continue
    }

    const lineInfo = modelLineOf(key)
    assignable.push({
      key,
      canonical,
      overridden: false,
      capability: capabilityOf(info) ?? 0,
      quality: qualityOf(info),
      cost: costIndex(info),
      version: lineInfo.version,
      line: lineInfo.line,
      base: lineInfo.base,
      variant: lineInfo.variant,
      date: lineInfo.date,
      family: familyOf(key),
    })

    let tier = null
    let failed = {}
    if (canUseBands) {
      // Capability bands answer "how hard is the work"; the envelope's cost and
      // latency ceilings are guardrails on what that budget may buy. The quality
      // floor is the band's job here, so only the ceilings move a model up.
      const bandTier = tierForModel(canonical)
      if (bandTier !== null) {
        const bandIndex = TIER_IDS.indexOf(bandTier)
        // One band up at most: a price or latency ceiling can move a model to
        // the next budget, which is what "a tier it cannot be bought on" means.
        // A model still out of envelope one band up is far below that budget's
        // grade (a cheap, weak, slow model would otherwise be parked in `deep`)
        // and is off instead.
        const lastIndex = Math.min(bandIndex + 1, TIER_IDS.length - 1)
        let cursor = bandIndex
        while (cursor <= lastIndex) {
          const candidateTier = TIER_IDS[cursor]
          const fields = ceilingBreaches(info, routes?.[candidateTier]?.envelope)
          if (fields.length === 0) {
            tier = candidateTier
            break
          }
          failed[candidateTier] = fields
          cursor += 1
        }
      }
    } else {
      tier = autoTierFor(info, routes)
    }
    if (tier === null) {
      groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = { reason: 'no-envelope', failed: Object.keys(failed).length > 0 ? failed : failedEnvelopes(info, routes) }
      unassigned.push(key)
      continue
    }
    groups[tier].push(key)
    tierOf[key] = tier
    const line = modelLineOf(key)
    placed.push({
      key,
      tier,
      canonical,
      overridden: false,
      capability: capabilityOf(info) ?? 0,
      quality: qualityOf(info),
      cost: costIndex(info),
      version: line.version,
      line: line.line,
      date: line.date,
      family: familyOf(key),
    })
  }

  /**
   * Supersede older generations.
   *
   * A model is superseded by a **measured** newer model of the same base line,
   * whether that replacement is placed or not (an unplaced newer generation still
   * retires the one it descends from). Two shapes qualify:
   *
   *  - same line and same date identity: a like-for-like version bump
   *    (`glm-5` -> `glm-5.3`, `kimi-k2.6` -> `kimi-k3`);
   *  - same base line where either side carries no product-variant words: a
   *    generation change (`deepseek-v3.2` -> `deepseek-v4.1-flash`, an older
   *    dated base snapshot -> the new base generation).
   *
   * Different product variants (`flash` vs `max`, `pro` vs `flash`) and different
   * dates (snapshots are their own models) are not replacements.
   *
   * A newer model that is materially weaker does not retire a stronger one: the
   * capability guard keeps the best model routable even when its number is lower
   * (observed: `qwen4-max` is newer but 6 points below `qwen3.7-max`; version
   * alone would have removed the rank-1 model). Hand assignments are never
   * superseded by this rule.
   */
  if (mode === 'auto') {
    const CAPABILITY_TOLERANCE = 2
    const supersededBy = new Map()
    const ordered = [...assignable]
      .filter((entry) => entry.version !== null)
      .sort((left, right) => compareModelVersions(right.version, left.version) || right.capability - left.capability)
    for (const member of ordered) {
      if (member.overridden) continue
      if (!TIER_IDS.includes(tierOf[member.key])) continue
      if (supersededBy.has(member.key)) continue
      const candidates = ordered
        .filter((other) => {
          if (other.key === member.key || other.overridden) return false
          if (other.family !== member.family) return false
          if (compareModelVersions(other.version, member.version) <= 0) return false
          if (other.capability < member.capability - CAPABILITY_TOLERANCE) return false
          // Same major generation, much dearer, barely stronger: not a
          // replacement inside a budget tier. Dropping the cheapest fast model
          // for a 4x-pricier successor emptied `fast` of its budget option.
          const sameMajor = (other.version?.[0] ?? 0) === (member.version?.[0] ?? 0)
          if (sameMajor && other.cost - member.cost > 20 && other.capability - member.capability < 10) return false
          const sameLine = other.line === member.line && (other.date ?? '') === (member.date ?? '')
          const sameBase = other.base === member.base && (other.variant === '' || member.variant === '')
          return sameLine || sameBase
        })
        .sort((left, right) => compareModelVersions(right.version, left.version) || right.capability - left.capability)
      let winner = candidates[0]
      if (winner === undefined) continue
      // Follow the chain to the current replacement: a middle generation may
      // itself be superseded (kimi-k2.6 -> k3 -> k3.1-pro), and the card should
      // name the model that actually replaced it.
      const seen = new Set([member.key])
      while (supersededBy.has(winner.key) && !seen.has(winner.key)) {
        seen.add(winner.key)
        winner = supersededBy.get(winner.key)
      }
      supersededBy.set(member.key, winner)
    }
    for (const [key, winner] of supersededBy) {
      const member = assignable.find((entry) => entry.key === key)
      if (member === undefined) continue
      // The entry is in whichever group placement put it in (its recorded tier);
      // removing by the assignable record's absent `tier` left the lane populated.
      const currentTier = tierOf[key]
      const group = TIER_IDS.includes(currentTier) ? groups[currentTier] : null
      const position = group?.indexOf(key) ?? -1
      if (position >= 0) group.splice(position, 1)
      if (!groups.off.includes(key)) groups.off.push(key)
      tierOf[key] = OFF
      offReasons[key] = {
        reason: 'superseded',
        by: winner.key,
        winnerVersion: versionLabel(winner.version),
        version: versionLabel(member.version),
        kind: winner.line === member.line ? 'line' : 'generation',
      }
      const at = placed.findIndex((item) => item.key === key)
      if (at >= 0) placed.splice(at, 1)
    }
  }

  /**
   * Dominance, scoped to one tier and one model family: paying more for a lower
   * grade is pointless. In capability mode the grade is the capability estimate
   * the bands use -- comparing it on the conservative bound made a wide-band
   * frontier model lose to a cheaper, lower-grade one. A newer generation of the
   * same line is never pruned by an older one; supersede decides that.
   */
  const dominanceQuality = (entry) => (effectiveCriterion === 'capability' ? entry.capability : entry.quality)
  for (const candidate of [...placed]) {
    if (candidate.overridden) continue
    if (tierOf[candidate.key] !== candidate.tier) continue
    const candidateVersion = candidate.version
    const winner = placed.find((other) => {
      if (other.key === candidate.key || other.overridden) return false
      if (other.canonical === candidate.canonical) return false
      // Under capability bands a cheaper sibling belongs to a lower tier by
      // design, so dominance is scoped to the same tier. In cost mode the tiers
      // are price bands and a cheaper-stronger model anywhere makes the dearer
      // one pointless.
      if (effectiveCriterion === 'capability' && other.tier !== candidate.tier) return false
      if (other.family !== candidate.family) return false
      if (dominanceQuality(other) <= dominanceQuality(candidate)) return false
      if (other.cost > candidate.cost - DOMINANCE_COST_MARGIN) return false
      // The same model line: the newer generation outranks the older one, so an
      // older cheaper sibling cannot switch the newer one off.
      const otherLine = modelLineOf(other.key)
      if (
        candidateVersion !== null && otherLine.version !== null
        && modelLineOf(candidate.key).line === otherLine.line
        && (modelLineOf(candidate.key).date ?? '') === (otherLine.date ?? '')
        && compareModelVersions(candidateVersion, otherLine.version) > 0
      ) return false
      return true
    })
    if (winner === undefined) continue
    const position = groups[candidate.tier].indexOf(candidate.key)
    if (position >= 0) groups[candidate.tier].splice(position, 1)
    groups.off.push(candidate.key)
    tierOf[candidate.key] = OFF
    const record = {
      reason: 'dominated',
      key: candidate.key,
      by: winner.key,
      quality: dominanceQuality(candidate),
      winnerQuality: dominanceQuality(winner),
      cost: candidate.cost,
      winnerCost: winner.cost,
    }
    offReasons[candidate.key] = { ...record, margin: Math.round(candidate.cost - winner.cost) }
  }

  return {
    mode,
    groups,
    tierOf,
    providerOf,
    modelOf,
    overridden,
    dominated: Object.values(offReasons)
      .filter((reason) => reason.reason === 'dominated')
      .map(({ reason, ...record }) => record),
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
    endpointsOf,
    hidden,
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
