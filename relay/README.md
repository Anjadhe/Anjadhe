# Anjadhe relay

A **zero-knowledge rendezvous** that lets a user's phone reach their Mac without
opening a port on the home network. The Mac dials *out* to the relay and holds
the connection open; the phone connects to the relay; the relay forwards frames
between them.

## What the relay can and cannot see

| Can see | Cannot see |
|---|---|
| That a host and a client share a routing ID | Any encryption key |
| Frame sizes and timing | Frame contents — payloads are end-to-end encrypted (Noise) between Mac and phone |
| Connection metadata (IPs, connect/disconnect) | Prompts, AI responses, or any app data |

The relay forwards `payload` strings verbatim and never decrypts them.
Confidentiality is enforced at the endpoints by the Noise session — the relay
is deliberately dumb. A hostile or compromised relay operator still learns
nothing about the user's data.

## Run

```sh
npm install
npm start          # listens on :8787 (override with PORT=...)
npm test           # smoke test — forwards frames both ways
```

`GET /healthz` returns `ok` for liveness checks.

## Protocol

See the header comment in `server.js` for the full message set. In short:
a peer sends `hello` with a `routingId` and a `role` (`host` = the Mac,
`client` = a phone); afterwards `data` frames carry opaque ciphertext.

## Deployments

- **This Node server** — for local development and the channel tests
  (`js/channel/test-*.mjs`), which start it in-process.
- **Anjadhe Connect** — the production deployment since 2026-07-28:
  `wss://api.anjadhe.com/v1/relay` (`lib/relay.js` in the anjadhe-connect
  repo). Same protocol, same zero-knowledge model, plus abuse controls and
  a 1 MiB frame cap — `js/channel/channel-endpoint.mjs` chunks larger
  payloads to fit. Verify it with `RELAY_URL=wss://api.anjadhe.com/v1/relay
  node worker/smoke.mjs`.
- **`worker/`** — the former production deployment (Cloudflare Worker,
  one Durable Object per routing ID). Superseded; kept for reference until
  the worker is deleted. See `worker/README.md`.

## Status / roadmap

- v0.1 — single Mac + multiple phones per routing ID, in-memory rooms.
- Later — connection rate-limiting and metrics. Pairing and the Noise session
  that produce the routing ID and keys live in the desktop app and the mobile
  app, not here.
