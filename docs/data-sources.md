# Task-type data sources

This document records where the router's task-type signals come from, what each
payload looks like, how it is mapped into the catalog and the ranking, and what
was deliberately skipped. It covers the sources added for task-type indexes;
the model price/serving/usage sources are described in `README.md`.

## 1. What "task-type index" means here

Three different kinds of source data say something about a task type, and they
are **not** interchangeable:

| Kind | Example | Where it goes |
|---|---|---|
| Single-benchmark accuracy | OpenRouter's GPQA Diamond leaderboard | a benchmark observation in one dimension (`rank.js`) |
| Composite domain index | Artificial Analysis Legal Index | an index signal only: stored, reported, never blended into a dimension |
| Adoption ranking | OpenRouter task-spend shares | `usage.tasks` on the entry: a routing-adjacent signal, never capability |

The ranking engine already enforces this: dimensions are arithmetic means of
aligned benchmark observations, one vote per canonical benchmark, while the
intelligence index and Epoch ECI are ordinal/own-scale signals that are reported
and never averaged in. The task data follows the same rule.

## 2. Artificial Analysis

All pages are Next.js and ship their data inside the RSC flight stream
(`self.__next_f.push([1,"…"])`). `decodeFlightChunks()` in `src/refresh.js`
decodes it, so no browser is needed.

### 2.1 Domain task indexes — `/indexes/<domain>` (used as index signals)

Pages (sitemap `/indexes`):

```
https://artificialanalysis.ai/indexes/finance-and-accounting
https://artificialanalysis.ai/indexes/strategy-and-ops
https://artificialanalysis.ai/indexes/legal
https://artificialanalysis.ai/indexes/healthcare-and-medical
https://artificialanalysis.ai/indexes/engineering
https://artificialanalysis.ai/indexes/economics
```

Each page server-renders one chart row per model:

```json
{
  "name": "Claude Fable 5.2 (Max, Default Fallback)",
  "weightedIndex": 63.296409078231,
  "headlineValue": 63.296409078231,
  "subScores": {
    "knowledge": 71.78, "reasoning": 80.2, "longContext": 24.2,
    "agenticToolUse": 80.87, "nonHallucination": 48.03,
    "agenticKnowledgeWork": 64.26
  }
}
```

`weightedIndex` is a composite of the sub-scores listed on the page (the exact
mix differs by domain: Legal has knowledge/reasoning/long-context/agentic tool
use/non-hallucination/knowledge work, Engineering has science/knowledge/reasoning/
agentic terminal use/knowledge work). It is therefore stored per entry as:

```
crossChecks.taskIndexes = {
  source, checkedAt,
  indexes:  { legal: 63.3, engineering: 72.6, … },   // composite, 0-100
  subScores: { legal: { knowledge: 71.8, … }, … }     // as published
}
```

and reported through `table.indexSignals` as `task-index:<domain>`. It is never
blended into a dimension — that is the same rule as the intelligence index, and
the sub-scores are domain-conditioned versions of evidence already counted under
the per-benchmark observations.

### 2.2 Evaluation leaderboards — `/evaluations/<slug>` (discovered, not used)

The sitemap lists ~40 single-evaluation pages (`/evaluations/gpqa-diamond`,
`/evaluations/math-500`, `/evaluations/mmlu-pro`, …). Each embeds the same
~27 chart-selected models with a flat set of benchmark fields (`math500`,
`mmluPro`, `globalMmluLiteScore`, `cweBench`, `mmmuPro`, `lcr`, …).

They were checked and **not** merged as extra observations: the chart selection
is 27 frontier models, only a handful of which are in this catalog, and the
fields largely restate benchmarks the model table already carries (under
different names). Using one page per benchmark would add 40 requests for a
negligible, biased subset. The model table (`scores` map) remains the AA
benchmark source.

### 2.3 Composite indexes — `/indexes` and `/evaluations/*-index`

The index page also lists composite indexes: Intelligence, Progress, Coding
Agent, Search, Cyber, Decision, Openness. They are composites over multiple
evaluations (or over agents/providers, or not capability at all). The
intelligence index was already captured as the existing AA index signal; the
others are skipped for the ranking because requirement and engine agree that a
composite does not become one dimension vote. The Coding Agent Index measures
agents (Claude Code, Codex, …), not models, and Search/Cyber/Openness are either
provider-level or not one of the router's dimensions.

## 3. OpenRouter

### 3.1 Task benchmark leaderboards — `/benchmarks/<slug>` (used as observations)

`https://openrouter.ai/benchmarks` lists the benchmarks OpenRouter runs itself.
Each detail page server-renders a `models` array in the RSC payload:

```json
{
  "modelName": "Google: Gemini 4 Argon",
  "modelSlug": "google/gemini-4-argon",
  "median": {
    "providerName": "Google",
    "accuracy": 0.964646,     // median accuracy across providers, 0-1
    "runCount": 1,
    "totalTasks": 198,
    "avgCostPerTask": 0.0947
  }
}
```

Used (`OPENROUTER_BENCHMARK_PAGES` in `src/refresh.js`):

| Page | Canonical benchmark | Dimension | Scale |
|---|---|---|---|
| `gpqa-diamond` | `gpqa` (shared with AA) | knowledge | accuracy 0–1 |
| `tau2-bench-airline` | `tau2` (shared with AA) | agentic | accuracy 0–1 |
| `vgi-bench` | `vgi-bench` | vision | accuracy 0–1 |

The accuracy is stored as published in
`crossChecks.openrouterBenchmarks.accuracy` and enters `rank.js` as channel
`openrouter`. A canonical id shared with another channel (`gpqa`, `tau2`) is one
benchmark vote across publishers, not one vote each: the engine's same-canonical
deduplication handles that.

**Skipped:** `browsecomp`, `hle`, `deepsearchqa`, `widesearch`. Those pages
publish `lanes` — combinations of model × search engine × surface — so the score
measures a *configuration*, not the model; the catalog names no search engine and
cannot fairly attribute that score. The media benchmarks (`/benchmarks/media/*`:
image, video, memes, sketch, speech) measure generative media, which is not one
of the router's capability dimensions. `/benchmarks/routers` measures routers.

### 3.2 Task-spend ranking — `/api/frontend/v1/rankings/task-spend` (used as adoption)

Public frontend endpoint (no key), 30-day window, 39 task tags in 8 macro
categories:

```json
{
  "data": {
    "spend": {
      "windowDays": 30,
      "macroCategories": [{ "key": "software", "label": "Software", "spendShare": 0.41 }, …],
      "tasks": [{
        "tag": "software.implementation",
        "macroCategory": "software",
        "spendShareOfTotal": 0.1597,
        "models": [{ "model": "anthropic/claude-opus-5.5-20260921", "share": 0.2446, "deltaPp": 2.25 }, …]
      }]
    },
    "tokens": { "…": "same shape, token share instead of spend share" }
  }
}
```

Reduced to `usage.tasks` per entry: the top 12 task tags with the model's share
and rank inside that task, plus the window length. This is adoption, not
capability: it changes no dimension and no composite. It is exposed on the entry
(the same place the weekly overall usage lives) so the selector/decision prompt
can use it later; `rank.js` also carries it in `row.signals.taskUsage`.

The page also exposes `/api/frontend/v1/rankings/benchmarks`, which republishes
Artificial Analysis' index values (intelligence, the six domain indexes, cyber,
openness, multilingual, decision) for OpenRouter model slugs, plus a Design Arena
category list and OpenRouter's `valsIndex`. It was inspected and not used: it is
the same AA data this pipeline captures from the AA source directly, and adding a
second republisher would double the AA join surface without adding evidence.

### 3.3 Already-existing OpenRouter usage

`src/openrouter.js` already captures the weekly overall usage ranking
(`/api/frontend/v1/models/find?order=top-weekly`). The new task-spend signal is
separate and complementary: overall popularity here, per-task popularity there.

## 4. Mapping and invariants

- **Identity** is `provider/model`. Source rows name a model, not an endpoint:
  a row attaches to every catalog id naming the same model under the existing
  identity rule (effort/serving variants and dates may differ; model tiers and
  version digits may not), and never to an id whose label names a different
  model (`labelAgrees`).
- **Zero means not measured.** Accuracy `0` and index `0` are dropped at the
  extractor/consumer guard, as everywhere else.
- **One benchmark, one vote.** New canonicals registered in `DIM_RULES`
  (`src/rank.js`): `math-500` (math), `mmlu-pro`/`global-mmlu-lite` (knowledge),
  `vgi-bench` (vision), `mka*` (vision), `tauBanking` (agentic, canonical
  `tau3-banking`), `analystAgent` (agentic, canonical `analyst-agent`).
- **No scale conversion.** OpenRouter accuracy stays a 0–1 fraction as published
  and is aligned to the ranking axis by the fitted affine map; AA indexes stay
  on their published 0–100 composite scale and are never averaged with anything.
- **Composite stays out.** `crossChecks.taskIndexes` is an index signal; a test
  pins that adding it changes no dimension and no composite.

## 5. Captures and regeneration

| File | Endpoint(s) | Regenerate with |
|---|---|---|
| `data/artificialanalysis-task-indexes.json` | `/indexes/<6 domains>` | `node scripts/scrape-task-indexes.mjs` |
| `data/openrouter-benchmarks.json` | `/benchmarks/{gpqa-diamond,tau2-bench-airline,vgi-bench}` | same |
| `data/openrouter-task-usage.json` | `/api/frontend/v1/rankings/task-spend` | same |
| Runtime catalog (task data attached) | all of the above plus the existing sources | `node scripts/refresh-database.mjs` |

`refreshCatalog()` fetches the same endpoints at run time, so a database refresh
picks up the task data even if the committed captures are old. Each source is
fetched independently and a failure is recorded in
`data/refresh-report.json` without discarding the others.

Playwright was not needed: every endpoint above is reachable with plain `fetch`
and the RSC/payload decode already in `src/refresh.js`. The OpenRouter
`/api/v1/benchmarks` JSON API requires a key and was not used.

## 6. Measured effect (2026-11-19 rebuild)

`node scripts/refresh-database.mjs` before → after adding the task sources:

| Measure | Before | After |
|---|---|---|
| Entries / measured | 69 / 65 | 69 / 68 |
| OpenRouter benchmark observations | — | 164 (118 calibrated, 46 uncalibrated) |
| Knowledge: models measured / evidence ≥ 2 / observation count | 63 / 26 / 114 | 68 / 35 / 128 |
| Agentic: models measured / evidence ≥ 2 / observation count | 13 / 9 / 29 | 62 / 11 / 87 |
| Coding / math / reasoning / longContext | unchanged | unchanged |
| Vision measured | 3 | 3 |
| AA task-index models (6 domains) | — | 19 |
| Entries with OpenRouter task usage | — | 55 |
| Uncalibrated observations | 589 | 635 |
| Derived envelope floors (fast / balanced / deep) | 22 / 26 / 29 | 28 / 33 / 35 |

Top 10 before → after: `qwen3.7-max` stays first; `glm-5.3` stays second;
`kimi-k3` 3 → 4; `deepseek-v4-pro-0813` 4 → 5; `deepseek-v4-flash-0731` 9 → 3;
`qwen3.8-max` 6 → 6; `deepseek-v4.1-flash-1017` 5 → 10. Three entries that were
previously carried by a single dimension (`antdigital/ling-3.1-flash`,
`qwen3.8-2.4t-a95b`, `vanchin/deepseek-v4-pro`) enter the top ten because the
OpenRouter task benchmark gives them an agentic estimate they did not have.

Honesty notes:

- **`vgi-bench` is uncalibrated against the axis.** It has rows for 46 catalog
  entries, but the axis owner (BenchGecko) measures vision on only 3 models, so
  both the same-benchmark fit and the dimension-level fallback refuse. The
  observations are listed in `data/refresh-report.json` and the vision dimension
  is unchanged; it is not forced in.
- **`tau2` has no same-benchmark partner** (BenchGecko does not carry tau2), so
  its 49 agentic observations come from the dimension-level fallback — the
  engine's documented weaker alignment (residual RMS is reported per fit). That
  is why agentic coverage rises sharply but the `evidence ≥ 2` count rises only
  from 9 to 11: most new estimates are a single benchmark and carry the
  corresponding uncertainty band.
- **AA domain indexes are stored for 19 of 69 entries** because each index page
  charts only its top ~28 models. They are index signals and do not change any
  dimension; the remaining entries simply have no published domain-index value.
- Task-spend coverage is 55 entries; it is adoption and changes no score.
