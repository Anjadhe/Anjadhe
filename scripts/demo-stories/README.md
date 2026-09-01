# Per-story demo recordings

One short video per personal-assistant story, recorded hands-free against
the seeded demo instance (docs/DEMO.md). Each story is a choreography in
`demo-stories.mjs` over the shared driver `demo-lib.mjs` (CDP screencast,
demo cursor, consent auto-approver that pauses so the dialog is readable
on camera, `askAndWait` that types into the live composer and waits for
the assistant's message to land). `record-demo.mjs` (the overview
walkthrough, one level up) runs on the same driver.

**The videos narrate themselves.** Title slides and lower-third captions
are baked into the frames (no voiceover; music is added in post):

- `d.slide(title, sub, holdMs)` — full-screen chapter card, Minimal Book
  styling; its progress hairline doubles as the frame pump so the hold
  survives the dead-air cap.
- `d.cap(text, holdMs)` — lower-third caption; with `holdMs` the screen
  holds that long with frames flowing (`__demo.holdLive`). `d.cap(null)`
  clears it.
- `d.capOnAsk(text)` — stages a caption that the consent auto-approver
  flips on the moment a dialog appears (and it holds the dialog longer).

The canonical text lives in **docs/DEMOS.md** — a caption change in a
script must land there in the same commit.

## Recipe (per story — re-seed EVERY take; the stories mutate state)

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed-demo-data.js ~/AnjadheDemo --baked --force
ANJADHE_DATA_ROOT=~/AnjadheDemo ANJADHE_APPS_DIR="~/AnjadheDemo/Anjadhe Demo" \
    ./node_modules/.bin/electron . --remote-debugging-port=9333 \
    --disable-backgrounding-occluded-windows --disable-renderer-backgrounding &
node scripts/demo-stories/demo-stories.mjs <email|goal|routine|memory|voice> /tmp/frames
ffmpeg -f concat -safe 0 -i /tmp/frames/concat.txt \
    -vf "scale=1400:-2,format=yuv420p" -r 30 -c:v libx264 -crf 18 \
    -movflags +faststart demo-<story>.mp4
```

The driver preps the instance (dismisses chrome nudges, warms prices)
and waits for background AI to settle before recording. **A model you
configured on the instance is kept** — the driver adds and selects the
Anjadhe Cloud entry only when NO model is selected, or when forced with
`DEMO_MODEL=cloud` (flash) / `DEMO_MODEL=big` (Qwen) on the record
command. `goal-appendix.mjs` is a follow-on take on a live
instance for the bulk-shift consent beat.

## Hard-won constraints (learned over ~20 takes, 2026-08-21)

- **Free tier is 30 requests/min and 2 concurrent, per install key**
  (anjadhe-connect config). A flash-speed agentic task turn (up to 16
  requests) can rate-limit ITSELF; ambient triage or the thread judge
  holding one of the 2 concurrent slots kills task planning. The routine
  story therefore quiets ambient AI (in-memory stubs, session-only),
  flushes any queued digest catch-up, and cools 65s before the trigger.
- **The task engine's intake gate (I1) and per-item bookkeeping** shape
  what routine goals can run cleanly: goals must say where to FETCH
  material (never "read it" / "that email" / "the document"), and
  composition steps ("write the tailored resume") planned as foreach get
  their bookkeeping marked failed even when the work lands. The seeded
  automation goals are worded around both; keep that wording.
- **The model narrates instead of acting ~2 of 3 times** on save_memory /
  save_decision / shift_schedule_items phrasings without an explicit "go
  ahead and save it now" — the memory story keeps nudging until the
  store actually changes.
- **A turn is over only when the assistant's message lands** — "not
  streaming" lies during tool round-trips and consent asks.
- Frames land in the output dir with `concat.txt` (per-frame durations,
  dead air capped) ready for ffmpeg's concat demuxer. Use a DISTINCT
  frames dir per take — a retake otherwise wipes the last good one.
- **The `memory` story is currently blocked on ISSUES.md #2(b)**: the
  save_decision/save_memory turn emits its tool call, then dies without
  the consent card ever rendering (1 success in 6 attempts). Re-record it
  once that's fixed; the choreography is ready.
