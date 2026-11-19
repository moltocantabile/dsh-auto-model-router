/**
 * Model types and per-model overrides.
 *
 * The router needs to know which advertised models are decision models (the ones
 * served by the System One protocol) so the decision-endpoint picker only offers
 * those, grouped by provider. Providers publish no type field, so the type is
 * resolved in this order:
 *
 *   1. a user override (a type assigned from the model's card);
 *   2. a name heuristic for the decision protocol (`decision-model`, `system-one`);
 *   3. `unknown` -- and an unknown type is left for the user to assign rather
 *      than guessed.
 *
 * The same override file carries the editable facts of a model: label, type,
 * modalities, tool support, context window and price. Edits are stored beside
 * the runtime catalog (`data/model-overrides.json`) and applied over the
 * knowledge base at load, so a refreshed catalog cannot wipe them.
 */
import fs from 'node:fs'

/** The types a model can be assigned. `unknown` means "not determined yet". */
export const MODEL_TYPES = Object.freeze(['decision', 'chat', 'unknown'])

/** Overrides live next to the runtime catalog, not inside it. */
export const MODEL_OVERRIDES_URL = new URL('../data/model-overrides.json', import.meta.url)

/** Facts an override may set. Everything else is source data and not editable. */
const EDITABLE = Object.freeze(['label', 'type', 'modalities', 'toolCalling', 'contextWindow', 'price'])

/** A model whose id names the decision protocol, whatever provider serves it. */
const DECISION_NAME = /(?:^|[^a-z])(decision|system[-\s]?one)(?:[^a-z]|$)/i

/**
 * Type inferred from the model id alone.
 *
 * @param {string} modelId
 * @returns {'decision'|'unknown'}
 */
export function detectModelType(modelId) {
  return DECISION_NAME.test(String(modelId ?? '')) ? 'decision' : 'unknown'
}

/** The `provider/model` key the override file and the board both use. */
export function modelTypeKey(provider, modelId) {
  return typeof provider === 'string' && provider.length > 0 ? `${provider}/${modelId}` : String(modelId)
}

/**
 * Read the overrides file. A missing or malformed file is an empty override set,
 * not an error: overrides are optional user data.
 *
 * @param {URL} [url]
 * @returns {{models: Record<string, object>, updatedAt: string|null}}
 */
export function loadModelOverrides(url = MODEL_OVERRIDES_URL) {
  try {
    if (!fs.existsSync(url)) return { models: {}, updatedAt: null }
    const parsed = JSON.parse(fs.readFileSync(url, 'utf8'))
    const models = parsed !== null && typeof parsed.models === 'object' && parsed.models !== null ? parsed.models : {}
    return { models, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null }
  } catch {
    return { models: {}, updatedAt: null }
  }
}

/** Keep only the fields an operator may edit, with the types the readers expect. */
export function sanitizeModelPatch(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  if (typeof patch.label === 'string' && patch.label.trim().length > 0) out.label = patch.label.trim().slice(0, 120)
  if (MODEL_TYPES.includes(patch.type)) out.type = patch.type
  if (Array.isArray(patch.modalities)) {
    const allowed = ['text', 'image', 'audio', 'video']
    const list = [...new Set(patch.modalities.filter((m) => allowed.includes(m)))]
    if (list.length > 0) out.modalities = list
  }
  if (typeof patch.toolCalling === 'boolean') out.toolCalling = patch.toolCalling
  if (patch.contextWindow === null || (Number.isFinite(Number(patch.contextWindow)) && Number(patch.contextWindow) >= 0)) {
    out.contextWindow = patch.contextWindow === null ? null : Math.round(Number(patch.contextWindow))
  }
  if (patch.price !== null && typeof patch.price === 'object') {
    const price = {}
    for (const field of ['input', 'output']) {
      const value = patch.price[field]
      if (value === null || (Number.isFinite(Number(value)) && Number(value) >= 0)) price[field] = value === null ? null : Number(value)
    }
    if (Object.keys(price).length > 0) out.price = price
  }
  return out
}

/** Merge new overrides over the existing ones, one model at a time. */
export function mergeModelOverrides(existing, key, patch) {
  const models = { ...(existing?.models ?? {}) }
  models[key] = { ...(models[key] ?? {}), ...sanitizeModelPatch(patch) }
  return { models, updatedAt: new Date().toISOString() }
}

/**
 * Write the override file.
 *
 * @param {{models: Record<string, object>, updatedAt?: string}} overrides
 * @param {URL} [url]
 * @returns {string} the path written
 */
export function saveModelOverrides(overrides, url = MODEL_OVERRIDES_URL) {
  fs.mkdirSync(new URL('.', url), { recursive: true })
  fs.writeFileSync(url, `${JSON.stringify({ ...overrides, updatedAt: overrides.updatedAt ?? new Date().toISOString() }, null, 2)}\n`)
  return url.pathname
}

/**
 * Apply overrides over the knowledge base in place.
 *
 * Only keys the base already carries are touched: an override for an id the
 * catalog does not describe cannot invent an entry, it only refines one.
 *
 * @param {Record<string, object>} dataset
 * @param {{models: Record<string, object>}} overrides
 * @returns {{id: string, fields: string[]}[]} which entries changed
 */
export function applyModelOverrides(dataset, overrides) {
  const changed = []
  for (const [key, patch] of Object.entries(overrides?.models ?? {})) {
    // A board key is provider-qualified; the knowledge base keys the model id the
    // catalog advertises (which may itself contain a vendor slash, so only the
    // provider segment is stripped).
    const bare = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key
    const entry = dataset?.[key] ?? dataset?.[bare]
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const fields = []
    for (const field of EDITABLE) {
      if (patch[field] === undefined) continue
      if (field === 'type') continue
      entry[field] = field === 'price' ? { ...(entry.price ?? {}), ...patch.price } : patch[field]
      fields.push(field)
    }
    if (fields.length > 0) changed.push({ id: key, entry: bare, fields })
  }
  return changed
}

/**
 * Type of one model: user override, then name heuristic, then unknown.
 *
 * @param {string} provider
 * @param {string} modelId
 * @param {{models: Record<string, object>}} [overrides]
 * @returns {'decision'|'chat'|'unknown'}
 */
export function modelTypeOf(provider, modelId, overrides) {
  const key = modelTypeKey(provider, modelId)
  const assigned = overrides?.models?.[key]?.type
  if (MODEL_TYPES.includes(assigned)) return assigned
  return detectModelType(modelId)
}

/**
 * The decision-endpoint picker's options: providers, and per provider only the
 * models typed `decision`.
 *
 * @param {string[]} providers - provider ids to group by
 * @param {(provider: string, modelId: string) => 'decision'|'chat'|'unknown'} typeOf
 * @param {Record<string, string[]>} catalogs - provider -> advertised model ids
 * @returns {{provider: string, models: string[]}[]}
 */
export function decisionOptions(providers, typeOf, catalogs) {
  const out = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const models = (catalogs?.[provider] ?? []).filter((id) => typeOf(provider, id) === 'decision')
    out.push({ provider, models })
  }
  return out
}
