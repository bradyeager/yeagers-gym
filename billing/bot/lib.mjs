// Shared utilities for the billing bot (weekly + monthly scripts).
// Keep this file free of side effects at import time so both scripts can reuse.

import fs from "node:fs/promises";
import path from "node:path";

// ---- GitHub repo context (for prefilled new-file URLs) ----

export const GITHUB_OWNER = process.env.GITHUB_OWNER || "bradyeager";
export const GITHUB_REPO = process.env.GITHUB_REPO || "yeagers-gym";
export const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";

// ---- YG colorway (canonical per YG-Brand-Style-Reference.md §2) ----
// Teal is dominant (structure/data/trust). Pink is action/urgency ONLY.
// Purple is a sparing accent. Max 2 brand colors per view + neutrals.
export const PALETTE = {
  bg: "#0A0E17",          // dark base
  bgPanel: "#0F1420",     // surface 1 (cards)
  bgSoft: "#151B2A",      // surface 2 (nested)
  surface3: "#1A2235",    // surface 3 (hover)
  border: "rgba(255,255,255,0.12)",
  divider: "rgba(255,255,255,0.08)",
  textPrimary: "#E8E6E3",
  textMuted: "#8A8D93",
  textDim: "#4A4D55",
  teal: "#48C4CC",
  tealHover: "#35ADB5",
  pink: "#EF3295",
  pinkHover: "#D42582",
  purple: "#9B6FD4",
  danger: "#EF3295",      // pink = warnings per brand
  success: "#48C4CC",
};

// Email-safe fonts (brand ref §3/§9): data + headings = monospace
// (JetBrains Mono → Courier New fallback since email can't @font-face),
// Single clean sans throughout (renders natively on every device: SF on
// Apple, Segoe on Windows, Roboto on Android; falls back to Helvetica/Arial).
// Brad disliked the monospace look, so display + body share this stack.
export const FONTS = {
  display: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
  body: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`,
};

// Logo shown in the email hero. Served via GitHub Pages from the repo's
// assets/ folder. Drop a dark-background PNG at this path to override.
// If the image is missing/blocked, the alt text + wordmark still render.
export const LOGO_URL = "https://bradyeager.github.io/yeagers-gym/assets/yg-logo-email.png";

// ---- Env helpers ----

export function requireEnv(name, val) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

// ---- Paths ----

export function resolveRepoRoot(fileUrl) {
  return path.resolve(path.dirname(new URL(fileUrl).pathname), "..", "..");
}

// ---- CSV + roster ----

export function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === "," && !inQuotes) {
      cells.push(cur); cur = "";
    } else { cur += c; }
  }
  cells.push(cur);
  return cells;
}

// Header-driven parser: column order doesn't matter, missing columns are fine.
// Recognized columns: vagaro_name, venmo_handle, venmo_display_name,
// default_price, valid_prices, pays_cash, prepaid, notes.
// valid_prices is a SLASH-separated list (e.g. "70/100") of all acceptable
// amounts for a client whose price legitimately varies (couple solo vs together,
// group vs alone). Comma can't be used — it's the CSV delimiter.
export async function loadClients(csvPath) {
  const raw = await fs.readFile(csvPath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const header = lines.shift();
  if (!header || !header.toLowerCase().startsWith("vagaro_name,")) {
    throw new Error(`Unexpected clients.csv header: ${header}`);
  }
  const cols = parseCsvLine(header).map((c) => c.trim().toLowerCase());
  const idx = (name) => cols.indexOf(name);
  const iName = idx("vagaro_name");
  const iHandle = idx("venmo_handle");
  const iDisplay = idx("venmo_display_name");
  const iDefault = idx("default_price");
  const iValid = idx("valid_prices");
  const iCash = idx("pays_cash");
  const iPrepaid = idx("prepaid");
  const iNotes = idx("notes");
  const at = (cells, i) => (i >= 0 && i < cells.length ? cells[i] : "");

  return lines.map((line) => {
    const cells = parseCsvLine(line);
    const displayRaw = at(cells, iDisplay) || "";
    const defaultPrice = at(cells, iDefault) ? Number(at(cells, iDefault)) : null;
    const validRaw = at(cells, iValid) || "";
    const validPrices = validRaw
      ? validRaw.split("/").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n))
      : [];
    // Acceptable prices always include default + any explicit valid_prices.
    const acceptablePrices = [...new Set([defaultPrice, ...validPrices].filter((n) => n != null))];
    return {
      vagaro_name: at(cells, iName),
      venmo_handle: at(cells, iHandle) || "",
      venmo_display_name: displayRaw,
      venmo_display_names: displayRaw
        ? displayRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      default_price: defaultPrice,
      valid_prices: validPrices,
      acceptable_prices: acceptablePrices,
      pays_cash: (at(cells, iCash) || "").toLowerCase() === "true",
      prepaid: (at(cells, iPrepaid) || "").toLowerCase() === "true",
      notes: at(cells, iNotes) || "",
    };
  });
}

// Pull a M/D (optionally M/D/YY) date out of a free-text Venmo note.
// Handles "5/19", "5/19/26", "5.19", "5-19", "May 19", "May 19, 2026".
// Returns a Date (UTC noon to dodge tz edges) or null. refYear seeds the
// year when the note omits it.
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
export function parseNoteDate(note, refYear) {
  if (!note) return null;
  const text = String(note);
  // Numeric: M/D, M/D/YY, M/D/YYYY, M.D, M-D
  let m = text.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/);
  if (m) {
    const mo = Number(m[1]) - 1, d = Number(m[2]);
    let y = m[3] ? Number(m[3]) : refYear;
    if (y < 100) y += 2000;
    if (mo >= 0 && mo <= 11 && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo, d, 12));
  }
  // Month name: "May 19", "May 19, 2026"
  m = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?\b/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = Number(m[2]);
    const y = m[3] ? Number(m[3]) : refYear;
    if (mo != null && d >= 1 && d <= 31) return new Date(Date.UTC(y, mo, d, 12));
  }
  return null;
}

// ---- Weekly schedule (day+time → client_name) ----

const DAY_ALIASES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

export async function loadSchedule(csvPath) {
  let raw;
  try {
    raw = await fs.readFile(csvPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const header = lines.shift();
  if (!header || !header.toLowerCase().startsWith("day,")) {
    throw new Error(`Unexpected schedule.csv header: ${header}`);
  }
  // Detect schema: legacy 4-col (day,time,client,notes) or new 5-col with price_override
  const headerCells = parseCsvLine(header);
  const hasPriceOverride = headerCells[3]?.trim().toLowerCase() === "price_override";
  const notesIdx = hasPriceOverride ? 4 : 3;
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    const dayNum = DAY_ALIASES[(cells[0] || "").trim().toLowerCase()];
    const priceRaw = hasPriceOverride ? (cells[3] || "").trim() : "";
    return {
      day_of_week: dayNum,
      time: (cells[1] || "").trim(),
      client_name: (cells[2] || "").trim(),
      price_override: priceRaw ? Number(priceRaw) : null,
      notes: (cells[notesIdx] || "").trim(),
    };
  }).filter((s) => s.day_of_week != null && s.time && s.client_name);
}

// Given a date and the schedule, return the list of schedule entries
// (active only; INACTIVE markers excluded) matching the Pacific-time slot.
export function findScheduleEntriesForSlot(schedule, date, tz = "America/Los_Angeles") {
  const local = localParts(date, tz);
  return schedule
    .filter((s) => s.day_of_week === local.dayNum && s.time === local.hhmm)
    .filter((s) => s.client_name.toUpperCase() !== "INACTIVE");
}

export function findClientsForSlot(schedule, date, tz = "America/Los_Angeles") {
  return findScheduleEntriesForSlot(schedule, date, tz).map((s) => s.client_name);
}

// True if the schedule has any INACTIVE marker at this day+time.
// Used to suppress entire slots from the UNIDENTIFIED bucket.
export function isInactiveSlot(schedule, date, tz = "America/Los_Angeles") {
  const local = localParts(date, tz);
  return schedule.some(
    (s) =>
      s.day_of_week === local.dayNum &&
      s.time === local.hhmm &&
      s.client_name.toUpperCase() === "INACTIVE",
  );
}

function localParts(date, tz) {
  // Use Intl to get day-of-week + HH:MM in the target tz.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour12: false, hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const dayNum = DAY_ALIASES[parts.weekday?.toLowerCase()] ?? -1;
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return { dayNum, hhmm: `${hh}:${parts.minute}` };
}

// ---- Cash entries (aggregates cash-log.md + cash-entries/ dir) ----

export async function loadCashEntries(repoRoot) {
  const entries = [];
  const cashLogPath = path.join(repoRoot, "billing", "cash-log.md");
  try {
    const raw = await fs.readFile(cashLogPath, "utf8");
    for (const line of raw.split("\n")) {
      const parsed = parseCashLine(line);
      if (parsed) entries.push({ ...parsed, source: "cash-log.md" });
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  const dirPath = path.join(repoRoot, "billing", "cash-entries");
  try {
    const files = await fs.readdir(dirPath);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const raw = await fs.readFile(path.join(dirPath, f), "utf8");
      for (const line of raw.split("\n")) {
        const parsed = parseCashLine(line);
        if (parsed) entries.push({ ...parsed, source: `cash-entries/${f}` });
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return entries;
}

function parseCashLine(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*\$?([\d.]+)(?:\s*\|\s*(.*))?/);
  if (!m) return null;
  return { date: m[1], name: m[2].trim(), amount: Number(m[3]), notes: (m[4] || "").trim() };
}

// ---- Matching helpers ----

export function fuzzyName(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const nb = b.toLowerCase().replace(/[^a-z ]/g, "").trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Prefix match handles business names: "Mudroom" matches "Mudroom Backpacks"
  if (na.startsWith(nb + " ") || nb.startsWith(na + " ")) return 0.9;

  const aParts = na.split(/\s+/);
  const bParts = nb.split(/\s+/);
  const aFirst = aParts[0], bFirst = bParts[0];
  const aLast = aParts[aParts.length - 1];
  const bLast = bParts[bParts.length - 1];

  if (aFirst === bFirst) {
    if (aLast === bLast) return 1;
    if (aLast[0] === bLast[0]) return 0.8;
    return 0.6;
  }

  // Nickname / alt spelling tolerance: same last name + similar first
  // ("Laci James" / "Lacey James", "katie lowther" / "Katelin Lowther")
  if (aLast && bLast && aLast === bLast) {
    if (aFirst.slice(0, 3) === bFirst.slice(0, 3)) return 0.9;
    if (aFirst.startsWith(bFirst) || bFirst.startsWith(aFirst)) return 0.9;
  }

  return 0;
}

// ---- Date formatting ----

export function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
}

export function fmtDateTime(d, tz = "America/Los_Angeles") {
  return new Date(d).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

export function fmtDateIso(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function fmtMonth(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function slugify(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Retry an async fn with exponential backoff. For flaky external calls
// (Vagaro iCal 403s, Gmail/Google transient 5xx). Throws the last error
// after `tries` attempts.
export async function withRetry(fn, { tries = 3, baseMs = 1500, label = "op" } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries) {
        const wait = baseMs * 2 ** (i - 1);
        console.log(`${label}: attempt ${i}/${tries} failed (${err.message || err}); retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

// ---- Deep links / URLs ----

export function venmoRequestLink(handle, amount, note) {
  if (!handle) return "";
  const params = new URLSearchParams({
    txn: "charge",
    recipients: handle,
    amount: String(amount),
    note: note || "",
  });
  return `https://account.venmo.com/pay?${params.toString()}`;
}

export function githubNewFileUrl({ filename, value, message = "" }) {
  const base = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/new/${DEFAULT_BRANCH}`;
  const params = new URLSearchParams({ filename, value });
  if (message) params.set("message", message);
  return `${base}?${params.toString()}`;
}

// ---- Brevo email ----

export async function sendBrevoEmail({ apiKey, to, from, fromName, subject, html, dryRun = false }) {
  if (dryRun) {
    console.log("DRY_RUN — would have sent email:");
    console.log("Subject:", subject);
    console.log(html);
    return;
  }
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: fromName, email: from },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Brevo send failed: ${resp.status} ${body}`);
  }
}

// ---- YG email building blocks ----

// Neon sunset — the YG signature gradient (teal → purple → pink).
// The one place all three brand colors appear together; treated as a single
// decorative "neon sign" flourish (per the Velocity Method logo aesthetic).
export const NEON_GRADIENT = "linear-gradient(90deg, #48C4CC 0%, #9B6FD4 50%, #EF3295 100%)";

export function emailShell({ title, bodyHtml, footerNote = "", subtitle = "Weekly Revenue Transmission" }) {
  const P = PALETTE;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:${P.bg};background-image:radial-gradient(1100px 460px at 82% -10%, rgba(239,50,149,0.10), transparent 60%),radial-gradient(900px 420px at -8% 0%, rgba(72,196,204,0.12), transparent 55%);color:${P.textPrimary};font-family:${FONTS.body};-webkit-font-smoothing:antialiased;">
  <div style="max-width:640px;margin:0 auto;padding:22px 18px 40px;">

    <!-- HERO -->
    <div style="border-radius:16px;overflow:hidden;border:1px solid ${P.border};background:linear-gradient(150deg,${P.bgPanel} 0%,${P.bgSoft} 55%,#1c1330 100%);box-shadow:0 0 30px rgba(72,196,204,0.12),0 18px 50px -22px rgba(239,50,149,0.40);">
      <div style="height:5px;background:${NEON_GRADIENT};"></div>
      <div style="padding:26px 24px 22px;">
        <div style="font-family:${FONTS.display};font-size:34px;line-height:1;font-weight:800;color:#FFFFFF;letter-spacing:0.01em;">YEAGER'S GYM</div>
        <div style="font-family:${FONTS.display};font-size:13px;color:${P.teal};font-weight:600;letter-spacing:0.04em;margin-top:9px;">${subtitle}</div>
        <div style="font-family:${FONTS.display};font-size:12px;color:${P.textMuted};margin-top:5px;">${title}</div>
      </div>
    </div>

    <div style="margin-top:22px;">
      ${bodyHtml}
    </div>

    <div style="margin-top:34px;border-top:1px solid ${P.border};padding-top:14px;">
      <div style="height:3px;width:100%;background:${NEON_GRADIENT};opacity:0.55;border-radius:2px;margin-bottom:12px;"></div>
      <div style="font-family:${FONTS.display};font-size:10px;color:${P.textDim};letter-spacing:0.14em;">${footerNote || ""}</div>
      <div style="font-family:${FONTS.display};font-size:10px;color:${P.textMuted};letter-spacing:0.16em;margin-top:8px;">YEAGER'S GYM &#183; San Diego, CA &#183; brad@yeagersgym.com</div>
      <div style="font-family:${FONTS.display};font-size:10px;color:${P.textDim};letter-spacing:0.14em;margin-top:4px;">// end transmission &#183; automated by the YG billing engine</div>
    </div>
  </div>
</body></html>`;
}

export function sectionLabel(text, color = "teal") {
  const c = PALETTE[color] || PALETTE.teal;
  // Neon "spine" bar + uppercase mono label — HUD section header.
  return `<div style="margin:30px 0 12px 0;">`
    + `<span style="display:inline-block;width:18px;height:3px;background:${c};border-radius:2px;box-shadow:0 0 8px ${c};vertical-align:middle;margin-right:10px;"></span>`
    + `<span style="font-family:${FONTS.display};color:${c};font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;vertical-align:middle;">${text}</span>`
    + `</div>`;
}

export function button({ href, label, color = "pink", size = "md" }) {
  const c = PALETTE[color] || PALETTE.pink;
  const pad = size === "sm" ? "6px 12px" : "10px 18px";
  const fs = size === "sm" ? "12px" : "14px";
  return `<a href="${href}" style="display:inline-block;padding:${pad};background:${c};color:#0a0a0a;text-decoration:none;border-radius:6px;font-family:${FONTS.display};font-size:${fs};font-weight:600;margin:4px 6px 4px 0;letter-spacing:0.02em;">${label}</a>`;
}

export function buttonOutline({ href, label, color = "teal", size = "sm" }) {
  const c = PALETTE[color] || PALETTE.teal;
  const pad = size === "sm" ? "5px 11px" : "8px 16px";
  const fs = size === "sm" ? "12px" : "14px";
  return `<a href="${href}" style="display:inline-block;padding:${pad};background:transparent;color:${c};text-decoration:none;border:1px solid ${c};border-radius:6px;font-family:${FONTS.display};font-size:${fs};font-weight:600;margin:4px 6px 4px 0;letter-spacing:0.02em;">${label}</a>`;
}

export function card(innerHtml, accent = "border") {
  const P = PALETTE;
  const borderColor = P[accent] || P.border;
  return `<div style="background:${P.bgPanel};border:1px solid ${borderColor};border-left:3px solid ${borderColor};border-radius:6px;padding:14px 16px;margin-bottom:10px;">${innerHtml}</div>`;
}

export function kv(label, value, valueColor = PALETTE.textPrimary) {
  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid ${PALETTE.border};"><span style="font-family:${FONTS.display};color:${PALETTE.textMuted};font-size:12px;text-transform:uppercase;letter-spacing:0.1em;">${label}</span><span style="color:${valueColor};font-weight:600;">${value}</span></div>`;
}

// ---- Log parsing (for monthly summary) ----

export async function readWeeklyLogs(logsDir, { start, end }) {
  let files;
  try {
    files = await fs.readdir(logsDir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const logDate = new Date(m[1] + "T12:00:00Z");
    if (logDate < start || logDate > end) continue;
    const raw = await fs.readFile(path.join(logsDir, f), "utf8");
    out.push({ date: m[1], parsed: parseWeeklyLog(raw) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function parseWeeklyLog(md) {
  // Appointment lines look like (pipe-delimited):
  //   - Mon, 5/25, 6:00 AM | Jacob Bain | $70 | PAID_VENMO (matched "Jacob Bain", $70, note: "5/21")
  //   - Tue, 5/26, 8:00 AM | Annie Deioma | $80 | PAID_VENMO (matched "Mudroom", $80, note: "...")
  // We split on "|" rather than one mega-regex so the format can drift a bit
  // without silently parsing zero rows (which would zero out the monthly total).
  const out = { appointments: [] };
  for (const raw of md.split("\n")) {
    if (!raw.startsWith("- ")) continue;
    const parts = raw.slice(2).split("|");
    if (parts.length < 4) continue;
    const dateStr = parts[0].trim();
    const name = parts[1].trim();
    const priceTok = (parts[2].match(/[\d.]+/) || [])[0];
    const rest = parts.slice(3).join("|").trim();
    const status = (rest.match(/^([A-Z_]+)/) || [])[1] || "";
    if (!status) continue;
    // Amount actually received = first "$N" after the word "matched".
    const paidM = rest.match(/matched[^$]*\$(\d+(?:\.\d+)?)/);
    out.appointments.push({
      date: dateStr,                                   // human string; used only as a dedup key
      name,
      price: priceTok ? Number(priceTok) : null,
      status,
      paidAmount: paidM ? Number(paidM[1]) : null,
    });
  }
  return out;
}
