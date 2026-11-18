/**
 * OpenRouter's "Top Weekly" model usage ranking, as a plain data source.
 *
 * `https://openrouter.ai/api/v1/models` (the documented catalog API) carries no
 * usage field, and the HTML of `/models?order=top-weekly` is rendered from data
 * the browser fetches afterwards. That request is:
 *
 *   GET https://openrouter.ai/api/frontend/v1/models/find?order=top-weekly&active=true
 *
 * It needs no API key and answers with roughly 6.8 MB of JSON:
 *
 *   {
 *     data: {
 *       models: [{
 *         slug: 'deepseek/deepseek-v4.1-flash-1017',
 *         name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
 *         author: 'deepseek',
 *         permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
 *         endpoint: {
 *           variant: 'standard',
 *           model_variant_permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
 *           pricing: { prompt: '0.000000036', completion: '0.0000005', ... },
 *         },
 *         ...
 *       }, ...],
 *       analytics: {
 *         'deepseek/deepseek-v4.1-flash-20261017': {
 *           date: '2026-11-11 00:00:00',
 *           total_prompt_tokens: 68645406422771,
 *           total_completion_tokens: 976713874841,
 *           ...
 *         }, ...
 *       },
 *       weekly_growth: { ... },
 *       ...
 *     }
 *   }
 *
 * `models` arrives sorted by exactly the usage the page labels "Top Weekly";
 * the first slug matches the public `/rankings` leaderboard. The `analytics`
 * map is a seven-day aggregate per model variant ("Tokens processed in the last
 * 7 days" in the page tooltip), which is where `weeklyTokens` comes from.
 *
 * Everything here is pure JSON handling: no host imports, no `ctx`, and no
 * filesystem writes.
 */

/** The documented catalog API (used as a model catalogue, but it has no usage). */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

/** The internal frontend endpoint that returns the usage-ranked model list. */
export const OPENROUTER_USAGE_URL = 'https://openrouter.ai/api/frontend/v1/models/find'

/** The order value behind `?order=top-weekly` on the models page. */
export const OPENROUTER_WEEKLY_ORDER = 'top-weekly'

/** The exact request behind the Top Weekly ranking (public, no auth). */
export const OPENROUTER_USAGE_REQUEST_URL = `${OPENROUTER_USAGE_URL}?order=${OPENROUTER_WEEKLY_ORDER}&active=true`

/** Prices are published per token; routing code wants dollars per million. */
const TOKENS_PER_MILLION = 1_000_000

/** Variant rows are labelled "… (free)" / "… (batch)"; the model id is not. */
const VARIANT_SUFFIX = /\s*\((?:batch|free)\)\s*$/i

/**
 * @typedef {{ prompt?: number, completion?: number }} OpenRouterPricing
 *   USD per million tokens.
 *
 * @typedef {object} OpenRouterUsageRow
 * @property {string} id - model id, e.g. `deepseek/deepseek-v4.1-flash-1017`.
 * @property {string} name - display name, variant suffix removed.
 * @property {string} [author] - first path segment of `id`.
 * @property {number} weeklyRank - 1-based position in the top-weekly ordering.
 * @property {number} [weeklyTokens] - prompt + completion tokens over 7 days.
 * @property {number} [weeklyShare] - `weeklyTokens` / total of all known rows.
 * @property {OpenRouterPricing} [pricing] - USD per million tokens.
 */

/** @returns {Record<string, unknown>|null} */
function objectOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** @returns {unknown[]|null} */
function arrayOf(value) {
  return Array.isArray(value) ? value : null
}

/** @returns {string|undefined} */
function textOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** @returns {number|undefined} */
function numberFrom(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The model array of a usage payload: the `models/find` response nests it under
 * `data.models`; a bare array is treated as an already-ordered model list.
 * A payload with only model data and no usage ordering (`{ data: [...] }`, as
 * returned by the catalog endpoint) is deliberately not ranked.
 *
 * @returns {unknown[]|null}
 */
function modelsOf(payload) {
  if (Array.isArray(payload)) return payload
  const root = objectOf(payload)
  if (root === null) return null
  const data = objectOf(root.data)
  return arrayOf(data?.models) ?? arrayOf(root.models)
}

/** @returns {Record<string, unknown>} */
function analyticsOf(payload) {
  const root = objectOf(payload)
  if (root === null) return {}
  const data = objectOf(root.data)
  return objectOf(data?.analytics) ?? objectOf(root.analytics) ?? {}
}

/** @returns {string|undefined} */
function modelIdOf(model) {
  return textOf(model.slug) ?? textOf(model.id) ?? textOf(model.permaslug)
}

/** `author/model` -> `author`. Alias ids may carry a leading `~`. */
function authorFromId(id) {
  const bare = id.startsWith('~') ? id.slice(1) : id
  const slash = bare.indexOf('/')
  return slash > 0 ? bare.slice(0, slash) : undefined
}

/** The analytics entry that belongs to this exact row (variant included). */
function usageKeyOf(model) {
  const endpoint = objectOf(model.endpoint)
  return (
    textOf(endpoint?.model_variant_permaslug) ??
    textOf(model.permaslug) ??
    textOf(model.slug)
  )
}

/** Prompt + completion tokens for the row's own seven-day analytics entry. */
function weeklyTokensOf(model, analytics) {
  const key = usageKeyOf(model)
  if (key === undefined) return undefined
  const row = objectOf(analytics[key])
  if (row === null) return undefined
  const prompt = numberFrom(row.total_prompt_tokens)
  const completion = numberFrom(row.total_completion_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  return (prompt ?? 0) + (completion ?? 0)
}

/** @returns {OpenRouterPricing|undefined} */
function pricingOf(model) {
  const endpoint = objectOf(model.endpoint)
  const raw = objectOf(endpoint?.pricing) ?? objectOf(model.pricing)
  if (raw === null) return undefined
  const pricing = {}
  const prompt = perMillion(raw.prompt)
  const completion = perMillion(raw.completion)
  if (prompt !== undefined) pricing.prompt = prompt
  if (completion !== undefined) pricing.completion = completion
  return Object.keys(pricing).length > 0 ? pricing : undefined
}

/** @returns {number|undefined} value in USD per million tokens. */
function perMillion(value) {
  const perToken = numberFrom(value)
  if (perToken === undefined || perToken < 0) return undefined
  return Number((perToken * TOKENS_PER_MILLION).toFixed(6))
}

/** @returns {string} */
function nameOf(model, id) {
  const name = textOf(model.name) ?? textOf(model.short_name) ?? id
  return name.replace(VARIANT_SUFFIX, '')
}

/** The standard variant is the one whose name and prices describe the model. */
function isStandardVariant(model) {
  const endpoint = objectOf(model.endpoint)
  if (endpoint === null) return true
  const variant = textOf(endpoint.variant)
  return variant === undefined || variant === 'standard'
}

/**
 * Normalise a `models/find?order=top-weekly` payload (or an already-ordered
 * model array) into one row per model.
 *
 * Rows keep the order the endpoint returned, which is the weekly usage
 * ranking, so `weeklyRank` is that position. `free`/`batch` variants share the
 * model id of the standard row, so they are merged into it: token counts add up
 * and the standard variant wins for `name`/`pricing`. Anything that does not
 * look like the expected payload yields `[]` instead of throwing.
 *
 * @param {unknown} payload
 * @returns {OpenRouterUsageRow[]}
 */
export function extractOpenRouterUsage(payload) {
  const models = modelsOf(payload)
  if (models === null) return []
  const analytics = analyticsOf(payload)
  const rows = new Map()

  for (const value of models) {
    const model = objectOf(value)
    if (model === null) continue
    const id = modelIdOf(model)
    if (id === undefined) continue

    const tokens = weeklyTokensOf(model, analytics)
    const standard = isStandardVariant(model)
    const name = nameOf(model, id)
    const author = authorFromId(id) ?? textOf(model.author)
    const pricing = pricingOf(model)

    const existing = rows.get(id)
    if (existing === undefined) {
      rows.set(id, { id, name, author, weeklyTokens: tokens, pricing, standard })
      continue
    }
    if (tokens !== undefined) existing.weeklyTokens = (existing.weeklyTokens ?? 0) + tokens
    if (standard && existing.standard === false) {
      existing.standard = true
      existing.name = name
      existing.author = author
      existing.pricing = pricing ?? existing.pricing
    } else if (existing.pricing === undefined && pricing !== undefined) {
      existing.pricing = pricing
    }
  }

  let totalTokens = 0
  for (const row of rows.values()) {
    if (Number.isFinite(row.weeklyTokens) && row.weeklyTokens > 0) totalTokens += row.weeklyTokens
  }

  const normalized = []
  let rank = 0
  for (const row of rows.values()) {
    rank += 1
    /** @type {OpenRouterUsageRow} */
    const entry = { id: row.id, name: row.name, author: row.author, weeklyRank: rank }
    if (Number.isFinite(row.weeklyTokens)) entry.weeklyTokens = row.weeklyTokens
    if (Number.isFinite(row.weeklyTokens) && totalTokens > 0) entry.weeklyShare = row.weeklyTokens / totalTokens
    if (row.pricing !== undefined) entry.pricing = row.pricing
    normalized.push(entry)
  }
  return normalized
}

/**
 * Fetch the current Top Weekly usage ranking.
 *
 * The request is public: no key, no auth header. HTTP and network failures are
 * thrown so a refresh can keep its previous snapshot rather than silently
 * replacing it with nothing; an unrecognised body still yields `[]`.
 *
 * @param {{ fetchImpl?: Function, signal?: AbortSignal }} [options]
 * @returns {Promise<OpenRouterUsageRow[]>}
 */
export async function fetchOpenRouterUsage({ fetchImpl = globalThis.fetch, signal } = {}) {
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new TypeError('fetchOpenRouterUsage needs a fetch implementation')
  const response = await fetchFn(OPENROUTER_USAGE_REQUEST_URL, {
    headers: { accept: 'application/json' },
    signal,
  })
  if (objectOf(response) === null) throw new TypeError('OpenRouter usage request returned no response')
  if (response.ok === false) {
    throw new Error(`OpenRouter usage request failed (HTTP ${response.status ?? 'unknown'})`)
  }
  const payload = await response.json()
  return extractOpenRouterUsage(payload)
}
