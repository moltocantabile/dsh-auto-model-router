/**
 * One capability basis, one owner.
 *
 * The catalog carries two measures of the same idea: the aligned per-dimension
 * estimates the ranking engine produces (`ranking.dims`, with integer evidence
 * counts) and the legacy compiled `scores`/`quality` the earlier compiler wrote.
 * They are different scales. Mixing them -- comparing one entry's aligned value
 * with another's legacy value, or reading a floor on one axis and a card on the
 * other -- is the bug class this module exists to make impossible:
 *
 * - **One basis per entry**, chosen once by {@link basisOf}. A dimension the
 *   chosen basis has no estimate for is a prior, never a value borrowed from the
 *   other basis.
 * - **One scalar basis** for every tier rule: {@link qualityBasis} is the
 *   conservative value (ranking low bound, else composite, else legacy score when
 *   the entry has never been ranked).
 * - **Provenance decides a floor's axis** ({@link envelopeQuality}): a derived
 *   floor is a quantile of the aligned value, a hand-written operator floor was
 *   authored against the legacy score and is translated first
 *   ({@link alignedOperatorFloors}, {@link alignedFloor}).
 * - **Effective envelopes** are computed here, not by a caller
 *   ({@link mergeEnvelopes}, {@link effectiveEnvelopes}), so the field that is
 *   actually in force keeps its provenance.
 * - **The card** ({@link boardMetaOf}) reports the same basis and the same
 *   producer fields the rules read.
 *
 * `select.js`, `tiers.js`, `refresh.js` and `index.js` import these rules; none of
 * them may re-implement one.
 */

/**
 * Capability dimensions carried by every knowledge entry. Scores are 0-100 and
 * comparable across models within a dimension; they are *not* comparable across
 * dimensions (a 70 in coding is not a 70 in speed).
 */
export const DIMENSIONS = ['overall', 'coding', 'reasoning', 'math', 'knowledge', 'agentic', 'longContext', 'vision', 'speed']

/** The five dimensions the composite is built from. */
const CORE_DIMENSIONS = ['coding', 'reasoning', 'math', 'knowledge', 'agentic']

const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const numOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The legacy compiled capability scalar: `quality`, else the `scores.composite`
 * some fixtures carry. This is a basis for entries the ranking has never seen,
 * and the authored scale of a hand-written operator floor; no rule that has a
 * ranking may compare against it in place of the measured value.
 *
 * @param {object|null} [info]
 * @returns {number|null}
 */
export function legacyQuality(info) {
  const quality = num(info?.quality, null)
  return quality !== null ? quality : num(info?.scores?.composite, null)
}

/**
 * The whole capability basis for one entry, chosen once and used whole.
 *
 * @typedef {object} Basis
 * @property {'ranking'|'legacy'|'ranking-empty'} source - which measurement set was used
 * @property {Record<string, number>} values - per-dimension estimates on that basis
 * @property {Record<string, number>} evidence - integer benchmark counts on that basis
 * @property {number|null} quality - the scalar tier rules compare (ranking low bound, else composite; legacy only when unranked)
 * @property {number|null} legacy - the legacy compiled scalar, for provenance-aware floors
 * @property {boolean} measured - whether the catalog has a measurement it may rank
 */

/**
 * @param {object|null} [info]
 * @returns {Basis}
 */
export function basisOf(info) {
  const ranking = info?.ranking ?? null
  const legacy = legacyQuality(info)
  const dims = ranking?.dims
  const hasDims = dims !== null && typeof dims === 'object' && Object.keys(dims).length > 0
  let values = {}
  let evidence = {}
  let source
  if (hasDims) {
    for (const dim of DIMENSIONS) {
      const entry = dims[dim]
      const value = num(entry?.value, null)
      if (value !== null) values[dim] = value
      evidence[dim] = Math.max(0, Math.trunc(num(entry?.evidence, 0)))
    }
    source = 'ranking'
  } else if (ranking !== null) {
    // A ranking with no dimension at all is an unmeasured entry: the legacy
    // scores it refused to decompose are not a basis.
    source = 'ranking-empty'
  } else {
    values = info?.scores ?? {}
    evidence = info?.evidence ?? {}
    source = 'legacy'
  }
  // Once an entry has a ranking, that ranking is authoritative even when it
  // reports no measurement: falling back to the legacy `quality` there mixed the
  // two scales again (an unmeasured model with a compiled prior read stronger
  // than every measured model).
  const quality = ranking !== null
    ? (num(ranking.low, null) ?? num(ranking.composite, null))
    : legacy
  const measured = ranking !== null ? ranking.status === 'measured' : legacy !== null
  return { source, values, evidence, quality, legacy, measured }
}

/**
 * The per-dimension measurement basis for one entry (`basisOf`'s values and
 * evidence). Kept as its own name because the scoring code says "basis" when it
 * means the dimensions.
 *
 * @param {object|null} [info]
 * @returns {Basis}
 */
export function dimensionBasis(info) {
  return basisOf(info)
}

/**
 * The scalar capability basis used by every tier rule: the cross-source ranking
 * when the catalog has one, the legacy compiled score otherwise.
 *
 * The two are different measures of the same idea and must not be mixed within
 * one comparison -- the board ranks by the composite while dominance read the
 * legacy score, so a model could be switched off by one measure and ranked above
 * its killer by the other.
 *
 * @param {object|null} [info]
 * @returns {number|null} the conservative value (ranking low bound) or the score
 */
export function qualityBasis(info) {
  return basisOf(info).quality
}

/**
 * Whether an entry has a measured capability the router may rank, on the same
 * basis the tiers place it with.
 *
 * Once a ranking exists its status is authoritative: `provisional` (an AA index
 * only) and `unmeasured` are listed but not auto-placed, even when the legacy
 * catalog still carries a compiled `quality` for the entry.
 *
 * @param {object|null} [info]
 * @returns {boolean}
 */
export function hasMeasuredQuality(info) {
  if (info === null || info === undefined) return false
  return basisOf(info).measured
}

/**
 * The profile-weighted capability of one entry on the measurement basis it
 * carries: the number the risk floor is compared against and the one the
 * capability term is built from.
 *
 * A dimension the basis has no estimate for is the neutral prior 50 here, and
 * the weight resting on that guess is charged by the scorer's `unverified` term
 * -- the two must read the same basis or the floor would describe a different
 * measurement than the score.
 *
 * @param {object|null} info
 * @param {Record<string, number>} weights - normalized profile weights
 * @returns {number} 0-100
 */
export function capabilityQuality(info, weights) {
  const basis = basisOf(info)
  let quality = 0
  let known = 0
  for (const dim of DIMENSIONS) {
    const w = num(weights[dim], 0)
    if (w === 0) continue
    quality += w * num(basis.values[dim], 50)
    known += w
  }
  return known === 0 ? 0 : quality / known
}

/**
 * Translate a hand-written quality floor onto the measured axis.
 *
 * A floor like `q≥66` was authored against the legacy compiled score. Once the
 * catalog carries a ranking, comparing that number to the ranking's value mixes
 * scales again: a model whose legacy score is stale (a 71.9 for an entry the
 * ranking puts at a 7 low bound) clears a hand-written ceiling it cannot prove it
 * meets. The floor is therefore read as a *share* of the legacy distribution --
 * "this floor kept out 80% of the catalog" -- and resolved at the same share of
 * the measured distribution. Same policy, correct axis.
 *
 * @param {number} floor - the operator's number
 * @param {number[]} legacyValues - legacy scores in the catalog
 * @param {number[]} alignedValues - measured (ranking low) values in the catalog
 * @returns {number} the floor on the measured axis, or the input when either side is thin
 */
export function alignedFloor(floor, legacyValues, alignedValues) {
  const legacy = (legacyValues ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  const aligned = (alignedValues ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (!Number.isFinite(floor) || legacy.length < 8 || aligned.length < 8) return floor
  const below = legacy.filter((value) => value < floor).length / legacy.length
  const at = Math.min(aligned.length - 1, Math.max(0, Math.round(below * (aligned.length - 1))))
  return Math.round(aligned[at] * 10) / 10
}

/**
 * Translate every hand-written operator floor in `routes` onto the measured axis.
 *
 * The floor was authored against the legacy compiled score. A model whose legacy
 * value is stale would clear a ceiling the ranking says it misses, so the floor's
 * *policy* (what share of the catalog it kept out) is moved onto the axis that
 * now measures the models. The operator's original number is kept beside it, and
 * the translated floor carries its provenance (`derived`/`source`) so the
 * envelope check compares it on the axis it belongs to.
 *
 * @param {Record<string, {envelope?: object}>} routes
 * @param {Iterable<object|null>} entries - catalog entries carrying `quality` and/or `ranking.low`
 * @returns {Record<string, {envelope?: object}>} routes with translated floors
 */
export function alignedOperatorFloors(routes, entries) {
  const legacy = []
  const aligned = []
  for (const entry of entries ?? []) {
    if (Number.isFinite(entry?.quality)) legacy.push(entry.quality)
    const low = Number.isFinite(entry?.ranking?.low) ? entry.ranking.low : null
    if (low !== null) aligned.push(low)
  }
  const out = {}
  for (const [id, route] of Object.entries(routes ?? {})) {
    const envelope = route?.envelope ?? {}
    if (!Number.isFinite(envelope.minQuality) || envelope.derived === true || envelope.source === 'derived') {
      out[id] = route
      continue
    }
    const translated = alignedFloor(envelope.minQuality, legacy, aligned)
    // The translated number lives on the measured axis, so it must say so:
    // `envelopeQuality` compares a floor against the legacy score unless the
    // floor carries its provenance, and a measured-axis floor compared to the
    // legacy score empties or floods the tier.
    out[id] = translated === envelope.minQuality
      ? route
      : {
          ...route,
          envelope: {
            ...envelope,
            minQuality: translated,
            operatorMinQuality: envelope.minQuality,
            derived: true,
            source: 'derived',
          },
        }
  }
  return out
}

/**
 * The value a quality floor in `envelope` must be compared against.
 *
 * A floor means only what its source meant: a hand-written one was authored
 * against the legacy score, a derived one is a quantile of the ranking's
 * conservative value (or an operator floor translated onto that axis by
 * `alignedOperatorFloors`). Provenance decides the basis; comparing a floor
 * against the other scale silently empties or floods the tier.
 *
 * @param {object|null} info
 * @param {object|null|undefined} envelope
 * @returns {number|null}
 */
export function envelopeQuality(info, envelope) {
  const derivedFloor = envelope?.derived === true || envelope?.source === 'derived'
  const basis = basisOf(info)
  return derivedFloor ? basis.quality : basis.legacy
}

/**
 * The board-card facts for one model, computed from the same fields the rules
 * that placed it read.
 *
 * `quality` is the capability basis the router ranks and prunes on (ranking low
 * bound, else composite, else the legacy score); `composite` is the point
 * estimate next to it, kept separate so the card can label both instead of
 * showing the point estimate as if it were the number that decided the card's
 * lane. `dimsCovered`/`dimsTotal` say how much of the composite is measured.
 *
 * @param {object|null} [info] - knowledge entry for the model
 * @returns {{rank: number|null, composite: number|null, low: number|null, quality: number|null, status: string|null, usage: number|null, uncalibrated: number|null, dimsCovered: number|null, dimsTotal: number}}
 */
export function boardMetaOf(info) {
  const ranking = info?.ranking ?? null
  const dims = ranking?.dims ?? {}
  const covered = CORE_DIMENSIONS.filter((dim) => {
    const value = dims[dim]
    return value !== undefined && Number.isFinite(Number(value?.value))
  }).length
  return {
    rank: Number.isInteger(ranking?.rank) ? ranking.rank : null,
    composite: numOrNull(ranking?.composite),
    low: numOrNull(ranking?.low),
    quality: qualityBasis(info),
    status: typeof ranking?.status === 'string' ? ranking.status : null,
    usage: numOrNull(info?.usage?.percentile),
    uncalibrated: numOrNull(ranking?.uncalibrated),
    dimsCovered: ranking === null ? null : covered,
    dimsTotal: CORE_DIMENSIONS.length,
  }
}

/**
 * Combine operator envelopes with derived ones.
 *
 * `explicit` trusts the operator only, `merge` fills fields the operator left out
 * (a hand-set ceiling always wins), `derived` takes the data's cut-offs and keeps
 * only the operator's latency class, which is a policy choice rather than a
 * measurement.
 *
 * A merged floor keeps the provenance of the field that was actually used: the
 * envelope check compares a derived floor against the ranking's conservative
 * value and a hand-written one against the legacy score, so a floor filled from
 * the data must still say it is derived even when the operator wrote the other
 * fields.
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
    const filledFloor = base.minQuality === undefined && data.minQuality !== undefined
    const envelope = mode === 'derived'
      ? { maxCost: data.maxCost, minQuality: data.minQuality, maxLatency: base.maxLatency ?? data.maxLatency, derived: true, source: 'derived' }
      : {
          maxCost: base.maxCost ?? data.maxCost,
          minQuality: base.minQuality ?? data.minQuality,
          maxLatency: base.maxLatency ?? data.maxLatency,
          ...(data.source === undefined ? {} : { source: data.source }),
          ...(data.sample === undefined ? {} : { sample: data.sample }),
          ...(filledFloor ? { derived: true, source: 'derived' } : {}),
        }
    out[id] = { ...route, envelope }
  }
  return out
}

/**
 * The envelopes the rules should actually read.
 *
 * Three sources can supply a field, and the operator is the only one that may
 * claim precedence: `merge` lets a hand-written field win and fills the rest from
 * the derived cut-offs; `explicit` trusts the operator and completes it from the
 * shipped defaults; `derived` takes the measured cut-offs and keeps only the
 * operator's packet policy (latency), which is a choice, not a measurement.
 *
 * The shipped defaults must not pre-fill the operator's config before this runs:
 * doing so made every field look hand-written, so the derived ceilings were never
 * in force while the status claimed they were.
 *
 * @param {Record<string, {envelope?: object}>} operatorRoutes
 * @param {Record<string, object>|null} derived
 * @param {Record<string, object>} fallback - shipped defaults, envelope only
 * @param {'explicit'|'merge'|'derived'} mode
 * @returns {Record<string, {envelope?: object}>}
 */
export function effectiveEnvelopes(operatorRoutes, derived, fallback, mode = 'merge') {
  const base = mode === 'explicit' ? fallback : (derived ?? fallback)
  const merged = mergeEnvelopes(operatorRoutes, base, mode)
  const out = {}
  for (const id of new Set([...Object.keys(operatorRoutes ?? {}), ...Object.keys(fallback ?? {})])) {
    const defaultEnvelope = fallback?.[id]?.envelope ?? {}
    const route = merged[id] ?? operatorRoutes?.[id] ?? {}
    // Complete whatever is still missing so a field an operator omitted can never
    // make an envelope permissive by accident.
    out[id] = { ...route, envelope: { ...defaultEnvelope, ...(route.envelope ?? {}) } }
  }
  return out
}
