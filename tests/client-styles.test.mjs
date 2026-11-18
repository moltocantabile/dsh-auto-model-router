import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'

/**
 * Style invariants for the settings page, checked against the source bundle.
 *
 * These pin what a stylesheet edit breaks silently: a token the theme does not
 * declare (renders as nothing), a font family outside the theme's own (the page
 * drifts from the shell), and markup asking for a class no rule defines.
 */
const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`\n\n    // ── locale'))

/** Every token the theme bundle declares, read from the theme package itself. */
function declaredTokens() {
  const themePath = new URL(
    'file:///Users/colin/.nvm/versions/node/v24.18.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  )
  if (!fs.existsSync(themePath)) return null
  const theme = fs.readFileSync(themePath, 'utf8')
  return new Set([...theme.matchAll(/(--dsw-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))
}

function definedClasses() {
  return new Set([...css.matchAll(/\.(amr[a-zA-Z0-9_-]*)/g)].map((m) => m[1]))
}

function usedClasses() {
  const used = new Set()
  for (const match of source.matchAll(/className:\s*'([^']+)'/g)) {
    for (const name of match[1].split(/\s+/)) if (name.startsWith('amr')) used.add(name)
  }
  return used
}

test('every amr class the markup uses is defined by the stylesheet', () => {
  const defined = definedClasses()
  const missing = [...usedClasses()].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], `undefined classes: ${missing.join(', ')}`)
})

test('every var() names a --dsw token the theme declares', () => {
  const tokens = [...new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))]
  assert.ok(tokens.length > 5, 'expected the stylesheet to use theme tokens')
  for (const token of tokens) assert.ok(token.startsWith('--dsw-'), `non-theme variable: ${token}`)

  const declared = declaredTokens()
  if (declared === null) return // theme package not resolvable here; the prefix check already passed
  const unknown = tokens.filter((token) => !declared.has(token))
  assert.deepEqual(unknown, [], `tokens the theme does not declare: ${unknown.join(', ')}`)
})

test('font families come from the theme', () => {
  const families = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim())
  for (const family of families) {
    assert.equal(family, 'var(--dsw-font-family)', `font-family must defer to the theme: ${family}`)
  }
  assert.ok(/font:inherit/.test(css), 'controls inherit the shell font')
})

test('no color outside the token layer', () => {
  const withoutBrandForeground = css.replace('color:#fff', '')
  const literals = [...withoutBrandForeground.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0])
  assert.deepEqual(literals, [], `hardcoded colors: ${literals.join(', ')}`)
})

test('metrics match the official plugin-inventory settings block', () => {
  assert.ok(/border:\.5px solid var\(--dsw-alias-settings-card-stroke\)/.test(css), 'cards use the settings stroke')
  assert.ok(/background:var\(--dsw-alias-settings-card-fill\)/.test(css), 'cards use the settings fill')
  assert.ok(/\.amr \{[^}]*font-size:13px;[^}]*line-height:20px/.test(css), 'body text is 13/20')
  assert.ok(/gap:14px/.test(css), 'stack gap is 14px')
  assert.ok(!/border:1px solid/.test(css), 'hairlines are .5px')
})

test('width is fluid with an upper bound, never a fixed pixel column', () => {
  const root = css.match(/\.amr \{[^}]*\}/)?.[0] ?? ''
  assert.ok(/width:100%/.test(root), 'the page fills its slot')
  assert.ok(/max-width:\d+px/.test(root), 'and caps its line length')
})

test('inline bar labels cannot be squeezed away', () => {
  // The score row is a flex line inside a narrow table cell: a shrinkable label
  // collapses to zero width and the bar reads as unlabelled.
  const bar = css.match(/\.amr-bar \{[^}]*\}/)?.[0] ?? ''
  assert.ok(/flex:none/.test(bar), '.amr-bar does not shrink')
  assert.ok(/flex-wrap:wrap/.test(css.match(/\.amr-scoreRow \{[^}]*\}/)?.[0] ?? ''), 'the row wraps instead of clipping')
})

test('icon buttons keep a square hit area and the text-button states', () => {
  const box = css.match(/\.amr-iconBtn > button \{[^}]*\}/)?.[0] ?? ''
  assert.ok(/width:28px/.test(box), 'the icon button is as wide as it is tall')
  assert.ok(/height:28px/.test(box), 'and matches the .amr-btn height')
  assert.ok(/padding:0/.test(box), 'the glyph is not padded off-centre')
  assert.ok(/\.amr-iconBtn > button:hover:not\(\[disabled\]\)/.test(css), 'hover matches .amr-btn')
  assert.ok(/\.amr-iconBtn > button\[disabled\] \{[^}]*opacity:\.5/.test(css), 'disabled matches .amr-btn')
})

test('controls come from the host kit', () => {
  assert.ok(source.includes("require('@deepseek-ai/dsh-client-ui-primitives')"), 'primitives are required')
  for (const component of ['Button', 'Tag', 'Input', 'Tooltip']) {
    assert.ok(source.includes(`ui.${component}`), `${component} is taken from the kit`)
  }
})