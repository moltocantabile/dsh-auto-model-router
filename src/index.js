/**
 * @dsh-external/dsh-auto-model-router
 *
 * Routes every model request through a System One decision model and applies
 * the structured reply to the request route. Main agents and subagents are
 * treated identically: both assemble prompts and dispatch `agent/request`
 * through the agent scope chain, so one host-plane plugin covers every agent
 * the process runs — including children spawned by `subagent`/`subagent_fork`.
 *
 * Seams used:
 * - `agent/inbox/claimed`  capture the batch claimed for the step (the new
 *   user message is not yet on the session surface when assembly runs).
 * - `system-prompt/assemble` (outermost) decide once per request and publish
 *   the chosen route as the `provider`/`model` prompt variables.
 * - `agent/request` (outermost) replace the frozen call config with that route.
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
  callDecisionModel,
  parseDecision,
} from './decision.js'
import { infoFor, knowledgeProvider, routingNote, applyDataset, saveRuntimeDataset, MODEL_INFO, RUNTIME_DATA_URL } from './model-info.js'
import { refreshCatalog } from './refresh.js'
import { DEFAULT_SUMMARIZER, buildDigestPrompt, callChatModel, createDigestCache } from './summarize.js'
import { selectForTier, describeRanking } from './select.js'

export const name = '@dsh-external/dsh-auto-model-router'
export const inject = ['tools']

const RECENT_LIMIT = 40
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
    selection: { costWeight: 0.35, tierCostFactor: undefined, ...(provided.selection ?? {}) },
    logDecisions: provided.logDecisions ?? false,
  }
}

export function apply(ctx, input) {
  const config = mergeConfig(input)
  const routes = config.routes

  let mode = config.mode
  let globalForce = null
  /** Pins that expire after they are used once (`force` with turns=1). */
  const turnPins = []
  let decisionSeq = 0
  let keyCache = null
  let keyCacheAt = 0

  /** Messages claimed for a step, consumed by the next assembly of that agent. */
  const claimed = new WeakMap()
  /** Latest decision computed for an agent, reused by its `agent/request`. */
  const pending = new WeakMap()
  /** Route currently serving an agent (for switch hysteresis and status). */
  const current = new WeakMap()
  /** Per-agent forced route ids. */
  const forced = new WeakMap()
  /** `llm.resolveCallConfig` results per route id; false is sticky until reset. */
  const routeValidity = new Map()
  const decisions = []
  const stats = { requests: 0, decisions: 0, acknowledged: 0, applied: 0, switches: 0, fallbacks: 0, errors: 0, latencyTotal: 0, summaries: 0, digestChars: 0, digestFailures: 0 }

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
      const { system, user } = buildDigestPrompt({ previous, transcript, maxChars: options.maxChars, messageCount })
      const digest = await callChatModel({
        baseURL: config.decision.baseURL,
        apiKey: await resolveApiKey(),
        model: options.model,
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
    if (cached !== undefined && Date.now() - cached.at < (cached.error === undefined ? CATALOG_TTL_MS : CATALOG_ERROR_TTL_MS)) {
      if (cached.error !== undefined) throw new Error(cached.error)
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
      catalogs.set(provider, { at: Date.now(), models })
      return models
    } catch (error) {
      const message = String(error?.message ?? error)
      catalogs.set(provider, { at: Date.now(), error: message })
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
  async function candidatePool() {
    const providers = [...new Set(Object.values(routes).map((route) => route.provider))]
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
        if (seen.has(model.id)) continue
        seen.add(model.id)
        pooled.push({ tier: 'auto', provider, model: model.id, info: model.info ?? routeInfo({ provider, model: model.id }), configured: true })
      }
    }
    if (pooled.length > 0) return pooled
    return Object.entries(routes).map(([id, route]) => ({
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
        // The model may only name something the router could actually call.
        models: pool.map((candidate) => candidate.model),
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

    if (failure === null) {
      const parsed = parseDecision(raw, routes, config.policy)
      profile = parsed.profile
      confidence = parsed.confidence
      source = parsed.source
      if (parsed.acknowledged === true) stats.acknowledged += 1

      // The user naming a model outranks every heuristic in this file: it is the
      // one signal that says what they want without inference.
      const requested = pool.find((candidate) => candidate.model === parsed.requestedModel) ?? null
      if (pinTargetOf?.kind === 'model') {
        const pinned = pool.find((candidate) => candidate.model === pinTargetOf.model)
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
        const candidates = await candidatePool()
        const result = selectForTier(profile, candidates, routes, {
          costWeight: config.selection?.costWeight,
          tierFactors: config.selection?.tierCostFactor,
          defaultRoute: config.defaultRoute,
        })
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
      confidence,
      profile: failure === null ? profile : undefined,
      ranking: failure === null ? ranking : undefined,
      inputTokens: raw?.inputTokens,
      latencyMs,
      applied: false,
      switched: false,
      ...(failure === null ? {} : { error: String(failure.message ?? failure) }),
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

  // ── decision input: the batch claimed for this step ────────────────────────
  ctx.on('agent/inbox/claimed', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    const batch = claimed.get(agent) ?? []
    batch.push(payload.message)
    claimed.set(agent, batch)
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
      return {
        ...resolved,
        variables: { ...(resolved.variables ?? {}), provider: route.provider, model: route.model },
      }
    },
    { prepend: true },
  )

  // ── apply the route to the actual model request ────────────────────────────
  ctx.on(
    'agent/request',
    async (payload, next) => {
      const resolved = await next()
      stats.requests += 1
      const agent = payload?.agent
      if (agent === undefined) return resolved
      const latest = pending.get(agent)
      if (latest === undefined) return resolved
      latest.decision.turn = payload.turn
      latest.decision.step = payload.step
      if (mode !== 'on') return resolved
      let route = routeOf(agent, latest.decision)
      if (!(await routeUsable(route, payload.signal))) {
        const fallback = { id: config.defaultRoute, ...routes[config.defaultRoute] }
        if (route.id !== fallback.id && (await routeUsable(fallback, payload.signal))) route = fallback
        else return resolved
      }
      const previous = current.get(agent)
      if (previous !== route.id) {
        stats.switches += 1
        latest.decision.switched = true
      }
      current.set(agent, route.id)
      latest.decision.applied = true
      latest.decision.routeId = route.id
      latest.decision.turn = payload.turn
      latest.decision.step = payload.step
      stats.applied += 1
      const { reasoningEffort: _inherited, ...rest } = resolved
      return {
        ...rest,
        provider: route.provider,
        model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      }
    },
    { prepend: true },
  )

  // ── model-facing control surface ───────────────────────────────────────────
  function statusText(agent) {
    const lines = []
    lines.push(`auto model router: mode=${mode} default=${config.defaultRoute} costWeight=${config.selection?.costWeight ?? 0.35}`)
    lines.push(`decision model: ${config.decision.model} @ ${config.decision.baseURL}`)
    const describePin = (pin) => (pin === null || pin === undefined ? 'none' : pin.replace(/^model:/, 'model '))
    lines.push(`force: global=${describePin(globalForce)} thisAgent=${describePin(agent === undefined ? null : forced.get(agent) ?? null)}`)
    const summarizer = summarizerOptions()
    lines.push(
      summarizer.enabled === false
        ? 'session digest: off (routing on recent messages only)'
        : `session digest: ${summarizer.model}, ${stats.summaries} summarized${stats.digestFailures > 0 ? `, ${stats.digestFailures} failed` : ''}${stats.digestChars > 0 ? `, last ${stats.digestChars} chars` : ''}`,
    )
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
          `  ${time} ${record.agentId} [${record.agentKind}] turn=${record.turn ?? '-'} step=${record.step ?? '-'} -> ${record.model ?? record.routeId} conf=${Number(record.confidence ?? 0).toFixed(2)} src=${record.source}${shape} ${state} task="${task}"`,
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
      result = selectForTier(profile, candidates, routes, {
        costWeight: config.selection?.costWeight,
        tierFactors: config.selection?.tierCostFactor,
        defaultRoute: config.defaultRoute,
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

  /** Coerce a UI-submitted config into the merged shape the runtime keeps. */
  function sanitizeConfig(input) {
    const source = input ?? {}
    const routes = {}
    for (const [id, route] of Object.entries(source.routes ?? {})) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (route === null || typeof route !== 'object') continue
      const provider = String(route.provider ?? '').trim()
      const model = String(route.model ?? '').trim()
      if (provider.length === 0 || model.length === 0) continue
      const clean = { provider, model }
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
      if (typeof route.reasoningEffort === 'string' && route.reasoningEffort.length > 0) clean.reasoningEffort = route.reasoningEffort
      routes[id] = clean
    }
    if (Object.keys(routes).length === 0) throw new Error('configure requires at least one complete route')
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
      defaultRoute: routes[source.defaultRoute] !== undefined ? source.defaultRoute : Object.keys(routes)[0],
      routes,
      decision,
      policy,
      selection,
      logDecisions: source.logDecisions === true,
    }
  }

  /** Machine-readable state for the config UI panel. */
  function snapshotPayload(agent) {
    const avg = stats.decisions === 0 ? 0 : Math.round(stats.latencyTotal / stats.decisions)
    const agentsService = ctx.get('agents')
    const live = agentsService !== undefined && typeof agentsService.list === 'function' ? agentsService.list() : []
    const info = persistenceInfo()
    return {
      ok: true,
      mode,
      defaultRoute: config.defaultRoute,
      force: { global: globalForce ?? null, thisAgent: agent === undefined ? null : forced.get(agent) ?? null },
      config: {
        mode,
        defaultRoute: config.defaultRoute,
        routes: Object.fromEntries(Object.entries(routes).map(([id, route]) => [id, { ...route }])),
        decision: { ...config.decision },
        policy: { ...config.policy },
        selection: { ...config.selection },
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
        const result = await refreshCatalog({ base: MODEL_INFO, signal })
        const summary = { ...result.summary, durationMs: Date.now() - started }
        // Persist first: if writing fails, the in-memory catalog stays as it was,
        // so the page never shows numbers that would disappear on restart.
        summary.path = saveRuntimeDataset(result.dataset)
        applyDataset(result.dataset, { checkedAt: summary.checkedAt })
        summary.file = RUNTIME_DATA_URL.pathname
        const text = summary.errors.length === 0
          ? `model data refreshed: ${summary.models} models (${summary.benchgecko} benchgecko, ${summary.compass} compassrank, ${summary.epoch} epoch, ${summary.llmLeaderboard} llmleaderboard) at ${summary.checkedAt}`
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
        config.decision = merged.decision
        config.policy = merged.policy
        config.logDecisions = merged.logDecisions
        syncDigestOptions()
        mode = next.mode
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