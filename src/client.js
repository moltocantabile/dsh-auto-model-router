/**
 * Client half of @dsh-external/dsh-auto-model-router.
 *
 * Renders the router's configuration page in Settings (`settings.section`).
 * Every state change goes through the same host operations as the
 * `model_router` tool, over the plugin's JSON endpoint
 * (`/dsh-auto-model-router-api`), so the page and the tool cannot drift apart.
 *
 * Model pickers are populated from the live provider catalog (`llm.listModels`),
 * enriched on the host with price, context and capability notes from the
 * plugin's knowledge base. Selecting a model is therefore never a guess about
 * which ids exist.
 *
 * Controls are the host's own: `Button`, `Tag` and `Input` come from
 * `@deepseek-ai/dsh-client-ui-primitives`, one of the eleven modules the
 * shell's seed table exposes to a client bundle, so their appearance and
 * light/dark behaviour are the platform's rather than this file's. Each has a
 * local fallback for the case where an export moves.
 *
 * Styling reads its variables from `--dsw-alias-*` (the semantic layer in
 * `dsh-client-ui-theme`, which follows the light and dark switch) and its
 * metrics from the official plugin-inventory settings block: `.5px` hairlines,
 * `settings-card-fill/stroke` surfaces, 13/20 body text, `font:inherit`.
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-auto-model-router',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host UI kit, with per-export fallbacks so an upstream rename degrades instead of crashing. */
    const ui = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
      } catch (error) {
        return {}
      }
    })()
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-auto-model-router'
    const API = '/dsh-auto-model-router-api'
    const MODES = ['on', 'shadow', 'off']
    const CUSTOM = '__custom__'
    /** How many distinct provider colours the capsule dots cycle through. */
    const PROVIDER_TONES = 5

    /** Stamped by scripts/build.sh, so the page can name the bundle it runs. */
    const BUILD = '__AMR_BUILD_STAMP__'

    /** Copy an envelope without the latency ceiling (the "any latency" choice). */
    function omitLatency(envelope) {
      const next = { ...(envelope ?? {}) }
      delete next.maxLatency
      return next
    }

    // ── styles ──────────────────────────────────────────────────────────────
    /**
     * Stylesheet, read out of this build rather than designed from taste.
     *
     * Three sources, each checkable:
     *
     * 1. **Variables** — every `var()` names a `--dsw-*` token declared by
     *    `dsh-client-ui-theme`; the alias layer (`--dsw-alias-*`) carries the
     *    semantic colors that follow the light and dark switch. A token the
     *    theme does not declare renders as nothing, so the test suite pins the
     *    whole set.
     * 2. **Metrics** — copied from the official plugin-inventory settings
     *    block, the closest official page to this one (a list with state and
     *    actions): `.5px` hairline, `settings-card-fill/stroke`, 13/20 body
     *    text, `font:inherit`, `gap:14px`, and max-width as an upper bound.
     * 3. **Layout** — the shell's `.options` is the only scroll container and
     *    supplies `padding:0 24px 24px`; the section gets `{close}` and no
     *    title. So the page is `width:100%` with a max-width cap, never a
     *    hardcoded pixel width.
     */
    const CSS = `
.amr { width:100%; max-width:760px; display:flex; flex-direction:column; gap:14px; color:var(--dsw-alias-label-primary); font-family:var(--dsw-font-family); font-size:13px; line-height:20px; }
.amr-head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; flex-wrap:wrap; }
.amr-headText { display:flex; flex-direction:column; gap:2px; min-width:220px; flex:1; }
.amr-title { font-size:16px; line-height:24px; font-weight:500; margin:0; }
.amr-build { margin:0; font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }
.amr-sub { font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); margin:0; max-width:64ch; }
.amr-summary { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:4px; }
.amr-card { display:flex; flex-direction:column; gap:14px; padding:12px 14px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-xl); background:var(--dsw-alias-settings-card-fill); }
.amr-cardHead { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; }
.amr-cardTitle { font-size:13px; line-height:20px; font-weight:500; margin:0; }
.amr-cardHint { font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); margin:2px 0 0; max-width:72ch; }
.amr-grid { display:grid; gap:12px 16px; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
.amr-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.amr-field--wide { grid-column:1/-1; }
.amr-label { font-size:13px; line-height:20px; color:var(--dsw-alias-label-secondary); }
.amr-input, .amr-select { height:30px; padding:0 8px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; width:100%; box-sizing:border-box; }
.amr-input:focus-visible, .amr-select:focus-visible, .amr-textarea:focus-visible { border-color:var(--dsw-alias-brand-primary); outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
.amr-input::placeholder, .amr-textarea::placeholder { color:var(--dsw-alias-label-tertiary); }
.amr-textarea { min-height:64px; padding:6px 8px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px; width:100%; box-sizing:border-box; resize:vertical; }
.amr-btn { height:28px; padding:0 10px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); background:0 0; color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; }
.amr-btn:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
.amr-btn[disabled] { opacity:.5; cursor:default; }
.amr-iconBtn { display:inline-flex; align-items:center; }
.amr-iconBtn > button { width:28px; min-width:28px; height:28px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
.amr-iconBtn > button:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
.amr-iconBtn > button[disabled] { opacity:.5; cursor:default; pointer-events:none; }
.amr-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.amr-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.amr-seg { display:inline-flex; gap:2px; padding:2px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); }
.amr-segBtn { height:24px; padding:0 10px; border:0; border-radius:calc(var(--dsw-radius-sm) - 2px); background:0 0; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; cursor:pointer; }
.amr-segBtn:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
.amr-segBtn[data-active="true"] { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-weight:500; }
.amr-segBtn[disabled] { opacity:.5; cursor:default; }
.amr-board { display:flex; flex-direction:column; gap:10px; }
.amr-lane { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-layer-1, transparent); }
.amr-lane[data-over="true"] { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-interactive-bg-hover); }
.amr-laneHead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.amr-laneId { font-size:13px; font-weight:500; }
.amr-laneCount { color:var(--dsw-alias-label-tertiary); font-size:12px; }
.amr-capsules { display:flex; flex-wrap:wrap; gap:6px; min-height:30px; align-items:flex-start; }
.amr-capsule { position:relative; display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:3px 10px; border-radius:999px; border:.5px solid var(--dsw-alias-border-l3); background:var(--dsw-alias-settings-card-fill); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:grab; user-select:none; }
.amr-capsule:hover { border-color:var(--dsw-alias-brand-primary); }
.amr-capsule[data-dragging="true"] { opacity:.4; }
.amr-capsule[data-off="true"] { cursor:pointer; }
.amr-capsule[data-measured="false"] { border-style:dotted; }
.amr-capsule[data-measured="false"] .amr-capsuleProvider { font-style:italic; }
.amr-capsule[data-dominated="true"] { border-style:dashed; }
.amr-capsule[data-overridden="true"] { border-style:dashed; }
.amr-capsuleName { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; }
.amr-capsuleDot { width:6px; height:6px; border-radius:50%; flex:none; background:var(--dsw-alias-brand-primary); }
.amr-capsuleProvider { color:var(--dsw-alias-label-tertiary); }
.amr-capsuleRank { color:var(--dsw-alias-label-tertiary); font-size:11px; font-variant-numeric:tabular-nums; }
.amr-capsuleBadge { font-size:10px; line-height:14px; padding:0 4px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-tertiary); }
.amr-capsuleBadge[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary); }
.amr-capsuleBadge[data-tone="error"] { color:var(--dsw-alias-state-error-primary); }
.amr-capsule[data-tone="0"] { border-color:var(--dsw-alias-brand-primary); }
.amr-capsule[data-tone="0"] .amr-capsuleDot { background:var(--dsw-alias-brand-primary); }
.amr-capsule[data-tone="1"] { border-color:var(--dsw-alias-state-success-primary); }
.amr-capsule[data-tone="1"] .amr-capsuleDot { background:var(--dsw-alias-state-success-primary); }
.amr-capsule[data-tone="2"] { border-color:var(--dsw-alias-state-warn-primary); }
.amr-capsule[data-tone="2"] .amr-capsuleDot { background:var(--dsw-alias-state-warn-primary); }
.amr-capsule[data-tone="3"] { border-color:var(--dsw-alias-state-error-primary); }
.amr-capsule[data-tone="3"] .amr-capsuleDot { background:var(--dsw-alias-state-error-primary); }
.amr-capsule[data-tone="4"] { border-color:var(--dsw-alias-state-idle-primary); }
.amr-capsule[data-tone="4"] .amr-capsuleDot { background:var(--dsw-alias-state-idle-primary); }
.amr-capsule[data-off="true"] .amr-capsuleDot { background:var(--dsw-alias-label-tertiary); }
.amr-pop { position:absolute; z-index:40; top:calc(100% + 6px); left:0; width:260px; display:flex; flex-direction:column; gap:6px; padding:10px 12px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; cursor:default; }
.amr-popTitle { font-size:13px; font-weight:500; }
.amr-popHint { color:var(--dsw-alias-label-tertiary); }
.amr-popActions { display:flex; gap:6px; flex-wrap:wrap; padding-top:2px; }
.amr-emptyLane { color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.amr-toggle { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 10px; border-radius:999px; border:.5px solid var(--dsw-alias-border-l3); background:0 0; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
.amr-toggle:hover { background:var(--dsw-alias-interactive-bg-hover); }
.amr-toggle[data-on="true"] { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-label-primary); }
.amr-toggleDot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-label-tertiary); }
.amr-toggle[data-on="true"] .amr-toggleDot { background:var(--dsw-alias-brand-primary); }
.amr-tier { display:flex; flex-direction:column; gap:12px; padding:12px 14px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-lg); }
.amr-tier + .amr-tier { margin-top:10px; }
.amr-tierHead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.amr-tierId { font-size:13px; font-weight:500; }
.amr-chip { display:inline-flex; align-items:center; gap:4px; padding:0 6px; border-radius:var(--dsw-radius-sm); border:.5px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.amr-mono { font-variant-numeric:tabular-nums; letter-spacing:.01em; }
.amr-cap { color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:20px; font-variant-numeric:tabular-nums; }
.amr-note { margin:0; font-size:13px; line-height:20px; color:var(--dsw-alias-label-tertiary); }
.amr-note[data-tone="ok"] { color:var(--dsw-alias-state-success-primary); }
.amr-note[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary); }
.amr-note[data-tone="error"] { color:var(--dsw-alias-state-error-primary); }
.amr-num { font-variant-numeric:tabular-nums; }
.amr-table { width:100%; border-collapse:collapse; font-size:13px; table-layout:fixed; }
.amr-table th { text-align:left; font-weight:400; color:var(--dsw-alias-label-tertiary); padding:0 8px 6px; border-bottom:.5px solid var(--dsw-alias-border-l3); }
.amr-table td { padding:8px; border-bottom:.5px solid var(--dsw-alias-border-l1); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:top; }
.amr-table th:first-child, .amr-table td:first-child { padding-left:0; }
.amr-table th:last-child, .amr-table td:last-child { padding-right:0; }
.amr-table tbody tr:last-child td { border-bottom:0; }
.amr-table tbody tr:hover td { background:var(--dsw-alias-interactive-bg-hover); }
.amr-scoreRow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; row-gap:4px; margin-top:4px; }
.amr-bar { display:flex; align-items:center; gap:4px; flex:none; }
.amr-barTrack { display:block; width:40px; height:3px; border-radius:2px; background:var(--dsw-alias-border-l1); overflow:hidden; }
.amr-barFill { display:block; height:100%; background:var(--dsw-alias-brand-primary); border-radius:2px; }
.amr-barLabel { flex:none; font-size:10px; line-height:12px; color:var(--dsw-alias-label-tertiary); }
.amr-stats { display:grid; gap:10px 20px; grid-template-columns:repeat(auto-fit,minmax(92px,1fr)); color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:20px; }
.amr-stats b { display:block; font-size:15px; line-height:22px; font-weight:500; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; }
.amr-check { display:flex; align-items:center; gap:8px; font-size:13px; }
.amr-empty { margin:0; color:var(--dsw-alias-label-tertiary); font-size:13px; line-height:20px; }
`


    // ── locale ──────────────────────────────────────────────────────────────
    const dict = {
      en: {
        title: 'Auto Model Router',
        intro:
          'A System One decision model picks the model tier for every agent request. Changes take effect immediately; “Save config” also persists them to the profile patch so they survive a restart.',
        refresh: 'Refresh',
        refreshModels: 'Refresh model data',
        modelsRefreshed: 'Model data refreshed',
        applyRuntime: 'Apply runtime',
        save: 'Save config',
        savedTo: 'Saved to {path}',
        runtimeOnly: 'Runtime only: {reason}',
        applied: 'Applied at runtime.',
        busy: 'Working…',
        mode: 'Mode',
        modeHint: 'on routes requests, shadow decides and records without routing, off disables routing.',
        modeOn: 'on',
        modeShadow: 'shadow',
        modeOff: 'off',
        defaultRoute: 'Default route',
        defaultRouteHint: 'Used when the decision is rejected or a route is unavailable.',
        force: 'Force route',
        forceNone: 'No force',
        forceHint: 'Pins every agent to one tier until cleared.',
        apply: 'Apply',
        clear: 'Clear',
        routes: 'Route tiers',
        routesHint: 'Each tier names a provider/model pair and tells the decision model when to pick it.',
        provider: 'Provider',
        model: 'Model',
        description: 'When to use this tier',
        reasoningEffort: 'Reasoning effort',
        customOption: 'Other (type an id)…',
        notInCatalog: 'not in this provider catalog',
        retiredModel: 'retired',
        previewModel: 'preview',
        sunsetModel: 'ends {date}',
        notRoutable: 'not a routing model',
        notConfigured: 'not configured',
        notConfiguredHint: 'The provider advertises this model but has no credentialed route for it; a tier using it falls back to the default.',
        catalogModels: 'Provider models',
        anchorModel: 'anchor model',
        anchorModelHint: 'Used for force, for the fallback path, and by the tier menu. Routing picks the best model inside the envelope.',
        tiers: 'Tiers',
        tiersHint: 'Membership is computed from measurement: a model joins the cheapest tier whose envelope it satisfies. Drag a capsule to move it, click one to switch it off.',
        boardHint: 'Hover a model for its price, capability and context. Drag between tiers to overrule the automatic assignment; click to disable it.',
        boardLoading: 'The provider catalogs are still loading; the tiers fill in as soon as they answer.',
        providersSeen: 'Providers on this board: {count}.',
        providerFilter: 'Providers',
        allProviders: 'All providers',
        providersSelected: '{count} providers',
        providerFilterHint: 'Tick the providers to show. Nothing ticked shows all.',
        filterActive: 'Showing {provider} only.',
        unmeasuredHint: '{count} advertised models are not routable: nobody measured their quality, so they cannot be ranked.',
        tierUnmeasured: 'unmeasured',
        badgeOff: 'off',
        badgeSuperseded: 'superseded',
        badgeProvisional: 'provisional',
        badgeUncalibrated: '{count} uncal.',
        rankComposite: 'composite {value}',
        rankPosition: 'rank #{rank}',
        rankUsage: 'usage {pct}th pct',
        unmeasuredModelHint: 'No quality measurement: it cannot be ranked automatically. Drag it into a tier to route it anyway.',
        dominatedHint: 'Off automatically: {by} is cheaper and scores higher. Drag it into a tier to use it anyway.',
        tierOff: 'off',
        laneEmpty: 'No model here yet.',
        modelCount: '{count} models',
        modeAuto: 'auto',
        modeManual: 'manual',
        handAssigned: 'hand-assigned',
        moveTo: '→ {tier}',
        disableModel: 'Disable',
        enableModel: 'Enable',
        resetToAuto: 'Follow auto',
        resetBoard: 'Reset board to automatic',
        capsuleHint: 'Click a model to switch it off, drag it to move it.',
        toggleLabel: 'Auto',
        toggleTitle: 'Automatic model routing',
        toggleOnTitle: 'Auto routing is deciding the model',
        toggleOffTitle: 'Auto routing is off; the model picker decides',
        toggleUnknown: 'Auto routing: state unknown (click to read it)',
        toggleOn: 'On — route every session',
        toggleShadow: 'Observe — decide and log, do not switch',
        toggleOff: 'Off — leave the model alone',
        toggleHint: 'Sticky sessions keep the model they started on; a named model or a pin still wins.',
        maxCost: 'max cost index',
        minQuality: 'min quality',
        maxLatency: 'max latency',
        anyLatency: 'any',
        envelopeHint: 'The envelope is what steers routing: the task profile picks a tier, then the best model that fits it is chosen.',
        catalogModelsHint: 'Every model the provider advertises, with cost and capabilities. Assign a model to a tier, or edit tiers above. Scores are 0-100 composites: cod coding, rea reasoning, agt agentic, math mathematics. The bar row repeats cod/rea/agt, and CC is the CompassRank leaderboard average.',
        noCatalog: 'The provider catalog is unavailable.',
        modelCol: 'Model',
        capabilityCol: 'Capabilities',
        costCol: 'CNY per 1M',
        tierCol: 'Tier',
        tierAuto: 'auto',
        assign: 'Assign',
        noModels: 'No models reported.',
        decision: 'Decision model',
        decisionHint: 'The System One endpoint that classifies each request. It answers typed questions, never prose.',
        baseURL: 'Base URL',
        credentialRef: 'Credential',
        timeout: 'Timeout (ms)',
        maxMessages: 'Transcript messages',
        maxStateChars: 'State budget (chars)',
        maxMessageChars: 'Per-message budget',
        summarizer: 'Session digest',
        summarizerHint: 'A cheap model summarizes the session so routing decisions see the task, not just the last step.',
        summarizerModel: 'Summarizer model',
        summarizerMaxChars: 'Digest budget (chars)',
        summarizerRefresh: 'Refresh every N messages',
        policy: 'Confidence policy',
        policyHint:
          'A choice below the confidence or probability floor falls back to the complexity axis; switching tiers needs switchConfidence.',
        minConfidence: 'Min confidence',
        minProbability: 'Min probability',
        acknowledgeConfidence: 'Acknowledge confidence',
        acknowledgeHint: 'How sure the decision model must be that a message only acknowledges before its turn is priced at zero.',
        modelRequestConfidence: 'Model request confidence',
        modelRequestHint: 'How sure it must be that a named model is a request rather than a mention in a log or config.',
        switchConfidence: 'Switch confidence',
        envelopeMode: 'Tier ceilings',
        envelopeExplicit: 'hand-written',
        envelopeMerge: 'data, unless hand-written',
        envelopeDerived: 'data-derived',
        switchingAuto: 'Re-route every step (auto switch)',
        switchingHint: 'Off by default: a session keeps the model it started on. The decision is still logged, and naming a model or using `force` always moves it.',
        logDecisions: 'Log every decision at info level',
        observability: 'Observability',
        stats: 'Stats',
        agents: 'Live agents',
        decisions: 'Recent decisions',
        noDecisions: 'No decisions yet.',
        noAgents: 'No live agents.',
        selection: 'Model selection',
        selectionHint:
          'The decision model names the task shape, depth, breadth and risk; the router then scores every configured model on measured capability and picks the highest utility. This knob sets how much cost weighs against capability.',
        costWeight: 'Cost weight',
        costWeightHint: '0 = quality at any price · 1 = cheapest that clears the floor',
        costWeightExplain: 'Current {value}: higher trades capability for price.',
        classify: 'Classify',
        classifyHint: 'Run the decision model on pasted text without routing anything.',
        probePlaceholder: 'Paste a task description to see which tier the decision model would pick…',
        probeEmpty: 'Enter some text first.',
        probeRoute: 'Model',
        probeRanking: 'Selection ranking',
        probeRankingHint: 'How the winner scored against every other model in the pool, and which capability dimensions were weighted.',
        probeExcluded: 'Excluded: {list}',
        probeConfidence: 'Confidence',
        probeComplexity: 'Complexity',
        probeTools: 'Needs tools',
        requests: 'requests',
        decisionsCount: 'decisions',
        switches: 'switches',
        fallbacks: 'fallbacks',
        errors: 'errors',
        avgMs: 'avg decision ms',
        agent: 'Agent',
        kind: 'Kind',
        status: 'Status',
        route: 'Route',
        time: 'Time',
        confidence: 'Conf.',
        source: 'Source',
        state: 'State',
        task: 'Task',
        priceUnknown: 'unpriced',
        contextFailed: 'Catalog error: {error}',
      },
      zh: {
        title: '自动模型路由',
        intro:
          '由 System One 决策模型为每个 agent 请求选择模型档位。修改即时生效；“保存配置”还会写入 profile patch，重启后依然有效。',
        refresh: '刷新',
        refreshModels: '刷新模型数据',
        modelsRefreshed: '模型数据已刷新',
        applyRuntime: '仅运行时应用',
        save: '保存配置',
        savedTo: '已保存到 {path}',
        runtimeOnly: '仅运行时：{reason}',
        applied: '已在运行时生效。',
        busy: '处理中…',
        mode: '模式',
        modeHint: 'on 按决策路由，shadow 只记录不路由，off 关闭路由。',
        modeOn: 'on',
        modeShadow: 'shadow',
        modeOff: 'off',
        defaultRoute: '默认档位',
        defaultRouteHint: '决策被拒绝或档位不可用时使用。',
        force: '强制档位',
        forceNone: '不强制',
        forceHint: '把所有 agent 固定到一个档位，直到清除。',
        apply: '应用',
        clear: '清除',
        routes: '档位',
        routesHint: '每个档位是一组 provider/模型，并告诉决策模型何时选择它。',
        provider: '提供方',
        model: '模型',
        description: '何时使用该档位',
        reasoningEffort: '推理强度',
        customOption: '其他（手动输入 id）…',
        notInCatalog: '不在该提供方目录中',
        retiredModel: '已下线',
        previewModel: '预览版',
        sunsetModel: '截止 {date}',
        notRoutable: '非路由模型',
        notConfigured: '未配置',
        notConfiguredHint: '提供方公布了该模型，但本地没有可用的凭据路由；使用它的档位会回退到默认档位。',
        catalogModels: '提供方模型',
        anchorModel: '锚定模型',
        anchorModelHint: '用于强制指定、回退路径与档位菜单。路由会在封套范围内选择最合适的模型。',
        tiers: '档位',
        tiersHint: '档位成员由实测自动划分：模型进入它能满足的最便宜档位。拖动胶囊可改档，点击可停用。',
        boardHint: '悬停查看价格、能力与上下文；拖动可覆盖自动分配，点击可停用该模型。',
        boardLoading: '正在读取各供应商的模型目录，读取完成后档位会自动填充。',
        providersSeen: '当前面板包含 {count} 个供应商。',
        providerFilter: '供应商',
        allProviders: '全部供应商',
        providersSelected: '{count} 个供应商',
        providerFilterHint: '勾选要显示的供应商；全不勾选则显示全部。',
        filterActive: '仅显示 {provider}。',
        unmeasuredHint: '另有 {count} 个模型未被路由：没有任何质量测量，无法排序。',
        tierUnmeasured: '未测量',
        badgeOff: '停用',
        badgeSuperseded: '已被超越',
        badgeProvisional: '临时',
        badgeUncalibrated: '{count} 项未校准',
        rankComposite: '综合分 {value}',
        rankPosition: '排名 #{rank}',
        rankUsage: '使用度 {pct} 百分位',
        unmeasuredModelHint: '没有任何质量测量，无法自动排序。拖入某个档位即可强制纳入路由。',
        dominatedHint: '已自动停用：{by} 更便宜且得分更高。仍可拖入档位强制使用。',
        tierOff: '停用',
        laneEmpty: '暂无模型。',
        modelCount: '{count} 个模型',
        modeAuto: '自动',
        modeManual: '手动',
        handAssigned: '手动指定',
        moveTo: '→ {tier}',
        disableModel: '停用',
        enableModel: '启用',
        resetToAuto: '恢复自动',
        resetBoard: '全部恢复自动',
        capsuleHint: '点击停用，拖动换档。',
        toggleLabel: '自动',
        toggleTitle: '自动模型路由',
        toggleOnTitle: '自动路由正在决定模型',
        toggleOffTitle: '自动路由已关闭，由模型选择器决定',
        toggleUnknown: '自动路由：状态未知（点击读取）',
        toggleOn: '开启 — 路由每个会话',
        toggleShadow: '观察 — 只决策记录，不切换',
        toggleOff: '关闭 — 不干预模型',
        toggleHint: '固定会话沿用开场模型；点名模型或强制指定仍然优先。',
        maxCost: '成本上限',
        minQuality: '质量下限',
        maxLatency: '延迟上限',
        anyLatency: '不限',
        envelopeHint: '封套才真正决定路由：任务画像先选出档位，再在档位内挑选最合适的模型。',
        catalogModelsHint: '该提供方公布的全部模型及其成本与能力。可把模型分配到档位，或在上方编辑档位。评分为 0-100 综合分：cod 编码、rea 推理、agt 智能体、math 数学。条形图对应 cod/rea/agt，CC 为 CompassRank 榜单均分。',
        noCatalog: '无法读取提供方目录。',
        modelCol: '模型',
        capabilityCol: '能力',
        costCol: '元 / 百万 token',
        tierCol: '档位',
        tierAuto: '自动',
        assign: '分配',
        noModels: '没有返回模型。',
        decision: '决策模型',
        decisionHint: '对每个请求进行分类的 System One 端点，只返回结构化答案，不返回文本。',
        baseURL: 'Base URL',
        credentialRef: '凭据',
        timeout: '超时（毫秒）',
        maxMessages: '对话消息数',
        maxStateChars: '状态预算（字符）',
        maxMessageChars: '单条消息预算',
        summarizer: '会话摘要',
        summarizerHint: '用便宜模型总结整个会话，让路由决策看到任务本身，而不只是最后一步。',
        summarizerModel: '摘要模型',
        summarizerMaxChars: '摘要长度上限（字符）',
        summarizerRefresh: '每 N 条消息刷新',
        policy: '置信度策略',
        policyHint: '低于置信度或概率下限的选择会退回复杂度判定；切换档位需要达到切换置信度。',
        minConfidence: '最低置信度',
        minProbability: '最低概率',
        acknowledgeConfidence: '确认置信度',
        acknowledgeHint: '判定模型有多确定「这条消息只是确认」时才把该轮按零成本计价。',
        modelRequestConfidence: '点名模型置信度',
        modelRequestHint: '判定模型有多确定「点名的模型是请求」而非日志、配置里的提及。',
        switchConfidence: '切换置信度',
        envelopeMode: '档位上限来源',
        envelopeExplicit: '手写',
        envelopeMerge: '数据（手写优先）',
        envelopeDerived: '数据推导',
        switchingAuto: '每步重新路由（自动切换）',
        switchingHint: '默认关闭：会话沿用开场选定的模型。决策仍会记录；用户点名模型或使用 `force` 时照常切换。',
        logDecisions: '在 info 级别记录每次决策',
        observability: '运行观测',
        stats: '统计',
        agents: '在线 agent',
        decisions: '最近的决策',
        noDecisions: '暂无决策。',
        noAgents: '暂无在线 agent。',
        selection: '模型选择',
        selectionHint:
          '决策模型判断任务形状、深度、广度与风险，路由器再按实测能力为每个已配置模型打分并选出效用最高者。此参数控制成本相对能力的权重。',
        costWeight: '成本权重',
        costWeightHint: '0 = 不计价格追求质量 · 1 = 最便宜且达到质量下限',
        costWeightExplain: '当前 {value}：越高越偏向低价。',
        classify: '试算',
        classifyHint: '对粘贴的文本运行决策模型，不实际路由。',
        probePlaceholder: '粘贴一段任务描述，看看决策模型会选哪个档位…',
        probeEmpty: '请先输入文本。',
        probeRoute: '档位',
        probeConfidence: '置信度',
        probeComplexity: '复杂度',
        probeTools: '需要工具',
        requests: '请求',
        decisionsCount: '决策',
        switches: '切换',
        fallbacks: '回退',
        errors: '错误',
        avgMs: '平均决策毫秒',
        agent: 'Agent',
        kind: '类型',
        status: '状态',
        route: '档位',
        probeRanking: '选择排序',
        probeRankingHint: '胜出模型与其余模型的得分对比，以及各能力维度的权重。',
        probeExcluded: '已排除：{list}',
        time: '时间',
        confidence: '置信度',
        source: '来源',
        state: '状态',
        task: '任务',
        priceUnknown: '未定价',
        contextFailed: '目录读取失败：{error}',
      },
    }

    // ── transport ───────────────────────────────────────────────────────────
    async function api(action, args) {
      const response = await fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(args ?? {}) }),
      })
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`router API returned a non-JSON body (${response.status})`)
      }
      if (!response.ok || body?.ok === false) throw new Error(body?.error ?? `router API failed (${response.status})`)
      return body
    }

    /**
     * The host's `refresh` re-reads the model facts and answers with a summary
     * inside `data`. Only what it actually sent is shown, and a missing or
     * reshaped summary renders nothing rather than throwing at the page.
     */
    function summaryLine(body, t) {
      const summary = body?.data?.summary
      if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return null
      const parts = []
      // Every board is reported, because a refresh that silently drops one is
      // exactly the failure a reader needs to see.
      const counts = ['models', 'benchgecko', 'compass', 'epoch', 'llmLeaderboard']
        .filter((key) => typeof summary[key] === 'number' && Number.isFinite(summary[key]))
        .map((key) => `${key} ${summary[key]}`)
      if (counts.length > 0) parts.push(counts.join(' · '))
      for (const key of ['checkedAt', 'path']) {
        if (typeof summary[key] === 'string' && summary[key].trim().length > 0) parts.push(summary[key].trim())
      }
      return parts.length === 0 ? null : `${t('modelsRefreshed')}: ${parts.join(' · ')}`
    }

    // ── formatting ──────────────────────────────────────────────────────────
    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

    function money(value) {
      const parsed = number(value)
      if (parsed === null) return null
      return parsed >= 1 ? String(Math.round(parsed * 100) / 100) : String(parsed)
    }

    function contextLabel(tokens) {
      const parsed = number(tokens)
      if (parsed === null || parsed <= 0) return null
      if (parsed >= 1_000_000) return `${Math.round((parsed / 1_000_000) * 10) / 10}M`
      return `${Math.round(parsed / 1000)}k`
    }

    /** `¥2 / ¥8 · 1M` — the one-line cost summary used in pickers and tables. */
    function costLabel(info) {
      if (info === null || info === undefined) return null
      const input = money(info.price?.input)
      const output = money(info.price?.output)
      const ctx = contextLabel(info.contextWindow)
      const parts = []
      if (input !== null && output !== null) parts.push(`¥${input} / ¥${output}`)
      if (ctx !== null) parts.push(ctx)
      return parts.length === 0 ? null : parts.join(' · ')
    }

    // ── atoms ───────────────────────────────────────────────────────────────
    function Card({ title, hint, actions, children }) {
      return h(
        'section',
        { className: 'amr-card' },
        (title !== undefined || hint !== undefined || actions !== undefined) &&
          h(
            'div',
            { className: 'amr-cardHead' },
            h(
              'div',
              null,
              title !== undefined && h('h3', { className: 'amr-cardTitle' }, title),
              hint !== undefined && h('p', { className: 'amr-cardHint' }, hint),
            ),
            actions,
          ),
        children,
      )
    }

    function Field({ label, hint, wide, children }) {
      return h(
        'label',
        { className: wide === true ? 'amr-field amr-field--wide' : 'amr-field' },
        h('span', { className: 'amr-label' }, label),
        children,
        hint !== undefined && h('p', { className: 'amr-cardHint' }, hint),
      )
    }

    function TextInput({ value, onChange, placeholder, type }) {
      const text = value === undefined || value === null ? '' : String(value)
      const handle = (event) => onChange(event.target.value)
      if (typeof ui.Input === 'function') {
        return h(ui.Input, { className: 'amr-input', type: type ?? 'text', value: text, placeholder, onChange: handle })
      }
      return h('input', { className: 'amr-input', type: type ?? 'text', value: text, placeholder, onChange: handle, spellCheck: false })
    }

    function NumberInput({ value, onChange, step, min }) {
      return h('input', {
        className: 'amr-input',
        type: 'number',
        step: step ?? 1,
        min: min ?? 0,
        value: value === undefined || value === null ? '' : String(value),
        onChange: (event) => {
          const parsed = Number(event.target.value)
          onChange(Number.isFinite(parsed) ? parsed : 0)
        },
      })
    }

    function Select({ value, onChange, children }) {
      return h('select', { className: 'amr-select', value, onChange: (event) => onChange(event.target.value) }, children)
    }

    function Button({ children, onClick, variant, disabled, title, icon: glyph, ...rest }) {
      if (typeof ui.Button === 'function') {
        return h(
          ui.Button,
          {
            variant: variant === 'primary' ? 'primary' : variant === 'ghost' ? 'ghost' : 'outline',
            size: 'sm',
            disabled: disabled === true,
            onClick,
            ...(glyph === undefined || glyph === null ? {} : { icon: glyph }),
            ...(title === undefined ? {} : { title }),
            ...rest,
          },
          children,
        )
      }
      const className =
        variant === 'primary' ? 'amr-btn amr-btn--primary' : variant === 'ghost' ? 'amr-btn amr-btn--ghost' : 'amr-btn'
      return h(
        'button',
        { type: 'button', className, onClick, disabled: disabled === true, title, ...rest },
        glyph === undefined || glyph === null ? null : glyph,
        children,
      )
    }

    /**
     * One guarded door to the kit's icon set: the export when this build has it,
     * `null` when a rename moved it — the caller then falls back to its words
     * instead of the page dying over a missing glyph.
     */
    function glyphOf(name) {
      const candidate = ui[name]
      return typeof candidate === 'function' ? candidate : null
    }

    /**
     * Icon-first action. The glyph is the visible control; the tooltip and the
     * button's own `aria-label` both carry the words, so the accessible name
     * never depends on the icon having rendered.
     */
    function IconButton({ name, label, onClick, disabled }) {
      const glyph = glyphOf(name)
      if (glyph === null) return h(Button, { onClick, disabled }, label)
      const button = h(Button, { onClick, disabled, icon: h(glyph, { size: 14 }), 'aria-label': label })
      const wrapped = h(
        'span',
        typeof ui.Tooltip === 'function' ? { className: 'amr-iconBtn' } : { className: 'amr-iconBtn', title: label },
        button,
      )
      if (typeof ui.Tooltip !== 'function') return wrapped
      return h(ui.Tooltip, { label, side: 'bottom', delayMs: 400 }, wrapped)
    }

    const TAG_TONES = { ok: 'success', warn: 'warning', error: 'danger', info: 'info' }

    /**
     * A toned label, text-only: a configuration page reports state in color and
     * wording rather than with an indicator that animates.
     */
    function Chip({ children, tone, ...rest }) {
      if (typeof ui.Tag === 'function') {
        return h(ui.Tag, { tone: TAG_TONES[tone] ?? 'neutral', ...rest }, children)
      }
      return h('span', { className: 'amr-chip', 'data-tone': tone, ...rest }, children)
    }

    /** Model picker: every catalog id, grouped by whether it can serve routing. */
    function ModelSelect({ value, models, onChange, t }) {
      const current = String(value ?? '')
      const known = models.some((entry) => entry.id === current)
      const usable = (entry) => entry.routable === true && entry.retired !== true && entry.configured !== false
      const routing = models.filter(usable)
      const others = models.filter((entry) => !usable(entry))
      const label = (entry) => {
        const cost = costLabel(entry.info)
        return cost === null ? entry.id : `${entry.id}  —  ${cost}`
      }
      return h(
        Select,
        { value: known ? current : CUSTOM, onChange: (next) => onChange(next === CUSTOM ? '' : next) },
        !known && current.length > 0 && h('option', { value: current }, `${current} (${t('notInCatalog')})`),
        !known && current.length === 0 && h('option', { value: CUSTOM }, t('notInCatalog')),
        h(
          'optgroup',
          { label: t('routes') },
          routing.map((entry) => h('option', { key: entry.id, value: entry.id }, label(entry))),
        ),
        others.length > 0 &&
          h(
            'optgroup',
            { label: t('notRoutable') },
            others.map((entry) =>
              h(
                'option',
                { key: entry.id, value: entry.id, disabled: entry.routable !== true || entry.configured === false },
                label(entry),
              ),
            ),
          ),
        h('option', { value: CUSTOM }, t('customOption')),
      )
    }

    /** The four dimensions routing actually scores, with their full names for tooltips. */
    /**
     * Effective digest settings when the stored config predates them. Kept in
     * step with `DEFAULT_SUMMARIZER` in src/summarize.js; the host is the
     * authority, this only keeps the form from rendering blanks.
     */
    const SUMMARIZER_DEFAULTS = { enabled: true, model: '', timeoutMs: 8000, maxChars: 900, minMessages: 6, refreshEvery: 6 }

    const SCORE_DIMS = [
      ['cod', 'coding'],
      ['rea', 'reasoning'],
      ['agt', 'agentic'],
      ['math', 'math'],
    ]

    /**
     * Measured capability line. Each score is the 0-100 composite this plugin
     * keeps per model (see `model-info-data.json`), so the abbreviation is always
     * paired with its full name in a tooltip and the card hint spells them out.
     */
    function scoreLine(info) {
      const scores = info?.scores
      if (scores === null || scores === undefined) {
        return h('span', { className: 'amr-note' }, 'no benchmark data')
      }
      const verify = info?.evidence ?? {}
      const samples = ['coding', 'reasoning', 'math', 'knowledge', 'agentic'].reduce((sum, dim) => sum + (verify[dim] ?? 0), 0)
      return h(
        'div',
        { className: 'amr-row' },
        h(
          'span',
          { className: 'amr-mono', style: { fontSize: 11 } },
          SCORE_DIMS.filter(([, key]) => typeof scores[key] === 'number').map(([abbr, key], index) =>
            h(
              'span',
              { key, title: `${key} ${Math.round(scores[key])}/100` },
              index === 0 ? `${abbr} ${Math.round(scores[key])}` : ` · ${abbr} ${Math.round(scores[key])}`,
            ),
          ),
        ),
        samples === 0 ? h(Chip, { tone: 'warn' }, 'prior only') : h(Chip, null, `${samples} samples`),
        ...crossCheckChips(info),
        [contextLabel(info?.contextWindow), info?.latency,
          ...(info?.modalities ?? []).filter((modality) => modality !== 'text')]
          .filter((piece) => piece !== null && piece !== undefined && piece !== '')
          .join(' · '),
      )
    }

    /** Tiny inline bars so the strongest dimension is visible at a glance. */
    function scoreBar(info) {
      const scores = info?.scores
      if (scores === null || scores === undefined) return null
      return SCORE_DIMS.slice(0, 3).map(([label, key]) => {
        const value = scores[key]
        return h(
          'span',
          { key, className: 'amr-bar', title: `${key} ${Math.round(value ?? 0)}/100` },
          h('span', { className: 'amr-barTrack' }, h('span', { className: 'amr-barFill', style: { width: `${Math.max(2, Math.min(100, value ?? 0))}%` } })),
          h('span', { className: 'amr-barLabel' }, label),
        )
      })
    }

    /**
     * Cross-check chips: one per independent leaderboard that measured this
     * model. They are evidence, not inputs to the score, so they carry no tone
     * that suggests rank — just the number and a tooltip naming the board.
     */
    function crossCheckChips(info) {
      const checks = info?.crossChecks
      if (checks === undefined || checks === null) return []
      const chips = []
      const cc = checks.compassRank
      if (cc !== undefined && cc !== null) {
        const parts = []
        if (typeof cc.average === 'number') parts.push(`avg ${Math.round(cc.average)}`)
        if (typeof cc.reasoning === 'number') parts.push(`rea ${Math.round(cc.reasoning)}`)
        if (typeof cc.agent === 'number') parts.push(`agt ${Math.round(cc.agent)}`)
        if (typeof cc.swePro === 'number') parts.push(`swe ${Math.round(cc.swePro)}`)
        chips.push(
          h(Chip, { key: 'cc', tone: 'info', title: `CompassRank V3.0 · evaluated ${cc.evaluated ?? '—'} · ${parts.join(' · ')}` }, `CC ${Math.round(cc.average ?? 0)}`),
        )
      }
      const epoch = checks.epoch
      if (epoch !== undefined && epoch !== null && typeof epoch.eci === 'number') {
        // ECI is an interval scale, not a percentage: label it as an index so it
        // is not read on the same 0-100 axis as the score columns.
        chips.push(h(Chip, { key: 'eci', tone: 'neutral', title: `Epoch Capabilities Index ${epoch.eci} · ${epoch.date ?? '—'}` }, `ECI ${Math.round(epoch.eci)}`))
      }
      const lb = checks.llmLeaderboard
      if (lb !== undefined && lb !== null) {
        const boards = Object.keys(lb.benchmarks ?? {})
        if (boards.length > 0) {
          const detail = boards.map((id) => `${id} ${lb.benchmarks[id]}`).join(' · ')
          chips.push(h(Chip, { key: 'lb', tone: 'neutral', title: `llmleaderboard.com · ${detail}` }, `LB ${boards.length}`))
        }
        if (typeof lb.tokensPerSecond === 'number') {
          chips.push(h(Chip, { key: 'tps', tone: 'neutral', title: `measured ${Math.round(lb.tokensPerSecond)} tok/s · TTFT ${lb.ttftSeconds ?? '—'}s · ${lb.provider ?? 'unknown offer'}` }, `${Math.round(lb.tokensPerSecond)} tok/s`))
        }
      }
      return chips
    }

    /** Per-model facts under a tier: cost line plus retire/preview warnings. */
    function ModelFacts({ entry, t }) {
      if (entry === null || entry === undefined) {
        return h('span', { className: 'amr-note', 'data-tone': 'warn' }, t('notInCatalog'))
      }
      const cost = costLabel(entry.info)
      const chunks = []
      if (cost !== null) chunks.push(cost)
      if (entry.preview === true && typeof entry.sunsetAt === 'string') {
        chunks.push(t('sunsetModel').replace('{date}', entry.sunsetAt))
      }
      const latency = entry.info?.latency
      if (latency !== undefined) chunks.push(String(latency))
      const extras = (entry.info?.modalities ?? []).filter((modality) => modality !== 'text')
      if (extras.length > 0) chunks.push(extras.join('+'))
      return h(
        'div',
        { className: 'amr-row' },
        h('span', { className: 'amr-cap' }, chunks.join(' · ')),
        ...crossCheckChips(entry?.info),
        entry.retired === true && h(Chip, { tone: 'error' }, t('retiredModel')),
        entry.preview === true && h(Chip, { tone: 'warn' }, t('previewModel')),
        entry.routable !== true && h(Chip, { tone: 'warn' }, t('notRoutable')),
        entry.configured === false && h(Chip, { tone: 'warn' }, t('notConfigured')),
      )
    }


    // ── tier board ──────────────────────────────────────────────────────────
    /**
     * Who is in which tier, and the only place membership is edited.
     *
     * The board is computed on the host (`snap.board`) so the page and the
     * router cannot disagree about the assignment. Every gesture maps to one
     * config change and is applied immediately: dragging a capsule sets an
     * override for that model, clicking it switches the model off, and a model
     * with neither follows the automatic assignment again.
     */
    function TierBoard({ snap, draft, models, t, applyTiers, busy }) {
      const board = snap.board ?? { mode: draft.tiers?.mode ?? 'auto', groups: { fast: [], balanced: [], deep: [], off: [] }, overridden: [], unassigned: [] }
      const overrides = draft.tiers?.overrides ?? {}
      const disabled = new Set(draft.tiers?.disabled ?? [])
      // Keyed the same way as the board (provider/model): a bare id is ambiguous
      // once several catalogs are on screen.
      const index = new Map((models ?? []).map((entry) => [`${entry.provider}/${entry.id}`, entry]))
      // Bare-id fallback: a board key without a provider (an older snapshot) still
      // finds its row instead of claiming the model is not in any catalog.
      const byBareId = new Map()
      for (const entry of models ?? []) if (!byBareId.has(entry.id)) byBareId.set(entry.id, entry)
      const providerOf = board.providerOf ?? {}
      const dominatedBy = new Map((board.dominated ?? []).map((entry) => [entry.key, entry.by]))
      const [hovered, setHovered] = useState(null)
      const [dragging, setDragging] = useState(null)
      const [over, setOver] = useState(null)
      // Which provider's models are on screen. Capsules from one provider share a
      // colour, so this filter is the difference between a readable board and a
      // soup of ids once a profile exposes several catalogs.
      // Empty means "every provider": an explicit empty selection would hide the
      // whole board, which is never what someone meant by unticking the last box.
      const [providerFilter, setProviderFilter] = useState([])
      const [providerMenu, setProviderMenu] = useState(false)

      const providers = useMemo(() => {
        const seen = new Map()
        for (const id of Object.values(providerOf)) {
          if (typeof id !== 'string' || id.length === 0) continue
          seen.set(id, (seen.get(id) ?? 0) + 1)
        }
        return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, count]) => ({ id, count }))
      }, [board])

      const providerTone = useMemo(() => {
        const tones = new Map()
        providers.forEach((provider, position) => tones.set(provider.id, position % PROVIDER_TONES))
        return tones
      }, [providers])

      const visible = (key) => providerFilter.length === 0 || providerFilter.includes(providerOf[key])
      const toggleProvider = (id) =>
        setProviderFilter((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))

      const lanes = [
        ...['fast', 'balanced', 'deep'].map((id) => ({ id, label: id, off: false })),
        { id: 'off', label: t('tierOff'), off: true },
        { id: 'unmeasured', label: t('tierUnmeasured'), off: true },
      ]
      const metaOf = (key) => board.meta?.[key] ?? {}
      const laneMembers = (id) => {
        const members = (id === 'unmeasured' ? board.unmeasured ?? [] : board.groups?.[id] ?? []).filter(visible)
        // Measured rank first (best first), then the unranked ones in place.
        return [...members].sort((a, b) => {
          const ra = metaOf(a).rank
          const rb = metaOf(b).rank
          if (ra === rb) return a.localeCompare(b)
          if (ra === null || ra === undefined) return 1
          if (rb === null || rb === undefined) return -1
          return ra - rb
        })
      }

      function move(model, tier) {
        if (busy === true) return
        if (tier === 'off') {
          applyTiers({ ...(draft.tiers ?? {}), disabled: [...new Set([...disabled, model])] })
          return
        }
        const nextOverrides = { ...overrides, [model]: tier }
        applyTiers({ ...(draft.tiers ?? {}), overrides: nextOverrides, disabled: [...disabled].filter((id) => id !== model) })
      }

      function followAuto(model) {
        if (busy === true) return
        const nextOverrides = { ...overrides }
        delete nextOverrides[model]
        applyTiers({ ...(draft.tiers ?? {}), overrides: nextOverrides, disabled: [...disabled].filter((id) => id !== model) })
      }

      function capsule(key, laneId) {
        const model = board.modelOf?.[key] ?? key
        const entry = index.get(key) ?? index.get(`${providerOf[key]}/${model}`) ?? byBareId.get(model) ?? null
        const off = disabled.has(key)
        const handAssigned = Object.hasOwn(overrides, key)
        const open = hovered === key
        return h(
          'div',
          {
            key,
            className: 'amr-capsule',
            draggable: !off && busy !== true,
            'data-off': off ? 'true' : 'false',
            'data-overridden': handAssigned ? 'true' : 'false',
            'data-tone': String(providerTone.get(providerOf[key]) ?? 0),
            'data-measured': laneId === 'unmeasured' ? 'false' : 'true',
            'data-dominated': dominatedBy.has(key) ? 'true' : 'false',
            'data-dragging': dragging === key ? 'true' : 'false',
            title: dominatedBy.has(key)
              ? t('dominatedHint').replace('{by}', dominatedBy.get(key))
              : laneId === 'unmeasured' ? t('unmeasuredModelHint') : off ? t('enableModel') : t('disableModel'),
            onMouseEnter: () => setHovered(key),
            onMouseLeave: () => setHovered((current) => (current === key ? null : current)),
            onClick: () => (off ? followAuto(key) : move(key, 'off')),
            onDragStart: (event) => {
              setDragging(key)
              try {
                event.dataTransfer.setData('text/plain', key)
                event.dataTransfer.effectAllowed = 'move'
              } catch (error) {
                /* some browsers refuse a synthetic transfer; the drop still reads `dragging` */
              }
            },
            onDragEnd: () => {
              setDragging(null)
              setOver(null)
            },
          },
          h('span', { className: 'amr-capsuleDot' }),
          metaOf(key).rank !== null && metaOf(key).rank !== undefined &&
            h('span', { className: 'amr-capsuleRank' }, `#${metaOf(key).rank}`),
          h(
            'span',
            { className: 'amr-capsuleName' },
            h('span', { className: 'amr-capsuleProvider' }, `${providerOf[key] ?? 'unknown'}/`),
            model,
          ),
          // State is a badge, not a faded card: a faded parent also faded the
          // hover card, which made superseded models unreadable.
          off && h('span', { className: 'amr-capsuleBadge', 'data-tone': 'warn' }, t('badgeOff')),
          dominatedBy.has(key) && h('span', { className: 'amr-capsuleBadge', 'data-tone': 'warn' }, t('badgeSuperseded')),
          metaOf(key).status === 'provisional' && h('span', { className: 'amr-capsuleBadge' }, t('badgeProvisional')),
          (metaOf(key).uncalibrated ?? 0) > 0 && h('span', { className: 'amr-capsuleBadge', 'data-tone': 'error' }, t('badgeUncalibrated').replace('{count}', String(metaOf(key).uncalibrated))),
          handAssigned && h('span', { className: 'amr-capsuleBadge', 'data-tone': 'warn' }, t('handAssigned')),
          open &&
            h(
              'div',
              { className: 'amr-pop', onClick: (event) => event.stopPropagation() },
              h('span', { className: 'amr-popTitle' }, `${providerOf[key] ?? 'unknown'}/${model}`),
              (metaOf(key).composite !== null || metaOf(key).usage !== null) &&
                h(
                  'p',
                  { className: 'amr-note' },
                  [
                    metaOf(key).composite === null ? null : t('rankComposite').replace('{value}', String(metaOf(key).composite)),
                    metaOf(key).rank === null ? null : t('rankPosition').replace('{rank}', String(metaOf(key).rank)),
                    metaOf(key).usage === null ? null : t('rankUsage').replace('{pct}', String(metaOf(key).usage)),
                  ].filter(Boolean).join(' · '),
                ),
              laneId === 'unmeasured' && h('p', { className: 'amr-note' }, t('unmeasuredModelHint')),
              dominatedBy.has(key) && h('p', { className: 'amr-note' }, t('dominatedHint').replace('{by}', dominatedBy.get(key))),
              h(ModelFacts, { entry, t }),
              h(
                'div',
                { className: 'amr-popActions' },
                ...['fast', 'balanced', 'deep'].map((tier) =>
                  h(
                    Button,
                    {
                      key: tier,
                      disabled: busy === true || overrides[key] === tier,
                      onClick: () => move(key, tier),
                    },
                    t('moveTo').replace('{tier}', tier),
                  ),
                ),
                h(
                  Button,
                  { disabled: busy === true, onClick: () => (off ? followAuto(key) : move(key, 'off')) },
                  off ? t('enableModel') : t('disableModel'),
                ),
                handAssigned &&
                  h(Button, { disabled: busy === true, onClick: () => followAuto(key) }, t('resetToAuto')),
              ),
              h('span', { className: 'amr-popHint' }, t('capsuleHint')),
            ),
        )
      }

      function laneMeta(id) {
        const members = board.groups?.[id] ?? []
        const count = members.length
        return h(
          'div',
          { className: 'amr-laneHead' },
          h('span', { className: 'amr-laneId' }, lanes.find((lane) => lane.id === id)?.label ?? id),
          h('span', { className: 'amr-laneCount' }, t('modelCount').replace('{count}', String(count))),
          id === draft.defaultRoute && h(Chip, { tone: 'ok' }, t('defaultRoute')),
          id !== 'off' && h(
            Button,
            {
              disabled: busy === true,
              onClick: () => applyTiers({ ...(draft.tiers ?? {}), mode: (draft.tiers?.mode ?? 'auto') === 'auto' ? 'manual' : 'auto' }),
            },
            (draft.tiers?.mode ?? 'auto') === 'auto' ? t('modeAuto') : t('modeManual'),
          ),
        )
      }

      return h(
        'div',
        { className: 'amr-board' },
        h(
          'div',
          { className: 'amr-row' },
          h(
            'div',
            { className: 'amr-field', style: { minWidth: 200, position: 'relative' } },
            h('span', { className: 'amr-label' }, t('providerFilter')),
            h(
              'button',
              {
                type: 'button',
                className: 'amr-toggle',
                'data-on': providerFilter.length > 0 ? 'true' : 'false',
                'aria-expanded': providerMenu ? 'true' : 'false',
                onClick: () => setProviderMenu((open) => !open),
              },
              h('span', { className: 'amr-toggleDot' }),
              providerFilter.length === 0
                ? t('allProviders')
                : t('providersSelected').replace('{count}', String(providerFilter.length)),
            ),
            providerMenu &&
              h(
                'div',
                {
                  className: 'amr-pop',
                  style: { width: 260 },
                  onMouseLeave: () => setProviderMenu(false),
                },
                h(
                  'div',
                  { className: 'amr-row', style: { justifyContent: 'space-between' } },
                  h('span', { className: 'amr-popTitle' }, t('providerFilter')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'amr-segBtn',
                      onClick: () => setProviderFilter([]),
                    },
                    t('allProviders'),
                  ),
                ),
                ...providers.map((provider) =>
                  h(
                    'label',
                    { key: provider.id, className: 'amr-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: providerFilter.includes(provider.id),
                      onChange: () => toggleProvider(provider.id),
                    }),
                    h('span', {}, `${provider.id} (${provider.count})`),
                  ),
                ),
                h('span', { className: 'amr-popHint' }, t('providerFilterHint')),
              ),
          ),
          providerFilter.length > 0 &&
            h('span', { className: 'amr-note' }, t('filterActive').replace('{provider}', providerFilter.join(', '))),
        ),
        snap.board === null && h('p', { className: 'amr-note', 'data-tone': 'warn' }, t('boardLoading')),
        h('p', { className: 'amr-note' }, t('boardHint')),
        (board.unmeasured ?? []).length > 0 &&
          h('p', { className: 'amr-note' }, t('unmeasuredHint').replace('{count}', String((board.unmeasured ?? []).length))),
        ...lanes.map((lane) => {
          const members = laneMembers(lane.id)
          return h(
            'div',
            {
              key: lane.id,
              className: 'amr-lane',
              'data-over': over === lane.id ? 'true' : 'false',
              onDragOver: (event) => {
                event.preventDefault()
                setOver(lane.id)
              },
              onDragLeave: () => setOver((current) => (current === lane.id ? null : current)),
              onDrop: (event) => {
                event.preventDefault()
                let dropped = dragging
                try {
                  dropped = event.dataTransfer.getData('text/plain') || dropped
                } catch (error) {
                  /* fall back to the capsule that started the drag */
                }
                setOver(null)
                setDragging(null)
                if (typeof dropped === 'string' && dropped.length > 0) move(dropped, lane.id)
              },
            },
            laneMeta(lane.id),
            h(
              'div',
              { className: 'amr-capsules' },
              members.length === 0
                ? h('span', { className: 'amr-emptyLane' }, t('laneEmpty'))
                : members.map((model) => capsule(model, lane.id)),
            ),
          )
        }),
        h(
          'div',
          { className: 'amr-row' },
          h(
            Button,
            {
              disabled: busy === true,
              onClick: () => applyTiers({ ...(draft.tiers ?? {}), overrides: {}, disabled: [] }),
            },
            t('resetBoard'),
          ),
        ),
      )
    }


    // ── composer toggle ─────────────────────────────────────────────────────
    /**
     * Auto routing, as a control in the composer tool row.
     *
     * The model menu next to it is shell-owned, so this is the seat a plugin
     * gets: one chip that says whether routing is deciding the model, and a
     * popover with the states that matter in a session — auto, observe, and off
     * (the model picker takes over). It reads the host on mount and after every
     * change, so two windows cannot disagree for long.
     */
    function ComposerToggle(props) {
      const t = props.t
      const [mode, setMode] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        let cancelled = false
        api('status')
          .then((body) => {
            if (!cancelled && mounted.current) setMode(body.mode ?? 'off')
          })
          .catch(() => {
            /* a router that cannot be reached simply shows no state */
          })
        return () => {
          cancelled = true
          mounted.current = false
        }
      }, [])

      const choose = async (next) => {
        setBusy(true)
        try {
          const body = await api(next === 'toggle' ? (mode === 'on' ? 'off' : 'on') : next)
          if (mounted.current) setMode(body.mode ?? 'off')
        } catch (error) {
          /* leave the previous state visible rather than guessing */
        } finally {
          if (mounted.current) setBusy(false)
          setOpen(false)
        }
      }

      // Never render nothing: a chip that hides itself when `status` fails is
      // indistinguishable from a plugin that never loaded, which is exactly the
      // confusion this cost once. Unknown reads as "off" and clicking re-reads.
      const known = mode !== null
      const on = mode === 'on'
      return h(
        'div',
        { style: { position: 'relative' } },
        h(
          'button',
          {
            type: 'button',
            className: 'amr-toggle',
            'data-on': on ? 'true' : 'false',
            title: known ? (on ? t('toggleOnTitle') : t('toggleOffTitle')) : t('toggleUnknown'),
            'aria-pressed': on ? 'true' : 'false',
            'data-known': known ? 'true' : 'false',
            onClick: () => {
              if (!known) {
                api('status')
                  .then((body) => {
                    if (mounted.current) setMode(body.mode ?? 'off')
                  })
                  .catch(() => {})
                return
              }
              setOpen((current) => !current)
            },
          },
          h('span', { className: 'amr-toggleDot' }),
          t('toggleLabel'),
        ),
        open &&
          h(
            'div',
            {
              className: 'amr-pop',
              style: { top: 'auto', bottom: 'calc(100% + 6px)', left: 0, width: 220 },
              onMouseLeave: () => setOpen(false),
            },
            h('span', { className: 'amr-popTitle' }, t('toggleTitle')),
            ...[
              ['on', t('toggleOn')],
              ['shadow', t('toggleShadow')],
              ['off', t('toggleOff')],
            ].map(([value, label]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'amr-segBtn',
                  style: { textAlign: 'left', width: '100%' },
                  'data-active': mode === value ? 'true' : 'false',
                  disabled: busy,
                  onClick: () => choose(value),
                },
                label,
              ),
            ),
            h('span', { className: 'amr-popHint' }, t('toggleHint')),
          ),
      )
    }

    // ── page ────────────────────────────────────────────────────────────────
    function RouterPanel(props) {
      const t = props.t
      const [snap, setSnap] = useState(null)
      const [draft, setDraft] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [catalogs, setCatalogs] = useState({})
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [probeText, setProbeText] = useState('')
      const [probeBusy, setProbeBusy] = useState(false)
      const [probeResult, setProbeResult] = useState(null)
      const [modelBusy, setModelBusy] = useState(false)
      const mounted = useRef(true)

      const adopt = useCallback((payload) => {
        setSnap(payload)
        setDraft((previous) => {
          const next = JSON.parse(JSON.stringify(payload.config))
          next.decision.summarizer = { ...SUMMARIZER_DEFAULTS, ...(next.decision.summarizer ?? {}) }
          // Keep in-progress description edits while the rest comes from the host.
          if (previous !== null) {
            for (const [id, route] of Object.entries(next.routes)) {
              const edited = previous.routes?.[id]
              if (edited !== undefined && typeof edited.description === 'string') route.description = edited.description
            }
          }
          return next
        })
      }, [])

      const loadCatalog = useCallback(async (provider) => {
        if (typeof provider !== 'string' || provider.length === 0) return
        const body = await api('catalog', { provider })
        if (!mounted.current) return
        setCatalog(body)
        setCatalogs((previous) => ({ ...previous, [body.provider]: body.models ?? [] }))
      }, [])

      /**
       * Load a catalog for every provider the page can show.
       *
       * The board spans every provider the harness exposes, so loading only the
       * providers named in the routes left most capsules without a catalog row --
       * reported to the operator as "not in this provider catalog", which read
       * like a missing model rather than a missing fetch.
       */
      const loadCatalogsFor = useCallback(
        async (config, board) => {
          const providers = new Set(Object.values(config?.routes ?? {}).map((route) => route.provider))
          for (const provider of Object.values(board?.providerOf ?? {})) providers.add(provider)
          for (const provider of providers) {
            if (typeof provider === 'string' && provider.length > 0) await loadCatalog(provider)
          }
        },
        [loadCatalog],
      )

      const refresh = useCallback(async () => {
        let payload = await api('snapshot')
        // A snapshot taken while the host is rebuilding its catalog can carry a
        // board built from the route anchors alone. One retry turns that from a
        // wrong board on screen into a short delay.
        const boardProviders = new Set(Object.values(payload?.board?.providerOf ?? {}))
        if (payload?.board !== undefined && payload.board !== null && boardProviders.size < 2) {
          await new Promise((resolve) => setTimeout(resolve, 900))
          const again = await api('snapshot')
          if (new Set(Object.values(again?.board?.providerOf ?? {})).size > boardProviders.size) payload = again
        }
        if (!mounted.current) return
        adopt(payload)
        await loadCatalogsFor(payload.config, payload.board)
      }, [adopt, loadCatalogsFor])

      /**
       * Re-read the upstream model facts. The catalog's scores come from them,
       * so it is reloaded too: a refreshed summary over stale numbers would be
       * worse than no button at all.
       */
      const refreshModels = useCallback(async () => {
        setModelBusy(true)
        try {
          const body = await api('refresh')
          if (!mounted.current) return
          const line = summaryLine(body, t)
          setNotice(line === null ? null : { tone: 'ok', text: line })
          await loadCatalogsFor(draft).catch(() => undefined)
        } catch (error) {
          if (mounted.current) setNotice({ tone: 'error', text: String(error?.message ?? error) })
        } finally {
          if (mounted.current) setModelBusy(false)
        }
      }, [draft, loadCatalogsFor, t])

      const run = useCallback(
        async (action, args) => {
          setBusy(true)
          try {
            const body = await api(action, args)
            if (mounted.current) {
              if (body.config !== undefined) adopt(body)
              if (action === 'configure') {
                const persist = body.persist ?? {}
                setNotice(
                  persist.saved === true
                    ? { tone: 'ok', text: t('savedTo').replace('{path}', persist.document ?? 'profile patch') }
                    : { tone: 'warn', text: t('runtimeOnly').replace('{reason}', String(persist.reason ?? 'unknown')) },
                )
                await loadCatalogsFor(body.config)
              } else {
                setNotice({ tone: 'ok', text: t('applied') })
              }
            }
            return body
          } catch (error) {
            if (mounted.current) setNotice({ tone: 'error', text: String(error?.message ?? error) })
            return null
          } finally {
            if (mounted.current) setBusy(false)
          }
        },
        [adopt, loadCatalogsFor, t],
      )

      // Tell the host what this page actually has. Without it, "the UI shows one
      // provider" and "the bundle never loaded" are indistinguishable from the
      // host side, which cost several rounds of guesswork.
      useEffect(() => {
        if (snap === null || draft === null) return
        const board = snap.board ?? null
        const count = (id) => (board?.groups?.[id] ?? []).length
        const providers = board?.providerOf ? [...new Set(Object.values(board.providerOf))] : []
        const capsules = typeof document === 'undefined' ? null : document.querySelectorAll('.amr-capsule').length
        api('client-report', {
          build: BUILD,
          instance: snap.instance ?? null,
          board: board !== null,
          providers,
          lanes: board === null ? null : { fast: count('fast'), balanced: count('balanced'), deep: count('deep'), off: count('off') },
          capsules,
          tiersMode: (draft.tiers?.mode ?? 'auto'),
        }).catch(() => {})
      }, [snap, draft])

      useEffect(() => {
        mounted.current = true
        refresh().catch((error) => {
          if (mounted.current) setNotice({ tone: 'error', text: String(error?.message ?? error) })
        })
        // The host can change under an open page (a reload, a tool call, another
        // window). Poll the snapshot so the board is never showing a membership
        // the router no longer has -- stale data here reads as a broken feature.
        const read = () => {
          if (!mounted.current) return
          api('snapshot')
            .then((payload) => {
              if (mounted.current && payload?.config !== undefined) adopt(payload)
            })
            .catch(() => {})
        }
        const timer = setInterval(() => {
          // Background tabs throttle timers to about once a minute, so a poll
          // scheduled there is not a refresh: read on return instead.
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') read()
        }, 5000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') read()
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        // Node-based test hosts keep the loop alive for an interval; `unref` is a
        // no-op in a browser, where the timer belongs to the page anyway.
        timer?.unref?.()
        return () => {
          mounted.current = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [adopt, refresh])

      // Every provider's catalog, flattened with its origin: the board keys models
      // by provider/model, so a bare id would collide across catalogs.
      const models = useMemo(
        () => Object.entries(catalogs).flatMap(([provider, list]) => list.map((entry) => ({ ...entry, provider }))),
        [catalogs],
      )
      const byId = useMemo(() => {
        const table = {}
        for (const entry of models) table[entry.id] = entry
        return table
      }, [models])

      const edit = useCallback((mutate) => {
        setDraft((previous) => {
          if (previous === null) return previous
          const next = JSON.parse(JSON.stringify(previous))
          mutate(next)
          return next
        })
      }, [])

      const editRoute = useCallback(
        (id, patch) => {
          edit((next) => {
            next.routes[id] = { ...(next.routes[id] ?? {}), ...patch }
          })
          if (patch.provider !== undefined) loadCatalog(patch.provider).catch(() => undefined)
        },
        [edit, loadCatalog],
      )

      const classify = useCallback(async () => {
        const text = probeText.trim()
        if (text.length === 0) {
          setNotice({ tone: 'warn', text: t('probeEmpty') })
          return
        }
        setProbeBusy(true)
        try {
          const body = await api('explain', { text })
          if (mounted.current) setProbeResult(JSON.parse(body.decision))
        } catch (error) {
          if (mounted.current) setNotice({ tone: 'error', text: String(error?.message ?? error) })
        } finally {
          if (mounted.current) setProbeBusy(false)
        }
      }, [probeText, t])

      if (snap === null || draft === null) {
        return h('div', { className: 'amr' }, h('p', { className: 'amr-sub' }, busy ? t('busy') : t('refresh')))
      }

      /**
       * Apply a tier change and re-read the board.
       *
       * Runtime-only on purpose: dragging a capsule is an adjustment, not a
       * commit, and the page has its own Save for the durable write. The host
       * recomputes the assignment, so the board the user sees next is the one the
       * router will use.
       */
      const applyTiers = async (tiers) => {
        edit((next) => {
          next.tiers = tiers
        })
        const body = await run('configure', { config: { ...draft, tiers }, runtimeOnly: true })
        if (body?.config !== undefined) {
          setSnap((current) => (current === null ? current : { ...current, board: body.board ?? current.board }))
        }
      }

      const routeIds = Object.keys(draft.routes)
      const routeOptions = routeIds.map((id) => h('option', { key: id, value: id }, id))
      const saveGlyph = glyphOf('IconCheckOutlineRegular')
      const blocked = busy || modelBusy

      return h(
        'div',
        { className: 'amr' },
        h(
          'div',
          { className: 'amr-head' },
          h(
            'div',
            { className: 'amr-headText' },
            h('h2', { className: 'amr-title' }, t('title')),
            h('p', { className: 'amr-build', 'data-amr-build': BUILD }, `build ${BUILD}`),
            h('p', { className: 'amr-sub' }, t('intro')),
            // One glance answers "is it on, what does it fall back to, how much
            // does it care about price" without scrolling to three sections.
            h(
              'div',
              { className: 'amr-summary' },
              h(Chip, { tone: snap.mode === 'on' ? 'ok' : snap.mode === 'shadow' ? 'warn' : 'error' }, `${t('mode')}: ${snap.mode}`),
              h(Chip, null, `${t('defaultRoute')}: ${draft.defaultRoute}`),
              h(Chip, null, `${t('costWeight')}: ${Number(draft.selection?.costWeight ?? 0).toFixed(2)}`),
              h(Chip, null, `${t('decision')}: ${draft.decision.model}`),
              (snap.force?.global ?? '').length > 0 && h(Chip, { tone: 'warn' }, `${t('force')}: ${snap.force.global}`),
            ),
            notice !== null && h('p', { className: 'amr-note', 'data-tone': notice.tone }, notice.text),
          ),
          h(
            'div',
            { className: 'amr-actions' },
            h(IconButton, {
              name: 'IconRefreshOutlineRegular',
              label: t('refresh'),
              onClick: () => refresh().catch(() => undefined),
              disabled: blocked,
            }),
            h(IconButton, {
              // Two refreshes sit side by side, so their tooltips share no
              // wording: this one reloads the model facts, the other the page.
              name: 'IconDatabaseOutlineRegular',
              label: modelBusy ? t('busy') : t('refreshModels'),
              onClick: () => refreshModels().catch(() => undefined),
              disabled: blocked,
            }),
            h(IconButton, {
              name: 'IconPlayOutlineRegular',
              label: t('applyRuntime'),
              onClick: () => run('configure', { config: draft, runtimeOnly: true }),
              disabled: blocked,
            }),
            // Saving is the one commit on the page, and the only action whose
            // weight belongs in words; it keeps the check glyph beside them.
            h(
              Button,
              {
                onClick: () => run('configure', { config: draft }),
                variant: 'primary',
                disabled: blocked,
                ...(saveGlyph === null ? {} : { icon: h(saveGlyph, { size: 14 }) }),
              },
              t('save'),
            ),
          ),
        ),

        h(
          Card,
          { title: t('mode'), hint: t('modeHint') },
          h(
            'div',
            { className: 'amr-row' },
            h(
              'div',
              { className: 'amr-seg' },
              MODES.map((mode) =>
                h(
                  'button',
                  {
                    key: mode,
                    type: 'button',
                    className: 'amr-segBtn',
                    'data-active': snap.mode === mode ? 'true' : 'false',
                    onClick: () => run('mode', { mode }),
                    disabled: busy,
                  },
                  t(mode === 'on' ? 'modeOn' : mode === 'shadow' ? 'modeShadow' : 'modeOff'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'amr-field', style: { minWidth: 160 } },
              h('span', { className: 'amr-label' }, t('defaultRoute')),
              h(
                Select,
                { value: draft.defaultRoute, onChange: (next) => edit((config) => { config.defaultRoute = next }) },
                routeOptions,
              ),
            ),
            h(
              'div',
              { className: 'amr-field', style: { minWidth: 160 } },
              h('span', { className: 'amr-label' }, t('force')),
              h(
                Select,
                {
                  value: snap.force?.global ?? '',
                  onChange: (next) =>
                    run(next.length === 0 ? 'clear' : 'force', next.length === 0 ? {} : { route: next, all: true }),
                },
                h('option', { value: '' }, t('forceNone')),
                routeOptions,
              ),
            ),
          ),
        ),

        h(
          Card,
          {
            title: t('tiers'),
            hint: `${t('tiersHint')} ${t('providersSeen').replace('{count}', String((snap.board?.providerOf ? new Set(Object.values(snap.board.providerOf)).size : 0)))}`,
          },
          h(TierBoard, { snap, draft, models, t, applyTiers, busy: blocked }),
        ),

        h(
          Card,
          { title: t('routes'), hint: t('routesHint') },
          routeIds.map((id) => {
            const route = draft.routes[id]
            // The route's own provider is the right place to look, but a route may
            // be anchored to an id another catalog serves; showing its facts beats
            // claiming the model is not in any catalog.
            const entry =
              (catalogs[route.provider] ?? []).find((candidate) => candidate.id === route.model) ??
              (models ?? []).find((candidate) => candidate.id === route.model) ??
              null
            return h(
              'div',
              { key: id, className: 'amr-tier' },
              h(
                'div',
                { className: 'amr-tierHead' },
                h('span', { className: 'amr-tierId' }, id),
                id === draft.defaultRoute && h(Chip, { tone: 'ok' }, t('defaultRoute')),
                route.model === '' && h(Chip, { tone: 'warn' }, t('customOption')),
              ),
              h(
                'div',
                { className: 'amr-grid' },
                h(
                  Field,
                  { label: t('maxCost') },
                  h(NumberInput, {
                    value: route.envelope?.maxCost ?? '',
                    min: 0,
                    step: 5,
                    onChange: (next) => editRoute(id, { envelope: { ...(route.envelope ?? {}), maxCost: next } }),
                  }),
                ),
                h(
                  Field,
                  { label: t('minQuality') },
                  h(NumberInput, {
                    value: route.envelope?.minQuality ?? '',
                    min: 0,
                    step: 5,
                    onChange: (next) => editRoute(id, { envelope: { ...(route.envelope ?? {}), minQuality: next } }),
                  }),
                ),
                h(
                  Field,
                  { label: t('maxLatency') },
                  h(
                    Select,
                    {
                      value: route.envelope?.maxLatency ?? '',
                      onChange: (next) =>
                        editRoute(id, {
                          envelope: next === '' ? omitLatency(route.envelope) : { ...(route.envelope ?? {}), maxLatency: next },
                        }),
                    },
                    h('option', { value: '' }, t('anyLatency')),
                    h('option', { value: 'fast' }, 'fast'),
                    h('option', { value: 'balanced' }, 'balanced'),
                    h('option', { value: 'slow' }, 'slow'),
                  ),
                ),
                h(
                  Field,
                  { label: t('reasoningEffort') },
                  h(TextInput, {
                    value: route.reasoningEffort ?? '',
                    placeholder: 'default',
                    onChange: (next) => editRoute(id, { reasoningEffort: next }),
                  }),
                ),
                h(
                  Field,
                  { label: t('description'), wide: true },
                  h('textarea', {
                    className: 'amr-textarea',
                    value: route.description ?? '',
                    onChange: (event) => editRoute(id, { description: event.target.value }),
                    spellCheck: false,
                  }),
                ),
              ),
              h(ModelFacts, { entry, t }),
            )
          }),
        ),

        h(
          Card,
          { title: t('decision'), hint: t('decisionHint') },
          h(
            'div',
            { className: 'amr-grid' },
            h(Field, { label: t('baseURL'), wide: true }, h(TextInput, {
              value: draft.decision.baseURL,
              onChange: (next) => edit((config) => { config.decision.baseURL = next }),
              mono: true,
            })),
            h(Field, { label: t('model') }, h(ModelSelect, {
              t,
              value: draft.decision.model,
              models,
              onChange: (next) => edit((config) => { config.decision.model = next }),
            })),
            h(Field, { label: t('credentialRef') }, h(TextInput, {
              value: draft.decision.credentialRef,
              onChange: (next) => edit((config) => { config.decision.credentialRef = next }),
              mono: true,
            })),
            h(Field, { label: t('timeout') }, h(NumberInput, {
              value: draft.decision.timeoutMs,
              step: 50,
              onChange: (next) => edit((config) => { config.decision.timeoutMs = next }),
            })),
            h(Field, { label: t('maxMessages') }, h(NumberInput, {
              value: draft.decision.maxMessages,
              onChange: (next) => edit((config) => { config.decision.maxMessages = next }),
            })),
            h(Field, { label: t('maxStateChars') }, h(NumberInput, {
              value: draft.decision.maxStateChars,
              step: 500,
              onChange: (next) => edit((config) => { config.decision.maxStateChars = next }),
            })),
            h(Field, { label: t('maxMessageChars') }, h(NumberInput, {
              value: draft.decision.maxMessageChars,
              step: 100,
              onChange: (next) => edit((config) => { config.decision.maxMessageChars = next }),
            })),
            h(Field, { label: t('summarizer') }, h(Select, {
              value: draft.decision.summarizer.enabled === false ? 'off' : 'on',
              options: [['on', t('on')], ['off', t('off')]],
              onChange: (next) => edit((config) => { config.decision.summarizer.enabled = next !== 'off' }),
            })),
            h(Field, { label: t('summarizerModel'), hint: t('summarizerHint') }, h(ModelSelect, {
              t,
              value: draft.decision.summarizer.model,
              models,
              onChange: (next) => edit((config) => { config.decision.summarizer.model = next }),
            })),
            h(Field, { label: t('summarizerMaxChars') }, h(NumberInput, {
              value: draft.decision.summarizer.maxChars,
              step: 100,
              onChange: (next) => edit((config) => { config.decision.summarizer.maxChars = next }),
            })),
            h(Field, { label: t('summarizerRefresh') }, h(NumberInput, {
              value: draft.decision.summarizer.refreshEvery,
              onChange: (next) => edit((config) => { config.decision.summarizer.refreshEvery = next }),
            })),
          ),
        ),

        h(
          Card,
          { title: t('policy'), hint: t('policyHint') },
          h(
            'div',
            { className: 'amr-grid' },
            h(Field, { label: t('minConfidence') }, h(NumberInput, {
              value: draft.policy.minConfidence,
              step: 0.05,
              onChange: (next) => edit((config) => { config.policy.minConfidence = next }),
            })),
            h(Field, { label: t('minProbability') }, h(NumberInput, {
              value: draft.policy.minProbability,
              step: 0.05,
              onChange: (next) => edit((config) => { config.policy.minProbability = next }),
            })),
            h(Field, { label: t('switchConfidence') }, h(NumberInput, {
              value: draft.policy.switchConfidence,
              step: 0.05,
              onChange: (next) => edit((config) => { config.policy.switchConfidence = next }),
            })),
            h(Field, { label: t('acknowledgeConfidence'), hint: t('acknowledgeHint') }, h(NumberInput, {
              value: draft.policy.acknowledgeConfidence,
              step: 0.05,
              onChange: (next) => edit((config) => { config.policy.acknowledgeConfidence = next }),
            })),
            h(Field, { label: t('modelRequestConfidence'), hint: t('modelRequestHint') }, h(NumberInput, {
              value: draft.policy.modelRequestConfidence,
              step: 0.05,
              onChange: (next) => edit((config) => { config.policy.modelRequestConfidence = next }),
            })),
          ),
          h(
            'label',
            { className: 'amr-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.switching === 'auto',
              onChange: (event) => edit((config) => { config.switching = event.target.checked ? 'auto' : 'sticky' }),
            }),
            t('switchingAuto'),
          ),
          h('p', { className: 'amr-cardHint' }, t('switchingHint')),
          h(
            'label',
            { className: 'amr-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.logDecisions === true,
              onChange: (event) => edit((config) => { config.logDecisions = event.target.checked }),
            }),
            t('logDecisions'),
          ),
        ),

        h(
          Card,
          { title: t('selection'), hint: t('selectionHint') },
          h(
            'div',
            { className: 'amr-grid' },
            h(Field, { label: t('costWeight') }, h(NumberInput, {
              value: draft.selection?.costWeight ?? 0.35,
              step: 0.05,
              onChange: (next) => edit((config) => {
                config.selection = { ...(config.selection ?? {}), costWeight: next }
              }),
            })),
            h(Field, { label: t('costWeightHint') }, h('span', { className: 'amr-note' },
              t('costWeightExplain').replace('{value}', String(draft.selection?.costWeight ?? 0.35)))),
          ),
        ),

        h(
          Card,
          { title: t('classify'), hint: t('classifyHint') },
          h('textarea', {
            className: 'amr-textarea',
            value: probeText,
            placeholder: t('probePlaceholder'),
            onChange: (event) => setProbeText(event.target.value),
            spellCheck: false,
          }),
          h(
            'div',
            { className: 'amr-row' },
            h(IconButton, {
              name: 'IconInspectOutlineRegular',
              label: t('classify'),
              onClick: classify,
              disabled: probeBusy,
            }),
            probeResult !== null &&
              h(
                'span',
                { className: 'amr-cap' },
                `${t('probeRoute')}: ${probeResult.selected?.model ?? '—'} · ${t('probeConfidence')}: ${Number(
                  probeResult.confidence ?? 0,
                ).toFixed(2)} · ${t('probeComplexity')}: ${
                  probeResult.profile === undefined
                    ? '—'
                    : `d${probeResult.profile.depth} b${probeResult.profile.breadth} r${probeResult.profile.risk}`
                }`,
              ),
          ),
        ),

        probeResult !== null && probeResult.ranking !== undefined &&
          h(
            Card,
            { title: t('probeRanking'), hint: t('probeRankingHint') },
            h(
              'div',
              { className: 'amr-row' },
              ...Object.entries(probeResult.ranking.weights ?? {})
                .filter(([dim, weight]) => weight > 0.05)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([dim, weight]) =>
                  h(Chip, { key: dim, tone: 'info' }, `${dim} ${Math.round(weight * 100)}%`),
                ),
            ),
            h(
              'table',
              { className: 'amr-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('modelCol')),
                h('th', null, 'utility'),
                h('th', null, 'quality'),
                h('th', null, 'cost'),
                h('th', null, 'why'),
              )),
              h('tbody', null,
                ...(probeResult.ranking.ranked ?? []).map((row) =>
                  h('tr', { key: row.model },
                    h('td', null, h('span', { className: 'amr-mono' }, row.model)),
                    h('td', null, String(row.utility)),
                    h('td', null, String(row.quality)),
                    h('td', null, String(row.cost)),
                    h('td', { style: { whiteSpace: 'normal', fontSize: 11 } }, (row.reasons ?? []).join(' · ')),
                  ),
                ),
              ),
            ),
            (probeResult.ranking.excluded ?? []).length > 0 &&
              h('p', { className: 'amr-note' },
                t('probeExcluded').replace('{list}',
                  probeResult.ranking.excluded.map((x) => `${x.model} (${x.reason})`).join(', '))),
          ),

        h(
          Card,
          { title: t('observability'), hint: t('stats') },
          h(
            'div',
            { className: 'amr-stats' },
            h('span', null, h('b', null, String(snap.stats.requests)), ` ${t('requests')}`),
            h('span', null, h('b', null, String(snap.stats.decisions)), ` ${t('decisionsCount')}`),
            h('span', null, h('b', null, String(snap.stats.switches)), ` ${t('switches')}`),
            h('span', null, h('b', null, String(snap.stats.fallbacks)), ` ${t('fallbacks')}`),
            h('span', null, h('b', null, String(snap.stats.errors)), ` ${t('errors')}`),
            h('span', null, h('b', null, String(snap.stats.avgDecisionMs)), ` ${t('avgMs')}`),
          ),
          (snap.agents ?? []).length === 0
            ? h('p', { className: 'amr-empty' }, t('noAgents'))
            : h(
                'table',
                { className: 'amr-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: { width: '38%' } }, t('agent')),
                    h('th', { style: { width: '16%' } }, t('kind')),
                    h('th', { style: { width: '20%' } }, t('route')),
                    h('th', { style: { width: '26%' } }, t('status')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  (snap.agents ?? []).map((agent) =>
                    h(
                      'tr',
                      { key: agent.id },
                      h('td', { className: 'amr-mono' }, String(agent.id)),
                      h('td', null, agent.kind ?? '—'),
                      h('td', null, agent.route ?? '—'),
                      h('td', null, String(agent.status ?? '—')),
                    ),
                  ),
                ),
              ),
          (snap.decisions ?? []).length === 0
            ? h('p', { className: 'amr-empty' }, t('noDecisions'))
            : h(
                'table',
                { className: 'amr-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { style: { width: '10%' } }, t('time')),
                    h('th', { style: { width: '16%' } }, t('agent')),
                    h('th', { style: { width: '12%' } }, t('route')),
                    h('th', { style: { width: '10%' } }, t('confidence')),
                    h('th', { style: { width: '14%' } }, t('source')),
                    h('th', { style: { width: '12%' } }, t('state')),
                    h('th', { style: { width: '26%' } }, t('task')),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  (snap.decisions ?? []).map((record) =>
                    h(
                      'tr',
                      { key: record.id },
                      h('td', { className: 'amr-mono' }, new Date(record.at).toISOString().slice(11, 19)),
                      h('td', { className: 'amr-mono' }, String(record.agentId).slice(-12)),
                      h('td', null, record.routeId),
                      h('td', null, Number(record.confidence ?? 0).toFixed(2)),
                      h('td', null, record.source),
                      h('td', null, record.applied ? 'applied' : snap.mode === 'shadow' ? 'shadow' : 'decided'),
                      h('td', { title: String(record.task ?? '') }, String(record.task ?? '').replace(/\s+/g, ' ')),
                    ),
                  ),
                ),
              ),
        ),
      )
    }

    /** Settings page wrapper: the slot supplies the locale-bound translator. */
    function RouterPage(props) {
      return h(RouterPanel, { t: props.t })
    }

    function installStyles() {
      if (typeof document === 'undefined' || document.getElementById('amr-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'amr-styles'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        installStyles()
        ctx.effect(() => ctx.locale.register(NS, dict))
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'auto-model-router',
          order: 60,
          label: () => t('title'),
          locale: NS,
        }, RouterPage))
        // The composer tool row is where a session-level routing switch belongs:
        // next to the model control it overrides.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'auto-model-router-toggle',
          order: 20,
          label: () => t('toggleLabel'),
          locale: NS,
        }, ComposerToggle))
      },
    }
  },
})