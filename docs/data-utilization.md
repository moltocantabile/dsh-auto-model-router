# Data utilization: audit, ranking, and tier grouping

Status: **design + prototype, review pending.** Nothing here is enforced. The
plugin is in `shadow` mode, so every proposal below is a computation that can be
logged and compared against the current decision before anything routes.

The prototype is [`src/rank.js`](../src/rank.js) with tests in
[`tests/rank.test.mjs`](../tests/rank.test.mjs). No existing file was modified.
Run it with:

```bash
node --test tests/rank.test.mjs     # 38 tests
npm test                            # 176 tests, includes the new ones
```

A short summary of what this document argues:

1. The catalog **already contains** enough data to rank honestly — BenchGecko's
   leaf table, CompassRank boards, llmleaderboard tracks, Artificial Analysis
   per-benchmark percentages, AA's index, Epoch's ECI. Most of it is dropped or
   used only as a display cross-check.
2. The one number the selector sees (`scores.*`) is a blended composite with one
   integer evidence count. It cannot tell a two-source consensus from a prior,
   and three different sources can change it without leaving a trace.
3. A defensible merge needs a named axis, per-source alignment with a refusal
   threshold, one vote per underlying benchmark, and a hard line around the
   scales that must never be averaged. `rank.js` implements that.
4. Tiers can stay the stable operator-facing names while their **ceilings** are
   derived from the current pool (cost percentiles and lower-bound capability
   quantiles) and their **membership ranking** becomes visible. `force`,
   `defaultRoute`, hand overrides and the same-family dominance rule survive.
5. The audit found real data defects that should be fixed in `refresh.js`
   independently of this ranking work: an AA index of `0` becomes invented
   quality, AA per-benchmark scores are stored and never used, some AA rows are
   joined to the wrong catalog id, and BenchGecko leaf provenance (category,
   origin) is discarded.

`file:line` references are against the tree at the time of writing
(2026-11-19). Line numbers may move; the tests do not depend on them.

---

## 1. The invariants this design has to satisfy

From the brief, restated as rules the code enforces:

| Invariant | Enforcement |
|---|---|
| A model with no measurement is never ranked on an invented prior. | `rank.js` emits `rankValue = null` and status `unmeasured` when no dimension has integer evidence ≥ 1. Family priors are **not implemented**; compiled scores with `evidence === 0` are ignored. An AA-index-only estimate is `provisional`, evidence 1, flagged, and excluded from auto tier placement. |
| Every score carries an integer evidence count. | Per dimension, evidence = number of distinct canonical benchmarks after deduplication. `toCatalogPatch()` writes integers only. A derived fact (context capacity, modalities) carries evidence `0`. |
| Prices are CNY per 1M tokens in the dataset; AA quotes USD. | `priceOf()` reads `entry.price` as CNY. AA's USD price is used only when the entry has no catalog price, converted at `PRICE_CNY_PER_USD = 7.2`, and flagged `converted: true`. No CNY/USD values are averaged. |
| Model identity is `provider/model`. | The table is keyed by the catalog key unchanged; AA rows are matched to keys by exact normalized id (never by fuzzy prefix), and a row that matches nothing is reported. |
| Nothing compares across vendors for the purpose of disabling a model. | `planTiers()` disables only within `familyOf(key)`. The cross-vendor Pareto view exists on the table for display and is never fed to the disable rule. |
| Tier names stay `fast`/`balanced`/`deep`. | `TIER_IDS` re-exported from `tiers.js`; no new names. |

Two further rules are design choices, stated so they can be rejected:

- **Ranking uses a lower bound.** A model's rank is its composite minus its
  uncertainty band, not its point estimate. Missing dimensions, thin evidence
  and source disagreement all reduce the rank. This is what stops a model
  measured on two lucky dimensions from outranking a fully measured one.
- **Tiers use the lower bound for their quality floor by default.** A model that
  cannot prove it clears a floor does not clear it — the same rule the current
  envelope already applies to *unmeasured* models, extended to *uncertainly*
  measured ones. `qualityBasis: 'point'` restores the old behaviour.

---

## 2. Field-by-field audit

Verdict legend:

- **SCORED** — contributes to a routing score today.
- **FALLBACK** — contributes only when something is missing.
- **DISPLAY** — stored/rendered for humans or prompts, never arithmetic.
- **COUNT** — used only as a sample count.
- **IGNORED** — extracted or available at the source but dropped.
- **DERIVED** — transformed into a score fact, not a measurement (evidence 0).

### 2.1 BenchGecko

Extraction: [`src/refresh.js:190`](../src/refresh.js#L190) `extractBenchGecko`.
Counts: [`src/refresh.js:223`](../src/refresh.js#L223) `countsOf`.
Compilation: [`src/model-data-build.js:156`](../src/model-data-build.js#L156)
`buildDataset`.

| Source field | Where it goes | Verdict |
|---|---|---|
| `scores[].benchmark` (label) | `extraction.benchmarks` map, refresh:199; stored on entry, build:342 | **IGNORED** by the selector; used by `countCat()` (build:376) only to count samples |
| `scores[].score` (leaf value) | bench:199 | **IGNORED** for scoring; the nine scores use the *category mean* instead |
| `scores[].category` | category means, refresh:193-206 | **SCORED** — but only `math`, `knowledge`, `reasoning`, `coding`, `agentic` are consumed (`DIMS`, build:26). `general`, `language`, `arena`, `speed` are dropped. |
| `scores[].source` (Epoch AI hub / Artificial Analysis / LiveBench / LMArena) | — | **IGNORED** — the dataset never stores it |
| `scores[].source_url`, `benchmark_url`, `benchmark_slug`, `unit` | — | **IGNORED** |
| `avg_score` | `quality` (build:334-339), blend anchor cap (build:173-175, 291-292) | **SCORED / SORT KEY** — `index.js:173` sorts the model picker by it |
| category sample counts | `countsOf` → `evidence[dim]` (build:282, 294, 317) | **COUNT** |
| `context_window` | extraction:207 | **IGNORED** — the build keeps the old catalog's `contextWindow` (build:321), never BenchGecko's |
| `model_type`, `is_open_source`, `status`, `release_date`, `benchgecko_score.rank/of` | extraction:208-215 | **IGNORED** — extracted then never stored in the catalog |

Audit finding, verified against the raw captures in `data/benchgecko-raw/`:
BenchGecko is an **aggregator**, not a benchmark author. Across the 16 captured
models its rows come from Epoch AI Benchmarking Hub (26 benchmarks), Artificial
Analysis (13), LiveBench (8) and LMArena (2). The dataset keeps no `source`
field, so the compiler cannot distinguish an Epoch measurement from an AA
measurement republished by BenchGecko. This matters for agreement weighting and
for anyone tempted to compare "BenchGecko vs AA" — partly it is AA vs itself.

The category assignment is also inconsistent across captures: `WeirdML v3` is
filed under `knowledge` while `WeirdML` is filed under `coding`, and every
Artificial Analysis row is filed under the category `speed` (a UI grouping quirk,
not a speed measurement). So BenchGecko's taxonomy is not a trustworthy
dimension oracle on its own; `rank.js` treats it as a transport and applies its
own registry (documented in §3.2).

### 2.2 CompassRank

Extraction: [`src/refresh.js:152`](../src/refresh.js#L152) `extractCompass`;
dimension mapping [`src/model-data-build.js:198`](../src/model-data-build.js#L198)
`compassDims`.

| Source field | Where it goes | Verdict |
|---|---|---|
| `ability.Average`, `Knowledge`, `Reasoning`, `Abstraction`, `Agent` | `compassDims` (build:198-210) | **SCORED** |
| `ability.QuantitativeReasoning` | `math` (build:205) | **SCORED** |
| `bench['Programming.Average']`, `['Programming.SWE-bench Pro Verified']` | `coding` (build:203) | **SCORED** |
| `bench['Science.Average']` | `knowledge` (build:206) | **SCORED** |
| `bench['Programming.Terminal-Bench 4.0']`, `bench['KnowledgeWork.Average']` | `agentic` (build:207) | **SCORED** |
| `bench['General.HLE-Diamond']` | stored only (`crossChecks.compassRank.hle`, build:359) | **DISPLAY** |
| `released` | `crossChecks.compassRank.evaluated`, build:359 | **DISPLAY** |
| `ability.Interaction`, `Safety`, and all sub-abilities (`AppliedScientificKnowledge`, `EverydayKnowledge`, `FormalScientificKnowledge`, `AttentionAndScanning`, `LogicalReasoning`, `SpatialAndPhysicalReasoning`, `TaskPlanningAndToolUse`, `DataAnalysisAndDeepResearch`, …) | — | **IGNORED** — extracted (refresh:157-166) then never used or stored |
| `ability.responseTokenCost`, `thinkingTokenCost` | — | **IGNORED** (the bench loop strips `*TokenCost`, refresh:178; the ability loop does not, but the compiler ignores them) |
| `bench` columns other than the four above (`OC-Turnkey`, `OC-WorkFlowBench`, `GDP.pdf`, `Terminal-Bench-Science`, `EESE`, `OC-KnowScope`) | — | **IGNORED** |
| `name`, `org`, `openSource` | — | **IGNORED** (only `name` reaches the extraction object) |

The stored cross-check ([`src/model-data-build.js:350`](../src/model-data-build.js#L350))
is narrower than the source: `average`, `knowledge`, `reasoning`, `abstraction`,
`agent`, `swePro`, `terminalBench`, `hle`, `evaluated`. The compiler used
`QuantitativeReasoning`, `Programming.Average`, `Science.Average` and
`KnowledgeWork.Average` and then dropped them, so a re-derivation from the
catalog cannot reproduce the build. `rank.js` reads the stored fields it has and
will pick up the missing ones automatically if `refresh.js` stores them.

### 2.3 Epoch ECI

Extraction: [`src/refresh.js:979`](../src/refresh.js#L979) `extractEpochEci`.
Storage: [`src/refresh.js:1071`](../src/refresh.js#L1071) `attachCrossChecks`,
fields at 1077-1079.

| Field | Where it goes | Verdict |
|---|---|---|
| `eci` | `crossChecks.epoch.eci` | **DISPLAY** — never read by `select.js`, `tiers.js` or `index.js`; rendered by `client.js:816` and returned by `model-info.js:251` |
| `date` | `crossChecks.epoch.date` | **DISPLAY** |
| any confidence-interval columns the CSV publishes | — | **IGNORED** — the extractor reads only `Display name`, `eci`, `date` (refresh:981-1004) |

The docstring at refresh:969-975 is explicit that ECI is an interval scale and
must not be averaged into 0-100 scores. The code honours that by never using it.
It also never uses it for anything else, which is the gap.

### 2.4 llmleaderboard

Comparison CSV: [`src/refresh.js:1013`](../src/refresh.js#L1013)
`extractLlmComparison`. Benchmark pages:
[`src/refresh.js:1054`](../src/refresh.js#L1054) `extractLlmBenchmarkPage`.
Storage: refresh:1081-1088.

| Field | Where it goes | Verdict |
|---|---|---|
| `ttft_seconds`, `output_tokens_per_second` (fastest provider offering) | `crossChecks.llmLeaderboard` | **FALLBACK, effectively dead** — only used by `attachArtificialAnalysis` to fill `latency` when `entry.latency === undefined` (refresh:862-870), but `buildDataset` always writes a latency (build:331), so base models never take it; AA-created entries are created after `attachCrossChecks` runs |
| provider offering identity (`provider`, `configuration`) | stored (refresh:1084-1086) | **DISPLAY** |
| per-track benchmark scores (`livebench-2-*`, `terminal-bench-4-0`, `deepswe-v1-1`, `gpqa-diamond-aa`, `gdp-pdf-aa`) | `crossChecks.llmLeaderboard.benchmarks` (refresh:1086) | **DISPLAY** — rendered at `client.js:822`, never scored |
| which row is kept (fastest tokens/s) | refresh:1038-1045 | **POLICY** — reasonable for comparing models rather than providers |

### 2.5 Artificial Analysis

Leaderboard extraction: [`src/refresh.js:622`](../src/refresh.js#L622)
`extractArtificialAnalysis`. Model-page fallback:
[`src/refresh.js:714`](../src/refresh.js#L714). Attach:
[`src/refresh.js:756`](../src/refresh.js#L756) `attachArtificialAnalysis`.

| Field | Where it goes | Verdict |
|---|---|---|
| `intelligenceIndex` | calibration fit (refresh:759-782; defaults `slope=1.6, intercept=20` at 766-767), fills `quality` only when missing (845-852), created entries (874-935) | **FALLBACK** — never blended when a quality exists; feeds the quality number that tiers compare (tiers:154, 487) |
| per-benchmark `scores` (gpqa, hle, terminalbench-*, livecodebench, scicode, tau2, mmmu-pro, aime25, …) | extracted at refresh:668-673 (`number * 100`), then only averaged by `fractionMean` (788-792) to derive a quality for models AA stopped ranking (822-828) | **IGNORED** beyond that one derived mean — the benchmark scores are not stored: the `crossChecks.artificialAnalysis` block (refresh:836-841) keeps only index/price/ttft/speed |
| `price1mInputTokens`, `price1mOutputTokens` | fills `price` only when missing (854-861), USD→CNY at `CNY_PER_USD = 7.2` (refresh:41); raw USD also stored (838-839) | **FALLBACK** |
| `cacheHitPrice` | — | **IGNORED** (present in `data/artificialanalysis.json`, never read) |
| `timeToFirstToken`, `outputSpeed` | latency class (862-870, 874-878); stored | **FALLBACK** (same dead path as llmleaderboard for base models) |
| `contextWindowTokens` | created entries only (refresh:912) | **FALLBACK** |
| `reasoning`, `openWeights`, `releaseDate`, `deprecated`, `creator` | — | **IGNORED** — the extractor never reads them; note that the created entries write `reasoning: value.reasoning === true` (refresh:917) but `value.reasoning` is never set, so every AA-created entry claims `reasoning: false` regardless of the source row |
| `intelligenceIndex === 0` | treated as a normal finite index (refresh:657) → `qualityOf(0) = intercept` | **BUG** — see §2.8 |

### 2.6 The compiled catalog fields

The catalog entry shape is produced by `buildDataset` (build:319-374) and
completed by `attachArtificialAnalysis` (refresh:936-953). Consumers:
`select.js`, `tiers.js`, `index.js`, `model-info.js`, `client.js`.

| Field | Read by | Verdict |
|---|---|---|
| `scores.{coding,reasoning,math,knowledge,agentic}` | weighted in `scoreCandidate` (`select.js:228-240`); sorted by quality at `index.js:173` | **SCORED** |
| `scores.overall` | weighted as a dimension alongside the five (`select.js:39-59`, `DIMENSIONS` at 30) — note this double-counts the composite with its components | **SCORED** |
| `scores.longContext` | log context window mapped to 0-100 (build:157-161, 309); weighted by shapes (e.g. refactor 0.18) | **DERIVED, evidence 0** |
| `scores.vision` | 100 if image/video, else 0 (build:311-313); weighted by `inspect` (0.55) | **DERIVED, evidence 0** |
| `scores.speed` | BenchGecko `speed` category if present, else the hand-written `PRIOR.speed` (build:314-317) | **PRIOR when evidence 0**; weighted (e.g. lookup 0.3) and counted by `evidenceConfidence` when BenchGecko speed samples exist (`select.js:192-199`) |
| `evidence.*` | `evidenceConfidence` (`select.js:192-199`); unverified-weight penalty (261-268); display at `client.js:756` | **COUNT** |
| `quality` | `tiers.js:50-53`, measured check 154, `withinEnvelope` minQuality 487-490; `index.js:173`; `build` 334-339; refresh fills 845-852 | **SCORED / TIER KEY** |
| `price.input`, `price.output` | `blendedPrice` 1:2 weighting (`select.js:169-181`), `costIndex` 183-190, dominance `tiers.js:170,186`, cheapest summarizer model `index.js:189-198`, display `client.js:560-562` | **SCORED** |
| `price.cacheHitInput` | `explicitCache` flag (build:330); preserved by AA fill (refresh:856) | **IGNORED by the cost model** |
| `latency` | `withinEnvelope` (`select.js:482-486`), `autoTierFor` (`tiers.js:76`), display | **SCORED (hard filter)** |
| `contextWindow` | hard filter `select.js:296`; display `model-info.js:198`; AA created entries refresh:912 | **HARD FILTER / DISPLAY** |
| `modalities` | hard filter `select.js:289`; display `model-info.js:208` | **HARD FILTER** |
| `toolCalling` | hard filter `select.js:292` | **HARD FILTER** |
| `reasoning`, `structuredOutput`, `parallelTools`, `mcp` | build:326-329; only `reasoning` is displayed (`model-info.js:206`) | **DISPLAY / IGNORED** |
| `maxOutput` | build:322 | **IGNORED** (never read) |
| `explicitCache` | build:330 | **IGNORED** (never read) |
| `retired`, `preview`, `sunsetAt` | `select.js:299`, `index.js:396-398`, `tiers.js` withdrawal gate | **HARD FILTER / DISPLAY** |
| `bestFor`, `weaknesses`, `distinguishing` | `model-info.js:220-236`, decision prompt | **PROMPT CONTEXT** (never arithmetic) |
| `sources`, `notes`, `checkedAt` | display/audit | **DISPLAY** |
| `benchmarks` (BenchGecko leaf map) | build:342 stores it; `select.js`/`tiers.js` never read it | **IGNORED except evidence counting** |
| `benchmarkSources` | `model-info.js:252`, client | **DISPLAY** |
| `crossChecks.*` (compassRank, epoch, llmLeaderboard, artificialAnalysis) | `model-info.js:251` → `client.js:802-830` | **DISPLAY ONLY** — `grep` confirms `select.js`, `tiers.js` and `index.js` never read `crossChecks` |

### 2.7 Router consumption: where the gaps actually hurt

- `scoreCandidate` (`select.js:222-284`) builds the capability term from
  `scores[dim]` with `num(scores[dim], 50)` (line 233). A dimension with
  `evidence[dim] === 0` is still scored at its prior value; the only defence is
  the uncertainty penalty (261-268), which depends on the *sum* of evidence
  (`/12`, line 197), not on which dimensions are unmeasured.
- `withinEnvelope` (`select.js:478-490`) treats an unpriced model as mid-priced
  through `costIndex`'s fallback (`select.js:183-190` returns 55 when price is
  missing) and can never fail a quality floor on a model with a non-null
  `quality`, even if that quality came from an AA index of `0`.
- `tiers.js:154` defines "measured" as `quality != null || scores.composite != null`
  — exactly the field an invented fallback writes into. This is how AA-created
  entries with evidence 0 on all nine dimensions become routable today.
- The tier board itself (`tiers.js:114-211`) returns groups and `tierOf` but no
  ordering; the operator cannot see which model inside a tier is stronger, which
  is the "no visible ranking per tier" gap from the brief.

### 2.8 Data defects found during the audit (fix in `refresh.js`, not here)

These are independent of the ranking design and worth a separate patch:

1. **AA index `0` is treated as a measurement.** `Number.isFinite(0)` is true
   (refresh:657); `qualityOf(0)` returns the calibration intercept (refresh:782),
   and `attachArtificialAnalysis` writes it when `quality` is missing (845-852).
   The shipped `data/model-info-runtime.json` contains entries whose `quality` is
   exactly `27.4` with all nine evidence counts `0` (e.g. `kimi-k2.7-code`,
   `qwen3.5-122b-a10b`, `qwen3.7-plus-2026-05-26`). An index of 0 means "not
   ranked", not "zero capability". `rank.js` treats `index > 0` only.
2. **AA benchmark scores are mixed-scale.** Only some `scores` values are 0-1
   fractions; `gdpval-aa-normalized` ranges ≈ -402…1866, `aa-3d` ≈ 583…1318,
   `aa-briefcase` ≈ 0…1815, `code2video-aa` ≈ 304…1536. `extractArtificialAnalysis`
   multiplies every one by 100 (refresh:668-673). `fractionMean` accidentally
   filters them out of the quality derivation (788-791), but any future use of
   the leaf values must range-check first. `rank.js` reports these as index
   signals and only accepts `0 ≤ x ≤ 1` from the raw table.
3. **AA per-benchmark scores are thrown away.** `value.benchmarks` is built at
   refresh:673 / 727, then the stored cross-check (836-841) keeps only index,
   price, TTFT and speed. The single richest per-dimension source in the stack is
   never usable after a refresh.
4. **AA fields are dropped at extraction.** `cacheHitPrice`, `reasoning`,
   `openWeights`, `releaseDate`, `deprecated`, `creator` are present in
   `data/artificialanalysis.json` and never read (refresh:655-673). The created
   entry then claims `reasoning: false` for every model (refresh:917), because
   the value was never set.
5. **AA identity join is fuzzy and can rename a catalog entry.** The shipped
   catalog contains `siliconflow/deepseek-v3-0324` labelled **"DeepSeek V4.1
   Flash 1017 (Max)"**, `glm-5` labelled **"GLM-5.3 (Max)"**, and
   `vanchin/deepseek-v4-pro` labelled **"DeepSeek V4 Pro 0813 (Max)"** — all
   created by `matchAnalysisRow`/`claim` (refresh:550-570, 638-649) and labelled
   from the AA row (refresh:911). Identity is supposed to be `provider/model`;
   the join should be exact-id only (as `rank.js` does) and unmatched rows
   reported.
6. **BenchGecko provenance is discarded.** `scores[].category` and
   `scores[].source` are not stored per leaf (refresh:190-221), so the catalog
   cannot say that `WeirdML v3` was a knowledge-category Epoch row while
   `WeirdML` was a coding-category one, or that a row came from AA. Store
   `benchmarkMeta: { label: { category, source } }` — see §7.
7. **The compiler ignores four of BenchGecko's nine categories** (`general`,
   `language`, `arena`, `speed`) because `DIMS` is the five capability
   dimensions (build:26). The `speed` category then feeds `scores.speed`
   (build:314-317) even though the category contains Artificial Analysis
   benchmark rows, not a speed measurement.
8. **Prior blending leaks written guesses into measured scores.** `blend()`
   (build:163-177) mixes `PRIOR[dim]` into an observed value with weight
   `K = 1.5` (build:25, 168), and the evidence count never mentions the prior.
   `scores.speed` for models without BenchGecko speed is *only* the prior
   (build:314-317) with evidence 0 — e.g. `qwen3.8-flash` speed 85/evidence 0,
   `qwen3.8-max` speed 60/evidence 0 in the shipped baseline.
9. **`evidence` does not mean "benchmarks".** CompassRank contributes exactly
   `COMPASS_W = 1` per dimension (build:217, 294), BenchGecko contributes its
   category sample count, and the sum is reported as one integer. `evidence: 3`
   can mean "three category samples + one Compass board", not three benchmarks.
10. **`latency` is a class derived from a hard-coded rule, and measured TTFT is
    almost never reached.** `buildDataset` always writes `q.latency ?? old.latency
    ?? 'balanced'` (build:331), so the llmleaderboard/AA latency fill
    (refresh:862-870) is effectively dead for base models. The class is a fact
    (or a guess) but not a measurement.
11. **Provider duplicates carry different quality.** `deepseek-v4.1-flash-1017`
    has `quality 67.4`, `vanchin/deepseek-v4.1-flash-1017` has `61.3`: the same
    model id under two provider keys got different evidence paths. The key is
    `provider/model`, so both are legitimate entries — but the values should
    agree, and the refresh should dedupe knowledge lookups rather than re-derive
    each key independently.
12. **Fixed cost window ties envelopes to a price era.** `costIndex`
    (`select.js:183-190`) maps blended price over a hard-coded `0.4 … 60 CNY`
    log window, so `maxCost: 55/85/100` (decision.js:25/32/39) are magic numbers
    relative to today's catalog. Add a model and the same envelope admits a
    different share of the pool.

---

## 3. Ranking design

### 3.1 One axis, named

Every capability number in the catalog is on a 0-100 scale, but the scales are
not the same scale. The design picks the **BenchGecko normalized axis** as the
common axis, because BenchGecko's leaf values are already normalized to 0-100
and it is the source the current compiler already treats as the anchor. The
schema statement is:

> A dimension estimate is an arithmetic mean of aligned benchmark observations,
> on BenchGecko's normalized 0-100 scale. An observation is a pair
> `(canonical benchmark, aligned value)`. Alignment is an affine map fitted from
> overlapping models. Nothing else is averaged.

`rank.js` calls the axis-owning channel `benchgecko`.

### 3.2 Benchmark registry (editorial, reported)

`DIM_RULES` in `rank.js` maps each canonical benchmark to exactly one dimension.
It is deliberately explicit and conservative:

| Dimension | Canonical benchmarks |
|---|---|
| coding | swe-bench, swe-bench-pro, deepswe, frontierswe, frontiercode, livecodebench, scicode, weirdml, mirrorcode, livebench-coding |
| reasoning | arc-agi, hle, livebench-reasoning, livebench-data-analysis, simplebench, critpt |
| math | aime, frontiermath, livebench-mathematics, proofbench |
| knowledge | gpqa, simpleqa, omniscience-accuracy, omniscience-non-hallucination, healthbench, gdpval, gdp-pdf, livebench-language |
| agentic | terminal-bench, terminal-bench-science, apex-agents, tau2, tau3, itbench, osworld, remote-labor-index, automationbench, enterprise-ops-gym, analyst-agent, harvey-lab, vials, livebench-agentic |
| vision | mmmu |
| longContext | long-context-reasoning |

Everything else is reported as `unknown` with the models that carried it
(`table.unknownBenchmarks`) and is not scored. CompassRank fields are mapped in
`COMPASS_FIELDS`, with the table (`ability` vs `bench`) recorded because the two
are on different scales.

The registry is a judgement call and should be reviewed as such. It is also why
the doc does not claim benchmark purity: `hle` is filed under reasoning and
`gpqa` under knowledge; another reviewer could move either and the arithmetic
would not change, only the labels.

### 3.3 Channels, alignment, and the refusal threshold

Each source is a **channel**; the origin of a benchmark is its **family**
(`epoch-bench`, `aa`, `livebench`, `arena`, `compass`, `llm`). Channels are
separate because they need separate alignment; families are separate because
agreement must not count a republished measurement twice.

Alignment hierarchy per observation, best first:

1. **Same benchmark** (canonical id measured by both the channel and the axis
   owner): fit offset from ≥3 overlapping models, and a least-squares slope
   shrunk halfway toward 1 only at ≥8 overlaps (`MIN_SLOPE_OVERLAP`,
   `SLOPE_SHRINK`). This is psychometric mean/linear equating and is the
   strongest calibration available.
2. **CompassRank table** (`ability` or `bench`, per dimension): offset-only,
   because the pooled pairs are not independent samples and a slope from four
   models is noise. This exists because a single dimension offset that mixed the
   two Compass tables was demonstrably wrong (the ability frontier sits near 78,
   the benchmark table much lower).
3. **Channel × dimension**: offset-only median shift against the axis. This is
   the pre-existing method; it is kept as a fallback and reported as the weaker
   option.
4. **Nothing.** Below three overlaps the observation is **not merged**; it is
   listed in `table.coverage.uncalibrated` with the models that carried it and
   in each affected model's `uncalibrated` list.

In today's catalog the census is: 184 observations used the axis directly, 126
same-benchmark equating, 40 the Compass table offset, 294 the dimension fallback,
and 21 were left uncalibrated (all 12 AA `mmmu` observations and 9 llm
`livebench-reasoning` observations, because those channels have fewer than three
overlapping models). Those are real gaps, reported rather than papered over.

What is **fitted** (and therefore reported with `n`, `mode`, `residualRms`,
`offset`, `slope`): the affine equating maps, and the AA-index→composite map used
only for provisional models. What is **averaged**: aligned observations within a
dimension after canonical deduplication. What is **never blended**: AA's
`intelligenceIndex`, Epoch's `eci`, the catalog's `quality`, `scores.overall`,
serving measurements, and derived facts.

### 3.4 One benchmark, one vote

Observations are grouped by canonical benchmark id. If GPQA arrives from the
Epoch hub row, from an AA row republished by BenchGecko, and from
llmleaderboard's `gpqa-diamond-aa`, the aligned values are averaged and the
group contributes **one** unit of evidence. Evidence per dimension is therefore
the number of distinct benchmarks, an integer:

```
dims[dim] = {
  estimate,        // mean of aligned canonical-benchmark values
  evidence,        // count of distinct canonical benchmarks (integer)
  confidence,      // evidence/(evidence+3) × agreement factor × calibration factor
  band,            // 6/√evidence + spread/2, clamped [2, 30]
  low/high,        // estimate ∓ band
  sources: [{ channel, family, canonical, raw, aligned, alignment }],
  families: { epoch-bench: 64.5, aa: 51.2, … },
  spread,          // max−min across independent families
  flags: ['single-source' | 'disagreement' | 'weak-calibration' | 'compiled-composite' | …],
  derived: null | 'context-window' | 'modalities' | 'latency-class' | 'aa-index-calibrated',
}
```

A **disagreement** flag is set when two or more independent families differ by
more than 12 points; a **weak-calibration** flag when a used fit has residual
RMS above 15. A single-source dimension is not a failure — it is one benchmark's
opinion, and the confidence formula says so.

### 3.5 The composite

```
composite = Σ w_d · estimate_d / Σ w_d   over measured core dimensions
w = { coding 0.25, reasoning 0.25, math 0.15, knowledge 0.15, agentic 0.20 }
band = weighted mean of dimension bands + 8 × (missing core dimensions)
rankValue = composite − band
```

Evidence = the sum of the core dimensions' evidence. Coverage = measured core
dimensions / 5. The missing-dimension charge is structural, not noise: a
composite over two of five dimensions is not comparable to one over all five.
The rank order is `rankValue` descending, then point composite, then evidence,
then price, then key — deterministic on identical input.

An index-only model (no core dimension measured, AA index > 0, index fit
available with ≥8 pairs) gets `provisional` status: composite from the fitted
index, evidence 1, `low = estimate − 20`, flags `index-only`, `provisional`; it
is listed and excluded from auto placement unless the operator opts in.

### 3.6 Price, speed, context, vision

- **Price** stays CNY. `priceOf()` returns input/output/cache-hit components, a
  1:2 blended number for comparability with `select.js`, a `cacheRatio`, and a
  `converted` flag when AA's USD quote was used. `cacheAdjustedPrice(price,
  rate)` prices a workload with a cache-hit rate; it is a calculator, not a
  ranking input, because the rate is operator knowledge.
- **Cost percentile** is data-derived: rank of blended price over every priced
  catalog entry (0 = cheapest, 100 = dearest). The absolute `costIndex` from
  `select.js` is still computed, because the *explicit* envelopes are documented
  in those terms.
- **Speed** is measured from TTFT and output tokens/s (`speedScore`, monotone
  log mapping); evidence = number of serving channels (1 or 2); the catalog's
  `scores.speed` prior is never read. With no serving data, speed has no
  estimate and the latency class is a derived fact with evidence 0.
- **longContext** uses a measured long-context benchmark if one exists;
  otherwise the log context-window mapping, evidence 0, `derived:
  'context-window'`.
- **vision** uses `mmmu` if measured; otherwise the modality flag, evidence 0,
  `derived: 'modalities'`. `hasVision` remains an independent fact for the hard
  filter.

### 3.7 Agreement across sources

`table.sourceAgreement` reports Spearman rank correlation of the composite
against:

- Epoch ECI (`n = 20`, ρ = 0.59 today) — interval scale, rank comparison only;
- AA intelligence index (`n = 17`, ρ = 0.53);
- CompassRank `average` (`n = 7`, ρ = −0.21 today — small n, and the one
  diagnostic in this table that suggests the Compass alignment needs another
  look before Compass is trusted as a rank);
- the AA-index calibration fit itself (`slope ≈ 0.67`, intercept ≈ 30.6, RMS
  ≈ 5.7 on 17 pairs).

None of these numbers enters a dimension. They are the evidence that the merge
is sane, and they are exactly what an operator needs when a source changes its
methodology.

### 3.8 Honesty limits, stated

- The axis is BenchGecko's normalized scale. BenchGecko normalizes leaf values
  itself; how it does that is not public, so the axis is "BenchGecko's opinion
  of 0-100", not a physical unit.
- BenchGecko is an aggregator; its leaf values come from Epoch/AA/LiveBench.
  Same-benchmark deduplication handles the double-counting where canonical ids
  line up, but BenchGecko category means (which `rank.js` does not use) can
  contain benchmarks the registry does not know.
- Alignment uses 3-8 overlap models in this catalog. A fitted slope is shrunk
  and needs 8; below that only an offset is fitted; below 3 nothing is merged.
  The calibration table reports every fit's `n` and residual, and
  `weak-calibration` flags the dimensions that inherited a noisy one.
- A dimension with one benchmark and no independent family is a single-source
  estimate. It is reported as such and discounted by confidence and band; it is
  not called consensus.
- The composite weights are the router's values, not a measurement.
- Family priors are not implemented. The existing `PRIOR` table
  (build:31-49) and its `K = 1.5` blending should be retired or moved behind an
  explicit `prior` source with evidence 0 and no ranking, if the operator wants
  to keep them.

---

## 4. Tier grouping design

### 4.1 What a tier is today

A tier is an envelope (`maxCost`, `maxLatency`, `minQuality`). With
`tiers.criterion: 'capability'` (the default) membership is the pool's capability
band, and the envelope's cost/latency ceilings are guardrails that move a model
up a band (or off when `deep` cannot pay). The `cost` criterion keeps the older
"cheapest tier that admits it" rule. Membership is model-level: provider/reseller
and serving-variant endpoints of one model are deduped to one capsule, withdrawn
ids never auto-place, and a newer generation supersedes its line. The names are
stable and operator-facing; `force <tier>` pins a tier, `defaultRoute` picks the
fallback tier, hand overrides win before auto placement, and same-family dominance
turns a clearly beaten model off.

What is wrong with it:

1. the ceilings are constants (`55/85/100`, `40/55/66`) from an older catalog,
   so a tier's membership is a price band with no relation to the current pool;
2. the board has no ordering, so "who is the best model in `balanced`" is not
   answerable from the plugin;
3. the envelope can admit nothing (today `deep` admits zero models under the
   explicit defaults once the new composite scale is used), which degrades to a
   widened selection that is logged but invisible in the board;
4. `minQuality` compares a point estimate, so a thin composite can clear it.

### 4.2 The proposal

Two layers that coexist:

**Layer 1 — membership ceilings, data-derived by default (opt-in).**

`derivedEnvelopes(table)` computes, over measured + priced models:

| Tier | `maxCost` (percentile of blended price) | `minQuality` (quantile of `rankValue`) | `maxLatency` |
|---|---|---|---|
| `fast` | 40th | 25th | `fast` |
| `balanced` | 75th | 50th | `balanced` |
| `deep` | 100th | 75th | `slow` |

and enforces monotonicity. `maxCost` carries `costAxis: 'percentile'` so the
check reads the percentile axis, while explicit envelopes keep the absolute
`costIndex` axis; the two never silently mix. Quality thresholds are quantiles
of the same lower-bound distribution the check uses, so "fast buys the bottom
quartile" stays true as the pool changes. Latency classes are not fitted — they
are operator-facing filters, and measured TTFT is exposed separately.

Coexistence policy:

- `envelopeMode: 'explicit'` (default) is exactly today's behaviour;
- `'merge'` starts from the derived envelope and lets every explicitly set field
  override field by field;
- `'derived'` ignores the shipped constants and uses the pool quantiles;
- hand overrides, `disabled`, `force <tier>`, `defaultRoute`, manual mode and
  same-family dominance all run unchanged. `force` still selects a *group by
  name*, and the group names are unchanged.

**Layer 2 — a visible ranking inside each tier.**

`planTiers()` returns `ranking[tier]`, `rankOf[key]` and `score` per member:
`rankValue − 0.15 × tierCostFactor × costIndex` (tier cost factors mirror
`select.js`'s `fast 1.6 / balanced 1 / deep 0.05`, so `fast` discounts dear
models harder and `deep` barely discounts price). This answers "which model does
this budget buy?" without changing how selection itself scores candidates.

The global table also exposes the non-dominated cost/capability frontier
(`paretoLayers`) and per-dimension ranks and bands (`dimRanks`, `dimBands` from
the dimension quantiles). The Pareto view is cross-vendor for display; the
disabling rule stays inside a family.

### 4.3 Today's result (diagnostic, not a decision)

With the shipped runtime catalog + the saved AA scrape and **derived**
envelopes:

- counts: 46 entries → 34 measured, 9 provisional, 3 unmeasured;
- derived ceilings: `fast ≤ p40 cost / rankValue ≥ 30 / latency fast`,
  `balanced ≤ p75 / ≥ 35 / balanced`, `deep ≤ p100 / ≥ 41 / slow`;
- groups: `fast` 5 (qwen3.7-flash, qwen3.8-flash, qwen3.6-flash,
  deepseek-v4.1-flash-1017, deepseek-v4.1-flash), `balanced` 3 (glm-5.3,
  glm-5.2, vanchin/deepseek-v4.1-flash-1017), `deep` 6 (qwen3.7-max, kimi-k3,
  kimi-k3.1-pro, qwen3.8-max, qwen3.8-2.4t-a95b, kimi/kimi-k3.1-pro);
- 9 provisional and 3 unmeasured are listed, not routed; 19 measured models fit
  no envelope and are off (unassigned), which is the envelope working as a
  constraint rather than a ranking;
- one same-family dominance: `deepseek-v4-pro` off, beaten by
  `deepseek-v4.1-flash-1017`;
- the `explicit` envelope mode places 1/1/0 under the old constants — see §5.

This is a *shadow* output: it should be logged next to the current selection and
diffed, not applied.

---

## 5. Integration plan (deliberately not done)

The prototype is pure data in, data out. Integration touches these files, in
order:

1. **`refresh.js`** — persist what the ranking needs and fix §2.8:
   - store AA per-benchmark percentages in
     `crossChecks.artificialAnalysis.benchmarks` (range-check `0 ≤ x ≤ 1` first,
     report the index-scaled fields separately);
   - store `cacheHitPrice`, `reasoning`, `openWeights`, `releaseDate` on the AA
     cross-check; use them for the created entries instead of the hard-coded
     `reasoning: false`;
   - require `intelligenceIndex > 0` before using it;
   - make the AA join exact-id and reported, never rename an entry from an AA
     row;
   - store BenchGecko leaf metadata (`category`, `source`) per label;
   - store the full CompassRank cross-check fields the compiler uses
     (`quantitativeReasoning`, `programmingAverage`, `scienceAverage`,
     `knowledgeWorkAverage`);
   - keep a raw AA row snapshot for audit (already exists in `data/`).
2. **`model-info.js`** — `applyDataset` can accept the `toCatalogPatch()` result:
   measured/derived scores with integer evidence, unmeasured dimensions keep the
   old number but zero evidence, `qualityLow` alongside `quality`.
3. **`index.js` / board** — replace `assignTiers(pool, routes, config.tiers)` at
   line 505 with `planTiers(table, ...)`, ship `ranking`, `dimRanks`,
   `dimBands`, `pareto`, `derivedEnvelopes` and the coverage/unmapped report to
   `client.js`; show `provisional`/`unmeasured` separately (the hints at
   `client.js:236-239` already exist).
4. **`select.js`** — read the patched scores/evidence; consider using
   `compositeLow` for the quality floor and adding the `weak-calibration` flag to
   its uncertainty penalty. This is a separate review because it changes ranking
   behaviour.
5. **`tiers.js`** — the dominance rule and family logic can be kept; `planTiers`
   reimplements them with the same precedence so the two can be diffed during
   the shadow period.
6. **`decision.js`** — the shipped envelopes `40/55/66` are on the old quality
   scale. Under the new composite (q25/q50/q75 = 46.5/50.3/56.6 for the point
   estimate, 30.1/36.3/41.6 for the lower bound) they are not comparable. Either
   adopt derived envelopes or re-author the defaults; the open question is §8.5.

Nothing here assumes enforcement: during `shadow`, both the existing selection
and `rankTable`/`planTiers` can be computed and logged, and the decision log can
record the rank, band, flags, coverage and calibration that produced them.

---

## 6. Prototype contents

[`src/rank.js`](../src/rank.js) — pure functions, no host imports, no network.
Data in, data out; local imports are `DIMENSIONS` and `costIndex` from
`select.js` and `TIER_IDS`, `familyOf` from `tiers.js` so dimension names,
cost scale and family rule have one source of truth.

| Export | Purpose |
|---|---|
| `rankTable(dataset, options)` | the whole table: per-model dimensions with provenance, composite, lower bound, features, ranks, Pareto, calibration, agreement, coverage, unmapped benchmarks |
| `classifyBenchmark(name, channel)` | benchmark → canonical id + dimension + origin family |
| `sourceObservations(entry, analysisRow)` | leaf measurements per channel |
| `fitAlignment(pairs, options)` | affine equating with overlap threshold and slope shrinkage |
| `quantile`, `spearman`, `contextScore`, `speedScore`, `priceOf`, `cacheAdjustedPrice` | small pure helpers |
| `derivedEnvelopes(table)` | data-derived ceilings |
| `fitsEnvelope`, `autoTierForModel` | envelope checks (`qualityBasis`, `costAxis`) |
| `planTiers(table, options)` | precedence, group membership, visible tier ranking, dominance |
| `paretoLayers(points)` | non-dominated layers for display |
| `toCatalogPatch(table)` | `scores`/`evidence`/`quality`/`qualityLow` patch for the selector |

Tests: 38, covering alignment refusal/shrinkage, deduplication, mixed AA scales,
the "evidence 0 is never a measurement" rule, disagreement flags, price
conversion, cost percentiles, provisional handling, lower-bound ranking, tier
precedence/derived/merge/dominance, the patch shape, and invariants over the
shipped runtime catalog.

---

## 7. Evidence to collect next (cheap, high value)

- Store BenchGecko `category` + `source` per leaf; then compare our registry
  against the publisher's taxonomy and report disagreements instead of choosing
  by hand.
- Store CompassRank's full `ability`/`bench` row; then the per-table alignment
  can be replaced by same-benchmark equating where overlap exists.
- Record `intelligenceIndex` only when `> 0`, and record `reasoning`,
  `openWeights`, `releaseDate`, `cacheHitPrice` from the raw AA table.
- Keep the raw AA table's `cacheHitPrice` so cache-aware pricing becomes a
  measured option rather than a calculator with an assumed rate.
- Snapshot the rank table daily next to the decision log; the diff over a week
  is a better review of the weights than any single run.

---

## 8. Open questions for the operator

1. **Axis owner.** Keep BenchGecko's normalized scale as the axis (current
   compiler's choice, but its taxonomy is inconsistent and it is an aggregator)?
   Or make the current compiled scores the axis and treat every source as
   evidence? The latter is circular but stable; the former is cleaner but trusts
   a publisher's normalization.
2. **The registry is editorial.** Who owns the benchmark→dimension mapping, and
   should `hle`/`gpqa`/`gdpval`/`chess puzzles`/`weirdml` stay where §3.2 puts
   them? This is the one place where the ranking's construct validity is a
   judgement, not arithmetic.
3. **Lower-bound ranking.** Rank by `composite − band` (so thin coverage loses)
   and charge 8 points per missing core dimension. Is that the right degree of
   conservatism, or should thin models be ranked on the point estimate and
   filtered from tiers instead?
4. **Composite weights.** `coding .25 / reasoning .25 / math .15 / knowledge .15
   / agentic .20` are the router's values. `select.js` already has per-shape
   weights; this composite is only for tier/rank. Confirm or replace.
5. **Envelope defaults.** Under the new composite, shipped `minQuality 40/55/66`
   admits almost nothing. Adopt `derivedEnvelopes` as the defaults (recommended),
   re-author explicit constants by hand, or keep explicit defaults and accept
   that the board is empty until the operator edits them?
6. **Derived quantiles.** Cost percentiles `40/75/100` and quality quantiles
   `25/50/75` on the lower bound are a starting point; with 34 measured models
   the quantiles are noisy (and will be staler for slow-changing capability than
   for price). Do you want tier membership recomputed on every refresh, and
   should the board snapshot the thresholds it used?
7. **AA variants and index-0.** Multiple AA rows per model (reasoning effort)
   are currently resolved by "most benchmarks, then highest index". Is that the
   right pick, or should the catalog pin the row matching the provider's actual
   inference setting? Confirm that an index of 0 should be treated as
   "unranked" everywhere.
8. **Provisional models.** Keep them listed but unrouted by default (current),
   or allow the calibrated index to place them in `deep`? The nine provisional
   entries in today's catalog are mostly provider duplicates of measured models,
   so the practical impact is small.
9. **Legacy `quality`.** Should it remain as a cross-check (it is still the
   `index.js` sort key and the `tiers.js` measured test), or be removed once the
   patch is integrated? If it stays, it must never be able to make a model
   "measured" on its own.
10. **Family priors.** The `PRIOR` table and `K = 1.5` blend are still in the
    build. Retire them, or keep them behind an explicit `prior` source with
    evidence 0 and no ranking eligibility?
11. **Cache pricing.** Should ranking adopt a cache-aware blended price with a
    configured cache-hit rate (changing the cost axis), or stay on the 1:2 list
    blend and expose the calculator only?
12. **Provider duplicates.** `provider/model` identity means
    `deepseek-v4.1-flash-1017` and `vanchin/deepseek-v4.1-flash-1017` are two
    entries with different derived quality. Should the refresh dedupe knowledge
    lookups across providers serving the same catalog, or keep independent
    estimates?
13. **Epoch recency.** ECI rows carry dates from different months. Should old
    evaluations be down-weighted or only reported?
14. **`force <tier>` and empty tiers.** Today `force deep` on an empty group
    widens to the default and logs it. With derived envelopes the emptiness
    becomes visible; should `force` onto an empty tier fail loudly instead of
    widening?
