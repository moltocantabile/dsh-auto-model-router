import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aliasMatches } from '../src/identity.js'

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
  const engines = ['src/rank.js', 'src/tiers.js', 'src/basis.js', 'src/select.js', 'src/decision.js', 'src/refresh.js', 'src/client.js', 'src/identity.js']
  const names = /\b(qwen|deepseek|glm|kimi|minimax|llama|claude|gpt|gemini|mistral|moonshot|zhipu|openai|anthropic|alibaba)\b/i
  for (const file of engines) {
    const code = codeOf(file)
    const hit = names.exec(code)
    assert.equal(hit, null, `${file} contains model/vendor-specific logic: "${hit?.[0]}" in "${hit ? code.slice(Math.max(0, hit.index - 60), hit.index + 60) : ''}"`)
  }
})

test('source-name aliases are data, not code', () => {
  // Curated aliases are configuration for sources that spell a model differently;
  // they are inert unless a source row names the alias, and adding one never
  // changes how any other model is ranked or tiered. They live in data so the
  // source tree contains no model spellings at all.
  const aliases = JSON.parse(fs.readFileSync(path.join(root, 'data/model-aliases.json'), 'utf8'))
  assert.ok(aliases !== null && typeof aliases === 'object' && !Array.isArray(aliases), 'the alias file is an object')
  const entries = Object.entries(aliases)
  assert.ok(entries.length > 0, 'the shipped alias file is not empty')
  for (const [id, spellings] of entries) {
    assert.ok(Array.isArray(spellings) && spellings.length > 0, `${id} maps to spellings`)
    for (const spelling of spellings) {
      assert.equal(aliasMatches(id, spelling), true, `${spelling} is an alias of ${id}`)
    }
  }
  // The identity module loads the file and carries no alias literals itself.
  const identity = codeOf('src/identity.js')
  assert.match(identity, /model-aliases\.json/, 'identity reads the data file')
  assert.match(identity, /function loadAliases/, 'the loader is generic')
  // No alias may be read inside the ranking/tier engines either: they consume
  // identity helpers, so a source spelling cannot leak into the algorithms.
  for (const file of ['src/rank.js', 'src/tiers.js', 'src/select.js']) {
    assert.ok(!/model-aliases|NAME_ALIASES|aliasMatches/.test(codeOf(file)), `${file} must not read the alias table`)
  }
})
