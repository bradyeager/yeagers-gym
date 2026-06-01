// Command Center email template (v2) — LIVE.
//
// As of this change, the `command-center` template renders "THE MONEY LINE"
// in its Miami-neon theme (Brad's pick). This file is now a thin drop-in
// wrapper so every existing call site keeps working unchanged:
//   • billing/bot/preview.mjs  → import { buildEmailV2 } from "./email-v2.mjs"
//   • the weekly job (EMAIL_STYLE=command-center) → same import
//
// The actual builder lives in ./email-moneyline.mjs (themeable: "miami" | "brand").
// Same data contract and return shape as before:
//   buildEmailV2({ results, unmatchedPayments, now, windowStart, checkoutPrompt })
//     → { subject, html, preheader }
//
// To switch skins later, change LIVE_THEME (or pass `theme` through).

import { buildMoneyLine } from "./email-moneyline.mjs";

const LIVE_THEME = "miami"; // "miami" (live) | "brand"

export function buildEmailV2(args) {
  return buildMoneyLine({ ...args, theme: args?.theme || LIVE_THEME });
}

// Re-export for any importer that referenced these directly.
export { buildMoneyLine };
