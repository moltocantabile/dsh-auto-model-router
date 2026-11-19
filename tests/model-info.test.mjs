import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHECKED_AT,
  applyDataset,
  applyProviderAliases,
  MODEL_INFO,
  capabilityFragments,
  capabilitySummary,
  contextLabel,
  infoFor,
  knowledgeProvider,
  modelKey,
  routingNote,
} from '../src/model-info.js'

test('modelKey strips the provider prefix and keeps an unrelated slash', () => {
  assert.equal(modelKey('p-a', 'p-a/deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash-1017')
  assert.equal(modelKey('x', ' DeepSeek-V4.1-Flash '), 'deepseek-v4.1-flash')
  // A slash that is not a provider prefix belongs to the model name.
  assert.equal(modelKey('x', 'vendor/model-name'), 'vendor/model-name')
})

test('provider aliases are operator config, empty by default', () => {
  // Nothing baked in: two entries share a catalog only when the profile says so.
  assert.equal(knowledgeProvider('p-a'), 'p-a')
  applyProviderAliases({ 'p-a-aliyun': 'p-a' })
  assert.equal(knowledgeProvider('p-a-aliyun'), 'p-a')
  applyProviderAliases({})
  assert.equal(knowledgeProvider('p-a-aliyun'), 'p-a-aliyun', 'resetting restores no aliases')
})

test('every knowledge entry carries the fields the routing prompt and the config page read', () => {
  // `modalities`/`toolCalling` are facts only some sources publish: a model nobody
  // described keeps them unknown (absent) rather than claiming text-only / tools.
  // Everything the rules read unconditionally is required.
  const required = ['label', 'contextWindow', 'price', 'reasoning', 'latency', 'scores', 'evidence', 'bestFor', 'weaknesses', 'sources']
  let unknownModalities = 0
  let knownModalities = 0
  for (const [id, entry] of Object.entries(MODEL_INFO)) {
    for (const field of required) assert.ok(field in entry, `${id} is missing ${field}`)
    assert.ok(Array.isArray(entry.sources), `${id} sources is not an array`)
    if (entry.modalities !== undefined) {
      assert.ok(Array.isArray(entry.modalities) && entry.modalities.length > 0, `${id} modalities must be a non-empty list when known`)
      knownModalities += 1
    } else unknownModalities += 1
    if (entry.toolCalling !== undefined) assert.equal(typeof entry.toolCalling, 'boolean', `${id} toolCalling must be boolean when known`)
    for (const source of entry.sources) assert.match(source, /^https:\/\//)
    for (const text of [...(entry.bestFor ?? []), ...(entry.weaknesses ?? [])]) {
      assert.ok(text.length < 160, `${id}: long bullet (${text.length})`)
    }
    // Every capability dimension the selector scores must be present and 0-100.
    for (const dim of ['overall', 'coding', 'reasoning', 'math', 'knowledge', 'agentic', 'longContext', 'vision', 'speed']) {
      const value = entry.scores[dim]
      assert.equal(typeof value, 'number', `${id} score ${dim}`)
      assert.ok(value >= 0 && value <= 100, `${id} score ${dim} out of range: ${value}`)
    }
    if (entry.price !== null && entry.price.input !== null) assert.equal(typeof entry.price.input, 'number', `${id} price`)
  }
  assert.ok(knownModalities > 0, 'the catalog states modalities where a source does')
  assert.equal(CHECKED_AT, '2026-11-18')
})

test('infoFor resolves a dated id from its family entry and reports unknown models', () => {
  const direct = infoFor('bailian-tokenplan', 'deepseek-v4.1-flash-1017')
  assert.equal(direct.label, 'DeepSeek-V4.1-Flash-1017')
  assert.equal(infoFor('bailian-tokenplan', 'qwen4-max-preview').preview, true)
  assert.equal(infoFor('bailian-tokenplan', 'deepseek-v4-flash-0731').retired, true)
  assert.equal(infoFor('bailian-tokenplan', 'no-such-model'), null)
})

test('capability fragments and routing notes stay short and carry cost and fit', () => {
  const info = infoFor('bailian-tokenplan', 'qwen3.8-flash')
  const fragments = capabilityFragments(info)
  assert.ok(fragments.some((fragment) => fragment.includes('¥0.8 / ¥2.7')))
  assert.ok(fragments.some((fragment) => fragment.includes('1M ctx')))
  const note = routingNote(info)
  assert.ok(note.includes('good at'))
  assert.ok(note.includes('weak at'))
  assert.ok(note.length <= 320)
  assert.equal(routingNote(null), '')
  assert.equal(contextLabel(1_048_576), '1M')
  assert.equal(contextLabel(262144), '262k')
  assert.equal(contextLabel(undefined), null)
})

test('CompassRank cross-checks are recorded only for models OpenCompass evaluated', () => {
  // Other boards (Epoch, llmleaderboard) also write cross-checks, so this looks
  // for the CompassRank block specifically rather than any cross-check at all.
  const withCompass = Object.entries(MODEL_INFO).filter(([, entry]) => entry.crossChecks?.compassRank !== undefined)
  assert.ok(withCompass.length >= 5, 'expected several CompassRank-backed models')
  for (const [id, entry] of withCompass) {
    const cc = entry.crossChecks.compassRank
    assert.ok(cc !== null && typeof cc === 'object', `${id}: crossChecks.compassRank missing`)
    // Raw CompassRank numbers are kept unmodified, on its own 0-100 scale.
    for (const field of ['average', 'knowledge', 'reasoning', 'abstraction', 'agent']) {
      const value = cc[field]
      assert.ok(value === null || (typeof value === 'number' && value >= 0 && value <= 100), `${id}: ${field} out of range`)
    }
    // Any CompassRank-sourced model cites the board it came from.
    assert.ok(entry.sources.some((url) => url.includes('rank.opencompass.org.cn')), `${id}: missing CompassRank source`)
  }
})

test('a model measured by either source carries a composite, not a prior', () => {
  for (const [id, entry] of Object.entries(MODEL_INFO)) {
    // Only the two benchmark passes produce a composite; Epoch's index and
    // llmleaderboard's serving data are recorded as evidence, not as the score.
    if (entry.crossChecks?.compassRank !== undefined) {
      assert.ok(typeof entry.quality === 'number', `${id}: CompassRank-evaluated model should have a composite`)
    }
    // Evidence counts are integers: a second source is one additional sample.
    for (const [dim, count] of Object.entries(entry.evidence ?? {})) {
      assert.ok(Number.isInteger(count) && count >= 0, `${id}.${dim}: evidence ${count} is not a non-negative integer`)
    }
  }
})

test('capabilitySummary carries the cross-check and provenance through to the UI', () => {
  const [id, entry] = Object.entries(MODEL_INFO).find(([, e]) => e.crossChecks?.compassRank !== undefined)
  const summary = capabilitySummary(infoFor('bailian-tokenplan', id))
  assert.ok(summary !== null)
  assert.ok(summary.crossChecks !== null, 'crossChecks must survive summarization')
  assert.equal(summary.crossChecks.compassRank.average, entry.crossChecks.compassRank.average)
  assert.ok(Array.isArray(summary.benchmarkSources))
  assert.ok(summary.benchmarkSources.includes('opencompass-compassrank'))
  assert.equal(summary.checkedAt, CHECKED_AT)
})

test('the catalog lookup is case-insensitive, as provider ids are not consistent', () => {
  // `MiniMax/MiniMax-M3` and `ZHIPU/GLM-5.3` are advertised with capitals while
  // lookups normalise to lower case; without the index these read as unmeasured.
  const backup = JSON.parse(JSON.stringify(MODEL_INFO))
  try {
    applyDataset({
      'MiniMax/MiniMax-M3': { ...backup['qwen3.8-flash'], label: 'MiniMax-M3', quality: 47.1 },
    })
    const found = infoFor('bailian-aliyun', 'MiniMax/MiniMax-M3')
    assert.ok(found !== null, 'a mixed-case entry resolves')
    assert.equal(found.quality, 47.1)
    assert.equal(infoFor('bailian-aliyun', 'minimax/minimax-m3')?.quality, 47.1)
  } finally {
    applyDataset(backup)
  }
})
