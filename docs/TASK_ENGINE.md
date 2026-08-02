# The Anjadhe Task Engine — architecture, invariants, failure taxonomy

Status: living design doc, created 2026-08-01 after findings #37–#48 (eight
harness fixes in three days, each correct, each discovered reactively by a
live run). This doc exists so that stops: the engine is built TO this
design, and every new failure mode is judged against it. **The change rule
is at the bottom — no patch without a law.**

Companion docs: `docs/COWORK_AGENT.md` §9 (the C9 build arc and its
findings log), §4/C4 (the original task mode). The research grounding
(LangGraph/ReWOO/LLMCompiler, Anthropic's agent engineering posts, Manus
context engineering, Cognition, BFCL/AgentBench small-model data) is
summarized in §9's source list.

## The contract, in one paragraph

A task turns a GOAL plus MATERIALIZED INPUTS into a DELIVERABLE through a
validated pipeline: **intake → plan → gated execution → verify → report**.
The model is only ever invoked in narrow, single-purpose, schema-forced
calls sized to their output. ALL control flow, iteration, state, and
validation live in the harness. The design target is a ~12B–27B local
model, and the benchmark reality that dictates everything: models at this
scale are near-ceiling on ONE constrained call against a flat schema, and
collapse to 20–40% on self-driven multi-step sequences. Every gain left is
in moving loop control, state, and verification into the harness.

## The invariants (the laws)

- **I1 — Materialized inputs.** No step runs on data that is not already
  in harness state (the context snapshot, the results map). Conversation
  text, attachment text, and image transcriptions are materialized at
  intake; a goal whose referenced data cannot be materialized stops AT
  INTAKE with a question, never mid-run. (Violations: findings #41, #48.)
- **I2 — Narrow typed calls.** Every model call has one purpose, a forced
  schema where structure matters, a token budget sized to its largest
  legitimate output, and harness-side validation of the result (llama.cpp
  fails open on grammar errors). A call asked to carry a list carries it
  ONCE. (Violations: #44, #47.)
- **I3 — Gated progression.** A step's output passes its gate BEFORE any
  later step consumes it: derived-output checks (an items-producer must
  yield a non-empty list; a foreach must cover its items) and plan-carried
  post-conditions run at the step boundary, not just at the end. Gate
  failure is a wrong-output failure (see taxonomy), not silent progress.
  (Violation: #47 — the starved foreach discovered the miss a step late.)
- **I4 — Classified failure.** A failure is classified before it is
  handled; the handler and bound come from the class, never improvised:

  | Class | Signal | Handler | Bound |
  |---|---|---|---|
  | Transient | engine down, timeout, 429, truncated call | retry same call, backoff | 2–4 retries |
  | Wrong output | gate failed, count check missed, verify issue | ONE informed retry — the failure evidence rides the retry context (blind retries degrade results; ICLR 2024) | 1 per step |
  | Structural | step impossible, approach dead, tools missing | replan the remainder (shape-linted, delivery-checked) | MAX_REPLANS (2) |
  | External | permission denied, data only the user has | pause with a named ask (Question/Review), notify if unattended | until answered |

- **I5 — Plans deliver goals.** Plan shape is enforced deterministically:
  a per-item goal carries a foreach (lint → one revision → harness
  fallback plan); a replan may not drop the fan-out while per-item work is
  undone; the final step produces the goal's OUTPUT — preparation
  (batching, listing, planning) is never a complete plan. (Violations:
  #43, #45, #46.)
- **I6 — Evidence-derived truth.** Completion claims, card notes, and the
  report derive from harness evidence: the results map, mechanical checks,
  the write ledger, and the verifier's goal verdict. Model prose never
  gets to declare success. (Violations: #42, #44, #45.)
- **I7 — Bounded and resumable.** Every loop has a cap; every cap PAUSES
  resumably (fresh allowance on Resume) rather than dying; partial work
  (foreach rows) is persisted incrementally so resume skips what's done.
  Long-horizon is achieved by resumability, not by unbounded runs.

## The pipeline

### 1. Intake — materialize, then gate
- Materialize: conversation tail (text turns), non-image attachment text
  (folded into the snapshot), attached images (ONE vision transcription
  call, `task-image-extract`, lists verbatim and in full), the goal.
- **Readiness gate** (`task-intake`): for goals that REFER to material
  ("the list", "the attached…", "provided above" — deterministic
  pre-filter, so ordinary goals skip the call), one forced-JSON check:
  does the material contain the referenced data? Missing → the task stops
  BEFORE planning with a named ask ("Can't start: … — add it to the chat
  and start the task again"). Two replans were burned in run #48
  rediscovering an absence that was knowable in one look.

### 2. Plan — typed, linted, goal-specific
- Steps are typed: `{kind: single|foreach, step, tools, items_from,
  per_item, check}` — kind and tool groups enum-forced (unemittable
  hallucinations), foreach refs validated against final plan positions.
- Deterministic lints, in order: shape (per-item goal ⇒ foreach exists),
  reference validity, delivery (the last step produces output, not prep).
  Lint failure → ONE revision with the objection → harness fallback plan
  (structure is the harness's; wording comes from a tiny fill-in call so
  the approval card reads like the goal, not like machinery).
- Effort scaling in the prompt: fewest steps that deliver; 1–2 for simple
  goals; list + foreach for per-item goals.

### 3. Execute — gated steps over one unit loop
- One shared bounded tool loop (`_runUnit`) under every step kind:
  permission gate (same as chat), stall detection, budgets, vision
  hand-off, typed closing (`_closeUnit` — status/result decode-forced;
  sentinel parsing survives only as the plain-json-downgrade fallback;
  the round-cap exit also closes, salvaging partial rows).
- `single` steps: goal + context + plan-so-far + the step; closing
  demands `items` (bigger cap, result-as-one-liner) when a later foreach
  consumes this step.
- `foreach` steps: the HARNESS iterates — chunks of 5, one unit per
  chunk with only that chunk in context, decoration-tolerant count check,
  one informed retry scoped to the missing items, JS aggregation,
  incremental persistence (`results` map) + per-chunk card progress, own
  time window that pauses resumably mid-list.
- **Step gate** (I3) before advancing: items-producers must have a
  non-empty list (typed or salvageable from numbered/bulleted result
  text); plan-carried post-conditions evaluate NOW. Gate failure → one
  informed re-run of the step → then structural failure → replan.

### 4. Verify — adversarial, then structural
- Mechanical checks first (they override model judgment, and an
  all-mechanical pass skips the model entirely).
- Model pass with READ-ONLY tools judges each step's intent AND the goal:
  findings end with "GOAL: achieved / not achieved — what's missing",
  judged by the goal's OUTPUT. Failed steps get one informed retry.

### 5. Report — evidence, honestly
- The report compiles the results map (full foreach rows, capped with an
  overflow note), never the 200-char card notes.
- Steps clean + goal unmet = honest failure naming what's missing; blocks
  recipe eligibility. Partial results are delivered as partial.

## State model (what persists where)

| State | Where | Notes |
|---|---|---|
| Task record (goal, plan, statuses, notes, log) | `agent-tasks` (synced) | capped log, 30 tasks |
| Context snapshot (+ attachment text, image transcription) | on the task record | pruned on settle |
| Results map (`results["<step#>"]` → {result, items, rows}) | on the task record | 12k/step, whole-row overflow drops, pruned on settle |
| Tool log (recipe recording) | on the task record | pruned unless recipe-eligible |
| Write ledger (undo) | WriteLedger scopes | C8.4 |
| Run journal (planned — C9.5) | per-run JSONL | resume-by-replay, exactly-once writes |

## Bounds (all in one place)

MAX_STEPS 8 · MAX_STEP_ITERATIONS 12 (×2 fan-out language) ·
CHUNK_ITERATIONS 8 · FOREACH_CHUNK 5 · MAX_TOTAL_TOOL_CALLS 120/round
(pause + fresh allowance) · STEP_TIME_MS 6 min (foreach: ×4, pauses
resumably) · MAX_WALL_CLOCK_MS 30 min/run · MAX_REPLANS 2 ·
MODEL_ERROR_RETRIES 2 (engine-down: 4 × 15s) · RESULT_STORE_CAP 12k/step ·
closing caps 1200 / 3000 (items).

## Build status

Built (2026-07-31 → 08-01): typed plans + foreach executor + count checks
(#46), results map + salvage (#47), typed closings (#44/#47), plan-shape +
replan-shape lints + fallback plans (#46/#47), goal verdict (#45),
attachment/image intake (#48), intake readiness gate, per-step gates,
**run journal** (tool journal in localStorage; exactly-once write replay;
evidence-derived activity on card + report; pruned on settle, orphans
swept at init), **recitation** (every 4th unit round, tail-side) +
**observation folding** (one large jump past 24k chars, last-4 keep
window), **task card** (collapse-on-completion with sticky expand,
journal-derived activity line, foreach item-coverage notes), **living
plan** (prune-only boundary replan after each successful step —
guard-railed so "ignore the revision" is the worst case).

Deliberately deferred (add only when a real run demands it):
- Full LLM-transcript resume-by-replay — steps re-run cheaply (reads
  re-execute, writes replay from the journal, foreach resumes item-exact).
- Per-tool-call lines folded under each step row (needs the full journal
  in the card's render path).
- Queued mid-run steering (composer seam, not engine work).
- Ask-shape glyphs (Notify/Question/Review) on paused cards.

Standing per-model note: Qwen-family gets native lazy-grammar tool
handlers in llama.cpp; Gemma rides the generic fallback — the eval
scorecard (C8.8, `--model`) is the release-time evidence for which brains
are task-grade (RELEASING 3a).

## What the field does (research pass, 2026-08-01)

Three-agent sweep over (a) real OSS agent codebases (OpenHands, Cline/Roo,
Aider, goose, AutoGPT platform, Open Interpreter, CrewAI, MetaGPT), (b)
research/fan-out engines (gpt-researcher, open_deep_research, dzhng,
smolagents-ODR, STORM, Jina node-DeepResearch, local-deep-researcher), (c)
local-small-model ground truth (BFCL/tau-bench, practitioner reports).
Full reports in the 2026-08-01 session; the load-bearing conclusions:

1. **Zero of the surveyed production agents execute a free-form
   model-authored plan.** Every one that tried removed it (OpenHands
   deleted its PlannerAgent and typed task actions; goose deleted its
   lead/worker planner split; AutoGPT replaced the autonomous loop with
   human-authored graphs). Where "plans" exist they are prose/markdown
   the model re-reads, or a model-maintained todo list the harness merely
   renders. Where decomposition WORKS, the structure is authored by code
   or humans: fixed pipelines (every research engine), YAML recipes with
   shell checks (goose), scripted agendas (Cline deep-planning). This
   engine's harness-owned foreach and fallback plans are that pattern;
   the model-authored plan survives here only because it is enum-typed,
   linted, and replaceable by the harness — keep it ≤3 steps and never
   loosen the guards.
2. **Fixed task-shaped pipelines are the only thing proven at 7–8B**
   (STORM on Mistral-7B, local-deep-researcher at 8B, MindSearch at 7B —
   all: control flow 100% code, LLM confined to flat 2–3-key schemas).
   Free-form agency at 12–32B benchmarks at 9–16% (smolagents GAIA).
3. **Multi-turn state-tracking is a MODEL property, not a harness
   property**: stock 4–14B models score 10–22% on BFCL multi-turn vs
   GPT-4o's ~47%; agentic fine-tunes (xLAM-2-8b) jump to GPT-4o-beating
   levels at 8B. Letta — the most sophisticated harness extant —
   requires frontier-class models. Harness returns diminish; model
   choice dominates.
4. **Live confirmation on this machine (finding #49)**: the identical
   engine that mega-planned and stalled on gemma4:26b (no tool tokens,
   generic llama.cpp handler) ran the 10-movie fan-out cleanly on
   qwen3.6:35b-a3b — native foreach plan, 10/10 items, adaptive
   read_url fallback when search died, honest caveats, 116s; eval
   scorecard 53/53 det + 7/7 model.

**Standing policy from this**: (a) task mode has a MODEL floor separate
from chat's — the catalog must say which brains are task-grade, from the
per-model scorecard (qwen3.6:35b-a3b is the first certified; Gemma-family
is chat/vision-grade, not task-grade); (b) new reliability effort goes to
task-family pipelines and model certification, not more generic harness;
(c) the deferred list above stays deferred.

**Certification log.** qwen3.6:35b-a3b: CERTIFIED 2026-08-01 (scorecard
53/53 det + 7/7 model; clean live fan-out runs — final confirmation 118s,
3/3 verified, goal achieved). qwen3.5:9b: evaluated 2026-08-01, NOT
certified — two live fan-out samples both settled `done` with correct
tables, but each needed one failure-replan (under-coverage once, a
step-1 stumble once). The engine makes it USABLE (the nets recover it);
the flag means RELIABLE (clean without nets). It stays the 16GB chat
default, uncertified for tasks. xLAM-2-8b-fc-r: evaluated 2026-08-01,
**INCOMPATIBLE** — tool calls emitted as plain-text JSON that llama.cpp's
--jinja parser doesn't map (0/7 model journeys), and its live runs were
FALSE GREENS (a one-item list for "the 10 movies", hallucinated
conclusions, self-rubber-stamped verify) — which yielded the
`_goalItemCount` gate (finding #53). No 16GB task brain is certified;
that is the honest current ceiling of the tier. Also observed at 9B: thinking-out-loud
artifacts leak into step results ("Wait, re-checking: …") — cosmetic,
noted for a possible report-side scrub.

**Built from this (2026-08-01) — capability routing.** Who decides what:
WE decide task-grade (scorecard + live-run evidence → catalog
`taskGrade` flag, remote-config so it updates without a release); the
USER decides their brain (a non-task-grade brain starting a task gets a
quiet advice row on the plan card with a one-tap switch —
`task.brainAdvice`, never a silent swap); the HARNESS decides mechanical
capability matches (`task-image-extract` routes to an installed
vision-capable model when the task brain can't see — logged in the task
log, honest skip when no vision exists anywhere). The MODEL decides
nothing about routing. Cloud engines and custom servers are assumed
task-grade (unprobeable, deliberately chosen).

## The change rule

When a live run fails: **name the violated invariant first.** If an
existing invariant was violated, fix the code to honor it (and add an eval
journey reproducing the run). If NO invariant covers the failure, add the
invariant to this doc first — stated generally, not as the day's symptom —
then implement it. A fix that can't name its law is a patch, and patches
are how this engine got eight findings in three days.
