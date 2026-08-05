# AI Assistant — Technical Design

> Status: descriptive, as built 2026-08-03. This document explains how the
> assistant actually works end to end — the chat loop, model plumbing, the
> tool system, permissions, long-running tasks, and routines (including how
> the app knows an email arrived). It is a map, not a plan: the planning and
> decision history lives in `docs/COWORK_AGENT.md`, the task engine's
> invariants in `docs/TASK_ENGINE.md`, and the trigger laws in
> `docs/ROUTINE_TRIGGERS.md`. When this doc and those disagree, those win —
> update this one.

## 1. Overview

There is ONE agent (`js/agent/agent-service.js`, `AgentService`) with two
execution modes sharing one tool registry, one permission gate, and one
user-chosen model brain:

- **Chat mode** — the streaming tool-call loop behind the assistant panel,
  the full-page Agent app, headless routine runs, and the `anjadhe` CLI.
- **Task mode** (`js/agent/task-service.js`, `TaskService`) — a harness that
  turns a goal into a validated plan → gated execution → adversarial verify
  → evidence-derived report. Used for multi-step outcomes and for
  unattended routine runs that may act.

Everything runs in the **renderer**; the main process is the enforcement
and transport layer (LLM HTTP, fs/shell scopes, MCP process lifecycle,
Gmail fetch, SQLite). Design principles that shape everything below:

1. **One brain, no hybrid.** The user picks a model entry (local llama.cpp,
   a self-hosted OpenAI-compatible server, or BYOK OpenAI/Anthropic); the
   app never routes around it or escalates to a bigger model. The design
   target is a local ~12B, so reliability is engineered in the harness.
2. **Permissions gate capability.** allow/ask/deny per tool call, with
   once/session/always grants, bounded standing grants (budgets, expiry,
   exclusions), and main-process enforcement for fs/shell.
3. **Truth from evidence, not prose.** What the agent changed comes from
   the write ledger; task completion comes from mechanical checks and a
   verifier, never from the model saying "done".
4. **Deterministic where it matters.** Trigger matching, tool scoping,
   adherence math, thread membership — anything a user must be able to
   predict is computed, never model-judged.

```
 User / Routine / CLI / Task step
          │
          ▼
 AgentService.sendMessage  ──────────────►  TaskService (plan/act/verify)
          │  scoped tools, system prompt              │ per-step calls
          ▼                                           ▼
 PermissionManager (allow/ask/deny) ◄── ASK_TOOLS, grants, budgets
          │ approved
          ▼
 AgentTools.execute ──► WriteLedger (pre-images, pills, undo)
          │
          ▼
 LLMLogger → electronLLM IPC → main.js openai(Stream)Request
          │
          ▼
 llama.cpp @127.0.0.1:18434 │ custom server │ OpenAI │ Anthropic
```

## 2. The chat loop (basics)

### 2.1 Conversations

- Stored in the synced `agent-conversations` key (cap 50); Terminal (CLI)
  conversations are partitioned into the machine-local `agent-terminal`
  key on every save. Shape: `{id, title, createdAt, updatedAt, messages}`
  plus per-conversation options: `model` (override), `contextMode`
  (`'simple'`), `thinkMode`, `scopedDomains` (grow-only tool-domain set),
  `extraContext`, `historyStart`, `recordKey`/`recordLabel`,
  `egressTainted`, `numCtx`.
- Messages carry `metadata: {model, sources?, records?, actions?,
  undoScope?}` — all four derived deterministically from tool results, not
  from model prose (§4.6, §5.4).
- **Record-scoped chats**: `openConversationForRecord(recordKey, label)`
  reuses a ≤24h-old conversation bound to the same record, seeds tool
  domains from `RECORD_DOMAINS`, and writes a durable `extraContext`
  naming the record. `AgentContext.getActiveRecord()` supplies the record
  when the panel opens over an app that exposes one.
- Leaving a conversation queues **memory extraction** (§2.4).

### 2.2 Anatomy of a turn (`AgentService.sendMessage`)

1. Guard: one stream per conversation. Mint `streamId`, register
   `_streamingState` (the registry `BackgroundWork` and Stop read).
2. Persist the user message; auto-title; seed a provisional
   `conv.goal`.
3. **History window** — hysteresis, not sliding: `historyStart` is sticky
   and only jumps (to `length − 12`) when the window exceeds 24 messages,
   so between jumps the prompt prefix is append-only and llama.cpp's KV
   cache keeps re-using it.
4. **Scope** — `scopeText` = last 3 user messages + attachment names + the
   tail of a just-confirmed offer. `AgentTools._domainsForMessage(scopeText)`
   unions into `conv.scopedDomains` (monotonic, again for prefix
   stability). Tier resolution (§2.5) picks simple vs full context.
5. **Prompt assembly** (§2.3) — one system message + the briefing on the
   first user message of the window + CURRENT CONTEXT on the newest.
6. **Tool set** — `AgentTools.definitionsFor(scopeText, scopedDomains)`,
   then four filters in order: drop `web_search` when search is
   unconfigured; simple turns keep only `{web_search, read_url, think}`;
   `readOnly` (headless routines) keeps only read-only tools; the
   **untrusted-context filter** drops `UNTRUSTED_BLOCKED_TOOLS` when the
   foreground app is `browse`/`email` or `AgentService.untrustedInput` is
   set (§5.5). Computed once per turn — the model sees a stable list.
7. **Model call** — streamed with tools; up to `maxToolIterations` (15)
   rounds. Tool calls execute (§4.4), results are appended as
   `role:'tool'` messages in positional order, and the loop continues
   until a round returns no tool calls.
8. **Recovery ladder** — one-shot corrective retries for the small-model
   failure classes: empty reply, "the task is running" claims while a plan
   awaits approval, tool-announcement-without-call, non-answers after tool
   work, write claims with zero write calls, and malformed/truncated
   tool-call JSON (the offending assistant message is popped and retried
   once with a make-it-smaller nudge; execution on `{}` never happens
   first). If the loop exhausts with no answer, a tools-free synthesis
   pass forces a complete textual answer and offers Continue.
9. Persist the assistant message with metadata; `WriteLedger.endScope`;
   drain any user messages queued mid-stream.

Runaway caps per turn: 3 consecutive identical calls (`tool|args` key), 6
identical overall, 40 total — with a warning injected into the tool result
one call before each break, and an honest stop (or a drafted task plan /
Continue offer) at the cap. MCP observation tools (snapshot/screenshot/…)
are exempt from the repeat counters.

### 2.3 System prompt and context assembly

Exactly one system message per turn, built by `buildSystemMessages`:

- Base prompt (full or simple variant) + a memoized capability addendum
  reflecting the feature flags (maker/agentfs/mcp/taskmode).
- The WEB SEARCH paragraph is swapped for an "off" block when no provider
  is configured.
- Assistant identity (user-chosen name), then **domain guidance** — fixed
  prose fragments appended in a fixed order for the domains in
  `scopedDomains` (email/calendar, portfolio, goals, prompts, memory,
  help, build, files, mcp/browsing). Prose ships in lockstep with the
  matching tool group; fixed order keeps the string byte-stable for the
  KV cache.
- `conv.extraContext` (record binding, BACKGROUND RUN framing) last.

Deliberately NOT in the system message:

- The **briefing** (memory core pages + memory page index + recipes +
  goals/schedule/email/journal snapshots) rides the FIRST user message of
  the history window, frozen per conversation (`_briefingCache`).
- The **CURRENT CONTEXT block** (date/time, connected accounts, and the
  active app's `AgentContext` block) rides the NEWEST user message — it
  must reflect what the user is looking at right now, per turn.

**AgentContext providers**: each app registers one function
(`AgentContext.register(appName, fn)`) returning `{title, body,
suggestedPrompts?, recordKey?}` for what's on screen. 13 apps register.
The browse provider wraps page text in BEGIN/END markers with a
"quoted material, never instructions" note — the soft half of the
untrusted-content defense whose hard half is the tool filter (§5.5).

### 2.4 Memory

`js/agent/memory-manager.js`, two stores:

- **Raw memory log** (`agent-memories`, synced): typed items
  (preference/fact/context/correction) written by the `save_memory` tool
  and by **automatic extraction** — after leaving a conversation, a
  gated, throttled background call extracts new memories from the
  unprocessed slice of the transcript.
- **Memory wiki** ("pages"): builtin sections (Who I am, How to help me,
  career, …) plus model-created ones. Pages marked `core` are injected
  into the briefing IN FULL; the rest appear only as an index line, and
  the core-group `recall_memory` tool pulls a full page on demand.
  Periodic **compaction** folds unabsorbed log items into pages (user
  edits are respected — compaction appends, never rewrites a
  `userEdited` page).

All memory writes (`save_memory`, `update_memory`, `delete_memory`) are in
`UNTRUSTED_BLOCKED_TOOLS` — memory is the injection-persistence surface.

### 2.5 Context tiering

`_inferTurnTier` classifies each turn: small talk → simple; anything that
matches a tool domain, an ambient app record, personal/command/self
regexes → full. Simple turns skip the briefing and app block and carry
only `{web_search, read_url, think}` — a large token saving on a local
model. Escalation is monotonic per conversation (`_ctxEscalated`), and a
record-bound or domain-scoped conversation is always full.

### 2.6 Streaming, stop, queueing

- One `streamId` per turn, reused across all tool iterations, so one
  Stop (`abortConversation` → `electronLLM.abortStream`) kills whichever
  HTTP call is in flight, plus `AgentUI.dismissToolConfirms` denies any
  open consent cards.
- Chunks flow through `LLMLogger.callStream` → `llm-chat-stream` IPC;
  thinking (`<think>…</think>`) is split off in main and forwarded as
  separate events; TTFT is measured on the first content chunk.
- Messages typed while streaming are **queued** (`queueMessage`) and
  drained at the top of the next tool iteration with an explicit
  "sent while you were working" framing on the LLM copy.
- `getActiveStreamingConvIds()` is the `BackgroundWork` source that makes
  Cmd+R warn before killing a live stream.

## 3. Models and engines

### 3.1 Model entries — the brain

The user keeps a LIST of engine+model entries in the machine-local
`agent-settings` key (`modelList`, `defaultModelId`): engines are
`llamacpp` (managed local llama-server), `server` (user-hosted
OpenAI-compatible endpoint, `baseUrl` on the entry), and the BYOK cloud
engines `openai` / `anthropic` (per-entry key, encrypted in main). The
default entry is the **brain**; `setDefaultEntry` writes through to the
legacy provider settings (`_syncBrainToEntry`) so non-agent features
(email insights, feed prompts) follow it, warms local models, and kicks
stalled background AI (`_kickBackgroundAI` → email backlog, bundle
classification, `PromptFeed.tick`). Conversations may override the model
per chat; the entry is resolved ONCE per turn so a mid-turn switch never
applies halfway through a tool loop.

- `isMeteredBrain()` — true only for `openai`/`anthropic` (narrower than
  "remote": a self-hosted server costs nothing per call). Consumed by the
  email insight engine to keep the pre-model shortlist on installs where
  every call is the user's money.
- `isTaskGrade(entry)` — catalog flag behind task mode's separate model
  floor; a non-task-grade brain gets a visible advice row on the plan
  card, never a silent swap.
- Vision capability is read from the model catalog (`mmproj`) and gates
  image attachments and image-bearing tool results.

### 3.2 The local engine path

`chatParams.engine` routes in main: `llamacpp` → `llamaCppChatConfig` →
`LlamaCppManager.ensureModel(model, numCtx)` → an OpenAI-compatible HTTP
call to `http://127.0.0.1:18434/v1/chat/completions` with a per-spawn
`--api-key`. One process serves one (model, ctx, mmproj) triple; changing
any of them restarts llama-server and dumps the warmed KV cache — which is
why every call site (chat, prewarm, extraction, tasks) must pass the same
`num_ctx` (`entryNumCtx`: entry override, else a RAM-tiered auto value).
`--jinja` gives grammar-constrained tool calls: malformed argument JSON is
unemittable, so the remaining failure mode is truncation
(`finish_reason:'length'`), which the loop detects and retries (C8.1).

Warm lifecycle: `prewarm()` primes the prefix cache with exactly what a
fresh chat sends (system + core tools, `maxTokens:1`); `warmOnIntent()` is
the light load on panel open; idle unload after 10 min; memory-pressure
unload; a share watchdog keeps the model resident while LAN sharing is on.

`openaiStreamRequest`/`openaiRequest` in main are the two transport twins
for every engine (llamacpp/server/cloud share them); both carry
`finish_reason` in the return contract, support `format` (forced JSON /
JSON-schema), scrub lone surrogates, and normalize Anthropic's
`stop_reason` onto the same field.

## 4. The tool system

### 4.1 Registry

`js/agent/agent-tools.js` — `AgentTools.definitions` (OpenAI function
schemas) + `AgentTools.handlers` (name-keyed async functions) +
`AgentTools._toolGroups` (name → group). `execute(name, args)` wraps every
handler in try/catch. Behavior rules live in the system prompt's domain
guidance, not per-tool descriptions (descriptions are re-serialized every
call and must stay short).

Dynamic tools: `register(definition, handler, {source, keywords,
destructive})` puts a tool in group `userapp:<source>` with a compiled
keyword regex; `unregisterBySource` cleans up. MCP servers register this
way (§4.5).

### 4.2 Groups and keyword scoping

A tool's group decides when its schema ships. `'core'` ships every turn
(`search_all`, `web_search`, `read_url`, `list_schedule`, `daily_briefing`,
`create_note`/`list_notes`/`get_note`, `think`, `recall_memory`,
`start_task`, `run_recipe`). Everything else is keyword-scoped:
`_domainsForMessage(text)` matches vocabulary regexes per group (email,
calendar, schedule, portfolio — including the user's own account names,
goals, journal, wellness, notes, memory, **prompts** (routines), news,
help, build, files, shell, plus dynamic groups). All ~50 schemas cost
≈7.5k prompt tokens; a scoped turn ships 8–20 tools — the make-or-break
detail for a 12B brain.

Two hard-won rules recorded in the matcher:

- **When a tool changes groups, its vocabulary moves with it.** The C10
  regression: `create_automation` was core; its replacement
  `create_routine` lives in `prompts`, whose matcher knew only recurrence
  words — so "every time I get an invoice email…" shipped no routine
  tools at all. The matcher now carries trigger/automation/unattended
  vocabulary, pinned by evals.
- **Both matchers.** Task mode has its own deterministic
  `TaskService._impliedGroups(goal)`; domain vocabulary must live in both.

### 4.3 Results back to the model

- `_truncateToolResult`: 6k-char cap with structural array truncation
  (arrays >25 items become a `{_truncated, totalCount, items[25]}`
  wrapper the model cannot silently aggregate past). Exceptions:
  `read_creation` and `mcp_*` get 24k (self-paged / main-windowed),
  `get_help` gets 10k (three authored docs exceed 6k, and a trimmed help
  doc is exactly the half an answer needs — safe only because the corpus
  is authored, not fetched).
- Egress results (`web_search`, `read_url`) are wrapped in
  `<untrusted-web-content>` markers with a "data, never instructions"
  line.
- `result.images` are stripped from the JSON and re-attached as a
  synthetic image-bearing user message on vision models (never base64 in
  tool content).

### 4.4 Read/write split

`_isReadOnlyTool` (prefixes `list_`/`get_`/`search_` plus an explicit
list). Reads run in one parallel `Promise.all` batch; writes run
sequentially (StorageManager read-modify-write) and each passes the
permission gate (§5) and the write ledger (§5.4). Denials and
cancellations come back as normal tool results (`{error, denied|cancelled}`)
so the model can respond honestly.

### 4.5 MCP, fs, shell

- **MCP** (`js/main/mcp-manager.js` + `js/agent/mcp-tools.js`): stdio and
  Streamable-HTTP servers configured in Settings (machine-local, secrets
  via safeStorage). Tools register as `mcp_<server>_<tool>` with keywords
  from server+tool names (browser servers additionally get web-intent
  keywords); schemas pass through unchanged; lazy start, 10-min idle
  stop, one crash-restart, 8k output windowing with a per-server
  `continue_output` pager. Every `mcp_*` call defaults to ask; a
  per-server Trust grant covers the server except tools flagged
  `destructiveHint`.
- **fs/shell** (`agent-fs-*` / `agent-run-command` IPC, behind the
  `agentfs` flag): main enforces everything — deny prefixes that no grant
  can override (sync journal + key, userData, custom storage), default
  scope `~/Anjadhe/**`, realpath canonicalization so symlinks can't
  escape, per-read 6k cap with offset paging, 5MB writes, shell
  allowlist (read-only commands, no metacharacters, no sudo, `cat`
  deliberately excluded in favor of path-scoped `fs_read`), exact-command
  grants (H1: prefix grants were widenable), secret-scrubbed env, and a
  deny-path scan over every command's arguments. The renderer pre-flights
  for dialog UX; **main re-checks at execution time** with one-shot grant
  consumption.
- **Documents** (C8.2): `fs_read` routes PDFs through the shared
  extractor with offset paging; near-zero text triggers macOS Vision OCR
  (JXA + VNRecognizeTextRequest — no bundled engine); xlsx/docx extract
  via a dependency-free zip+XML reader; images return `images:[{dataUrl}]`
  for the vision hand-off. `read_url` follows PDFs to the same extractor.
  `read_email_attachment` rides the same helpers in one IPC hop.

### 4.6 Help actions — the assistant as front door

`get_help`/`get_setup_status` (group `help`) return authored docs plus an
`actions` list of ids resolved against `js/agent/help-actions.js`
(`HelpActions`). Two invariants: every action **navigates, never mutates**
(a mutating button would route around the permission machinery), and
**labels live in the registry, ids on the message** (only ids persist and
sync; a gated action drops out; a model cannot invent a button).
`recordActions` harvests ids off tool results into `metadata.actions` —
the same deterministic path as `sources` and record pills.

## 5. Permissions and safety

### 5.1 Resolution

`PermissionManager.resolve(tool, args)`, synchronous, in order: hard
denials (fs/shell — produced by main) → persisted grants (with bounds) →
session grants → MCP policy (default ask; server trust; destructive
override) → static `ASK_TOOLS` + the `/^delete_/` prefix rule → default
allow (reads and in-app writes run silently).

`ASK_TOOLS`: `send_email`, `trash_email`, calendar create/update,
`add_transaction`, `update_cash`, `create_routine`/`update_routine`
(arming commits unattended runs — the dialog IS the auto-run consent),
`create_artifact`/`edit_artifact`, `fs_trash`, `run_applescript`.

### 5.2 Grants and bounded autonomy (C8.6)

Grants live in the machine-local settingsStore (they reference machine
paths — never synced). A standing grant may carry a daily `budget`, an
`expiresAt`, and `exclusions` — the first concrete one being
`send_email`'s `new_recipient` (auto-attached on grantAlways): a
recipient not found in the user's mail history still asks, with the
reason in the dialog. Exhausting a bound never silently downgrades — the
verdict is an ask that names the limit. `_isKnownRecipient` reads
`EmailApp.emails` (the live SQLite-backed array — the old blob-field read
answered "stranger" for every address; see §7.4's law about ghost reads).
Settings › AI Assistant lists standing grants grouped
(files/commands/servers/app abilities) with bounds and revoke.

### 5.3 The consent flow

A write resolving to `ask` goes through `AgentService._confirmWrite`:
CLI conversations route to the TTY; otherwise `AgentUI.confirmToolCall`
renders an **inline ask card** above the composer (modal fallback when no
agent surface is visible), queued FIFO with a "+N waiting" counter, three
scopes (once / session / always), and honest notes (grant scope, bound
exhaustion, new-recipient reason). Stop denies the whole queue. Approval
records the grant at the right layer (main for scoped fs/shell, renderer
for tool/server grants); every outcome lands in a capped machine-local
decision log.

### 5.4 Write ledger and undo (C8.4)

`js/agent/write-ledger.js` — the single recorder every mutating tool
result passes through, in chat, tasks, and recipe replays. Per-scope
(turn or task run): entries `{at, tool, action, target, …}`, generic
**pre-images** captured by a hook on `StorageManager.set` during the tool
execution window (JSON-deep-copied, 2MB/scope with an honest `overflow`
flag), after-hashes for conflict detection, and fs pre-images kept by
main. Machine-local key (pre-images are large; undo is local).

- **Record pills** under an answer are `pillsForScope()` — a view of the
  ledger, never a parallel derivation from prose.
- **Undo** restores pre-images per key, skipping (and reporting) keys the
  user changed since; tombstones records the union-merge would otherwise
  resurrect; file undo replays newest-first (moves un-move before
  pre-images land); external actions (`EXTERNAL_TOOLS` + every `mcp_*`)
  are honestly labeled "cannot be undone from here".

### 5.5 Untrusted input — a property of the run

`AgentService.UNTRUSTED_BLOCKED_TOOLS` is ONE list of tool classes
withheld when the model's input is attacker-supplied: external comms and
mail mutation (`send_email`, `trash_email`, `modify_labels`), calendar
create/update (invites reach attendees), financial writes
(`add_transaction`, `update_cash`), memory writes (injection
persistence), and every delete. Local reversible writes stay, so triage
("read this invoice and make me a task") still works.

Two enforcement points, deliberately fed from the one list:

- **Chat**: dropped from `scopedTools` when `AppManager.currentApp` is
  `browse`/`email` OR `AgentService.untrustedInput` is set.
- **Task steps**: `TaskService._toolsForGroups(groups, implied,
  task.untrustedInput)` — set at task creation by `PromptFeed._runAsTask`
  for email- and file-triggered routines. This closed the C10 gap where
  an unattended routine fired by an incoming email (no foreground app)
  got the full tool surface — the "autonomy × prompt injection" standing
  risk.

Prompt framing (BEGIN/END markers, "data, never instructions") is the
first line; the tool filter is the backstop for when a 12B follows the
injection anyway.

### 5.6 Egress gate

`read_url`/`web_search` are read-only but outbound. Once a conversation
is **tainted** (carries attachments, or any non-egress tool has run —
i.e. private data is in context), egress calls leave the parallel batch
and require an origin-scoped grant (`read_url:<origin>`), so injected
instructions can't quietly exfiltrate context to an attacker's URL.

## 6. Task mode — long-running work

Authoritative doc: `docs/TASK_ENGINE.md` (invariants I1–I7; change rule
"no patch without a law"). **A v3 redesign is proposed there (2026-08-03,
"one session, soft plan" — laws I8/I9, I2 amended) — read it before
extending what's described here.** Summary of the machine as built:

### 6.1 Contract

A task turns a GOAL plus **materialized inputs** into a deliverable
through intake → plan → gated execution → verify → report. The model is
only invoked in narrow, single-purpose, schema-forced calls; **all
control flow, iteration, state, and validation live in the harness** —
the one architecture that works at the 12B–27B floor (models near-ceiling
on one constrained call collapse on model-driven multi-step sequences).
One task at a time; entered via the core `start_task` tool (chat routes
multi-app / bulk / research fan-out asks to it); no nesting.

### 6.2 Intake (I1 — materialized inputs)

`TaskService.start(goal, conversationId, opts)`:

- Materializes the conversation tail (20 turns / 6k chars) + attachment
  text; attached images get ONE vision transcription call (routed to an
  installed vision model if the brain lacks vision — logged, never
  silent).
- A deterministic pre-filter (`_goalReferencesMaterial`) plus one
  forced-JSON readiness gate stops "the list above"-shaped goals whose
  material isn't actually present — at intake, with a question, never
  mid-run.
- Attended runs on a non-task-grade brain get `brainAdvice`
  (recommendation on the plan card; the user decides).

### 6.3 Plan (I5 — plans deliver goals)

One forced-JSON call under `_planSchema`: ≤8 steps, each
`{kind: single|foreach, step, tools: [enum of live groups], items_from,
per_item, check}`. Hallucinated tool groups are unemittable (enum);
optional per-step `check` post-conditions (`file_exists`, `note_titled`,
`schedule_item_titled`) are evaluated mechanically later. Deterministic
shape enforcement: a per-item goal without a `foreach` triggers one lint
revision, then a harness-built fallback fan-out plan; a trailing
`foreach` gets a delivery step appended (preparation is never a complete
plan). Attended runs stop at `awaiting_user` — **plan approval is the
consent moment**; unattended runs (armed routines) go straight to
running with a system notification.

### 6.4 Execution (I2, I3, I7)

Per step: tools = step's declared groups + `_impliedGroups(goal)`
(deterministic capability routing — a goal that names email gets email
tools on every step) + core, minus `start_task`, minus the untrusted
block. The step prompt carries the goal, the context snapshot, the plan
so far with done-step results inlined, and this step only — **no
briefing**.

The shared unit loop (`_runUnit`): bounded rounds (12, ×2 on fan-out
language), 6-min step time box, recitation every 4th round, one
observation-fold past 24k chars, stall gate on identical calls, a
per-round tool budget that **pauses resumably** rather than dying,
exactly-once write replay from the run journal (a resumed run never
re-sends an email), the permission gate (attended → dialog; unattended →
pause + system notification, and resuming marks the run attended), ledger
capture, and typed closings (`{status, result, note, items?}` with token
budgets sized to whether a later foreach consumes the items).

`foreach` is harness-owned fan-out: items come from the results map
(`results[itemsFrom].items`, salvage from numbered lists as fallback),
chunks of 5, rows canonicalized back to input items, missed items get ONE
scoped retry, unresolved items become explicit `unknown` rows (no silent
holes), rows persist incrementally so resume skips covered items.

Progression is gated (I3): an items-producer must actually yield items; a
goal that names a count ("40 movies") is cross-checked; post-conditions
run at the step boundary. Failure classes are handled by taxonomy (I4):
transient → same-call retry with backoff (engine-down gets 4×15s — a 7am
run against a cold llama-server is normal); wrong output → ONE informed
retry carrying the failure evidence; structural → replan of the remainder
(≤2, shape-linted, may not drop undone fan-out, never re-issues the failed
step unchanged; the failed step is retagged `replanned`, recovered-not-
terminal); external → pause with a named ask. Two consecutive failures
skip the remainder honestly. A boundary prune after each success lets the
model drop now-redundant steps — prune-only by construction.

### 6.5 Verify and report (I6 — evidence-derived truth)

Mechanical checks run first and short-circuit the model verifier when
every step is settled. Otherwise a read-only-tools adversarial pass judges
each step and the GOAL by its output, with the write ledger's entries
supplied as "what actually happened"; findings become typed verdicts, and
**mechanical results override model judgment**. Failed verdicts get one
retry pass. The report derives from the results map (full rows, not the
200-char notes), a journal-derived activity line ("web search ×12 ·
read url ×3" — never model prose), and a goal verdict that mechanical
evidence can downgrade to a caveat. Settle prunes context/results/journal
and computes recipe eligibility (clean run + replayable tool log →
"Save as recipe"; `run_recipe` replays byte-identical args outside
model-named slots, each call re-passing the permission gate).

### 6.6 State and survival

The task record (goal, plan, statuses, results map, log) lives in the
synced `agent-tasks` key; the run journal is localStorage (volatile
execution state must not ride synced blobs); `_activeRuns` is in-memory
per window (the tasks blob syncs, so a stored "running" status can belong
to another Mac). On launch, `init()` flips any busy task to `paused` — a
task never auto-runs on startup. Every cap pauses resumably with a fresh
allowance; Resume re-enters at `stepIndex` with foreach rows and
journaled writes intact. `BackgroundWork` counts `_activeRuns` so Cmd+R
warns. Results post two ways: the task card (ephemeral UI) and an
assistant message appended to the originating conversation. A
routine-started run additionally keeps its compiled report on the task
record (`t.report`), read from the routine detail's Run history — never
the feed (§7.6).

## 7. Routines — everything the app does on its own

Authoritative doc: `docs/ROUTINE_TRIGGERS.md` (laws T1–T7, open defects
D1–D6, plan R1–R6; same change rule as the task engine — the plan gained
engine extraction, a run queue, and per-thing run scope on 2026-08-03
after a live confirmation of D1/D6). One concept since C10 (2026-08-03):
a **Routine** = a prompt note with a trigger; it absorbed both scheduled
prompts and Automations.

### 7.1 Data model

A routine is a note (`template:'prompt'`) in the synced `notes` blob;
run config nests at `note.prompt`, normalized by `NotePrompts.config`:

- `offline: true` = armed (`isRoutine`);
- `trigger`: `{type:'time'|'email'|'file'}`. **Time is derived** from the
  flat `interval` (`hourly|6h|daily|weekdays|weekly`) + `time` fields, so
  every pre-C10 routine reads correctly with zero migration; email
  triggers carry `from`/`subject`/`contains` (all case-insensitive
  substrings, AND-ed; an email rule with nothing to match falls back to
  the schedule rather than firing on everything); file triggers carry
  `folder` + optional `pattern`;
- `runMode`: `'digest'` (default — one read-only headless turn) or
  `'task'` (full unattended TaskService run that may write);
- `homeMachineId`: the record syncs everywhere, only its home Mac ticks
  it. `_runsHere` **fails open** (unpinned or unreadable id → run):
  a routine that never runs is a worse failure than a duplicate post.
  The pin is dedupe; safety is the arming consent + per-step permissions
  (law T7);
- `web` / `useContext` (digest only): web-search tool loop / full
  headless assistant context.

Scheduler state lives apart in the synced `promptFeed` blob: `runs`
(`{noteId: lastRunISO}`) merges **newest-stamp-per-id** in main
(`RECORD_MERGED_KEYS`) because whole-key LWW made prompts re-fire;
`errors` holds trigger-level failures (an unreadable watch folder).

### 7.2 Setup paths

1. **Assistant tool `create_routine`** (group `prompts`; the trigger
   vocabulary in `_domainsForMessage` and `_impliedGroups` is what makes
   it reachable). The handler validates the trigger up front (email needs
   at least one matcher; file needs a folder — a user asking "when an
   invoice arrives" must not silently get "every day"), gates
   `runMode:'task'` on the taskmode flag, dedupes by title, stamps
   `homeMachineId`, and nudges the scheduler. Exactly ONE handler per
   tool (a leftover duplicate key once shadowed the real one and every
   schema-correct call returned "goal required").
   **Arming always asks**: `create_routine` is in `ASK_TOOLS`, and the
   consent dialog names the trigger sentence and states plainly what the
   run may do — task mode: "It can make changes — each step that needs
   permission pauses and notifies you"; digest: "It only writes you an
   answer; it cannot change anything." Never decided by a model verdict.
2. **Routines page** (`js/apps/prompts/prompts-app.js`): list/detail/form;
   the form refuses an empty trigger rule rather than falling back;
   creating stamps this Mac as home, editing leaves the home alone.
3. **Programmatic recipes** — `StarterPrompts.seed()` (per-id diffed;
   newly seeded non-immediate starters are pre-stamped so nothing fires
   on upgrade boot) and `ReviewRoutines.start` (the "Strategy Review:
   <name>" / "Goal Review: <title>" convention, linked by title with
   `syncRename` carrying renames). A user's click on a page is already
   consent — no dialog.

### 7.3 The scheduler

`PromptFeed` is the ONE background runner. No daemon: the app not running
means routines don't run (stated property); the recovery is a catch-up
pass 8s after launch, then a 5-minute `tick()` interval, plus a 1.5s
debounced nudge whenever a routine is created or edited. `tick()` skips
when busy or when no model is configured (leaving triggers unstamped so
nothing is lost), walks armed routines that run on this Mac, dispatches
`_dueFor` per trigger type, and `break`s after starting one task-mode run
(the single task slot).

Time due-ness (`_isDue`): never-run fires immediately; anchored
daily/weekdays/weekly compute the most recent HH:MM occurrence (weekdays
walks the anchor back over weekends; weekly adds a 6-day guard) and fire
when the last run predates it; unanchored intervals compare elapsed time.
`_retroBlocked` keeps a task-mode routine's FIRST run from retroactively
firing on an anchor that predates its creation ("file invoices every
morning at 7", armed at 9am, must not file this morning's) — a digest
firing immediately on creation is long-standing wanted behavior.

### 7.4 How it knows an email came

There is no push, no webhook, no server. "An email arrived" is **a
difference the app computes** between the local mailbox and its own
record of what it has acted on. Two loops:

**Loop A — mail into local storage.** `EmailApp` polls Gmail on a
self-rescheduling timer (60s active / 3min idle / 10min background;
reset on power resume): `deltaSync()` → Gmail history API
(`startHistoryId`, `messageAdded`) → full-message fetch → `_persistEmails`
→ the SQLite `emails` table (bodies in `email_bodies`) and the in-memory
`EmailApp.emails`. (Caveat D5: this sync is bootstrapped by the home
Email widget's `kickLoad()` — a session that never shows it fetches no
mail; flagged for the same fix `resumeAnalysisBacklog` got.)

**Loop B — the trigger.** On each scheduler tick, `_dueForEmail`:

1. `_mailbox()` — awaits `EmailApp.loadData()` if needed (in-flight
   deduped) and returns `EmailApp.emails`. This read is the D0 lesson:
   the previous code read `StorageManager.get('email').emails`, a field
   that stopped existing when mail moved to SQLite, so it searched `[]`
   forever and **no email-triggered routine ever fired** — invisible for
   months because the evals seeded the same ghost field. A fixture must
   be written where production reads.
2. `sinceMs = max(last run stamp, routine.createdAt)` — the `createdAt`
   floor is the anti-replay defense (arming never replays the mailbox).
3. Candidates: messages with `internalDate > sinceMs` AND
   `_isIncoming` (not SENT/DRAFT/TRASH/SPAM — a rule matching "invoice"
   must not fire on the user's own sent mail), newest first, capped at 60
   (only bites after a long sleep).
4. Match `from`/`subject` in memory; `contains` checks subject + snippet,
   then fetches the body from `email_bodies` per candidate (a handful of
   lookups, not a mailbox scan) — `contains` exists because a bill's
   subject often just says "Your monthly statement".
5. First (newest) match returns a `{suffix}` naming the email; the run
   stamps `runs[id]` forward.

Worst-case latency: Gmail poll (≤10 min) + scheduler poll (≤5 min).
Known open defects (tracked in ROUTINE_TRIGGERS.md, laws T1–T5): D1 —
only the newest match fires and the stamp jumps past the others (three
invoices in one window → one run); D2 — backfilled/late mail whose
`internalDate` predates the marker can never fire; D3 — the delta
`deltaSync` already computed is rediscovered by scanning. The planned fix
(R1–R3) is a per-routine identity ledger of processed message ids plus an
event hook from `deltaSync`, with the poll kept as reconciliation.

### 7.5 File trigger

`_dueForFile` lists the folder through the scoped `agent-fs-list` IPC
(an ungranted folder surfaces as a stored trigger error — a timer must
never raise a permission prompt) and fires on any non-directory entry
with `mtime > sinceMs`. Same identity-vs-timestamp caveats as email
(`mtime` is copier-controlled; law T4).

### 7.6 Execution and the feed

- **Digest**: stamp first (a failing prompt waits a full interval instead
  of spinning), append the trigger suffix to a clone of the prompt body,
  then one of: `AgentService.runHeadless` (ephemeral conversation, full
  context, **read-only tools**, explicit "BACKGROUND RUN — no one can
  reply" framing), a bounded 4-iteration web-search loop, or a plain
  one-shot call. One retry on an empty response.
- **Task**: `_runAsTask` → `TaskService.start(goal + trigger suffix,
  null, {unattended: true, routineId, untrustedInput: email|file})`.
  "Already running" returns deferred and deliberately **unstamped** so
  the next tick retries rather than silently losing the run. Unattended
  semantics: plan approval was the arming; asks pause + notify; the
  untrusted block withholds irreversible tools for the whole run (§5.5).
- **Output goes to the feed; the execution log does not** (2026-08-03,
  reversing this section's original "both post to the feed"). A digest's
  output IS content, so it posts. An action run's report — the step
  transcript with its `Changed:` line from the write ledger — is a LOG,
  and it lives on the task record (`t.report`, written by
  `TaskService._report`, capped 4KB), read back as the routine detail
  page's **Run history**; a failed run also sets the routine's "Last
  problem" line (`RoutineEngine.noteError`), and the system notification
  stays (a doorbell, not a record). `PromptFeed.postTaskResult` is gone;
  journey `c10-task-run-log-off-feed` pins the new contract. Feed posts
  remain `template:'feed'` notes grouped into per-routine series, pruned
  to 10 editions with tombstones (pinned exempt), summarized **without a
  model** (`_summaryFor` — the digest must work with the engine off).

### 7.7 The email insight engine is not a routine

Ambient email analysis (Email AI / the analysis panel) shares the mailbox
and nothing else: it is driven inline by `deltaSync` (`isNew` +
`shouldConsiderForAnalysis` → the persisted analysis queue, drained in
batches; `resumeAnalysisBacklog` runs from `AppManager.init` so a Cmd+R
from any view resumes it), writes to the `email_analyses` table, and
surfaces in the Email widget / Email AI app — never the feed, never
through `PromptFeed`.

## 8. Cross-cutting

- **Sync**: conversations, tasks, recipes, memories, and routine notes
  sync; model list, grants, the write ledger, the run journal, MCP
  config, and the Terminal conversation are machine-local. `promptFeed`
  and `notes` are record-merged; `runs` merges newest-stamp-per-id.
- **Reload safety**: `BackgroundWork` sources (agent streams
  `getActiveStreamingConvIds`, task runs `_activeRuns`, email analysis,
  Maker builds, feed generation) make Cmd+R prompt before killing live
  model work; email analysis is `resumable` and never prompts.
- **Transparency**: every model call goes through `LLMLogger` with a
  `logTag` (`agent`, `task-plan`/`-step`/`-verify`/`-verdicts`,
  `prompt-feed`, `task-image-extract`, …); searches through
  `SearchLogger`; permission outcomes into the capped decision log; all
  inspectable in Settings.
- **Feature flags** (`js/core/features.js`): `agentfs`, `mcp`, `taskmode`
  are always-on since 2026-07-13; `maker` is off by default since
  2026-08-03 — each flag cuts its tools from the registry at load time
  (a flip reloads via `AppManager.requestReload`).

## 9. Doc map

| Area | Authoritative source |
|---|---|
| Vision, phases C0–C10, decision history | `docs/COWORK_AGENT.md` |
| Task engine invariants + change rule | `docs/TASK_ENGINE.md` |
| Trigger laws T1–T7, defects, R1–R4 plan | `docs/ROUTINE_TRIGGERS.md` |
| Positioning / privacy copy rules | `docs/POSITIONING.md` |
| Platform arc (user apps, SDK) | `docs/PLATFORM.md` |
| Evals | `tests/agent-evals/` (`npm run agent-evals`) |
