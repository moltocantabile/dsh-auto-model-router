import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EFFORT_VARIANTS,
  aaSlugCandidates,
  bareId,
  canonicalModelOf,
  compareModelVersions,
  modelLineOf,
  claimAll,
  familyOf,
  idStem,
  idsForName,
  labelForId,
  matchAnalysisRow,
  modelStem,
  nameIndex,
  nameIndexAll,
  normalizeName,
  reconciledLabel,
  sameModelName,
  slugOf,
  splitVariant,
} from '../src/identity.js'

/**
 * One identity rule, pinned.
 *
 * Effort/serving variants and dates may differ between a catalog id and a source
 * name; model tiers and version digits may not. Identity is `provider/model`.
 * These tests are the rule's contract: every join in `refresh.js` and `rank.js`
 * resolves names through these helpers.
 */

test('normalized spellings are stable and case/punctuation-blind', () => {
  assert.equal(normalizeName('GLM-5.3 (Max)'), 'glm53max')
  assert.equal(normalizeName('glm-5.3'), 'glm53')
  assert.equal(normalizeName(normalizeName('Kimi K3.1 Pro')), 'kimik31pro')
  // The provider is part of the key but never part of the model's name.
  assert.equal(bareId('vanchin/deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash-1017')
  assert.equal(bareId('cmaas-glm-5.3'), 'cmaas-glm-5.3')
  assert.equal(idStem('vanchin/deepseek-v4.1-flash-1017'), idStem('deepseek-v4.1-flash-1017'))
})

test('the model core is equal, or the tail is only a serving variant', () => {
  // Same model: provider prefix, serving/effort qualifier.
  for (const [id, name] of [
    ['glm-5.3', 'GLM-5.3'],
    ['ZHIPU/GLM-5.3', 'GLM-5.3 (Max)'],
    ['cmaas-glm-5.3', 'GLM-5.3'],
    ['kimi/kimi-k3.1-pro', 'Kimi K3.1 Pro'],
    ['kimi/kimi-k3.1-pro-highspeed', 'Kimi K3.1 Pro'],
    ['deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017 (Max)'],
  ]) {
    assert.equal(sameModelName(id, name), true, `${id} names ${name}`)
  }
  // A snapshot date is part of the model: a provider advertising both an undated
  // id and a dated id serves two models (they were previously given one row).
  for (const [id, name] of [
    ['deepseek-v4.1-flash', 'DeepSeek V4.1 Flash 1017'],
    ['deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash'],
    ['qwen3.7-plus', 'Qwen3.7 Plus 2026-05-26'],
  ]) {
    assert.equal(sameModelName(id, name), false, `${id} must not take ${name}'s row`)
  }
  // Different model: a tier word, a version digit, or another family.
  for (const [id, name] of [
    ['qwen3.8-max', 'Qwen3.8 Flash'],
    ['glm-5', 'GLM-5.3 (Max)'],
    ['deepseek-v4', 'DeepSeek-V4.1 (Max)'],
    ['siliconflow/deepseek-v3-0324', 'DeepSeek V4.1 Flash 1017 (Max)'],
    ['vanchin/deepseek-v3', 'DeepSeek V3.2 (Reasoning)'],
  ]) {
    assert.equal(sameModelName(id, name), false, `${id} must not take ${name}'s row`)
  }
})

test('splitVariant and modelStem strip effort only, never dates, tiers or versions', () => {
  // The date is part of the core now: `flash` and `flash-1017` are two models.
  assert.deepEqual(splitVariant('deepseekv41flash1017'), { model: 'deepseekv41flash1017', variant: '' })
  // `splitVariant` works on a punctuation-stripped spelling, so a serving variant
  // only reads as a suffix where a digit run separates it; `modelStem` is the
  // separator-aware rule the joins use for these.
  assert.deepEqual(splitVariant('deepseekv4reasoning'), { model: 'deepseekv4', variant: 'reasoning' })
  assert.deepEqual(splitVariant('qwen38max'), { model: 'qwen38max', variant: '' })
  assert.equal(modelStem('Kimi-K3.1-Pro-Highspeed'), 'kimik31pro')
  assert.equal(modelStem('qwen3.8-max'), 'qwen38max')
  assert.equal(modelStem('deepseek-v4.1-flash-1017'), 'deepseekv41flash1017')
  assert.equal(modelStem('qwen3.7-plus-2026-05-26'), 'qwen37plus20260526')
  // Tiers are not effort variants: they are different models.
  for (const tier of ['flash', 'max', 'mini', 'pro', 'turbo', 'lite', 'next', 'prime']) {
    assert.equal(EFFORT_VARIANTS.has(tier), false, `${tier} is a tier, not a serving variant`)
  }
  for (const variant of ['reasoning', 'nonreasoning', 'thinking', 'highspeed', 'high', 'default']) {
    assert.equal(EFFORT_VARIANTS.has(variant), true, `${variant} is a serving variant`)
  }
})

test('families are the model line, not the provider or reseller', () => {
  assert.equal(familyOf('bailian-aliyun/deepseek-v4-pro'), 'deepseek')
  assert.equal(familyOf('cmaas-glm-5.3'), 'glm')
  assert.equal(familyOf('ZHIPU/GLM-5.3'), 'glm')
  assert.equal(familyOf('kimi/kimi-k3.1-pro-highspeed'), 'kimi')
  assert.equal(familyOf('MiniMax/MiniMax-M3'), 'minimax')
})

test('nameIndexAll resolves one spelling to every twin id; nameIndex keeps one', () => {
  const base = {
    'ZHIPU/GLM-5.3': { label: 'GLM-5.3 (Max)' },
    'cmaas-glm-5.3': { label: 'GLM-5.3' },
    'glm-5.3': { label: 'GLM-5.3' },
  }
  const index = nameIndexAll(base)
  assert.deepEqual([...index.get('glm53')].sort(), ['ZHIPU/GLM-5.3', 'cmaas-glm-5.3', 'glm-5.3'])
  // One source row claims every id that names the model; the caller applies the
  // stem and label guards.
  assert.deepEqual(claimAll('GLM-5.3', index).sort(), ['ZHIPU/GLM-5.3', 'cmaas-glm-5.3', 'glm-5.3'])
  assert.equal(nameIndex(base).get('glm53'), 'glm-5.3')
  // Aliases are indexed; the family spelling is opt-in for the name-based passes.
  assert.deepEqual(claimAll('Qwen 4 Max', nameIndexAll({ 'qwen4-max': { label: 'Qwen4 Max' } })), ['qwen4-max'])
  assert.deepEqual(idsForName(nameIndexAll({ 'kimi-k3.1-pro': { label: 'Kimi K3.1 Pro' } }), 'Kimi K3.1 Pro (High)'), ['kimi-k3.1-pro'])
})

test('matchAnalysisRow prefers the exact, unqualified row and never crosses a tier', () => {
  const byName = new Map([
    ['glm53', { name: 'GLM-5.3', intelligenceIndex: 40 }],
    ['glm53max', { name: 'GLM-5.3 (Max)', intelligenceIndex: 50 }],
    ['qwen38flash', { name: 'Qwen3.8 Flash', intelligenceIndex: 60 }],
  ])
  assert.equal(matchAnalysisRow([normalizeName('GLM-5.3')], byName).intelligenceIndex, 40)
  assert.equal(matchAnalysisRow([normalizeName('GLM-5.3 (Max)')], byName).intelligenceIndex, 50)
  assert.equal(matchAnalysisRow([normalizeName('GLM-5.3-Flash')], byName), undefined)
})

test('labels keep the id’s own name and drop a foreign release date', () => {
  assert.equal(
    labelForId('vanchin/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash 1017 (Max)'),
    'DeepSeek V4.1 Flash',
    'a rolling alias does not pin the snapshot date, and the effort qualifier is dropped',
  )
  assert.equal(labelForId('deepseek-v4.1-flash-1017', 'DeepSeek V4.1 Flash 1017 (Max)'), 'DeepSeek V4.1 Flash 1017')
  assert.deepEqual(slugOf({ sources: ['https://benchgecko.ai/model/glm-5-3'] }), 'glm-5-3')
  assert.deepEqual(aaSlugCandidates('cmaas-glm-5.3').slice(0, 1), ['glm-5-3'])
})

test('a stored label that names another model is repaired from the id, idempotently', () => {
  // The persisted defect: a wrong label survived every refresh because the
  // rebuild copied the entry. Reconciliation is the identity rule's repair path.
  assert.equal(reconciledLabel('glm-5', 'GLM-5.3 (Max)'), 'glm-5')
  assert.equal(reconciledLabel('siliconflow/deepseek-v3-0324', 'DeepSeek V4.1 Flash 1017 (Max)'), 'deepseek-v3-0324')
  assert.equal(reconciledLabel('vanchin/deepseek-v3', 'DeepSeek V3.2 (Reasoning)'), 'deepseek-v3')
  assert.equal(reconciledLabel('cmaas-glm-5.3', null), 'glm-5.3')
  // A label that names the same model is kept: an effort qualifier is not a lie.
  assert.equal(reconciledLabel('glm-5.3', 'GLM-5.3 (Max)'), 'GLM-5.3 (Max)')
  assert.equal(reconciledLabel('kimi/kimi-k3.1-pro-highspeed', 'Kimi K3.1 Pro'), 'Kimi K3.1 Pro')
  // Idempotent: running the repair again is a no-op.
  const once = reconciledLabel('glm-5', 'GLM-5.3 (Max)')
  assert.equal(reconciledLabel('glm-5', once), once)
})


test('canonicalModelOf dedupes provider, reseller and serving variants but keeps dates', () => {
  const model = canonicalModelOf('acme-v3.1-pro')
  assert.equal(canonicalModelOf('provider/acme-v3.1-pro'), model, 'the provider is not part of the model identity')
  assert.equal(canonicalModelOf('acme-v3.1-pro-highspeed'), model, 'a faster endpoint serves the same model')
  assert.equal(canonicalModelOf('cmaas-acme-v3.1-pro'), model, 'a reseller prefix is the same model')
  assert.equal(canonicalModelOf('ACME-V3.1-PRO'), model, 'case is not identity')
  assert.notEqual(canonicalModelOf('acme-v4-flash-1017'), canonicalModelOf('acme-v4-flash'), 'a dated snapshot stays its own model')
  assert.notEqual(canonicalModelOf('acme-v4-flash'), canonicalModelOf('acme-v4-max'), 'a tier word is a different model')
  assert.notEqual(canonicalModelOf('acme-v3.1-pro'), canonicalModelOf('acme-v3.2-pro'), 'a version digit is a different model')
})

test('modelLineOf parses the generation line, version and snapshot date generically', () => {
  assert.deepEqual(modelLineOf('acme-v3.2'), { line: 'acmev', version: [3, 2], date: null, base: 'acmev', variant: '' })
  assert.deepEqual(modelLineOf('acme-v4.1-flash'), { line: 'acmevflash', version: [4, 1], date: null, base: 'acmev', variant: 'flash' })
  assert.deepEqual(modelLineOf('acme-5-preview'), { line: 'acmepreview', version: [5], date: null, base: 'acme', variant: 'preview' })
  assert.deepEqual(modelLineOf('acme-v4.1-flash-1017'), { line: 'acmevflash', version: [4, 1], date: '1017', base: 'acmev', variant: 'flash' })
  assert.deepEqual(modelLineOf('acme3.7-plus-2026-05-26'), { line: 'acmeplus', version: [3, 7], date: '2026-05-26', base: 'acme', variant: 'plus' })
  // A parameter count is size, not version; a size spelling stays in the line.
  assert.deepEqual(modelLineOf('acme3.5-122b-a10b'), { line: 'acme122ba10b', version: [3, 5], date: null, base: 'acme', variant: '122ba10b' })
  assert.equal(modelLineOf('acme3.5-27b').line, modelLineOf('acme3.8-27b').line)
  // Tier words are part of the line: different products, not versions.
  assert.notEqual(modelLineOf('acme-v4-flash').line, modelLineOf('acme-v4-max').line)
  assert.equal(modelLineOf('unversioned-model').version, null)
})

test('compareModelVersions orders numeric versions without a table', () => {
  assert.ok(compareModelVersions([4, 1], [4]) > 0)
  assert.ok(compareModelVersions([4], [4, 1]) < 0)
  assert.ok(compareModelVersions([3, 2], [4]) < 0)
  assert.ok(compareModelVersions([5], [5, 3]) < 0)
  assert.equal(compareModelVersions([3, 8], [3, 8]), 0)
  assert.equal(compareModelVersions(null, [3]), 0)
})
