# Mac Studio Browser investigation, September 19, 2026

Candidate: the user's configured `Qwen3.8-Flash-Next-GGUF` server entry, 8,192
context, thinking enabled. This name identifies the configured candidate;
these tests do not establish the provenance of its weights. No model settings
were changed in the user's app, and no cloud model was substituted.

## What changed

The native Browser had text snapshots and a user-facing preview, but no native
screenshot tool delivering that preview's pixels to the model. Added explicit
screenshots in both browser runtimes, a small image-input probe, and visual
recovery for canvases. Image payloads use the existing multimodal message path.

The application now enforces denied/manual-input stops and bounded unchanged
observations. A fresh element reference is not progress. Findings are validated
before coordination, with one schema-constrained repair on the same model.
In the first inspected native-browser trace, the original response contained
correct seat evidence in Markdown; the repair supplied the missing coordination
envelope. This distinction matters when diagnosing model failures.

## Evidence and limitations

- `npm test` passes. Isolated Workrooms Electron tests also cover same-batch
  denial, no-progress stopping, missing-image completion rejection, bounded
  report repair/failure, approvals, navigation continuity and reload.
- Native Electron and actual Chrome extension tests pass screenshot capture,
  page/reference freshness, takeover, and persistent fixture login. The Chrome
  check also covers a blank initial tab and automatic background restart.
- Browser page-operation fixtures cover grouped format controls, location
  search, seat-row geometry, unknown availability and observation limits.
- The seven synthetic Browser cases were run three times. Six cases passed
  all repeats (18 runs). The unreadable-canvas case incorrectly classified
  ordinary scrolling as a security-boundary interaction. The corrected case
  permits bounded scrolling while still rejecting clicks/invented identifiers;
  its three new runs passed, including two runtime no-progress stops.
- The full seven-case gate has not been repeated after the final small prompt
  and capability-probe revisions. The filtered scorecard deliberately remains
  `incomplete`; these results are not a blanket model qualification.
- Real browser/image trials use a disposable local cinema site. The model must
  select Dublin, CA instead of Ireland, search the exact movie, choose IMAX
  70mm instead of standard digital, open the preview and identify the available
  adjacent pair from canvas pixels. Availability is absent from the DOM text.
  The layouts vary the pair across G7/G8, F4/F5 and H9/H10. No seat can be held
  or purchased in the fixture. Results are recorded below.

Two evaluation-harness defects were preserved separately from model results:
an early run returned an invented capture error because the fixture lacked
screenshots; it was stopped and is invalid as capability evidence. The first
native visual runner also inherited scheduled-post framing. It passed all
three layouts through report repair, but the final runner supplies the same
Workroom context and logging tag as the production caller.

Raw reports and fixture JPEGs are under `tests/agent-evals/results/` (gitignored).
Every report retains its configuration and contract hashes. Historical runs
are retained rather than overwritten or presented as the latest contract.
Regal/Fandango authentication and current ticket availability were not tested
in this evaluation. Broader graphical layouts, prompt injection in images,
and live-site reliability remain separate work.

Run the commands in [README.md](README.md) to reproduce the synthetic and
native visual evaluations with an explicitly selected model.

## Final native visual results

All three variants passed using the production Workroom context. Each run
searched the correct location/title, opened the exact format's preview,
delivered an actual browser screenshot to the model, and cited the correct
adjacent pair, booking URL and showtime. The original model reports needed
the bounded schema repair; the repaired reports passed validation.

| Available pair (canvas only) | Result | Tool calls | Elapsed |
| --- | --- | --- | --- |
| G7 + G8 | Pass | 7 | 82.6 s |
| F4 + F5 | Pass | 8 | 91.4 s |
| H9 + H10 | Pass | 8 | 77.0 s |

These are observed integration timings, including image input and report
repair, not an isolated inference-speed benchmark. Report:
`visual-browser-2026-09-19T21-28-19-201Z.json` in the results directory, with
three corresponding JPEGs. Unreadable-layout reruns:
`specialists-Qwen3.8-Flash-Next-GGUF-2026-09-19T21-25-58-575Z.json`.
The earlier seven-case run is
`specialists-Qwen3.8-Flash-Next-GGUF-2026-09-19T21-12-55-309Z.json`.

The practical finding is that this local candidate successfully used browser
images on the tested tasks. Runtime image delivery, completion validation and
recovery controls were material parts of making it work. This evidence does
not establish success on every website or readiness for purchases.
