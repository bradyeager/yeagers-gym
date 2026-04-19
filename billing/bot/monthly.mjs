#!/usr/bin/env node
// Monthly revenue summary for Yeager's Gym.
// Runs on the 1st of each month via GitHub Actions. Reads all weekly
// logs from the prior calendar month, tabulates revenue by source
// (Venmo vs. cash) and outstanding unpaid balance, and emails Brad
// via Brevo — useful context for the 1099-K / tax conversation.

import path from "node:path";
import {
  PALETTE, FONTS, GITHUB_OWNER, GITHUB_REPO,
  requireEnv, resolveRepoRoot, fmtMonth, fmtDateIso,
  readWeeklyLogs, sendBrevoEmail,
  emailShell, sectionLabel, card,
} from "./lib.mjs";

const {
  BREVO_API_KEY,
  RECIPIENT_EMAIL = "brad@yeagersgym.com",
  SENDER_EMAIL = "brad@yeagersgym.com",
  SENDER_NAME = "Yeager's Gym Billing Bot",
  DRY_RUN = "false",
  MONTH_OFFSET = "-1", // -1 = prior month, 0 = current
} = process.env;

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const LOGS_DIR = path.join(REPO_ROOT, "billing", "logs");

function monthWindow(offset) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + Number(offset);
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0) - 1);
  return { start, end };
}

export function totalsFromLogs(logs) {
  let sessions = 0;
  let venmo_revenue = 0;
  let cash_revenue = 0;
  let unpaid_outstanding = 0;
  let needs_review_count = 0;
  let unpaid_count = 0;
  let paid_venmo_count = 0;
  let paid_cash_count = 0;

  for (const { parsed } of logs) {
    for (const a of parsed.appointments) {
      sessions += 1;
      switch (a.status) {
        case "PAID_VENMO":
          paid_venmo_count += 1;
          venmo_revenue += a.paidAmount ?? a.price ?? 0;
          break;
        case "PAID_CASH":
          paid_cash_count += 1;
          cash_revenue += a.paidAmount ?? a.price ?? 0;
          break;
        case "UNPAID":
          unpaid_count += 1;
          unpaid_outstanding += a.price ?? 0;
          break;
        case "NEEDS_REVIEW":
          needs_review_count += 1;
          if (a.paidAmount) venmo_revenue += a.paidAmount;
          if (a.price && a.paidAmount && a.price > a.paidAmount) {
            unpaid_outstanding += a.price - a.paidAmount;
          }
          break;
      }
    }
  }

  const total_revenue = venmo_revenue + cash_revenue;
  const venmo_pct = total_revenue ? (venmo_revenue / total_revenue) * 100 : 0;
  const cash_pct = total_revenue ? (cash_revenue / total_revenue) * 100 : 0;

  return {
    sessions,
    venmo_revenue, cash_revenue, total_revenue,
    unpaid_outstanding,
    unpaid_count, needs_review_count, paid_venmo_count, paid_cash_count,
    venmo_pct, cash_pct,
  };
}

function money(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

export function buildEmail({ monthLabel, totals, weekCount, start, end }) {
  const subject = `Monthly billing summary — ${monthLabel} — ${money(totals.total_revenue)} revenue`;

  const stat = (value, label, color = "teal", big = false) => {
    const c = PALETTE[color] || PALETTE.teal;
    const valueSize = big ? "34px" : "26px";
    const labelSize = "11px";
    return `<div style="flex:1;min-width:140px;background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};border-top:3px solid ${c};border-radius:6px;padding:14px 16px;">
      <div style="font-family:${FONTS.display};font-size:${valueSize};font-weight:700;color:${c};line-height:1.1;">${value}</div>
      <div style="font-family:${FONTS.display};font-size:${labelSize};text-transform:uppercase;letter-spacing:0.15em;color:${PALETTE.textMuted};margin-top:8px;">${label}</div>
    </div>`;
  };

  let body = "";

  body += `<div style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:12px;">${monthLabel} · ${weekCount} weekly log${weekCount === 1 ? "" : "s"}</div>`;

  // Headline: total revenue
  body += `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;">`;
  body += stat(money(totals.total_revenue), "Total revenue", "teal", true);
  body += stat(String(totals.sessions), "Sessions", "teal");
  body += `</div>`;

  // Venmo vs. cash split
  body += sectionLabel("Revenue by source", "teal");
  body += `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;">`;
  body += stat(money(totals.venmo_revenue), `Venmo · ${totals.venmo_pct.toFixed(0)}%`, "teal");
  body += stat(money(totals.cash_revenue), `Cash · ${totals.cash_pct.toFixed(0)}%`, "purple");
  body += `</div>`;

  // Tax note
  if (totals.venmo_revenue > 0) {
    body += card(
      `<div style="color:${PALETTE.textPrimary};font-family:${FONTS.body};font-size:14px;line-height:1.6;">
        <strong style="color:${PALETTE.teal};">Venmo total (reported to IRS on 1099-K):</strong> ${money(totals.venmo_revenue)}<br>
        <span style="color:${PALETTE.textMuted};">Keep cash receipts organized separately — not on Venmo's 1099-K but still taxable income.</span>
      </div>`,
      "teal",
    );
  }

  // Outstanding
  if (totals.unpaid_outstanding > 0) {
    body += sectionLabel("Outstanding", "pink");
    body += card(
      `<div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div>
          <div style="font-family:${FONTS.display};font-size:28px;color:${PALETTE.pink};font-weight:700;">${money(totals.unpaid_outstanding)}</div>
          <div style="color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;">Unpaid + short</div>
        </div>
        <div style="text-align:right;color:${PALETTE.textMuted};font-family:${FONTS.display};font-size:12px;">
          ${totals.unpaid_count} unpaid · ${totals.needs_review_count} review
        </div>
      </div>
      <div style="color:${PALETTE.textMuted};font-size:13px;margin-top:12px;">Chase via Friday emails or write off.</div>`,
      "pink",
    );
  }

  // Activity breakdown
  body += sectionLabel("Session breakdown", "teal");
  body += `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:20px;">`;
  body += stat(String(totals.paid_venmo_count), "Paid (Venmo)", "teal");
  body += stat(String(totals.paid_cash_count), "Paid (cash)", "purple");
  body += stat(String(totals.unpaid_count), "Unpaid", totals.unpaid_count ? "pink" : "textMuted");
  body += stat(String(totals.needs_review_count), "Needs review", totals.needs_review_count ? "purple" : "textMuted");
  body += `</div>`;

  const footer = `Window: ${fmtDateIso(start)} → ${fmtDateIso(end)} · ${weekCount} weekly log${weekCount === 1 ? "" : "s"} aggregated · Data source: billing/logs/`;
  const html = emailShell({ title: `${monthLabel} — Monthly Summary`, bodyHtml: body, footerNote: footer });
  return { subject, html };
}

async function main() {
  requireEnv("BREVO_API_KEY", BREVO_API_KEY);
  const { start, end } = monthWindow(Number(MONTH_OFFSET));
  const monthLabel = fmtMonth(start);
  console.log(`Month window: ${start.toISOString()} → ${end.toISOString()} (${monthLabel})`);

  const logs = await readWeeklyLogs(LOGS_DIR, { start, end });
  console.log(`Loaded ${logs.length} weekly logs for ${monthLabel}`);

  if (logs.length === 0) {
    console.log("No logs found in window; skipping email.");
    return;
  }

  const totals = totalsFromLogs(logs);
  const { subject, html } = buildEmail({ monthLabel, totals, weekCount: logs.length, start, end });

  await sendBrevoEmail({
    apiKey: BREVO_API_KEY,
    to: RECIPIENT_EMAIL,
    from: SENDER_EMAIL,
    fromName: SENDER_NAME,
    subject,
    html,
    dryRun: DRY_RUN === "true",
  });
  console.log(`Sent email: ${subject}`);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) main().catch(async (err) => {
  console.error("Monthly summary failed:", err);
  if (DRY_RUN !== "true" && BREVO_API_KEY) {
    try {
      await sendBrevoEmail({
        apiKey: BREVO_API_KEY, to: RECIPIENT_EMAIL, from: SENDER_EMAIL, fromName: SENDER_NAME,
        subject: "Monthly summary — FAILED",
        html: emailShell({
          title: "Monthly summary run failed",
          bodyHtml: `<pre style="background:${PALETTE.bgPanel};border:1px solid ${PALETTE.border};padding:12px;border-radius:6px;color:${PALETTE.textPrimary};font-family:${FONTS.display};font-size:12px;">${String(err.stack || err).slice(0, 2000)}</pre><div style="color:${PALETTE.textMuted};margin-top:16px;">Check Actions logs: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/actions</div>`,
        }),
      });
    } catch (_) { /* ignore */ }
  }
  process.exit(1);
});
