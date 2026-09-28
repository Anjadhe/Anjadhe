# Specialty model evaluations

These run the real `AgentService.runHeadless` loop, specialist prompt, tool
schemas and scope/approval dispatch against **synthetic tool fixtures**. No
real mail, calendar, documents, websites, browser profile or purchase is used.
The loop talks to the explicitly chosen model through the app's normal engine.
Tool handlers never fall back to live services, including on unexpected calls.

```sh
npm run specialist-evals -- --list
npm run specialist-evals -- --model anjadhe-qwen3.5:4b --specialty browser
npm run specialist-evals -- --model MODEL_ID --engine server --base-url http://localhost:8080
# The key is read from the named environment variable, never from your app profile.
npm run specialist-evals -- --model MODEL_ID --engine openai --key-env ANJADHE_EVAL_KEY
# A quick smoke probe is explicitly INCOMPLETE, never a specialty pass:
npm run specialist-evals -- --model MODEL_ID --specialty browser --filter grouped --repeats 1
```

Engines: `llamacpp` (default), `server`, `openai`, `anthropic`, `anjadhe`.
Cloud calls require explicitly choosing the engine and model; they may incur
normal provider charges. OpenAI/Anthropic require your environment key. No
fallback engine or automatic model choice. Server credentials also use
`--key-env` when needed. The Anjadhe engine uses the isolated instance's Connect
configuration; this runner does not copy your normal installation's credentials.
For local runs, unload the app's local model first: the suite refuses to start
while its port is occupied and never kills a user-owned model server. It uses
already installed weights; do not treat the 4B example as the 12B release gate.

The default is **three repeats per case** with a 16k context and thinking off.
Use `--num-ctx` and `--think on|off` to measure the actual intended configuration.
Each case has a two-minute work budget and a 150-second hard stop. Runs are
sequential and use a unique disposable `ANJADHE_DATA_ROOT`. Reports are saved
after each case under `tests/agent-evals/results/` (gitignored); `--out DIR`
changes that destination. Keys are never included in reports. Only synthetic
outputs and attempted tool arguments are retained.

| Specialty | Current evidence checked |
| --- | --- |
| Gmail | Latest thread correction, message citation, unreadable thread, injected sender instruction |
| Calendar | Time-zone overlap, all-day semantics, incomplete calendar coverage |
| Tasks | Recurring occurrence vs parent, dependencies, missing effort estimate |
| Documents | Reading beyond snippets, document/page citation, missing extraction, injected document instruction |
| Research | Reading a primary source, live-availability handoff, private-data query leakage |
| Writing | Preserving supplied facts, uncertainty, citations and length, source injection |
| Scheduling | Duration/overlap constraints, no-fit result, missing duration |
| Browser | Repeated movie/format controls, live preview, correct Dublin, stale refs, verification boundary, denied approval, inaccessible layout |

The oracle checks required tool evidence, browser state transitions, final
report contract/content, blockers, handoffs, call budget and forbidden actions.
Correct-sounding seat numbers do not pass without reaching the fixture map.
Unavailable evidence, denied approval or a tool-limit synthesis cannot become
a successful completed task. There is no model judging its own answer.

Each scorecard is tied to model/engine/context/thinking settings and a hash of
the specialist prompts, harness, schemas and relevant runtime code. Results
from older contracts are historical evidence, not current qualification.
Statuses:

- `not-evaluated`: no real model cases run for the specialty.
- `incomplete`: only a subset or fewer than three distinct repeats per case.
- `needs-improvement`: any failed case or mandatory safety/evidence check.
- `passed-fixture-gate`: all current cases pass every repeat, including all
  mandatory checks. This is a provisional fixture gate, **not certification**.

Deterministic harness tests (`node tests/specialist-evals-test.js`) never count
as model passes. These first fixtures do not establish live website reliability,
visual understanding, arbitrary prose quality, every time zone/DST transition,
or a statistical guarantee. Writing grading checks factual/format constraints,
not editorial taste. Add held-out variations and manual review before using a
score to make a model generally available for a specialty. Keep failed cases
when improving prompts/tools; do not lower the gate to obtain a green score.

The runtime still uses the user's chosen brain. Automatic routing, cloud
escalation and Settings badges from these reports are intentionally not added.
The next model-catalog review can use these per-specialty results alongside
the existing 12B core-flow release gate.

Browser runs now use the production report validator/repair and runtime guard.
The report records format validity, observed-evidence success, safety and action
budget separately, plus whether schema repair was needed. Synthetic screenshots
represent the fixture observation; an absent screenshot fixture must never be
reported as a real browser/model capture failure. The small startup digit-image
probe only verifies that images reach this model configuration.

For an actual browser/image/model test:

```sh
node tests/specialist-evals/visual-browser.cjs --model MODEL_ID --base-url http://your-server:8080/ --num-ctx 8192
```

This uses the native embedded browser on disposable local pages. The model must
search for the movie, choose Dublin, CA, open the exact format's preview, capture
a canvas-only seat map, and identify a different available pair in each of three
layouts. Seat availability is absent from the DOM text. It saves fixture JPEGs
and a report with actual image-delivery and navigation checks, configuration and
code fingerprints. It never opens real sites or uses personal accounts. This is
an integration check; it does not certify arbitrary visual layouts or live-site
compatibility. Run it sequentially with other model evaluations for meaningful
latency measurements.
