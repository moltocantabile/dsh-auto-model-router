# Final audit

Scope: the whole `dsh-auto-model-router` plugin — `src/`, `tests/`, `scripts/`,
`docs/`, the runtime data schema, and the host↔client contract.
Method: source-level audit with read/grep verification and executable
reproductions; no source changes were made. Findings are ordered by severity and
each names the wrong behaviour it enables.

## Snapshot and limitations

- **Audited snapshot:** git `HEAD` = `2ba59f8` ("Close the next round of
  measurement and identity bugs"), catalog `data/model-info-runtime.json`
  checkedAt 2026-11-19, `data/routing-derived.json` checkedAt 2026-11-19.
- **Moving target:** the working tree at audit time had uncommitted edits to
  `src/decision.js`, `src/refresh.js`, `src/summarize.js`, and their tests (a
  parallel agent's work). Those files were changing during the audit; their
  findings are marked **in flight** and line numbers for them are working-tree
  numbers. Everything else is stable at `HEAD`.
- **Audit conventions:** no codebase-memory graph provider is available in this
  session's tool surface, so there is no graph generation, pagination, or
  `check_index_coverage` result to report. All claims are source-verified with
  `file:line`; "unused" claims were checked by grepping every source and test.
  Bounded scope excludes generated `lib/` (parity checked separately), the
  DSH host itself, and live provider catalogs.
- **Verification run:** `npm test` at the clean snapshot: **237/237 pass**.
  Reproduction scripts quoted below were run against the shipped runtime
  catalog.

## Severity scale

- **Critical** — produces a wrong routing/placement answer in the default
  configuration, or silently corrupts the measurement data the router uses.
- **High** — a documented control or headline feature does not do what its
  status says, or a plausible operational event silently degrades correctness.
- **Medium** — duplicated ownership or missing observability that makes the
  above likely to recur.
- **Low** — debt with no current wrong answer.

---

## Critical

### C1. Tier quality floors compare a translated number on the wrong axis

**Evidence.** `alignedOperatorFloors` rewrites each hand-written floor onto the
measured axis (`src/index.js:177-198`) and records the original as
`operatorMinQuality`, but it does not mark which axis the new number belongs to.
`mergeEnvelopes` then treats that number as an explicit field
(`src/refresh.js:480-520`), and `withinEnvelope` reads the axis from the
`derived`/`source` marker, which is absent:
`const quality = derivedFloor ? qualityBasis(info) : legacyQuality(info)`
(`src/select.js:771-800`). The translated floor is therefore compared against
the **legacy compiled quality**.

On the shipped catalog:

| tier | authored floor | translated | models passing on legacy basis | on measured basis |
|---|---|---|---|---|
| fast | 40 | 7.2 | 6 | 6 |
| balanced | 55 | 14.2 | 28 | 26 |
| deep | 66 | 27.8 | **60** | **29** |

Reproducing the host's effective envelopes and `assignTiers` on the runtime
catalog gives `fast 5 / balanced 12 / deep 16 / off 34`, with `deep` containing
`deepseek-r1-distill-qwen-1.5b`, `kimi-k2.5`, `siliconflow/deepseek-v3.2` and
other thin/legacy-quality models that the measured axis rejects.

**Why it is Critical.** Every default install merges `DEFAULT_ROUTES`
(`src/index.js:96-142`), so every operator floor is translated and every floor is
read on the wrong axis. The data-derived floor is not merely ignored (see H2);
the fallback number actually used is a cross-scale comparison — the precise
failure the ranking work was introduced to remove. The same planner then prunes
with a *third* basis: dominance compares `qualityBasis` (measured low bound,
`src/tiers.js:217-232`) while placement compared legacy quality, so a model can
be admitted by one measure and switched off by another.

**Wrong answer enabled.** `deep` admits twice the models the measured policy
intends; weak models are routed as "evidence-backed ceiling" and the board's
lanes contradict its own ranks.

### C2. A partial refresh can overwrite good measurements, and the result is saved

**Evidence.** `refreshCatalog` collects source failures in `errors`
(`src/refresh.js:263-410`, `errors.push` at 270, 275, 297, 313, 319, 328, 344)
and then proceeds to rebuild and return the dataset regardless
(`src/refresh.js:384-405`). The rebuild is not a merge:

- `buildDataset` writes `benchmarks: ex?.benchmarks ?? null` and rebuilds
  `crossChecks` only from the current Compass response
  (`src/model-data-build.js:345`, `:355`). If BenchGecko returned nothing, the
  previous leaf tables are erased for the entries the builder owns (the 17
  `PRIOR` models, `src/model-data-build.js:25-49`).
- `attachCrossChecks`/`attachArtificialAnalysis` add only what this run fetched;
  a failed source removes its previous contribution for those entries.
- The refresh action saves and applies the returned dataset unconditionally
  (`src/index.js:1516-1526`), then reports "refreshed with N source error(s)".

**Reproduction.** Rebuilding the shipped catalog with empty source maps (a
BenchGecko + Compass outage) yields: `12` models lose their BenchGecko leaf
tables and `15` lose their compiled evidence; the ranking engine has no axis
owner left. Over a normal refresh this means one transient outage permanently
degrades the runtime catalog and the ranking derived from it.

**Wrong answer enabled.** The router keeps routing while its measurements were
silently replaced by priors/thinner data; only a one-line error count marks it.

---

## High

### H1. `force <tier>` is inert for the shipped envelope-only routes

**Evidence.** The shipped tiers name no provider or model
(`src/decision.js:18-40`). The forced-route branch nevertheless treats the tier
as a concrete route: `selected = { provider: routes[forceId].provider, model:
routes[forceId].model }` (`src/index.js:832-834`), i.e. `null/null`. `routeOf`
returns the same null route for a route pin (`src/index.js:357-367`), and
`routeUsable` either rejects it or the harness rejects the null selection; the
apply path then returns without selecting anything (`src/index.js:1037-1080`).
Status records the decision with `applied: false`; the only other trace is a
warn log. The test for this control pins the pin *format*, not the effect
(`tests/intent.test.mjs:70-77`).

**Wrong answer enabled.** "Pin this agent to the `deep` tier" does nothing on a
default install, which is exactly when `force` is the operator's escape hatch.
It works only after the operator also pins each tier to a provider/model.

### H2. Derived tier ceilings are inert by default while status says they are used

**Evidence.** `mergeConfig` always materialises `DEFAULT_ROUTES`, so
`operatorRoutes` always has all three envelope fields (`src/index.js:96-142`).
`mergeEnvelopes` fills a field only when the operator's value is absent
(`base.maxCost ?? data.maxCost`, `src/refresh.js:480-520`); nothing is absent.
Reproducing startup with the shipped config and `data/routing-derived.json`
gives effective ceilings `55 / 85 / 100` and translated floors — the derived
numbers `67 / 80 / 100` and `15 / 24 / 31` are never applied; only their
`sample` count survives in the merged envelope. Status still prints
`envelopes: merge (derived from 66 models)` (`src/index.js:1100-1102`). The
settings page has no `envelopeMode` control; the locale strings for it exist but
are never rendered (`src/client.js:312-315`).

**Wrong answer enabled.** The advertised "data-derived ceilings" feature never
changes a board, while both status and the design doc claim it does. Operators
cannot distinguish "data says these cut-offs" from "shipped constants".

### H3. Durable wrong-model entries persist; no reconciliation pass repairs them

**Evidence.** The shipped runtime catalog contains entries whose `label` names a
different model:

- `glm-5` → `"GLM-5.3 (Max)"`
- `siliconflow/deepseek-v3-0324` → `"DeepSeek V4.1 Flash 1017 (Max)"`
- `vanchin/deepseek-v4-pro` → `"DeepSeek V4 Pro 0813 (Max)"`
- `ZHIPU/GLM-5` → `"GLM-5.3 (Max)"` (unmeasured)

`refreshCatalog` rebuilds from `base`, and `buildDataset` carries old entries
unchanged when the id has no `PRIOR` (`src/model-data-build.js:273-277`), so the
mislabelled entries survive every refresh. The working-tree edit (**in flight**)
adds a `labelAgrees` guard and now passes the catalog into every name-based
extractor, which closes the future-join path. It does not reconcile the entries
already persisted: the catalog keeps the wrong label and the wrong measurements
until an explicit repair pass relabels or drops them.

**Wrong answer enabled.** For any provider that still advertises one of those
ids, the router compares, ranks and prices it with another model's
measurements and shows the wrong label on the board. This is the same class of
failure that motivated the identity work, persisting in data rather than code.

### H4. The number on a board card is not the number its lane used

**Evidence.** Card metadata returns `quality: qualityBasis(info)` — the measured
low bound (`src/tiers.js:72-83`) — and the client renders it as the card's
"quality" (`src/client.js:1073-1092`). In the default configuration, lane
placement uses `legacyQuality` because of C1. The measured quantities do move
the visible order: the client sorts each lane by `meta.rank`, which is the
measured `rankValue` order (`src/client.js:980-995`). Reproduced board: rank #1
`qwen3.7-max` (low 46.3) sits in `balanced` while rank #3 `kimi-k3` (low 42.0)
sits in `deep`; the card shows `low 46.3`, the lane was won with legacy quality
69.0.

**Wrong answer enabled.** The operator cannot reproduce a lane assignment from
the card, and the board can show a lower-ranked model in the "deeper" lane with
no trace of why.

### H5. The "67 measured" headline is not supported by the current axis coverage

**Evidence.** The catalog has 69 entries; 12 carry BenchGecko leaf tables (the
axis owner), 56 carry Artificial Analysis benchmarks, and only **4** entries
carry both (`deepseek-v4.1-flash-1017`, `deepseek-v4-pro-0813`, `glm-5.3`,
`qwen3.7-plus`). With `MIN_DIMENSION_OVERLAP = 6`
(`src/rank.js:96`, applied at `:825`), almost no dimension-level alignment can
be fitted on that overlap:

- `550` of `996` observations are uncalibrated in the shipped run. AA keeps only
  the same-benchmark fits for `hle`, `scicode` and `long-context-reasoning`;
  llmleaderboard keeps one knowledge-dimension fit; the remaining AA/llm
  observations never reach a score;
- `43` of the `67` "measured" models have every core dimension at evidence `1`;
  `67` of `181` measured dimensions have more than one benchmark;
- the threshold is load-bearing on exactly this catalog: at overlap 4 the same
  data yields `230 / 265` multi-benchmark dimensions and 46 models with 4/5
  coverage; at 6 it yields `67 / 181` and only 10 models with 4/5 coverage.
  A change from 4 to 6 discarded 505 observations with no alert and no test.

**Wrong answer enabled.** Models are called `measured`, placed in tiers and
ranked against fully measured models on the strength of three prior-shrunk
single benchmarks, while status reports "67 measured" and the design doc claims
cross-source consensus. The ranking engine's honesty rules are correct; the
input pipeline does not give it enough overlap to apply them.

---

---

## Medium

### M1. Two tier planners exist; only one runs

`tiers.js` (`assignTiers`, `autoTierFor`, `withinEnvelope` via
`select.js:771-800`) is live in the host (`src/index.js:571`, `:1221`).
`rank.js`'s `planTiers`, `fitsEnvelope`, `autoTierForModel`, `toCatalogPatch`
and `paretoLayers` are imported by tests only (`tests/rank.test.mjs` is their
only consumer; no `src/` import), and duplicate constants (`TIER_COST_FACTOR`
at `src/rank.js:120` vs `TIER_COST_FACTORS` at `src/select.js:67`;
`LATENCY_RANK` twice). The two planners already disagree: `rank.fitsEnvelope`
defaults to the measured basis, `select.withinEnvelope` (live) uses the legacy
basis for explicit floors. The visible per-tier ranking and Pareto frontier
designed in `rank.js` never reach the board; the client builds its own order
from global rank.

**Failure enabled.** A fix to the dead planner passes its tests while production
keeps the bug; two "sources of truth" for the same policy guarantee drift.

### M2. Identity policy is spread across five modules with different rules

`refresh.js` owns `normalizeName`, `nameIndex`, `nameIndexAll`, `idsAt`,
`idStem`, `sameModelName`, `modelStem`, `splitVariant`, `matchAnalysisRow`,
`aaSlugCandidates` (`src/refresh.js:666-940`); `rank.js` has its own
`normalizeName`, `bareId`, and exact-match `buildAnalysisRows`
(`src/rank.js:202-226`, `1103-1155`); `tiers.js` has `familyOf`
(`src/tiers.js:35-48`); `model-info.js` has `modelKey`/`infoFor` with a
`-\d{3,4}` family fallback (`src/model-info.js:165-196`); `attachUsage` adds a
stem fallback (`src/refresh.js:523-575`). H3 is the observable consequence:
the same source row can join by exact name in one path and by stem in another,
and a stored entry is never re-validated against its own id.

**Failure enabled.** Every new provider spelling or source-name convention
requires edits in several places; one missed place becomes durable bad data.

### M3. The suite pins data accidents and misses the two host seams where C1/H2 live

- Live-catalog tests assert current data state, not code invariants:
  `models.length >= 40`, `unknownBenchmarks.length > 0`,
  `coverage.uncalibrated.length > 0`, `epoch.n >= 3`
  (`tests/rank.test.mjs:721-807`); `tests/ranking-integration.test.mjs:74-82`
  re-ranks the shipped file. Fixing C2/H5 would make some of these fail, which
  makes the defect harder to fix, not easier.
- No test drives `applyEnvelopes`/`alignedOperatorFloors` or the effective
  `routingRoutes`; `mergeEnvelopes` is tested only with absent fields
  (`tests/envelopes-derived.test.mjs`), never with translated defaults. That is
  why C1/H2 pass CI.
- No test covers partial-source refresh behaviour (C2) or reconciles persisted
  entries against their labels (H3).
- `tests/generic.test.mjs` asserts source-substring presence for wiring; it is
  cheap but breaks on benign refactors and does not test behaviour.

### M4. Load-bearing documentation describes a different system

- `README.md:120-170` gives the utility formula as
  `floor = 36 + 9 × risk` (the default is a pool quantile,
  `src/select.js:374-461`), omits the usage bias, and states "admits 6 / 9 / 3"
  while the replicated default board is 5 / 12 / 16. The tier table does not
  mention `envelopeMode` or derived ceilings.
- `docs/data-utilization.md:1-7` says "nothing here is enforced", "38 tests",
  and lists `planTiers` as an integration plan; ranking now drives selection,
  throughput and floors.
- `src/rank.js:20-60` still describes "below three overlaps the channel is
  uncalibrated" although the dimension fallback now requires
  `MIN_DIMENSION_OVERLAP = 6` (`src/rank.js:96`, `:825`) and thin estimates are
  shrunk toward a neutral prior (`src/rank.js:904-950`) without a header
  update.
- `src/model-info.js:14-32` still describes family/release-date priors as the
  mechanism; `src/refresh.js:400-402` still says "Nothing routes on it yet"
  while `select.js` scores `ranking.dims`.

### M5. Status omits the facts that explain a board

`statusText` prints `envelopes: merge (derived from N models)` without the
derived numbers or their age (the loader drops `checkedAt`,
`src/model-info.js:108-118`), has no ranking coverage/uncalibrated/evidence
line, lists lane members in pool order rather than rank order
(`src/index.js:1103-1119` vs client sort at `src/client.js:980-995`), and prints
`null/null` for envelope-only routes (`src/index.js:1142-1160` against
`src/decision.js:18-40`). `attachRanking` already computes
`uncalibratedObservations`, `unknownBenchmarks` and a coverage table
(`src/refresh.js:582-630`); the refresh summary text prints only
measured/provisional/unmeasured (`src/index.js:1529-1533`).

**Failure enabled.** An operator cannot tell why the lanes changed after a
refresh, or that a refresh discarded 550 observations (H5), without
reading source.

---

## No change needed

These mechanisms were checked and are sound; leave them alone.

- **Unconfigured or failed decision endpoint:** warn once, status says
  routing inactive, and a failed decision never moves a session
  (`src/index.js:238-250`, `:1037-1049`). Errors are counted and shown.
- **Empty provider answers and stale catalogs:** a collapsed pool keeps the
  previous board, retries, and reports `stale`/`FAILED` per provider
  (`src/index.js:392-470` and the `catalog:` line in `statusText`); route anchors are never published as a
  catalog.
- **Partial provider catalog failure:** previous models are retained and the
  failure is cached/visible, so one provider outage does not shrink the board
  (`src/index.js:407-455`).
- **Summarizer failure:** a failed digest keeps the previous one and never
  blocks a route; failure count is in `status` and the digest tool
  (`src/summarize.js:160-270`; the working-tree edits improve framing and
  message budgeting).
- **Ranking merge invariants:** one benchmark one vote, integer evidence,
  refusal below overlap, no AA-index/Epoch blending, provisional/unmeasured
  handling, AA zero and mixed-scale handling are pinned by
  `tests/calibration.test.mjs`, `tests/rank.test.mjs`,
  `tests/ranking-integration.test.mjs`.
- **Usage bias:** bounded, outside the composite, deterministic, with tests
  (`src/select.js:540-560`, `tests/usage.test.mjs`).
- **Pool-derived risk floor:** one plan per run, derived from the same
  profile-weighted values it is subtracted from, with a visible fallback note
  (`src/select.js:374-461`, `tests/consistency.test.mjs`).
- **Board ownership:** membership is computed on the host and shipped in the
  snapshot; the page renders `snap.board` and does not re-derive tier rules.
- **Price conversion:** one stated CNY/USD rate, AA USD only when the catalog has
  no price, flagged in the ranking price (`src/rank.js:415-480`).
- **`lib/` parity:** every `src/*.js` matches `lib/` byte-for-byte except the
  build stamp in `client.js` produced by `scripts/build.sh`.
- **In-flight decision/summarize edits** (uncommitted at audit time) address
  malformed-answer confidence, empty answer sets, message-window noise,
  reuse-signature collisions and authless endpoints. Verify and land them; do
  not audit them as final here.

---

## Reconstruction recommendation

**Do not reconstruct the whole project.** The layering is sound: pure ranking
engine (`rank.js`), pure scoring (`select.js`), host policy/wiring
(`index.js`), browser UI (`client.js`), and tested parsers. A rewrite would
concentrate risk on the data pipeline, which is where the defects actually are,
and would discard a 237-test suite whose core assertions are behavioural.

Reconstruct three seams and one data rule, in this order:

### Step 1 — one capability basis (`src/basis.js`)

Extract a deep module that owns: choosing the basis (ranking vs legacy), the
conservative value, the per-dimension values/evidence, envelope acceptance,
floor planning, and the board card facts. `select.js`, `tiers.js` and
`index.js` import it; the client receives card facts from host-computed board
metadata instead of its own `basisValues` mirror (`src/client.js:790-806`).
Interface (small): `basisOf(info)`, `placeable(info)`, `accepts(info,
envelope)`, `floorPlan(profile, infos)`, `cardOf(info)`. The invariant "one
basis per comparison" becomes structural instead of a convention held by
comments. This is where C1, H2 and H4 are fixed, once.

### Step 2 — one identity module (`src/identity.js`)

Move `normalizeName`, `modelStem`, `splitVariant`, `sameModelName`, the
name-join guard, model keys and family resolution behind one interface used by
`refresh.js`, `rank.js`, `openrouter.js`, `model-info.js` and `tiers.js`. Add a
refresh reconciliation pass: an entry whose id and label disagree is relabelled
from the id (or reported and left unrouted), and the reconciliation report
travels in the refresh summary. This closes H3 and M2 and makes H3's data defect
self-healing rather than requiring a manual catalog edit.

### Step 3 — one tier planner

Keep `tiers.js` as the live planner (it is what the host and most tests use) and
delete `rank.planTiers`/`fitsEnvelope`/`autoTierForModel`/`toCatalogPatch`/
`paretoLayers`, or wire `planTiers` into the board and delete `assignTiers`.
Do not keep both. Keep `rank.derivedEnvelopes`; it is the derivation, not the
planner. Re-point the surviving ranking/Pareto tests at the live seam.

### The data rule: merge, don't rebuild

Refresh becomes transactional per source: keep last-good values for fields whose
source failed this run, never erase a leaf table because an extractor returned
nothing, and apply with an explicit `degraded` flag (or refuse to apply when
BenchGecko, the axis owner, is missing). Persist per-source `checkedAt` and the
derived-envelope `checkedAt`; surface coverage (axis models, calibrated
channels, uncalibrated observations, multi-benchmark dimension share) in the
refresh result and in `status`. This closes C2/H5 and makes the status honest.

### Migration order and test strategy

1. Add failing tests at the new pure seams first: `effectiveEnvelopes(routes,
   derived, mode, legacyValues, measuredValues)` (C1/H2), `mergeRefresh(prev,
   next, results)` (C2), `cardOf(info)` vs lane placement (H4), identity
   reconciliation (H3), and `force tier` against envelope-only routes (H1).
2. Extract `basis.js` and switch `select/tiers/index/client`; keep the existing
   behavioural tests green.
3. Extract `identity.js` and run the reconciliation pass; add property tests
   (idempotent normalize, tier words never collapse, effort variants do).
4. Delete or wire the duplicate planner; delete its tests or move them to the
   live seam.
5. Replace live-catalog assertions with fixture-based invariants plus one
   catalog-shape smoke test that tolerates coverage changes (assert evidence is
   integer and non-negative, no axis leakage, every measured model has a
   plausible coverage note — not `uncalibrated > 0` as a requirement).
6. Re-derive README and `docs/` from the tests once the seams are final.

Scope: two new pure modules, edits to six existing modules, one data-flow rule,
and one test cleanup. No rewrite of the ranking engine, the source extractors,
the decision client, or the UI.

---

## Top three things to fix before calling the project done

1. **Restore one capability basis across floor, placement, dominance and card.**
   Compute effective envelopes in one pure function with explicit field
   provenance; compare a measured-basis floor against the measured low bound;
   make `merge` apply the derived floor when the shipped value is a default
   (or state plainly that the tier is explicit). Add the host-seam test that
   would have caught C1/H2/H4.
2. **Make refresh transactional and measurement coverage truthful.**
   Never overwrite last-good source data on a partial failure; mark the apply
   degraded or refuse it when the axis owner is missing; report axis coverage,
   calibration and evidence distribution in `status` and the refresh summary;
   either restore overlap (fetch BenchGecko for advertised ids) or reclassify
   single-benchmark `measured` models until "measured" means what the summary
   says. Include the id/label reconciliation so H3 cannot recur.
3. **Make `force <tier>` actually constrain the tier.** Pass the forced tier
   into the selector's membership instead of synthesising a null route, and
   test it end-to-end against the shipped envelope-only routes. While there,
   delete or wire the duplicate tier planner so the fix has one home.

The remaining Medium/Low items (identity consolidation, status completeness,
docs, dead exports, startup data-version check) are scheduled as the
reconstruction steps above; none of them is a prerequisite for these three.

---

## Reproductions used

- Floor basis and board: reimplemented the host's `alignedOperatorFloors` →
  `mergeEnvelopes` → `assignTiers` sequence against
  `data/model-info-runtime.json` and `data/routing-derived.json`; printed
  translated floors (7.2 / 14.2 / 27.8), pass counts (6 / 28 / 60 legacy vs
  6 / 26 / 29 measured) and lane sizes (5 / 12 / 16 with 34 off).
- Outage: `buildDataset({ base: runtime, benchgecko: {}, compass: {}, counts: {}
  })`; 12 leaf tables and 15 evidence sets lost.
- Coverage: `rankTable(runtime)` and
  `rankTable(runtime, { minDimensionOverlap: 4 })`; counted channel overlap,
  uncalibrated observations, evidence distribution and coverage bands.
- Identity: inspected runtime entries for `glm-5`,
  `siliconflow/deepseek-v3-0324`, `vanchin/deepseek-v4-pro`.
- Force: traced `pinTarget` → `decideFor` forced-route branch → `routeOf` →
  `routeUsable` against `DEFAULT_ROUTES`.
- Test baseline: `npm test` (237 pass) on the clean snapshot.

## Post-audit actions (Lead, same session)

| Finding | Status |
|---|---|
| C1 floor-axis mix | Fixed: a translated operator floor carries `derived: true, source: 'derived'`, so `withinEnvelope` compares it on the measured axis. Regression test added. |
| C2 partial refresh overwrites | Fixed by the database reconstruction: `scripts/refresh-database.mjs` refuses to write on any source error. |
| H1 `force <tier>` inert | Fixed: a route without a pinned model constrains the selector to that tier instead of selecting an absent model. |
| H2 derived ceilings inert | Fixed: the shipped defaults are no longer merged into the operator config; `effectiveEnvelopes(operator, derived, defaults, mode)` fills absent fields from the data (merge), from the defaults (explicit), or from the data with the operator's latency policy (derived). Status now reports how many fields are actually in force. |
| H3 persisted wrong-model labels | Fixed by the database pass (identity guard on every join + rebuild); the six mislabelled entries are gone. |
| H4 card basis ≠ lane basis | Fixed by C1: lane and card now read the same basis. |
| H5 coverage/status integrity | Fixed for the card: `boardMetaOf` reports `dimsCovered/dimsTotal` (five composite dimensions), shown beside rank/composite/usage, and the uncalibrated count was already a badge. The refresh report carries per-channel coverage. |
| M1 duplicate tier planners | Not yet: `rank.planTiers` remains test-only. |
| M2 identity policy fragmentation | Not yet: the suggested `src/identity.js` extraction. |

Remaining reconstruction order (unchanged): `src/basis.js` → identity module + refresh reconciliation → delete or wire the duplicate planner → per-source refresh merge.
