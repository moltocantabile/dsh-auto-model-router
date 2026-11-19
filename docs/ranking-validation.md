# Ranking validation against Latent Space coverage

The tier/rank design was checked against the model coverage on
[latent.space](https://latent.space/) (Latent Space's AINews model-launch posts),
which quote independent boards — Artificial Analysis, Vals, Arena — alongside the
vendor's own claims. The site exposes no structured model API; the usable signal is
in the articles, so the comparison is qualitative except where a board number is
quoted.

Method: `https://latent.space/api/search?q=<model>` → the launch AINews post →
the "Benchmark results" section. Numbers below are as quoted in the posts.

| Model | Independent claim (source) | Our composite / rank | Verdict |
|---|---|---|---|
| DeepSeek V4.1-Flash (`…-1017`) | 40 on AA Intelligence Index, "above V4 Pro and below GLM-5.3-Flash"; AutomationBench-AA 69; GDPval-AA 1632 (overtaking Kimi K3 at 1584); AA-LCR 84; $0.27 per AA task, 89k tokens/task | cos 53.6 / rank 6 / deep | ordering corroborated (GLM-5.3-Flash above the **undated** alias, snapshot above it); verbosity cost is a gap — our price model ignores output length |
| DeepSeek V4.1-Flash (undated alias) | AA says the snapshot rows describe 1017; article's model is the snapshot | cos 47.0 / rank 56 / fast | not the snapshot; kept as its own model |
| DeepSeek V4 Pro 0813 | AA: V4.1-Flash "surpasses V4 Pro 0813 despite being much cheaper" | cos 49.8 / rank 40 / **off** | corroborated: dominated by the stronger, cheaper same-family snapshot |
| Qwen3.8-Max | Vals Index 66.1 (#2 open); SWE-bench 87.3%; Terminal-Bench 2.1 67.4; Qwen3.8 = 66.1 vs Qwen3.7 = 57.5 | cos 51.5 / rank 14 / deep | **disagrees**: our catalog has 7 observations for it (no math dimension, one coding row) so it trails Qwen3.7-Max; a coverage gap, see below |
| Qwen3.7-Max | Vals 57.5 | cos 57.8 / rank 1 / deep | corroborated as a strong current model |
| Kimi K3.1 Pro | Kimi K3 family: AA 57, GDPval 1668, AutomationBench 53% | cos 53.2 / rank 7 / deep | corroborated |
| GLM-5.3 / GLM-5.3-Flash | GLM-5 post: SOTA open on BrowseComp, #1 open Text Arena; AA index of Flash above V4.1-Flash's 40 | cos 51.4 / rank 16 / deep ; cos 50.0 / rank 39 / balanced | corroborated: Flash above undated V4.1-Flash, below the snapshot |

## What the comparison changed

Measuring against the AA index (the only numeric independent board we capture)
showed the displayed rank was not capability-ordered:

```
before:  AA index vs composite 0.88 | vs lower bound 0.37 | vs published rank 0.37
after:   AA index vs composite 0.88 | vs lower bound 0.37 | vs published rank 0.88
```

- **Rank order** is now the capability point estimate (composite); the conservative
  lower bound leads the tie-break and remains the router's quality safety bound,
  but no longer decides the displayed order (a lower bound is mostly evidence
  width, so it ordered models by how much we had measured them).
- **Capability bands** (`tiers.criterion: 'capability'`) use the composite for the
  same reason; the coverage gate still keeps <3-core-dimension fragments out.
- Result: `deepseek-v4.1-flash-1017` deep, `deepseek-v4.1-flash` fast,
  `GLM-5.3` balanced, matching the independent ordering above; the dominated
  V4 Pro 0813 is off.

## Membership sanity (2026-11-19)

Bands alone left the board with lanes that were defensible per-model and wrong as
a board: a retired entry in `balanced`, four endpoints of one model in `deep`,
older generations next to their own replacements, and expensive/slow models on
cheap tiers. The assignment now enforces four rules, each with a synthetic-pool
test in `tests/tiers.test.mjs`:

| rule | effect |
|---|---|
| withdrawn | `retired`/`deprecated`/`withdrawn`, or any `sunsetAt`, never auto-places; off with the kind and date on the card |
| superseded | a newer **measured** model of the same base line replaces it — same line and date identity, or a newer generation where either side has no product-variant words (`deepseek-v3.2` → `v4.1-flash`, `kimi-k2.6` → `k3.1-pro`). Guards: the successor must not be materially weaker (composite within 2 points), and within one major generation a 4x-pricier successor does not retire the budget option. Chains resolve to the final replacement, so a card never names a model that is itself off |
| guardrail | a model above its capability band's cost or latency ceiling moves one band up; if that budget still rejects it, it is off, not parked on a tier that cannot pay |
| dedupe | one capsule per model: provider/reseller/serving variants collapse to the best endpoint (fastest, then most evidence, then cheapest); the card keeps the endpoint count |

Two consequences worth recording. Supersede runs before dominance, so an older,
cheaper sibling cannot prune the newer generation; and capability-mode dominance
now compares the composite (same grade as the bands), scoped to one tier, because
the conservative lower bound is mostly evidence width. Membership is model-level,
so `status` and the lane headers count the same deduped board the page renders.

Snapshot against `data/model-info-runtime.json` (host-derived envelopes, 64
entries, one row per model):

```
before  fast 13 · balanced 15 · deep 19 · off  9 · unmeasured 8
after   fast  2 · balanced  6 · deep  9 · off 25 · unmeasured 7
```

The 15 collapsed entries are duplicate provider/reseller/serving endpoints of
the same model; the retired entry, the superseded generations and the dominated
models are in `off` with their reasons.

`node scripts/ranking-eval.mjs` prints the current agreement; run it after any
change to the rank or grade rule.

## Limits the articles made visible

1. **Sparse new models.** Qwen3.8-Max is graded on 7 observations and lacks a math
   dimension, so it ranks below the model Vals places 8.6 points below it. The
   cause is source coverage, not the rank rule.
2. **Parameter-count names.** AA names `qwen3.8-max` as "Qwen3.8 2.4T A95B"
   (article: 2.4T total / 95B active). That captured row carries no index, price or
   scores, so it adds no measurement even though the model identity is clear. No
   model-specific alias was added for it: the engine stays model-agnostic, and
   `tests/genericity.test.mjs` fails if a model/vendor name appears in the rank,
   tier, selection or refresh code. Aliases, when needed, are data in the identity
   table and are honoured generically by the name guard.
3. **Cost is capability-adjusted on some boards.** Vals' #1-open-weight for
   V4.1-Flash is a cost-adjusted placement; our composite is a pure capability
   order. Cost already enters selection utility and the tier envelopes.
4. **Verbosity.** AA reports 89k tokens/task vs 71k (GLM-5.3) and 55k (V4 Pro
   0813). Output length is a real cost factor our per-token price does not model.
5. **Vals/Arena snapshots are not ingested.** Only AA's index is captured; the
   other boards are read qualitatively here.
