#!/usr/bin/env node
/**
 * Rebuild the runtime catalog from the sources.
 *
 * The committed runtime catalog (`data/model-info-runtime.json`) and the tier
 * envelopes derived from it (`data/routing-derived.json`) are products, not
 * inputs. This script produces both from:
 *
 *   - the hand-authored baseline catalog (`src/model-info-data.json`: prices,
 *     limits, modalities and the qualitative notes a source does not publish);
 *   - `data/catalog-pool.json`, the provider catalog captured from the host
 *     (`llm.listModels`), which says which model ids are actually advertised;
 *   - the live sources `refreshCatalog()` fetches: CompassRank's two CDN
 *     boards, BenchGecko's per-model documents, Epoch's ECI CSV,
 *     llmleaderboard's comparison CSV and benchmark pages, Artificial
 *     Analysis' table and model pages, and OpenRouter's weekly usage.
 *
 * Rebuilding from the baseline rather than from the previous runtime catalog is
 * deliberate: an entry the last refresh invented (a wrong label, a stale
 * cross-check, an AA-only row AA has since dropped) must not survive by being
 * its own input. Only ids a source can describe at refresh time get an entry.
 *
 * Usage:
 *   node scripts/refresh-database.mjs                 # write both files
 *   node scripts/refresh-database.mjs --dry-run       # fetch, print counts, write nothing
 *   node scripts/refresh-database.mjs --allow-errors  # write even if a source failed
 *   node scripts/refresh-database.mjs --base <path> --pool <path>
 *
 * A refresh with any source error exits non-zero without writing: a catalog
 * built from half the sources silently loses the measurements the failed source
 * carried.
 */
import fs from 'node:fs'

import { refreshCatalog } from '../src/refresh.js'
import { rankTable } from '../src/rank.js'
import { saveRuntimeDataset, saveRuntimeDerived } from '../src/model-info.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const basePath = option('base', new URL('../src/model-info-data.json', import.meta.url).pathname)
const poolPath = option('pool', new URL('../data/catalog-pool.json', import.meta.url).pathname)
const reportPath = new URL('../data/refresh-report.json', import.meta.url).pathname
const dryRun = args.includes('--dry-run')
const familyJoin = args.includes('--family-join')
const outPath = option('out', new URL('../data/model-info-runtime.json', import.meta.url).pathname)
const derivedOutPath = option('derived-out', new URL('../data/routing-derived.json', import.meta.url).pathname)
const allowErrors = args.includes('--allow-errors')

/** Same filter as `routableModel()` in src/index.js: chat models only. */
const NON_ROUTING_IDS = new Set(['auto', 'decision-model-preview'])
const NON_ROUTING_PATTERN = /(audio|tts|video|image|embed|asr|ocr|wan\d|cosyvoice|omni)/i

const base = JSON.parse(fs.readFileSync(basePath, 'utf8'))
const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'))
const wanted = []
const seen = new Set()
for (const raw of pool.wanted ?? []) {
  const model = typeof raw === 'string' ? raw : raw?.model
  const provider = typeof raw === 'string' ? undefined : raw?.provider
  if (typeof model !== 'string' || model.length === 0) continue
  if (NON_ROUTING_IDS.has(model) || NON_ROUTING_PATTERN.test(model)) continue
  const key = `${provider ?? ''}/${model}`
  if (seen.has(key)) continue
  seen.add(key)
  wanted.push({ model, ...(provider === undefined ? {} : { provider }) })
}

console.log(`base: ${Object.keys(base).length} entries (${basePath})`)
console.log(`pool: ${wanted.length} advertised chat models (${poolPath})`)
console.log('fetching the live sources ...')
const started = Date.now()
const result = await refreshCatalog({ base, wanted, joinFamilyForAnalysis: familyJoin })
const { summary } = result

// The diagnostics are recomputed from the written catalog: they are the audit
// trail for "which gaps are data availability and which are code decisions".
const table = rankTable(result.dataset)
const root = new URL('..', import.meta.url).pathname
const relative = (path) => (path.startsWith(root) ? path.slice(root.length) : path)
const report = {
  checkedAt: summary.checkedAt,
  durationMs: Date.now() - started,
  base: relative(basePath),
  pool: relative(poolPath),
  models: summary.models,
  sources: summary.sources,
  benchgecko: summary.benchgecko,
  compass: summary.compass,
  epoch: summary.epoch,
  llmLeaderboard: summary.llmLeaderboard,
  artificialAnalysis: summary.artificialAnalysis,
  openrouter: summary.openrouter,
  ranking: summary.ranking,
  envelopes: summary.envelopes,
  errors: summary.errors,
  reconciled: summary.reconciled ?? [],
  diagnostics: {
    sourceAgreement: table.sourceAgreement,
    quantiles: table.quantiles,
    channels: table.coverage.channels,
    uncalibrated: table.coverage.uncalibrated,
    unknownBenchmarks: table.unknownBenchmarks,
    indexSignals: table.indexSignals,
  },
}

if (summary.errors.length > 0) {
  console.error(`\n${summary.errors.length} source error(s):`)
  for (const error of summary.errors) console.error(`  ${error}`)
  if (!allowErrors) {
    console.error('\nrefusing to write a catalog built from a partial refresh (pass --allow-errors to override)')
    process.exit(1)
  }
}

console.log(`\nmodels ${summary.models}: ${summary.benchgecko} benchgecko, ${summary.compass} compassrank, ` +
  `${summary.epoch} epoch, ${summary.llmLeaderboard} llmleaderboard, ` +
  `${summary.artificialAnalysis.models} artificialanalysis (${summary.artificialAnalysis.created} new, ` +
  `${summary.artificialAnalysis.measured} measured); openrouter usage ` +
  `${summary.openrouter.matched}/${summary.openrouter.rows} matched`)
console.log(`ranking: ${summary.ranking.measured} measured / ${summary.ranking.provisional} provisional / ` +
  `${summary.ranking.unmeasured} unmeasured, ${summary.ranking.uncalibratedObservations} uncalibrated observations`)
if (summary.envelopes?.valid === false) console.log(`envelopes: not derived (${summary.envelopes.reason})`)
else if (summary.envelopes !== undefined && summary.envelopes !== null) {
  console.log(`envelopes from ${summary.envelopes.sample} measured+priced models: ` +
    Object.entries(result.derived ?? {}).map(([tier, e]) => `${tier} cost<=${e.maxCost} quality>=${e.minQuality}`).join(', '))
}

if (dryRun) {
  console.log('\n--dry-run: nothing written')
  process.exit(0)
}

// Custom output paths let the two join policies be built side by side for a
// comparison without overwriting the catalog in use.
const toMain = outPath === reportPath || outPath.endsWith('model-info-runtime.json')
const written = outPath.endsWith('model-info-runtime.json') ? saveRuntimeDataset(result.dataset) : (fs.writeFileSync(outPath, `${JSON.stringify(result.dataset, null, 2)}\n`), outPath)
if (result.derived !== null && result.derived !== undefined) {
  if (derivedOutPath.endsWith('routing-derived.json')) {
    saveRuntimeDerived(result.derived, { checkedAt: summary.checkedAt, sample: summary.envelopes.sample })
  } else {
    fs.writeFileSync(derivedOutPath, `${JSON.stringify({ checkedAt: summary.checkedAt, sample: summary.envelopes.sample, envelopes: result.derived }, null, 2)}\n`)
  }
  report.envelopePath = derivedOutPath
}
report.path = outPath
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nwrote ${outPath} (${Object.keys(result.dataset).length} entries), ${derivedOutPath}, ${reportPath}`)
console.log(`(${written})`)
