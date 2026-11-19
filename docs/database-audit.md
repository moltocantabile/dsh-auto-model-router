# Database audit and reconstruction

Audit performed 2026-11-19 against the committed tree. The runtime catalog was
rebuilt from the bundled baseline plus the live sources; nothing was committed.
The two measurement defects deferred by the previous round are fixed with
regression tests.

## 1. Scope and method

Files audited:

- `data/model-info-runtime.json` — the live catalog every consumer reads
  (69 entries before, see §8 for the rebuilt count).
- `data/routing-derived.json` — the tier envelopes derived from that catalog.
- `src/model-info-data.json` — the bundled baseline catalog (17 hand-authored
  entries). Read as the reconstruction base; not edited by this audit.
- `data/artificialanalysis.json` — a scraped Artificial Analysis table, kept as
  an audit snapshot (the runtime refresh reads the live page instead).
- `data/benchgecko-extracted.json` + `data/benchgecko-raw/` — the BenchGecko
  captures the baseline was compiled from.
- `data/compass-rank-*.json` — CompassRank board captures.
- `data/catalog-pool.json` — **new**: the provider catalog captured from the
  host, the list of ids the providers actually advertise.

Pipeline modules read and exercised: `src/refresh.js` (all source passes and the
`refreshCatalog()` orchestration), `src/model-data-build.js` (the compiled legacy
scores), `src/model-info.js` (load/lookup/apply), `src/rank.js` (ranking: read,
not modified — the audit found no defect in it).

The contract applied, from the brief and the previous round:

1. A zero from a source means **not measured**, never a score.
2. Measures are compared only on one basis: ranking `low`, then `composite`, then
   the legacy compiled `quality` only when no ranking exists.
3. Identity is `provider/model`. Twin ids are allowed. Model tiers
   (`flash`/`max`/`mini`/`turbo`/`lite`/`next`/`prime`) are different models;
   only effort/serving variants and dates may be ignored.
4. Prices are CNY per 1M tokens in the catalog; Artificial Analysis quotes USD
   and is converted at one stated rate (`PRICE_CNY_PER_USD = 7.2`).

"Before" means the committed `data/model-info-runtime.json`. "After" means the
reconstructed catalog written by `scripts/refresh-database.mjs` on 2026-11-19.

## 2. Invariant checklist

| Invariant | Before | After | Enforcement |
|---|---|---|---|
| Every entry carries the nine dimensions | pass (69/69) | pass (66/66) | completion pass in `attachArtificialAnalysis`; `tests/model-info.test.mjs` |
| Every evidence count is an integer ≥ 0 | pass (69/69) | pass (66/66) | same |
| Context window present and positive | **fail — 23 entries had `contextWindow: 0`** | pass (0) | AA model-page extraction now reads `contextWindowTokens`; an unknown capacity is `null`, not `0` |
| Latency class ∈ {fast, balanced, slow} | pass (69/69 in set) | pass (66/66 in set) | class derivation from measured TTFT/tokens-per-second; `balanced` for an AA-created entry with no serving row |
| Price is CNY/1M and AA USD is converted at one rate | pass | pass | price fill only when the catalog has none, `round1(usd × 7.2)`; no mixing |
| A zero is never a score | **fail — 206 zero AA benchmark values, 2 zero BenchGecko leaf values, 2 BenchGecko category means polluted by zeros, 52 AA-index→quality artefacts** | pass (0 stored zeros from either extractor) | extractors drop zeros; consumer-side guards stay |
| Label names the entry's own model | **fail — 6 entries** | pass (0) | identity guard on every name-based join; `labelForId()` for AA-created labels |
| No entry without an advertised id | **fail — 1 orphan** (`deepseek-v4-flash`, a legacy alias no provider advertises) **and 3 entries were labelled from another model** (`glm-5.3-prime`, `ZHIPU/GLM-5.3-FlashX` from a GLM-5.3 row; `vanchin/deepseek-v3` from a V3.2 row) | 1 retained legacy alias (`deepseek-v4-flash`, see §11) | reconstruction from the advertised pool |
| Duplicate/twin ids allowed, no accidental merge | pass after rekey (twins share rows) | pass | `nameIndexAll` resolves one name to every id; per-id fills |
| Cross-source disagreement reported | partial | partial (see §9) | rank-table `sourceAgreement` + `uncalibrated` counts; per-dimension disagreement flags are computed but not persisted (gap, §11) |
| Usage percentile reflects the ranks the catalog carries | latent fail (the committed catalog happened to have no multi-row keys; the first rebuild produced 46/55 wrong) | pass | percentile computed from final per-entry ranks, not from all fetched rows |
| `routing-derived.json` matches the catalog it was derived from | pass | pass | recomputed from the written catalog on every refresh; script writes both atomically |
| AA index is fitted on the ranking basis, not legacy `quality` | **fail** | fixed — the fit is gone from `refresh.js`; `rank.js` fits AA index→composite for provisional entries only | see §5 |
| Epoch / llmleaderboard joins cannot cross generations | **fail** | fixed — label must corroborate the row; creation uses the identity rule | see §6 |

## 3. Data-file integrity findings

### 3.1 `data/model-info-runtime.json` (before)

- 69 entries, 67 measured, 2 unmeasured, 0 provisional; 57 with OpenRouter
  usage; 550 uncalibrated observations.
- **52 entries were Artificial-Analysis-only**, all carrying a compiled
  `quality` that no source measured (all nine `scores` equal, every `evidence`
  0). The values came from the AA-index→legacy-`quality` calibration, whose fit
  fell back to hard-coded coefficients when its overlap set dropped below five
  models (27.4 is the old zero-index floor; the range runs 27.4–78). Examples:
  `kimi-k3.1-pro` quality 75.8 (measured composite ~53), `stepfun/step-3.7-flash`
  68, `qwen3.8-2.4t-a95b` 27.4.
- 23 AA-page-created entries claimed `contextWindow: 0`.
- 206 zero AA benchmark values, 4 zero AA raw scores and 2 zero BenchGecko leaf
  values were stored as if measured; two BenchGecko category means were pulled
  down by a "not run" zero (`qwen3.6-flash` math 39.5 instead of 49.3).
- 6 labels named a different model than their id: `glm-5` and `ZHIPU/GLM-5`
  labelled "GLM-5.3 (Max)", `glm-5.3-prime` and `ZHIPU/GLM-5.3-FlashX`
  labelled "GLM-5.3 (Max)", `siliconflow/deepseek-v3-0324` labelled "DeepSeek
  V4.1 Flash 1017 (Max)", `vanchin/deepseek-v3` labelled "DeepSeek V3.2
  (Reasoning)".
- Usage percentiles were computed over the list of *fetched rows*, not the
  ranks the entries finally carry (one catalog key can be matched by several
  OpenRouter rows; the last write wins, but every fetched row was counted). The
  committed catalog escaped it because no key had multiple rows; rebuilding from
  the baseline produced a key with two matches and 46 of 55 percentiles came out
  understated.
- No ranking drift against `rankTable()` and no `routing-derived.json` drift:
  the committed ranking and envelopes are exactly what the code computes from
  the committed catalog.

### 3.2 `data/routing-derived.json`

Consistent with the catalog: the recomputed envelopes (sample 66, fast cost ≤ 67
quality ≥ 15, balanced ≤ 80 quality ≥ 24, deep ≤ 100 quality ≥ 31) matched the
file byte for byte. It is a product, and the reconstruction writes it together
with the catalog it describes.

### 3.3 `src/model-info-data.json` (bundled baseline, 17 entries)

Schema-complete; nine dimensions with integer evidence; every priced entry in
CNY; no duplicate ids. Two entries have `quality: null` (`deepseek-v4-flash`,
`qwen4-max-preview`) and are unmeasured, which matches the ranking contract. The
baseline was **not** rebuilt: it is the hand-authored starting point (prices,
limits, modalities, notes) and `scripts/build-model-info.mjs` compiles the
benchmark scores into it — that file is outside this audit's edit scope. Its
numbers are therefore the pre-audit captures; the runtime catalog is rebuilt from
the live sources on top of it.

### 3.4 `data/benchgecko-extracted.json` + `data/benchgecko-raw/`

- 16 extracted models, but only 11 raw captures: 5 extracted records could not be
  reproduced from the committed tree. `scripts/scrape-benchgecko.mjs` now
  refreshes every known slug, writes the raw response and rebuilds the
  extraction, so every extracted record has its source document. The missing 5
  were captured during this audit.
- The extraction now drops zero scores from category means, leaf maps and
  evidence counts (`qwen3.6-flash` math 39.5 → 49.3). Raw captures keep the
  zero as published.
- The extractor also keeps the API's `priceUsd` and `geckoTests` records, which
  the compile path ignores but the committed capture recorded; without them a
  re-capture silently dropped fields.

### 3.5 `data/compass-rank-*.json`

`compass-rank-2026-11-18.json` uses a legacy layout: table averages are
unprefixed (`Programming`, `Average`) and the ability table carries the deep
sub-abilities, while the current `extractCompass()` produces
`Programming.Average` and only the top-level abilities. `scripts/fetch-compass-rank.mjs`
captured the current layout as `compass-rank-2026-11-19.json`; the build script
now picks the newest capture. The compiler reads the fields that are present in
both layouts, so nothing breaks; the 11-18 file is a historical capture.

### 3.6 `data/artificialanalysis.json`

Shape matches `scripts/scrape-artificialanalysis.mjs` (283 models, 120 with an
intelligence index, 176 priced). It is an audit snapshot: the runtime refresh
fetches the live page and does not read this file. Zeros in the scrape are
"unranked" as published; the extractor refuses them.

## 4. Pipeline correctness: what the real refresh does

### 4.1 A refresh from the committed catalog reproduces it

`refreshCatalog({ base: committed, wanted: provider pool })` produced the same 69
entries with no source errors; the only differences were OpenRouter token counts
(the live weekly table had moved). So the committed catalog is exactly what the
current code produces from itself. That is not a clean bill of health: it means
every defect in it was inherited, not transient — fixing the code alone cannot
repair the file. The database had to be rebuilt from the baseline.

### 4.2 A refresh from the bundled baseline (the reconstruction)

`node scripts/refresh-database.mjs` (base `src/model-info-data.json`, pool
`data/catalog-pool.json`, live sources):

- 66 entries: 17 rebuilt baseline entries + 49 created from Artificial Analysis
  rows for advertised ids the catalog never described.
- **What changed:** 43 invented legacy qualities removed; 22 context windows
  filled (0 → the AA capacity); the 5 wrong-model labels repaired and one
  removed entry's label gone with it; 212 stale zero measurements dropped;
  Epoch cross-checks 46 → 46 and llmleaderboard 31 → 32 entries (the three
  removed entries lost theirs, the fixed name index restored the dated and
  serving variants; the first reconstruction attempt showed only 13/8 — see the
  ordering defect below); rankings and envelopes re-derived; the legacy-quality
  distribution used for floor translation is now the 15 real compiled scores
  instead of 67 (52 of which were AA artefacts).
- **What was lost:** 3 entries whose advertised id no source describes
  (`glm-5.3-prime`, `ZHIPU/GLM-5.3-FlashX`, `vanchin/deepseek-v3`); usage
  coverage 57 → 55 (two removed/rekeyed entries had a row). Nothing measured was
  dropped: 65 of 66 entries stay `measured`.
- **What is invented:** AA-created entries still assume `modalities: ['text']`
  and `toolCalling: true` (AA publishes neither), and `latency: 'balanced'` when
  no serving row exists. No capability score is invented any more; the ranking
  measures what the observations support and leaves the rest unmeasured.

### 4.3 Ordering and name-index defects found while reconstructing

The Epoch / llmleaderboard passes ran **before** the Artificial Analysis pass
that creates entries for advertised models, and their name index only covered the
base catalog. A model created during the same refresh therefore could not receive
its own Epoch or llmleaderboard row (the first reconstruction attached 13/8;
the finished pipeline reaches 46/32). An advertised id with a date or serving suffix
(`qwen3.7-plus-2026-05-26`, `kimi/kimi-k3.1-pro-highspeed`) additionally had no
spelling a source row could hit even after being indexed.

Fixed in `refreshCatalog()` and `nameIndexAll()`: the creation pass runs before
the cross-check passes, the advertised ids are indexed, and each advertised id is
also indexed under its family spelling (release date or effort/serving suffix
removed, version digits and tier words kept). That restored Epoch coverage for
the dated and serving-variant entries without loosening the identity rule.

Regression tests: *a model created from an AA row still receives its Epoch and
llmleaderboard cross-checks*; *an advertised id with a date or serving suffix
joins its model by name*.

The family spelling is scoped to the Epoch and llmleaderboard joins, not to the
Artificial Analysis join. Enabling it for AA too was measured: it raised the
AA/axis overlap from 4 to 6 models, which is the threshold that switches on the
dimension-level fallback (the weakest alignment, residual RMS 16-18). Under that
setting 408 observations were merged via the fallback, uncalibrated observations
fell to 84, and Epoch agreement fell from ρ ≈ 0.66 to ρ ≈ 0.22. The fallback is
the engine's documented last choice; whether to accept that trade — more coverage
against a weaker equating — is a policy decision, not an audit finding (§11).

## 5. Deferred defect 1 — AA index calibrated on the demoted legacy `quality`

**Evidence.** `attachArtificialAnalysis()` fitted AA's intelligence index to
`base[id].quality`, the compiled legacy score, and wrote the result into every
entry AA had measured but the catalog had not scored. The fit ran on the few
entries that had both: in the committed catalog 5 pairs (slope 0.37, intercept
52.34). Rebuilding from the bundled baseline left 4 pairs, so the hard-coded
fallback (`slope 1.6, intercept 20`) was used instead and minted qualities from
11.2 to 100 for 46 entries — `kimi-k3.1-pro` read 95.4 while its measured
composite is ~53. The committed catalog still carries the values earlier runs of
the same fit wrote: 52 of its 69 entries were Artificial-Analysis-only and all 52
had a finite `quality` (range 27.4–78, e.g. `qwen3.8-2.4t-a95b` 27.4 — the old
zero-index floor — and `kimi-k3.1-pro` 75.8). The legacy `quality` is used by the
hand-written floor translation, so an artefact on that scale leaked into a
routing-adjacent decision.

**Fix.** The fit and the quality fill are removed from `refresh.js`.
`rank.js` already owns the AA-index fit on the correct basis: it fits the index
to the measured composite for entries with no per-dimension measurement and
marks them `provisional` (minimum 8 overlap pairs, `MIN_INDEX_FIT`). The refresh
now stores AA's measurements (index, benchmark percentages, price, serving) and
writes no capability score. The legacy `quality` field is written only by
`model-data-build.js` from the two benchmark passes.

**Tests.** `tests/artificialanalysis.test.mjs`:

- *an AA index does not invent a legacy quality* — an existing legacy score is
  left alone, no second fit exists, the summary count reports AA measurements.
- *a benchmarked model without an index keeps its observations and gets no
  invented score* — no derived quality; the ranking refuses to measure without a
  calibratable channel.

## 6. Deferred defect 2 — joins attached a row from another generation

**Evidence.** `vanchin/deepseek-v3` (the 2024 V3 id) was labelled "DeepSeek V3.2
(Reasoning)" by an old fuzzy AA match, and its Epoch cross-check was
`eci 131.7, date 2024-12-26` — the 2024 V3 evaluation of a V3.2-labelled entry.
The join resolved a source row by catalog id (correct for the id) while the
entry's label named the next generation. The same class produced
`siliconflow/deepseek-v3-0324` labelled "DeepSeek V4.1 Flash 1017 (Max)" and
`glm-5`/`ZHIPU/GLM-5` labelled "GLM-5.3 (Max)".

**Fix.**

- Every name-based join (`extractArtificialAnalysis`,
  `extractArtificialAnalysisModelPage`, `extractEpochEci`,
  `extractLlmComparison`, `extractLlmBenchmarkPage`) requires the row to name
  both the id **and** the entry's label (`labelAgrees`). Parenthetical effort
  qualifiers are ignored on both sides; a version digit or tier word is not.
  A row that matches only one of the two is reported as ambiguous and not
  attached.
- The entry-creation path uses the same identity rule (`sameModelName`) instead
  of a prefix `startsWith` that accepted "deepseekv32" for "deepseekv3".
- Created labels are built by `labelForId()`: it drops AA's inference-setting
  parenthetical and a release-date token the id does not pin, so a rolling alias
  is not named after one snapshot.

**Tests.** `tests/artificialanalysis.test.mjs`:

- *Epoch does not hand a mislabelled entry a different generation's ECI*
- *llmleaderboard does not attach a cross-generation serving row*
- *a benchmark board row follows the same generation guard*
- *the AA multi-id fill applies the same label guard*
- *a different generation is never created under an id that names another*
- *a serving-tier suffix is the same model, a model tier is not*
- *an alias is not labelled with a dated snapshot it does not pin*

`tests/refresh.test.mjs`:

- *a model page does not overwrite the leaderboard row for a model it happens to
  embed* and *an effort variant does not replace the model's own row as the
  name match* (both regressions found while validating the fix).

## 7. Regeneration procedure

The runtime catalog is a product of the baseline, the advertised pool and the
sources. It can be rebuilt end to end:

```bash
# 1. Capture the provider catalog the host advertises (input, kept in data/).
node scripts/capture-catalog-pool.mjs                  # -> data/catalog-pool.json

# 2. Re-capture the raw source extracts the bundled baseline is compiled from.
node scripts/fetch-compass-rank.mjs                    # -> data/compass-rank-<date>.json (newest wins)
node scripts/scrape-benchgecko.mjs                     # -> data/benchgecko-raw/, data/benchgecko-extracted.json
node scripts/scrape-artificialanalysis.mjs             # -> data/artificialanalysis.json (audit snapshot)

# 3. Compile the baseline (run by a human; outside this audit's edit scope).
npm run build:data                                     # src/model-info-data.json
node scripts/build-model-info.mjs

# 4. Rebuild the runtime catalog and the derived envelopes from live sources.
node scripts/refresh-database.mjs                      # -> data/model-info-runtime.json
                                                       #    data/routing-derived.json
                                                       #    data/refresh-report.json

# Dry run (fetch, print counts, write nothing):
node scripts/refresh-database.mjs --dry-run
```

Sources and endpoints:

| File | Endpoint(s) |
|---|---|
| `data/model-info-runtime.json`, `data/routing-derived.json` | CompassRank: `https://cdn.opencompass.org.cn/assets/lm/data-lm-ability_official.json` and `..._benchmark.json`; BenchGecko: `https://benchgecko.ai/api/v1/models/<slug>`; Epoch: `https://epoch.ai/data/eci_scores.csv`; llmleaderboard: `https://llmleaderboard.com/api/models/comparison.csv` plus `/benchmarks/<page>`; Artificial Analysis: `https://artificialanalysis.ai/leaderboards/models` plus `/models/<slug>`; OpenRouter: `https://openrouter.ai/api/frontend/v1/models/find?order=top-weekly` |
| `data/benchgecko-raw/`, `data/benchgecko-extracted.json` | BenchGecko API, one document per slug |
| `data/compass-rank-<date>.json` | CompassRank CDN boards |
| `data/artificialanalysis.json` | Artificial Analysis leaderboard page (RSC flight stream) |
| `data/catalog-pool.json` | host provider catalog (`llm.listModels`), captured from the composed provider config |

Kept by hand, and why:

- `src/model-info-data.json` — prices, limits, modalities, qualitative notes. No
  source publishes Bailian's CNY list prices or the routing notes; the benchmark
  scores in it are compiled.
- `data/catalog-pool.json` — the advertised id list is deployment state, not a
  benchmark endpoint. It is captured from the profile and committed so the
  refresh is reproducible; on a different profile, re-capture it.
- `NAME_ALIASES` and `EFFORT_VARIANTS` in `src/refresh.js` — editorial identity
  rules, not data.

The refresh refuses to write when any source fails (`--allow-errors` overrides),
so a committed catalog is never a partial build. `data/refresh-report.json`
records the counts, the source list, the calibration diagnostics and the
uncalibrated/unknown benchmark census for the run that produced it.

## 8. Before / after counts

| Measure | Before | After |
|---|---|---|
| Entries | 69 | 66 |
| Measured | 67 | 65 |
| Provisional | 0 | 0 |
| Unmeasured | 2 | 1 |
| Entries with OpenRouter usage | 57 | 55 |
| Entries with Epoch ECI | 46 | 46 |
| Entries with llmleaderboard data | 31 | 32 |
| Entries with CompassRank cross-check | 7 | 7 |
| Entries with Artificial Analysis cross-check | 57 | 54 |
| Uncalibrated observations | 550 | 562 |
| Entries carrying a legacy `quality` | 67 | 15 |
| AA-derived legacy qualities (invented) | 52 | 0 |
| Entries with `contextWindow: 0` | 23 | 0 |
| Stored zero measurements | 212 | 0 |
| Labels naming a different model | 6 | 0 |
| Entries with no advertised id | 1 (retained legacy alias) | 1 (retained legacy alias) |
| Usage percentiles inconsistent with carried ranks | 0 (latent bug; 46 in the first rebuild) | 0 |
| Derived envelope sample | 66 | 64 |
| Derived envelopes (cost index / quality floor) | 67 / 15, 80 / 24, 100 / 31 | 67 / 22, 79 / 26, 100 / 29 |

The derived envelope sample drops from 66 to 64 because the reconstruction has
64 measured *and priced* entries.

## 9. Honesty of coverage

The rebuilt catalog reports what it can support and no more:

- **66 entries, 65 measured, 1 unmeasured.** The single unmeasured entry is
  `qwen4-max-preview` (a preview model with no published benchmark row, preserved
  from the baseline as `preview`). No entry is `provisional`: every advertised
  model AA indexed also had enough benchmark observations to be measured on at
  least one dimension.
- **Uncalibrated observations: 562 of 1094** (518 from Artificial Analysis, 44
  from llmleaderboard). They are listed per channel, canonical benchmark and
  dimension in `data/refresh-report.json` (27 groups). They are not merged
  because the alignment fit has fewer than 3 overlapping models on that
  benchmark (same-benchmark equating) or fewer than 6 on the dimension-level
  fallback. Why the overlap is thin:
  - **Data availability:** BenchGecko — the axis owner — covers only 12 of the
    66 entries; Artificial Analysis covers 54. Many AA benchmarks (frontiercode,
    terminal-bench variants, critpt, mmmu, …) therefore have no accepted partner
    on the axis. Capturing more BenchGecko models is the fix, not lowering the
    threshold.
  - **Code decision:** the refusal thresholds (`MIN_ALIGN_OVERLAP = 3`,
    `MIN_DIMENSION_OVERLAP = 6`) are deliberate. Below them the fit is a guess;
    those observations are reported instead of used.
  - The largest groups are AA `terminal-bench` (96 models), `critpt` (70),
    `automationbench` (39), `frontiercode` (38), `ifbench` (32), `tau2` (31),
    `gdp-pdf` (29), `mmmu` (25), `omniscience-*` (21 each); and
    llmleaderboard's `livebench-*` tracks (12 each).
  - Calibrated observations: 225 from BenchGecko (the axis owner, all used),
    46 CompassRank, 216 Artificial Analysis, 45 llmleaderboard.
- **Advertised but absent:** the pool has 159 routable ids; 66 have an entry.
  The remaining 93 are mostly legacy Qwen 1.5/2.x and specialised endpoints
  (rerank, translation, speech, omni) that the plugin's routable filter
  (`src/index.js`) does not exclude and that neither Benchmark source describes.
  That is a data-availability gap, plus the filter's own blind spots (e.g.
  `speech-*`, `*-rerank`, `qwen-mt-*` pass `NON_ROUTING_PATTERN`).
- **Advertised with no describable source (3):** `glm-5.3-prime`,
  `ZHIPU/GLM-5.3-FlashX`, `vanchin/deepseek-v3`. Their previous entries existed
  only because a fuzzy match had attached another model's row. They are omitted
  rather than fabricated; see §11.
- **Source agreement** (orthogonal diagnostics, never blended):
  Epoch ECI vs composite ρ = 0.32 (n = 46 entries; 0.37 after collapsing the
twin ids that share one ECI), AA index vs composite ρ = 0.58 (n = 20),
  CompassRank average vs composite ρ = 0.64 (n = 7). The AA-index fit used for
  provisional entries is `slope 0.55, offset 33.32, RMS 3.95` on 20 pairs.
  Epoch agreement is materially lower than the committed catalog's 0.66, and the
  movement is concentrated in AA-created twins whose observation set changed
  when the fuzzy AA joins were replaced by the strict identity rule: 4 of the
  13 twin groups now differ by more than 4 composite points (one by 10.3). The
  engine already keeps twin estimates independent (documented open question
  `docs/data-utilization.md` §8.12); the drop is reported here because it is the
  one diagnostic that says the reconstructed ordering is less externally
  consistent, and it is a candidate for a ranking-policy review — not a score
  input.
- **Usage:** 55 of 66 entries have an OpenRouter weekly rank; percentile is the
  rank among the 42 distinct ranks the catalog actually carries.

## 10. Entries removed, rekeyed, repaired

**Removed (3)** — advertised ids no current source describes; each old entry
carried another model's labels/measurements:

| Id | Old label | Why removed |
|---|---|---|
| `glm-5.3-prime` | GLM-5.3 (Max) | AA has no such model; the row was the base GLM-5.3 (Max). Identity is a different model (tier word `prime`). |
| `ZHIPU/GLM-5.3-FlashX` | GLM-5.3 (Max) | AA has no FlashX row; the old entry borrowed GLM-5.3's. |
| `vanchin/deepseek-v3` | DeepSeek V3.2 (Reasoning) | The label named V3.2 while the id is the 2024 V3; the Epoch row (2024-12-26) was correct for the id and wrong for the label. No source describes this advertised endpoint now. |

**Rekeyed (6, not removed)** — same models, keyed by the advertised id's lower
case instead of the previous mixed-case key, because the creation path keys by
the lowercase id it is given: `MiniMax/MiniMax-M3` → `minimax/minimax-m3`,
`MiniMax/MiniMax-M3.1-Flash` → `minimax/minimax-m3.1-flash`,
`ZHIPU/GLM-5.3` → `zhipu/glm-5.3`, `ZHIPU/GLM-5.3-Flash` →
`zhipu/glm-5.3-flash`, `antdigital/Ling-3.1-flash` →
`antdigital/ling-3.1-flash`, `ZHIPU/GLM-5` → `zhipu/glm-5` (and relabelled from
GLM-5.3 to GLM-5).

**Labels:** 24 surviving entries gained a different label. The table below
lists every wrong-model or unpinned-snapshot label: 4 surviving entries were
repaired and 3 entries were removed. The other 19 label changes are Artificial
Analysis-created entries losing AA's inference-setting qualifier
(`Kimi K3 (Low)` → `Kimi K3`, `GLM-5.2 (Non-reasoning)` → `GLM-5.2`,
`DeepSeek V4 Pro 0813 (High)` → `DeepSeek V4 Pro 0813`): the setting is not part
of the model's identity, so a stable label does not pin whichever variant AA
happened to publish first.

**Wrong-model or unpinned-snapshot labels (7 entries):**

| Id | Before | After |
|---|---|---|
| `glm-5` / `ZHIPU/GLM-5` | GLM-5.3 (Max) | GLM-5 (Reasoning) — now keyed `zhipu/glm-5` |
| `glm-5.3-prime` | GLM-5.3 (Max) | entry removed |
| `ZHIPU/GLM-5.3-FlashX` | GLM-5.3 (Max) | entry removed |
| `siliconflow/deepseek-v3-0324` | DeepSeek V4.1 Flash 1017 (Max) | DeepSeek V3 0324 |
| `vanchin/deepseek-v3` | DeepSeek V3.2 (Reasoning) | entry removed |
| `vanchin/deepseek-v4.1-flash` | DeepSeek V4.1 Flash 1017 (Max) | DeepSeek V4.1 Flash |
| `vanchin/deepseek-v4-pro` | DeepSeek V4 Pro 0813 (Max) | DeepSeek V4 Pro |

**Repaired data (all 66 entries):** context windows filled from AA where the
entry had `0` (22 entries); zero observations dropped from AA and BenchGecko
payloads; AA-invented legacy qualities removed (43); usage percentiles
recomputed; ranking and derived envelopes recomputed; Epoch/llmleaderboard
cross-checks re-attached by the fixed joins (46/32 entries).

## 11. Residual issues and human decisions

1. **`deepseek-v4-flash` is retained although no configured provider advertises
   it.** It is a legacy alias in the bundled baseline, kept so an old configured
   route still resolves. Removing it would require editing the baseline, which
   is outside this audit's scope. Decision: keep it flagged, or drop it in a
   baseline rebuild.
2. **Three advertised ids now have no entry.** Omitting them is honest but they
   become invisible to the router. If the operator wants them described, a
   source has to describe them (they cannot be reconstructed from AA today).
3. **`modalities`/`toolCalling` on AA-created entries are assumptions**
   (`text`, `true`). AA publishes neither. A multimodal model described only by
   AA will not be offered for vision tasks, and a text-only model described only
   by AA claims tool support it may not have. This is a data gap, not a code
   defect that can be fixed without a modality source.
4. **Latency class vs measured serving.** Two entries' operator class disagrees
   with the AA serving measurement (`deepseek-v4.1-flash-1017` says `fast`,
   measured TTFT 1.28 s; `deepseek-v4-pro-0813` says `slow`, measured TTFT 2.43 s
   against a 3 s `balanced` cut-off). The class stays an operator-facing filter
   (`select.js` documents this); `ranking.dims.speed` carries the measurement.
   Decide whether the class should be re-derived from measurements.
5. **Context-window disagreements (2).** `qwen4-max` catalog 1,000,000 vs AA
   983,616; `glm-5.3` 1,048,576 vs AA 1,000,000. The provider-declared value is
   kept because it is the hard filter's real limit; the AA value is in the
   cross-check.
6. **Per-dimension source-disagreement flags are computed but not persisted.**
   The rank table exposes them per refresh; the catalog keeps only the integer
   `uncalibrated` count per entry. Persisting the flags would let the board show
   *why* a dimension is weak. Not changed here (the client does not read them
   yet; `rank.js` is out of the audit's change budget).
7. **`src/model-info-data.json` was not rebuilt.** The committed extract files
   are fresher than the compiled baseline and the Compass capture format moved;
   running `npm run build:data` would recompile it. Do that in a separate change
   that reviews the resulting score shifts.
8. **`data/compass-rank-2026-11-18.json` is a legacy-layout capture.** It is
   kept for provenance; the build script now uses the newest capture. Consider
   retiring it or converting it to the current layout.
9. **Twin ids carry independent estimates.** `provider/model` identity makes
   the twins legitimate, but a reseller entry measured only by Artificial
   Analysis and the canonical entry measured by BenchGecko/CompassRank can
   differ by up to 10 composite points (13 groups; median spread 0). This was
   already true of the committed catalog and is the open question in
   `docs/data-utilization.md` §8.12. Decide whether the refresh should merge
   knowledge across providers of the same model or keep independent estimates.
10. **Whether to widen the AA join.** The family-spelling expansion that fixes
    Epoch/llmleaderboard coverage also raises AA↔axis overlap to the
    dimension-fallback threshold; measured effect in §4.3. Enabling it for AA is
    a one-line change (`nameIndexAll(base, wanted)` for the AA passes),
    deliberately not made here because it trades coverage for a weaker equating
    and drops Epoch agreement.

## 12. Tests

Every code change above carries a regression test. The two audited test files
hold 52 tests (36 before; 3 rewritten, 16 added) — `tests/refresh.test.mjs` (14)
and `tests/artificialanalysis.test.mjs` (38). The full suite passed at handoff
(268 tests, including the concurrent decision-log work); the Lead runs the final
combined suite.

## Addendum — Lead decisions on §11

The three advertised ids this audit removed are kept, as the operator asked:

- `glm-5.3-prime`, `ZHIPU/GLM-5.3-FlashX`, `vanchin/deepseek-v3` are hand-authored
  stubs in `src/model-info-data.json` with no scores, price, modality or tool
  claim. They appear on the board as `unmeasured` (not routable) instead of
  vanishing, and any future source description fills them through the normal
  pipeline. Catalogue after the rebuild: 69 entries, 65 measured, 4 unmeasured
  (the three stubs plus `qwen4-max-preview`).

Unknown facts are marked unknown:

- `modalities` and `toolCalling` are now inherited from another entry describing
  the same model when one exists (baseline or another catalog entry), and read
  from Artificial Analysis' model-page input-modality flags when that page
  publishes them. When no source has them, the fields stay absent — 27 entries
  currently carry unknown modalities — and `contextWindow`/`price`/`reasoning`/
  `latency` are explicitly `null` so a reader can tell "unknown" from "never
  existed". The old `modalities: ['text']`, `toolCalling: true` defaults are gone.

The two join policies were built and compared:

- `node scripts/refresh-database.mjs --family-join` enables family spellings for
  the Artificial Analysis join (`joinFamilyForAnalysis` in `refreshCatalog`).
- Both builds produced 69 entries / 65 measured / 4 unmeasured and *identical*
  composites, ranks and sanity checks (Epoch ρ 0.31, Compass ρ 0.64, AA-index
  ρ 0.55); the family join only added five AA cross-checks without changing an
  observation. Strict spelling is therefore the default — it moves no number and
  keeps the identity rule tight — and the option stays for future measurement.

Regeneration after this addendum: `node scripts/refresh-database.mjs`.
