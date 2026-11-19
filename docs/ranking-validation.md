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
  `GLM-5.3-Flash` balanced, matching the independent ordering above; the
  dominated V4 Pro 0813 is off.

`node scripts/ranking-eval.mjs` prints the current agreement; run it after any
change to the rank or grade rule.

## Limits the articles made visible

1. **Sparse new models.** Qwen3.8-Max is graded on 7 observations and lacks a math
   dimension, so it ranks below the model Vals places 8.6 points below it. The
   cause is source coverage, not the rank rule.
2. **Parameter-count names.** AA names `qwen3.8-max` as "Qwen3.8 2.4T A95B"
   (article: 2.4T total / 95B active). The curated alias now resolves it, but that
   AA row carries no index, price or scores, so it adds nothing until AA evaluates
   the model.
3. **Cost is capability-adjusted on some boards.** Vals' #1-open-weight for
   V4.1-Flash is a cost-adjusted placement; our composite is a pure capability
   order. Cost already enters selection utility and the tier envelopes.
4. **Verbosity.** AA reports 89k tokens/task vs 71k (GLM-5.3) and 55k (V4 Pro
   0813). Output length is a real cost factor our per-token price does not model.
5. **Vals/Arena snapshots are not ingested.** Only AA's index is captured; the
   other boards are read qualitatively here.
