/**
 * @dsh-external/dsh-auto-model-router
 *
 * Routes every model request through a System One decision model and applies
 * the structured reply as the agent's model selection. Main agents and
 * subagents are treated identically: both assemble prompts inside the agent
 * scope chain, so one host-plane plugin covers every agent the process runs —
 * including children spawned by `subagent`/`subagent_fork`.
 *
 * Seams used:
 * - `agent/inbox/claimed`  capture the batch claimed for the step (the new
 *   user message is not yet on the session surface when assembly runs).
 * - `agent/inbox/inserted` record the last decision as the agent's selection
 *   when a message lands, because `preStep` reads the selection synchronously
 *   with no async window in front of it.
 * - `system-prompt/assemble` (outermost) decide once per step and record the
 *   chosen route with `agent.model.select()` so it applies from the next step.
 *
 * Model choice never happens in `agent/request`: the harness fixes the step's
 * model before that waterfall runs and rejects a late change (see
 * `prepareRequest`). `agent.model.select()` is the supported seam.
 *
 * The plugin imports nothing at runtime: the host process resolves no peer
 * package for it, so an injected build needs only its own lib/ files.
 *
 * Config UI transport:
 * - `GET  /dsh-auto-model-router-api`  returns the full runtime snapshot.
 * - `POST /dsh-auto-model-router-api`  accepts the same operations as the
 *   `model_router` tool (`on`/`shadow`/`off`, `force`, `clear`, `explain`,
 *   `catalog` for the provider's model list, plus `configure` which also
 *   persists through the profile's config editor when the entry is
 *   addressable). The settings page and the tool are the two callers; both go
 *   through {@link runAction}.
 */
import {
  DEFAULT_DECISION,
  DEFAULT_POLICY,
  DEFAULT_ROUTES,
  buildState,
  isRoutableMessage,
  callDecisionModel,
  parseDecision,
} from './decision.js'
import { infoFor, knowledgeProvider, routingNote, applyDataset, applyProviderAliases, saveRuntimeDataset, saveRuntimeDerived, loadRuntimeDerived, MODEL_INFO, RUNTIME_DATA_URL } from './model-info.js'
import { refreshCatalog } from './refresh.js'
import { DEFAULT_SUMMARIZER, buildDigestPrompt, callChatModel, createDigestCache } from './summarize.js'
import { derivedRouteEnvelopes, mergeEnvelopes } from './refresh.js'
import { selectForTier, describeRanking, costIndex } from './select.js'
import { selectRoute as recordSelection } from './route.js'
import { TIER_IDS, assignTiers, membershipOf } from './tiers.js'

export const name = '@dsh-external/dsh-auto-model-router'
export const inject = ['tools']

const RECENT_LIMIT = 40
/** Below this many candidates the pool is the route-anchor fallback, not a catalog. */
const COLLAPSED_POOL = 8
/** How many model ids the decision model may be offered as a named choice. */
const MODEL_CHOICE_LIMIT = 40
const KEY_CACHE_MS = 60_000
const DECISION_REUSE_MS = 120_000
/**
 * How long a first digest may delay a decision. The summarizer's own timeout is
 * longer than this: whatever it produces after the deadline is still cached, so
 * the next decision benefits without this one waiting.
 */
const DIGEST_FIRST_BUDGET_MS = 1200
const ROUTE_VALIDITY_TTL_MS = 30_000
const ENTRY_ID = 'auto-model-router'
const API_PATH = '/dsh-auto-model-router-api'
const MODES = new Set(['on', 'shadow', 'off'])
const CATALOG_TTL_MS = 5 * 60_000
const CATALOG_ERROR_TTL_MS = 30_000
const TOOL_NAMES_TTL_MS = 60_000
/** Ids the provider advertises that must never be treated as routable tiers. */
const NON_ROUTING_IDS = new Set(['auto', 'decision-model-preview'])
const NON_ROUTING_PATTERN = /(audio|tts|video|image|embed|asr|ocr|wan\d|cosyvoice|omni)/i

/** Merge deployment config over the defaults without dropping catalog entries. */
function mergeConfig(input) {
  const provided = input ?? {}
  const routes = {}
  for (const [id, route] of Object.entries(DEFAULT_ROUTES)) routes[id] = { ...route }
  if (provided.routes !== undefined && provided.routes !== null) {
    for (const [id, route] of Object.entries(provided.routes)) routes[id] = { ...(routes[id] ?? {}), ...route }
  }
  const defaultRoute =
    routes[provided.defaultRoute] !== undefined
      ? provided.defaultRoute
      : routes.balanced !== undefined
        ? 'balanced'
        : Object.keys(routes)[0]
  return {
    mode: provided.mode ?? 'shadow',
    defaultRoute,
    routes,
    decision: { ...DEFAULT_DECISION, ...(provided.decision ?? {}) },
    policy: { ...DEFAULT_POLICY, ...(provided.policy ?? {}) },
    selection: {
      costWeight: 0.35,
      tierCostFactor: undefined,
      // How much real-world adoption biases a near-tie. 0 disables it.
      usageWeight: 0.5,
      ...(provided.selection ?? {}),
    },
    // How long a session keeps the route it started on. `sticky` chooses once per
    // session and then only moves when the user asks (a named model, `force`);
    // `auto` re-decides at every step. Sticky is the default because switching
    // models mid-task throws away the prompt cache and the style the turn began
    // in, and a session that keeps changing models is harder to reason about.
    switching: provided.switching === 'auto' ? 'auto' : 'sticky',
    // Tier membership is computed from measurement by default; `mode: manual`
    // means only the operator's own assignments route, and an unassigned model
    // stays out instead of being guessed at.
    tiers: {
      mode: provided.tiers?.mode === 'manual' ? 'manual' : 'auto',
      // Where tier ceilings come from: `explicit` trusts the config, `merge`
      // fills what the config omits from the measured catalog, `derived` uses the
      // data's cut-offs and keeps only the operator's latency policy.
      envelopeMode: ['explicit', 'merge', 'derived'].includes(provided.tiers?.envelopeMode) ? provided.tiers.envelopeMode : 'merge',
      overrides: { ...(provided.tiers?.overrides ?? {}) },
      disabled: [...(provided.tiers?.disabled ?? [])],
    },
    knowledgeProviderAliases: provided.knowledgeProviderAliases ?? {},
    logDecisions: provided.logDecisions ?? false,
  }
}

export function apply(ctx, input) {
  const INSTANCE = Math.random().toString(36).slice(2, 8)
  const config = mergeConfig(input)
  // Provider aliases decide which catalog entries share one knowledge entry, so
  // they are per-profile config rather than a table of vendor names in here.
  applyProviderAliases(config.knowledgeProviderAliases)
  const routes = config.routes

  /** Operator-authored envelopes, kept so a merge can be recomputed. */
  const operatorRoutes = JSON.parse(JSON.stringify(routes))
  let derivedEnvelopes = loadRuntimeDerived()

  /** Recompute tier envelopes from the operator config plus the derived cut-offs. */
  function applyEnvelopes() {
    const merged = mergeEnvelopes(operatorRoutes, derivedEnvelopes, config.tiers?.envelopeMode ?? 'merge')
    for (const [id, route] of Object.entries(merged)) {
      if (routes[id] === undefined) continue
      routes[id].envelope = route.envelope
    }
  }
  applyEnvelopes()

  let mode = config.mode
  let globalForce = null
  /** Pins that expire after they are used once (`force` with turns=1). */
  const turnPins = []
  let decisionSeq = 0
  let keyCache = null
  let keyCacheAt = 0

  /** Messages claimed for a step, consumed by the next assembly of that agent. */
  const claimed = new WeakMap()
  /** Latest decision computed for an agent, reused when its next message lands. */
  const pending = new WeakMap()
  /** The selection this router last recorded for an agent. */
  const recorded = new WeakMap()
  /** Where an agent is in the loop, for logs: `{ turn, step }`. */
  const position = new WeakMap()
  /** Route currently serving an agent (for switch hysteresis and status). */
  const current = new WeakMap()
  /** Per-agent forced route ids. */
  const forced = new WeakMap()
  /** `llm.resolveCallConfig` results per route id; false is sticky until reset. */
  const routeValidity = new Map()
  const decisions = []
  const stats = { requests: 0, decisions: 0, acknowledged: 0, applied: 0, switches: 0, fallbacks: 0, errors: 0, latencyTotal: 0, summaries: 0, digestChars: 0, digestFailures: 0 }

  /**
   * Whether a decision endpoint is configured. Routing needs an endpoint and a
   * model; the credential is optional, because a local server may not want one.
   */
  const decisionConfigured = () =>
    typeof config.decision.baseURL === 'string' && config.decision.baseURL.length > 0 &&
    typeof config.decision.model === 'string' && config.decision.model.length > 0

  let unconfiguredWarned = false
  function warnUnconfigured() {
    if (unconfiguredWarned) return
    unconfiguredWarned = true
    ctx.logger.warn('[model-router] no decision endpoint configured (decision.baseURL + decision.model); routing stays off until it is set')
  }

  /**
   * Model ids offered to the decision model as a `model` choice.
   *
   * @param {Array<object>} pool
   * @returns {Array<string>}
   */
  function offerModelIds(pool) {
    const ranked = [...pool].sort((a, b) => (b.info?.quality ?? 0) - (a.info?.quality ?? 0))
    const ids = []
    const seen = new Set()
    for (const candidate of ranked) {
      if (seen.has(candidate.model)) continue
      seen.add(candidate.model)
      ids.push(candidate.model)
      if (ids.length >= MODEL_CHOICE_LIMIT) break
    }
    return ids
  }

  /**
   * The cheapest model the pool can call, used when no summarizer model is
   * configured. Cost is the measured index, so an unpriced model does not win.
   */
  async function cheapestModel() {
    const pool = await candidatePool()
    let best = null
    for (const candidate of pool) {
      const cost = costIndex(candidate.info)
      if (best === null || cost < best.cost) best = { cost, model: candidate.model }
    }
    return best?.model ?? null
  }

  /** Summarizer settings, config over defaults. */
  const summarizerOptions = () => ({ ...DEFAULT_SUMMARIZER, ...(config.decision?.summarizer ?? {}) })

  /**
   * Session digests, one per agent.
   *
   * The summarizer reads the transcript with a cheap model and keeps a bounded
   * working-state digest; `decideFor` hands that digest to the decision model so
   * a step inherits the task it belongs to. Failures are counted and swallowed:
   * a digest is an improvement to a decision, never a precondition for one.
   */
  const digestCache = createDigestCache({
    summarize: async ({ previous, transcript, messageCount, signal }) => {
      const options = summarizerOptions()
      if (options.enabled === false) return previous ?? ''
      // Reading, not reasoning: with no model configured, use the cheapest one
      // the pool can actually call rather than a vendor's flash model.
      const model = options.model.length > 0 ? options.model : await cheapestModel()
      if (model === null) return previous ?? ''
      const { system, user } = buildDigestPrompt({ previous, transcript, maxChars: options.maxChars, messageCount })
      const digest = await callChatModel({
        baseURL: config.decision.baseURL,
        apiKey: await resolveApiKey(),
        model,
        system,
        user,
        timeoutMs: options.timeoutMs,
        signal,
      })
      stats.summaries += 1
      stats.digestChars = digest.length
      return digest
    },
    onError: (error) => {
      stats.digestFailures += 1
      ctx.logger.warn(`[model-router] session digest failed: ${error?.message ?? error}`)
    },
  })

  /** Keep the cache's thresholds in step with a live config change. */
  function syncDigestOptions() {
    const options = summarizerOptions()
    digestCache.configure({
      refreshEvery: options.refreshEvery,
      minMessages: options.minMessages,
      maxInputChars: options.maxInputChars,
    })
  }
  syncDigestOptions()

  /** Resolve the decision-model credential once per minute. */
  async function resolveApiKey() {
    if (keyCache !== null && Date.now() - keyCacheAt < KEY_CACHE_MS) return keyCache
    let value
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        value = (await credentials.resolve(config.decision.credentialRef))?.value
      } catch (error) {
        ctx.logger.warn(`[model-router] credential lookup failed: ${error?.message ?? error}`)
      }
    }
    if (value === undefined) value = process.env[config.decision.credentialRef]
    keyCache = value ?? null
    keyCacheAt = Date.now()
    return keyCache
  }

  /** Keep only the newest decisions for status reporting. */
  function remember(record) {
    decisions.push(record)
    if (decisions.length > RECENT_LIMIT) decisions.shift()
  }

  /**
   * The pin in effect for an agent: a route id, or `model:<id>` for a model the
   * user asked for by name. Returns null when nothing is pinned.
   */
  function pinOf(agent) {
    const pin = agent === undefined ? globalForce : forced.get(agent) ?? globalForce
    return pin ?? null
  }

  /** Split a pin into its kind and target. */
  function pinTarget(pin) {
    if (pin === null) return null
    if (typeof pin === 'string' && pin.startsWith('model:')) return { kind: 'model', model: pin.slice('model:'.length) }
    if (routes[pin] !== undefined) return { kind: 'route', routeId: pin }
    return null
  }

  /** Resolve the route that should serve this agent, honoring forced routes. */
  function routeOf(agent, decision) {
    const target = pinTarget(pinOf(agent))
    if (target?.kind === 'route') {
      return { id: target.routeId, ...routes[target.routeId] }
    }
    if (target?.kind === 'model') {
      const route = decision?.provider !== undefined && decision?.model === target.model
        ? { provider: decision.provider, model: decision.model }
        : Object.values(routes).find((candidate) => candidate.model === target.model) ?? {}
      return { id: `model:${target.model}`, ...route }
    }
    // New flow: decision has provider/model directly from the selection engine
    if (decision?.provider !== undefined && decision?.model !== undefined) {
      return { id: decision.routeId ?? config.defaultRoute, provider: decision.provider, model: decision.model }
    }
    // Fallback: look up by routeId
    let routeId = decision?.routeId
    if (routes[routeId] === undefined) routeId = config.defaultRoute
    return { id: routeId, ...routes[routeId] }
  }

  /** Provider model lists, cached per provider; failures are cached briefly. */
  const catalogs = new Map()
  /** Last catalog outcome per provider, so `status` can explain a missing provider. */
  const catalogStatus = new Map()
  /** Tool names per agent, cached so building a decision does not rebuild schemas. */
  const toolNames = new Map()

  /** The knowledge entry for a route's model, if the catalog has been described. */
  function routeInfo(route) {
    return infoFor(knowledgeProvider(route?.provider), route?.model)
  }

  /** Capability notes the decision prompt appends to each route description. */
  function routeNotes() {
    const notes = {}
    for (const [id, route] of Object.entries(routes)) {
      const note = routingNote(routeInfo(route))
      if (note.length > 0) notes[id] = note
    }
    return notes
  }

  /** Whether a provider model id can serve as a routing tier. */
  function routableModel(id) {
    return !NON_ROUTING_IDS.has(id) && !NON_ROUTING_PATTERN.test(id)
  }

  /** Tool names visible to one agent, cached: `tools.schemas()` is not free. */
  function toolNamesOf(agent) {
    const cached = toolNames.get(agent)
    if (cached !== undefined && Date.now() - cached.at < TOOL_NAMES_TTL_MS) return cached.names
    let names = []
    try {
      const registry = ctx.get('tools')
      if (registry !== undefined && typeof registry.schemas === 'function') {
        names = registry.schemas(agent).map((schema) => schema.name)
      }
    } catch {
      names = []
    }
    toolNames.set(agent, { at: Date.now(), names })
    return names
  }

  /** Models the provider advertises, enriched with the routing knowledge base. */
  async function providerModels(provider) {
    const cached = catalogs.get(provider)
    const cachedTtl = cached?.empty === true || cached?.error !== undefined ? CATALOG_ERROR_TTL_MS : CATALOG_TTL_MS
    if (cached !== undefined && Date.now() - cached.at < cachedTtl) {
      if (cached.error !== undefined) {
        // A failed refresh must not erase a provider that worked before: dropping
        // it silently shrank the whole board to whichever provider answered last.
        if (Array.isArray(cached.models) && cached.models.length > 0) return cached.models
        throw new Error(cached.error)
      }
      return cached.models
    }
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') {
      const models = []
      catalogs.set(provider, { at: Date.now(), models })
      return models
    }
    try {
      const listed = await llm.listModels(provider)
      const models = await Promise.all((Array.isArray(listed) ? listed : []).map(async (model) => {
        const info = infoFor(knowledgeProvider(provider), model.id)
        // A provider can advertise a model it has no credentialed route for; such
        // an id cannot serve a request, so the UI must not present it as a tier.
        let configured = true
        if (typeof llm.resolveModelInfo === 'function') {
          try {
            await llm.resolveModelInfo(provider, model.id)
          } catch {
            configured = false
          }
        }
        return {
          id: model.id,
          name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
          description: typeof model.description === 'string' ? model.description : undefined,
          inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ['text'],
          routable: routableModel(model.id),
          configured,
          retired: info?.retired === true,
          preview: info?.preview === true,
          sunsetAt: info?.sunsetAt,
          info,
        }
      }))
      // An empty list from a provider that answered with models before is a
      // transient state (adapters re-registering after a reload), not a fact. Keep
      // the known list and retry on the short TTL instead of publishing a board
      // built from nothing.
      const previousModels = Array.isArray(cached?.models) ? cached.models : null
      if (models.length === 0 && previousModels !== null && previousModels.length > 0) {
        catalogs.set(provider, { at: Date.now(), models: previousModels, empty: true })
        catalogStatus.set(provider, { at: Date.now(), models: previousModels.length, error: 'empty answer', stale: true })
        return previousModels
      }
      catalogs.set(provider, { at: Date.now(), models, ...(models.length === 0 ? { empty: true } : {}) })
      catalogStatus.set(provider, { at: Date.now(), models: models.length, error: null, stale: false })
      return models
    } catch (error) {
      const message = String(error?.message ?? error)
      const previous = Array.isArray(cached?.models) ? cached.models : null
      catalogs.set(provider, { at: Date.now(), error: message, ...(previous === null ? {} : { models: previous }) })
      catalogStatus.set(provider, { at: Date.now(), models: previous?.length ?? 0, error: message, stale: previous !== null })
      ctx.logger.warn(`[model-router] catalog for ${provider} failed: ${message}${previous === null ? '' : ` (keeping ${previous.length} cached models)`}`)
      if (previous !== null) return previous
      throw new Error(message)
    }
  }

  /** Snapshot of the model catalog the config page lists. */
  async function catalogPayload(provider) {
    const llm = ctx.get('llm')
    let providers = []
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      try {
        providers = llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }))
      } catch {
        providers = []
      }
    }
    const fallbackProvider = routes[config.defaultRoute]?.provider ?? Object.values(routes)[0]?.provider
    const chosen = typeof provider === 'string' && provider.length > 0 ? provider : fallbackProvider
    let models = []
    let error
    try {
      models = await providerModels(chosen)
    } catch (caught) {
      error = String(caught?.message ?? caught)
    }
    return { providers, provider: chosen, models, error }
  }

  /** Newest diagnostic the browser half sent: what it actually rendered. */
  let clientReport = null

  /** Newest tier assignment, so status and the config page can show it without
   * walking the catalog again. */
  // Shared through `globalThis`, not a closure: a reload can leave an older fiber
  // serving the HTTP route while a newer one serves the tool, and two closured
  // boards then disagree -- the page showed one provider while `status` showed
  // four. One process, one board.
  const SHARED = globalThis.__dshAutoModelRouterShared ??= { board: null, pool: [] }
  const lastBoard = () => SHARED.board

  /**
   * Tier membership for the current pool.
   *
   * Disabled models leave the routing pool entirely; the rest are grouped by the
   * assignment (auto or overridden) and the selector asks membership rather than
   * re-applying an envelope it has already satisfied.
   */
  /**
   * Build the tier board from the live pool.
   *
   * Returns null while the pool is still the route-anchor fallback: at startup
   * this runs before the LLM adapters have registered their providers, and
   * publishing that three-model board is what made a fresh start look like
   * "only tokenplan". A null board is honest — the page says it is loading —
   * and the retry below fills it in a moment.
   */
  async function assignedTiers() {
    let pool = await candidatePool()
    // A pool this small is not a catalog, it is the route anchors: the providers
    // answered empty while re-registering. Drop the cached answers and ask once
    // more before believing it.
    if (pool.length < COLLAPSED_POOL) {
      catalogs.clear()
      pool = await candidatePool()
    }
    if (pool.length < COLLAPSED_POOL && SHARED.board === null) {
      scheduleBoardRetry()
      return null
    }
    // A pool that collapsed — to nothing, or to a handful of route anchors — is a
    // catalog problem, not a routing decision. Keep the last good board so a
    // transient empty answer cannot shrink every tier to one provider.
    const previousSize = SHARED.pool.length
    if (SHARED.board !== null && previousSize >= 8 && pool.length < Math.floor(previousSize / 2)) {
      ctx.logger.warn(`[model-router] catalog returned ${pool.length} candidates (had ${previousSize}); keeping the previous tier board`)
      const kept = SHARED.pool.filter((candidate) => TIER_IDS.includes(SHARED.board.tierOf[candidate.key ?? candidate.model]))
      return {
        pool: SHARED.pool,
        assigned: SHARED.board,
        membership: membershipOf(SHARED.board),
        candidates: kept,
        byModel: new Map(SHARED.pool.map((candidate) => [candidate.model, candidate])),
      }
    }
    const assigned = assignTiers(pool, routes, config.tiers)
    // Rank and adoption travel with the board so the page can order a tier by
    // measured rank instead of insertion order, and show where a model sits.
    const meta = {}
    for (const candidate of pool) {
      const key = candidate.key ?? candidate.model
      const info = candidate.info ?? {}
      meta[key] = {
        rank: Number.isInteger(info.ranking?.rank) ? info.ranking.rank : null,
        composite: Number.isFinite(info.ranking?.composite) ? info.ranking.composite : null,
        status: info.ranking?.status ?? null,
        usage: Number.isFinite(info.usage?.percentile) ? info.usage.percentile : null,
      }
    }
    assigned.meta = meta
    const membership = membershipOf(assigned)
    const byModel = new Map(pool.map((candidate) => [candidate.model, candidate]))
    const candidates = pool.filter((candidate) => TIER_IDS.includes(assigned.tierOf[candidate.key ?? candidate.model]))
    SHARED.board = assigned
    SHARED.pool = pool
    return { pool, assigned, membership, candidates, byModel }
  }

  /**
   * Retry the board until the providers are registered.
   *
   * Startup order is not ours to control: the first walk can happen before the
   * provider adapters exist. Three spaced attempts cover it without polling
   * forever.
   */
  let boardRetryTimer = null
  const boardRetries = [500, 1500, 4000, 10000]
  function scheduleBoardRetry() {
    if (boardRetryTimer !== null) return
    const delay = boardRetries.shift()
    if (delay === undefined) return
    boardRetryTimer = setTimeout(() => {
      boardRetryTimer = null
      assignedTiers().catch((error) => {
        ctx.logger.warn(`[model-router] tier board retry failed: ${error?.message ?? error}`)
      })
    }, delay)
    boardRetryTimer.unref?.()
  }

  /** Candidates the assignment actually routes (everything not switched off). */
  function assignedMembers(candidates, assigned) {
    return candidates.filter((candidate) => TIER_IDS.includes(assigned.tierOf[candidate.key ?? candidate.model]))
  }

  /** Whether the llm runtime accepts this route; cached per route id. */
  /**
   * The set of models the selector may choose from.
   *
   * Tiers are a pinning device, not the decision space: fine-grained routing
   * needs every model the provider actually serves, or the selector can only
   * shuffle three names. The pool is the provider catalog filtered to models
   * that are routable, configured, and not retired — deduplicated by model id
   * across the route providers. Falls back to the configured tiers when the
   * catalog is unavailable, so a provider outage degrades to the old behavior
   * instead of failing.
   */
  /**
   * Providers the pool may draw from.
   *
   * Routes are envelopes, so a default install names no provider: the pool is
   * every provider the harness exposes, and the tiers pick from it. A route may
   * still name one to pin its tier to a provider.
   */
  async function poolProviders() {
    // Every provider the harness exposes. A route naming one provider is a
    // fallback anchor for that tier, not a statement that the other catalogs do
    // not exist -- narrowing here hid three of this profile's four providers.
    const allow = Array.isArray(config.selection?.providers) && config.selection.providers.length > 0
      ? new Set(config.selection.providers.map((id) => String(id)))
      : null
    let all = []
    const llm = ctx.get('llm')
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      try {
        all = llm.listProviders().map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.length > 0)
      } catch {
        all = []
      }
    }
    const providers = [...new Set(all)]
    return allow === null ? providers : providers.filter((id) => allow.has(id))
  }

  async function candidatePool() {
    const providers = await poolProviders()
    const pooled = []
    const seen = new Set()
    for (const provider of providers) {
      let catalog
      try {
        catalog = await catalogPayload(provider)
      } catch {
        continue
      }
      for (const model of catalog?.models ?? []) {
        if (model.routable === false || model.configured === false || model.retired === true) continue
        // Two providers can serve the same id; they are two routable endpoints,
        // so the key is provider-qualified rather than the bare id.
        const key = `${provider}/${model.id}`
        if (seen.has(key)) continue
        seen.add(key)
        pooled.push({ key, tier: 'auto', provider, model: model.id, info: model.info ?? routeInfo({ provider, model: model.id }), configured: true })
      }
    }
    if (pooled.length > 0) return pooled
    return Object.entries(routes)
      .filter(([, route]) => typeof route.provider === 'string' && typeof route.model === 'string')
      .map(([id, route]) => ({
        key: `${route.provider}/${route.model}`,
        tier: id,
        provider: route.provider,
        model: route.model,
        info: routeInfo(route),
        configured: true,
      }))
  }

  async function routeUsable(route, signal) {
    const cached = routeValidity.get(route.id)
    if (cached !== undefined && Date.now() - cached.at < ROUTE_VALIDITY_TTL_MS) return cached.ok
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.resolveCallConfig !== 'function') return true
    try {
      await llm.resolveCallConfig(
        {
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
        },
        signal,
      )
      routeValidity.set(route.id, { ok: true, at: Date.now() })
      return true
    } catch (error) {
      routeValidity.set(route.id, { ok: false, at: Date.now() })
      ctx.logger.warn(`[model-router] route "${route.id}" rejected by llm: ${error?.message ?? error}`)
      return false
    }
  }

  /** Ask the decision model about the current request once, with reuse. */
  async function decideFor(agent, claimedBatch, signal) {
    // The digest describes the whole session; the recent messages stay verbatim
    // because they are what is being routed. The first digest of a long session
    // gets a short budget so it cannot hold up a turn indefinitely, and whatever
    // arrives later still lands in the cache for the next decision.
    const messages = agent.session.deriveMessages()

    // An unconfigured decision endpoint leaves routing inert instead of falling
    // back to some vendor's service: the session keeps the model it started on.
    if (!decisionConfigured()) {
      warnUnconfigured()
      return null
    }

    // A step whose whole new input is harness-injected (a model-switch notice,
    // the environment block) is not a new request. Deciding from it would let
    // the router answer its own output, and a switch would keep re-routing.
    // The route that caused the notice stands instead.
    if (claimedBatch.length > 0 && !claimedBatch.some(isRoutableMessage)) {
      return pending.get(agent)?.decision ?? null
    }
    const pin = pinOf(agent)
    const pinTargetOf = pinTarget(pin)
    const forceId = pinTargetOf?.kind === 'route' ? pinTargetOf.routeId : null
    let digest = null
    if (summarizerOptions().enabled !== false) {
      const pending = digestCache.ensure(agent, messages, { waitForFirst: true })
      digest = await Promise.race([
        pending,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), DIGEST_FIRST_BUDGET_MS)
          timer.unref?.()
        }),
      ])
    }

    const state = buildState(messages, claimedBatch, config.decision, {
      agentKind: agent.session.header?.origin === 'subagent' ? 'subagent' : 'main',
      toolNames: toolNamesOf(agent),
      digest,
    })
    const signature = `${state.messageIds}\u0000${state.text.length}\u0000${state.task}\u0000${digest === null ? 0 : digest.length}`
    const previous = pending.get(agent)
    if (previous !== undefined && previous.signature === signature && Date.now() - previous.at < DECISION_REUSE_MS) {
      return previous.decision
    }
    if (mode === 'off') return null

    let started = Date.now()
    let latencyMs = 0
    let raw = null
    let failure = null
    stats.decisions += 1
    const pool = await candidatePool()
    try {
      raw = await callDecisionModel({
        baseURL: config.decision.baseURL,
        apiKey: await resolveApiKey(),
        model: config.decision.model,
        state: state.text,
        timeoutMs: config.decision.timeoutMs,
        // The model may only name something the router could actually call, and
        // the list is bounded: a profile serving 200 models would otherwise put
        // 200 choices in front of the decision model for a request that names
        // none of them. Best-measured first, so the ids a user is likely to ask
        // for are the ones offered.
        models: offerModelIds(pool),
        signal,
      })
    } catch (error) {
      failure = error
    }
    latencyMs = Date.now() - started
    if (failure !== null) {
      stats.errors += 1
      stats.fallbacks += 1
    }

    // Parse the decision model's reply into a task profile, then rank all
    // configured models by capability fit. The winner is the best fit; tiers
    // are just labels the operator uses to organize the pool.
    let selected = null
    let ranking = null
    let profile = null
    let confidence = 0
    let source = 'error'
    let tierChosen = null
    let envelopeWidened = false
    /** Tier groups the assignment produced for the pool this decision used. */
    let tiersAssigned = null

    if (failure === null) {
      const parsed = parseDecision(raw, routes, config.policy)
      profile = parsed.profile
      confidence = parsed.confidence
      source = parsed.source
      if (parsed.acknowledged === true) stats.acknowledged += 1

      // The user naming a model outranks every heuristic in this file: it is the
      // one signal that says what they want without inference.
      const requested = pool.find(
        (candidate) => candidate.key === parsed.requestedModel || candidate.model === parsed.requestedModel,
      ) ?? null
      if (pinTargetOf?.kind === 'model') {
        const pinned = pool.find((candidate) => candidate.key === pinTargetOf.model || candidate.model === pinTargetOf.model)
        if (pinned !== undefined) {
          selected = { provider: pinned.provider, model: pinned.model, tier: 'pinned' }
          tierChosen = null
          source = 'pin'
        }
      } else if (requested !== null) {
        selected = { provider: requested.provider, model: requested.model, tier: 'requested' }
        tierChosen = null
        source = 'requested'
      }

      if (selected !== null) {
        // a named model already decided this
      } else if (forceId !== null && routes[forceId] !== undefined) {
        selected = { provider: routes[forceId].provider, model: routes[forceId].model, tier: forceId }
        source = 'force'
      } else {
        const walked = await assignedTiers()
        if (walked === null) return null
        const { candidates, membership, assigned } = walked
        const result = selectForTier(profile, candidates, routes, {
          costWeight: config.selection?.costWeight,
          tierFactors: config.selection?.tierCostFactor,
          usageWeight: config.selection?.usageWeight,
          defaultRoute: config.defaultRoute,
          membership,
        })
        tiersAssigned = assigned.groups
        selected = result.selected
        ranking = result.ranking
        tierChosen = result.tier
        envelopeWidened = result.widened
        if (selected === null) {
          selected = { provider: routes[config.defaultRoute].provider, model: routes[config.defaultRoute].model, tier: config.defaultRoute }
          source = 'default'
        }
      }
    } else {
      selected = { provider: routes[config.defaultRoute].provider, model: routes[config.defaultRoute].model, tier: config.defaultRoute }
      source = 'error'
    }

    // A pin from `force turns=1` has now done its job.
    if (turnPins.length > 0 && pin !== null) {
      const spent = turnPins.splice(0, turnPins.length)
      for (const expire of spent) expire()
    }

    const record = {
      id: ++decisionSeq,
      at: Date.now(),
      agentId: agent.id,
      agentKind: agent.session.header?.origin === 'subagent' ? 'subagent' : 'main',
      task: state.task,
      routeId: tierChosen ?? selected.tier ?? config.defaultRoute,
      provider: selected.provider,
      model: selected.model,
      source,
      ...(tierChosen === null ? {} : { tier: tierChosen }),
      ...(envelopeWidened ? { envelopeWidened: true } : {}),
      ...(tiersAssigned === null ? {} : { tiers: tiersAssigned }),
      confidence,
      profile: failure === null ? profile : undefined,
      ranking: failure === null ? ranking : undefined,
      inputTokens: raw?.inputTokens,
      latencyMs,
      applied: false,
      switched: false,
      ...(failure === null ? {} : { error: String(failure.message ?? failure) }),
    }
    const where = position.get(agent)
    if (where !== undefined) {
      record.turn = where.turn
      record.step = where.step
    }
    pending.set(agent, { signature, at: Date.now(), decision: record })
    remember(record)
    stats.latencyTotal += latencyMs
    if (failure !== null) {
      ctx.logger.warn(`[model-router] decision failed for ${agent.id}: ${record.error}`)
    } else if (config.logDecisions || source !== 'ranked') {
      const desc = ranking !== null ? describeRanking(ranking) : `${selected.model} (${source})`
      ctx.logger.info(`[model-router] ${agent.id} -> ${desc}`)
    }
    return record
  }

  /**
   * Record a route as the agent's model selection.
   *
   * `preStep` captures the selection before any plugin code runs for that step,
   * and `agent/request` may not change provider/model afterwards, so this is the
   * only seam that moves an agent between models. `select()` appends a durable
   * `model/selection` event, which is what makes the change survive a resume.
   *
   * @returns whether a selection was recorded (false when it was already set).
   */
  /**
   * The model this session is already committed to, or null when it is still
   * the router's to choose.
   *
   * A deliberate choice is one written to the session as a `model/selection`
   * event: this router's own decision, the UI's model picker, or an earlier run
   * before a restart. The harness also writes one at startup for the configured
   * default route, which is not a choice anyone made — comparing against the
   * agent's own options tells the two apart. Without that comparison sticky
   * routing would keep every session on its configured default and never route.
   */
  function committedSelection(agent) {
    const inMemory = recorded.get(agent)
    if (inMemory !== undefined) return inMemory
    const model = agent?.model
    if (model === undefined || typeof model.recordedSelection !== 'function') return null
    const event = model.recordedSelection()
    if (event === null || event === undefined) return null
    const options = agent.options
    if (options?.provider === event.provider && options?.model === event.model) return null
    return { provider: event.provider, model: event.model }
  }

  /**
   * The model that actually served this session's last request.
   *
   * `model/selection` records deliberate choices, but the harness can also move
   * a session by falling back to another provider, and that path writes no
   * selection. The request header is the fact of what ran, so sticky routing
   * treats it as the commitment instead of pulling the session back to a route
   * the operator never asked for.
   */
  function servedSelection(agent) {
    const config = agent?.session?.requestHeader?.()?.config
    if (config === undefined || config === null) return null
    if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
    const options = agent.options
    if (options?.provider === config.provider && options?.model === config.model) return null
    return { provider: config.provider, model: config.model }
  }

  function selectRoute(agent, route) {
    const previous = recorded.get(agent) ?? null
    const selection = recordSelection(agent, route, previous)
    if (selection === null) return false
    recorded.set(agent, selection)
    if (previous !== null) stats.switches += 1
    stats.applied += 1
    current.set(agent, route.id)
    return true
  }

  /**
   * Pre-select for the step a newly landed message will open.
   *
   * A turn's first step has no window for a decision: the loop claims the
   * message and reads the selection in the same synchronous pass. So the route
   * recorded here is the one the previous step decided — exact for a
   * continuation ("continue", "ok"), and corrected by assembly before the next
   * step for a fresh request.
   */
  ctx.on('agent/inbox/inserted', (payload) => {
    const agent = payload?.agent
    // `shadow` observes and must not move a session between models, so this
    // gate is `on`, not `!== off`.
    if (agent === undefined || mode !== 'on') return
    const latest = pending.get(agent)?.decision
    if (latest === undefined) return
    try {
      selectRoute(agent, routeOf(agent, latest))
    } catch (error) {
      ctx.logger.warn(`[model-router] selection failed for ${agent.id}: ${error?.message ?? error}`)
    }
  })

  // ── decision input: the batch claimed for this step ────────────────────────
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const batch = claimed.get(agent) ?? []
    batch.push(payload.message)
    claimed.set(agent, batch)
    // One claim per step, so the counter is the step number. The harness does
    // not hand these numbers to assembly, and they are what makes a decision
    // log readable across a long turn.
    const turn = Number(payload.turn)
    const previous = position.get(agent)
    const step = Number.isFinite(turn) && previous?.turn === turn ? previous.step + 1 : 1
    position.set(agent, { turn: Number.isFinite(turn) ? turn : null, step })
  })

  // ── decide before the request is built, publish route variables ────────────
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      const agent = context?.agent
      const claimedBatch = agent === undefined ? [] : claimed.get(agent) ?? []
      if (agent !== undefined) claimed.delete(agent)
      const resolved = await next()
      if (agent === undefined || mode === 'off') return resolved
      // Membership is a fact about the catalog, not about the decision: refresh it
      // even when the decision endpoint is unavailable, or the board goes blank
      // exactly when the operator needs it to explain what routing would do.
      let walked = null
      try {
        walked = await assignedTiers()
      } catch (error) {
        ctx.logger.warn(`[model-router] tier assignment failed: ${error?.message ?? error}`)
      }
      if (walked === null) return resolved
      let decision
      try {
        decision = await decideFor(agent, claimedBatch, context.signal)
      } catch (error) {
        stats.errors += 1
        ctx.logger.warn(`[model-router] assembly decision failed for ${agent.id}: ${error?.message ?? error}`)
        return resolved
      }
      if (decision === null || mode !== 'on') return resolved
      let route = routeOf(agent, decision)
      if (!(await routeUsable(route, context.signal))) {
        const fallback = { id: config.defaultRoute, ...routes[config.defaultRoute] }
        if (route.id === fallback.id || !(await routeUsable(fallback, context.signal))) return resolved
        route = fallback
      }
      stats.requests += 1
      const switchesBefore = stats.switches

      // A decision that failed says nothing about the right model. Selecting the
      // default route here is how a broken endpoint used to move a session onto
      // a different model mid-task, and it fought the harness's own provider
      // fallback: the fallback moved the model, this moved it back.
      if (decision.source === 'error') return resolved

      // Sticky sessions keep the route they started on. The decision is still
      // computed and logged (so `status` explains what routing would have
      // done), but the session only moves when the request itself asked for a
      // model or a pin is in effect — a user naming a model is an instruction,
      // a router second-guessing itself is not.
      const kept = committedSelection(agent) ?? servedSelection(agent)
      const keepSticky = config.switching !== 'auto' && kept !== null && kept !== undefined && decision.source !== 'requested' && decision.source !== 'pin'
      if (keepSticky) {
        // What routing would have chosen stays in the record, so `status` shows
        // both the session's route and the router's opinion of this step.
        decision.sticky = true
        decision.proposed = { provider: decision.provider, model: decision.model, routeId: decision.routeId }
        decision.provider = kept.provider
        decision.model = kept.model
        decision.routeId = current.get(agent) ?? decision.routeId
        return resolved
      }

      // The step being assembled already has its model; this selection applies
      // from the next step, and to the next turn's first step via the insert
      // hook above.
      try {
        selectRoute(agent, route)
        decision.applied = true
        decision.routeId = route.id
        decision.switched = stats.switches > switchesBefore
      } catch (error) {
        ctx.logger.warn(`[model-router] selection failed for ${agent.id}: ${error?.message ?? error}`)
      }
      return resolved
    },
    { prepend: true },
  )

  // ── model-facing control surface ───────────────────────────────────────────
  function statusText(agent) {
    const lines = []
    lines.push(`auto model router: mode=${mode} switching=${config.switching} default=${config.defaultRoute} costWeight=${config.selection?.costWeight ?? 0.35}`)
    lines.push(
      decisionConfigured()
        ? `decision model: ${config.decision.model} @ ${config.decision.baseURL}`
        : 'decision model: not configured (routing inactive; set decision.baseURL + decision.model)',
    )
    const describePin = (pin) => (pin === null || pin === undefined ? 'none' : pin.replace(/^model:/, 'model '))
    lines.push(`force: global=${describePin(globalForce)} thisAgent=${describePin(agent === undefined ? null : forced.get(agent) ?? null)}`)
    // Who is in which tier, from the last assignment the router computed.
    const board = lastBoard()
    if (board !== null) {
      lines.push(`plugin instance: ${INSTANCE}`)
    const envelopeMode = config.tiers?.envelopeMode ?? 'merge'
    const derivedSample = derivedEnvelopes === null || derivedEnvelopes === undefined ? 0 : (derivedEnvelopes.fast?.sample ?? 0)
    lines.push(`envelopes: ${envelopeMode}${derivedEnvelopes === null ? ' (no derived cut-offs yet)' : ` (derived from ${derivedSample || 'measured'} models)`}`)
    lines.push(`tiers: ${board.mode}${board.overridden.length > 0 ? `, ${board.overridden.length} hand-assigned` : ''}`)
      for (const id of TIER_IDS) {
        const members = board.groups[id] ?? []
        lines.push(`  ${id}: ${members.length === 0 ? '(none)' : members.join(', ')}`)
      }
      if (board.groups.off.length > 0) {
        const shown = board.groups.off.slice(0, 12)
        const rest = board.groups.off.length - shown.length
        lines.push(`  off: ${shown.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`)
      }
      if ((board.unmeasured ?? []).length > 0) lines.push(`  unmeasured: ${board.unmeasured.length} not routable (no quality measurement)`)
      if ((board.dominated ?? []).length > 0) {
        lines.push(`  dominated: ${board.dominated.length} off (another model is cheaper and better)`)
      }
    }
    const summarizer = summarizerOptions()
    lines.push(
      summarizer.enabled === false
        ? 'session digest: off (routing on recent messages only)'
        : `session digest: ${summarizer.model}, ${stats.summaries} summarized${stats.digestFailures > 0 ? `, ${stats.digestFailures} failed` : ''}${stats.digestChars > 0 ? `, last ${stats.digestChars} chars` : ''}`,
    )
    if (catalogStatus.size > 0) {
      const parts = [...catalogStatus.entries()].map(([provider, status]) => {
        const age = Math.round((Date.now() - status.at) / 1000)
        if (status.error === null) return `${provider}=${status.models}`
        return `${provider}=${status.models}${status.stale ? ' stale' : ' FAILED'} (${status.error.slice(0, 60)}; ${age}s)`
      })
      lines.push(`catalog: ${parts.join(' | ')}`)
    }
    if (clientReport !== null) {
      const age = Math.round((Date.now() - clientReport.at) / 1000)
      lines.push(
        `browser page: build=${clientReport.build ?? '?'} instance=${clientReport.instance ?? '?'} board=${clientReport.board} providers=${clientReport.providers.length} ` +
          `capsules=${clientReport.capsules ?? '?'} lanes=${JSON.stringify(clientReport.lanes)} (${age}s ago)`,
      )
    } else {
      lines.push('browser page: no report (bundle predates the report, or the page has not opened settings)')
    }
    lines.push('routes:')
    for (const [id, route] of Object.entries(routes)) {
      const marks = []
      if (id === config.defaultRoute) marks.push('default')
      if (id === pinOf(agent)) marks.push('forced')
      if (id === (agent === undefined ? undefined : current.get(agent))) marks.push('current')
      const envelope = route.envelope ?? {}
      const caps = [
        typeof envelope.maxCost === 'number' ? `cost≤${envelope.maxCost}` : null,
        typeof envelope.minQuality === 'number' ? `q≥${envelope.minQuality}` : null,
        typeof envelope.maxLatency === 'string' ? `lat≤${envelope.maxLatency}` : null,
      ].filter((piece) => piece !== null)
      const suffix = caps.length === 0 ? '' : ` (${caps.join(' ')})`
      lines.push(`  ${id}: ${route.provider}/${route.model}${suffix}${marks.length === 0 ? '' : ` [${marks.join(', ')}]`}`)
    }
    const avg = stats.decisions === 0 ? 0 : Math.round(stats.latencyTotal / stats.decisions)
    lines.push(
      `stats: requests=${stats.requests} decisions=${stats.decisions} acknowledged=${stats.acknowledged} applied=${stats.applied} switches=${stats.switches} fallbacks=${stats.fallbacks} errors=${stats.errors} avgDecisionMs=${avg}`,
    )
    const agents = ctx.get('agents')
    const live = agents !== undefined && typeof agents.list === 'function' ? agents.list() : []
    if (live.length > 0) {
      lines.push('live agents:')
      for (const candidate of live.slice(0, 20)) {
        const kind = candidate.session?.header?.origin === 'subagent' ? 'subagent' : 'main'
        lines.push(`  ${candidate.id} [${kind}] route=${current.get(candidate) ?? '-'} status=${candidate.status}`)
      }
    }
    if (decisions.length > 0) {
      lines.push('recent decisions:')
      for (const record of decisions.slice(-8)) {
        const time = new Date(record.at).toISOString().slice(11, 19)
        const task = String(record.task ?? '').replace(/\s+/g, ' ').slice(0, 70)
        const state = record.applied ? 'applied' : mode === 'shadow' ? 'shadow' : 'decided'
        const prof = record.profile
        const shape = prof === undefined
          ? ''
          : ` shape=${prof.shape} d${prof.depth} b${prof.breadth} r${prof.risk}${prof.vision === true ? ' vision' : ''}`
        lines.push(
          `  ${time} ${record.agentId} [${record.agentKind}] turn=${record.turn ?? '-'} step=${record.step ?? '-'} -> ${record.source === 'error' ? '(no selection: decision failed)' : record.model ?? record.routeId}${record.sticky === true && record.proposed?.model !== record.model ? ` (kept; routing proposed ${record.proposed?.model})` : ''} conf=${Number(record.confidence ?? 0).toFixed(2)} src=${record.source}${shape} ${state} task="${task}"`,
        )
      }
    }
    return lines.join('\n')
  }

  async function explainText(text, signal, includeRaw = false) {
    const candidates = await candidatePool()
    const raw = await callDecisionModel({
      baseURL: config.decision.baseURL,
      apiKey: await resolveApiKey(),
      model: config.decision.model,
      state: text,
      timeoutMs: config.decision.timeoutMs,
      models: candidates.map((candidate) => candidate.model),
      signal,
    })
    const parsed = parseDecision(raw, routes, config.policy)
    const { profile, confidence } = parsed
    let source = parsed.source
    let result = null

    const requested = candidates.find((candidate) => candidate.model === parsed.requestedModel) ?? null
    if (requested !== null) {
      source = 'requested'
      result = { tier: null, eligible: candidates.length, widened: false, ranking: null, selected: { ...requested, tier: 'requested' } }
    } else {
      const assigned = assignTiers(candidates, routes, config.tiers)
      result = selectForTier(profile, assignedMembers(candidates, assigned), routes, {
        costWeight: config.selection?.costWeight,
        tierFactors: config.selection?.tierCostFactor,
        usageWeight: config.selection?.usageWeight,
        defaultRoute: config.defaultRoute,
        membership: membershipOf(assigned),
      })
    }
    if (parsed.acknowledged === true) source = `${source} (acknowledged per the model\'s own judgement)`
    const { selected, ranking } = result

    return JSON.stringify(
      {
        profile,
        confidence,
        source,
        ...(parsed.intent === undefined ? {} : { intent: parsed.intent }),
        ...(parsed.requestedModel === undefined ? {} : { requestedModel: parsed.requestedModel }),
        tier: result.tier,
        tierEligible: result.eligible,
        ...(result.widened ? { envelopeWidened: true } : {}),
        selected: selected
          ? { provider: selected.provider, model: selected.model, tier: selected.tier, reasons: selected.reasons, utility: selected.utility, quality: selected.quality, cost: selected.cost }
          : null,
        ranking: ranking
          ? {
              ranked: ranking.ranked.slice(0, 5).map((r) => ({
                model: r.model,
                tier: r.tier,
                utility: r.utility,
                quality: r.quality,
                cost: r.cost,
                reasons: r.reasons,
              })),
              excluded: ranking.excluded,
              weights: ranking.weights,
              floor: ranking.floor,
            }
          : null,
        inputTokens: raw?.inputTokens,
        serverLatencyMs: raw?.serverLatencyMs,
        ...(includeRaw ? { raw } : {}),
      },
      null,
      2,
    )
  }

  // ── one operation, two callers: tool and config UI share this surface ─────
  /** Lazy probe of whether the profile's config editor can persist this entry. */
  let persistenceProbe = null
  function persistenceInfo() {
    if (persistenceProbe !== null) return persistenceProbe
    const editor = ctx.get('configEditor')
    let addressable = false
    let reason = 'config editor unavailable'
    let document = null
    if (editor !== undefined) {
      try {
        const rows = editor.configuration()
        addressable = rows.some((row) => row.entry.options.id === ENTRY_ID)
        reason = addressable ? null : 'entry is not owned by the profile include tree'
      } catch (error) {
        reason = String(error?.message ?? error)
      }
      document = typeof editor.documentPath === 'string' ? editor.documentPath : null
    }
    persistenceProbe = { addressable, reason, document }
    return persistenceProbe
  }

  /** Persist a complete raw config through the profile's config editor. */
  async function persistConfig(next) {
    const info = persistenceInfo()
    if (!info.addressable) return { saved: false, reason: info.reason }
    const editor = ctx.get('configEditor')
    try {
      const rows = editor.configuration()
      const row = rows.find((candidate) => candidate.entry.options.id === ENTRY_ID)
      if (row === undefined) return { saved: false, reason: 'router entry disappeared' }
      await editor.edit(row.entry, (_current, inherited) => ({ ...inherited, ...next }))
      persistenceProbe = { ...info, addressable: true } // reloaded fiber may move entries; keep the probe warm
      return { saved: true, document: info.document }
    } catch (error) {
      return { saved: false, reason: String(error?.message ?? error) }
    }
  }

  /**
   * Coerce the tier assignment: an optional mode, per-model overrides, and the
   * list of models the operator switched off. Anything unknown is dropped rather
   * than trusted, so a hand-edited patch cannot aim a tier at a model that does
   * not exist.
   */
  function sanitizeTiers(input) {
    const source = input ?? {}
    const overrides = {}
    for (const [model, tier] of Object.entries(source.overrides ?? {})) {
      if (typeof model !== 'string' || model.length === 0) continue
      if (!TIER_IDS.includes(tier)) continue
      overrides[model] = tier
    }
    const disabled = [...new Set((Array.isArray(source.disabled) ? source.disabled : []).filter((id) => typeof id === 'string' && id.length > 0))]
    return {
      mode: source.mode === 'manual' ? 'manual' : 'auto',
      envelopeMode: ['explicit', 'merge', 'derived'].includes(source.envelopeMode) ? source.envelopeMode : (config.tiers?.envelopeMode ?? 'merge'),
      overrides,
      disabled,
    }
  }

  /** Coerce a UI-submitted config into the merged shape the runtime keeps. */
  function sanitizeConfig(input) {
    const source = input ?? {}
    const routes = {}
    const providedRoutes = source.routes ?? {}
    const userProvidedRoutes = Object.keys(providedRoutes).length > 0
    for (const [id, route] of Object.entries(providedRoutes)) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (route === null || typeof route !== 'object') continue
      // A route is an envelope. Naming a provider and model pins its tier to one
      // deployment; leaving them out is the default and the selector then chooses
      // from the whole pool, so those fields are optional here.
      const provider = String(route.provider ?? '').trim()
      const model = String(route.model ?? '').trim()
      const pinned = provider.length > 0 && model.length > 0
      const clean = pinned ? { provider, model } : {}
      const envelope = {}
      const maxCost = Number(route.envelope?.maxCost)
      if (Number.isFinite(maxCost) && maxCost > 0) envelope.maxCost = Math.min(100, Math.round(maxCost))
      const minQuality = Number(route.envelope?.minQuality)
      if (Number.isFinite(minQuality) && minQuality > 0) envelope.minQuality = Math.min(100, Math.round(minQuality))
      const maxLatency = String(route.envelope?.maxLatency ?? '').trim()
      if (['fast', 'balanced', 'slow'].includes(maxLatency)) envelope.maxLatency = maxLatency
      if (Object.keys(envelope).length > 0) clean.envelope = envelope
      const description = String(route.description ?? '').trim()
      if (description.length > 0) clean.description = description
      if (!pinned && clean.envelope === undefined && clean.description === undefined) continue
      if (typeof route.reasoningEffort === 'string' && route.reasoningEffort.length > 0) clean.reasoningEffort = route.reasoningEffort
      routes[id] = clean
    }
    // Only throw if the user explicitly provided routes that were all invalid;
    // omitting routes entirely means "use the defaults", which mergeConfig handles.
    if (userProvidedRoutes && Object.keys(routes).length === 0) throw new Error('configure requires at least one route with an envelope or a pinned provider/model')
    const decision = {}
    for (const key of ['baseURL', 'credentialRef', 'model']) {
      const value = String(source.decision?.[key] ?? '').trim()
      if (value.length === 0) throw new Error(`decision.${key} is required`)
      decision[key] = value
    }
    for (const key of ['timeoutMs', 'maxMessages', 'maxStateChars', 'maxMessageChars']) {
      const value = Number(source.decision?.[key])
      if (Number.isFinite(value) && value > 0) decision[key] = Math.floor(value)
    }
    // The summarizer is optional: absent means the defaults, and an explicit
    // `enabled: false` falls back to routing on the recent messages alone.
    const summarizer = {}
    if (source.decision?.summarizer !== undefined) {
      const input = source.decision.summarizer ?? {}
      if (typeof input.enabled === 'boolean') summarizer.enabled = input.enabled
      const model = String(input.model ?? '').trim()
      if (model.length > 0) summarizer.model = model
      for (const key of ['timeoutMs', 'maxChars', 'minMessages', 'refreshEvery']) {
        const value = Number(input[key])
        if (Number.isFinite(value) && value > 0) summarizer[key] = Math.floor(value)
      }
    }
    if (Object.keys(summarizer).length > 0) decision.summarizer = summarizer
    const selection = {}
    const costWeight = Number(source.selection?.costWeight)
    if (Number.isFinite(costWeight)) selection.costWeight = Math.max(0, Math.min(1, costWeight))
    const policy = {}
    for (const key of ['minConfidence', 'minProbability', 'switchConfidence', 'acknowledgeConfidence', 'modelRequestConfidence']) {
      const value = Number(source.policy?.[key])
      if (Number.isFinite(value) && value >= 0 && value <= 1) policy[key] = value
    }
    const requestedMode = source.mode
    return {
      mode: MODES.has(requestedMode) ? requestedMode : mode,
      switching: source.switching === 'auto' ? 'auto' : 'sticky',
      tiers: sanitizeTiers(source.tiers),
      defaultRoute: routes[source.defaultRoute] !== undefined
        ? source.defaultRoute
        : routes[config.defaultRoute] !== undefined
          ? config.defaultRoute
          : Object.keys(routes)[0],
      routes,
      decision,
      policy,
      selection,
      logDecisions: source.logDecisions === true,
    }
  }

  /** Machine-readable state for the config UI panel. */
  function snapshotPayload(agent) {
    // Which plugin instance served this payload: two fibers answering different
    // halves of the UI is invisible without it.
    const instance = INSTANCE
    const avg = stats.decisions === 0 ? 0 : Math.round(stats.latencyTotal / stats.decisions)
    // The board the UI renders is computed here, so the page and the router agree
    // about who is in which tier instead of each re-deriving it.
    const board = lastBoard()
    const agentsService = ctx.get('agents')
    const live = agentsService !== undefined && typeof agentsService.list === 'function' ? agentsService.list() : []
    const info = persistenceInfo()
    return {
      ok: true,
      mode,
      instance,
      defaultRoute: config.defaultRoute,
      // The page renders this board; it is computed by the host so the router and
      // the UI cannot disagree about who is in which tier.
      board,
      force: { global: globalForce ?? null, thisAgent: agent === undefined ? null : forced.get(agent) ?? null },
      config: {
        mode,
        defaultRoute: config.defaultRoute,
        routes: Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, { ...route }])),
        decision: { ...config.decision },
        policy: { ...config.policy },
        selection: { ...config.selection },
        switching: config.switching,
        tiers: { ...config.tiers },
        envelopes: { mode: config.tiers?.envelopeMode ?? 'merge', derived: derivedEnvelopes },
        logDecisions: config.logDecisions,
      },
      stats: {
        requests: stats.requests,
        decisions: stats.decisions,
        applied: stats.applied,
        switches: stats.switches,
        fallbacks: stats.fallbacks,
        errors: stats.errors,
        acknowledged: stats.acknowledged,
        avgDecisionMs: avg,
      },
      decisions: decisions.slice(-12).map((record) => ({ ...record })),
      agents: live.slice(0, 40).map((candidate) => ({
        id: candidate.id,
        kind: candidate.session?.header?.origin === 'subagent' ? 'subagent' : 'main',
        route: current.get(candidate) ?? null,
        status: candidate.status,
      })),
      persistence: {
        addressable: info.addressable,
        reason: info.reason,
        document: info.document,
      },
    }
  }

  /** Execute one router operation; shared by the tool and the config UI route. */
  async function runAction(action, args, agent, signal) {
    try {
      if (action === 'status' || action === 'snapshot') {
        return { ok: true, text: action === 'status' ? statusText(agent) : '', data: snapshotPayload(agent) }
      }
      if (action === 'digest') {
        const own = agent === undefined ? null : digestCache.peek(agent)
        const held = digestCache.entries()
        // No agent context does not mean no digest: report the newest one,
        // labelled, rather than an empty answer.
        const newest = own === null && held.length > 0 ? held[0] : null
        const digest = own ?? newest?.digest ?? null
        const text = digest === null
          ? 'no session digest yet (the summarizer runs once a session is long enough, and its first pass is bounded)'
          : newest !== null
            ? `[${newest.sessionId ?? 'unknown session'}]\n${digest}`
            : digest
        return {
          ok: true,
          text,
          data: {
            digest,
            sessions: held.map((entry) => ({ sessionId: entry.sessionId, covered: entry.covered })),
            model: summarizerOptions().model,
            enabled: summarizerOptions().enabled !== false,
          },
        }
      }
      if (action === 'config') {
        const payload = snapshotPayload(agent)
        return { ok: true, text: JSON.stringify(payload.config), data: payload }
      }
      if (action === 'refresh') {
        const started = Date.now()
        // The pool names the models the providers actually advertise, so the
        // refresh can describe ones the shipped catalog has never covered.
        const pool = await assignedTiers()
        const wanted = pool === null ? [] : pool.pool.map((candidate) => ({ model: candidate.model, provider: candidate.provider }))
        const result = await refreshCatalog({ base: MODEL_INFO, wanted, signal })
        const summary = { ...result.summary, durationMs: Date.now() - started }
        // Persist first: if writing fails, the in-memory catalog stays as it was,
        // so the page never shows numbers that would disappear on restart.
        summary.path = saveRuntimeDataset(result.dataset)
        if (result.derived !== null && result.derived !== undefined) {
          derivedEnvelopes = result.derived
          summary.envelopePath = saveRuntimeDerived(result.derived, { checkedAt: summary.checkedAt })
          applyEnvelopes()
        }
        applyDataset(result.dataset, { checkedAt: summary.checkedAt })
        summary.file = RUNTIME_DATA_URL.pathname
        const aa = summary.artificialAnalysis ?? {}
        const ranked = summary.ranking ?? {}
        const text = summary.errors.length === 0
          ? `model data refreshed: ${summary.models} models (${summary.benchgecko} benchgecko, ${summary.compass} compassrank, ${summary.epoch} epoch, ${summary.llmLeaderboard} llmleaderboard, ${aa.models ?? 0} artificialanalysis → ${aa.created ?? 0} new, ${aa.filledQuality ?? 0} measured, ${aa.filledPrice ?? 0} priced; openrouter usage ${summary.openrouter?.matched ?? 0}/${summary.openrouter?.rows ?? 0} matched; ranking: ${ranked.measured ?? 0} measured / ${ranked.provisional ?? 0} provisional / ${ranked.unmeasured ?? 0} unmeasured) at ${summary.checkedAt}`
          : `model data refreshed with ${summary.errors.length} source error(s): ${summary.errors.slice(0, 3).join('; ')}`
        return { ok: true, text, data: { summary } }
      }
      if (action === 'catalog') {
        const catalog = await catalogPayload(args?.provider)
        return { ok: true, text: JSON.stringify(catalog), data: { ...catalog } }
      }
      if (action === 'explain') {
        const text = String(args?.text ?? '').trim()
        if (text.length === 0) throw new Error('`explain` requires non-empty `text`')
        const decision = await explainText(text, signal, args?.raw === true)
        return { ok: true, text: decision, data: { decision } }
      }
      if (action === 'force') {
        // A route id pins a tier; a model id pins that model for the same scope.
        const wanted = String(args?.route ?? args?.model ?? '')
        const isRoute = routes[wanted] !== undefined
        let pin = wanted
        if (!isRoute) {
          const pool = await candidatePool()
          const named = pool.find((candidate) => candidate.model === wanted)
          if (named === undefined) throw new Error(`unknown route or model "${wanted}"; routes: ${Object.keys(routes).join(', ')}`)
          pin = `model:${named.model}`
        }
        if (args?.all === true) globalForce = pin
        else if (agent === undefined) throw new Error('`force` needs a calling agent unless all=true')
        else forced.set(agent, pin)
        const turns = Number(args?.turns ?? 0)
        const scope = `${args?.all === true ? 'all agents' : `agent ${agent.id}`}${turns === 1 ? ', this turn only' : ''}`
        if (turns === 1) {
          // One-shot: drop the pin as soon as it has been used, so the next
          // request goes back to deciding for itself.
          const oneShot = args?.all === true ? () => { globalForce = null } : () => { forced.delete(agent) }
          turnPins.push(oneShot)
        }
        return { ok: true, text: `forced ${isRoute ? 'route' : 'model'} ${wanted.replace(/^model:/, '')} for ${scope}`, data: snapshotPayload(agent) }
      }
      if (action === 'clear') {
        globalForce = null
        if (typeof forced.clear === 'function') forced.clear()
        routeValidity.clear()
        return { ok: true, text: 'cleared forced routes and route validation cache', data: snapshotPayload(agent) }
      }
      if (action === 'mode') {
        const requested = String(args?.mode ?? '')
        if (!MODES.has(requested)) throw new Error(`mode must be one of ${[...MODES].join(', ')}`)
        mode = requested
        if (mode !== 'off') routeValidity.clear()
        return { ok: true, text: `auto model router mode=${mode}`, data: snapshotPayload(agent) }
      }
      if (action === 'on' || action === 'shadow' || action === 'off') {
        mode = action
        if (action !== 'off') routeValidity.clear()
        return { ok: true, text: `auto model router mode=${mode}`, data: snapshotPayload(agent) }
      }
      if (action === 'configure') {
        const next = sanitizeConfig(args?.config)
        const merged = mergeConfig(next)
        config.defaultRoute = merged.defaultRoute
        // `routes` is captured by reference across the hooks: replace its contents,
        // never the binding, or decisions keep consulting the pre-configure catalog.
        for (const id of Object.keys(routes)) delete routes[id]
        Object.assign(routes, merged.routes)
        // The newly configured envelopes are the operator's, so they replace the
        // baseline a merge is computed from.
        for (const key of Object.keys(operatorRoutes)) delete operatorRoutes[key]
        Object.assign(operatorRoutes, JSON.parse(JSON.stringify(merged.routes)))
        applyEnvelopes()
        config.decision = merged.decision
        config.policy = merged.policy
        config.switching = merged.switching
        config.tiers = merged.tiers
        config.logDecisions = merged.logDecisions
        syncDigestOptions()
        mode = next.mode
        // the page reads the board straight after configure; do not make it wait
        // for the next step
        assignedTiers().catch(() => {})
        if (mode !== 'off') routeValidity.clear()
        const persist =
          args?.runtimeOnly === true
            ? { saved: false, reason: 'runtime only, not persisted' }
            : await persistConfig(next)
        const note = persist.saved === true
          ? `persisted to ${persist.document ?? 'the profile patch'}`
          : `runtime only (${persist.reason})`
        return { ok: true, text: `config applied; ${note}`, data: { persist, ...snapshotPayload(agent) } }
      }
      if (action === 'client-report') {
        // The page reporting on itself: the only way to tell "the bundle never
        // reached the browser" from "the host sent no data" without a debugger.
        const safe = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null)
        clientReport = {
          at: Date.now(),
          build: safe(args?.build, 40),
          board: args?.board === true,
          providers: Array.isArray(args?.providers) ? args.providers.slice(0, 12).map((id) => safe(id, 60)) : [],
          lanes: args?.lanes !== null && typeof args?.lanes === 'object' ? args.lanes : null,
          capsules: Number.isFinite(Number(args?.capsules)) ? Number(args.capsules) : null,
          tiersMode: safe(args?.tiersMode, 20),
        }
        return { ok: true, text: 'client report recorded', data: snapshotPayload(agent) }
      }
      throw new Error(`unknown action "${String(action)}"`)
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const routerTool = {
    name: 'model_router',
    description:
      'Inspect or control automatic model routing. `status` summarizes routes, live agents, counters and recent decisions; `config` returns the configuration as JSON; `catalog` lists the models the provider advertises, each with price, context and capability notes; `explain` classifies task text without routing; `digest` returns the session summary the decision model currently reads. `force` pins a route or an exact model (this agent, or every agent with all=true; `turns=1` expires after one turn), `clear` removes pins, `on`/`shadow`/`off` set the mode, and `configure` replaces routes, decision endpoint and policy — the same operation the settings page performs.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'digest', 'config', 'catalog', 'explain', 'force', 'clear', 'on', 'shadow', 'off', 'mode', 'configure'],
          description: 'Operation to perform.',
        },
        route: { type: 'string', description: 'Route id or model id to pin with `force`; a model id pins that exact model.' },
        text: { type: 'string', description: 'Task text to classify with `explain`.' },
        all: { type: 'boolean', description: 'Apply `force` to every agent instead of only the caller.' },
        turns: { type: 'integer', description: 'With `force`, pin for this many turns (1 = this turn only, then routing decides again).' },
        config: {
          type: 'object',
          description: 'Complete router config for `configure`: mode, defaultRoute, routes (id -> provider/model/description), decision (endpoint), policy.',
          additionalProperties: true,
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const outcome = await runAction(args?.action, args, exec.agent, exec.signal)
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.text
    },
  }

  ctx.effect(() => ctx.tools.register(routerTool), '@dsh-external/dsh-auto-model-router: model_router tool')

  // The tier board is catalog data, not routing state: compute it once at start
  // so the settings page is populated even when mode is `off` and no decision
  // ever runs.
  queueMicrotask(() => {
    assignedTiers().catch((error) => {
      ctx.logger.warn(`[model-router] initial tier assignment failed: ${error?.message ?? error}`)
    })
  })

  // ── config UI transport: JSON endpoint for the bundle-page panel ──────────
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const sendJson = (res, status, payload) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    const readBoundedBody = async (req) => {
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.byteLength
        if (size > 64 * 1024) {
          req.resume()
          return null
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: API_PATH,
      handler: async (req, res) => {
        const rejection = webCtx.connection?.requestRejection?.(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, snapshotPayload())
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('allow', 'GET, POST')
          res.end()
          return
        }
        if (String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
          return
        }
        let text
        try {
          text = await readBoundedBody(req)
        } catch {
          sendJson(res, 400, { ok: false, error: 'request body unreadable' })
          return
        }
        if (text === null) {
          sendJson(res, 413, { ok: false, error: 'request body is too large' })
          return
        }
        let body
        try {
          body = JSON.parse(text)
        } catch {
          sendJson(res, 400, { ok: false, error: 'request body must be JSON' })
          return
        }
        if (typeof body.action !== 'string') {
          sendJson(res, 400, { ok: false, error: 'missing action' })
          return
        }
        const outcome = await runAction(body.action, body, undefined, undefined)
        if (!outcome.ok) {
          sendJson(res, 400, { ok: false, error: outcome.error })
          return
        }
        sendJson(res, 200, { ok: true, ...outcome.data })
      },
    }), `auto-model-router: ${API_PATH}`)
  })
}