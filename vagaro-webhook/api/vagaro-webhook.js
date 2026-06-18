export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  const now = new Date().toISOString();
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "yg-vagaro-webhook", time: now });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  let raw = "";
  try { raw = await readRawBody(req); }
  catch (e) { console.error("vagaro-webhook: read body failed:", e); }
  console.log("==== VAGARO WEBHOOK RECEIVED", now, "====");
  console.log("METHOD:", req.method, "URL:", req.url);
  console.log("HEADERS:", JSON.stringify(req.headers, null, 2));
  console.log("RAW BODY:", raw);
  const expected = process.env.VAGARO_VERIFICATION_TOKEN || "";
  if (expected) {
    const hdr = JSON.stringify(req.headers).toLowerCase();
    const inHeader = hdr.includes(expected.toLowerCase());
    const inBody = raw.includes(expected);
    console.log(`TOKEN CHECK: configured=yes in_header=${inHeader} in_body=${inBody}`);
  } else {
    console.log("TOKEN CHECK: no VAGARO_VERIFICATION_TOKEN env var set yet");
  }
  try {
    const p = JSON.parse(raw);
    console.log("PARSED type:", p.type, "action:", p.action, "id:", p.id);
  } catch (_) { console.log("PARSED: body was not valid JSON"); }
  res.status(200).json({ received: true, at: now });
}
