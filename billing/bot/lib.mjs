// Shared utilities for the billing bot (weekly + monthly scripts).
// Keep this file free of side effects at import time so both scripts can reuse.

import fs from "node:fs/promises";
import path from "node:path";

// ---- GitHub repo context (for prefilled new-file URLs) ----

export const GITHUB_OWNER = process.env.GITHUB_OWNER || "bradyeager";
export const GITHUB_REPO = process.env.GITHUB_REPO || "yeagers-gym";
export const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";

// ---- YG colorway (CLAUDE.md) ----

export const PALETTE = {
  bg: "#0a0a0a",
  bgPanel: "#141414",
  bgSoft: "#1a1a1a",
  border: "#2a2a2a",
  textPrimary: "#eaeaea",
  textMuted: "#9a9a9a",
  textDim: "#6a6a6a",
  teal: "#1EC8B0",
  pink: "#F0448A",
  purple: "#9B6FD4",
  danger: "#ff6b6b",
  success: "#1EC8B0",
};

// Email-safe font stacks (most clients ignore @font-face).
export const FONTS = {
  display: `ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`,
  body: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", sans-serif`,
};

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

export async function loadClients(csvPath) {
  const raw = await fs.readFile(csvPath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const header = lines.shift();
  if (!header || !header.startsWith("vagaro_name,")) {
    throw new Error(`Unexpected clients.csv header: ${header}`);
  }
  return lines.map((line) => {
    const cells = parseCsvLine(line);
    return {
      vagaro_name: cells[0],
      venmo_handle: cells[1] || "",
      venmo_display_name: cells[2] || "",
      default_price: cells[3] ? Number(cells[3]) : null,
      pays_cash: (cells[4] || "").toLowerCase() === "true",
      notes: cells[5] || "",
    };
  });
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
  const aParts = na.split(/\s+/);
  const bParts = nb.split(/\s+/);
  if (aParts[0] === bParts[0]) {
    const aLast = aParts[aParts.length - 1];
    const bLast = bParts[bParts.length - 1];
    if (aLast === bLast) return 1;
    if (aLast[0] === bLast[0]) return 0.8;
    return 0.6;
  }
  return 0;
}

// ---- Date formatting ----

export function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
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

export function emailShell({ title, bodyHtml, footerNote = "" }) {
  const P = PALETTE;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background:${P.bg};color:${P.textPrimary};font-family:${FONTS.body};">
  <div style="max-width:640px;margin:0 auto;padding:24px 20px;">
    <div style="border-bottom:1px solid ${P.border};padding-bottom:16px;margin-bottom:24px;">
      <div style="font-family:${FONTS.display};color:${P.teal};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:6px;">Yeager's Gym — Billing</div>
      <h1 style="margin:0;font-family:${FONTS.body};font-size:22px;font-weight:600;color:${P.textPrimary};">${title}</h1>
    </div>
    ${bodyHtml}
    ${footerNote ? `<div style="margin-top:32px;padding-top:16px;border-top:1px solid ${P.border};font-family:${FONTS.display};font-size:11px;color:${P.textDim};">${footerNote}</div>` : ""}
  </div>
</body></html>`;
}

export function sectionLabel(text, color = "teal") {
  const c = PALETTE[color] || PALETTE.teal;
  return `<div style="font-family:${FONTS.display};color:${c};font-size:11px;letter-spacing:0.15em;text-transform:uppercase;margin:28px 0 10px 0;">${text}</div>`;
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
  // Pull appointment lines like:
  // "- 2026-04-14 | Alice Chen | $100 | PAID_VENMO (matched @alice-chen-2021, $100)"
  const out = { appointments: [] };
  for (const line of md.split("\n")) {
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+?)\s*\|\s*\$?([\d.?]+|\?)\s*\|\s*(\w+)/);
    if (!m) continue;
    const amountMatch = line.match(/\$(\d+(?:\.\d+)?)\)/);
    out.appointments.push({
      date: m[1],
      name: m[2].trim(),
      price: m[3] === "?" ? null : Number(m[3]),
      status: m[4],
      paidAmount: amountMatch ? Number(amountMatch[1]) : null,
    });
  }
  return out;
}
