// ─────────────────────────────────────────────────────────────────────
// "THE MONEY LINE" — a creative reinvention of the weekly billing email.
//
// Reframes the week as a BOX SCORE, not a dashboard. One dominant money line
// + a coach's verdict up top; the action queue becomes "The Chase List"; the
// session ledger becomes "The Tape"; the Vagaro block is "The Playbook".
//
// All eight original information blocks are preserved (header, readout,
// system status, action queue, ledger, unmatched, checkout, footer) — the
// readout + status are absorbed into the hero. Every session still appears,
// every action item keeps its control, the Vagaro block is byte-for-byte
// verbatim in a <pre>.
//
// Two themes, same structure (drop-in A/B):
//   • "brand" — clean YG dark (teal-dominant, semantic status colors)
//   • "miami" — cyberpunk Miami Beach (teal #48C4CC + hot pink #EF3295 neon
//                over deep night, purple sunset connective, glow + gradients)
//
// Email constraints honored: tables only, inline CSS, no JS, no images,
// email-safe fonts, ≤720px, entity icons, verbatim <pre>.
//
// Signature: buildMoneyLine({ results, unmatchedPayments, now, windowStart,
//                             checkoutPrompt, theme }) → { subject, html, preheader }
// ─────────────────────────────────────────────────────────────────────

import { GITHUB_OWNER, GITHUB_REPO, fmtDate, fmtDateIso } from "./lib.mjs";

const FONT_BODY = `Inter, Arial, Helvetica, sans-serif`;
const FONT_MONO = `ui-monospace, Menlo, 'SF Mono', Consolas, monospace`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => `$${Number(n || 0).toLocaleString()}`;
const timeOf = (d) => new Date(d).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
const dayKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
const fmtShort = (d) => new Date(d).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "numeric", day: "numeric" });

// ─── Themes ──────────────────────────────────────────────────────────

const THEMES = {
  brand: {
    name: "brand",
    bg: "#0A0E17", card: "#111827", cardElev: "#141C2E", heroBg: "#0E1626",
    rowAlt: "#0E1422", panel: "#151B2A", border: "#1E293B", hair: "#26334A",
    teal: "#48C4CC", pink: "#EF3295", purple: "#9B6FD4",
    white: "#FFFFFF", body: "#E5E7EB", muted: "#9CA3AF", dim: "#64748B",
    // semantic
    paid: "#22C55E", unpaid: "#EF4444", review: "#FACC15", unid: "#9B6FD4",
    data: "#48C4CC", action: "#EF3295",
    glow: false, gradient: false,
    heroBarStyle: "background-color:#48C4CC;", heroBarColor: "#48C4CC",
    numIn: "#48C4CC", numOut: "#EF3295",
    inGlow: "", outGlow: "", btnGlow: "",
  },
  miami: {
    name: "miami",
    bg: "#080611", card: "#130E26", cardElev: "#1A1138", heroBg: "#150A2B",
    rowAlt: "#170F2E", panel: "#140C28", border: "#33215C", hair: "#4B2E7A",
    teal: "#3DE7E0", pink: "#FF3DA6", purple: "#9B6FD4",
    white: "#FFFFFF", body: "#E7E0F5", muted: "#A99CC9", dim: "#6A5C92",
    // semantic remapped to the neon trio (teal→purple→pink sunset)
    paid: "#3DE7E0", unpaid: "#FF3DA6", review: "#C77DFF", unid: "#C77DFF",
    data: "#3DE7E0", action: "#FF3DA6",
    glow: true, gradient: true,
    heroBarStyle: "background:linear-gradient(90deg,#3DE7E0 0%,#9B6FD4 50%,#FF3DA6 100%);background-color:#9B6FD4;",
    heroBarColor: "#9B6FD4",
    numIn: "#3DE7E0", numOut: "#FF3DA6",
    inGlow: "text-shadow:0 0 22px rgba(61,231,224,0.55),0 0 4px rgba(61,231,224,0.5);",
    outGlow: "text-shadow:0 0 22px rgba(255,61,166,0.55),0 0 4px rgba(255,61,166,0.5);",
    btnGlow: "box-shadow:0 0 18px rgba(255,61,166,0.45);",
  },
};

// ─── Shared categorize / queue / verdict logic (unchanged behavior) ──

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

// ─── Main builder ────────────────────────────────────────────────────

export function buildMoneyLine({ results, unmatchedPayments, now, windowStart, checkoutPrompt, theme = "brand" }) {
  const T = THEMES[theme] || THEMES.brand;
  const cats = categorize(results, now);

  // ── themed atoms (closures over T) ──────────────────────────────────

  const micro = (text, color = T.muted, ls = "0.12em") =>
    `<span style="font-family:${FONT_BODY};font-size:10px;font-weight:700;letter-spacing:${ls};text-transform:uppercase;color:${color};">${text}</span>`;

  function sectionLabel(text, color = T.teal) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 13px;"><tr>`
      + `<td valign="middle" style="padding-right:11px;"><div style="width:22px;height:3px;${T.gradient ? `background:linear-gradient(90deg,${T.teal},${color});` : `background:${color};`}font-size:0;line-height:0;">&nbsp;</div></td>`
      + `<td valign="middle" style="font-family:${FONT_BODY};color:${color};font-size:12px;font-weight:800;letter-spacing:0.24em;text-transform:uppercase;">${text}</td>`
      + `</tr></table>`;
  }

  function card(inner, accent = T.border, bg = T.card) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background-color:${bg};border:1px solid ${T.border};border-left:3px solid ${accent};border-radius:8px;margin-bottom:10px;">`
      + `<tr><td style="padding:15px 17px;">${inner}</td></tr></table>`;
  }

  function statusPill(level) {
    const map = {
      red: { bg: T.unpaid, text: "ACTION REQUIRED", fg: T.gradient ? "#1a0010" : "#3a0000" },
      yellow: { bg: T.review, text: "REVIEW", fg: T.gradient ? "#1a0030" : "#3a2a00" },
      green: { bg: T.paid, text: "ALL CLEAR", fg: T.gradient ? "#04201f" : "#062810" },
    }[level];
    const glow = T.glow ? `box-shadow:0 0 16px ${map.bg}66;` : "";
    return `<span style="display:inline-block;padding:6px 12px;background:${map.bg};color:${map.fg};font-family:${FONT_BODY};font-size:11px;font-weight:800;letter-spacing:0.1em;border-radius:4px;${glow}">&#9679;&nbsp; ${map.text}</span>`;
  }

  function priorityChip(priority, accent) {
    const glow = T.glow ? `box-shadow:0 0 14px ${accent}55;` : "";
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="${accent}" style="background-color:${accent};border-radius:5px;${glow}">`
      + `<tr><td width="34" height="34" align="center" valign="middle" style="width:34px;height:34px;font-family:${FONT_MONO};font-size:15px;font-weight:800;color:${T.bg};line-height:1;">P${priority}</td></tr></table>`;
  }

  function moneyLedger({ expected, received, delta, method, accent }) {
    let rows = "";
    const line = (lbl, val, valColor = T.white) =>
      `<tr><td align="right" style="padding:1px 0;font-family:${FONT_BODY};font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${T.muted};">${lbl}&nbsp;&nbsp;</td>`
      + `<td align="right" style="padding:1px 0;font-family:${FONT_MONO};font-size:14px;font-weight:700;color:${valColor};white-space:nowrap;">${val}</td></tr>`;
    if (expected != null) rows += line("Expected", money(expected));
    if (received != null) rows += line("Received", money(received));
    if (delta != null && delta !== 0) rows += line("Delta", `${delta > 0 ? "+" : "\u2212"}${money(Math.abs(delta))}`, accent);
    if (method) rows += `<tr><td colspan="2" align="right" style="padding-top:6px;">${micro(method, T.muted)}</td></tr>`;
    if (!rows) return "";
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right">${rows}</table>`;
  }

  function btnPink({ href, label }) {
    return `<a href="${href}" style="display:inline-block;padding:9px 16px;background:${T.action};color:${T.bg};text-decoration:none;border-radius:6px;font-family:${FONT_BODY};font-size:13px;font-weight:800;letter-spacing:0.01em;margin-right:7px;${T.btnGlow}">${esc(label)}</a>`;
  }
  function btnTeal({ href, label }) {
    const glow = T.glow ? `box-shadow:0 0 14px ${T.teal}3a;` : "";
    return `<a href="${href}" style="display:inline-block;padding:8px 15px;background:transparent;color:${T.teal};text-decoration:none;border:1px solid ${T.teal};border-radius:6px;font-family:${FONT_BODY};font-size:13px;font-weight:700;letter-spacing:0.01em;margin-right:7px;${glow}">${esc(label)}</a>`;
  }

  // ── action queue (data) ──
  function buildActionQueue() {
    const items = [];
    for (const r of cats.unpaid) {
      const handle = r.roster?.venmo_handle;
      const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
      const action = handle ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${expected}&note=Training%20${encodeURIComponent(fmtDateIso(r.appt.date))}`, label: `Request ${money(expected)} on Venmo` }) : "";
      items.push({ priority: 1, type: "Unpaid", accent: T.unpaid, client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date), expected, received: null, method: r.roster?.notes?.toLowerCase().includes("zelle") ? "Zelle" : "Venmo", issue: "No payment received this week.", fix: "Tap to send a Venmo request.", action });
    }
    for (const r of cats.lagging) {
      const isUnp = r.status === "UNPAID";
      const handle = r.roster?.venmo_handle;
      const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
      const received = r.payment?.amount ?? null;
      const action = handle && isUnp ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${expected}&note=Training%20${encodeURIComponent(fmtDateIso(r.appt.date))}`, label: `Request ${money(expected)} on Venmo` }) : "";
      items.push({ priority: 1, type: isUnp ? "Unpaid (carryover)" : "Review (carryover)", accent: isUnp ? T.unpaid : T.review, client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date), expected, received, method: r.payment ? "Venmo" : null, issue: "Carried over from a prior week — clear first.", fix: isUnp ? "Send a Venmo request, or accept as cash if collected." : "Review the amount mismatch; accept or chase the balance.", action });
    }
    for (const r of cats.review) {
      const handle = r.roster?.venmo_handle;
      const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
      const received = r.payment?.amount ?? null;
      const delta = received != null && expected != null ? received - expected : null;
      const shortBy = delta != null && delta < 0 ? -delta : null;
      const action = shortBy && handle ? btnPink({ href: `https://venmo.com/${handle}?txn=charge&amount=${shortBy}&note=${encodeURIComponent("Balance for " + fmtDateIso(r.appt.date))}`, label: `Request ${money(shortBy)} balance` }) : "";
      items.push({ priority: 2, type: "Payment Mismatch", accent: T.review, client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date), expected, received, method: "Venmo", issue: `Received ${money(received)} but expected ${money(expected)}.`, fix: shortBy ? `Request the ${money(shortBy)} balance, or accept as paid in full.` : "Eyeball — could be a tip or smoothie add-on.", action });
    }
    for (const r of cats.cashPending) {
      const notes = (r.roster?.notes || "").toLowerCase();
      const expected = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price;
      let bankHref = null, bankLabel = null;
      if (notes.includes("chase")) { bankHref = "https://secure.chase.com/web/auth/dashboard"; bankLabel = "Verify in Chase"; }
      else if (notes.includes("capital one") || notes.includes("capitalone")) { bankHref = "https://verified.capitalone.com/auth/signin"; bankLabel = "Verify in Capital One"; }
      const method = notes.includes("zelle") ? (notes.includes("chase") ? "Zelle · Chase" : notes.includes("capital one") ? "Zelle · Capital One" : "Zelle") : notes.includes("check") ? "Check / cash" : "Cash";
      const confirmHref = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/new/main/billing/cash-entries?filename=${fmtDateIso(r.appt.date)}-${(r.roster?.vagaro_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md&value=${encodeURIComponent(`${fmtDateIso(r.appt.date)} | ${r.roster?.vagaro_name} | $${expected} | per weekly billing email\n`)}`;
      items.push({ priority: 3, type: "External Payment Verification", accent: T.teal, client: r.roster?.vagaro_name, when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date), expected, received: null, method, issue: `${method} not yet confirmed.`, fix: "Verify it landed in your bank app, then tap Confirm paid.", action: (bankHref ? btnPink({ href: bankHref, label: bankLabel }) : "") + btnTeal({ href: confirmHref, label: "Confirm paid" }) });
    }
    for (const r of cats.unidentified) {
      items.push({ priority: 4, type: "Unidentified Slot", accent: T.unid, client: "Unidentified session", when: fmtShort(r.appt.date) + " · " + timeOf(r.appt.date), expected: null, received: null, method: null, issue: `Vagaro slot not mapped to a client — ${esc(r.appt.summary || "unknown")}.`, fix: "If it's a real client, add them to schedule.csv. Otherwise mark INACTIVE." });
    }
    for (const r of cats.unknown) {
      items.push({ priority: 5, type: "Unknown Client", accent: T.unid, client: r.appt.client_name || "Unknown", when: fmtShort(r.appt.date), expected: null, received: null, method: null, issue: "Booked under a name that isn't in clients.csv.", fix: "Add to clients.csv, or correct the Vagaro booking name." });
    }
    return items;
  }

  function actionCard({ priority, type, accent, client, when, expected, received, method, issue, fix, action }) {
    const delta = (expected != null && received != null) ? received - expected : null;
    const ledger = moneyLedger({ expected, received, delta, method, accent });
    let inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>`
      + `<td valign="top" width="34" style="padding-right:13px;">${priorityChip(priority, accent)}</td>`
      + `<td valign="top">`
        + `<div style="font-family:${FONT_BODY};font-size:10px;color:${accent};font-weight:800;letter-spacing:0.14em;text-transform:uppercase;">${esc(type)}</div>`
        + `<div style="font-family:${FONT_BODY};font-size:17px;color:${T.white};font-weight:700;margin-top:5px;line-height:1.1;">${esc(client)}</div>`
        + `<div style="font-family:${FONT_MONO};font-size:12px;color:${T.muted};margin-top:4px;">${esc(when)}</div>`
      + `</td>`
      + (ledger ? `<td valign="top" align="right" style="padding-left:12px;">${ledger}</td>` : "")
      + `</tr></table>`;
    if (issue || fix || action) {
      inner += `<div style="border-top:1px dashed ${T.hair};margin-top:13px;padding-top:11px;">`;
      if (issue) inner += `<div style="font-family:${FONT_BODY};font-size:13px;color:${T.body};line-height:1.5;">${micro("Why", T.muted)} &nbsp;${esc(issue)}</div>`;
      if (fix) inner += `<div style="font-family:${FONT_BODY};font-size:13px;color:${T.body};margin-top:6px;line-height:1.5;">${micro("The Move", T.action)} &nbsp;${esc(fix)}</div>`;
      if (action) inner += `<div style="margin-top:13px;">${action}</div>`;
      inner += `</div>`;
    }
    return card(inner, accent);
  }

  // ── ledger ("The Tape") ──
  function ledgerRow(r, zebra) {
    const time = timeOf(r.appt.date);
    let icon, iconColor, tag = "", tagColor = T.muted;
    switch (r.status) {
      case "PAID_VENMO": icon = "&#9989;"; iconColor = T.paid; if (r.inferred) tag = "rescheduled"; break;
      case "PAID_CASH": icon = "&#9989;"; iconColor = T.paid; tag = "cash"; break;
      case "PAID_PREPAID": icon = "&#9989;"; iconColor = T.paid; tag = "prepaid"; break;
      case "NEEDS_REVIEW": icon = "&#9203;"; iconColor = T.review; tag = `review · ${money(r.payment?.amount)}`; tagColor = T.review; break;
      case "CASH_PENDING": icon = "&#9203;"; iconColor = T.review; tag = "expected check/Zelle"; break;
      case "UNPAID": icon = "&#10060;"; iconColor = T.unpaid; tag = `${money(r.expectedPrice ?? r.roster?.default_price)} unpaid`; tagColor = T.unpaid; break;
      case "UNIDENTIFIED_SLOT": icon = "&#10067;"; iconColor = T.unid; tag = esc(r.appt.summary || "unknown"); break;
      case "UNKNOWN": icon = "&#10067;"; iconColor = T.unid; tag = "not in roster"; break;
      default: icon = "&bull;"; iconColor = T.body;
    }
    const name = r.roster?.vagaro_name || r.appt.client_name || "(unidentified)";
    const bg = zebra ? T.rowAlt : T.card;
    const cellBg = `bgcolor="${bg}" style="background-color:${bg};`;
    return `<tr>`
      + `<td valign="middle" width="30" align="center" ${cellBg}padding:8px 0 8px 10px;font-size:16px;color:${iconColor};line-height:1;">${icon}</td>`
      + `<td valign="middle" width="76" ${cellBg}padding:8px 0;font-family:${FONT_MONO};font-size:12px;color:${T.muted};white-space:nowrap;">${time}</td>`
      + `<td valign="middle" ${cellBg}padding:8px 0;font-family:${FONT_BODY};font-size:14px;font-weight:600;color:${T.body};">${esc(name)}</td>`
      + `<td valign="middle" align="right" ${cellBg}padding:8px 12px 8px 8px;font-family:${FONT_MONO};font-size:12px;color:${tagColor};white-space:nowrap;">${tag}</td>`
      + `</tr>`;
  }
  function ledger() {
    if (!results.length) return "";
    const byDay = new Map();
    for (const r of results) { const k = dayKey(r.appt.date); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
    let html = "";
    for (const k of [...byDay.keys()].sort()) {
      const rows = byDay.get(k).sort((a, b) => new Date(a.appt.date) - new Date(b.appt.date));
      const dayName = new Date(k + "T20:00:00Z").toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "numeric", day: "numeric" });
      const count = rows.length;
      html += `<div style="margin:16px 0 7px;">`
        + `<span style="font-family:${FONT_BODY};font-size:12px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${T.white};">${esc(dayName)}</span>`
        + `<span style="font-family:${FONT_MONO};font-size:11px;color:${T.dim};">&nbsp;&nbsp;${count} session${count === 1 ? "" : "s"}</span>`
        + `</div>`;
      html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.card}" style="background-color:${T.card};border:1px solid ${T.border};border-radius:8px;">${rows.map((r, i) => ledgerRow(r, i % 2 === 1)).join("")}</table>`;
    }
    return html;
  }

  function legendChip(icon, color, label) {
    return `<span style="font-family:${FONT_BODY};font-size:11px;color:${T.muted};white-space:nowrap;"><span style="color:${color};font-size:13px;">${icon}</span>&nbsp; ${label}</span>`;
  }

  // ── totals + status ──
  const paidCount = cats.paidVenmo.length + cats.paidCash.length + cats.paidPrepaid.length;
  const unpaidCount = cats.unpaid.length + cats.lagging.filter((r) => r.status === "UNPAID").length;
  const reviewCount = cats.review.length + cats.lagging.filter((r) => r.status === "NEEDS_REVIEW").length;
  const unidCount = cats.unidentified.length + cats.unknown.length;
  const actionsCount = cats.unpaid.length + cats.review.length + cats.cashPending.length + cats.lagging.length + cats.unidentified.length + cats.unknown.length;

  const venmoCollected = cats.paidVenmo.reduce((s, r) => s + (r.payment?.amount || 0), 0);
  const outstanding =
    [...cats.unpaid, ...cats.lagging.filter((r) => r.status === "UNPAID")].reduce((s, r) => s + (r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price ?? 0), 0)
    + [...cats.review, ...cats.lagging.filter((r) => r.status === "NEEDS_REVIEW")].reduce((s, r) => {
      const exp = r.checkoutAmount ?? r.expectedPrice ?? r.roster?.default_price ?? 0;
      const got = r.payment?.amount ?? 0;
      return s + Math.max(0, exp - got);
    }, 0);

  let level, verdict, nextMove;
  if (unpaidCount > 0) {
    level = "red";
    verdict = `${money(outstanding)} is still on the table. Go get it.`;
    nextMove = `${unpaidCount} unpaid${reviewCount ? `, ${reviewCount} to review` : ""} — fire the pink requests in The Chase List.`;
  } else if (reviewCount || cats.cashPending.length || unidCount) {
    level = "yellow";
    const loose = [];
    if (reviewCount) loose.push(`${reviewCount} mismatch${reviewCount === 1 ? "" : "es"}`);
    if (cats.cashPending.length) loose.push(`${cats.cashPending.length} payment${cats.cashPending.length === 1 ? "" : "s"} to verify`);
    if (unidCount) loose.push(`${unidCount} unidentified`);
    verdict = `Money's all in. ${loose.join(", ")} to clear, then you're done.`;
    nextMove = "Verify the external payments and eyeball the mismatches below.";
  } else {
    level = "green";
    verdict = `All square. ${money(venmoCollected)} in, nothing out.`;
    nextMove = "Run The Playbook to check this week's sessions out in Vagaro.";
  }
  const statusColor = level === "red" ? T.unpaid : level === "yellow" ? T.review : T.paid;

  const weekEnding = fmtDate(now);
  const subject = `Weekly billing — week ending ${weekEnding} — ${unpaidCount} unpaid, ${reviewCount} review`;
  const preheader = `${money(venmoCollected)} in · ${money(outstanding)} out · ${actionsCount} action item${actionsCount === 1 ? "" : "s"}`;

  // ── record strip (paid · unpaid · review · unidentified) ──
  const recPart = (n, label, color) =>
    `<span style="font-family:${FONT_MONO};font-size:13px;font-weight:700;color:${n > 0 ? color : T.dim};">${n}</span>`
    + `<span style="font-family:${FONT_BODY};font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:${n > 0 ? T.body : T.dim};">&nbsp;${label}</span>`;
  const recordStrip = [
    recPart(paidCount, "Paid", T.paid),
    recPart(unpaidCount, "Unpaid", T.unpaid),
    recPart(reviewCount, "Review", T.review),
    recPart(unidCount, "Unid", T.unid),
  ].join(`<span style="color:${T.dim};font-family:${FONT_MONO};">&nbsp;&nbsp;·&nbsp;&nbsp;</span>`);

  // ── big money number cell ──
  const moneyStat = (label, value, color, glow, alignRight) =>
    `<td width="50%" valign="top" style="padding:${alignRight ? "0 0 0 12px" : "0 12px 0 0"};">`
      + `<div style="${micro(label, T.muted, "0.18em") ? "" : ""}font-family:${FONT_BODY};font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:${T.muted};">${label}</div>`
      + `<div style="font-family:${FONT_MONO};font-size:58px;line-height:1.02;font-weight:800;color:${color};letter-spacing:-0.02em;margin-top:6px;${glow}">${value}</div>`
    + `</td>`;

  // ── body ──
  let body = "";

  // THE CHASE LIST (action queue)
  const actions = buildActionQueue();
  if (actions.length) {
    body += sectionLabel(`The Chase List — ${actions.length}`, T.action);
    for (const a of actions) body += actionCard(a);
  }

  // THE TAPE (ledger)
  body += sectionLabel("The Tape — Every Session This Week", T.teal);
  body += `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:4px;"><tr>`
    + `<td style="padding-right:16px;">${legendChip("&#9989;", T.paid, "paid")}</td>`
    + `<td style="padding-right:16px;">${legendChip("&#10060;", T.unpaid, "unpaid")}</td>`
    + `<td style="padding-right:16px;">${legendChip("&#9203;", T.review, "expected / review")}</td>`
    + `<td>${legendChip("&#10067;", T.unid, "unidentified")}</td>`
    + `</tr></table>`;
  body += ledger();

  // LOOSE ENDS (unmatched / unidentified)
  if (cats.unidentified.length || unmatchedPayments.length) {
    body += sectionLabel("Loose Ends", T.unid);
    if (cats.unidentified.length) {
      for (const r of cats.unidentified) {
        body += card(
          `<div style="font-family:${FONT_MONO};font-size:13px;color:${T.white};font-weight:700;">${fmtShort(r.appt.date)} · ${timeOf(r.appt.date)}</div>`
            + `<div style="font-family:${FONT_BODY};font-size:13px;color:${T.body};margin-top:5px;">${esc(r.appt.summary || "Unknown service")}</div>`
            + `<div style="font-family:${FONT_BODY};font-size:12px;color:${T.muted};margin-top:7px;line-height:1.5;">${micro("Suggested", T.unid)} &nbsp;Map this slot in schedule.csv, or mark INACTIVE.</div>`,
          T.unid,
        );
      }
    }
    if (unmatchedPayments.length) {
      body += `<div style="margin:10px 0 6px;">${micro(`Unmatched Venmo Payments — ${unmatchedPayments.length}`, T.muted)}</div>`;
      let list = "";
      unmatchedPayments.forEach((p, i) => {
        const bg = i % 2 === 1 ? T.rowAlt : T.card;
        list += `<tr><td bgcolor="${bg}" style="background-color:${bg};padding:8px 12px;font-family:${FONT_MONO};font-size:12px;color:${T.muted};">`
          + `<span style="color:${T.body};">${esc(p.sender_display_name)}</span> &middot; <span style="color:${T.white};font-weight:700;">${money(p.amount)}</span> &middot; ${fmtDate(p.date)} &middot; "${esc(p.note || "")}"`
          + `</td></tr>`;
      });
      body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.card}" style="background-color:${T.card};border:1px solid ${T.border};border-radius:8px;">${list}</table>`;
    }
  }

  // THE PLAYBOOK (Vagaro checkout — VERBATIM)
  if (checkoutPrompt) {
    body += sectionLabel("The Playbook — Vagaro Checkout", T.teal);
    body += `<div style="font-family:${FONT_BODY};font-size:12px;color:${T.muted};margin-bottom:8px;line-height:1.5;">Use this block exactly when checking out sessions in Vagaro. Triple-click inside, &#8984;A, &#8984;C, paste into a new Claude for Chrome session.</div>`;
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.panel}" style="background-color:${T.panel};border:1px solid ${T.border};border-radius:8px;">`;
    body += `<tr><td style="padding:9px 12px;border-bottom:1px dashed ${T.hair};">${micro("Copy-Paste Payload", T.teal)}</td></tr>`;
    body += `<tr><td style="padding:12px;">`;
    body += `<pre style="margin:0;font-family:${FONT_MONO};font-size:9px;line-height:1.45;color:${T.body};white-space:pre-wrap;overflow-x:auto;">${esc(checkoutPrompt)}</pre>`;
    body += `</td></tr></table>`;
  }

  // ── shell ──
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:${T.bg};font-family:${FONT_BODY};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${T.bg};opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${T.bg}" style="background-color:${T.bg};">
  <tr><td align="center" style="padding:22px 12px 40px;">
    <table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:720px;max-width:720px;">

      <!-- HERO -->
      <tr><td bgcolor="${T.heroBg}" style="background-color:${T.heroBg};border:1px solid ${T.border};border-radius:12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td height="5" style="height:5px;line-height:5px;font-size:0;${T.heroBarStyle}" bgcolor="${T.heroBarColor}">&nbsp;</td></tr>
          <tr><td style="padding:22px 26px 6px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td valign="middle">
                <span style="font-family:${FONT_BODY};font-size:15px;font-weight:800;color:${T.white};letter-spacing:0.02em;">YEAGER'S GYM</span>
                <span style="font-family:${FONT_BODY};font-size:11px;font-weight:800;letter-spacing:0.2em;text-transform:uppercase;color:${T.teal};">&nbsp;&nbsp;Weekly Billing Lab</span>
              </td>
              <td valign="middle" align="right">${statusPill(level)}</td>
            </tr></table>
          </td></tr>

          <!-- THE MONEY LINE -->
          <tr><td style="padding:14px 26px 4px;">
            <div style="margin-bottom:14px;">${micro("The Money Line · Week ending " + esc(weekEnding), T.muted, "0.16em")}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              ${moneyStat("Collected", money(venmoCollected), T.numIn, T.inGlow, false)}
              ${moneyStat("Outstanding", money(outstanding), outstanding > 0 ? T.numOut : T.dim, outstanding > 0 ? T.outGlow : "", true)}
            </tr></table>
            <div style="margin-top:16px;padding-top:14px;border-top:1px dashed ${T.hair};">${recordStrip}</div>
          </td></tr>

          <!-- THE CALL (verdict) -->
          <tr><td style="padding:16px 26px 24px;">
            <div style="border-left:3px solid ${statusColor};padding-left:14px;">
              <div style="${micro("", "", "") ? "" : ""}font-family:${FONT_BODY};font-size:10px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:${statusColor};">The Call</div>
              <div style="font-family:${FONT_BODY};font-size:22px;line-height:1.25;font-weight:800;color:${T.white};margin-top:8px;letter-spacing:0.01em;">${esc(verdict)}</div>
              <div style="font-family:${FONT_BODY};font-size:13px;line-height:1.5;color:${T.body};margin-top:9px;">${micro("Next Move", T.teal)} &nbsp;${esc(nextMove)}</div>
            </div>
          </td></tr>
        </table>
      </td></tr>

      <!-- BODY -->
      <tr><td>${body}</td></tr>

      <!-- FOOTER -->
      <tr><td style="padding:32px 4px 0;">
        <div style="border-top:1px solid ${T.border};padding-top:15px;">
          <div style="font-family:${FONT_MONO};font-size:11px;color:${T.dim};line-height:1.8;">
            Window ${esc(fmtDateIso(windowStart))} &#8594; ${esc(fmtDateIso(now))} &middot; log billing/logs/${esc(fmtDateIso(now))}.md
          </div>
          <div style="font-family:${FONT_BODY};font-size:11px;color:${T.dim};line-height:1.8;margin-top:3px;">
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
