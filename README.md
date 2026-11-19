# @dsh-external/dsh-auto-model-router

Automatic model routing for DSH. Every model request is classified by a
**System One** decision model — any endpoint that speaks the protocol, configured
per profile — which returns a *capability profile* of the work, and the router
then scores every model the harness serves against that profile. Subagents are routed the same way: a
child's first request is classified from its own delegated task, so it no longer
inherits the parent's model just because it inherited the parent agent.

Routing is not a three-way split. Two models in the same price band can fail in
opposite directions — one has the coding scores but no vision, the other reads
screenshots but cannot hold a refactor. A tier name cannot express that, so the
tier is only a pinning device; the decision is arithmetic over measured
capability.

## How it works

```
user message ──► agent/inbox/inserted   pre-select: the previous decision applies
                    │                   to the step this message opens
                    ▼
                agent loop step
                    ├─ agent/inbox/claimed       capture the step's new messages
                    └─ system-prompt/assemble    System One → task profile (one forward pass)
                          shape · depth · breadth · risk · intent · vision · tools · latency
                          then: pick the tier, rank the models inside its envelope,
                          and record the winner with agent.model.select()
```

Routing happens in two places because the harness fixes a step's model before
any plugin sees it:

- `agent.model.select()` is the only supported way to move an agent between
  models, so assembly records the decision rather than rewriting the request.
  The selection is durable — it is a `model/selection` event on the session, so
  a resumed session continues on the routed model.
- Because the selection lands *after* the step that produced it, a message
  arriving at an idle agent gets the route decided by the previous step. That is
  exact for a continuation (`continue`, `ok`) and self-correcting otherwise: a
  fresh request is decided at its own assembly, one step before it is served.

Harness-injected messages are filtered out of the decision input: the
environment block, the system prompt, and the notice that a previous turn ran on
another model. That last one is not decoration — it names the models it switched
between, so reading it as the request lets the router answer its own output: the
notice scores as a task about a model, the next switch writes another notice.
With the notice excluded, a step that carries only it reuses the decision that
caused the switch, and routing stays put.

Both hooks are registered at the host root and declared `prepend`, so they run
outermost and win over the UI model-selection listener. The scope chain of
`dsh-scope` admits root listeners for every agent, which is why one plugin
routes the main agent and every subagent without per-agent wiring.

### The session digest

The decision model sees the *task*, not just the step. Recent messages ride
along verbatim, and in front of them sits a digest of the whole session written
by a cheap model (`qwen3.8-flash` by default):

```
GOAL  the user's objective, not the current step
DONE  completed work, with the files or areas touched
NOW   the step in progress and what it is trying to establish
RISK  the mistake that would hurt, and the constraint that must hold
```

Without it a one-line edit inside a half-finished migration is indistinguishable
from a one-line edit on a fresh request, so the profile — and the tier it
selects — follows the slice instead of the work.

The digest is incremental: each refresh receives the previous digest plus only
the messages since the last pass, so it updates a document instead of re-reading
the session from scratch, and it stays stable across steps rather than drifting.
Three rules keep it out of the critical path:

- **Never blocking.** A stale digest is returned immediately and refreshed in
  the background. Only the first digest of a session is awaited, and only for
  1.2 s; whatever the summarizer produces later is still cached.
- **Bounded.** The digest is capped at 900 characters and at a third of
  `maxStateChars`, so it cannot crowd out the messages being routed.
- **Cheap by construction.** The summarizer runs with thinking disabled: on a
  46k-character transcript, thinking on spends its budget deliberating and misses
  the deadline, while thinking off answers in ~2.2 s. If an endpoint rejects that
  parameter the call is retried without it.
- **Non-fatal.** A failed summary keeps the previous digest; the decision then
  proceeds on the recent messages alone. `status` reports the digest model and
  how many passes have run, and the settings page carries its model, budget,
  refresh interval and an on/off switch.

### The task profile

The decision model answers seven typed questions, never text:

| question  | type   | meaning |
| --------- | ------ | ------- |
| `shape`   | choice | what kind of work it is: `lookup` `edit` `implement` `debug` `refactor` `design` `review` `test` `docs` `analyze` `inspect` |
| `depth`   | score  | 0-4 reasoning depth of the *hardest* step |
| `breadth` | score  | 0-4 how much code or context must be held at once |
| `risk`    | score  | 0-4 cost of being wrong |
| `intent`  | choice | what the message asks for: `acknowledge` `resume` `work` |
| `model`   | choice | which model the user asked for, or `auto` |
| `modelRequest` | noul | how sure the model name is a request vs a mention |
| `vision`  | noul   | must pixels be read (screenshot, diagram, chart) |
| `tools`   | noul   | are tool calls required rather than prose |
| `latency` | noul   | is the user waiting interactively |

Each shape carries its own dimension weights, and the profile adjusts them. A
shallow implementation is an execution problem (speed rises, reasoning falls); a
deep one is a thinking problem (reasoning rises); wide breadth pulls long-context
up; high risk sharpens whatever the shape already cares about most. That is what
makes `implement depth 1 breadth 1` and `implement depth 3 breadth 3` pick
different models even though both are "implement".

### Scoring

Every routable model in the provider catalog is a candidate. For each:

```
quality  = Σ(weight × capability score)      normalized over the weighted dims
floor    = 36 + 9 × risk                     "good enough for these stakes"
cost     = log-scaled blended price          2 output tokens per input token
utility  = min(quality, floor)               full credit up to the floor
         + surplus × (0.30 + 0.15 × risk)     headroom pays only as risk rises
         − costWeight × (1 + (4−risk)/4) × 0.4 × cost
         − max(0, floor − quality) × (1.5 + 0.8 × risk)
         − (1 − evidenceConfidence) × risk × 7
         − unverifiedWeight × (3 + 2 × risk)
```

Two ideas carry most of the behavior. **Capability above the floor is worth less
than capability below it**, so an adequate cheap model beats an overqualified
dear one on easy work — but the surplus rate climbs with risk, so a risky
migration genuinely buys headroom. And **a dimension we never benchmarked is a
guess**, so unverified weight on the decisive dimension is charged for; a model
cannot win by looking strong on an axis nobody measured.

Hard requirements filter first and are not negotiable: vision when pixels are
required, tool calling when tools are required, a 200k+ window when long context
is weighted, never a retired id. `vision` uses a 0.6 threshold rather than 0.5,
because a false positive removes every text-only model from the pool.

Ties break toward more benchmark evidence, then lower cost, then id — a router
that changes its mind on identical input is untestable.

### Tiers are envelopes

A tier is a ceiling on what the router may buy, not a pinned model. Each tier
declares three things, all optional:

| Field | Meaning | Shipped fallback (`fast` / `balanced` / `deep`) |
|---|---|---|
| `maxCost` | cost index the tier will not exceed (0-100, log-scaled price) | 55 / 85 / 100 |
| `maxLatency` | slowest latency class tolerated (`fast` < `balanced` < `slow`) | `fast` / `balanced` / `slow` |
| `minQuality` | measured quality a model must reach | 40 / 55 / 66 |

Those fallbacks are only what an unconfigured profile starts from. When the
operator leaves an envelope unset, the plug-in replaces its cut-offs with
ceilings derived from the measured catalog (`fast` 68, `balanced` 79, `deep` 100
cost; quality floors 28 / 33 / 35 in the shipped data), so a tier describes the
pool it is fitted on instead of a catalog that no longer exists.

The profile chooses the tier by demand — `0.35 × depth + 0.15 × breadth +
0.5 × risk`. An interactive turn is pulled down to `fast` only while the work
really is small: low risk **and** shallow. Either alone is not enough, which was
learned the hard way — capping demand for every `latencyCritical` turn sent a
paused migration to the cheapest model in the pool because "Continue" scores
shallow risk while being deep work, and a wrong fast answer costs more than a
slow capable one. Interactive work still prefers faster models, through the
speed weight in the ranking rather than by collapsing its tier.

### Capability decides membership; the envelope is the guardrail

A tier also says *how hard the work is*, so membership is not "the cheapest
envelope that fits": models are ranked by measured composite capability and the
pool's thirds form the three bands. The envelope then guards that grade — a model
whose cost index or latency class exceeds its band's ceiling moves one band up,
because a cheap tier cannot buy an expensive or slow model; one band is the
coverage the envelope promises, so a model still rejected there (and anything
above `deep`'s ceiling) is off rather than routed by a budget that cannot pay
for it. The quality floor still applies to the `cost` criterion and to the
selector inside a tier.

On the shipped catalog snapshot (64 measured entries, one entry per model) that
places 2 models in `fast`, 6 in `balanced`, and 9 in `deep`; 7 are unmeasured,
25 are off with a reason, and 15 duplicate endpoints are collapsed by model into
the capsule that represents it. Counts move with the catalog, so `status` reports
the lanes it actually computed.

Two rules keep an envelope from becoming a trap. A model with no quality
measurement cannot clear a quality floor, because it cannot prove it does. And
if the chosen tier admits nothing, selection widens to the default route's tier
and then to the unfiltered pool, recording `envelopeWidened` in the decision log
so an over-tight envelope shows up as a fact instead of a silent fallback.

The tier's `model` field remains as an **anchor**: it is what `force` pins, what
the error path falls back to, and the label the tier menu carries. It never
overrides the ranking.

### Safety

1. A model the LLM runtime rejects falls back to the default route, then to the
   request's original config. Routing never breaks a turn.
2. `force` pins an agent (or every agent) to one tier, bypassing the ranking.
3. If the provider catalog is unavailable the pool degrades to the configured
   tiers, so a catalog outage is not an outage.
4. `mode: shadow` records decisions without applying them.
5. If the summarizer is unreachable or slow, the decision runs on the recent
   messages with the last digest it had — the digest is an improvement to a
   decision, never a precondition for one. `status` reports how many passes ran
   and how many failed, and `digest` returns the current summary itself.

## Layout

- `src/decision.js` — System One client, transcript→state builder, the seven
  profile questions, and answer parsing.
- `src/select.js` — capability-based selection: dimension weights per shape,
  profile adjustments, utility scoring, hard requirements, ranking.
- `src/model-info.js` — lookup helpers over the knowledge base (family fallback
  for dated ids, provider aliases, prompt and UI formatting).
- `src/model-info-data.json` — the knowledge base itself: per model, 0-100
  scores for `overall coding reasoning math knowledge agentic longContext vision
  speed`, the benchmark sample count behind each, price, context, modalities,
  qualitative fit, and source URLs. Regenerate rather than hand-edit.
- `src/index.js` — plugin wiring: hooks, route catalog, per-agent state,
  `model_router` tool, provider-catalog merge, and the JSON endpoint the
  config page talks to.
- `src/client.js` — browser half: the Settings → **Auto Model Router** page.
- `lib/` — generated by `npm run build` (a plain copy; the host loads only these files).
- `locale/en.json`, `locale/zh.json`, `icon.svg` — plugin display metadata.

The runtime is dependency-free on purpose: an injected package is linked into
the profile and must not need peer resolution. `inject = ['tools']` only.

## Install

```bash
npm run build
# then, in a DSH session with the super-injector:
#   dev_inject_plugin <path-to-plugin>/dsh-auto-model-router
```

Runtime config is passed by the loader. Nothing in the defaults names a vendor:
`decision.baseURL`, `decision.model` and (optionally) `decision.credentialRef`
start empty, and an unconfigured router stays inactive — it logs that once and
leaves every agent on the model it started with instead of calling some
service you did not ask for. Point it at any endpoint that speaks the protocol:

```yaml
decision:
  baseURL: https://your-endpoint/v1   # POST {baseURL}/systemone
  model: your-decision-model
  credentialRef: YOUR_API_KEY_ENV     # omit for an endpoint that takes no key
```

Routes are the *pinning* frame, not the decision space. Three ship by default,
each an envelope with no provider and no model; the selector picks the model and
draws from every provider the harness exposes:

| route      | envelope (cost ≤ / latency ≤ / quality ≥) | role |
| ---------- | ---------------------------------------- | ---- |
| `fast`     | 55 / fast / 40   | cheapest capable; the pool's floor |
| `balanced` | 85 / balanced / 55 | strongest measured reasoning per yuan |
| `deep`     | 100 / slow / 66  | evidence-backed ceiling |

A route may name a `provider` and `model` to pin its tier to one deployment; that
is what `force` and `defaultRoute` use. Leave them unset and the tier is decided
purely by measurement — and the pool then spans every provider the harness
exposes, because a router that only sees one catalog is a catalog feature. Pin
any tier to a provider and the pool narrows to that provider: naming one
deployment is an instruction, not a limitation of the selector.

### Tiers assign themselves

Nobody assigns models to tiers by hand. The assignment is computed on the host
and shipped in the config snapshot, so the page and the router always agree about
who is where. It is **model-level**: the same model advertised by several
providers (or resellers, or a `-highspeed` serving variant) gets one capsule,
represented by the best endpoint (fastest latency, then most evidence, then
cheapest); the other endpoints are in the capsule's endpoint count instead of
filling a second lane.

Every auto-off model carries the reason the board can show:

| lane | why the model is there |
|---|---|
| `off` — withdrawn | the catalog marks it retired/deprecated, or gives it a sunset date; the operator can still drag it back |
| `off` — superseded | a newer measured generation replaces it: the same line with the same date identity, or a newer generation when either side has no product-variant words (`v3.2` → `v4.1-flash`). A materially weaker or same-generation-much-dearer model is not a replacement; the card names both versions |
| `off` — no envelope | its capability band's cost/latency guardrail rejects it and no deeper band admits it (the card lists the failing fields) |
| `off` — dominated | a same-family model in the same budget is measurably stronger and at least ten cost points cheaper |
| `off` — switched off | the operator clicked it |
| `unmeasured` | no measurement, or too thin a profile to compare |

Superseding only compares like with like: the line is the family plus its size
and product tier words, and a release date is part of the model's identity, so
`-1017` and the undated alias are two models, and `flash` is not a version of
`max`. The same rule keeps a *newer* generation from being pruned by an older,
cheaper sibling.

The settings page shows the assignment as a board of **capsules**:

| gesture | effect |
|---|---|
| hover a capsule | price, capability bars, context, latency, cross-checks |
| drag a capsule to another tier | a per-model override; the board marks it `hand-assigned` |
| click a capsule | switch that model off (it leaves the routing pool; shown under `off`) |
| "Follow auto" in the capsule popover | drop the override and let the computation place it |
| "Reset board to automatic" | drop every override and every disabled model |
| the **Providers** menu | tick one or more catalogs to show; nothing ticked shows all |

A model is switched off automatically when another model **of the same family**
(`deepseek*`, `qwen*`, `glm*`, `kimi*`, …) is measurably stronger *and* at least
ten cost-index points cheaper. Under capability bands this is scoped to the same
tier (a cheaper sibling belongs one band down by design) and compares the
capability grade the bands use; the `cost` criterion keeps the cross-tier,
conservative-basis rule. The comparison is deliberately inside a family: a
cheaper Qwen is not a replacement for a DeepSeek, and disabling one vendor because
another vendor's model wins would turn a router into a vendor ranking. Reseller
prefixes (`cmaas-`, `vanchin/`, `siliconflow/`) resolve to the family underneath.

`tiers.mode: manual` routes only what is assigned explicitly — an unassigned model
stays out rather than being guessed at. The same data is on the `model_router`
tool (`status` prints the lanes; `configure` accepts `tiers`).

### Where the measurements come from

`refresh` (the button on the config page, or `POST /dsh-auto-model-router-api`
with `{"action":"refresh"}`) walks five sources and merges them into
`data/model-info-runtime.json`:

| source | what it contributes |
|---|---|
| CompassRank | benchmark spreads per capability dimension |
| BenchGecko | per-model capability samples |
| Epoch ECI | a fitted capability index, recorded as a cross-check |
| llmleaderboard | measured serving speed and TTFT, independent benchmarks |
| **Artificial Analysis** | an intelligence index, USD prices, TTFT/output speed, and per-benchmark scores for ~280 models |
| **OpenRouter** | real weekly usage ranking: which models actually serve traffic, with 7-day token volume (`/api/frontend/v1/models/find?order=top-weekly`, no key) |

Identity joins apply one rule (a date is part of the model, a serving variant is
not), and sources that spell a model differently are mapped in
`data/model-aliases.json` — data, not code, so the engine carries no model names
and every alias is honoured by the same name guard. A missing alias leaves the row
unmatched rather than attaching it to a guess.

Artificial Analysis is scraped, not called through its API: the documented
`/api/v2/*` endpoints now require a key, while `/leaderboards/models` ships the
whole table inside its Next.js RSC stream. `scripts/scrape-artificialanalysis.mjs`
decodes that stream with plain `fetch` — no browser — and `src/refresh.js` does
the same at run time, which a Playwright dependency could not do inside the host.

Two rules keep the merge honest. Its intelligence index is not a 0–100 score, so
it is mapped through a linear fit against the models both sources measured; and
the merge only fills what the catalog is missing — a measured quality or price is
never overwritten. Models the catalog has never described but the provider
advertises get an entry built from the AA row (dimensions mirroring the composite
with evidence 0), which is how previously unroutable ids become placeable.

Prices from AA are USD; the catalog stores CNY, so they convert at one stated
rate (`CNY_PER_USD`, 7.2).

### Usage is a bias, not a measurement

OpenRouter's weekly ranking records `usage: {rank, tokens, share, percentile}` on
each matched entry. The selector adds
`selection.usageWeight × ((percentile − 50) / 50) × 3` utility points — at the
default weight of 0.5 that is ±1.5 points, enough to break a near-tie in favour of
the model production already runs, and not enough to outrank a real capability
gap. `usageWeight: 0` disables it. It is deliberately kept out of the capability
composite: popularity says a model is exercised, not that it is better.

### The composer switch

`Auto` sits in the chatbox tool row next to the model control. Clicking it opens
the three states — **on**, **observe**, **off** — and each choice goes through the
same host call as the tool, so the page, the chip and `status` cannot disagree.

`shadow` (`observe`) is the safe default for a profile that is being set up: the
decision model still runs, the tiers are still computed and logged, and no
session ever moves.

### Sticky by default

A session routes once, at its start, and then keeps that model. `switching:
sticky` is the default because a mid-task switch discards the prompt cache and
the style the turn began in, and a session that keeps changing models is harder
to reason about. The decision model still runs at every step — `status` shows
both the session's route and what routing would have chosen (`applied` versus
`decided` in the log) — but the selection only moves when the request itself asks
for a model (`use X for this`) or when a pin is in effect (`force`). Set
`switching: auto` to re-route every step.

A session that was already placed on a model by hand keeps it, including after a
restart: the commitment is the `model/selection` event on the session, compared
against the agent's configured default so the startup write does not count as a
choice. Switching models in the UI is therefore an instruction the router obeys
instead of overrules on the next step.

The previous defaults (`deepseek-v4-flash-0731`, `deepseek-v4-pro-0813`) are
retired provider ids: the catalog no longer offers them, so the plugin ships
tiers it can actually route to. The knowledge base marks both entries
`retired` so a stale config still renders with an explanation instead of
failing quietly.

Modes: `on` routes, `shadow` decides and records without changing the route,
`off` disables. The default is `shadow`; switch at runtime from the config page
or with the `model_router` tool (`action=on`).

## Config UI

The plugin ships a browser half, so it appears as a settings page:
**Settings → Auto Model Router** (`settings.section`, id `auto-model-router`).
The page edits the live router and saves through the profile's config editor:

| control | effect |
| ------- | ------ |
| Mode `on` / `shadow` / `off` | segmented control, applies immediately |
| Default route | the tier used when a decision is rejected or missing |
| Force route | pins every agent to one tier until cleared |
| Route tiers | provider, model, description and reasoning effort per tier |
| Provider models | every advertised model with cost and capabilities; `Assign to tier` copies one into a route |
| Decision model | `baseURL`, `credentialRef`, `model`, `timeoutMs`, state bounds |
| Confidence policy | `minConfidence`, `minProbability`, `switchConfidence` |
| Log decisions | record every decision at info level |
| Classify | dry-run the decision model on pasted task text |
| Stats / live agents / recent decisions | read-only observability |

### Design

The page is assembled from this build's own frontend artifacts, so it renders
as part of the settings panel rather than as a foreign page. Each input to that
assembly can be re-derived:

**1. Controls come from the platform.** `Button`, `Tag`, `StateDot` and `Input`
are taken from `@deepseek-ai/dsh-client-ui-primitives`, one of the eleven
modules the shell's seed table exposes to a client bundle (alongside `react`,
`react-dom`, `zod`, `@deepseek-ai/dsh-client-ui-slots` and the store). Their
appearance, focus ring and light/dark behaviour are the platform's, and they
upgrade with it. Prop contracts were read from official call sites: `Button`
takes `variant: "primary" | "outline" | "ghost"` with `size: "sm"`, `Tag` takes
`tone: "neutral" | "info" | "success" | "warning" | "danger"`, and `Input`'s
`onChange` receives an event whose `target.value` is the new text. The kit's
`StateDot` is not used: it animates while it reads `ongoing`, and a
configuration page reports state with tone and wording instead. Each is guarded by a local fallback, so a renamed export degrades the
control instead of crashing the section.

**2. Variables come from the theme.** Every `var()` names a `--dsw-*` token
declared by `dsh-client-ui-theme`; colors use the `--dsw-alias-*` alias layer,
which is the semantic layer that follows the light and dark switch. A token the
theme does not declare renders as nothing, so the whole set is pinned by test.

**3. Metrics are copied from the closest official page.** The plugin-inventory
settings block is the same kind of page — a list with state and actions — so its
measured rules transfer directly: `.5px` hairlines rather than 1px,
`--dsw-alias-settings-card-fill` and `-stroke` for card surfaces,
`--dsw-radius-xl` for their corners, 13px/20px body text, `gap:14px` between
stacked blocks, and `font:inherit` on controls.

**4. Width is fluid.** The settings shell's `.options` column is the only scroll
container and supplies `padding:0 24px 24px`; a section receives just `close`
and no title of its own. The page therefore uses `width:100%` with a
`max-width:760px` cap for line length, which holds at any window size.

The header carries the current mode, default route, `costWeight`, decision model
and any global `force` pin, so the state you open the page to check is visible
without scrolling, and mode is shown by the chip's tone.

Two test files hold the arrangement in place:

- `tests/client-styles.test.mjs` reads the source and fails on a class the
  markup uses but no rule defines, a `var()` that is not a declared `--dsw-*`
  token, a font family other than `var(--dsw-font-family)`, a literal color, a
  1px hairline, and any drift from the inventory metrics or the fluid width.
- `tests/client-render.test.mjs` mounts the **built** `lib/client.js` under a
  `__ModuleLoader__` shim in jsdom with `react-dom/client`, then asserts the
  section registers, the page reaches its loaded state, its tier rows and
  controls exist, no animated indicator is present, and the injected stylesheet
  keeps the theme contract. It is a
  structural regression lock on the shipped artifact; pixels, layout and theme
  switching are outside its scope.

Model pickers are driven by the live provider catalog (`llm.listModels`), not
by a hardcoded list: options show `id — ¥in / ¥out · ctx`, group
non-routing models (audio, video, embeddings, the decision model itself)
separately, and mark `retired`, `preview`, and advertised-but-unconfigured
ids with chips so a stale or unusable tier is visible at a glance.

Two buttons, on purpose:

- **Apply runtime** changes the running process only.
- **Save config** persists the complete raw config to the profile patch, then the
  Loader reloads the entry — so it survives restart. When the running entry is a
  development injection rather than a profile-bundle row, the page says so and
  stays runtime-only.

The page and the tool share one operation surface (`runAction`): the page POSTs
to `GET/POST /dsh-auto-model-router-api` with the same `action` values the tool
takes, so the two callers cannot drift apart. The endpoint requires the same
browser session as the Web UI (cookie) and answers JSON.

## The `model_router` tool

| action | effect |
| ------ | ------ |
| `status` | routes, live agents and their current route, counters, recent decisions |
| `config` | the full configuration as JSON |
| `catalog` | every model the provider advertises, each with price, context and capability notes from the knowledge base |
| `explain` | classify `text` with the decision model without routing |
| `force` | pin `route` for the caller, or `all=true` for every agent |
| `clear` | remove pins and the route-validation cache |
| `on` / `shadow` / `off` / `mode` | set the mode |
| `configure` | replace routes, decision endpoint and policy: the same operation the config page's **Save config** performs |

### Tiers order their pool differently

Ranking the whole pool by one cost weight makes the tiers cosmetic: with
`costWeight: 0.35` the utilities of the top candidates sit within three points
of each other (`deepseek-v4.1-flash-1017` 60.4, `qwen3.7-max` 57.5), so the same
model won whether the request was labelled `balanced` or `deep` — measured, then
fixed. Each tier now weighs cost for its own purpose: `fast` 1.6×, `balanced`
1×, `deep` 0.05×, because choosing `deep` is the operator saying price is not
the reason for the call. Live behaviour after the change:

| request | source | intent | tier | model | quality | cost index |
|---|---|---|---|---|---|---|
| `thanks` after a finished task | decision model | acknowledge | fast | qwen3.8-flash | 72.3 | 33 |
| `ok` after a finished task | decision model | acknowledge | balanced | qwen3.8-flash | 72.3 | 33 |
| `continue` on an unfinished migration | decision model | resume | deep | qwen3.7-max | 74.3 | 85 |
| rename a variable | decision model | work | balanced | qwen3.8-flash | 63.1 | 33 |
| migrate every caller | decision model | work | deep | qwen3.7-max | 74.3 | 85 |
| `use qwen3.7-max for this` | the request itself | work | — | qwen3.7-max | 74.3 | 85 |

Every tier costs one decision call now: intent comes back from the same request
that scores the work, so an acknowledgement saves the *tier*, not the call. That
is the price of letting the model judge instead of matching words.

`selection.tierCostFactor` in the config overrides those three factors.

### The decision model judges intent, including what it cannot score

Two judgements cannot be derived from shape/depth/breadth/risk, so they are asked
directly and answered by the same model:

- **`intent`** — `acknowledge`, `resume`, or `work`. `acknowledge` means nothing
  is asked and nothing is in flight; `resume` means carry on with the work in
  progress; `work` means something specific is requested. Only a confident
  `acknowledge` prices a turn at zero (depth/breadth/risk all 0, `fast` tier). A
  bare "ok" after tool calls is `resume` in the model's reading, and "resume"
  keeps the profile the model scored, so a paused migration is not repriced by
  the word "ok".
- **`model` + `modelRequest`** — the model may be asked for by name. `model`
  names it, and `modelRequest` answers the separate question of whether the
  message is *asking* for it; both must hold. Measured on this model, explicit
  requests score 0.94–0.98 while the same ids quoted from a log line or config
  snippet score 0.20, so a name in prose is not an override.

Whether a short message means "stop" or "keep going" depends on what the session
is doing, which is exactly what a prompt with the digest in front of it can
decide and a word list cannot. Measured against a real digest:

| session state | message | intent | tier chosen |
|---|---|---|---|
| all 9 callers converted, suite green | `thanks` | acknowledge | fast |
| all 9 callers converted, suite green | `ok` | acknowledge, under the floor | balanced |
| 3 of 9 converted, transaction wrapper missing | `continue` | resume | deep |
| 3 of 9 converted, transaction wrapper missing | `ok` | resume | deep |

An earlier version hard-coded acknowledgement words and put `continue` and
`继续` in that set, which routed a resumed migration to the cheapest model with
no API call at all. Nothing in the router matches those words now.

The two floors are operator parameters, in the config under **Confidence policy**: `policy.acknowledgeConfidence` (how sure the model must be that a turn
is only an acknowledgement) and `policy.modelRequestConfidence` (how sure that a
named model is a request rather than a mention). Their defaults are
`ACKNOWLEDGE_MIN_CONFIDENCE` and `MODEL_REQUEST_MIN_PROBABILITY`, and
`MODEL_REQUEST_MIN_CONFIDENCE` stays fixed because a wrong model name is a wrong
model, not a judgement call.

An explicit request outranks every heuristic in the router, and `explain` reports
it as `source: requested` alongside `intent` and `requestedModel`.

When the model itself wants a different model — or the user says so without the
router noticing — the tool has an override that does not depend on inference:

| call | effect |
|---|---|
| `force route=deep` | pin this agent to the `deep` tier |
| `force route=qwen3.7-max` | pin this agent to that exact model (`source: pin`) |
| `force route=qwen3.7-max turns=1` | same, but expires after the first decision |
| `force route=deep all=true` | pin every agent |
| `clear` | drop every pin |

A route id and a model id share one argument: a name that matches a route pins
the tier, anything else is checked against the routable pool and pinned as
`model:<id>`. The pin is visible in `status` (`force: global=model qwen4-max`).

### Reading the digest

`model_router` with `action: "digest"` returns the summary the decision model is
currently reading, plus which sessions have one. Without an agent context (the
settings page, a call the harness makes itself) it reports the newest digest,
labelled with its session id.

## The decision prompt

The state the decision model sees is assembled from two parts:

1. **Routing context** — a `[router]` header line the transcript cannot show:
   agent kind (main/subagent), whether the step is steered, and the tool names
   the agent can call. Two agents with identical user text but different tool
   access are different routing problems. Runtime-context messages are dropped
   and the character budget keeps the *newest* turns, because the newest message
   is the request being routed.
2. **The transcript** — the last `maxMessages` turns, each flattened to one
   role-labelled line with tool calls and results summarised, clipped per
   message and in total.

Each question carries its options as descriptions, because that prose is the
only thing telling the model what an answer means:

- `shape` — 11 archetypes with one-line hints, plus instructions on the
  boundaries that actually get confused (edit vs implement, debug vs review,
  design vs implement).
- `depth`, `breadth`, `risk` — five anchored levels each; list position *is* the
  score, and the anchors are fixed reference points so scores stay comparable
  across requests instead of drifting with the conversation.
- `vision`, `tools`, `latency` — `noul` probabilities.

Calibration against the live decision model (`costWeight` 0.35) and the 14-model
pool the provider advertises:

| task | profile | routed to |
| ---- | ------- | --------- |
| what does the read tool do? | docs, depth 2.1 | `deepseek-v4.1-flash-1017` |
| bump the version in package.json | edit, depth 1.0, risk 2.2 | `deepseek-v4.1-flash-1017` |
| add a `--json` flag | lookup, depth 2.3 | `deepseek-v4.1-flash-1017` |
| pagination across host+client | implement, depth 2.8, breadth 3.0 | `deepseek-v4.1-flash-1017` |
| scheduler deadlocks; find the cause | debug, depth 3.3, risk 2.5 | `deepseek-v4.1-flash-1017` |
| event-model design | design, depth 3.1 | `deepseek-v4.1-flash-1017` |
| read one file, no reasoning | lookup, depth 0.5 | `qwen3.7-flash` |
| summarize a long document | docs, breadth 3 | `qwen3.7-flash` |
| migrate every session record (risk 4) | refactor, depth 4 | `qwen3.7-max` |

One result deserves saying plainly: on this catalog `deepseek-v4.1-flash-1017`
wins most coding-shaped work, because the merged data says it is both the
cheapest option at ¥2/¥8 per 1M and near the top on measured reasoning and
agentic ability. That is the router working, not the router collapsing — the
spread appears where the profile implies it should, and `costWeight` moves it:

| profile | `costWeight` 0 | 0.35 | 0.7 | 1.0 |
| ------- | -------------- | ---- | --- | --- |
| trivial edit | `qwen3.7-max` | `qwen3.7-flash` | `qwen3.7-flash` | `qwen3.7-flash` |
| risk-4 migration | `qwen3.7-max` | `qwen3.7-max` | `qwen3.7-max` | `qwen3.7-max` |

At `costWeight` 0 price is ignored and the strongest model wins the trivial edit;
at any sane setting the cheap one does; and no setting lets a cheap model take a
risk-4 migration.

## Where the numbers come from

Scores are 0-100 per dimension, merged from two independent leaderboard passes.
Two further boards are recorded as cross-checks. All four are refreshed together,
either by `scripts/build-model-info.mjs` or by the **refresh model data** button
on the settings page:

1. **[BenchGecko](https://benchgecko.ai)** — `/api/v1/models/<slug>` gives
   per-benchmark results (SWE-bench, ARC-AGI, GPQA, AIME, LiveBench, Aider,
   APEX-Agents, HLE, …) with a category label each; averaging by category
   reproduces BenchGecko's own published scorecard exactly. Raw responses are
   kept in `data/benchgecko-raw/`.
2. **[OpenCompass CompassRank V3.0](https://rank.opencompass.org.cn/leaderboard/llm)** —
   the SPA loads two boards from its CDN, captured in
   `data/compass-rank-2026-11-18.json`:
   - the **official ability board** (`/assets/lm/data-lm-ability_official.json`):
     overall plus knowledge / abstraction / reasoning / interaction / safety /
     agent, each with sub-dimensions;
   - the **benchmark board** (`/assets/lm/data-lm-ability_benchmark.json`):
     SWE-bench Pro Verified, Terminal-Bench 4.0, OC-Turnkey, OC-WorkFlowBench,
     GDP.pdf, Terminal-Bench-Science, EESE, OC-KnowScope, HLE-Diamond.

   That board is refreshed daily and its API lives under
   `/gw/opencompass-be/api/v1/` (the SPA's `/api/…` paths are page routes, an
   easy way to waste an afternoon). Vendor cards and Bailian pricing supply
   context, output limits, modalities and cost. `CHECKED_AT` dates the pass.

Cross-checks, recorded per model but never averaged into the scores:

3. **[Epoch Capabilities Index](https://epoch.ai/eci)** — `data/eci_scores.csv`.
   ECI is an interval scale fitted across benchmarks (currently ~140-175), so it
   orders models without being comparable to a 0-100 percentage. Shown as
   `ECI <n>`.
4. **[llmleaderboard.com](https://llmleaderboard.com)** — two things: the
   measured serving data from `api/models/comparison.csv` (time to first token,
   output tokens/second, fastest offer per model), and independent benchmark
   scores. Its JSON API only serves `hle` and a top-five board, so the remaining
   boards are read from the server-rendered pages: each table row carries
   `data-benchmark-model` and `data-score`, and one track per board is kept
   (`terminal-bench-4-0`, `livebench-2-coding`, `deepswe-v1-1`,
   `gpqa-diamond-aa`, `gdp-pdf-aa`, `livebench-2-agentic`,
   `livebench-2-reasoning`). Shown as `LB <boards>` and `<n> tok/s`.

### Refreshing from the page

The settings page has a **refresh model data** button. It runs the same two
fetches and the same merge as the build script, then writes
`data/model-info-runtime.json` and swaps the catalog into memory, so scores,
prices and cross-checks update without a rebuild or a restart. The bundled
`src/model-info-data.json` stays as the baseline; the runtime file wins when
present. Delete it to fall back to the committed capture. A refresh takes about
20 seconds (17 BenchGecko requests dominate) and reports its per-board counts in
the page notice line alongside any source that failed.

### Merging two scales

The two passes do not share a scale — CompassRank's frontier sits near 78
average, BenchGecko's near 68 — so averaging the numbers directly would import
one board's generosity into every score. Instead:

1. Each CompassRank dimension is assembled from the table that measures it:
   `coding` = SWE-bench Pro + programming average; `reasoning` = reasoning +
   abstraction; `agentic` = agent board + Terminal-Bench + knowledge work;
   `knowledge` = knowledge + science; `math` = quantitative reasoning.
2. It is aligned per dimension by the **median** score gap on models both
   sources measured (median, not mean: with four overlap points one outlier
   owns a mean), falling back to the overall gap when fewer than three pairs
   exist.
3. The aligned value is blended by sample count, with the CompassRank pass
   contributing one pseudo-sample, and the result is re-clamped to the
   composite band so one sub-dimension cannot leapfrog a model's own average.

Three honesty rules apply throughout:

1. **Bayesian blend.** A dimension with *n* benchmark samples is
   `(n·observed + 1.5·prior) / (n + 1.5)`. Many samples means the evidence
   speaks; none means the prior does, and the sample count travels with the
   score.
2. **Shrinkage toward the composite.** A single dimension is capped at
   `overall + 14` and floored at `overall − 35`.
3. **Every unmeasured dimension is charged for** at selection time, so a model
   cannot win a task on an axis nobody benchmarked.

Known gaps, stated rather than papered over: `qwen4-max` has CompassRank's
ability board but not its benchmark board yet, so its coding score is still a
prior; `deepseek-v4-flash` and `qwen4-max-preview` have neither and remain
prior-only; `qwen3.6-flash`, `qwen3.7-flash` and `qwen3.7-plus` are absent from
both 2026 boards, so their scores come from older BenchGecko samples; vision
quality is not measured by either source beyond modality, so image tasks are
filtered rather than ranked on visual accuracy. `safety` and `interaction` from
CompassRank are recorded in `crossChecks` but deliberately not routed on — they
describe conduct, not capability.

## Verify

```bash
npm test
```

Unit tests cover the state builder (runtime-context filtering, tail-preserving
budgets, steering, routing-context header), the seven profile questions, System
One parsing (choice/score/noul, the double-normalization trap, missing answers),
the selection engine (hard requirements and exclusions, utility ordering,
capability-floor behaviour), the System One request contract with a mocked
fetch, and the knowledge base (required fields, 0-100 score ranges, source URLs,
dated-id family lookup, compact notes).

The config page itself is verified through the live Client slot (settings
section `auto-model-router` active) and the host operation surface: reading
`config`, re-applying it unchanged, rejecting incomplete routes and unknown
route ids, and saving to the profile patch. Visual checks in light and dark
themes need the page open in the Web UI.