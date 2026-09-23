# Agent evals (docs/COWORK_AGENT.md C8.8)

The repeatable answer to two questions: "did today's harness change break a
journey that worked" and "is this new model better *for these tasks*".

```
npm run agent-evals                # everything (needs a local model; ~20 min)
npm run agent-evals:gate           # deterministic net + baseline gate (~2 min, no model)
node tests/agent-evals/run.js --model gemma4:12b-it-qat   # scorecard for another model
node tests/agent-evals/run.js --filter c84                # id substring
```

- **Deterministic journeys** stub the model at the TaskService/AgentTools
  seams and are the harness regression net — they must always pass.
- **Model journeys** drive the full agent with real prompts and produce the
  per-model scorecard (`results/<model>-<date>.json`, gitignored) used by the
  release-time model catalog review (RELEASING.md 3a).
- **The gate** compares against `baseline.json` (checked in): a journey the
  baseline says passes must pass. Changing behavior on purpose? Update the
  journey and the baseline in the same commit.
- Journeys are **self-contained** — the runner resets agent stores between
  them; never depend on a prior journey's state.
- Runs against a seeded throwaway `ANJADHE_DATA_ROOT`; fixtures (including a
  local Streamable-HTTP MCP spec server) live in `fixtures/`. Never point
  this at real data.
- **Model journeys need port 18434** (the eval app spawns its own
  llama-server). Don't run them while the real app has a local model loaded
  or is network-sharing — the servers contend for the port and every model
  call hangs or fails. `--det-only` is safe alongside a running app.
- If an eval run crashes hard, it can orphan a llama-server holding the
  port; the runner reaps orphans (parent PID 1 + the managed engine path)
  on relaunch and never touches a server whose parent app is alive.
