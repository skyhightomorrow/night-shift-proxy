# night-shift-proxy

Key-hiding live-AI proxy for **Don't Say You're Alone** (itch.io web build).
Deployed on **Deno Deploy** — the app auto-builds on every push to `main`.

- **Entrypoint:** `main.ts`
- **Runtime:** Deno (uses `Deno.serve` + `Deno.openKv`)
- **Secrets live in Deno env vars, NOT in this repo:** `ANTHROPIC_API_KEY`, `LOG_TOKEN`.
- **KV** database `night-shift-logs` is attached in the Deno app (stores turn + progression logs).

## What it does
- Forwards browser → Anthropic Messages API with the API key hidden (browser can't hold it / CORS).
- Strips the client's `_meta` analytics rider before forwarding (Anthropic rejects unknown fields),
  and logs `{session, mode, choices}` + real token usage per turn to Deno KV.
- `POST /event` records progression beacons (night_start / call_start / result) for the clear-rate funnel.
- `GET /logs?token=<LOG_TOKEN>` exports turn + event rows (add `&format=jsonl`).
- Per-IP + per-day rate limits bound abuse / spend.

The canonical source is here (`main.ts`). The game repo keeps a working copy at
`itch-game/deploy/deno_proxy.ts`; edits should be made here and pushed.
