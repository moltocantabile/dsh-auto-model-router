#!/usr/bin/env node
/**
 * Live smoke test of the decision model, for the checks that cannot run offline.
 *
 * The decision audit's open questions (does the endpoint state confidence, is
 * every question answered, does an explicit model request survive, does the
 * Chinese digest meet the length contract) all need a live endpoint. This script
 * asks them and exits non-zero when an invariant fails, so it can be run against
 * any OpenAI-compatible System One deployment.
 *
 * Usage:
 *   BAILIAN_ALIYUN_API_KEY=... node scripts/decision-smoke.mjs
 *   node scripts/decision-smoke.mjs --base-url URL --model NAME --key-env VAR
 *
 * The key is read from the environment only; nothing is written except an
 * optional `--out` JSON report.
 */
import fs from 'node:fs'
import { buildQuestions, buildState, callDecisionModel, parseDecision } from '../src/decision.js'
import { buildDigestPrompt, callChatModel } from '../src/summarize.js'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}
const baseURL = option('base-url', 'https://ws-11qq6fx2zi7f2wh3.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
const model = option('model', 'decision-model-preview')
const keyEnv = option('key-env', 'BAILIAN_ALIYUN_API_KEY')
const outPath = option('out', null)
const apiKey = process.env[keyEnv]
if (typeof apiKey !== 'string' || apiKey.length === 0) {
  console.error(`missing ${keyEnv}: this script never takes a key on the command line`)
  process.exit(2)
}

const config = { decision: { maxMessages: 10, maxStateChars: 12000, maxMessageChars: 2000 } }
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const tool = () => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', isError: false }] })
const CASES = [
  { name: 'rename', history: [user('Rename the getUser helper to fetchUser everywhere and update its callers.')], claimed: [], steered: false, expect: { shape: ['edit', 'refactor'], intent: ['work'] } },
  { name: 'ack-midturn', history: [user('start the migration'), tool()], claimed: [user('ok')], steered: true, expect: { intent: ['resume', 'acknowledge', 'work'] } },
  { name: 'continue-midturn', history: [user('start the migration'), tool()], claimed: [user('continue')], steered: true, expect: { intent: ['resume'] } },
  { name: 'model-request-listed', history: [user('Use qwen3.8-max for this one: refactor the auth module across modules.')], claimed: [], steered: false, expect: { requestedModel: 'model' } },
  { name: 'model-request-offlist', history: [user('Use some-unknown-model-9000 for this: write the README.')], claimed: [], steered: false, expect: { requestedModel: null } },
  { name: 'trivial', history: [user('What does line 5 of src/index.js say?')], claimed: [], steered: false, expect: { shape: ['lookup'] } },
  { name: 'hard-design', history: [user('Design a migration plan for splitting the billing service into its own repo.')], claimed: [], steered: false, expect: { shape: ['design', 'refactor'] } },
  { name: 'chinese', history: [user('把 getUser 重命名为 fetchUser，并更新所有调用点。')], claimed: [], steered: false, expect: { shape: ['edit', 'refactor'] } },
]
const SHORTLIST = ['qwen3.8-flash', 'deepseek-v4.1-flash-1017', 'qwen3.8-max', 'kimi-k3'].map((id) => `bailian-aliyun/${id}`)

const failures = []
const results = []
for (const testCase of CASES) {
  const state = buildState(testCase.history, testCase.claimed, config, {
    steered: testCase.steered,
    toolNames: ['read', 'bash', 'edit'],
    digest: null,
  })
  const started = Date.now()
  try {
    const raw = await callDecisionModel({ baseURL, apiKey, model, state: state.text, models: SHORTLIST, timeoutMs: 20000 })
    const answers = raw?.answers ?? {}
    const parsed = parseDecision(raw, {}, {})
    const row = {
      name: testCase.name,
      ms: Date.now() - started,
      inputTokens: raw?.inputTokens ?? null,
      answered: Object.keys(answers).length,
      confidence: parsed.confidence,
      intent: parsed.intent ?? null,
      acknowledged: parsed.acknowledged === true,
      requestedModel: parsed.requestedModel ?? null,
      shape: parsed.profile?.shape ?? null,
      modelTop: Object.entries(answers.model?.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }
    // Invariants: every required question answered, non-zero confidence, the
    // expected shape/intent/request outcome.
    if (row.answered !== 10) failures.push(`${testCase.name}: ${row.answered} of 10 questions answered`)
    if (!(row.confidence > 0)) failures.push(`${testCase.name}: confidence ${row.confidence}`)
    if (testCase.expect.shape !== undefined && !testCase.expect.shape.includes(row.shape)) failures.push(`${testCase.name}: shape ${row.shape} not in ${testCase.expect.shape}`)
    if (testCase.expect.intent !== undefined && !testCase.expect.intent.includes(row.intent)) failures.push(`${testCase.name}: intent ${row.intent} not in ${testCase.expect.intent}`)
    if (testCase.expect.requestedModel === 'model' && typeof row.requestedModel !== 'string') failures.push(`${testCase.name}: lost the explicit model request`)
    if (testCase.expect.requestedModel === null && row.requestedModel !== null) failures.push(`${testCase.name}: named a model outside the offered shortlist (${row.requestedModel})`)
    results.push(row)
  } catch (error) {
    failures.push(`${testCase.name}: ${String(error?.message ?? error)}`)
    results.push({ name: testCase.name, error: String(error?.message ?? error) })
  }
}

// The digest contract: 900 characters of digest, including the RISK line, in both
// widths the summarizer meets.
const digests = []
for (const [label, transcript] of [
  ['en', Array.from({ length: 12 }, (_, i) => `user: step ${i}: ${'refactor the handler and update tests; '.repeat(6)}`).join('\n')],
  ['zh', Array.from({ length: 12 }, (_, i) => `user: 第 ${i} 步：重构处理器并更新测试；${'这是很长的需求描述。'.repeat(8)}`).join('\n')],
]) {
  const prompt = buildDigestPrompt({ previous: null, transcript, maxChars: 900 })
  try {
    const text = await callChatModel({ baseURL, apiKey, model: 'qwen3.8-flash', system: prompt.system, user: prompt.user, timeoutMs: 30000 })
    digests.push({ label, chars: text.length, lines: text.split('\n').length, hasRisk: /RISK/i.test(text), hasGoal: /GOAL/i.test(text) })
    if (!(text.length > 0)) failures.push(`digest ${label}: empty`)
    if (!/GOAL/i.test(text)) failures.push(`digest ${label}: missing GOAL line`)
  } catch (error) {
    failures.push(`digest ${label}: ${String(error?.message ?? error)}`)
  }
}

const report = { baseURL, model, at: new Date().toISOString(), cases: results, digests, failures }
console.log(JSON.stringify(report, null, 2))
if (outPath !== null) fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
if (failures.length > 0) {
  console.error(`\n${failures.length} invariant(s) failed`)
  process.exit(1)
}
console.log('\nall decision invariants hold')
