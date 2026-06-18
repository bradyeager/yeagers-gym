// vagaro-webhook.js — Phase 2: verify x-vagaro-signature, persist event to repo
// Fail-closed: rejects 401 if VAGARO_VERIFICATION_TOKEN is missing or mismatched.

export const config = { api: { bodyParser: false } };

const REPO = "bradyeager/yeagers-gym";
const BRANCH = "main";

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function persistEvent(envelopeId, rawBody) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN env var missing");
  const safeId = String(envelopeId).replace(/[^A-Za-z0-9_-]/g, "_");
  const path = `billing/vagaro-events/${safeId}.json`;
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "yg-vagaro-webhook",
  };
  const head = await fetch(`${url}?ref=${BRANCH}`, { headers });
  if (head.status === 200) return { status: "exists", path };
  if (head.status !== 404) throw new Error(`GH HEAD ${head.status}: ${(await head.text()).slice(0,300)}`);
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `vagaro: ${envelopeId}`,
      content: Buffer.from(rawBody, "utf8").toString("base64"),
      branch: BRANCH,
    }),
  });
  if (!put.ok) throw new Error(`GH PUT ${put.status}: ${(await put.text()).slice(0,300)}`);
  return { status: "created", path };
}

export default async function handler(req, res) {
  const now = new Date().toISOString();
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "yg-vagaro-webhook", phase: 2, time: now });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  let raw = "";
  try { raw = await readRawBody(req); } catch (e) {
    console.error("read body failed:", e);
    res.status(400).json({ error: "bad body" }); return;
  }
  const expected = process.env.VAGARO_VERIFICATION_TOKEN || "";
  const got = req.headers["x-vagaro-signature"] || "";
  if (!expected || got !== expected) {
    console.warn(`rejecting: token_configured=${!!expected} signature_match=${expected ? (got===expected) : "n/a"}`);
    res.status(401).json({ error: "invalid or missing signature" });
    return;
  }
  let env = null;
  try { env = JSON.parse(raw); } catch (_) {}
  console.log("==== VAGARO ====", now, "type:", env?.type, "action:", env?.action, "id:", env?.id);
  if (!env?.id) { res.status(400).json({ error: "missing envelope id" }); return; }
  try {
    const result = await persistEvent(env.id, raw);
    console.log("persisted:", result.status, result.path);
    res.status(200).json({ received: true, persisted: true, status: result.status });
  } catch (e) {
    console.error("persist failed:", e.message);
    res.status(200).json({ received: true, persisted: false, error: "persist_failed" });
  }
}
