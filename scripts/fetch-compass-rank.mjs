#!/usr/bin/env node
/**
 * Capture CompassRank's two public boards into `data/compass-rank-<date>.json`.
 *
 * OpenCompass serves the boards as static JSON on its CDN; the files are
 * gzip-encoded without a `content-encoding` header, which is why this script
 * reuses `fetchJson()` from `src/refresh.js` instead of `fetch().json()`.
 *
 * The written file is the same `extractCompass()` shape the runtime refresh
 * builds, so `scripts/build-model-info.mjs` can compile a catalog from it.
 *
 * Usage: node scripts/fetch-compass-rank.mjs [outfile]
 */
import fs from 'node:fs'

import { COMPASS_ABILITY_URL, COMPASS_BENCH_URL, extractCompass, fetchJson } from '../src/refresh.js'

const outPath = process.argv[2] ?? new URL('../data/compass-rank-' + new Date().toISOString().slice(0, 10) + '.json', import.meta.url).pathname

const [ability, bench] = await Promise.all([fetchJson(COMPASS_ABILITY_URL), fetchJson(COMPASS_BENCH_URL)])
const compass = extractCompass(ability, bench)
if (Object.keys(compass).length === 0) {
  console.error('compass: no rows — the board shape changed')
  process.exit(1)
}
fs.writeFileSync(outPath, `${JSON.stringify(compass, null, 2)}\n`)
console.log(`compassrank: ${Object.keys(compass).length} models -> ${outPath}`)
console.log('next: node scripts/build-model-info.mjs writes src/model-info-data.json from the newest capture')
