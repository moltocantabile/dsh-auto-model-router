import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENROUTER_MODELS_URL,
  OPENROUTER_USAGE_REQUEST_URL,
  OPENROUTER_USAGE_URL,
  OPENROUTER_WEEKLY_ORDER,
  extractOpenRouterUsage,
  fetchOpenRouterUsage,
} from '../src/openrouter.js'

/**
 * Trimmed copy of a real
 * `GET /api/frontend/v1/models/find?order=top-weekly&active=true` response:
 * five models in the order the endpoint returned them, with the matching
 * seven-day `analytics` rows. StepFun has no analytics row (as happens for
 * brand-new or unused models), and GLM has no pricing on its endpoint.
 */
const PAYLOAD = {
  data: {
    models: [
      {
        slug: 'deepseek/deepseek-v4.1-flash-1017',
        name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
        short_name: 'DeepSeek V4.1 Flash 1017',
        author: 'deepseek',
        permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
        endpoint: {
          variant: 'standard',
          model_variant_permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
          pricing: {
            prompt: '0.000000036',
            completion: '0.0000005',
            input_cache_read: '0.00000001',
          },
        },
      },
      {
        slug: 'tencent/hy4-flash',
        name: 'Tencent: Hy4 flash',
        author: 'tencent',
        permaslug: 'tencent/hy4-flash-20261116',
        endpoint: {
          variant: 'standard',
          model_variant_permaslug: 'tencent/hy4-flash-20261116',
          pricing: {
            prompt: '0.000000035',
            completion: '0.0000001405',
            input_cache_read: '0.0000000015',
          },
        },
      },
      {
        // No `author` field: the module must derive it from the id.
        slug: 'z-ai/glm-5.3-flash',
        name: 'Z.ai: GLM 5.3 Flash',
        permaslug: 'z-ai/glm-5.3-flash-20260826',
        endpoint: {
          variant: 'standard',
          model_variant_permaslug: 'z-ai/glm-5.3-flash-20260826',
        },
      },
      {
        slug: 'stepfun/step-5-preview',
        name: 'StepFun: Step 5 Preview',
        author: 'stepfun',
        permaslug: 'stepfun/step-5-preview-20261008',
        endpoint: {
          variant: 'standard',
          model_variant_permaslug: 'stepfun/step-5-preview-20261008',
          pricing: {
            prompt: '0.00000005',
            completion: '0.0000001',
          },
        },
      },
      {
        // Capitalised author field: the id prefix wins.
        slug: 'xiaomi/mimo-v2.6-flash',
        name: 'Xiaomi: MiMo-V2.6-Flash',
        author: 'Xiaomi',
        permaslug: 'xiaomi/mimo-v2.6-flash-20260921',
        endpoint: {
          variant: 'standard',
          model_variant_permaslug: 'xiaomi/mimo-v2.6-flash-20260921',
          pricing: {
            prompt: '0.0000001',
            completion: '0.0000003',
          },
        },
      },
    ],
    analytics: {
      'deepseek/deepseek-v4.1-flash-20261017': {
        date: '2026-11-11 00:00:00',
        model_permaslug: 'deepseek/deepseek-v4.1-flash-20261017',
        variant: 'standard',
        count: 1101723464,
        total_prompt_tokens: 68645406422771,
        total_completion_tokens: 976713874841,
      },
      'tencent/hy4-flash-20261116': {
        date: '2026-11-16 00:00:00',
        model_permaslug: 'tencent/hy4-flash-20261116',
        variant: 'standard',
        count: 373243979,
        total_prompt_tokens: 44630900513196,
        total_completion_tokens: 312796899584,
      },
      'z-ai/glm-5.3-flash-20260826': {
        date: '2026-11-11 00:00:00',
        model_permaslug: 'z-ai/glm-5.3-flash-20260826',
        variant: 'standard',
        count: 408653767,
        total_prompt_tokens: 12814284727865,
        total_completion_tokens: 304039516402,
      },
      'xiaomi/mimo-v2.6-flash-20260921': {
        date: '2026-11-11 00:00:00',
        model_permaslug: 'xiaomi/mimo-v2.6-flash-20260921',
        variant: 'standard',
        count: 215207712,
        total_prompt_tokens: 4531476512193,
        total_completion_tokens: 64986981045,
      },
    },
    weekly_growth: {
      'deepseek/deepseek-v4.1-flash-20261017': 1526,
      'tencent/hy4-flash-20261116': 28,
    },
    modalities: { text: 934 },
  },
}

const EXPECTED_IDS = [
  'deepseek/deepseek-v4.1-flash-1017',
  'tencent/hy4-flash',
  'z-ai/glm-5.3-flash',
  'stepfun/step-5-preview',
  'xiaomi/mimo-v2.6-flash',
]

const weeklyTokensOf = (prompt, completion) => prompt + completion

const DEEPSEEK_TOKENS = weeklyTokensOf(68645406422771, 976713874841)
const TENCENT_TOKENS = weeklyTokensOf(44630900513196, 312796899584)
const GLM_TOKENS = weeklyTokensOf(12814284727865, 304039516402)
const XIAOMI_TOKENS = weeklyTokensOf(4531476512193, 64986981045)
const KNOWN_TOKENS = DEEPSEEK_TOKENS + TENCENT_TOKENS + GLM_TOKENS + XIAOMI_TOKENS

test('exposes the endpoints the ranking actually uses', () => {
  assert.equal(OPENROUTER_MODELS_URL, 'https://openrouter.ai/api/v1/models')
  assert.equal(OPENROUTER_USAGE_URL, 'https://openrouter.ai/api/frontend/v1/models/find')
  assert.equal(OPENROUTER_WEEKLY_ORDER, 'top-weekly')

  const url = new URL(OPENROUTER_USAGE_REQUEST_URL)
  assert.equal(`${url.origin}${url.pathname}`, OPENROUTER_USAGE_URL)
  assert.equal(url.searchParams.get('order'), 'top-weekly')
  assert.equal(url.searchParams.get('active'), 'true')
})

test('keeps the endpoint order so weeklyRank is the published ranking', () => {
  const rows = extractOpenRouterUsage(PAYLOAD)

  assert.deepEqual(rows.map((row) => row.id), EXPECTED_IDS)
  assert.deepEqual(rows.map((row) => row.weeklyRank), [1, 2, 3, 4, 5])
  assert.equal(rows[0].name, 'DeepSeek: DeepSeek V4.1 Flash 1017')
  assert.equal(rows[1].name, 'Tencent: Hy4 flash')
})

test('normalises the author from the author/model id', () => {
  const rows = extractOpenRouterUsage(PAYLOAD)

  // GLM has no `author` in the fixture, Xiaomi's field is capitalised; the id
  // prefix is what OpenRouter's own ids mean and what routing keys expect.
  assert.deepEqual(
    rows.map((row) => row.author),
    ['deepseek', 'tencent', 'z-ai', 'stepfun', 'xiaomi'],
  )
  const alias = extractOpenRouterUsage([
    { slug: '~deepseek/deepseek-flash-latest', name: 'DeepSeek: Flash Latest' },
  ])
  assert.equal(alias[0].author, 'deepseek')
})

test('reads weekly tokens from the seven-day analytics map', () => {
  const rows = extractOpenRouterUsage(PAYLOAD)

  assert.equal(rows[0].weeklyTokens, DEEPSEEK_TOKENS)
  assert.equal(rows[1].weeklyTokens, TENCENT_TOKENS)
  assert.equal(rows[2].weeklyTokens, GLM_TOKENS)
  assert.equal(rows[4].weeklyTokens, XIAOMI_TOKENS)

  // StepFun is ranked but has no analytics row; token/share fields stay absent.
  assert.equal('weeklyTokens' in rows[3], false)
  assert.equal('weeklyShare' in rows[3], false)

  assert.equal(rows[0].weeklyShare, DEEPSEEK_TOKENS / KNOWN_TOKENS)
  const shareSum = rows.reduce((sum, row) => sum + (row.weeklyShare ?? 0), 0)
  assert.ok(Math.abs(shareSum - 1) < 1e-12, 'shares of known rows add up to 1')
})

test('converts per-token pricing to USD per million tokens', () => {
  const rows = extractOpenRouterUsage(PAYLOAD)

  assert.deepEqual(rows[0].pricing, { prompt: 0.036, completion: 0.5 })
  assert.deepEqual(rows[1].pricing, { prompt: 0.035, completion: 0.1405 })
  assert.deepEqual(rows[3].pricing, { prompt: 0.05, completion: 0.1 })

  // GLM's endpoint carries no pricing block in the fixture.
  assert.equal('pricing' in rows[2], false)
})

test('merges free and batch variants that share one model id', () => {
  const variantPayload = {
    data: {
      models: [
        {
          // The free variant is ranked higher than the standard one.
          slug: 'nvidia/nemotron-3.5-super-vl',
          name: 'NVIDIA: Nemotron 3.5 Super VL (free)',
          permaslug: 'nvidia/nemotron-3.5-super-vl-20261015',
          endpoint: {
            variant: 'free',
            model_variant_permaslug: 'nvidia/nemotron-3.5-super-vl-20261015:free',
            pricing: { prompt: '0', completion: '0' },
          },
        },
        {
          slug: 'meta/muse-spark-1.3-contributor',
          name: 'Meta: Muse Spark 1.3 Contributor',
          permaslug: 'meta/muse-spark-1.3-contributor-20260902',
          endpoint: {
            variant: 'standard',
            model_variant_permaslug: 'meta/muse-spark-1.3-contributor-20260902',
            pricing: { prompt: '0.0000003', completion: '0.000001' },
          },
        },
        {
          slug: 'nvidia/nemotron-3.5-super-vl',
          name: 'NVIDIA: Nemotron 3.5 Super VL',
          permaslug: 'nvidia/nemotron-3.5-super-vl-20261015',
          endpoint: {
            variant: 'standard',
            model_variant_permaslug: 'nvidia/nemotron-3.5-super-vl-20261015',
            pricing: { prompt: '0.0000001', completion: '0.0000002' },
          },
        },
      ],
      analytics: {
        'nvidia/nemotron-3.5-super-vl-20261015:free': {
          total_prompt_tokens: 3000,
          total_completion_tokens: 0,
        },
        'meta/muse-spark-1.3-contributor-20260902': {
          total_prompt_tokens: 500,
          total_completion_tokens: 0,
        },
        'nvidia/nemotron-3.5-super-vl-20261015': {
          total_prompt_tokens: 1000,
          total_completion_tokens: 0,
        },
      },
    },
  }

  const rows = extractOpenRouterUsage(variantPayload)

  assert.deepEqual(rows.map((row) => row.id), [
    'nvidia/nemotron-3.5-super-vl',
    'meta/muse-spark-1.3-contributor',
  ])
  assert.deepEqual(rows.map((row) => row.weeklyRank), [1, 2])
  // Standard variant's tokens are merged into the ranked (free) row.
  assert.equal(rows[0].weeklyTokens, 4000)
  // Standard variant wins for the display name and the prices.
  assert.equal(rows[0].name, 'NVIDIA: Nemotron 3.5 Super VL')
  assert.deepEqual(rows[0].pricing, { prompt: 0.1, completion: 0.2 })
  assert.equal(rows[0].weeklyShare, 4000 / 4500)
})

test('accepts a root-level models array and a bare ordered array', () => {
  const fromRoot = extractOpenRouterUsage({
    models: PAYLOAD.data.models,
    analytics: PAYLOAD.data.analytics,
  })
  assert.deepEqual(fromRoot.map((row) => row.id), EXPECTED_IDS)

  const bare = extractOpenRouterUsage([
    { slug: 'a/one', name: 'A: One' },
    { slug: 'b/two', name: 'B: Two' },
  ])
  assert.deepEqual(bare.map((row) => row.weeklyRank), [1, 2])
  assert.deepEqual(bare.map((row) => row.weeklyShare), [undefined, undefined])
})

test('returns [] for payloads it does not understand', () => {
  const garbage = [
    null,
    undefined,
    0,
    42,
    '',
    'not json',
    [],
    {},
    { data: null },
    { data: {} },
    { data: [] },
    { data: { models: null } },
    { data: { models: 'nope' } },
    { models: 'nope' },
    { data: { models: [null, 42, 'x', {}, { name: 'no id here' }] } },
    { data: { models: [{ slug: null, id: '', permaslug: 42 }] } },
  ]

  for (const payload of garbage) {
    assert.deepEqual(extractOpenRouterUsage(payload), [], `payload: ${JSON.stringify(payload)}`)
  }
})

test('keeps rows when only the analytics map is malformed', () => {
  const rows = extractOpenRouterUsage({
    data: {
      models: [{ slug: 'a/one', name: 'A: One', author: 'a' }],
      analytics: ['not', 'a', 'map'],
    },
  })
  assert.deepEqual(rows, [{ id: 'a/one', name: 'A: One', author: 'a', weeklyRank: 1 }])
})

test('fetchOpenRouterUsage requests the top-weekly frontend endpoint', async () => {
  const calls = []
  const controller = new AbortController()
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => PAYLOAD }
  }

  const rows = await fetchOpenRouterUsage({ fetchImpl, signal: controller.signal })

  assert.equal(calls.length, 1)
  const url = new URL(calls[0].url)
  assert.equal(`${url.origin}${url.pathname}`, OPENROUTER_USAGE_URL)
  assert.equal(url.searchParams.get('order'), 'top-weekly')
  assert.equal(url.searchParams.get('active'), 'true')
  assert.equal(calls[0].init.signal, controller.signal)
  assert.deepEqual(rows, extractOpenRouterUsage(PAYLOAD))
})

test('fetchOpenRouterUsage surfaces HTTP and network failures', async () => {
  await assert.rejects(
    fetchOpenRouterUsage({ fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/,
  )
  await assert.rejects(
    fetchOpenRouterUsage({
      fetchImpl: async () => {
        throw new Error('offline')
      },
    }),
    /offline/,
  )
})
