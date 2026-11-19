import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Strip comments so prose examples do not count as logic. */
const codeOf = (file) =>
  fs
    .readFileSync(path.join(root, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    // The harness's own plugin packages live under @deepseek-ai/; that is the
    // host namespace, not a model reference in our logic.
    .replace(/@deepseek-ai\/[a-z-]+/g, ' ')

test('the ranking, tiering and selection engines name no vendor or model', () => {
  // The engine must be data-driven: catalogs come from data/, identity mappings
  // from the curated alias table, and nothing may special-case a model in the
  // algorithms. A one-off branch to make one model rank "right" is exactly the
  // failure this test exists to catch.
  const engines = ['src/rank.js', 'src/tiers.js', 'src/basis.js', 'src/select.js', 'src/decision.js', 'src/refresh.js', 'src/client.js']
  const names = /\b(qwen|deepseek|glm|kimi|minimax|llama|claude|gpt|gemini|mistral|moonshot|zhipu|openai|anthropic|alibaba)\b/i
  for (const file of engines) {
    const code = codeOf(file)
    const hit = names.exec(code)
    assert.equal(hit, null, `${file} contains model/vendor-specific logic: "${hit?.[0]}" in "${hit ? code.slice(Math.max(0, hit.index - 60), hit.index + 60) : ''}"`)
  }
})

test('model-specific mappings live in the alias table as data, not in algorithms', () => {
  // Curated aliases are configuration for sources that use a different spelling;
  // they are inert unless a source row names the alias, and adding one never
  // changes how any other model is ranked or tiered.
  const identity = fs.readFileSync(path.join(root, 'src/identity.js'), 'utf8')
  assert.match(identity, /const NAME_ALIASES = \{/)
  const aliasBlock = identity.slice(identity.indexOf('const NAME_ALIASES'), identity.indexOf('/**', identity.indexOf('const NAME_ALIASES')))
  assert.ok(aliasBlock.includes("'") || aliasBlock.trim().length < 200, 'aliases are a mapping table')
  // No alias may be read inside the rank/tier engines: they only consume identity
  // helpers, so a source-specific name cannot leak into the algorithms.
  for (const file of ['src/rank.js', 'src/tiers.js', 'src/select.js']) {
    assert.ok(!/NAME_ALIASES/.test(codeOf(file)), `${file} must not read the alias table`)
  }
})
