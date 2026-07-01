// Deno Deploy — key-hiding proxy for the itch web build's live AI callers.
// Use this instead of the Cloudflare Worker: Anthropic blocks Cloudflare Workers
// (they carry a cf-worker header), but Deno Deploy is not blocked.
//
// Deploy (no CLI): https://dash.deno.com → New Project → Playground → paste this →
// Save & Deploy. Then Settings → Environment Variables → add ANTHROPIC_API_KEY.
// Your URL will look like  https://<project>.deno.dev
//
// CONVERSATION LOGGING: every turn (the player's typed reply + the caller's
// response) is stored in Deno KV so you can review real players' answers later
// while developing. Export them with:
//     GET  https://<project>.deno.dev/logs?token=<LOG_TOKEN>          (JSON)
//     GET  https://<project>.deno.dev/logs?token=<LOG_TOKEN>&format=jsonl
// Set the LOG_TOKEN env var (any secret string) alongside ANTHROPIC_API_KEY.
// If LOG_TOKEN is unset, the /logs endpoint is disabled (logging still happens).
// NOTE: this records what players type — disclose "conversations are logged for
// development" on the itch page.

const ALLOWED_MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 400;
const RL_PER_IP = 100;    // max AI calls per IP per 10-minute window
const RL_PER_DAY = 1000;  // max total AI calls per UTC day (bounds Anthropic spend)
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

// KV is best-effort: if it's unavailable the proxy still serves AI calls.
let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
} catch (_e) {
  kv = null;
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

// Pull the last player message and the caller's parsed reply out of a turn,
// then write a compact log row. Never throws — logging must not break the call.
// `usage` is the Anthropic response's usage block, so rows carry REAL token
// counts (no estimation needed when totalling cost later).
async function logTurn(
  body: Record<string, unknown>,
  replyText: string,
  usage: Record<string, unknown> | null,
  meta: Record<string, unknown>,
): Promise<void> {
  if (!kv) return;
  try {
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    let player = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        const c = messages[i].content;
        player = typeof c === "string" ? c : JSON.stringify(c);
        break;
      }
    }
    const system = typeof body.system === "string" ? body.system : "";
    const persona = system.slice(0, 80);  // enough to tell which caller this is
    // Client analytics (stripped from the Anthropic call): who's playing + how.
    const session = typeof meta.session === "string" ? meta.session : "";
    const mode = typeof meta.mode === "string" ? meta.mode : "";
    const choices = Array.isArray(meta.choices) ? meta.choices : [];

    // The caller's reply is JSON ({say, presence_delta, end}) inside replyText.
    let say = replyText, presence: unknown = null, ended: unknown = null;
    try {
      const parsed = JSON.parse(replyText);
      if (parsed && typeof parsed === "object") {
        say = parsed.say ?? replyText;
        presence = parsed.presence_delta ?? null;
        ended = parsed.end ?? null;
      }
    } catch (_e) { /* keep raw */ }

    // Real token usage from the Anthropic response (undefined keys -> null).
    const inTok = usage ? Number(usage.input_tokens ?? 0) : null;
    const outTok = usage ? Number(usage.output_tokens ?? 0) : null;
    const cacheR = usage ? Number(usage.cache_read_input_tokens ?? 0) : null;
    const cacheW = usage ? Number(usage.cache_creation_input_tokens ?? 0) : null;

    const ts = new Date().toISOString();
    // Key is time-ordered so list() returns chronologically.
    await kv.set(["log", ts, crypto.randomUUID()], {
      kind: "turn",
      ts, persona, player, say, presence, end: ended,
      session, mode, choices,
      in: inTok, out: outTok, cacheR, cacheW,
    });
  } catch (_e) { /* logging is best-effort */ }
}

// Progression beacons (night_start / call_start / call_end / result). These never
// call Anthropic — they only write a KV row so we can compute clear rate and the
// drop-off funnel. Lightly rate-limited per IP (they cost nothing to serve).
async function eventRateLimited(req: Request): Promise<Response | null> {
  if (!kv) return null;
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim() || "unknown";
  const evKey = ["rl_ev", ip, Math.floor(Date.now() / 600000)];  // 10-minute window
  try {
    const c = (Number((await kv.get(evKey)).value) || 0) + 1;
    await kv.set(evKey, c, { expireIn: 660000 });
    if (c > 400) return json({ error: "rate limited" }, 429);
  } catch (_e) { /* KV hiccup — don't block */ }
  return null;
}

async function serveEvent(req: Request): Promise<Response> {
  const limited = await eventRateLimited(req);
  if (limited) return limited;
  let e: Record<string, unknown>;
  try {
    e = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (kv) {
    try {
      const ts = new Date().toISOString();
      await kv.set(["event", ts, crypto.randomUUID()], { kind: "event", ts, ...e });
    } catch (_e) { /* best-effort */ }
  }
  return json({ ok: true }, 200);
}

async function serveLogs(req: Request): Promise<Response> {
  const token = Deno.env.get("LOG_TOKEN") ?? "";
  const url = new URL(req.url);
  if (token === "") return json({ error: "logs disabled (set LOG_TOKEN)" }, 404);
  if (url.searchParams.get("token") !== token) return json({ error: "unauthorized" }, 401);
  if (!kv) return json({ error: "kv unavailable" }, 503);

  const rows: unknown[] = [];
  for await (const entry of kv.list({ prefix: ["log"] })) rows.push(entry.value);
  for await (const entry of kv.list({ prefix: ["event"] })) rows.push(entry.value);

  if (url.searchParams.get("format") === "jsonl") {
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    return new Response(body, { status: 200, headers: { ...CORS, "content-type": "application/x-ndjson" } });
  }
  return json({ count: rows.length, rows }, 200);
}

// Abuse control: per-IP + per-day counters in KV. Stops a hostile actor from
// scripting the public proxy to burn the API key's spend cap. Best-effort: if KV
// is down it skips (the $10 monthly cap is the hard backstop regardless).
async function rateLimited(req: Request): Promise<Response | null> {
  if (!kv) return null;
  const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim() || "unknown";
  const now = Date.now();
  const ipKey = ["rl_ip", ip, Math.floor(now / 600000)];   // 10-minute window
  const dayKey = ["rl_day", Math.floor(now / 86400000)];   // UTC day
  try {
    const ipCount = (Number((await kv.get(ipKey)).value) || 0) + 1;
    await kv.set(ipKey, ipCount, { expireIn: 660000 });      // ~11 min
    if (ipCount > RL_PER_IP) return json({ error: "rate limited: too many requests, slow down" }, 429);
    const dayCount = (Number((await kv.get(dayKey)).value) || 0) + 1;
    await kv.set(dayKey, dayCount, { expireIn: 90000000 });  // ~25 h
    if (dayCount > RL_PER_DAY) return json({ error: "daily limit reached, try again tomorrow" }, 429);
  } catch (_e) { /* KV hiccup — don't block the game */ }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/logs") return serveLogs(req);
  if (req.method === "POST" && url.pathname === "/event") return serveEvent(req);

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const limited = await rateLimited(req);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  // Clamp to keep cost bounded regardless of what the client sends.
  body.model = ALLOWED_MODEL;
  body.max_tokens = Math.min(Number(body.max_tokens) || 300, MAX_TOKENS);

  // Pull off our analytics rider and strip it — Anthropic rejects unknown fields.
  const meta = (body._meta && typeof body._meta === "object")
    ? body._meta as Record<string, unknown> : {};
  delete body._meta;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();

  // Log the turn on success (extract the reply text from the Messages response).
  if (r.status === 200) {
    try {
      const data = JSON.parse(text);
      let reply = "";
      if (data && Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block?.type === "text") reply += block.text;
        }
      }
      const usage = data && typeof data.usage === "object" ? data.usage : null;
      await logTurn(body, reply, usage, meta);
    } catch (_e) { /* best-effort */ }
  }

  return new Response(text, { status: r.status, headers: { ...CORS, "content-type": "application/json" } });
});
