#!/usr/bin/env node
/**
 * Capture the provider catalog that the host advertises into
 * `data/catalog-pool.json`.
 *
 * The runtime refresh needs to know which model ids the providers actually
 * serve, or it cannot tell an entry that is merely missing from the catalog
 * from one that no longer exists. At run time the plugin gets that list from
 * `llm.listModels`; a script cannot call the host API, so the same list is
 * captured from the composed provider config and committed as an input to
 * `scripts/refresh-database.mjs`.
 *
 * Usage:
 *   node scripts/capture-catalog-pool.mjs [profile-patch.yml] [outfile]
 *
 * Defaults to `$DSH_PROFILE_PATCH`, then `~/.dsh/profiles/web/cordis.patch.yml`,
 * and writes `data/catalog-pool.json`. Ids are stored unfiltered: the filter for
 * routable chat models lives in `scripts/refresh-database.mjs`, next to the
 * refresh that consumes it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const patchPath = process.argv[2] ?? process.env.DSH_PROFILE_PATCH ?? path.join(os.homedir(), '.dsh/profiles/web/cordis.patch.yml')
const outPath = process.argv[3] ?? new URL('../data/catalog-pool.json', import.meta.url).pathname
const LLM_PLUGIN_ID = 'llm-pi-ai'

const lines = fs.readFileSync(patchPath, 'utf8').split('\n')
const providers = {}
let pluginBlock = null
let provider = null
let inModels = false
let providerIndent = null

for (const line of lines) {
  const plugin = /^-\s+id:\s*(.+?)\s*$/.exec(line)
  if (plugin !== null) {
    pluginBlock = plugin[1]
    provider = null
    inModels = false
    continue
  }
  if (pluginBlock !== LLM_PLUGIN_ID) continue
  const providerKey = /^ {6}([A-Za-z0-9_.-]+):\s*$/.exec(line)
  if (providerKey !== null) {
    provider = providerKey[1]
    providerIndent = providerKey[0].length - providerKey[1].length
    inModels = false
    continue
  }
  if (/^ {8}models:\s*$/.test(line)) {
    inModels = true
    if (provider !== null) providers[provider] ??= []
    continue
  }
  if (provider === null) continue
  const model = /^ {10}- id:\s*(.+?)\s*$/.exec(line)
  if (inModels && model !== null) {
    providers[provider].push(model[1])
    continue
  }
  // Any other key at or left of the provider's indent closes the models list.
  const indent = line.length - line.trimStart().length
  if (line.trim().length > 0 && providerIndent !== null && indent <= providerIndent) {
    provider = null
    inModels = false
  }
}

const wanted = []
for (const [id, models] of Object.entries(providers)) for (const model of models) wanted.push({ model, provider: id })
if (wanted.length === 0) {
  console.error(`no providers found in ${patchPath} (expected plugin ${LLM_PLUGIN_ID} with a providers: block)`)
  process.exit(1)
}

const payload = {
  capturedAt: new Date().toISOString().slice(0, 10),
  source: `llm.listModels for the providers of ${LLM_PLUGIN_ID} in the profile (captured from ${path.basename(patchPath)}); ids stored unfiltered`,
  wanted,
}
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`)
console.log(`catalog pool: ${wanted.length} advertised ids from ${Object.keys(providers).length} providers -> ${outPath}`)
