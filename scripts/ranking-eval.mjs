#!/usr/bin/env node
/**
 * Validate the displayed ranking against an independent capability index.
 *
 * The catalog carries the Artificial Analysis intelligence index as a
 * cross-check, which is the only external board we capture with a numeric
 * capability score. This script prints how well the orderings agree (Spearman),
 * so a change to the rank/grade rule can be checked instead of argued:
 *
 *  1. the composite (capability point estimate)
 *  2. the conservative lower bound (the router's safety quality)
 *  3. the published rank (should track the composite)
 *
 * Usage: node scripts/ranking-eval.mjs [data/model-info-runtime.json]
 */
import fs from 'node:fs'
import { spearman } from '../src/rank.js'

const file = process.argv[2] ?? 'data/model-info-runtime.json'
const data = JSON.parse(fs.readFileSync(file, 'utf8'))
const rows = []
for (const [id, entry] of Object.entries(data)) {
  const index = entry?.crossChecks?.artificialAnalysis?.intelligenceIndex
  const ranking = entry?.ranking ?? {}
  if (!Number.isFinite(Number(index)) || Number(index) <= 0) continue
  if (!Number.isFinite(Number(ranking.composite))) continue
  rows.push({ id, index: Number(index), composite: ranking.composite, low: ranking.low, rank: ranking.rank, coverage: ranking.coverage })
}
if (rows.length < 5) {
  console.error(`not enough models with both an AA index and a composite (${rows.length})`)
  process.exit(1)
}
const pairs = (list, key) => list.map((row) => [row.index, key === 'rank' ? -row.rank : row[key]])
const show = (label, key) => {
  const rho = spearman(pairs(rows, key))
  console.log(`${label.padEnd(28)} ${rho.toFixed(3)}  (n=${rows.length})`)
}
console.log(`independent index: Artificial Analysis intelligence index (${rows.length} models)\n`)
show('AA index vs composite', 'composite')
show('AA index vs lower bound', 'low')
show('AA index vs published rank', 'rank')
const partial = rows.filter((row) => Number(row.coverage) >= 1)
if (partial.length >= 5) {
  const rho = (key) => spearman(pairs(partial, key))
  console.log(`\nfull-coverage subset (n=${partial.length})`)
  console.log(`${'AA index vs composite'.padEnd(28)} ${rho('composite').toFixed(3)}`)
  console.log(`${'AA index vs lower bound'.padEnd(28)} ${rho('low').toFixed(3)}`)
}
