# Routine triggers — how "when something happens" works, and what is wrong with it

Status: living design doc, created 2026-08-03 after a live report ("I made a
routine for invoice emails; an invoice came in; nothing happened") that turned
out to be **three defects on one path, one of which meant the feature had never
worked a single time since it shipped**. This doc exists so the trigger engine
stops being the part of Routines nobody has a model of. **The change rule is at
the bottom — no patch without a law.**

Companion docs: `docs/COWORK_AGENT.md` §10 (the C10 merge that folded
Automations into Routines, and its findings log), `docs/TASK_ENGINE.md` (what
`runMode:'task'` hands off to). Code: **`js/agent/routine-engine.js`** (the
scheduler, the matchers and the run queue — extracted from PromptFeed by R5 on
2026-08-03), `js/apps/prompts/prompt-feed.js` (the feed surface and run
execution), `js/apps/notes/note-prompts.js` (the stored trigger shape),
`js/apps/email/email-app.js` (the mailbox the email trigger reads).

## The contract, in one paragraph

A routine declares a TRIGGER; the app decides, without being told by anything
outside itself, that the trigger has FIRED, and runs the routine once for what
fired it. There is no push, no webhook, no daemon and no server. "An email
arrived" is not an event the app receives — it is **a difference the app
computes** between the local mailbox now and its own record of what it has
already acted on. Everything below follows from that one sentence: the quality
of a trigger is entirely the quality of that difference.

## How it works today

Two independent polling loops in the renderer, joined by a marker.

**Loop A — Gmail into local SQLite.** `EmailApp.scheduleNextPoll`
(`email-app.js:1833`) is a self-rescheduling `setTimeout` on an activity-tiered
interval: 1 min active, 3 min idle, 10 min background. Each tick runs
`deltaSync()` (`:1891`) — Gmail History API from the stored per-account
`historyId`, new ids, `fetchMessagesByIds`, `_mergeFetchedEmail` (`:1172`,
which returns `isNew`), `_persistEmails` into the `emails` table.

**Loop B — the routine scheduler.** `RoutineEngine.startScheduler` is a
`setInterval` at `POLL_MS` = 5 min, plus a catch-up pass 8 s after launch, plus
a debounced nudge when a routine note is saved. Each `tick()` asks `_dueFor` per
armed routine, which dispatches to `_dueForEmail` / `_dueForFile` / `_isDue`,
then ENQUEUES what fired and drains the queue (R5). Started from
`AppManager.init`, not from any view.

**The marker (pre-R1; kept for history).** `_sinceMs(prompt)` =
`max(last run, armed at)`; a candidate was anything newer, and firing moved
the marker past everything. Since R1 the marker is an IDENTITY set
(`state.seen`, below) and `_sinceMs` only fixes a new ledger's initial floor.

Neither loop knows the other exists. That decoupling is a real property — Loop
B keeps working when Gmail is down — and it is also how the dead-field bug hid
for months: Loop B failed silently and independently.

## The laws

- **T1 — A trigger is a difference, and the difference must be computed
  against IDENTITY, not against time.** What has been acted on is a set of
  things, so the record of it must be a set of things. A timestamp is a lossy
  encoding of that set: it cannot represent "these three, but not that one",
  and every operation on it is destructive. (Violated until R1, 2026-08-03
  — see D1, D2.)

- **T2 — Fire once per THING, not once per tick.** The user's sentence is
  "every time I get an invoice, make a task". If two invoices arrive between
  two ticks, two tasks is the only correct answer. A tick is an implementation
  detail of the harness and must never be observable in the output.
  (Violated until R1 — D1.)

- **T3 — Arming must not replay history, and a gap must not lose the
  present.** These are the two failure directions and they are in tension: the
  cheap defence against one causes the other. A design that only prevents
  replay (today's `createdAt` floor) will lose late arrivals; a design that
  only prevents loss will spam on first launch after a week. Both must be
  stated separately and defended separately. (Half-violated until R1 — D2.
  R1 defends both: the fixed floor + folder seeding against replay, the
  identity set against loss.)

- **T4 — Never infer arrival from a timestamp the source controls.**
  `internalDate` is Gmail's clock and answers "when was this sent to me",
  which is NOT "when did this machine first learn of it". A file's `mtime` is
  worse still: it is attacker- and copier-controlled, and `cp -p` produces a
  brand-new file with a 2019 timestamp. Arrival is a fact about US, so only we
  can record it. (Violated until R1 — D2, and the same hole existed in
  `_dueForFile`; file identity is now name+size, and a seen-stamp's ms is
  Date.now() — when this Mac first acted, the only clock that is ours.)

- **T5 — The delta is already known; do not recompute it.** `deltaSync`
  identifies precisely which messages are new (`isNew`, `email-app.js:1172`)
  and throws that knowledge away. Loop B then rediscovers it 5 minutes later
  by scanning the entire mailbox. Any work the harness has already done and
  discarded is both the latency and the cost. (Violated until 2026-08-03 —
  D3. R1 removed the cost half: the tick became a set-difference over the
  newest window. R3 removed the latency half: the sync paths hand the delta
  over the moment it persists.)

- **T6 — A trigger that has not fired must be distinguishable from a trigger
  that cannot fire.** "Nothing matched" and "this has been broken since the
  day you armed it" look identical today. This is not a UI nicety: it is the
  only reason the D0 outage below survived from C8.5 through C10.
  (Violated until R4, 2026-08-03 — D4.)

- **T7 — Duplicate beats silence, but only with T1 in place.** `_runsHere`
  fails open on purpose (`routine-engine.js`): an unpinned routine or an
  unreadable machine id runs anyway, because a routine that never runs is a
  total outage while a duplicate is an annoyance. That trade is only
  affordable while duplicates are cheap. Once routines can write, the
  identity ledger of T1 is what keeps it affordable — it makes a second Mac's
  duplicate run a no-op rather than a second task. (In place since R1: the
  seen union across Macs, plus TASK_ENGINE I8's record idempotency behind it.)

## The defects

| # | Defect | Law | Status |
|---|---|---|---|
| D0 | `_dueForEmail` read `StorageManager.get('email').emails`, a field deleted when messages moved to SQLite. Searched `[]` forever; **no email routine ever fired**. Both evals seeded the same ghost field and passed green. | — | **Fixed 2026-08-03** |
| D1 | Batch swallowing: fires on the newest match only, then stamps the marker past all the others. | T1, T2 | **Fixed 2026-08-03** (R1) |
| D2 | Backfilled and late mail is invisible; `fullSyncAccount` re-pulls messages whose `internalDate` predates the marker, and they can never fire. Same hole in `_dueForFile` via `mtime`. | T1, T3, T4 | **Fixed 2026-08-03** (R1) |
| D3 | O(mailbox) rescan every 5 min per routine, to rediscover a delta `deltaSync` already computed. Adds up to 5 min of latency for free. | T5 | **Fixed 2026-08-03** (R1 cost, R3 latency) |
| D4 | No "last checked / last matched"; `data.errors` only records trigger-level failures like an unreadable folder. A matcher returning nothing is indistinguishable from a matcher that is broken. | T6 | **Fixed 2026-08-03** (R4) |
| D5 | The email sync that feeds the trigger is bootstrapped by the **home widget** (`email-widget.js`). A routine's liveness depends on a surface it has nothing to do with, and fails silently if that changes. | T6 | **Fixed 2026-08-03** (R5) |
| D6 | **Every fire re-processes the whole mailbox.** Because firing is not per-thing, a routine's prompt compensates by searching ("search email for invoice-related messages") — so each new match triggers a run that re-does every PRIOR match's work and re-creates its records. Confirmed live 2026-08-03 (below). | T1, T2 | **Fixed 2026-08-03** (R1 firing + R6 scope + I8 records) |

### D1 in detail — why this is the one that matters

Three invoices land in one 5-minute window. `_dueForEmail` sorts newest-first
and returns the first match. `_runPrompt` stamps `runs[id] = now`. The next
tick's `_sinceMs` is past all three. **Invoices #2 and #3 never fire, ever,
with no error anywhere.** For `runMode:'task'` this breaks the literal promise
the arming dialog made. Even in digest mode the routine only learns about one
message, because the context suffix names a single subject.

`tick()` compounds it: it `break`s after starting one task-mode routine (the
single task slot), and nothing queues the rest.

### D1/D6 live confirmation — the invoice-routine runs (2026-08-03)

Five matching test emails (13:18, 16:26, 16:29, 16:36, 16:52) against an
armed `runMode:'task'` invoice routine produced **three** unattended runs
(16:33, 16:48, 16:58 — reconstructed from the write ledger and task
records, not report prose):

- **D1, exactly as stated**: the 16:26 + 16:29 pair got ONE run — the
  newest fired, the marker jumped past the other.
- **D6, the flip side**: each run's model-authored prompt re-searched the
  whole mailbox (the prompt compensates for firing not being per-thing),
  so every run re-read every prior invoice's PDFs and re-created its
  schedule tasks — 28 `create_schedule_item` calls across the three runs
  for what should be ≤3 distinct tasks, with the third run creating tasks
  literally titled "…(dup 2)" and "…(dup 3)". Cross-run record
  idempotency does not exist at any layer (see TASK_ENGINE.md §v3, law
  I8 — the two docs meet at this point; I8 shipped 2026-08-03, so a
  duplicate fire now converges on the existing record instead of forking
  a second one, which bounds this defect's cost while R1 is outstanding).
- The third run was then stranded `paused` by an app restart (silent for
  an unattended run), and Ram deleted every created record by hand — the
  routine's headline promise ("a task for each invoice") ended the day as
  a manual cleanup chore, while two of three runs reported work done.

One more overlap the run exposed: the ambient insight engine's
`syncActionItemsToSchedule` created its own task for the same invoice
minutes before the routine's run did. Two subsystems independently
watching the same mail and writing the same records is a product
question that per-thing firing does not answer by itself — resolved
2026-08-03: the ROUTINE owns it (see the decision log).

### D2 in detail — the tension in T3

Today's defence against replay is the `createdAt` floor inside `_sinceMs`.
It works, and it is why arming a rule does not fire it once per matching
message already in the mailbox. But it defends by *sending time*, so it also
discards anything that arrives late — which is not an edge case:
`deltaSync` falls back to `fullSyncAccount` whenever the `historyId` expires,
and that path re-pulls a window of mail wholesale.

The `emails` table has no first-seen column (`main.js:497` — `messageId`,
`account`, `internalDate`, `isRead`, `isStarred`, `labels`, `data`). Arrival is
not currently recorded anywhere, which is exactly what T4 says is wrong.

## The plan

### R1 — Identity ledger (fixes D1, D2; laws T1, T2, T3, T4) — **BUILT 2026-08-03**

Replace the timestamp-as-processed-marker with a **per-routine processed-id
set**, stored beside `runs` on the PromptFeed blob.

```
data.seen = {
  [routineId]: { ids: [messageId | fileKey, …], floorMs: <armed-at ms> }
}
```

- **Bounded** — keep the newest ~500 ids, or ids newer than 30 days, whichever
  is smaller. Unbounded growth in a synced blob is its own bug.
- **Seeded on arm** — at creation, fill `ids` with what currently matches (or
  simply what is currently in the mailbox within the floor window). This is
  what defends the replay direction of T3 *without* relying on send time, and
  it is the half that must not be forgotten: without seeding, R1 turns "don't
  replay history" into "replay all of it on first launch".
- **`floorMs` stays** as a hard backstop so a ledger that is ever lost or
  truncated degrades to today's behaviour rather than to a hundred tasks.
- **Merges by union.** `app_promptFeed` is already in `RECORD_MERGED_KEYS`
  with a newest-stamp-per-id rule for `runs`; a set of ids unions with no
  tie-break needed, because nothing ever un-processes a message. This is also
  what makes T7 affordable — a second Mac's fail-open duplicate becomes a
  no-op.

`_sinceMs` survives, demoted from "what counts as new" to "how far back we are
willing to look at all".

`tick()` fires for **every** unprocessed match, queueing task-mode runs rather
than `break`ing after the first.

For the file trigger, the same ledger keyed on `folder + name + size` rather
than `mtime` — T4 applies with more force there, since `mtime` is trivially
arbitrary.

**As built** (`RoutineEngine`, `state.seen[routineId] = {ids, floorMs, sig}`):
`ids` maps identity keys (`mail:<id>`, `file:<path>|<size>`) to a Date.now()
stamp — the arrival clock, ours (R2b resolved in passing). Load-bearing
details, each pinned by a journey:

- **The floor initializes from the OLD `_sinceMs` and then never moves.**
  For a pre-R1 routine that is `max(lastRun, armed)` — the migration
  boundary preserves old semantics exactly (mail the old engine passed over
  stays passed over) — and immobility thereafter is the D2 fix: a message
  sent after arming fires whenever it lands, however late.
- **The email scan window slices newest-N BEFORE dropping seen ids.**
  Filtering seen first would crawl the window 60 messages deeper into the
  backlog each tick, stamp the whole mailbox, evict the NEWEST messages'
  stamps first, and re-fire them. Sliced first, the scan set is pinned to
  the mailbox's newest edge and eviction only ever touches stamps hundreds
  of messages below it.
- **Seen means EVALUATED, not matched**: non-matching scanned mail is
  stamped too, so a `contains` body fetch happens at most once per message
  ever, and editing a rule does not replay mail the old rule considered.
- **Matched identities are stamped by the DRAIN, when the item leaves the
  queue** — not at match time. A queue lost before the run means the thing
  fires again rather than being silently swallowed (T7's direction).
- **File seeding trusts mtime for exactly one decision** — whether a file
  predates the arm, in the seconds between arming and the first evaluation
  — where being wrong costs one fire, not a folder replay. After that,
  identity only: the 2019-`cp -p` copy fires. `sig` (folder|pattern)
  re-seeds on change, so repointing a watch never fires on everything in
  the new folder.
- **The cap (newest 500 by stamp) is enforced inside main.js's merge as
  well as at stamp time**, because every renderer write of the key passes
  through the union — a cap applied only in the renderer would be
  resurrected by its own save. Known trade: a folder holding >500 matching
  files can re-fire evicted identities; the email side cannot (the scan
  window pins to the newest edge).
- One consequence for tests: `runs` and `seen` cannot be emptied through
  any renderer write (stamps never rewind, identities never un-process), so
  eval resets clear the IN-MEMORY state only and journeys isolate by fresh
  routine ids.

### R2 — Record arrival (completes D2; law T4)

The honest fix for "when did this machine first learn of it" is to write it
down. `_mergeFetchedEmail` already returns `isNew` — the signal exists and is
discarded. Either:

- **(a)** add a `firstSeen INTEGER` column to the `emails` table, set on
  insert only, indexed; or
- **(b)** carry it only in the ledger — a message enters `seen.ids` the moment
  it is first persisted, whether or not a routine matched it.

**(b) is preferred**: it needs no migration, no schema change and no second
source of truth, and the ledger is the thing that actually consumes it. (a) is
the right call only if something else later needs first-seen — worth revisiting
if the insight sweep ever wants it.

### R3 — Event-driven delivery (fixes D3, D5; law T5) — **BUILT 2026-08-03**

Have the new-message path in `deltaSync` (`email-app.js:1932`–`1944`) call
`PromptFeed.onNewMail(newEmails)` directly. The precedent is
`EmailThreads.invalidate()`, which hangs off `_persistEmails` for exactly this
reason: that is the single funnel every mutation passes through.

- Latency drops from *Gmail poll (1–10 min) + scheduler poll (≤5 min)* to just
  the Gmail poll.
- Cost drops from O(mailbox) × routines every 5 min to O(delta).
- **The 5-minute poll stays.** It becomes reconciliation, not the mechanism —
  it is what runs at launch and what catches anything the event path dropped.
  Deleting it would trade one silent-failure mode for another.

Same change fixes D5 in passing: if any armed routine carries an email
trigger, `PromptFeed` should ensure the mail sync is running rather than
inheriting it from whether the user visited home. The precedent is
`EmailApp.resumeAnalysisBacklog()` being moved into `AppManager.init` when the
same class of bug was found — work whose liveness depends on the current view
is work that silently stops. (D5's ownership half landed with R5.)

**As built**: both new-mail paths — `deltaSync`'s History batch AND the
`fullSyncAccount` fallback, which is exactly the re-pull that lands the late
mail R1 made fireable — collect their `isNew` messages and call
`EmailApp._notifyRoutinesOfNewMail` → `RoutineEngine.onNewMail` after
persisting. `onNewMail` is a gated, debounced nudge of the SAME `tick()` the
scheduler runs — one evaluation path, nothing to drift; R1's stamps already
made that tick O(newest-window-unseen), so the event hook's whole job is
latency. `loadMoreEmails` is deliberately not hooked (it reaches strictly
below the oldest mail held — archaeology, below any floor), and the 5-minute
poll stays as reconciliation. The IPC pair grew `_fetchHistory` /
`_fetchMessagesByIds` seams (the `_fetchEmails` precedent) so the journey
drives the REAL `deltaSync`. Journey `r3-new-mail-pushes-to-engine`.

### R5 — Extract the engine, and give it a queue (fixes D5 structurally; serves T2, T6) — **BUILT 2026-08-03**

Two structural moves that R1–R3 need a home for:

- **`RoutineEngine` as its own module** (a peer of `TaskService`, not a
  side-job of the feed surface): owns trigger evaluation, the run queue,
  per-routine state and observability; bootstrapped from
  `AppManager.init`, full stop. `PromptFeed` returns to being the feed
  surface; `EmailApp` stays the mail source but **pushes** into the
  engine (R3's `onNewMail` lands here). This is the
  `resumeAnalysisBacklog` fix applied structurally: background work must
  never depend on a view. It also ensures the mail sync runs whenever any
  armed routine carries an email trigger — D5's root, closed by
  ownership rather than by another call site.
- **A persisted run queue** replacing the single-start-and-`break` slot:
  fired triggers enqueue `(routineId, identity)` items; the engine drains
  them — serially through the one TaskService slot for `runMode:'task'`,
  digests interleaving freely. Restart-safe (machine-local), ordered,
  and visible ("2 runs waiting" on the Routines page). T2's
  fire-once-per-thing is only meaningful if the thing can wait its turn
  instead of being dropped or endlessly retried.

**As built** (`js/agent/routine-engine.js`): `RoutineEngine` owns trigger
evaluation, per-routine state, the queue and observability;
`AppManager.init` starts it BEFORE any UI (D5), and it starts the mail sync
itself when an armed routine carries an email trigger. `PromptFeed` kept the
feed and the run execution — `PromptFeed.runRoutine(prompt, context)` is the
seam the engine calls, so the engine decides WHEN and WHAT fired while the
feed decides HOW it runs and where the result lands. Matching semantics are
**unchanged** in this phase, on purpose; `identity` is carried through the
queue now so R1's ledger has somewhere to land.

State split, and it is load-bearing: `runs` and `errors` stay in the SYNCED
`promptFeed` blob (the newest-stamp-per-id merge in `RECORD_MERGED_KEYS` is
what stopped a daily routine firing three times a day). The queue and the
R4 stamps are MACHINE-LOCAL (`routine-state` in localStorage) — they are
volatile and rewritten every five minutes, and re-stamping a synced key on a
timer is the exact defect CLAUDE.md records against the portfolio price
cache. The queue dedupes on `(routineId, identity)` because a queued item has
not stamped `runs` yet and would otherwise re-enqueue on every tick while it
waited for the task slot. Journey `r5-queue-drains-through-one-task-slot`.

**Transient digest failures ride the queue (2026-08-04; serves T2, T6/T7's
direction).** A digest whose model never really answered — `ECONNREFUSED` /
`ECONNRESET` / `socket hang up` against a rebooting server, a timed-out
stream, an empty completion — used to consume its fire by posting an error
card to the feed (live confirmation: five such cards in one night, all
transport errors against the user's remote llama-server). The card is the
run's result surface, and "the server was asleep" is not a result. Now
`PromptFeed._runPrompt` classifies the failure (`_isTransient`) and, for
ENGINE-driven runs only, returns `{retry:true}` without posting; the drain
keeps the item queued and bumps `item.attempts`, so the next 5-minute tick
retries it — tick-spaced on purpose, because the observed failures outlive
any immediate retry. `PromptFeed.RETRY_MAX` (2) bounds it; the card posts
when retries are spent. While waiting, the routine's "Last problem" line
says "retrying on the next check". The identity is deliberately NOT stamped
while retrying (the fire is consumed when the run settles — T7), and the
queue's `(routineId, identity)` dedupe stops the still-queued item from
re-enqueueing. Manual "Run now" is exempt: a present user sees the failure
immediately. A final answer ("Local model unavailable", a tool-loop
overrun) never retries — re-buying the same failure is not resilience.
Journey `c10-transient-digest-retries-then-posts`.

### R6 — The fired THING is the run's scope (fixes D6; laws T1, T2) — **BUILT 2026-08-03**

Once R1 fires per identity, the run must be ABOUT that identity:

- The run's context names exactly the triggering message/file (id, not
  just a subject line), and the goal template scopes the work to it —
  "capture THIS invoice", not "search for invoices".
- `create_routine`'s domain guidance changes in the same commit: stop
  authoring prompts that re-search the mailbox (today that phrasing is
  the model's rational compensation for D1/D6; after R1 it is pure
  duplication).
- Cross-run record idempotency backstops the occasional overlap:
  TASK_ENGINE.md I8's idempotency keys (`sourceEmailId + title`
  precedent) apply to routine-created records across runs, so even a
  duplicate fire converges to one task. (Shipped earlier the same day.)

**As built**: the fired context now names the thing by ID — `email id: <id>`
/ the file's full path — and carries the scope directive ("this run is about
THIS one email only… do not search the mailbox: each match starts its own
run, and earlier matches were already handled"). One suffix serves both run
modes: digests fold it into the prompt, task runs into the goal.
`create_routine`'s tool description and the `prompts` domain guidance changed
in the same commit — the model now writes triggered prompts about "the
email/file that triggered this run", never as a mailbox search. Journey
`r6-run-scoped-to-the-thing`.

### R4 — Observability (fixes D4; law T6) — **BUILT 2026-08-03**

On the Routines page, per routine:

- **last checked** and **last matched** timestamps
- a **Test trigger** button that runs the matcher against the current mailbox
  and reports what it *would* fire on, stamping nothing

This is the cheapest item here and it is the one that would have caught D0 in
under a minute. It is also the honest answer to the user sentence that opened
this doc.

**As built**: `RoutineEngine.statusFor(id)` returns
`{lastCheckedAt, lastMatchedAt, lastRun, lastError, queued}` and the routine
detail page renders all five. `tick()` stamps `checkedAt` whether or not
anything matched — that IS the feature, because an absent checked stamp
means "the engine has never evaluated this routine", which is a different
problem from one that evaluates and never matches. `testTrigger(prompt)`
runs the matcher with `{probe: true}`, which suppresses every side effect
(no run, no marker moved, no error stamped) and additionally reports how
many candidates matched and how many were available to check — so an empty
answer distinguishes "nothing matched" from "there was nothing to match
against". Journey `r4-test-trigger-reports-and-stamps-nothing`.

### Sequencing (2026-08-03)

**R5 + R4 first** (extraction + observability) — **DONE 2026-08-03**: no
change to matching semantics, kills D5, and makes every later step
debuggable — R4 alone would have caught D0 in a minute. **R1 second** (the correctness core) — **DONE 2026-08-03**, shipped with the
batch/exactly-once/backfill/seeding/bound/file-identity evals below. **R3 + the queue drain
third** (latency and throughput, riding on R1's semantics) — **DONE
2026-08-03** (the queue drain landed with R5). **R6 last** (it only makes
sense once firing is per-thing) — **DONE 2026-08-03**. The plan is fully
built; what remains open here is nothing structural, only the product
question below (who owns invoice→task) and live-run validation. TASK_ENGINE I8/I9 (see
§v3 there) are parallel prerequisites — per-thing firing into an engine
that duplicates writes just fires the failures more precisely.

## What we are deliberately not doing

- **Gmail push (`users.watch` → Pub/Sub).** Needs a public HTTPS endpoint and
  routes mailbox change notifications through a server. Wrong shape for a
  local-first app and against `docs/POSITIONING.md`. Polling is the correct
  answer here, and with R3 the poll interval stops being the bottleneck.
- **A background daemon.** The app not running means routines do not run;
  that is a stated property, not a bug to engineer around. The launch
  catch-up pass is the recovery.
- **Model-judged trigger membership.** "Does this email look like an invoice?"
  is not a matcher. Same law as arithmetic thread membership
  (`EmailThreads`) and computed strategy adherence (`PortfolioStrategy.
  evaluate`): a queue you cannot predict is one you stop trusting. `contains`
  searching the message body is the deterministic version of that wish, and it
  is where this should stay.

## Evals

The lesson from D0 is not "we needed a test" — there **were** tests. It is
that both of them seeded `blob.emails`, the field production had stopped
reading, and so passed green over a feature that had never worked once.

> **A fixture must be written where production reads, not where it used to.**
> A passing journey over a dead read is worse than no journey, because it
> retires the suspicion.

Existing coverage (`tests/agent-evals/journeys/c10-routines.js`):
`c10-email-trigger` (fires on new, not on pre-arming, not on SENT),
`c10-email-trigger-body` (`contains` matches the body), `c10-file-trigger`,
`c10-busy-unstamped`, `c10-home-machine-pin`.

Needed, and currently absent:

- [x] **batch** — three matching messages in one window produce three runs
      (D1). The headline test. `r1-batch-three-invoices-three-runs`.
- [x] **exactly-once** — the same message across two ticks produces one run,
      and across two Macs produces one action (T1, T7).
      `r1-exactly-once-across-ticks-and-macs`.
- [x] **backfill** — a message inserted with an `internalDate` older than the
      last run still fires; one older than the arm floor does not (D2, T3).
      `r1-backfill-late-mail-fires`.
- [x] **seeding** — arming a routine against existing matching things fires
      zero times (T3, the other direction): the folder seed in
      `r1-file-identity-not-mtime`, the floor in `c10-email-trigger`.
- [x] **ledger bound** — the id set stays capped and merges by union, with
      the cap enforced inside the merge itself. `r1-ledger-bound-and-floor`.
- [x] **file trigger identity** — a file copied in with a 2019 `mtime` still
      fires (T4) — a real file with a genuinely forged mtime through the real
      IPC. `r1-file-identity-not-mtime`.
- [x] **queue** — a trigger firing while a task-mode run is active is
      queued and runs next, in arrival order; nothing is dropped and
      nothing re-fires forever (T2, R5). `r5-queue-drains-through-one-task-slot`.
- [x] **per-thing scope** — a second matching email produces a run about
      THAT email only (`r6-run-scoped-to-the-thing`); records for the first
      email are not re-created (D6, R6, I8 —
      `i8-three-invoice-batch-no-duplicates`).

## Decision log

- **2026-08-03 — `contains` searches the whole message.** from/subject could
  not express "an email with an invoice in it", which is how an email trigger
  is always asked. A bill whose subject reads "Your monthly statement" matched
  nothing. Same phrasing-vs-reality gap that retired `INSIGHT_LEXICON` as a
  gate on the same day.
- **2026-08-03 — the mailbox is `EmailApp.emails`, never the blob.** D0. Two
  call sites read the deleted field; the other was
  `PermissionManager._isKnownRecipient`, which had been answering "stranger"
  for every address in the user's own mail.
- **2026-08-03 — routine vocabulary must live in BOTH matchers.** Chat's
  `AgentTools._domainsForMessage` and `TaskService._impliedGroups`. "Help me
  set up an automation…" reaches the model as a `start_task` GOAL, so teaching
  only the chat matcher left the same "I don't have a create_routine function"
  answer through a second door.
- **2026-08-03 — the engine left the feed (R5), and `PromptFeed.data` with
  it.** Scheduler state is `RoutineEngine.state` (synced `runs`/`errors`,
  same blob and same merge rule) plus `RoutineEngine.local` (machine-local
  queue and observability stamps). Every caller moved —
  `onPromptsChanged` → `RoutineEngine.onRoutinesChanged`, `PromptFeed.tick`
  → `RoutineEngine.tick`, `PromptFeed._machineId` →
  `RoutineEngine._machineId` — including the c10 journeys, per this doc's
  own eval law: a fixture must be written where production reads. The one
  reader that was missed threw during `AppManager.init` and silently killed
  the whole init chain (machine id null, feed unrendered), which is a
  reminder that a refactor of a startup path needs a launch, not only a
  green unit.
- **2026-08-03 (evening) — D1/D6 confirmed live; R5/R6 added.** The
  invoice-routine runs (three unattended fires, 28 task creates, records
  then lost to the `app_schedule` clobber — full dissection in the D1/D6
  section and TASK_ENGINE.md §v3) turned the plan from prospective to
  evidence-backed. Direction approved by Ram: extract the engine, queue
  the runs, fire per thing, scope the run to the thing.
- **Resolved 2026-08-03 — R1's seeding policy.** Per trigger kind, by what
  each needs: FILES seed with everything currently in the folder (identity
  is the only defense there, so an unseeded arm would replay the folder);
  EMAIL needs no seed because the fixed floor already excludes pre-arming
  mail, and evaluated-but-unmatched messages stamp themselves as the window
  advances. Trigger edits: `sig` re-seeds a file watch; an email rule edit
  deliberately does not replay evaluated mail.
- **2026-08-03 — invoice→task is owned by the ROUTINE (decided by Ram).** A
  routine is something the customer created explicitly, with their own
  instruction for exactly this mail; the insight sweep is ambient help. So
  when an armed **task-mode** email routine matches a message,
  `syncActionItemsToSchedule` defers — the insight itself is untouched (it
  surfaces everywhere, and the manual "Add task" click still works), only
  the automatic task WRITE steps aside. `RoutineEngine.claimsEmail(email)`
  is the arbiter: arithmetic (same law as thread membership), task-mode
  only (a digest cannot write, so it must not silence the sweep), and
  `_runsHere`-blind (a routine armed on another Mac still owns the mail —
  its task syncs over, and this Mac writing too is the exact duplicate the
  decision exists to prevent). Synchronous by contract, so a `contains`
  rule checks the body only when it is already in memory — at sweep time
  the analysis has just read the message, so it normally is; a missed
  body-only match costs one duplicate task, never a lost one. Deleting the
  routine hands ownership back for future analyses (not retroactively).
  Journey `ownership-routine-claims-email-tasks`.
- **2026-08-03 — R3 + R6 land; the plan is fully built.** Push delivery
  rides the two sync paths' `isNew` lists into `RoutineEngine.onNewMail`
  (one debounced nudge of the same tick — no second matcher), and the fired
  context names its thing by id with the don't-search directive, with
  `create_routine`'s authoring guidance changed in the same commit per R6's
  own rule. Every defect D0–D6 is closed. What remains: the product
  question (does the ambient insight sweep or a routine own invoice→task —
  both can write the same records, I8 dedupes within each but they are two
  subsystems), and a live invoice re-run to validate the whole path on a
  real model.
- **Resolved 2026-08-03 — `firstSeen` lives only in the ledger (R2b).** A
  seen-stamp's ms is Date.now() at the moment this Mac first evaluated the
  thing — arrival, recorded by us (T4). No schema change; revisit R2a only
  if a second consumer (the insight sweep) ever wants it.

## The change rule

No patch to a trigger without a law. If a new failure mode is not explained by
T1–T7, the correct response is to add the law first and then fix the code to
it — not to add a guard that happens to make the reported symptom go away.
Every `TRIGGER_LEXICON_VER`-style bump in this codebase's history is what the
alternative looks like.
