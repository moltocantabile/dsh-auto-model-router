#!/usr/bin/env node
/**
 * Scrape Artificial Analysis' public model table into a JSON snapshot.
 *
 * Why no browser: the site is Next.js and the full table ships inside the RSC
 * flight stream of `/leaderboards/models` (`self.__next_f.push([1, "…"])` rows).
 * A headless browser would run the same payload through React afterwards, so
 * `fetch` + decode is both faster and usable from the plugin at run time, which
 * a Playwright dependency never could be.
 *
 * Usage: node scripts/scrape-artificialanalysis.mjs [outfile]
 */
import { writeFileSync } from 'node:fs'

const SOURCE = 'https://artificialanalysis.ai/leaderboards/models'
const OUT = process.argv[2] ?? new URL('../data/artificialanalysis.json', import.meta.url).pathname

/** Decode every `self.__next_f.push([1, "…"])` string literal into its text. */
function decodeFlightChunks(html) {
  const marker = 'self.__next_f.push([1,'
  const chunks = []
  let start = 0
  for (;;) {
    const at = html.indexOf(marker, start)
    if (at < 0) break
    let index = at + marker.length
    if (html[index] !== '"') {
      start = index
      continue
    }
    const begin = index
    index += 1
    let escaped = false
    for (; index < html.length; index += 1) {
      const char = html[index]
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    try {
      chunks.push(JSON.parse(html.slice(begin, index + 1)))
    } catch {
      // a chunk that is not a plain string literal carries no table rows
    }
    start = index + 1
  }
  return chunks
}

/** Tolerant JSON object reader: the payload may contain NaN / Infinity literals. */
function readObjectAt(text, at) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = at; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const slice = text.slice(at, index + 1)
        try {
          return JSON.parse(slice.replace(/\b(NaN|Infinity|-Infinity)\b/g, 'null'))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const isModelRow = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  ('price1mInputTokens' in value || 'intelligenceIndex' in value || 'scores' in value)

/** Collect every model row in the flight stream, merged by id. */
function extractModels(chunks) {
  const models = new Map()
  for (const text of chunks) {
    let at = text.indexOf('{"id":"')
    while (at >= 0) {
      const row = readObjectAt(text, at)
      if (isModelRow(row)) {
        const key = typeof row.id === 'string' && row.id.length > 0 ? row.id : `${row.name}`
        models.set(key, { ...(models.get(key) ?? {}), ...row })
      }
      at = text.indexOf('{"id":"', at + 1)
    }
  }
  return [...models.values()]
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const response = await fetch(SOURCE, { headers: { accept: 'text/html' } })
if (!response.ok) throw new Error(`artificialanalysis: HTTP ${response.status}`)
const html = await response.text()
const rows = extractModels(decodeFlightChunks(html))
if (rows.length === 0) throw new Error('artificialanalysis: no model rows found — the page shape changed')

const models = rows.map((row) => ({
  name: row.name,
  creator: row.modelCreatorName ?? row.release?.name ?? null,
  intelligenceIndex: number(row.intelligenceIndex),
  priceIn: number(row.price1mInputTokens),
  priceOut: number(row.price1mOutputTokens),
  cacheHitPrice: number(row.cacheHitPrice),
  contextTokens: number(row.contextWindowTokens),
  outputSpeed: number(row.outputSpeed),
  ttftSeconds: number(row.timeToFirstToken),
  reasoning: row.isReasoning === true,
  openWeights: row.isOpenWeights === true,
  deprecated: row.deprecated === true,
  releaseDate: row.release?.releaseDate ?? row.releaseDate ?? null,
  scores: Object.fromEntries(Object.entries(row.scores ?? {}).filter(([, value]) => number(value) !== null)),
}))

const withIndex = models.filter((model) => model.intelligenceIndex !== null).length
const withPrice = models.filter((model) => model.priceIn !== null).length
const payload = {
  checkedAt: new Date().toISOString(),
  source: SOURCE,
  counts: { models: models.length, withIntelligenceIndex: withIndex, withPrice },
  models,
}
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`)
console.log(`artificialanalysis: ${models.length} models (${withIndex} with index, ${withPrice} with price) -> ${OUT}`)
