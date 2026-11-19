/**
 * One identity rule for model names, shared by every join.
 *
 * A catalog entry's identity is `provider/model`. A source row names the *model*
 * the provider serves, not the endpoint it was fetched from, so a join may only
 * attach a row to an id that names the same model under this rule:
 *
 * - **May differ**: an inference/serving variant (`reasoning`, `thinking`,
 *   `high`, `heavy`, `highspeed`, `default`, …), a reseller prefix (`cmaas-`), a
 *   provider prefix, and a release date or parameter-count tail.
 * - **May not differ**: a model tier (`flash`, `max`, `mini`, `pro`, `turbo`,
 *   `lite`, `air`, `next`, `prime`, `ultra*`) or a version digit. Those are
 *   different models with different weights and prices; collapsing them once let
 *   one model's label, quality and price land on another.
 *
 * Every source join (`refresh.js`, `rank.js`) resolves names through the helpers
 * below instead of its own normalizer, and every join must name the model the
 * catalog names: a stored entry whose label disagrees with its own id is
 * repaired by {@link reconciledLabel} during a refresh, rather than surviving.
 */

/**
 * Words that describe an *inference or serving variant* of one model: the same
 * weights served with a different reasoning effort, instruction style, reseller
 * prefix, or endpoint speed.
 *
 * Deliberately excluded: model tiers (`flash`, `max`, `mini`, `pro`, `turbo`,
 * `lite`, `air`, `next`, `prime`, `ultra*`). Those are different models with
 * different weights and prices, and stripping them collapsed `Qwen3.8-Max` and
 * `Qwen3.8-Flash` (or `GLM-5.3` and `GLM-5.3-Flash`) onto one name, so a matcher
 * could attach one model's quality and price to the other.
 *
 * `highspeed`/`ultraspeed` are different: the provider serves the same weights
 * with a faster endpoint, which is a serving variant, not a new model. A
 * `kimi-k3.1-pro-highspeed` entry is the model "Kimi K3.1 Pro".
 */
export const EFFORT_VARIANTS = new Set([
  'reasoning', 'nonreasoning', 'thinking', 'reasoninghigh', 'reasoningmedium', 'reasoninglow',
  'instruct', 'default', 'based', 'on', 'cmaas',
  'high', 'medium', 'low', 'highspeed', 'ultraspeed',
])

/** Reseller prefixes a catalog id may carry in front of the model's own name. */
const RESELLER_PREFIXES = ['cmaas', 'vanchin', 'siliconflow']

/** Compare model names across sources: case, spacing and punctuation differ. */
export const normalizeName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** The model id behind a `provider/model` key (provider prefix dropped). */
export function bareId(key) {
  const text = String(key ?? '')
  const slash = text.lastIndexOf('/')
  return slash >= 0 ? text.slice(slash + 1) : text
}

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
 * Whether a source row's name is a curated alias of one catalog id.
 *
 * Aliases exist for sources that name a model differently (AA calls
 * `qwen3.8-max` "Qwen3.8 2.4T A95B"), and they must pass the same identity guard
 * as the id itself, otherwise the alias is indexed but never claimed.
 */
export function aliasMatches(id, name) {
  const normalized = normalizeName(name)
  return (NAME_ALIASES[id] ?? []).some((alias) => normalizeName(alias) === normalized)
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
 * Index every spelling of every catalog id by normalized name, resolving one
 * spelling to *all* the ids it names.
 *
 * A catalog can carry the same model twice under different provider or reseller
 * prefixes (`ZHIPU/GLM-5.3` and `glm-5.3`, `kimi/kimi-k3.1-pro` and
 * `kimi-k3.1-pro`). Identity is `provider/model`, so both entries are legitimate
 * -- but a source row names the *model*, not the endpoint, and joining it to
 * whichever id happened to win the single-value index left every twin without
 * the measurement. Every name-based source pass reads this index instead; the
 * per-id passes (BenchGecko's slug fetch, CompassRank's operator table) are
 * untouched.
 *
 * @param {Record<string, object>} base
 * @param {Array<{model?: string, provider?: string}|string>} [advertised] - models
 *   the provider advertises, including ones the catalog will create during this
 *   refresh. A name-based source pass runs before Artificial Analysis creates
 *   those entries, so without them here a newly created entry loses its Epoch
 *   and llmleaderboard rows.
 * @param {{family?: boolean}} [options] - `family: true` also indexes each
 *   advertised id under its family spelling (release date / effort variant
 *   removed). Only the Epoch and llmleaderboard joins opt in: those sources name
 *   the model, while the Artificial Analysis join feeds the ranking, and adding
 *   the family spellings there changes which channel observations the engine
 *   sees (it raised AA/axis overlap from 4 to 6 models and switched on the
 *   dimension-level fallback for hundreds of observations).
 * @returns {Map<string, string[]>} normalized spelling -> catalog ids
 */
export function nameIndexAll(base, advertised = [], options = {}) {
  const withFamily = options.family === true
  const index = new Map()
  const add = (name, id) => {
    const key = normalizeName(name)
    if (key.length === 0) return
    const list = index.get(key) ?? []
    if (!list.includes(id)) list.push(id)
    index.set(key, list)
  }
  for (const [id, entry] of Object.entries(base)) {
    add(entry?.label ?? id, id)
    add(id, id)
    add(bareId(id), id)
    const bare = bareId(id)
    if (/^cmaas-/i.test(bare)) add(bare.replace(/^cmaas-/i, ''), id)
    for (const alias of NAME_ALIASES[id] ?? []) add(alias, id)
  }
  for (const raw of advertised) {
    const id = typeof raw === 'string' ? raw : raw?.model
    if (typeof id !== 'string' || id.length === 0) continue
    const key = id.toLowerCase()
    add(id, key)
    add(bareId(id), key)
    const bare = bareId(id)
    if (/^cmaas-/i.test(bare)) add(bare.replace(/^cmaas-/i, ''), key)
    if (withFamily) for (const spelling of familySpellings(bare)) add(spelling, key)
  }
  return index
}

/**
 * Spellings of an advertised id with its serving/date suffix removed.
 *
 * A source names the model, not the deployment: `kimi/kimi-k3.1-pro-highspeed`
 * is "Kimi K3.1 Pro", `qwen3.7-plus-2026-05-26` is "Qwen3.7 Plus". Without these
 * spellings the name index has no spelling a source row can hit, and the entry
 * created during the refresh loses the measurement than names the same model.
 * Only a release date or an effort/serving variant is removed; a version digit
 * or a tier word stays part of the name.
 *
 * @param {string} id - advertised model id (provider prefix already removed)
 * @returns {Set<string>}
 */
function familySpellings(id) {
  const out = new Set()
  let text = String(id ?? '').replace(/^cmaas-/i, '')
  out.add(text)
  for (;;) {
    const variant = /[-_.]([a-z]+)$/.exec(text)
    if (variant !== null && EFFORT_VARIANTS.has(variant[1])) {
      text = text.slice(0, text.length - variant[1].length - 1)
      out.add(text)
      continue
    }
    break
  }
  return out
}

/**
 * Ids one normalized spelling resolves to.
 *
 * Accepts both index shapes so a caller holding `nameIndex` (one id per name) and
 * one holding `nameIndexAll` (a list) behaves the same.
 *
 * @param {Map<string, string|string[]>} index
 * @param {string} key
 * @returns {string[]}
 */
export function idsAt(index, key) {
  const hit = index?.get?.(key)
  if (hit === undefined) return []
  return Array.isArray(hit) ? hit : [hit]
}

/**
 * Ids a source row's display name resolves to.
 *
 * Sources annotate the model name with a parenthetical the identity rule ignores
 * (`DeepSeek-V3 (Mar 2025)` names the March-2025 V3 checkpoint). The index stores
 * the bare spelling, so the exact name is tried first and a parenthetical-free
 * spelling second; without the fallback the row is invisible and a *different*
 * row of the same family (`DeepSeek-V3`, 2024) can be attached instead.
 *
 * @param {Map<string, string|string[]>} index
 * @param {string} name
 * @returns {string[]}
 */
export function idsForName(index, name) {
  const spellings = [normalizeName(name), normalizeName(String(name ?? '').replace(/\([^)]*\)/g, ' '))]
  for (const spelling of new Set(spellings)) {
    const ids = idsAt(index, spelling)
    if (ids.length > 0) return ids
  }
  return []
}

/** Model stem of a catalog id, ignoring its provider and reseller prefixes. */
export function idStem(id) {
  return modelStem(bareId(id).replace(/^cmaas-/i, ''))
}

/**
 * Whether two model stems name the same model: equal, or one has only a date or
 * an effort/serving variant left over. A version digit or a tier word is a
 * different model, so it never passes (see `EFFORT_VARIANTS`).
 */
function stemsAgree(ours, theirs) {
  if (ours.length < 2 || theirs.length < 2) return false
  if (ours === theirs) return true
  const [longer, shorter] = ours.length >= theirs.length ? [ours, theirs] : [theirs, ours]
  const extra = longer.slice(shorter.length)
  // A snapshot date is part of the identity, not a variant: a provider that
  // advertises `model` and `model-1017` as two ids is serving two models, and
  // treating them as one gave both the same source rows (identical price,
  // dimensions and evidence for `vanchin/deepseek-v4.1-flash` and its `-1017`
  // id). Effort/serving qualifiers may still differ.
  return EFFORT_VARIANTS.has(extra)
}

/**
 * Whether a source row's name and a catalog id name the same model.
 *
 * This is the guard every join applies before taking a row's label and numbers:
 * a prefix match alone joined `siliconflow/deepseek-v3-0324` to a V4.1 row and
 * shipped its label under the wrong id. The model cores must be equal, or the
 * extra tail may only be a date or a serving variant (`qwen3.7-plus-2026-05-26`
 * against `Qwen3.7 Plus`). A version digit is not a tail -- `GLM-5` must not take
 * `GLM-5.3 (Max)`'s row.
 */
export function sameModelName(id, name) {
  const ours = idStem(id)
  // AA's qualifier parenthesis can split one variant word across two tokens
  // ("(Non-reasoning)"), so drop it before taking the stem.
  const theirs = modelStem(String(name ?? '').replace(/\([^)]*\)/g, ' '))
  return stemsAgree(ours, theirs)
}

/**
 * Whether an entry's label names the same model a source row names.
 *
 * The catalog key is the identity and the label is the human-readable name; a
 * name-based join should honour both. The shipped catalog carried entries whose
 * label named a different generation from their id (`vanchin/deepseek-v3` was
 * labelled "DeepSeek V3.2 (Reasoning)"), so the 2024 V3 row attached and the
 * entry looked internally consistent. A row that names only one of the two is
 * reported as ambiguous rather than attached: the id is the identity, but an
 * entry that cannot state its own name cannot own someone else's measurement.
 *
 * Parenthetical qualifiers are dropped first: labels use them for annotations
 * ("(latest alias)", "(retired)") and sources for reasoning effort.
 *
 * @param {Record<string, object>|null} base - catalog the id belongs to
 * @param {string} id
 * @param {string} name - source row's model name
 */
export function labelAgrees(base, id, name) {
  const label = base?.[id]?.label
  if (typeof label !== 'string' || label.length === 0) return true
  const ours = modelStem(String(label).replace(/\([^)]*\)/g, ' '))
  const theirs = modelStem(String(name ?? '').replace(/\([^)]*\)/g, ' '))
  return stemsAgree(ours, theirs)
}

/**
 * One fact a created entry may inherit from another entry describing the same
 * model, when no source published it for this id.
 *
 * The rule is "unknown unless another source has it": modalities and tool support
 * are not measurements, and defaulting them to `['text']`, `true` claimed facts
 * about models nobody had described. Returns `{}` when nothing can be inherited.
 *
 * @param {Record<string, object>} base
 * @param {string} id
 * @param {'modalities'|'toolCalling'} field
 * @returns {Record<string, unknown>}
 */
export function inheritFact(base, id, field) {
  for (const [key, entry] of Object.entries(base ?? {})) {
    const value = entry?.[field]
    if (value === undefined || value === null) continue
    const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : key
    if (!sameModelName(id, label)) continue
    return { [field]: value }
  }
  return {}
}

/** Split a normalized name into its leading model tokens and variant tokens. */
export function splitVariant(normalized) {
  let index = normalized.length
  for (;;) {
    const digits = /(\d+)$/.exec(normalized.slice(0, index))
    if (digits !== null) {
      const head = normalized.slice(0, index - digits[1].length)
      // Version numbers and snapshot dates are part of the name: `flash` and
      // `flash-1017` are different models, so only effort words are stripped.
      void head
      break
    }
    const word = /([a-z]+)$/.exec(normalized.slice(0, index))
    if (word !== null && EFFORT_VARIANTS.has(word[1])) {
      index = normalized.slice(0, index).length - word[1].length
      continue
    }
    break
  }
  return { model: normalized.slice(0, index), variant: normalized.slice(index) }
}

/**
 * Model stem without its suffix tokens, computed from the original separators.
 *
 * `splitVariant` works on a punctuation-stripped string, where a version and a
 * release date become one digit run (`deepseekv3` + `0324` -> `deepseekv30324`)
 * and both get stripped together, leaving `deepseekv`. Identity checks need the
 * separators, so this walks the original tokens.
 *
 * @param {string} text
 * @returns {string}
 */
export function modelStem(text) {
  const tokens = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    // Dates stay: `-1017` and `-0731` are different snapshots (see `stemsAgree`).
    if (EFFORT_VARIANTS.has(last)) {
      tokens.pop()
      continue
    }
    break
  }
  return tokens.join('')
}

/**
 * Find the analysis row for one advertised id.
 *
 * Tries exact keys first, then a model-name prefix whose remainder is only
 * variants. When several rows qualify (AA has one per reasoning effort) the row
 * with the highest intelligence index wins: the variant that was actually
 * evaluated is the one worth recording. Ties are broken deterministically --
 * an unqualified name first, then more benchmarks, then the name -- because the
 * payload order must not decide which effort variant a model is recorded from.
 */
export function matchAnalysisRow(keys, byName) {
  for (const key of keys) {
    const exact = byName.get(key)
    if (exact !== undefined) {
      // An exact name is the model's own row; only look further when the caller's
      // keys are aliases and no row carries the name.
      const name = String(exact.name ?? key)
      if (!/\([^)]*\)/.test(name)) return exact
    }
  }
  // Four characters is the shortest useful stem ("glm5", "kimi"); shorter than
  // that a prefix match would join unrelated models.
  const wanted = keys.map((key) => splitVariant(key)).filter(({ model }) => model.length >= 4)
  let best = null
  for (const [name, row] of byName) {
    const { model } = splitVariant(name)
    for (const candidate of wanted) {
      const shares = model === candidate.model || model.startsWith(candidate.model) || candidate.model.startsWith(model)
      if (!shares) continue
      const extra = model.length > candidate.model.length ? model.slice(candidate.model.length) : candidate.model.slice(model.length)
      // Effort variants and release dates may differ; a model tier, or a version
      // digit (`deepseek-v4` against `DeepSeek-V4.1`), may not.
      const extraOk = extra.length === 0 || EFFORT_VARIANTS.has(extra) || /^\d{4,8}$/.test(extra)
      if (!extraOk) continue
      const rank = [
        Number.isFinite(row.intelligenceIndex) ? row.intelligenceIndex : -1,
        /\([^)]*\)/.test(name) ? 0 : 1,
        Object.keys(row.benchmarks ?? {}).length,
      ]
      if (best !== null) {
        let comparison = 0
        for (let i = 0; i < rank.length && comparison === 0; i += 1) comparison = rank[i] - best.rank[i]
        if (comparison === 0) comparison = String(name).localeCompare(String(best.name))
        if (comparison <= 0) continue
      }
      best = { row, rank, name }
    }
  }
  return best === null ? undefined : best.row
}

/**
 * Catalog ids one source row's name claims.
 *
 * One row names a model, not an endpoint: every id whose normalized name matches
 * gets the row. The caller still applies `sameModelName` (and `labelAgrees` when
 * it has the catalog) -- a name is not identity on its own.
 *
 * @param {string} name - source row's model name
 * @param {Map<string, string|string[]>} index - `nameIndex`/`nameIndexAll`
 * @returns {string[]}
 */
export function claimAll(name, index) {
  const plain = normalizeName(name)
  // Drop the source's qualifier parenthesis, then trailing variant words.
  const stripped = normalizeName(String(name).replace(/\([^)]*\)/g, ' '))
  const trimmed = stripped.replace(/(non)?reasoning$/, '')
  for (const spelling of [plain, stripped, trimmed]) {
    const ids = idsAt(index, spelling)
    if (ids.length > 0) return ids
  }
  // Longest catalog key that prefixes the source name (dated ids, "-preview").
  let best = null
  for (const [key, value] of index) {
    if (key.length < 6 || !trimmed.startsWith(key)) continue
    const ids = Array.isArray(value) ? value : [value]
    if (best === null || key.length > best.length) best = { length: key.length, ids }
    else if (key.length === best.length) best.ids = [...new Set([...best.ids, ...ids])]
  }
  return best === null ? [] : best.ids
}

/**
 * Human label for a catalog id described by an Artificial Analysis row.
 *
 * The row's name is the best label, except when it carries a release-date token
 * the id does not: `vanchin/deepseek-v4.1-flash` is a rolling alias, and AA's
 * only measurement of it is the "1017" snapshot. Labelling the alias with the
 * snapshot's date would state a version the id does not pin (the catalog once
 * shipped `vanchin/deepseek-v3` labelled "V3.2"). An effort qualifier is kept:
 * it says which inference variant was measured, and it is the same model.
 *
 * @param {string} id
 * @param {string} name
 * @returns {string}
 */
export function labelForId(id, name) {
  const bare = String(id ?? '')
  const plain = bare.includes('/') ? bare.slice(bare.lastIndexOf('/') + 1) : bare
  const dates = new Set(plain.toLowerCase().match(/\d{4,8}/g) ?? [])
  // AA's trailing parenthesis names the inference setting ("(Max)",
  // "(Non-reasoning)", "(Medium, Default Fallback)"), not the model. Effort
  // variants are the same model, so a label taken wholesale from whichever
  // variant won the row match would claim a setting the id does not pin.
  let label = String(name ?? plain)
  while (/\([^)]*\)\s*$/.test(label)) label = label.replace(/\s*\([^)]*\)\s*$/, '')
  return label
    .replace(/(^|[\s-])(\d{4,8})(?=[\s]|$)/g, (match, lead, digits) => (dates.has(digits) ? match : lead))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The label an entry must carry: its own if it names the model, the id's own
 * name otherwise.
 *
 * Reconciliation is the durable half of the identity rule. A wrong label used to
 * survive every refresh because the catalog rebuild copied entries it did not
 * re-derive; the joins then had two names for one model. The stored label is
 * kept when it agrees with the id (an effort qualifier is the same model), and
 * otherwise replaced with the id's name so the bad label cannot outlive the
 * refresh that noticed it. Date and effort tokens stay in the id, so an id like
 * `kimi-k3.1-pro-highspeed` keeps its serving variant in the label.
 *
 * @param {string} id
 * @param {string|null|undefined} label
 * @returns {string}
 */
export function reconciledLabel(id, label) {
  const stored = typeof label === 'string' ? label.trim() : ''
  if (stored.length > 0 && sameModelName(id, stored)) return stored
  return labelForId(id, bareId(id).replace(/^cmaas-/i, ''))
}

/**
 * The BenchGecko slug recorded in an entry's `sources`, if any.
 *
 * @param {object} entry
 * @returns {string|null}
 */
export function slugOf(entry) {
  for (const source of entry?.sources ?? []) {
    const match = /^https:\/\/benchgecko\.ai\/model\/([^/?#]+)$/.exec(String(source))
    if (match !== null) return decodeURIComponent(match[1])
  }
  return null
}

/**
 * Slugs to try for a model's own Artificial Analysis page.
 *
 * AA keeps a page per model even when it drops the model from the comparison
 * table, and that page carries the benchmark scores -- which is where GLM-5.1 and
 * MiniMax-M2.7 live today.
 *
 * @param {string} id - catalog model id, possibly provider- or reseller-prefixed
 * @returns {string[]}
 */
export function aaSlugCandidates(id) {
  let bare = String(id ?? '')
  const slash = bare.lastIndexOf('/')
  if (slash >= 0) bare = bare.slice(slash + 1)
  bare = bare.replace(/^cmaas-/i, '').toLowerCase()
  const dotted = bare.replace(/[^a-z0-9.]+/g, '-').replace(/\./g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  const flat = bare.replace(/[^a-z0-9]+/g, '')
  const undotted = flat.replace(/^([a-z]+)(\d)(\d+)/, '$1-$2-$3')
  return [...new Set([dotted, flat, undotted])].filter((slug) => slug.length > 0)
}

/**
 * The model family a key belongs to, for comparing like with like.
 *
 * `deepseek-v4-pro` and `deepseek-v4.1-flash` are alternatives to each other;
 * `qwen3.8-flash` is not, even when it happens to be cheaper and stronger. A
 * router that disables DeepSeek because one Qwen beats one DeepSeek is ranking
 * vendors, not models -- and a profile that serves several vendors needs the
 * choice to stay open.
 *
 * @param {string} key - `provider/model` or a bare model id
 * @returns {string}
 */
export function familyOf(key) {
  let id = String(key ?? '').toLowerCase()
  id = bareId(id)
  for (const prefix of RESELLER_PREFIXES) {
    if (id.startsWith(`${prefix}-`)) {
      id = id.slice(prefix.length + 1)
      break
    }
  }
  const word = /^[a-z]+/.exec(id)
  return word === null ? id : word[0]
}
