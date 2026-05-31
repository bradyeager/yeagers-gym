// Command Center email template (v2). Built from the ChatGPT-drafted spec
// with three local modifications:
//   • "Bot confidence" field omitted (bot doesn't compute one).
//   • "Expected Final State" card omitted (speculative; can't predict taps).
//   • Blue #38BDF8 dropped — external-payment-verify uses teal (brand-discipline).
//
// PARALLEL TEMPLATE — does not replace buildEmail(). Selected via the
// EMAIL_STYLE=command-center env var at runtime; otherwise the live email
// stays on the existing template.

import { GITHUB_OWNER, GITHUB_REPO, fmtDate, fmtDateIso } from "./lib.mjs";

// Extended palette per the v2 spec (semantic colors on top of YG brand).
export const V2 = {
  bg: "#0A0E17",
  card: "#111827",
  panel: "#151B2A",
  border: "#1E293B",
  teal: "#48C4CC",
  pink: "#EF3295",
  purple: "#9B6FD4",
  white: "#FFFFFF",
  bodyText: "#E5E7EB",
  mutedText: "#9CA3AF",
  disabledText: "#64748B",
  green: "#22C55E",
  yellow: "#FACC15",
  red: "#EF4444",
};

const FONT_BODY = `Inter, Arial, Helvetica, sans-serif`;
const FONT_MONO = `ui-monospace, Menlo, "SF Mono", Consolas, monospace`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString()}`;
const timeOf = (d) => new Date(d).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const dayLabel = (d) => new Date(d).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "numeric", day: "numeric" });
const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
const fmtShort = (d) => new Date(d).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "numeric", day: "numeric" });

function categorize(results, now) {
  const THIS_WEEK_START = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isLagging = (r) => new Date(r.appt.date) < THIS_WEEK_START;
  const unpaidAll = results.filter((r) => r.status === "UNPAID");
  const reviewAll = results.filter((r) => r.status === "NEEDS_REVIEW");
  return {
    unpaid: unpaidAll.filter((r) => !isLagging(r)),
    review: reviewAll.filter((r) => !isLagging(r)),
    lagging: [...unpaidAll, ...reviewAll].filter(isLagging).sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date)),
    unknown: results.filter((r) => r.status === "UNKNOWN"),
    unidentified: results.filter((r) => r.status === "UNIDENTIFIED_SLOT"),
    paidVenmo: results.filter((r) => r.status === "PAID_VENMO"),
    paidCash: results.filter((r) => r.status === "PAID_CASH"),
    paidPrepaid: results.filter((r) => r.status === "PAID_PREPAID"),
    cashPending: results.filter((r) => r.status === "CASH_PENDING"),
  };
}

// ─── Atoms ───────────────────────────────────────────────────────────

function statusPill(level) {
  const cfg = {
    green: { bg: V2.green, text: "ALL CLEAR", fg: "#062810" },
    yellow: { bg: V2.yellow, text: "REVIEW", fg: "#3a2a00" },
    red: { bg: V2.red, text: "ACTION REQUIRED", fg: "#3a0000" },
  }[level];
  return `<span style="display:inline-block;padding:5px 11px;background:${cfg.bg};color:${cfg.fg};font-family:${FONT_BODY};font-size:11px;font-weight:700;letter-spacing:0.08em;border-radius:99px;">&#9679; ${cfg.text}</span>`;
}

function sectionLabel(text, color = V2.teal) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 10px;"><tr>`
    + `<td valign="middle" style="padding-right:10px;"><div style="width:18px;height:3px;background:${color};border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>`
    + `<td valign="middle" style="font-family:${FONT_BODY};color:${color};font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;">${text}</td>`
    + `</tr></table>`;
}

function card(inner, accent = V2.border) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${V2.card}" style="background-color:${V2.card};border:1px solid ${V2.border};border-left:3px solid ${accent};border-radius:10px;margin-bottom:10px;">`
    + `<tr><td style="padding:14px 16px;">${inner}</td></tr></table>`;
}

function tile({ label, value, color, mono = false }) {
  const valFont = mono ? FONT_MONO : FONT_BODY;
  return `<td valign="top" style="padding:5px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${V2.card}" style="background-color:${V2.card};border:1px solid ${V2.border};border-radius:10px;">`
    + `<tr><td style="padding:14px 16px;">`
    + `<div style="font-family:${valFont};font-size:26px;font-weight:800;color:${color};line-height:1;">${value}</div>`
    + `<div style="font-family:${FONT_BODY};font-size:11px;color:${V2.mutedText};margin-top:9px;letter-spacing:0.03em;">${label}</div>`
    + `</td></tr></table></td>`;
}

function tileRow(...tiles) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;"><tr>${tiles.join("")}</tr></table>`;
}

// ─── Action Queue cards ──────────────────────────────────────────────

function actionCard({ priority, type, accent, client, when, expected, received, method, issue, fix, action }) {
  const delta = (expected != null && received != null) ? received - expected : null;
  let inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
    + `<td valign="top">`
      + `<div style="font-family:${FONT_BODY};font-size:11px;color:${accent};font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">Priority ${priority} &middot; ${esc(type)}</div>`
      + `<div style="font-family:${FONT_BODY};font-size:16px;color:${V2.white};font-weight:700;margin-top:6px;">${esc(client)}</div>`
      + `<div style="font-family:${FONT_MONO};font-size:12px;color:${V2.mutedText};margin-top:3px;">${esc(when)}</div>`
    + `</td>`
    + `<td valign="top" align="right" style="font-family:${FONT_MONO};font-size:13px;color:${V2.bodyText};white-space:nowrap;">`;
  if (expected != null) inner += `<div>Expected <span style="color:${V2.white};font-weight:700;">${money(expected)}</span></div>`;
  if (received != null) inner += `<div style="margin-top:2px;">Received <span style="color:${V2.white};font-weight:700;">${money(received)}</span></div>`;
  if (delta != null && delta !== 0) inner += `<div style="margin-top:2px;color:${V2.yellow};">Δ ${delta > 0 ? "+" : ""}${money(delta)}</div>`;
  if (method) inner += `<div style="margin-top:4px;color:${V2.mutedText};font-family:${FONT_BODY};font-size:11px;">${esc(method)}</div>`;
  inner += `</td></tr></table>`;
  if (issue || fix || action) {
    inner += `<div style="border-top:1px solid ${V2.border};margin-top:12px;padding-top:10px;">`;
    if (issue) inner += `<div style="font-family:${FONT_BODY};font-size:13px;color:${V2.bodyText};"><span style="color:${V2.mutedText};">Issue:</span> ${esc(issue)}</div>`;
    if (fix) inner += `<div style="font-family:${FONT_BODY};font-size:13px;color:${V2.bodyText};margin-top:5px;"><span style="color:${V2.pink};font-weight:700;">Required fix:</span> ${esc(fix)}</div>`;
    if (action) inner += `<div style="margin-top:10px;">${action}</div>`;
    inner += `</div>`;
  }
  return card(inner, accent);
}

function btnPink({ href, label }) {
  return `<a href="${href}" style="display:inline-block;padding:8px 14px;background:${V2.pink};color:#0a0a0a;text-decoration:none;border-radius:6px;font-family:${FONT_BODY};font-size:13px;font-weight:700;margin-right:6px;">${esc(label)}</a>`;
}
function btnTeal({ href, label }) {
  return `<a href="${href}" style="display:inline-block;padding:7px 13px;background:transparent;color:${V2.teal};text-decoration:none;border:1px solid ${V2.teal};border-radius:6px;font-family:${FONT_BODY};font-size:13px;font-weight:700;margin-right:6px;">${esc(label)}</a>`;
}

// ─── Action Queue builder ────────────────────────────────────────────

function buildActionQueue(cats) {
  const items = [];
  // P1 — Unpaid this week (red)
  for (const r of cats.unpaid) {
    const handle = r.roster?.venmo_handle;
    const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
    const action = handle ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${expected}&note=Training%20${encodeURIComponent(fmtDateIso(r.appt.date))}`, label: `Request ${money(expected)} on Venmo` }) : "";
    items.push({
      priority: 1, type: "Unpaid", accent: V2.red,
      client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date),
      expected, received: null, method: r.roster?.notes?.toLowerCase().includes("zelle") ? "Zelle" : "Venmo",
      issue: "No payment received this week.",
      fix: "Tap to send a Venmo request.",
      action,
    });
  }
  // P1.5 — Lagging (older unpaid/review). Use red if it was UNPAID.
  for (const r of cats.lagging) {
    const isUnp = r.status === "UNPAID";
    const handle = r.roster?.venmo_handle;
    const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
    const received = r.payment?.amount ?? null;
    const action = handle && isUnp ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${expected}&note=Training%20${encodeURIComponent(fmtDateIso(r.appt.date))}`, label: `Request ${money(expected)} on Venmo` }) : "";
    items.push({
      priority: 1, type: isUnp ? "Unpaid (carryover)" : "Review (carryover)", accent: isUnp ? V2.red : V2.yellow,
      client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date),
      expected, received, method: r.payment ? "Venmo" : null,
      issue: "Carried over from a prior week — clear first.",
      fix: isUnp ? "Send a Venmo request, or accept as cash if collected." : "Review the amount mismatch; accept or chase the balance.",
      action,
    });
  }
  // P2 — Payment mismatch (yellow)
  for (const r of cats.review) {
    const handle = r.roster?.venmo_handle;
    const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
    const received = r.payment?.amount ?? null;
    const delta = received != null && expected != null ? received - expected : null;
    const shortBy = delta != null && delta < 0 ? -delta : null;
    const action = shortBy && handle ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${shortBy}&note=${encodeURIComponent("Balance for " + fmtDateIso(r.appt.date))}`, label: `Request ${money(shortBy)} balance` }) : "";
    items.push({
      priority: 2, type: "Payment Mismatch", accent: V2.yellow,
      client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date),
      expected, received, method: "Venmo",
      issue: `Received ${money(received)} but expected ${money(expected)}.`,
      fix: shortBy ? `Request the ${money(shortBy)} balance, or accept as paid in full.` : "Eyeball — could be a tip or smoothie add-on.",
      action,
    });
  }
  // P3 — External payment verification (teal)
  for (const r of cats.cashPending) {
    const notes = (r.roster?.notes || "").toLowerCase();
    const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
    let bankHref = null, bankLabel = null;
    if (notes.includes("chase")) { bankHref = "https://secure.chase.com/web/auth/dashboard"; bankLabel = "Verify in Chase"; }
    else if (notes.includes("capital one") || notes.includes("capitalone")) { bankHref = "https://verified.capitalone.com/auth/signin"; bankLabel = "Verify in Capital One"; }
    const method = notes.includes("zelle") ? (notes.includes("chase") ? "Zelle · Chase" : notes.includes("capital one") ? "Zelle · Capital One" : "Zelle") : notes.includes("check") ? "Check / cash" : "Cash";
    const confirmHref = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/new/main/billing/cash-entries?filename=${fmtDateIso(r.appt.date)}-${(r.roster?.vagaro_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md&value=${encodeURIComponent(`${fmtDateIso(r.appt.date)} | ${r.roster?.vagaro_name} | $${expected} | per weekly billing email\n`)}`;
    items.push({
      priority: 3, type: "External Payment Verification", accent: V2.teal,
      client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date),
      expected, received: null, method,
      issue: `${method} not yet confirmed.`,
      fix: "Verify it landed in your bank app, then tap Confirm paid.",
      action: (bankHref ? btnPink({ href: bankHref, label: bankLabel }) : "") + btnTeal({ href: confirmHref, label: "Confirm paid" }),
    });
  }
  // P4 — Unidentified slots (purple)
  for (const r of cats.unidentified) {
    items.push({
      priority: 4, type: "Unidentified Slot", accent: V2.purple,
      client: "Unidentified session", when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date),
      expected: null, received: null, method: null,
      issue: `Vagaro slot not mapped to a client — ${esc(r.appt.summary || "unknown")}.`,
      fix: "If it's a real client, add them to schedule.csv. Otherwise mark INACTIVE.",
    });
  }
  // P5 — Unknown
  for (const r of cats.unknown) {
    items.push({
      priority: 5, type: "Unknown Client", accent: V2.purple,
      client: r.appt.client_name || "Unknown", when: fmtShort(r.appt.date),
      expected: null, received: null, method: null,
      issue: "Booked under a name that isn't in clients.csv.",
      fix: "Add to clients.csv, or correct the Vagaro booking name.",
    });
  }
  return items;
}

// ─── Session Ledger (grouped by day) ─────────────────────────────────

function ledgerRow(r) {
  const time = timeOf(r.appt.date);
  let icon, color, tag = "";
  switch (r.status) {
    case "PAID_VENMO":
      icon = "&#9989;"; color = V2.green;
      if (r.inferred) tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; rescheduled</span>`;
      break;
    case "PAID_CASH":
      icon = "&#9989;"; color = V2.green;
      tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; cash</span>`;
      break;
    case "PAID_PREPAID":
      icon = "&#9989;"; color = V2.green;
      tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; prepaid</span>`;
      break;
    case "NEEDS_REVIEW":
      icon = "&#9203;"; color = V2.yellow;
      tag = `<span style="color:${V2.yellow};font-size:11px;font-family:${FONT_MONO};"> &middot; review &middot; ${money(r.payment?.amount)}</span>`;
      break;
    case "CASH_PENDING":
      icon = "&#9203;"; color = V2.yellow;
      tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; expected check/Zelle</span>`;
      break;
    case "UNPAID":
      icon = "&#10060;"; color = V2.red;
      tag = `<span style="color:${V2.red};font-size:11px;font-family:${FONT_MONO};"> &middot; ${money(r.expectedPrice ?? r.roster?.default_price)} unpaid</span>`;
      break;
    case "UNIDENTIFIED_SLOT":
      icon = "&#10067;"; color = V2.purple;
      tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; ${esc(r.appt.summary || "unknown")}</span>`;
      break;
    case "UNKNOWN":
      icon = "&#10067;"; color = V2.purple;
      tag = `<span style="color:${V2.mutedText};font-size:11px;"> &middot; not in roster</span>`;
      break;
    default:
      icon = "&bull;"; color = V2.bodyText;
  }
  const name = r.roster?.vagaro_name || r.appt.client_name || "(unidentified)";
  return `<tr><td style="padding:5px 0;font-family:${FONT_BODY};font-size:14px;color:${color};">`
    + `<span style="display:inline-block;width:22px;color:${color};">${icon}</span>`
    + `<span style="display:inline-block;width:74px;font-family:${FONT_MONO};font-size:12px;color:${V2.mutedText};">${time}</span>`
    + `<span style="color:${V2.bodyText};">${esc(name)}</span>${tag}`
    + `</td></tr>`;
}

function ledger(results) {
  if (!results.length) return "";
  const byDay = new Map();
  for (const r of results) {
    const k = dayKey(r.appt.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  let html = "";
  for (const k of [...byDay.keys()].sort()) {
    const rows = byDay.get(k).sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date));
    const dayName = new Date(k + "T20:00:00Z").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "numeric", day: "numeric" });
    html += `<div style="margin:14px 0 6px;font-family:${FONT_BODY};font-size:13px;font-weight:700;color:${V2.white};">${esc(dayName)}</div>`;
    html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map(ledgerRow).join("")}</table>`;
  }
  return html;
}

// ─── Main email builder ──────────────────────────────────────────────

export function buildEmailV2({ results, unmatchedPayments, now, windowStart, checkoutPrompt }) {
  const cats = categorize(results, now);
  const paidCount = cats.paidVenmo.length + cats.paidCash.length + cats.paidPrepaid.length;
  const actionsCount = cats.unpaid.length + cats.review.length + cats.cashPending.length + cats.lagging.length + cats.unidentified.length + cats.unknown.length;

  // System status logic
  let level, statusText, statusReason, nextMove;
  if (cats.unpaid.length || cats.lagging.some((r) => r.status === "UNPAID")) {
    level = "red";
    statusText = "ACTION REQUIRED";
    statusReason = `${cats.unpaid.length + cats.lagging.filter((r) => r.status === "UNPAID").length} unpaid session${(cats.unpaid.length + cats.lagging.filter((r) => r.status === "UNPAID").length) === 1 ? "" : "s"} need a Venmo request.`;
    nextMove = "Open the Manual Action Queue and tap the pink Request buttons.";
  } else if (cats.review.length || cats.cashPending.length || cats.unidentified.length || cats.lagging.length || cats.unknown.length) {
    level = "yellow";
    statusText = "REVIEW";
    const parts = [];
    if (cats.review.length) parts.push(`${cats.review.length} mismatch${cats.review.length === 1 ? "" : "es"}`);
    if (cats.cashPending.length) parts.push(`${cats.cashPending.length} pending external payment${cats.cashPending.length === 1 ? "" : "s"}`);
    if (cats.unidentified.length) parts.push(`${cats.unidentified.length} unidentified slot${cats.unidentified.length === 1 ? "" : "s"}`);
    statusReason = parts.join(", ") + ".";
    nextMove = "Verify external payments, eyeball mismatches, map any unidentified slots.";
  } else {
    level = "green";
    statusText = "ALL CLEAR";
    statusReason = "All sessions reconciled. No open items.";
    nextMove = "Run the Vagaro checkout block to mark sessions paid in the calendar.";
  }

  // Money totals
  const venmoCollected = cats.paidVenmo.reduce((s, r) => s + (r.payment?.amount || 0), 0);
  const outstanding =
    [...cats.unpaid, ...cats.lagging.filter((r) => r.status === "UNPAID")].reduce((s, r) => s + (r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price ?? 0), 0)
    + [...cats.review, ...cats.lagging.filter((r) => r.status === "NEEDS_REVIEW")].reduce((s, r) => {
      const exp = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price ?? 0;
      const got = r.payment?.amount ?? 0;
      return s + Math.max(0, exp - got);
    }, 0);

  const weekEnding = fmtDate(now);
  const subject = `Weekly billing — week ending ${weekEnding} — ${cats.unpaid.length + cats.lagging.filter((r) => r.status === "UNPAID").length} unpaid, ${cats.review.length + cats.lagging.filter((r) => r.status === "NEEDS_REVIEW").length} review`;
  const preheader = `${money(venmoCollected)} collected · ${money(outstanding)} outstanding · ${actionsCount} action item${actionsCount === 1 ? "" : "s"}`;

  // Body
  let body = "";

  // 2. Weekly Readout — 6 tiles in 2 rows
  body += sectionLabel("Weekly Readout", V2.teal);
  body += tileRow(
    tile({ label: "Paid Sessions", value: paidCount, color: V2.green, mono: true }),
    tile({ label: "Unpaid", value: cats.unpaid.length + cats.lagging.filter((r) => r.status === "UNPAID").length, color: cats.unpaid.length || cats.lagging.some((r) => r.status === "UNPAID") ? V2.red : V2.mutedText, mono: true }),
    tile({ label: "Needs Review", value: cats.review.length + cats.lagging.filter((r) => r.status === "NEEDS_REVIEW").length, color: cats.review.length || cats.lagging.some((r) => r.status === "NEEDS_REVIEW") ? V2.yellow : V2.mutedText, mono: true }),
  );
  body += tileRow(
    tile({ label: "Venmo Collected This Week", value: money(venmoCollected), color: V2.teal, mono: true }),
    tile({ label: "Outstanding — Not Yet Paid", value: money(outstanding), color: outstanding > 0 ? V2.pink : V2.teal, mono: true }),
    tile({ label: "Unidentified", value: cats.unidentified.length + cats.unknown.length, color: cats.unidentified.length || cats.unknown.length ? V2.purple : V2.mutedText, mono: true }),
  );

  // 3. System status card
  body += sectionLabel("System Status", level === "red" ? V2.red : level === "yellow" ? V2.yellow : V2.green);
  body += card(
    `<div style="font-family:${FONT_BODY};font-size:16px;color:${V2.white};font-weight:700;">${esc(statusText)}</div>`
      + `<div style="font-family:${FONT_BODY};font-size:13px;color:${V2.bodyText};margin-top:8px;"><span style="color:${V2.mutedText};">Reason:</span> ${esc(statusReason)}</div>`
      + `<div style="font-family:${FONT_BODY};font-size:13px;color:${V2.bodyText};margin-top:4px;"><span style="color:${V2.mutedText};">Next move:</span> ${esc(nextMove)}</div>`,
    level === "red" ? V2.red : level === "yellow" ? V2.yellow : V2.green,
  );

  // 4. Manual Action Queue
  const actions = buildActionQueue(cats);
  if (actions.length) {
    body += sectionLabel(`Manual Action Queue — ${actions.length}`, V2.pink);
    for (const a of actions) body += actionCard(a);
  }

  // 5. Session Ledger
  body += sectionLabel("This Week — Session Ledger", V2.teal);
  body += `<div style="font-family:${FONT_BODY};font-size:12px;color:${V2.mutedText};margin-bottom:8px;">`
    + `<span style="color:${V2.green};">&#9989;</span> paid &nbsp; `
    + `<span style="color:${V2.red};">&#10060;</span> unpaid &nbsp; `
    + `<span style="color:${V2.yellow};">&#9203;</span> expected / review &nbsp; `
    + `<span style="color:${V2.purple};">&#10067;</span> unidentified`
    + `</div>`;
  body += ledger(results);

  // 6. Unmatched / Unidentified items (only if any)
  if (cats.unidentified.length || unmatchedPayments.length) {
    body += sectionLabel("Unmatched / Unidentified", V2.purple);
    if (cats.unidentified.length) {
      for (const r of cats.unidentified) {
        body += card(
          `<div style="font-family:${FONT_BODY};font-size:14px;color:${V2.white};font-weight:700;">${fmtShort(r.appt.date)} · ${timeOf(r.appt.date)}</div>`
            + `<div style="font-family:${FONT_BODY};font-size:13px;color:${V2.bodyText};margin-top:4px;">${esc(r.appt.summary || "Unknown service")}</div>`
            + `<div style="font-family:${FONT_BODY};font-size:12px;color:${V2.mutedText};margin-top:6px;">Suggested action: map this slot in schedule.csv, or mark INACTIVE.</div>`,
          V2.purple,
        );
      }
    }
    if (unmatchedPayments.length) {
      body += `<div style="font-family:${FONT_BODY};font-size:12px;color:${V2.mutedText};margin:8px 0 4px;">Unmatched Venmo payments (${unmatchedPayments.length})</div>`;
      let list = "";
      for (const p of unmatchedPayments) {
        list += `<tr><td style="padding:4px 0;border-bottom:1px solid ${V2.border};font-family:${FONT_MONO};font-size:12px;color:${V2.mutedText};">${fmtDate(p.date)} · ${esc(p.sender_display_name)} · ${money(p.amount)} · "${esc(p.note || "")}"</td></tr>`;
      }
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${list}</table>`;
    }
  }

  // 7. Vagaro Checkout Instructions — VERBATIM
  if (checkoutPrompt) {
    body += sectionLabel("Vagaro Checkout Instructions", V2.teal);
    body += `<div style="font-family:${FONT_BODY};font-size:12px;color:${V2.mutedText};margin-bottom:6px;">Use this block exactly when checking out sessions in Vagaro. Triple-click inside, ⌘A, ⌘C, paste into a new Claude for Chrome session.</div>`;
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${V2.panel}" style="background-color:${V2.panel};border:1px solid ${V2.border};border-radius:8px;"><tr><td style="padding:12px;">`;
    body += `<pre style="margin:0;font-family:${FONT_MONO};font-size:9px;line-height:1.45;color:${V2.bodyText};white-space:pre-wrap;overflow-x:auto;">${esc(checkoutPrompt)}</pre>`;
    body += `</td></tr></table>`;
  }

  // ── Assemble shell ──
  const headerAccent = level === "red" ? V2.red : level === "yellow" ? V2.yellow : V2.green;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${V2.bg};font-family:${FONT_BODY};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${V2.bg};opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${V2.bg}" style="background-color:${V2.bg};">
  <tr><td align="center" style="padding:22px 12px 40px;">
    <table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:720px;max-width:720px;">

      <!-- 1. Header / transmission bar -->
      <tr><td bgcolor="${V2.card}" style="background-color:${V2.card};border:1px solid ${V2.border};border-radius:14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="${headerAccent}" height="4" style="height:4px;line-height:4px;font-size:0;background-color:${headerAccent};">&nbsp;</td></tr>
          <tr><td style="padding:22px 24px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle">
                <div style="font-family:${FONT_BODY};font-size:28px;line-height:1;font-weight:800;color:${V2.white};">YEAGER'S GYM</div>
                <div style="font-family:${FONT_BODY};font-size:12px;color:${V2.teal};font-weight:700;letter-spacing:0.08em;margin-top:8px;text-transform:uppercase;">Weekly Billing Lab</div>
              </td>
              <td valign="middle" align="right">${statusPill(level)}</td>
            </tr></table>
            <div style="font-family:${FONT_MONO};font-size:12px;color:${V2.mutedText};margin-top:14px;">Week ending ${esc(weekEnding)}</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- Body -->
      <tr><td>${body}</td></tr>

      <!-- 9. Footer -->
      <tr><td style="padding:30px 4px 0;">
        <div style="border-top:1px solid ${V2.border};padding-top:14px;">
          <div style="font-family:${FONT_BODY};font-size:11px;color:${V2.disabledText};line-height:1.7;">
            Window: ${esc(fmtDateIso(windowStart))} → ${esc(fmtDateIso(now))} &middot; log: <span style="font-family:${FONT_MONO};">billing/logs/${esc(fmtDateIso(now))}.md</span><br>
            Yeager's Gym Billing Bot &middot; brad@yeagersgym.com &middot; San Diego, CA
          </div>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, html, preheader };
}
