/**
 * Model knowledge base for capability-based routing.
 *
 * The router has two sources of truth:
 *
 * 1. The live provider catalog (`llm.listModels`) — which model ids the current
 *    provider actually advertises. This decides what the config UI offers and
 *    what can be routed to.
 * 2. This file — capability scores and qualitative facts the decision model
 *    needs but no provider API returns: coding/reasoning/math/knowledge/agentic
 *    scores, context window, modalities, latency class, and which work each
 *    model is good and bad at.
 *
 * Scores are 0-100 and merged from two independent leaderboard passes:
 *
 * - **BenchGecko** — per-benchmark results (SWE-bench, ARC-AGI, GPQA, AIME,
 *   LiveBench, APEX-Agents …) averaged over its own category labels.
 * - **OpenCompass CompassRank V3.0** — the official ability board (overall,
 *   knowledge, abstraction, reasoning, interaction, safety, agent) plus the
 *   benchmark board (SWE-bench Pro Verified, Terminal-Bench 4.0, Turnkey,
 *   WorkFlowBench, HLE-Diamond …), refreshed daily.
 *
 * Their scales differ, so CompassRank is aligned per dimension by the median
 * score gap on models both sources measured, then blended by sample count. A
 * model with 20 benchmark samples gets almost all its score from evidence; a
 * model with none gets a prior based on its family and release date. Both the
 * sample count (`evidence`) and the raw CompassRank numbers (`crossChecks`) are
 * exposed so the selector can discount models we know little about and a human
 * can audit any number.
 *
 * Prices are CNY per 1M tokens (Bailian Beijing list, peak rates), taken from
 * the providers' published pricing at `CHECKED_AT`; every entry keeps its
 * source URLs so a stale number is easy to audit and correct.
 */

import fs from 'node:fs'
import MODEL_INFO_DATA from './model-info-data.json' with { type: 'json' }

/**
 * Date of the bundled capture. A refreshed catalog carries its own date in
 * `CHECKED_AT` (rewritten by `applyDataset`), so this constant is the fallback.
 */
export let CHECKED_AT = '2026-11-18'

/**
 * The catalog in use. The bundled JSON is the baseline; a refresh writes a
 * sibling file and swaps the contents in place, so routing picks up new numbers
 * without a rebuild or a restart.
 */
export const MODEL_INFO = { ...MODEL_INFO_DATA }

/**
 * Where a refresh persists its result. It sits beside the bundled catalog inside
 * the plugin directory, which is writable in a workspace install and is the one
 * location both the build and the runtime can name without configuration.
 */
export const RUNTIME_DATA_URL = new URL('../data/model-info-runtime.json', import.meta.url)

/** Load a previously refreshed catalog, if one exists. */
function loadRuntime() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_DATA_URL, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed
  } catch {
    // No refresh yet, or an unreadable file: the bundled catalog stands.
  }
  return null
}

/**
 * Replace the catalog in place.
 *
 * Mutating the exported object (rather than rebinding it) keeps every existing
 * importer pointing at the live data.
 *
 * @param {Record<string, object>} dataset
 * @param {{checkedAt?: string}} [meta]
 */
export function applyDataset(dataset, meta = {}) {
  if (dataset === null || typeof dataset !== 'object') return false
  for (const key of Object.keys(MODEL_INFO)) delete MODEL_INFO[key]
  Object.assign(MODEL_INFO, dataset)
  if (typeof meta.checkedAt === 'string' && meta.checkedAt.length > 0) CHECKED_AT = meta.checkedAt
  return true
}

/** Persist a refreshed catalog so it survives the next start. */
export function saveRuntimeDataset(dataset) {
  fs.mkdirSync(new URL('.', RUNTIME_DATA_URL), { recursive: true })
  fs.writeFileSync(RUNTIME_DATA_URL, JSON.stringify(dataset, null, 2))
  return RUNTIME_DATA_URL.pathname
}

const RUNTIME = loadRuntime()
if (RUNTIME !== null) applyDataset(RUNTIME)

/**
 * Provider ids that differ only by deployment, never by model identity.
 *
 * Operator config, not an opinion about vendors: two provider entries that serve
 * the same catalog should share one knowledge entry, and which entries those are
 * depends on the profile, so `knowledgeProviderAliases` in the plugin config
 * extends this map.
 */
const PROVIDER_ALIASES = {}

/** The alias map plus whatever the operator configured. */
function providerAliases() {
  const configured = getAliases()
  return { ...PROVIDER_ALIASES, ...configured }
}

let configuredAliases = {}
/** Replace the operator-supplied alias map (called from the plugin config). */
export function applyProviderAliases(aliases) {
  configuredAliases = aliases !== null && typeof aliases === 'object' ? { ...aliases } : {}
}

function getAliases() {
  return configuredAliases
}

/** Canonical model key: drop a provider prefix, lowercase, trim. */
export function modelKey(provider, modelId) {
  let id = String(modelId ?? '').trim()
  if (id.includes('/')) {
    const [head, ...rest] = id.split('/')
    // Only strip a prefix that is the provider itself or one of its documented
    // aliases — a slash inside a model name is part of the name.
    const aliases = providerAliases()
    const known = head === provider || aliases[head] === provider || Object.values(aliases).includes(head)
    if (rest.length > 0 && known) id = rest.join('/')
  }
  if (id.includes(':')) id = id.slice(id.indexOf(':') + 1)
  return id.toLowerCase()
}

/**
 * Look up the knowledge entry for one provider/model pair.
 * @param {string} provider - provider route id as the harness reports it.
 * @param {string} modelId - model id as the provider advertises it.
 * @returns {object | null} detached entry with a `key`, or null when unknown.
 */
export function infoFor(provider, modelId) {
  const key = modelKey(provider, modelId)
  const direct = MODEL_INFO[key]
  if (direct !== undefined) return { key, ...direct }
  // A dated sibling (`...-1017`) may not have its own entry; the family entry
  // still describes it well enough for routing.
  const family = key.replace(/-\d{3,4}$/, '')
  if (family !== key && MODEL_INFO[family] !== undefined) return { key, ...MODEL_INFO[family], familyOf: family }
  return null
}

/** Provider id used for knowledge lookups (deployments share one catalog). */
export function knowledgeProvider(provider) {
  const aliases = providerAliases()
  return aliases[String(provider ?? '')] ?? String(provider ?? '')
}

const money = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value === 0) return '0'
  return value >= 1 ? String(Number(value.toFixed(2))) : String(Number(value.toFixed(3)))
}

/** Human context length: `262k`, `1M`, `128k`. */
export function contextLabel(tokens) {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1))}M`
  return `${Math.round(tokens / 1000)}k`
}

/**
 * One compact line the config page can show under a model picker.
 * @param {object|null} info - entry from {@link infoFor}.
 * @returns {string[]} ordered fragments, empty when nothing is known.
 */
export function capabilityFragments(info) {
  if (info === null || info === undefined) return []
  const parts = []
  const ctx = contextLabel(info.contextWindow)
  if (ctx !== null) parts.push(`${ctx} ctx`)
  if (info.price !== undefined) {
    const input = money(info.price.input)
    const output = money(info.price.output)
    if (input !== null && output !== null) parts.push(`¥${input} / ¥${output} per 1M`)
  }
  if (typeof info.latency === 'string') parts.push(info.latency)
  if (info.reasoning === true) parts.push('reasoning')
  if (info.toolCalling === true) parts.push('tools')
  const modalities = Array.isArray(info.modalities) ? info.modalities.filter((m) => m !== 'text') : []
  if (modalities.length > 0) parts.push(modalities.join('+'))
  return parts
}

/**
 * The routing note appended to a route's own description inside the decision
 * prompt: capability facts plus what the model is good and bad at.
 * @param {object|null} info - entry from {@link infoFor}.
 * @param {number} maxChars - hard cap so one verbose entry cannot crowd the prompt.
 * @returns {string} a single sentence fragment, or "" when nothing is known.
 */
export function routingNote(info, maxChars = 320) {
  if (info === null || info === undefined) return ''
  const pieces = []
  const capability = capabilityFragments(info).join(', ')
  if (capability.length > 0) pieces.push(capability)
  if (Array.isArray(info.bestFor) && info.bestFor.length > 0) {
    pieces.push(`good at ${info.bestFor.slice(0, 3).join('; ')}`)
  }
  if (Array.isArray(info.weaknesses) && info.weaknesses.length > 0) {
    pieces.push(`weak at ${info.weaknesses.slice(0, 2).join('; ')}`)
  }
  let note = pieces.join('. ')
  if (note.length === 0) return ''
  if (note.length > maxChars) note = `${note.slice(0, maxChars - 1)}…`
  return note
}

/**
 * Capability score summary for the UI and the tool.
 * @param {object|null} info
 * @returns {{scores: Record<string, number>|null, evidence: Record<string, number>|null, quality: number|null}}
 */
export function capabilitySummary(info) {
  if (info === null || info === undefined) return { scores: null, evidence: null, quality: null }
  return {
    scores: info.scores ?? null,
    evidence: info.evidence ?? null,
    quality: info.quality ?? null,
    distinguishing: info.distinguishing ?? [],
    // The second leaderboard pass, kept raw so a reader can see what
    // CompassRank measured independently of the blended scores.
    crossChecks: info.crossChecks ?? null,
    benchmarkSources: info.benchmarkSources ?? [],
    checkedAt: CHECKED_AT,
  }
}
