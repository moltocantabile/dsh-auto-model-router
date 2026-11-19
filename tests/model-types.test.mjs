import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_TYPES,
  applyModelOverrides,
  decisionOptions,
  detectModelType,
  mergeModelOverrides,
  modelTypeKey,
  modelTypeOf,
  sanitizeModelPatch,
} from '../src/model-types.js'

test('a model type is an override first, then a name heuristic, never a guess', () => {
  // Providers publish no type: only the decision protocol's own name is evidence.
  assert.equal(detectModelType('decision-model-preview'), 'decision')
  assert.equal(detectModelType('system-one'), 'decision')
  assert.equal(detectModelType('qwen3.8-flash'), 'unknown')
  assert.equal(modelTypeOf('bailian-aliyun', 'qwen3.8-flash'), 'unknown')
  // A user assignment is authoritative for that provider/model.
  const overrides = { models: { 'bailian-aliyun/qwen3.8-flash': { type: 'decision' } } }
  assert.equal(modelTypeOf('bailian-aliyun', 'qwen3.8-flash', overrides), 'decision')
  assert.equal(modelTypeOf('deepseek-official', 'qwen3.8-flash', overrides), 'unknown', 'an assignment is per provider/model')
})

test('the decision picker lists only decision-typed models, grouped by provider', () => {
  const overrides = { models: { 'bailian-aliyun/qwen3.8-max': { type: 'decision' } } }
  const typeOf = (provider, id) => modelTypeOf(provider, id, overrides)
  const options = decisionOptions(
    ['bailian-aliyun', 'bailian-tokenplan', 'deepseek-official'],
    typeOf,
    {
      'bailian-aliyun': ['qwen3.8-flash', 'qwen3.8-max', 'decision-model-preview'],
      'bailian-tokenplan': ['decision-model-preview', 'qwen3.8-flash'],
      'deepseek-official': ['deepseek-flash'],
    },
  )
  assert.deepEqual(options, [
    { provider: 'bailian-aliyun', models: ['qwen3.8-max', 'decision-model-preview'] },
    { provider: 'bailian-tokenplan', models: ['decision-model-preview'] },
    { provider: 'deepseek-official', models: [] },
  ])
})

test('an edit patch keeps only editable, well-formed facts', () => {
  const patch = sanitizeModelPatch({
    label: 'My Name',
    type: 'decision',
    modalities: ['text', 'image', 'image', 'not-a-modality'],
    toolCalling: true,
    contextWindow: 200000,
    price: { input: 1.5, output: -2 },
    quality: 99,
    ranking: { rank: 1 },
    source: 'forged',
  })
  assert.deepEqual(patch, { label: 'My Name', type: 'decision', modalities: ['text', 'image'], toolCalling: true, contextWindow: 200000, price: { input: 1.5 } })
  assert.equal(sanitizeModelPatch({ type: 'bogus' }).type, undefined)
})

test('overrides apply over a base catalog and merge one model at a time', () => {
  const dataset = { 'qwen3.8-flash': { label: 'Qwen3.8-Flash', modalities: ['text'], price: { input: 1 } } }
  const first = mergeModelOverrides({ models: {} }, 'bailian-aliyun/qwen3.8-flash', { label: 'Qwen Flash', toolCalling: true })
  const second = mergeModelOverrides(first, 'bailian-aliyun/qwen3.8-flash', { price: { output: 2 } })
  assert.deepEqual(Object.keys(second.models), ['bailian-aliyun/qwen3.8-flash'])
  // Provider-qualified keys resolve to the bare catalog entry.
  const changed = applyModelOverrides(dataset, second)
  assert.equal(dataset['qwen3.8-flash'].label, 'Qwen Flash')
  assert.equal(dataset['qwen3.8-flash'].toolCalling, true)
  assert.deepEqual(dataset['qwen3.8-flash'].price, { input: 1, output: 2 })
  assert.equal(changed.length, 1)
  assert.ok(!changed[0].fields.includes('type'), 'the type is picker metadata, not entry data')
})

test('an override for a model the catalog does not describe invents nothing', () => {
  const dataset = { 'qwen3.8-flash': { label: 'Q' } }
  const changed = applyModelOverrides(dataset, { models: { 'bailian-aliyun/ghost-model': { label: 'Ghost' } } })
  assert.deepEqual(changed, [])
  assert.equal(dataset['ghost-model'], undefined)
})

test('MODEL_TYPES is the closed set the UI can assign', () => {
  assert.deepEqual([...MODEL_TYPES], ['decision', 'chat', 'unknown'])
  assert.equal(modelTypeKey('bailian-aliyun', 'qwen3.8-flash'), 'bailian-aliyun/qwen3.8-flash')
})
