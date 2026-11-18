/**
 * Model selection, in the one place the harness allows it.
 *
 * `preStep` captures an agent's selection before any plugin code runs for that
 * step, and the `agent/request` waterfall rejects a provider/model change made
 * after that (`prepareRequest` throws). So a router may only *record* a
 * selection: `agent.model.select()` appends a durable `model/selection` event,
 * which is what the next step and every later turn read.
 */

/**
 * The selection object an agent expects.
 *
 * @param {{provider: string, model: string, reasoningEffort?: string}} route
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
export function selectionFor(route) {
  if (route === null || route === undefined) throw new Error('selectionFor needs a route')
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  }
}

/**
 * Record a route as an agent's model selection.
 *
 * Returns the selection that is now in effect, or null when nothing changed or
 * the agent cannot take a selection. A missing `agent.model.select` is not an
 * error: an agent detached from the live loop (or a harness version without the
 * API) must not break a turn over routing.
 *
 * @param {object} agent - the agent whose model call is being routed.
 * @param {object} route - route with provider/model (and optional reasoningEffort).
 * @param {object|null|undefined} previous - selection this router recorded last.
 * @returns {object|null} the selection now in effect, when one was recorded.
 */
export function selectRoute(agent, route, previous) {
  const model = agent?.model
  if (model === undefined || model === null || typeof model.select !== 'function') return null
  if (route === null || route === undefined) return null
  const selection = selectionFor(route)
  if (previous !== null && previous !== undefined && previous.provider === selection.provider && previous.model === selection.model && previous.reasoningEffort === selection.reasoningEffort) {
    return null
  }
  model.select(selection)
  return selection
}