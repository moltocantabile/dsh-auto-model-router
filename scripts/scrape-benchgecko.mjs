#!/usr/bin/env node
/**
 * Capture the BenchGecko per-model documents that `src/model-info-data.json`
 * was compiled from, and rebuild `data/benchgecko-extracted.json` from them.
 *
 * Every extracted entry keeps its raw response under
 * `data/benchgecko-raw/raw-<slug>.json`, so a score in the compiled catalog can
 * be traced to the document it came from and a method change can be recomputed
 * instead of re-fetched. `scripts/build-model-info.mjs` reads both files.
 *
 * Usage:
 *   node scripts/scrape-benchgecko.mjs             # refresh every known slug
 *   node scripts/scrape-benchgecko.mjs <slug> ...  # refresh only these slugs
 *
 * Slugs come from the extracted file's records and from the arguments, so the
 * set only grows when someone adds a model deliberately.
 */
import fs from 'node:fs'

import { extractBenchGecko } from '../src/refresh.js'

const EXTRACTED = new URL('../data/benchgecko-extracted.json', import.meta.url)
const RAW_DIR = new URL('../data/benchgecko-raw/', import.meta.url)
const API = 'https://benchgecko.ai/api/v1/models/'
const TIMEOUT_MS = 20_000

const extracted = JSON.parse(fs.readFileSync(EXTRACTED, 'utf8'))
// The file is keyed by catalog id (`deepseek-v4.1-flash-1017`), while the API is
// addressed by slug (`deepseek-v4-1-flash-1017`). Keep both directions.
const idBySlug = new Map()
for (const [id, entry] of Object.entries(extracted)) if (typeof entry?.slug === 'string') idBySlug.set(entry.slug, id)
const slugs = []
for (const raw of process.argv.slice(2)) if (raw.length > 0) slugs.push(raw)
for (const entry of Object.values(extracted)) if (typeof entry?.slug === 'string' && !slugs.includes(entry.slug)) slugs.push(entry.slug)
if (slugs.length === 0) {
  console.error('no slugs: the extracted file has no records and none were passed')
  process.exit(1)
}

fs.mkdirSync(RAW_DIR, { recursive: true })

/** Fetch one document with a timeout; returns null on failure. */
async function fetchModel(slug) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(API + encodeURIComponent(slug), { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

let failed = 0
for (const slug of slugs) {
  try {
    const raw = await fetchModel(slug)
    fs.writeFileSync(new URL(`raw-${slug}.json`, RAW_DIR), `${JSON.stringify(raw, null, 2)}\n`)
    const extraction = extractBenchGecko(raw)
    if (extraction === null) throw new Error('not a model document')
    // A slug with no recorded catalog id falls back to the slug; pass a new slug
    // only together with the id it belongs to.
    extracted[idBySlug.get(extraction.slug) ?? extraction.slug] = extraction
    console.log(`benchgecko ${slug}: ${(raw.scores ?? []).length} benchmark rows`)
  } catch (error) {
    failed += 1
    console.error(`benchgecko ${slug}: ${String(error?.message ?? error)}`)
  }
}

// Keep the file's insertion order stable so a refresh only shows real changes.
const ordered = {}
for (const [slug, value] of Object.entries(extracted)) ordered[slug] = value
fs.writeFileSync(EXTRACTED, `${JSON.stringify(ordered, null, 2)}\n`)
console.log(`benchgecko: ${Object.keys(ordered).length} extracted models (${failed} failed) -> data/benchgecko-extracted.json`)
if (failed > 0) process.exit(1)
