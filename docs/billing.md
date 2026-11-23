# Prepaid credits ("car-wash billing")

Status: implemented behind a flag (`--context billing=true`). Off by default, so a plain
deploy behaves exactly like upstream.

## Model

Put money in, get answers out. No subscription, no invoice after the fact.

1. A new account gets a small free starting credit (`billingFreeCreditCents`, default 50).
2. The header shows the balance. "Top up" opens Stripe Checkout for a fixed amount
   (default €5 / €10 / €20).
3. Each question **reserves** up to `billingHoldCents` (default €1.00) from the balance
   before the agent runs, then **settles** to the actual metered cost when the stream ends
   and refunds the rest. The answer shows what it cost.
4. At zero the question is refused with HTTP 402 and the UI offers a top-up.

## User stories

| # | Story | Acceptance criteria |
|---|---|---|
| B1 | As a visitor I can see my balance | `GET /api/billing` returns balance, currency, top-up amounts and prices; first read grants the free credit exactly once |
| B2 | As a user I can top up | `POST /api/billing/checkout {amountCents}` accepts only configured amounts and returns a Stripe Checkout URL bound to my user id |
| B3 | Payments credit exactly once | `POST /api/billing/webhook` verifies the Stripe signature, credits the **net** amount (`amount_subtotal`, i.e. excluding tax) on `checkout.session.completed` (when paid) and `checkout.session.async_payment_succeeded`; a replayed event never double-credits |
| B4 | I can't spend money I don't have | `/api/ask` reserves atomically (DynamoDB conditional write); below `billingMinChargeCents` it returns 402 without invoking the agent |
| B5 | I pay for what I used | Cost = input/output tokens from the agent's `model_metrics` events × configured per-million prices, at least the minimum charge, at most the reservation |
| B6 | I don't pay for failures | No `answer` event, an `Error:` answer, or any guardrail intervention → charge 0 |
| B7 | I see what each answer cost | A final `{type:"billing", charged_micros, balance_micros, currency}` SSE event; the UI shows it under the answer and updates the header |

## Design decisions

- **Money is integer micro-units** (1 cent = 10 000 micros), so per-token prices don't
  round to zero and floats never touch the ledger.
- **Same DynamoDB table** as sessions: `pk=USER#<sub>`, `sk=CREDIT` (balance) and
  `sk=PAYMENT#<checkoutSessionId>` (idempotency + audit record, no TTL).
- **Metering happens in the frontend route**, by observing the SSE stream the agent already
  emits. The agent and the AgentCore contract are unchanged.
- **Stripe keys live in Secrets Manager** (`parlamentgpt/stripe-<suffix>`, JSON
  `{"secretKey":"sk_…","webhookSecret":"whsec_…"}`), read at runtime with a cache. The
  secret is created empty and `RETAIN`ed, like the source API keys. If it is not filled,
  checkout returns 503 and asking still works against the free credit.
- **The webhook is the only writer of credit.** The success redirect only triggers a
  balance poll in the UI. It never credits anything.
- **Holds are not persisted.** If a task dies mid-stream, that question keeps its
  reservation (at most `billingHoldCents`). This is an accepted, bounded loss for the user,
  and the reason the hold is small.

## Configuration (CDK context)

| Key | Default | Meaning |
|---|---|---|
| `billing` | `false` | Enable prepaid credits |
| `billingCurrency` | `eur` | ISO currency for Checkout and display |
| `billingInputPricePerMTokCents` | `600` | Retail price per 1M input tokens |
| `billingOutputPricePerMTokCents` | `3000` | Retail price per 1M output tokens |
| `billingMinChargeCents` | `2` | Floor per successful answer |
| `billingHoldCents` | `100` | Reservation (and cap) per question |
| `billingFreeCreditCents` | `50` | One-time starting credit per account |
| `billingTopupAmountsCents` | `500,1000,2000` | Offered top-up amounts |
| `billingAutomaticTax` | `false` | Enable Stripe Tax on Checkout (needs Stripe Tax set up) |

Defaults are about 2× Claude Sonnet list prices, to cover the always-on infrastructure.
Re-derive them from your own cost data.

## Setup

1. `cdk deploy … --context billing=true`
2. In Stripe, add a webhook endpoint `https://<your-domain>/api/billing/webhook` for
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. `make fill-stripe-secret STRIPE_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… SUFFIX=… REGION=…`
4. Restart is not needed. The secret is re-read within 5 minutes.

## Not legal or tax advice

Selling to consumers triggers VAT/consumer-law obligations (EU OSS VAT, withdrawal-right
waiver for immediately delivered digital content, imprint/terms). Stripe Tax or a
merchant of record (Paddle, Lemon Squeezy) covers part of that. Also check each source's
licence for commercial reuse before charging (`docs/multi-gov/COMPLIANCE.md`).
