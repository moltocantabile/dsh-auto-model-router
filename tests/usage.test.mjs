import test from 'node:test'
import assert from 'node:assert/strict'
import { attachUsage } from '../src/refresh.js'
import { rankModels, selectForTier } from '../src/select.js'

const ROUTES = {
  fast: { envelope: { maxCost: 55, maxLatency: 'fast', minQuality: 40 } },
  balanced: { envelope: { maxCost: 85, maxLatency: 'balanced', minQuality: 55 } },
  deep: { envelope: { maxCost: 100, maxLatency: 'slow', minQuality: 66 } },
}

const info = (quality, extra = {}) => ({
  label: `m${quality}`,
  quality,
  scores: { overall: quality, coding: quality, reasoning: quality, math: quality, knowledge: quality, agentic: quality, longContext: quality, vision: quality, speed: quality },
  evidence: { overall: 2, coding: 2, reasoning: 2, math: 2, knowledge: 2, agentic: 2, longContext: 1, vision: 1, speed: 1 },
  price: { input: 2, output: 4 },
  latency: 'balanced',
  contextWindow: 200000,
  modalities: ['text'],
  toolCalling: true,
  ...extra,
})

test('usage rows join the catalog by id, bare id or model stem', () => {
  const dataset = {
    'p/deepseek-v4.1-flash-1017': info(70),
    'kimi/kimi-k3': info(72),
    'unrelated': info(60),
  }
  const result = attachUsage(dataset, [
    { id: 'deepseek/deepseek-v4.1-flash-1017', weeklyRank: 1, weeklyTokens: 100, weeklyShare: 0.6 },
    { id: 'moonshot/kimi-k3', weeklyRank: 2 },
    { id: 'x/an-unrelated-model', weeklyRank: 3 },
  ])
  assert.equal(result.matched, 2)
  assert.equal(dataset['p/deepseek-v4.1-flash-1017'].usage.rank, 1)
  assert.equal(dataset['p/deepseek-v4.1-flash-1017'].usage.percentile, 100)
  assert.equal(dataset['kimi/kimi-k3'].usage.percentile, 0)
  assert.equal(dataset['unrelated'].usage, undefined, 'a model with no usage row stays untouched')
})

test('usage is a near-tie breaker, never a capability override', () => {
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 2, vision: false, tools: true }
  const better = { provider: 'p', model: 'better', info: info(80, { usage: { percentile: 0 } }) }
  const popular = { provider: 'p', model: 'popular', info: info(70, { usage: { percentile: 100 } }) }
  const withUsage = rankModels(profile, [better, popular], { costWeight: 0.35, usageWeight: 1 })
  assert.equal(withUsage.ranked[0].model, 'better', 'a ten-point capability gap beats full usage weight')

  // At equal capability the used model wins.
  const tieA = { provider: 'p', model: 'a', info: info(70, { usage: { percentile: 100 } }) }
  const tieB = { provider: 'p', model: 'b', info: info(70) }
  const tie = rankModels(profile, [tieA, tieB], { costWeight: 0.35, usageWeight: 1 })
  assert.equal(tie.ranked[0].model, 'a')
})

test('usageWeight 0 disables the bias entirely', () => {
  const profile = { shape: 'implement', depth: 2, breadth: 2, risk: 2, vision: false, tools: true }
  const used = { provider: 'p', model: 'used', info: info(70, { usage: { percentile: 100 } }) }
  const plain = { provider: 'p', model: 'plain', info: info(70) }
  const off = rankModels(profile, [used, plain], { costWeight: 0.35, usageWeight: 0 })
  const on = rankModels(profile, [used, plain], { costWeight: 0.35, usageWeight: 1 })
  const usedOff = off.ranked.find((row) => row.model === 'used')
  assert.ok((usedOff.usageBoost ?? 0) === 0, 'weight 0 leaves the utility untouched')
  assert.ok(on.ranked.find((row) => row.model === 'used').usageBoost > 0)
})

test('tier selection carries the usage weight through', () => {
  const profile = { shape: 'implement', depth: 1, breadth: 1, risk: 1, vision: false, tools: true }
  const candidates = [
    { provider: 'p', model: 'used', key: 'p/used', info: info(60, { usage: { percentile: 100 } }) },
    { provider: 'p', model: 'plain', key: 'p/plain', info: info(60) },
  ]
  const result = selectForTier(profile, candidates, ROUTES, { usageWeight: 1, defaultRoute: 'balanced' })
  assert.equal(result.selected.model, 'used')
})
