#!/usr/bin/env node
/**
 * Capture the task-type rankings the router cannot get from the model table:
 *
 * - Artificial Analysis domain indexes (`/indexes/<domain>`): one composite
 *   `weightedIndex` per model plus its component sub-scores. Stored as index
 *   signals, never blended into a dimension.
 * - OpenRouter's own benchmark leaderboards (`/benchmarks/<slug>`): single
 *   benchmark accuracies (median across providers), stored as benchmark
 *   observations and mapped to a dimension by `src/rank.js`.
 * - OpenRouter's task-spend ranking (`/api/frontend/v1/rankings/task-spend`):
 *   which models production traffic uses per task tag. Adoption, never capability.
 *
 * Usage: node scripts/scrape-task-indexes.mjs [outdir]
 */
import fs from 'node:fs'

import {
  AA_TASK_INDEX_PAGES,
  ARTIFICIAL_ANALYSIS_INDEX_URL,
  OPENROUTER_BENCHMARK_PAGES,
  OPENROUTER_BENCHMARK_URL,
  OPENROUTER_TASK_SPEND_URL,
  extractArtificialAnalysisTaskIndexes,
  extractOpenRouterBenchmarkPage,
  extractOpenRouterTaskUsage,
  fetchJson,
  fetchText,
} from '../src/refresh.js'

const outDir = process.argv[2] ?? new URL('../data/', import.meta.url).pathname
const checkedAt = new Date().toISOString().slice(0, 10)
const failed = []

const domains = {}
for (const [slug] of AA_TASK_INDEX_PAGES) {
  try {
    const html = await fetchText(ARTIFICIAL_ANALYSIS_INDEX_URL(slug))
    const rows = extractArtificialAnalysisTaskIndexes(html, slug)
      .map((row, position) => ({ rank: position + 1, url: ARTIFICIAL_ANALYSIS_INDEX_URL(slug), ...row }))
    if (rows.length === 0) throw new Error('no index rows (page shape changed?)')
    domains[slug] = rows
    console.log(`artificialanalysis index ${slug}: ${rows.length} models`)
  } catch (error) {
    failed.push(`aa index ${slug}: ${String(error?.message ?? error)}`)
  }
}
fs.writeFileSync(`${outDir}artificialanalysis-task-indexes.json`, `${JSON.stringify({
  checkedAt,
  source: 'https://artificialanalysis.ai/indexes',
  scale: '0-100 composite; index signal only, never blended into a dimension',
  domains,
}, null, 2)}\n`)

const benchmarks = {}
for (const [slug] of OPENROUTER_BENCHMARK_PAGES) {
  try {
    const html = await fetchText(OPENROUTER_BENCHMARK_URL(slug))
    const rows = extractOpenRouterBenchmarkPage(html)
      .map((row, position) => ({ rank: position + 1, url: OPENROUTER_BENCHMARK_URL(slug), ...row }))
    if (rows.length === 0) throw new Error('no leaderboard rows (page shape changed?)')
    benchmarks[slug] = rows
    console.log(`openrouter benchmark ${slug}: ${rows.length} models`)
  } catch (error) {
    failed.push(`openrouter benchmark ${slug}: ${String(error?.message ?? error)}`)
  }
}
fs.writeFileSync(`${outDir}openrouter-benchmarks.json`, `${JSON.stringify({
  checkedAt,
  source: 'https://openrouter.ai/benchmarks',
  scale: 'accuracy as a 0-1 fraction, median across providers as published',
  benchmarks,
}, null, 2)}\n`)

let usage = { windowDays: null, models: {} }
try {
  usage = extractOpenRouterTaskUsage(await fetchJson(OPENROUTER_TASK_SPEND_URL))
  console.log(`openrouter task spend: ${Object.keys(usage.models).length} models, ${usage.windowDays}d window`)
} catch (error) {
  failed.push(`openrouter task spend: ${String(error?.message ?? error)}`)
}
fs.writeFileSync(`${outDir}openrouter-task-usage.json`, `${JSON.stringify({
  checkedAt,
  source: OPENROUTER_TASK_SPEND_URL,
  note: 'adoption signal (share of spend per task tag), never blended into a capability dimension',
  windowDays: usage.windowDays,
  models: usage.models,
}, null, 2)}\n`)

console.log(`wrote ${outDir}artificialanalysis-task-indexes.json, openrouter-benchmarks.json, openrouter-task-usage.json`)
if (failed.length > 0) {
  console.error(`${failed.length} source(s) failed:`)
  for (const message of failed) console.error(`  ${message}`)
  process.exit(1)
}
