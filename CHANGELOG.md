# Changelog

## 0.0.1

First stable release. The router ranks every advertised model from measurements
and picks one per request; `mode: shadow` records decisions without moving the
session.

### Routing

- System One decision model classifies each request (shape, depth, breadth, risk,
  intent), with confidence and probability mass per answer; an empty or partial
  answer no longer becomes a confident default.
- Selection scores candidates for the task: cost, capability, measured evidence,
  a pool-quantile risk floor, and a small real-usage bias from OpenRouter's weekly
  ranking.
- Tiers (`fast`/`balanced`/`deep`) are measured envelopes: a model joins the
  cheapest tier it satisfies. Ceilings can be hand-written, filled from the data,
  or derived from the measured pool (percentile cost, quantile quality), with
  provenance so a derived floor is compared on the axis it was derived on.
- Dominance prunes a model only within its own family (e.g. `deepseek*`), never
  across vendors.

### Data

- Sources: BenchGecko, CompassRank, Epoch ECI, llmleaderboard, Artificial
  Analysis (table + per-model pages), OpenRouter weekly usage.
- One capability basis across floor, placement, dominance and the card; a zero
  from any source means "not measured", never a score; partial refreshes refuse
  to write.
- Raw source data is retained beside the compiled values, including AA's
  mixed-scale benchmark scores and metadata.
- Identity is `provider/model` with one rule: effort variants and dates may
  differ, model tiers and version digits may not.
- Operator edits (type, label, modalities, tools, context, price) persist in
  `data/model-overrides.json` over the catalog.

### UI

- Tier board of capsules, ordered by measured rank, with rank/composite/
  measured-dimension coverage on the card, dominance/superseded/off badges, a
  keyword search, provider filtering, icon-first fold controls and drag-to-tier.
- Decision model configured by provider (only decision-typed models) or by typing
  the endpoint; model data editable from each card.
- Composer toggle for auto routing; settings page with policy, tiers, decision
  and session views.
