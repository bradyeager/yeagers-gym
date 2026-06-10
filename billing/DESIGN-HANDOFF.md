# Yeager's Gym — Weekly Billing Email · Design Brief

**Permission to be bold is granted. Don't ask for it again.**

The last designer who saw this brief produced a refinement of what already exists. That's a failure. I'm not paying you to polish a draft — I'm paying you to reinvent the artifact. Break conventions. Make me feel something.

---

## Who I am

Brad Yeager. I run Yeager's Gym in San Diego — a strength + velocity-based training studio for competitive lifters, CrossFit/Hyrox athletes, and people who want their training measured. Tagline: **"Coached by Data. Built on Strength."**

I'm a coach, not a designer. I built a billing bot because tracking 30+ clients across Venmo, cash, Zelle, and a couple of prepaid annuals was eating my Sundays.

The email that lands every Friday at 10 AM Pacific is my command deck for the week.

---

## The moment

Friday. 10 AM. I've just finished my own training. Coffee in one hand, phone in the other. The email lands.

In sixty seconds I need to know:

- Did anyone not pay?
- Did anyone pay weird?
- Is anyone's check or Zelle still in flight?
- Did I miss matching a payment somewhere?
- How much did I bring in?

If I can act on it right then from my phone, even better — there are tap-to-request-money links built in today.

Then I copy a block of text out of the email, paste it into Claude for Chrome, and my browser AI marks every session paid in Vagaro for me. That block must arrive untouched.

That's the workflow. That's the email's job.

---

## Color scheme

Teal `#48C4CC` and pink `#EF3295`. **That's it.**

Dark background, neutral text, teal as the carrier, pink as the alarm. If you can earn another accent color, prove it. If you can do it with just those two — better.

---

## What the email must convey

For the week just ended:

- **Money in** — Venmo collected, total
- **Money out (still)** — outstanding, total
- **The roster** — every session that ran, by day, with its payment state
- **The action list** — who owes, who's mismatched, whose check/Zelle hasn't landed, what unidentified slots showed up, in priority order
- **A read on the week** — am I square, am I doing eyeball work, am I chasing money
- **Tap-to-act controls** on each action — Venmo request, bank-app verify, mark-as-paid
- **Unmatched Venmo payments** — money came in but no session attached to it

Express this however you want. Cards, lists, dashboards, dataviz, narrative, editorial, infographic. **You decide.**

---

## The one untouchable

The bottom of the email contains a ~150-line plain-text block — a prompt my browser AI consumes to mark sessions paid in Vagaro. It must appear in the email **byte-for-byte identical** to what the bot generates. Style the container however you want. Don't touch the contents.

That's the only content rule. Everything else is yours.

---

## What I will recognize as a failure

- Stat tiles in a row across the top
- "Hello Brad, here is your weekly summary"
- "Don't forget to follow up!" energy
- Generic SaaS dashboard chrome
- Anything that could've come out of Mailchimp
- A refinement of what already exists

---

## What you'd be replacing

Current template: https://github.com/bradyeager/yeagers-gym/blob/main/billing/bot/email-v2.mjs
Current render: https://htmlpreview.github.io/?https://github.com/bradyeager/yeagers-gym/blob/main/billing/preview/weekly-v2.html

Read them so you know what to outshine. Then leave them behind.

---

## The data you have to work with

```
results: array of {
  status:  PAID_VENMO | PAID_CASH | PAID_PREPAID |
           CASH_PENDING | UNPAID | NEEDS_REVIEW |
           UNKNOWN | UNIDENTIFIED_SLOT
  appt:    { date, summary, client_name }
  roster:  { name, default_price, payment-method hints, ... }
  payment: { sender, amount, note, date }  // if matched
  expectedPrice, checkoutAmount
  inferred                                 // true if it was a reschedule
}
unmatchedPayments: standalone Venmo payments with no session
now, windowStart:  dates
checkoutPrompt:    the verbatim text block
```

Typical Friday: ~30 sessions, $1,500 collected, 1-3 action items. Most weeks I'm green. The interesting weeks have action.

To iterate: edit `billing/bot/email-v2.mjs`, run `node billing/bot/preview.mjs`, view the regenerated `billing/preview/weekly-v2.html`.

It does need to actually render as an email when it hits my inbox — that's the only technical reality. Gmail and iOS Mail are where I read it. How you achieve that is your problem to solve. Surprise me with the answer.

---

## What I want from you

Pitch me **the idea** before you render it. One paragraph. What's the concept, what's the visual move, what's the emotional register. Then build it.

Don't show me three options. Show me the one you believe in.

Don't ask permission to be bold.
