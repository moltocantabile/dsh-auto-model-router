/**
 * Regenerate `src/model-info-data.json` from the captured benchmark passes.
 *
 * The merge itself lives in `src/model-data-build.js`, shared with the runtime
 * refresh action so a hand-run build and a refresh from the settings page
 * produce a catalog by the same rules.
 */
import fs from 'node:fs'
import { buildDataset } from '../src/model-data-build.js'

const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'))

/** The newest `data/compass-rank-<date>.json` capture. */
function newestCompassCapture() {
  const dir = new URL('../data/', import.meta.url)
  const names = fs.readdirSync(dir)
    .filter((name) => /^compass-rank-\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
  if (names.length === 0) throw new Error('no data/compass-rank-<date>.json capture; run scripts/fetch-compass-rank.mjs')
  return names[names.length - 1]
}

const base = read('../src/model-info-data.json')
const benchgecko = read('../data/benchgecko-extracted.json')
const compass = read(`../data/${newestCompassCapture()}`)

/** Sample counts per slug and category, from the raw BenchGecko responses. */
const counts = {}
for (const entry of Object.values(benchgecko)) {
  if (typeof entry?.slug !== 'string') continue
  const candidates = ['raw-' + entry.slug + '.json', entry.slug + '.json']
  for (const name of candidates) {
    try {
      const raw = read('../data/benchgecko-raw/' + name)
      const tally = {}
      for (const score of raw.scores ?? []) {
        if (typeof score?.category !== 'string' || typeof score?.score !== 'number') continue
        tally[score.category] = (tally[score.category] ?? 0) + 1
      }
      counts[entry.slug] = tally
      break
    } catch {
      // No raw capture for this model: fall back to one sample per category.
    }
  }
}

const out = buildDataset({ base, benchgecko, compass, counts })
fs.writeFileSync(new URL('../src/model-info-data.json', import.meta.url), JSON.stringify(out, null, 2))

console.log('entries', Object.keys(out).length)
for (const [id, e] of Object.entries(out).sort((a, b) => (b[1].quality ?? 0) - (a[1].quality ?? 0))) {
  const s = e.scores
  console.log(id.padEnd(26), `q=${String(e.quality ?? '--').padStart(5)}`, `cod=${String(s.coding).padStart(5)}`, `rea=${String(s.reasoning).padStart(5)}`, `math=${String(s.math).padStart(5)}`, `kno=${String(s.knowledge).padStart(5)}`, `agt=${String(s.agentic).padStart(5)}`, `spd=${String(s.speed).padStart(5)}`, `ctx=${s.longContext}`, `vis=${s.vision}`)
}
