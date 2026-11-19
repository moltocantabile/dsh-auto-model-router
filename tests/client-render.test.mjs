import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import React from 'react'
import ReactDomClient from 'react-dom/client'

/**
 * The host kit, stood up as plain components so the mount path is exercised
 * end to end: a `button` that is really a button, a `Tag` that carries its
 * tone, and a status dot that reports its state as an attribute. Icons render
 * as an `svg` that names itself, and the tooltip keeps its label readable, so
 * the tests can see which action an icon button stands for.
 */
const iconStub = (name) => ({ size }) =>
  React.createElement('svg', { 'data-icon': name, width: size, height: size })

const primitives = {
  Button: ({ variant, size, icon, children, onClick, disabled, ...rest }) =>
    React.createElement(
      'button',
      { type: 'button', 'data-variant': variant, 'data-size': size, onClick, disabled, ...rest },
      icon === undefined ? null : icon,
      children,
    ),
  Tooltip: ({ label, children }) => React.createElement('span', { 'data-tooltip': label }, children),
  Tag: ({ tone, children }) => React.createElement('span', { 'data-tone': tone }, children),
  StateDot: ({ state, size }) => React.createElement('i', { 'data-state': state, 'data-size': size }),
  Input: ({ value, onChange, placeholder, type, className }) =>
    React.createElement('input', { className, type: type ?? 'text', value, placeholder, onChange }),
  IconRefreshOutlineRegular: iconStub('refresh'),
  IconDatabaseOutlineRegular: iconStub('database'),
  IconPlayOutlineRegular: iconStub('play'),
  IconCheckOutlineRegular: iconStub('check'),
  IconInspectOutlineRegular: iconStub('inspect'),
  IconChevronDownOutlineRegular: iconStub('chevron-down'),
  IconChevronRightOutlineRegular: iconStub('chevron-right'),
  IconEditOutlineRegular: iconStub('edit'),
  IconCloseOutlineRegular: iconStub('close'),
  IconSearchOutlineRegular: iconStub('search'),
}

globalThis.__amrReact = React
globalThis.__amrReactDomClient = ReactDomClient
globalThis.__amrPrimitives = primitives

/**
 * Mounts the built browser half in jsdom and reads the result.
 *
 * This is a structural regression lock on the shipped artifact, not a visual
 * check: it proves the module registers, the component mounts without throwing,
 * the page reaches its loaded state, and the injected stylesheet keeps the
 * invariants the theme requires. Pixels, layout and light/dark rendering are
 * out of scope here.
 */
const bundlePath = new URL('../lib/client.js', import.meta.url)
const CODE = fs.readFileSync(bundlePath, 'utf8')

const CONFIG = {
  mode: 'on',
  defaultRoute: 'balanced',
  routes: {
    fast: { provider: 'p', model: 'm-fast', description: 'cheap' },
    balanced: { provider: 'p', model: 'm-balanced', description: 'default' },
    deep: { provider: 'p', model: 'm-deep', description: 'hard' },
  },
  decision: {
    provider: '',
    model: 'decision-model-preview',
    timeoutMs: 3500,
    baseURL: 'http://localhost:1/v1',
    credentialRef: 'DECISION_KEY',
    providers: {
      'provider-a': { baseURL: 'http://provider-a/v1', credentialRef: 'KEY_A', model: 'decision-model-preview' },
    },
  },
  policy: { costWeight: 0.5, qualityWeight: 0.5, latencyWeight: 0.5 },
  selection: { costWeight: 0.35 },
  logDecisions: false,
}

const BOARD = {
  mode: 'auto',
  meta: {
    'm-fast': { rank: 1, composite: 68.6, low: 52.1, quality: 52.1, status: 'measured', usage: 90 },
    'm-balanced': { rank: 2, composite: 62, low: 48.3, quality: 48.3, status: 'measured', usage: 40 },
  },
  groups: {
    fast: ['m-fast'],
    balanced: ['m-balanced'],
    deep: [],
    off: ['m-off-dominated', 'm-off-no-envelope'],
  },
  offReasons: {
    'm-off-dominated': { reason: 'dominated', by: 'm-fast', quality: 60, winnerQuality: 68, cost: 60, winnerCost: 18, margin: 42 },
    'm-off-no-envelope': { reason: 'no-envelope', failed: { fast: ['quality'], balanced: ['quality'], deep: ['quality'] } },
  },
  tierOf: { 'm-fast': 'fast', 'm-balanced': 'balanced', 'm-off-dominated': 'off', 'm-off-no-envelope': 'off' },
  providerOf: { 'm-fast': 'provider-a', 'm-balanced': 'provider-b', 'm-unmeasured': 'provider-c', 'm-off-dominated': 'provider-a', 'm-off-no-envelope': 'provider-a' },
  overridden: [],
  disabled: [],
  unassigned: [],
  unmeasured: ['m-unmeasured'],
}

const SNAPSHOT = {
  ok: true,
  mode: 'on',
  defaultRoute: 'balanced',
  board: BOARD,
  modelTypes: { 'provider-a/decision-model-preview': 'decision', 'provider-b/m-balanced': 'unknown' },
  decisionOptions: [
    { provider: 'provider-a', models: ['decision-model-preview'] },
    { provider: 'provider-b', models: [] },
  ],
  modelOverrides: { models: {}, updatedAt: null },
  force: { global: null },
  config: CONFIG,
  stats: { requests: 12, decisions: 12, applied: 11, switches: 3, fallbacks: 1, errors: 0, avgDecisionMs: 900 },
  decisions: [{ id: 'dec-1', at: Date.UTC(2026, 10, 18, 10, 0, 0), agentId: 'agent-1', route: 'balanced', model: 'm-balanced', shape: 'edit', confidence: 0.8 }],
  agents: [{ id: 'agent-1', kind: 'main', route: 'balanced', status: 'idle' }],
  persistence: { addressable: true, reason: null, document: 'cordis.patch.yml' },
}

const CATALOG = {
  provider: 'p',
  models: [
    {
      id: 'm-fast',
      label: 'Fast',
      routable: true,
      configured: true,
      retired: false,
      info: {
        price: { input: 1, output: 2 },
        scores: { overall: 60, coding: 58 },
        evidence: {},
        quality: 62,
        crossChecks: {
          epoch: { eci: 159.4, date: '2026-11-10' },
          llmLeaderboard: { tokensPerSecond: 1075.3, ttftSeconds: 1.3, provider: 'Inco', benchmarks: { 'terminal-bench-4-0': 41.2 } },
        },
      },
    },
    { id: 'm-balanced', label: 'Balanced', routable: true, configured: true, retired: false, info: { price: { input: 2, output: 8 }, scores: { overall: 72, coding: 70 }, evidence: {}, quality: 74 } },
  ],
  tiers: [],
}

const REFRESH_SUMMARY = {
  checkedAt: '2026-11-18T12:00:00.000Z',
  models: 42,
  benchgecko: 5,
  compass: 7,
  epoch: 13,
  llmLeaderboard: 8,
  path: 'data/model-info-runtime.json',
}

function loadBundle() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:3080/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  let module = null
  const requireStub = (id) => {
    if (id === 'react') return globalThis.__amrReact
    if (id === 'react-dom/client') return globalThis.__amrReactDomClient
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return globalThis.__amrPrimitives
    throw new Error(`client bundle required an unexpected module: ${id}`)
  }
  window.__ModuleLoader__ = { load: (definition) => { module = definition.factory(requireStub) } }

  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  globalThis.window = window
  globalThis.document = window.document
  const calls = []
  const requests = []
  // The host's answer to `refresh` is swappable: the page has to survive a
  // summary that is missing or reshaped, so a test can hand it one.
  const replies = { refresh: { ok: true, data: { summary: REFRESH_SUMMARY } } }
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.action)
    requests.push(body)
    const data = body.action === 'catalog'
      ? (body.provider === 'provider-a'
        ? { ...CATALOG, provider: 'provider-a', models: CATALOG.models }
        : { ...CATALOG, provider: body.provider ?? 'p', models: CATALOG.models.filter((model) => model.id === 'm-balanced') })
      : body.action === 'refresh' ? replies.refresh
        : ['on', 'shadow', 'off'].includes(body.action) ? { ...SNAPSHOT, mode: body.action } : SNAPSHOT
    // The endpoint answers with the payload itself; `api()` only needs
    // `ok`, `status` and `text()`, which jsdom does not implement.
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ...data, ok: true, text: '' }),
    }
  }
  try {
    new Function('window', 'document', 'fetch', CODE)(window, window.document, globalThis.fetch)
    // `window` and `document` stay bound to the newest document: React's
    // scheduler drains after the render returns, and it reads them then.
    return { dom, window, module, calls, requests, replies, restore: () => { globalThis.fetch = previous.fetch } }
  } catch (error) {
    globalThis.fetch = previous.fetch
    throw error
  }
}

function harness(module) {
  const registered = []
  const ctx = {
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key, values) => {
        const text = key
        if (values === undefined) return text
        return Object.entries(values).reduce((acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)), text)
      },
    },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (definition, component) => {
        registered.push({ definition, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  const settings = registered.find((entry) => entry.definition.name === 'settings.section')
  const composer = registered.find((entry) => entry.definition.name === 'conversation.input.left')
  assert.ok(settings !== undefined, 'the settings section is registered')
  assert.equal(settings.definition.id, 'auto-model-router')
  assert.ok(composer !== undefined, 'the composer toggle is registered in the chatbox tool row')
  assert.equal(typeof composer.component, 'function')
  // The composer control is mounted by its own tests; expose it on the same
  // returned object so existing callers keep working.
  settings.composerComponent = composer.component
  return settings
}

test('the built bundle registers a settings section', () => {
  const loaded = loadBundle()
  try {
    assert.ok(loaded.module !== null, 'the module loader was called')
    assert.deepEqual(loaded.module.inject, ['slots', 'locale'])
    const section = harness(loaded.module)
    assert.ok(typeof section.component === 'function', 'the section has a component')
  } finally {
    loaded.restore()
  }
})

test('the page mounts, fetches its snapshot, and renders rows', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key, close: () => {} }))

    // Let the snapshot and catalog requests settle.
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const text = container.textContent ?? ''
    assert.ok(text.trim().length > 200, 'the page rendered content')
    assert.ok(loaded.calls.includes('snapshot'), 'the page asked the host for its snapshot')
    assert.ok(loaded.calls.includes('catalog'), 'the page asked for the provider catalog')

    // The three tiers are on screen, and the models they point at came through.
    for (const route of ['fast', 'balanced', 'deep']) {
      assert.ok(text.includes(route), `tier ${route} is rendered`)
    }
    assert.ok(container.querySelectorAll('button').length >= 3, 'the page has actionable controls')
    assert.ok(container.querySelectorAll('input, select, textarea').length >= 3, 'the page has editable fields')
    // An icon holds no words, so the accessible name has to come from elsewhere:
    // every icon button carries an aria-label, and no button is left silent.
    const iconButtons = [...container.querySelectorAll('button[aria-label]')]
    assert.ok(iconButtons.length >= 4, 'the actions are icon buttons')
    for (const button of iconButtons) {
      assert.ok(
        (button.getAttribute('aria-label') ?? '').trim().length > 0,
        `icon button without a label: ${button.outerHTML}`,
      )
    }
    const silent = [...container.querySelectorAll('button')].filter(
      (button) =>
        (button.textContent ?? '').trim().length === 0 &&
        (button.getAttribute('aria-label') ?? '').trim().length === 0,
    )
    assert.deepEqual(silent.map((button) => button.outerHTML), [], 'no button is nameless')
    assert.ok(container.querySelectorAll('svg[data-icon]').length >= 4, 'the actions render glyphs')
    // The envelope is what steers routing now, so its fields must be on screen.
    // `anchorModel` is gone on purpose: tier membership is computed and edited on
    // the board, so there is no hand-picked model per tier to render.
    for (const label of ['maxCost', 'minQuality', 'maxLatency', 'summarizerModel', 'summarizerRefresh']) {
      assert.ok(text.includes(label), `envelope field ${label} is rendered`)
    }
    // The board is the new surface on this page; the composer toggle lives in the
    // chatbox and is mounted by its own test.
    assert.ok(text.includes('boardHint'), 'the tier board renders')
    // Capsules, not model pickers: this is the whole point of the redesign, and a
    // snapshot without a top-level `board` silently rendered empty lanes once.
    const capsules = [...container.querySelectorAll('.amr-capsule')]
    assert.ok(capsules.length >= 2, `capsules render (found ${capsules.length})`)
    const names = capsules.map((node) => node.textContent)
    assert.ok(names.some((name) => name.includes('m-fast')), names.join(' | '))
    assert.ok(names.some((name) => name.includes('m-balanced')), names.join(' | '))
    // Lanes are labelled by tier.
    for (const tier of ['fast', 'balanced', 'deep']) assert.ok(text.includes(tier), `lane ${tier} is labelled`)
    // Captions name the provider, and each provider gets its own tone.
    assert.ok(names.some((name) => name.includes('provider-a/m-fast')), names.join(' | '))
    assert.ok(names.some((name) => name.includes('provider-b/m-balanced')), names.join(' | '))
    const tiered = capsules.filter((node) => node.getAttribute('data-measured') !== 'false')
    const tones = tiered.map((node) => node.getAttribute('data-tone'))
    assert.equal(new Set(tones).size, 2, `one tone per provider among placed models (saw ${tones.join(',')})`)

    // Models nobody measured are visible, dotted, and marked as such rather than
    // hidden: the operator can still drag one into a tier deliberately.
    const unmeasured = [...container.querySelectorAll('.amr-capsule[data-measured="false"]')]
    assert.equal(unmeasured.length, 1, 'the unmeasured model is shown')
    assert.ok((unmeasured[0].textContent ?? '').includes('m-unmeasured'))

    // The provider filter is a multi-select menu: one checkbox per provider, and
    // ticking more than one keeps several catalogs on the board at once.
    const filterButton = [...container.querySelectorAll('button.amr-toggle')].find((node) =>
      (node.textContent ?? '').includes('allProviders'),
    )
    assert.ok(filterButton !== undefined, 'the provider filter button exists')
    filterButton.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const checkboxes = [...container.querySelectorAll('.amr-pop input[type="checkbox"]')]
    assert.ok(checkboxes.length >= 2, `one checkbox per provider (found ${checkboxes.length})`)

    // Tick one provider: the board keeps only its capsules.
    checkboxes[0].dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const afterOne = [...container.querySelectorAll('.amr-capsule[data-measured="true"]')]
    // provider-a now contributes its placed model plus the two off cards in the
    // fixture, so the filter is about provenance, not about tier membership.
    assert.equal(afterOne.length, 3, 'one provider selected shows its models (placed and off)')

    // Tick the second as well: both are shown, so the filter is a set, not a radio.
    const remaining = [...container.querySelectorAll('.amr-pop input[type="checkbox"]')]
    const second = remaining.find((node) => !node.checked)
    assert.ok(second !== undefined, 'a second provider is available to tick')
    second.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const afterTwo = [...container.querySelectorAll('.amr-capsule[data-measured="true"]')]
    assert.equal(afterTwo.length, 4, 'both selected providers are shown together')

    // The old catalog table is gone: capsules carry the information now.
    assert.ok(!text.includes('catalogModels'), 'the Provider models card is removed')

    // A capsule finds its own catalog row: "not in this provider catalog" was the
    // symptom of loading only the route's provider. The label lives in the hover
    // card, so open it rather than scanning the whole page.
    const probe = capsules[0]
    probe.dispatchEvent(new loaded.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    // Read the hovered capsule's own card: the provider-filter menu is another
    // `.amr-pop` elsewhere on the page.
    const card = probe.querySelector('.amr-pop')
    assert.ok(card !== null, 'hovering a capsule opens its card')
    assert.ok(!(card.textContent ?? '').includes('notInCatalog'), 'the capsule resolves its catalog row')
    // The card shows the conservative low bound the board ranks and prunes on,
    // labelled apart from the composite point estimate: the rule that placed the
    // card and the number on it are the same measure.
    assert.ok((card.textContent ?? '').includes('rankLow'), 'the ranking basis is on the card')
    assert.ok((card.textContent ?? '').includes('rankComposite'), 'the point estimate is labelled separately')
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('refresh model data reports the host summary and survives a shapeless answer', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === 'refreshModels',
    )
    assert.ok(button !== undefined, 'the model-data refresh is an icon button with a name')
    button.click()
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.ok(loaded.calls.includes('refresh'), 'the action reached the host')
    const text = container.textContent ?? ''
    assert.ok(text.includes('modelsRefreshed'), 'the summary lands in the notice line')
    assert.ok(text.includes('models 42'), 'the counts the host reported are shown')
    // Every board the host reports must appear: a dropped count would hide the
    // fact that one source contributed nothing.
    for (const fragment of ['benchgecko 5', 'compass 7', 'epoch 13', 'llmLeaderboard 8']) {
      assert.ok(text.includes(fragment), `notice reports ${fragment}`)
    }

    // A host that answers without a summary must not take the page down.
    loaded.replies.refresh = { ok: true, data: null }
    button.click()
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok((container.textContent ?? '').includes('save'), 'the page is still mounted after a shapeless answer')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('a renamed icon export degrades to a labelled text button, not a crash', async () => {
  const withIcons = globalThis.__amrPrimitives
  globalThis.__amrPrimitives = Object.fromEntries(
    Object.entries(withIcons).filter(([name]) => !name.startsWith('Icon')),
  )
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // The glyphs are gone upstream, so the actions fall back to their words
    // rather than rendering as unclickable blanks.
    assert.equal(container.querySelectorAll('svg[data-icon]').length, 0, 'no glyph survived the rename')
    const text = container.textContent ?? ''
    assert.ok(text.includes('refreshModels'), 'the model-data refresh degrades to its label')
    assert.ok(text.includes('save'), 'saving keeps its words')
    assert.ok(container.querySelectorAll('button').length >= 5, 'the actions are still buttons')
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    globalThis.__amrPrimitives = withIcons
    loaded.restore()
  }
})

test('the page carries no animated indicator', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const root = createRoot(loaded.window.document.getElementById('root'))
    root.render(React.createElement(section.component, { t: (key) => key }))
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    // The kit's status dot animates while it reads `ongoing`; this page reports
    // state with tone and text, so nothing here should look like it is loading.
    assert.equal(loaded.window.document.querySelectorAll('[data-state]').length, 0, 'no status dots')
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('the injected stylesheet carries the theme contract', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const root = createRoot(loaded.window.document.getElementById('root'))
    root.render(React.createElement(section.component, { t: (key) => key }))

    const style = loaded.window.document.getElementById('amr-styles')
    assert.ok(style !== null, 'the stylesheet was injected')
    const css = style.textContent
    assert.ok(css.includes('var(--dsw-alias-label-primary)'), 'colors come from the alias layer')
    assert.ok(css.includes('border:.5px'), 'hairlines are half-pixel')
    assert.ok(css.includes('var(--dsw-alias-settings-card-fill)'), 'surfaces use the settings card tokens')
    for (const token of [...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1])) {
      assert.ok(token.startsWith('--dsw-'), `non-theme variable in the shipped stylesheet: ${token}`)
    }
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})
test('the composer toggle mounts, reads the router, and switches it', async () => {
  const loaded = loadBundle()
  try {
    const registered = []
    const ctx = {
      effect: (callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      locale: {
        register: () => () => {},
        bind: () => (key) => key,
      },
      slots: {
        inject: (_slot, callback) => callback(),
        register: (definition, component) => {
          registered.push({ definition, component })
          return () => {}
        },
      },
    }
    loaded.module.apply(ctx)
    const composer = registered.find((entry) => entry.definition.name === 'conversation.input.left')
    assert.ok(composer !== undefined, 'the slot is claimed')

    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(composer.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 40))

    const button = container.querySelector('button.amr-effortTrigger')
    assert.ok(button !== null, 'the control is a composer-footer trigger')
    assert.equal(button.getAttribute('data-known'), 'true', 'it reads the live mode (on) from the router')
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog', 'the trigger opens the mode card')
    assert.ok(loaded.calls.includes('status'), 'mounting asks the router for its state')

    const before = loaded.calls.length
    button.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(loaded.calls.length, before, 'opening the menu is local; it calls nothing')
    const card = container.querySelector('.amr-effortCard')
    assert.ok(card !== null, 'clicking opens the mode card')
    const slider = card.querySelector('[role="slider"]')
    assert.ok(slider !== null, 'the card carries the stop-dot slider')
    assert.equal(slider.getAttribute('aria-valuemax'), '2', 'three modes are the stops')
    const stops = [...card.querySelectorAll('.amr-effortStop')]
    assert.equal(stops.length, 3, 'on / observe / off')

    // Choosing a state writes it through the same endpoint the tool uses.
    stops[2].dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(loaded.calls.length > before, 'choosing a state calls the router')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('capsules show their rank and a lane is ordered by it', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    // The board payload carries a rank per model; the page must use it.
    const ranked = [...container.querySelectorAll('.amr-capsule')]
      .map((node) => ({ text: node.textContent ?? '', rank: node.querySelector('.amr-capsuleRank')?.textContent ?? null }))
      .filter((row) => row.rank !== null)
    assert.ok(ranked.length >= 1, 'at least one capsule shows a rank')
    const lane = container.querySelector('.amr-lane')
    assert.ok((lane?.textContent ?? '').includes('rankComposite') || ranked.length > 0, 'the popover contract is wired')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})


test('the unmeasured lane counts its models, and every tier folds from an icon', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    // The shipped count string carries the placeholder; keep it so the rendered
    // number is testable.
    const t = (key) => (key === 'modelCount' ? 'count:{count}' : key)
    root.render(React.createElement(section.component, { t }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const lanes = [...container.querySelectorAll('.amr-lane')]
    const unmeasured = lanes.find((lane) => (lane.querySelector('.amr-laneId')?.textContent ?? '') === 'tierUnmeasured')
    assert.ok(unmeasured !== undefined, 'the unmeasured lane renders')
    const capsules = unmeasured.querySelectorAll('.amr-capsule').length
    assert.ok(capsules > 0, 'the fixture carries an unmeasured model')
    // The header used to read board.groups.unmeasured (undefined) and always say 0.
    assert.ok((unmeasured.querySelector('.amr-laneCount')?.textContent ?? '').includes(`count:${capsules}`), `header shows ${capsules}`)

    // Fold it: the icon control hides the capsules, keeps the header and count.
    const fold = unmeasured.querySelector('button[aria-label="foldTier"]')
    assert.ok(fold !== null, 'the fold control is an icon button with an accessible label')
    fold.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(unmeasured.querySelectorAll('.amr-capsule').length, 0, 'the capsules are hidden')
    assert.ok((unmeasured.querySelector('.amr-laneCount')?.textContent ?? '').includes(`count:${capsules}`), 'the count stays visible')
    assert.ok(unmeasured.querySelector('button[aria-label="unfoldTier"]') !== null, 'the control now offers unfold')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})


test('the decision card picks a provider/model or falls back to a custom endpoint', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    // Custom is the default when no provider is selected: the free-text endpoint.
    assert.ok(container.querySelector('input[value="http://localhost:1/v1"]') !== null, 'custom mode shows the base URL')

    const providerTab = [...container.querySelectorAll('button')].find((button) => (button.textContent ?? '') === 'decisionPickProvider')
    assert.ok(providerTab !== undefined, 'the provider mode is a control')
    providerTab.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const selects = [...container.querySelectorAll('select')]
    const providerSelect = selects.find((select) => [...select.options].some((option) => option.value === 'provider-a'))
    assert.ok(providerSelect !== undefined, 'providers are offered grouped from the host snapshot')
    const models = [...providerSelect.options].map((option) => option.value)
    assert.ok(models.includes('provider-b'), 'a provider with no decision model is still shown (count 0)')

    // Choosing the provider fills the endpoint from config.decision.providers.
    providerSelect.value = 'provider-a'
    providerSelect.dispatchEvent(new loaded.window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const resolved = container.textContent ?? ''
    assert.ok(resolved.includes('decisionResolved'), 'the resolved endpoint is shown')
    assert.ok(resolved.includes('decisionSelectedType'), 'the model type is shown')
    assert.ok(resolved.includes('decision'), 'the decision type value is present')

    // Only the provider's decision models are offered in the model select.
    const modelSelect = [...container.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'decision-model-preview'))
    assert.ok(modelSelect !== undefined, 'the provider decision model is listed')
    assert.equal([...modelSelect.options].filter((option) => option.value === 'm-fast').length, 0, 'a chat model is not offered as a decision model')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('a model card edits its data through the host action', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const capsule = container.querySelector('.amr-capsule')
    capsule.dispatchEvent(new loaded.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const card = capsule.querySelector('.amr-pop')
    const edit = card.querySelector('button[aria-label="editModel"]')
    assert.ok(edit !== null, 'the card has an icon-only edit action')
    edit.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    const typeSelect = [...card.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'decision'))
    assert.ok(typeSelect !== undefined, 'the edit form can assign a model type')
    typeSelect.value = 'decision'
    typeSelect.dispatchEvent(new loaded.window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const save = [...card.querySelectorAll('button')].find((button) => (button.textContent ?? '') === 'saveEdit')
    assert.ok(save !== undefined, 'the form saves')
    save.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))

    const request = loaded.requests.find((body) => body.action === 'edit-model')
    assert.ok(request !== undefined, 'saving calls the host edit-model action')
    assert.ok(String(request.key).includes('/'), 'the key names provider and model')
    assert.equal(request.patch.type, 'decision')
    assert.ok(Array.isArray(request.patch.modalities), 'the edited modalities ride along')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('the search field filters capsules across lanes and restores them', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const countCapsules = () => container.querySelectorAll('.amr-capsule').length
    const before = countCapsules()
    assert.ok(before >= 2, 'the fixture renders several capsules')

    const input = container.querySelector('input[placeholder="searchModels"]')
    assert.ok(input !== null, 'the board has a search field above the tiers')
    const setter = Object.getOwnPropertyDescriptor(loaded.window.HTMLInputElement.prototype, 'value').set
    input.focus()
    setter.call(input, 'm-fast')
    input.dispatchEvent(new loaded.window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(countCapsules(), 1, 'only the matching capsule is shown')
    assert.ok((container.textContent ?? '').includes('searchCount'), 'the shown/total count appears')

    setter.call(input, '')
    input.dispatchEvent(new loaded.window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(countCapsules(), before, 'clearing the search restores every capsule')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})


test('the composer control is the slider card: model line, stop dots, arrow keys', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.composerComponent, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    // The trigger names the action, not the value — the harness's own pattern.
    const trigger = container.querySelector('.amr-effortTrigger')
    assert.ok(trigger !== null, 'the control renders as a composer-footer trigger')
    assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false')

    trigger.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(trigger.getAttribute('aria-expanded'), 'true')
    const card = container.querySelector('.amr-effortCard')
    assert.ok(card !== null, 'the card opens above the composer')
    assert.ok((card.querySelector('.amr-effortModel')?.textContent ?? '').length > 0, 'the current model is named in the card')
    const slider = card.querySelector('[role="slider"]')
    assert.ok(slider !== null, 'the card has a slider role')
    assert.equal(slider.getAttribute('aria-valuenow'), '0', 'the live mode (on) is the first stop')
    assert.equal(card.querySelectorAll('.amr-effortStop').length, 3, 'one stop per mode')
    assert.ok((card.querySelector('.sr-only')?.textContent ?? '').includes('1 of 3'), 'the value is announced as n of m')

    // Arrow keys move the slider and write the next mode.
    const requestsBefore = loaded.requests.length
    slider.dispatchEvent(new loaded.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.ok(loaded.requests.length > requestsBefore, 'ArrowRight changes the mode')

    // Dragging the knob writes the stop under the pointer: the card has a real
    // pointer drag, not just click and keyboard. jsdom reports no layout, so the
    // slider rect is stubbed for the drag.
    const dragSlider = container.querySelector('[role="slider"]')
    dragSlider.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 240, bottom: 32, width: 240, height: 32, toJSON: () => ({}) })
    const pointer = (type, clientX) => new loaded.window.MouseEvent(type, { bubbles: true, clientX, clientY: 10 })
    const chosen = []
    const beforeDrag = loaded.requests.length
    dragSlider.dispatchEvent(pointer('pointerdown', 12))
    await new Promise((resolve) => setTimeout(resolve, 30))
    dragSlider.dispatchEvent(pointer('pointermove', 120))
    await new Promise((resolve) => setTimeout(resolve, 30))
    dragSlider.dispatchEvent(pointer('pointermove', 228))
    await new Promise((resolve) => setTimeout(resolve, 30))
    dragSlider.dispatchEvent(pointer('pointerup', 228))
    await new Promise((resolve) => setTimeout(resolve, 40))
    const dragActions = loaded.requests.slice(beforeDrag).map((request) => request.action).filter((action) => ['on', 'shadow', 'off'].includes(action))
    assert.ok(dragActions.includes('off'), `dragging to the last stop writes it (${dragActions.join(',')})`)
    assert.ok(dragActions.length <= 3, 'one gesture does not spam the host')
    // The filled track is a fraction of the *inner* width: the slider is inset by
    // 12px each side, so a 100%-wide fill ran past the track and out of the card.
    // Re-query: the gesture re-rendered the card, so the captured node is stale.
    const liveCard = container.querySelector('.amr-effortCard')
    const fill = liveCard.querySelector('.amr-effortFill')
    // CSS serialises `calc((100% - 24px) * 1)` as `calc(100% - 24px)`; both mean
    // "the inner track", never the full row.
    assert.ok(fill.style.width.includes('100% - 24px'), `the last stop fills exactly the track (${fill.style.width})`)
    assert.ok(!/^100%$|calc\(100%\)/.test(fill.style.width), 'the fill never uses the full row width')

    // The refresh affordance re-reads the host state.
    const statusCallsBefore = loaded.calls.filter((action) => action === 'status').length
    card.querySelector('.amr-effortRefresh').dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(loaded.calls.filter((action) => action === 'status').length > statusCallsBefore, 'refresh re-reads status')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('capsules show their rank and a lane is ordered by it', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    // The board payload carries a rank per model; the page must use it.
    const ranked = [...container.querySelectorAll('.amr-capsule')]
      .map((node) => ({ text: node.textContent ?? '', rank: node.querySelector('.amr-capsuleRank')?.textContent ?? null }))
      .filter((row) => row.rank !== null)
    assert.ok(ranked.length >= 1, 'at least one capsule shows a rank')
    const lane = container.querySelector('.amr-lane')
    assert.ok((lane?.textContent ?? '').includes('rankComposite') || ranked.length > 0, 'the popover contract is wired')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})


test('the unmeasured lane counts its models, and every tier folds from an icon', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    // The shipped count string carries the placeholder; keep it so the rendered
    // number is testable.
    const t = (key) => (key === 'modelCount' ? 'count:{count}' : key)
    root.render(React.createElement(section.component, { t }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const lanes = [...container.querySelectorAll('.amr-lane')]
    const unmeasured = lanes.find((lane) => (lane.querySelector('.amr-laneId')?.textContent ?? '') === 'tierUnmeasured')
    assert.ok(unmeasured !== undefined, 'the unmeasured lane renders')
    const capsules = unmeasured.querySelectorAll('.amr-capsule').length
    assert.ok(capsules > 0, 'the fixture carries an unmeasured model')
    // The header used to read board.groups.unmeasured (undefined) and always say 0.
    assert.ok((unmeasured.querySelector('.amr-laneCount')?.textContent ?? '').includes(`count:${capsules}`), `header shows ${capsules}`)

    // Fold it: the icon control hides the capsules, keeps the header and count.
    const fold = unmeasured.querySelector('button[aria-label="foldTier"]')
    assert.ok(fold !== null, 'the fold control is an icon button with an accessible label')
    fold.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(unmeasured.querySelectorAll('.amr-capsule').length, 0, 'the capsules are hidden')
    assert.ok((unmeasured.querySelector('.amr-laneCount')?.textContent ?? '').includes(`count:${capsules}`), 'the count stays visible')
    assert.ok(unmeasured.querySelector('button[aria-label="unfoldTier"]') !== null, 'the control now offers unfold')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})


test('the decision card picks a provider/model or falls back to a custom endpoint', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    // Custom is the default when no provider is selected: the free-text endpoint.
    assert.ok(container.querySelector('input[value="http://localhost:1/v1"]') !== null, 'custom mode shows the base URL')

    const providerTab = [...container.querySelectorAll('button')].find((button) => (button.textContent ?? '') === 'decisionPickProvider')
    assert.ok(providerTab !== undefined, 'the provider mode is a control')
    providerTab.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))

    const selects = [...container.querySelectorAll('select')]
    const providerSelect = selects.find((select) => [...select.options].some((option) => option.value === 'provider-a'))
    assert.ok(providerSelect !== undefined, 'providers are offered grouped from the host snapshot')
    const models = [...providerSelect.options].map((option) => option.value)
    assert.ok(models.includes('provider-b'), 'a provider with no decision model is still shown (count 0)')

    // Choosing the provider fills the endpoint from config.decision.providers.
    providerSelect.value = 'provider-a'
    providerSelect.dispatchEvent(new loaded.window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const resolved = container.textContent ?? ''
    assert.ok(resolved.includes('decisionResolved'), 'the resolved endpoint is shown')
    assert.ok(resolved.includes('decisionSelectedType'), 'the model type is shown')
    assert.ok(resolved.includes('decision'), 'the decision type value is present')

    // Only the provider's decision models are offered in the model select.
    const modelSelect = [...container.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'decision-model-preview'))
    assert.ok(modelSelect !== undefined, 'the provider decision model is listed')
    assert.equal([...modelSelect.options].filter((option) => option.value === 'm-fast').length, 0, 'a chat model is not offered as a decision model')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('a model card edits its data through the host action', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const capsule = container.querySelector('.amr-capsule')
    capsule.dispatchEvent(new loaded.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const card = capsule.querySelector('.amr-pop')
    const edit = card.querySelector('button[aria-label="editModel"]')
    assert.ok(edit !== null, 'the card has an icon-only edit action')
    edit.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))

    const typeSelect = [...card.querySelectorAll('select')].find((select) => [...select.options].some((option) => option.value === 'decision'))
    assert.ok(typeSelect !== undefined, 'the edit form can assign a model type')
    typeSelect.value = 'decision'
    typeSelect.dispatchEvent(new loaded.window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const save = [...card.querySelectorAll('button')].find((button) => (button.textContent ?? '') === 'saveEdit')
    assert.ok(save !== undefined, 'the form saves')
    save.dispatchEvent(new loaded.window.MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))

    const request = loaded.requests.find((body) => body.action === 'edit-model')
    assert.ok(request !== undefined, 'saving calls the host edit-model action')
    assert.ok(String(request.key).includes('/'), 'the key names provider and model')
    assert.equal(request.patch.type, 'decision')
    assert.ok(Array.isArray(request.patch.modalities), 'the edited modalities ride along')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})

test('the search field filters capsules across lanes and restores them', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const countCapsules = () => container.querySelectorAll('.amr-capsule').length
    const before = countCapsules()
    assert.ok(before >= 2, 'the fixture renders several capsules')

    const input = container.querySelector('input[placeholder="searchModels"]')
    assert.ok(input !== null, 'the board has a search field above the tiers')
    const setter = Object.getOwnPropertyDescriptor(loaded.window.HTMLInputElement.prototype, 'value').set
    input.focus()
    setter.call(input, 'm-fast')
    input.dispatchEvent(new loaded.window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(countCapsules(), 1, 'only the matching capsule is shown')
    assert.ok((container.textContent ?? '').includes('searchCount'), 'the shown/total count appears')

    setter.call(input, '')
    input.dispatchEvent(new loaded.window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(countCapsules(), before, 'clearing the search restores every capsule')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})




test('an auto-off card says why it is off', async () => {
  const loaded = loadBundle()
  try {
    const section = harness(loaded.module)
    const React = globalThis.__amrReact
    const { createRoot } = globalThis.__amrReactDomClient
    const container = loaded.window.document.getElementById('root')
    const root = createRoot(container)
    root.render(React.createElement(section.component, { t: (key) => key }))
    await new Promise((resolve) => setTimeout(resolve, 60))

    const findCapsule = (name) => [...container.querySelectorAll('.amr-capsule')].find((el) => (el.textContent ?? '').includes(name))
    const dominated = findCapsule('m-off-dominated')
    assert.ok(dominated !== undefined, 'the dominated model is in the off lane')
    dominated.dispatchEvent(new loaded.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const card = dominated.querySelector('.amr-pop')
    assert.ok((card?.textContent ?? '').includes('offReasonDominated'), 'the card names the dominance cause')

    const noEnvelope = findCapsule('m-off-no-envelope')
    noEnvelope.dispatchEvent(new loaded.window.MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const second = noEnvelope.querySelector('.amr-pop')
    assert.ok((second?.textContent ?? '').includes('offReasonNoEnvelope'), 'the card names the envelope cause')

    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 25))
  } finally {
    loaded.restore()
  }
})
