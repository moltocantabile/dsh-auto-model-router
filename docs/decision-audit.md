# Decision prompt and acceptance audit

Status: **audit complete, fixes applied in `src/decision.js` and `src/summarize.js`.**
The decision endpoint is failing on quota, so this audit rests on the prompt
structure, the System One reply contract, and the test suite — not on a live
decision run. Every parameter kept or changed below has a stated rationale; the
open questions that only a live endpoint can answer are listed in §6.

The two files audited and edited are [`src/decision.js`](../src/decision.js)
(state assembly, questions, parsing, client) and [`src/summarize.js`](../src/summarize.js)
(digest prompt and cache). `file:line` anchors are against this tree
(2026-11-19); the tests do not depend on them. `src/index.js` is reported but
not edited: the record shape, shortlist contents and policy wiring live there,
and the findings for it are marked **needs `index.js`**.

Suite before: 237 tests. The changes here add 15 (252). The full tree, including
the concurrent database audit's additions, is 259/259. Each behaviour change
below has a test that fails on the previous code.

---

## 1. Field-by-field prompt inventory

### 1.1 State (what the model reads, not what it answers)

Assembled by `stateFromMessages` (`src/decision.js:175`) and capped at
`maxStateChars` (12,000 characters).

| Field | Content | Exists to decide | Notes |
|---|---|---|---|
| `[router] agent=…` | `main` / `subagent` | Whether the step may delegate/hold a long task | Two agents with identical text are different routing problems. Correct. |
| `session` | `steered` / `no steering` | Whether the step is mid-turn steering | **Wrong today**: the claimed batch always contains the new message, so every new turn reads `steered`. See M8. |
| `tools=N (…)` | up to 12 tool names | Whether tool-heavy work is possible | Tool names, not counts, are the useful part. Correct. |
| `[session-digest]` block | `GOAL/DONE/NOW/RISK`, ≤ `maxStateChars/3` | Task framing for risk and intent; prevents a step from being scored as a fresh request | Digest length is also part of the reuse signature. Correct after M1/M3. |
| digest framing line | “Score depth and breadth for the request … use the digest only to judge risk” | Stops the session’s difficulty inflating the step | Deliberate: it also tells the model not to use the digest for intent, even though the digest is the best evidence of work in flight. Left alone (§4). |
| transcript lines | last `maxMessages` context messages, one line each | What is happening in this step | Noise is now filtered before the window is counted (M4). |
| `request: …` line | last routable user message, added if it fell out of the window | Ensures the routed request is always present | Correct; de-duplicated when already in the window. |

Clocking of `maxStateChars` for an overflowing body takes the **end** of the
text, so the request line and the newest turns survive, and drops the oldest
first. Correct.

### 1.2 Questions (what the model answers)

`buildQuestions` (`src/decision.js:263`). `choice` criteria keys are the allowed
answers; `score` criteria position is the score; `noul` takes no criteria.

| Question | Type | Host reads it for | Chars (JSON) |
|---|---|---|---|
| `shape` | choice, 11 profiles | `SHAPE_WEIGHTS` base for all dimension weights | 1,091 |
| `depth` | score 0–4 | depth adjustment | 1,106 |
| `breadth` | score 0–4 | breadth adjustment | 495 |
| `risk` | score 0–4 | floor, risk adjustment, downgrade rule | 635 |
| `intent` | choice: acknowledge/resume/work | `acknowledge` alone prices the turn at zero; `resume` exists so a mid-task “ok” has a true alternative to `acknowledge` | 973 |
| `vision` | noul (threshold 0.6) | hard filter: text-only models excluded | 262 |
| `tools` | noul (threshold 0.5) | `toolCalling: false` candidates excluded | 199 |
| `latency` | noul (threshold 0.5) | `latencyCritical` adjustment and downgrade rule | 235 |
| `model` | choice, `auto` + shortlist | explicit model request | 2,789 with 40 ids |
| `modelRequest` | noul | gates whether the named model is a *request* or a mention | 435 |

Every base question is read by the host; none is decoration. `intent` values
`resume` and `work` are routing-identical (both keep the scored profile); the
distinction exists so `acknowledge` is not the only alternative to `work`.
`vision`/`tools`/`latency` are the only questions whose answers become hard
selection constraints, so their defaults matter: missing answers read as “no”.

Prompt size: 5,074 characters of questions without a shortlist; 8,298 with a
40-model shortlist (the shortlist is the single largest block, about a third of
the questions). State adds up to 12,000 characters, so a short request is
dominated by the questions and a long one is bounded by the state cap.

### 1.3 The `models` shortlist

`offerModelIds` (`src/index.js:91`) passes the 40 best-measured model ids
(`modelsByQuality` order, bare ids, de-duplicated by id). The question offers
`auto` plus one choice per id, with the same sentence for each id.

- An answer outside the offered keys cannot be produced by a conforming choice
  answer. A non-conforming endpoint can name anything; `decideFor` looks it up
  in the candidate pool and falls back to ranked selection when it is absent, so
  an off-list name is never applied — but it is also never logged (M6).
- Provider identity is dropped: two providers serving the same model id become
  one shortlist entry, and a request for “provider B’s X” cannot be expressed.
  The pool lookup matches the first candidate with that id (M6).
- The top-40 cut means a configured route model with a lower measured rank
  cannot be requested by name at all; the request silently falls back (M6).

### 1.4 What the host has and does not send

| Fact | Why it is not sent | Verdict |
|---|---|---|
| Ranking / usage / dominance facts | The decision model answers “what kind of work is this”, not “which model is best”; those are the selector’s arithmetic | Deliberate. Sending them would invite the model to rank, which is deterministic code. |
| Provider identity per shortlist id | Shortlist is strings from `modelsByQuality` | **M6**, needs `index.js`. |
| Tier envelopes (cost/latency/quality caps) | The tier is a pinning frame, not the decision space | Deliberate. The model is not asked to choose a tier. |
| Digest age / refresh state | The digest passed is already the current best | Deliberate; a stale digest is better than none and the decision must not block on it. |
| Route capability notes (`routeNotes`, `src/index.js:391`) | Dead function; `notes` was threaded into `buildQuestions` and never read | Removed from `decision.js`; the caller-side dead function is a **needs `index.js`** cleanup. |
| Tool schemas (not just names) | Token cost | Deliberate; names are enough to say whether tools are required. |
| Message language / locale | The criteria are semantic; the model infers language | Deliberate (§4). |

### 1.5 Wording ambiguities found

- `depth` criterion 0 (“acknowledgement: an answer of one word …”) duplicates
  the `intent` question. A reply can score depth 0 and intent `work`; the parser
  uses both independently, which is safe (cheap profile, not a zero-priced
  turn). Left alone: the depth anchor is a valid reference point on its scale.
- `shape: inspect` and `vision` both detect image work. `vision` is the hard
  constraint; `inspect` shifts weights. Redundant but not contradictory.
- The `model` instruction “A named model is an instruction, not a suggestion:
  choosing anything else overrides the user” reads as if any mention should be
  chosen, while the same instruction says a name in prose is not a request. The
  second sentence and the `modelRequest` gate resolve it; the wording is left
  alone because the measured separation (requests 0.94–0.98, mentions 0.20)
  comes from that pairing.

---

## 2. Findings

Severity: **High** changes acceptance of a wrong answer; **Medium** loses
evidence or degrades a prompt; **Low** documentation/config debt.

### High

**H1 — An empty or partial reply became a confident default decision.**
`normalizeAnswers` gave a bare value confidence `1`; `parseDecision` computed
`confidence = min(...)` over the answers present and defaulted to `1` when
there were none. An HTTP 200 with `{answers:{}}` therefore produced
`shape=implement, depth=2, breadth=2, risk=1.5, confidence=1.0,
source=system-one` — the surest-looking decision in the log, from no evidence.
A partial reply had the same problem: missing questions kept their fallbacks and
the reported confidence stayed high.
Fixed: a reply with no answered question is rejected in `callDecisionModel`
(where the caller already has an error path), and `parseDecision` reports
confidence `0` unless every required question was answered with a stated
confidence. Routing fallbacks are unchanged, so behaviour under a partial reply
is identical; only the report is now honest about it.
Tests: `a reply that answers nothing is rejected instead of parsed into
defaults`, `a partial reply cannot report the confidence of a complete
decision`.

**H2 — A choice with no stated confidence cleared the acknowledge and
model-request gates.** A `choice` answer without `confidence` and without
`probabilities` defaulted to `0.7`. The acknowledge floor is `0.6`, so
`{intent:{choice:"acknowledge"}}` priced the turn at zero; the model-request
choice-confidence floor is `0.5`, so a bare `{model:{choice:"X"}}` plus a high
`modelRequest` probability routed to X. Both are answers with no evidence
attached.
Fixed: the evidence for a choice is its stated confidence or the probability
mass on the chosen key; absent both, confidence is `0`. The same applies to
score answers, bare primitive answers, and the pre-normalized pass-through.
Tests: `a choice with no stated confidence cannot acknowledge a turn`,
`a model name with no stated confidence is not an explicit request`.

**H3 — An acknowledgement dropped an explicit model request.**
`parseDecision` returned from the `acknowledge` branch before reading the
`model`/`modelRequest` answers. “ok, use X for this” classified as an
acknowledgement with an explicit request lost the name, and the selection engine
overrode the user with a heuristic.
Fixed: the request is evaluated before the branch and returned with the
acknowledgement; `decideFor` already gives `requestedModel` priority over the
acknowledgement profile.
Test: `an acknowledgement that names a model keeps the explicit request`.

**H4 — A malformed shape was accepted and reported as a real shape.**
Any string became `profile.shape`; the selector silently fell back to
`implement` weights, but the record showed the nonsense value with full
confidence.
Fixed: the shape is validated against `PROFILES`; an unknown value is reported
as the `implement` fallback with confidence `0`.
Test: `an unknown shape falls back to implement and reports no confidence`.

### Medium

**M1 — The digest refresh described the wrong transcript.** On a refresh the
cache sends only `messages.slice(covered)` but told the model it was the last
`messages.length` messages, and the prompt called it “Transcript (last N
messages)”. A three-message tail was presented as the whole session. A
noise-only step or a compacted transcript could also send an empty transcript
to the summarizer, which returned “unclear” or drifted the digest.
Fixed: the refresh slices, filters noise, sends only the new messages, passes
that count, and announces it as “New messages since the previous digest (N)”.
With nothing new to summarize it keeps the digest, pulls the coverage mark back
to a compacted transcript's length (never forward), and makes no model call.
Tests: `a refresh sends the messages since the last digest, and says how many`,
`a refresh prompt names its transcript as the new messages`, `a compacted
transcript is not summarized as an empty one`.

**M2 — The summarizer rejected an unauthenticated endpoint.** `callChatModel`
threw `apiKey not set`, while the decision client explicitly supports a local
server without a credential. On such a deployment every digest failed and
routing silently ran on recent messages only.
Fixed: the credential is optional, as on the decision path; no header when
absent.
Test: `the summarizer accepts an unauthenticated endpoint`.

**M3 — The decision-reuse signature was length-based.** `messageIds` was
`${messageCount}:${taskLength}`; a new request of the same length as the previous
one matched the signature and reused the previous decision for up to
`DECISION_REUSE_MS` (120 s) without asking the model.
Fixed: `messageIds` is a content fingerprint of the assembled state and task, so
the signature follows the prompt text.
Test: `the reuse signature follows the prompt text, not its size`.

**M4 — Injected notices consumed the transcript window.** The window was sliced
from the raw tail and filtered afterwards, so ten injected notices (runtime
context, clock, skill catalog, tool registry) could fill a ten-message window
and push the assistant turn being followed out of it.
Fixed: context messages are filtered before the window is counted.
Test: `injected notices do not spend the transcript window`.

**M5 — The digest token budget did not cover the digest character contract.**
The prompt asks for at most 900 characters; `max_tokens` was 400. In Chinese
(roughly one token per character) the last line, RISK, was liable to be cut.
Fixed: the cap is `DEFAULT_SUMMARIZER.maxChars * 2` (1,800), which covers the
character contract, including CJK, and the hard clip of a returned digest.
Test: `the digest token budget covers its character contract`.

**M6 — The model shortlist loses provider identity and truncates at 40.**
See §1.3. Consequence is a silent fallback to ranked selection for a model the
user named that is outside the shortlist; no wrong model can be applied.
**Needs `index.js`** (and is a product decision): offer `provider/model` keys
(the parser and `decideFor` already accept `candidate.key`), and include any
model pinned by a configured route in the shortlist even when it ranks below the
top 40.

**M7 — The shadow-mode decision record omits the evidence.**
The record (`src/index.js:868`) carries `id, at, agentId, agentKind, task,
turn/step, routeId, provider, model, source, tier?, confidence, profile?,
ranking?, inputTokens, latencyMs, applied, switched, error?`. It does not carry
the raw reply, the parsed `intent` / `acknowledged` / `requestedModel`, the
completeness result, the digest, or `serverLatencyMs`. In shadow mode this
record is the only evidence, so an audit of “why did it decide this” cannot read
the answer that was parsed.
Partially fixed in scope: `callDecisionModel` now fills `inputTokens` from
`usage.input_tokens` and `serverLatencyMs` from `latency_ms`, so the record’s
`inputTokens` is populated and `explain`’s `serverLatencyMs` works; both were
read from the wrong field and were always `undefined`.
Test: `the decision client exposes protocol usage in the fields the record
reads`. **The remaining record fields need `index.js`.**

**M8 — The state tells the model every turn is steered.**
`session` is `steered` whenever the claimed batch holds a routable message,
which is true for the normal new message of every turn. The reader is told a
plain new request arrived mid-turn. **Needs `index.js`** to pass whether the
message arrived while a turn was in flight; `decision.js` has no signal to
distinguish them.

### Low

**L1 — Three policy fields control nothing.** `DEFAULT_POLICY.minConfidence`,
`minProbability` and `switchConfidence` are merged into config, exposed in the
settings page and the README, and read by no decision path (`acknowledgeConfidence`
and `modelRequestConfidence` are live). The comments claiming they gate choices
were corrected in `decision.js`; the README and settings page still advertise
them. **Needs `index.js`/`client.js`/`README`**: either wire them or remove them
from the contract. Wiring them into `parseDecision` would be a behaviour change
without live evidence (§4).

**L2 — Dead prompt plumbing.** `buildQuestions`/`callDecisionModel` carried a
`notes` parameter that never reached the prompt; it is removed.
`routeNotes()` (`src/index.js:391`) is the dead producer and is left for the
`index.js` change.

**L3 — Unused imports.** `DIMENSIONS` and `SHAPE_WEIGHTS` are imported in
`src/decision.js` and unused (pre-existing). Left alone.

**L4 — A degenerate configured deadline becomes 50 ms.** `Math.max(50, …)`
turns a configured `0`/negative deadline into a 50 ms deadline, which fails
every decision. The floor is deliberate (a deadline of 0 is not a usable
request); the value stays, and a non-finite value now falls back to the default
instead of throwing before the request. Test: `a non-finite decision timeout
falls back instead of failing before the request`.

---

## 3. Parameters: old → new

| Parameter | Old | New | Decision it controls | Rationale |
|---|---|---|---|---|
| bare primitive answer | confidence `1` | `0` | Whether an answer can clear a gate | A bare value states no confidence, so it is a profile input, not evidence. |
| pre-normalized `{value}` answer | confidence `1` | `0` | Same | Same. |
| `choice` without confidence/probabilities | `0.7` | `0` (or mass on the key) | Acknowledge and model-request gates | `0.7` cleared the `0.6` acknowledge floor and the `0.5` request floor with no evidence. |
| `score` / `answer` without confidence | `1` / `0.7` | `0` | Reported confidence | Same rule: no stated confidence, no evidence. |
| empty answer set confidence | `1` | `0` | Reported confidence | An empty reply is no evidence; it is now rejected at the client. |
| required-answer completeness | not checked | missing/malformed required answer ⇒ `0` | Reported confidence | A partial reply kept its defaulted dimensions and reported high confidence; the log now shows it. |
| shape validation | any string | `PROFILES` id, else `implement` + `0` | Shape weights | The selector already fell back to `implement`; the record now says so. |
| unparseable/empty reply | parsed as defaults | rejected by `callDecisionModel` | Error path in `index.js` | A 200 with no answers is not a decision; the caller already has an error path. |
| `max_tokens` (digest) | `400` | `Math.ceil(DEFAULT_SUMMARIZER.maxChars * 2)` = 1,800 | Digest completeness | The prompt allows 900 characters; 400 tokens cannot express that in Chinese. |
| digest refresh count | session total | new non-noise messages | Prompt accuracy | The prompt described the whole session while showing a tail. |
| digest refresh content | raw slice (could be empty) | filtered new messages; no call when empty | Digest stability and cost | An empty transcript produced “unclear” or drift. |
| reuse signature | message count + task length | FNV-1a fingerprint of state + task | Whether a decision is reused | Same-length different requests reused the previous decision. |
| transcript window | raw slice then filter | filter then slice | Which turns reach the prompt | Injected notices displaced real turns. |
| decision timeout value | `Math.max(50, timeoutMs)` | `Math.max(50, num(timeoutMs, 3500))` | Deadline | `NaN` reached `AbortSignal.timeout` and threw before the request. |
| digest auth | required | optional | Whether a local endpoint gets digests | The decision client already supports an unauthenticated server. |

### Thresholds and limits kept, with rationale

| Parameter | Value | Decision it controls | Why unchanged |
|---|---|---|---|
| `ACKNOWLEDGE_MIN_CONFIDENCE` | 0.6 | Whether a turn is priced cheap | Measured acknowledgements 0.47–0.99 vs real work 0.86–0.97; 0.6 sits below the work cluster and above the uncertain acknowledgements. A wrong direction here is symmetric in cost, and the prompt says ambiguous courtesy is an instruction. |
| `MODEL_REQUEST_MIN_PROBABILITY` | 0.5 | Whether a named model is a request | Measured requests 0.94–0.98, mentions 0.20; the midpoint separates them without live evidence for a finer cut. |
| `MODEL_REQUEST_MIN_CONFIDENCE` | 0.5 | Choice-confidence half of the request gate | Fixed by design (a wrong model name is a wrong model); no evidence to move it, and moving it would drop legitimate requests. |
| `vision` noul threshold | 0.6 | Hard vision filter | A false positive removes every text-only model, a worse error than a missed marginal image. |
| `tools`/`latency` noul threshold | 0.5 | `tools` hard filter, latency adjustment | Symmetric costs; 0.5 matches “more likely than not”. |
| `timeoutMs` (decision) | 3,500 | How long a step waits | Every failed decision is a step without a route; retrying a quota failure only doubles the wait. No retry added. |
| `maxMessages` / `maxStateChars` / `maxMessageChars` | 10 / 12,000 / 2,000 | Prompt window and size | The request line is guaranteed independently of the window; 12,000 characters is roughly 3–4k tokens for the decision model and is already the largest input consumer. |
| summarizer `timeoutMs` | 12,000 | Digest deadline | Measured ~2.2 s for a 46k-character transcript with thinking off; the deadline is a safety net, not a budget. |
| summarizer `maxChars` | 900 | Digest length | The digest is a framing aid, not the transcript; the decision state already caps it at a third of the budget. |
| summarizer `minMessages` / `refreshEvery` / `maxInputChars` | 6 / 6 / 48,000 | When and what to summarize | Short sessions lose detail when summarized; refreshing every step costs a call per step; 48k characters bounds the summarizer input. |
| digest `temperature` | 0 | Digest determinism | A reading task; stable digests are the point. |
| `DEFAULT_POLICY` min/switch fields | 0.5/0.5/0.4 | Nothing today | Kept in the config contract so the settings page still renders values; L1. |

`mergeConfig` (`src/index.js:96`) merges `DEFAULT_POLICY` and `DEFAULT_DECISION`
without coercing types. The two live gates fall back through `num()`, the
settings page clamps submitted policy values to `0..1`, and the decision
deadline now falls back on a non-finite value. The remaining numeric state
limits (`maxMessages`, `maxStateChars`, `maxMessageChars`) are used
arithmetically and are trusted as operator-authored; a string value in a
hand-written patch would corrupt the slice arithmetic. Fixing that belongs in
the config layer, not the prompt builder.

---

## 4. Deliberately left alone

- **Question wording and ordering.** No grounded reason to reorder; changing
  anchors without a live endpoint would trade one unverifiable prompt for
  another. The depth-0/intent overlap (§1.5) is safe because the parser uses
  them independently.
- **Acknowledgement corroboration.** The parser trusts a confident
  `acknowledge` even if the model scored depth 3; requiring the two answers to
  agree would be a new gate with no measurement behind it. The measured
  intent-confidence separation is the evidence the threshold was built on.
- **The min/switch policy fields.** Wiring `minConfidence` into the parser
  would change acceptance by feel. They stay inert and documented (L1).
- **English-only criteria and an English digest contract.** The descriptions are
  semantic and the model reads the user’s language; adding per-language examples
  biases every other language, and the Chinese token risk was addressed where it
  is mechanical (M5). The digest is not told which language to answer in; the
  decision model reads either.
- **“Use the digest only to judge risk”.** Removing the restriction would bring
  back the bug it fixed (session difficulty leaking into the step profile); the
  intent question still reads work-in-flight from the recent tool calls, which
  are in the window by construction.
- **Decision retry.** No retry on HTTP errors: every retry would double the
  deadline on a step that must not wait, and quota errors do not clear in
  milliseconds. A failed decision leaves the current route alone.
- **`maxStateChars` / `maxMessageChars`.** Reasonable token budget; no measured
  failure, so no change.

---

## 5. Logging: what a shadow-mode record proves today

The in-memory ring (`decisions`, last 40) plus `status`/`snapshot` is the only
evidence in shadow mode; `logDecisions` defaults to `false` and the info logger
only writes non-`ranked` sources.

| Needed to audit later | In the record today | Where it would come from |
|---|---|---|
| raw reply | no | `raw` is only in `explain --includeRaw` |
| parsed `intent` / `acknowledged` / `requestedModel` | no (only the `acknowledged` counter) | `parseDecision` returns them; the record drops them |
| completeness (which questions were missing) | no (confidence `0` is the only signal) | parser knows the required set |
| profile, confidence, tier, model, source | yes | record |
| ranking, reasons, floor plan | yes when source is `ranked` | `ranking` on the record; `status` prints the floor note |
| digest used | no | `digestCache.peek(agent)` |
| error | yes (`error`), plus `latencyMs` | record |
| token usage / server latency | `inputTokens` (now populated), `serverLatencyMs` not recorded | client now fills both; `index.js` records only the first |
| gate outcome (why an acknowledgement or request was declined) | no | parser would need to return the gate values |

All of these can be added inside `index.js` without changing the decision
contract; the raw reply needs an opt-in because of its size. The parser already
returns `intent`, `acknowledged`, `requestedModel` and an honest `confidence`,
and reporting the missing required questions is a small parser addition.

---

## 6. What needs a live decision endpoint to verify

1. **Completeness rate.** Does the live endpoint answer all eight required
   questions on every call? A nonzero rate of confidence-`0` decisions means the
   partial-answer fallbacks are load-bearing; if that rate is high, the product
   decision is whether a partial reply should keep routing (today it does) or
   fall into the error path.
2. **Confidence format.** Do `choice` answers state `confidence` or
   `probabilities`? Without either, the choice-confidence gate cannot be
   cleared, so acknowledgements and model requests never fire after H2. This
   check must be run first: it determines whether the conservative gate is too
   strict against the real endpoint.
3. **Acknowledge separation after H2.** Are acknowledgements still recognised
   at the `0.6` floor when the endpoint does state confidence? The measured
   0.47–0.99 range was recorded before the evidence-less default was removed.
4. **Model request rate.** Do explicit requests still pass both floors on real
   traffic, and do model ids quoted from logs stay below `0.5`?
5. **Digest completeness in Chinese.** Does a Chinese transcript produce a
   complete GOAL/DONE/NOW/RISK digest under the new 1,800-token cap, and does
   the digest refresh carry the right number of new messages?
6. **Local/unauthenticated summarizer.** Confirm the digest call succeeds
   without a credential on the deployment that uses none (M2).
7. **Off-shortlist requests.** How often does a user name a model outside the
   top-40 shortlist? That rate decides whether M6 is a real problem or a
   rare one.
8. **Reuse rate.** After the fingerprint change, the decision counter should
   match steps up to genuine signature reuse (same prompt text within 120 s),
   not to collisions. Watch `stats.decisions` against steps.
9. **Token/latency telemetry.** With `inputTokens` now populated, record the
   real prompt size (4–8k question characters + state) against the endpoint’s
   context and price.

---

## 7. Verification

- `bash scripts/build.sh` must run before the suite: the boot test imports
  `lib/index.js`, and `lib/` is the copied `src/`.
- `npm test`: 259 tests, 259 pass, 0 fail on the shared tree (the 15 tests added
  here plus the concurrent database audit's additions). The decision, summarize
  and intent suites are 55/55 on their own.
- The 15 new tests were run against the previous sources in a detached worktree
  and all 15 failed there; each name states the invariant it pins.

## Addendum — the three host-side items (§ M6/M7/M8) are closed

- **M6 shortlist.** `offerModelIds(pool, routes)` now emits `provider/model` keys
  (a bare id is ambiguous when two catalogs serve one model), puts every pinned
  route model first — the operator configured it, so the decision model must be
  able to name it — then the measured ranking order, deduplicated and capped.
  The parser already matches `requestedModel` against the candidate key first.
- **M7 shadow record.** Each decision record now carries the raw answer
  (`answer`, clipped to 1500 chars), `intent`, `acknowledged`, `requestedModel`
  and a `steered` flag beside the profile/ranking it used. Shadow decisions are
  reviewable without re-running the endpoint.
- **M8 steering.** The host decides whether the claimed message arrived mid-turn
  (the last history entry is a tool call/result) instead of inferring "steered"
  from a non-empty claimed batch — which was true on every new turn. `buildState`
  accepts the explicit signal and keeps the old behaviour only when it is absent.

## Live validation against bailian-aliyun (deferred §6 checks)

The endpoint was switched from the exhausted token-plan reseller to
`bailian-aliyun` (`decision-model-preview` at .../compatible-mode/v1/systemone),
and the deferred checks were run with the plugin's own prompt builder. The
repeatable harness is `node scripts/decision-smoke.mjs` (key via env; exits
non-zero on an invariant failure).

Results on 8 representative requests (state 101–143 chars, 10/10 questions
answered, latency 164–175 ms, ~1.42k input tokens):

| check | result |
|---|---|
| §6.1 does the endpoint state confidence/probabilities | **Yes** — every choice carries `confidence` and a full `probabilities` map; `depth`/`breadth`/`risk` carry probability mass over 0–4. The 0.6 acknowledge and 0.5 model-request gates can therefore fire. |
| §6.2 completeness | 10/10 answers in 8/8 cases, parse confidence 0.18–0.74 (never 0) |
| §6.3 acknowledge separation | "continue" mid-turn → `intent=resume` (0.80). "ok" mid-turn → `intent=work` (0.18): low-confidence, so the ack gate does not fire and the step routes as work. Left as observed — tightening the prompt for "ok" would trade a rare ambiguity for a false-ack risk. |
| §6.4 model request | listed model named → `requestedModel` returned with probability 0.99; off-shortlist model → `null` (auto 0.96), so the shortlist constrains the answer |
| §6.5 Chinese digest | 492 chars, 4 lines, GOAL + RISK present under the 1800-token cap; Chinese input request parsed as `edit` (0.71) |
| §6.7 real prompt size | ~1,417–1,424 input tokens for a 100–150 char state; the per-question legend dominates the prompt |
| §6.9 language | Chinese request classified without degradation |

Shape accuracy on the sample: rename → `edit`, trivial lookup → `lookup`, design
→ `design`, off-list request → `docs`. Both Bailian deployments serve the
System One protocol for `decision-model-preview`, although bailian-aliyun does not
advertise that id in its model catalog — the decision picker therefore also lists
the models of configured decision endpoints, not only catalog rows.
