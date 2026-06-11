// brevo-proxy — Yeager's Gym server-side email capture middleman
// DEPLOYED TO: Supabase project "Yeagers-Michelle" (ref qfprpepqzckymbijeexw)
// ENDPOINT:    https://qfprpepqzckymbijeexw.supabase.co/functions/v1/brevo-proxy
// SECRET:      BREVO_API_KEY (set in Supabase dashboard → Edge Function secrets — NEVER in this file or the website)
// verify_jwt:  false (public form endpoint with its own validation)
//
// This is the source of record for the deployed function. To update: edit and redeploy via Supabase.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") ?? "";
const BREVO_URL = "https://api.brevo.com/v3/contacts";

// Only these Brevo lists may be targeted (ALL_LEADS=8, LEAD_MAGNETS=6, QUIZ_COMPLETIONS=7).
const ALLOWED_LISTS = new Set([6, 7, 8]);

// Browser origins permitted to call this endpoint.
const ALLOWED_ORIGINS = new Set([
  "https://yeagersgym.com",
  "https://www.yeagersgym.com",
  "https://bradyeager.github.io",
  "http://localhost:3003",
  "http://127.0.0.1:3003",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTR_KEY_RE = /^[A-Z][A-Z0-9_]{0,29}$/;

function cors(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://yeagersgym.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function cleanAttributes(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (!ATTR_KEY_RE.test(k) || v == null) continue;
      if (typeof v === "string") { if (v.length <= 200) out[k] = v; }
      else if (typeof v === "number" || typeof v === "boolean") { out[k] = v; }
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, origin);
  if (!BREVO_API_KEY) return json({ ok: false, error: "server_not_configured" }, 500, origin);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, origin); }

  // Honeypot: bots that fill the hidden field get a fake success and are dropped.
  if (body && typeof body.hp === "string" && body.hp.trim() !== "") return json({ ok: true }, 200, origin);

  const email = (body?.email ?? "").toString().trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ ok: false, error: "invalid_email" }, 400, origin);

  const attributes = cleanAttributes(body?.attributes);
  if (typeof body?.firstName === "string" && body.firstName.trim() && body.firstName.length <= 100) {
    attributes.FIRSTNAME = body.firstName.trim();
  }

  let listIds = Array.isArray(body?.listIds)
    ? body.listIds.map((n: any) => Number(n)).filter((n: number) => ALLOWED_LISTS.has(n))
    : [];
  if (listIds.length === 0) listIds = [8];

  const payload = { email, attributes, listIds, updateEnabled: true };

  try {
    const r = await fetch(BREVO_URL, {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
    });
    if (r.status === 201 || r.status === 204) return json({ ok: true }, 200, origin);
    let data: any = {};
    try { data = await r.json(); } catch { /* ignore */ }
    if (data?.code === "duplicate_parameter") return json({ ok: true }, 200, origin);
    console.error("[brevo-proxy] upstream", r.status, data?.code ?? "");
    return json({ ok: false, error: "upstream_error" }, 502, origin);
  } catch (e) {
    console.error("[brevo-proxy] network", String(e));
    return json({ ok: false, error: "network_error" }, 502, origin);
  }
});
