import { NextRequest, NextResponse } from "next/server";
import { requestOrigin } from "@/lib/auth";
import { requireUser } from "@/lib/authGuard";
import { billingConfig } from "@/lib/billing/config";
import { ledgerConfigured } from "@/lib/billing/ledger";
import { stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a top-up: a Stripe Checkout session for one of the configured amounts, bound to
 * the verified user (docs/billing.md B2). Crediting happens only in the webhook.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = billingConfig();
  if (!cfg.enabled || !ledgerConfigured()) {
    return NextResponse.json({ error: "billing_disabled" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const amountCents = (body as { amountCents?: unknown })?.amountCents;
  // Only the advertised amounts: the client never chooses an arbitrary price.
  if (typeof amountCents !== "number" || !cfg.topupAmountsCents.includes(amountCents)) {
    return NextResponse.json({ error: "bad_amount" }, { status: 400 });
  }

  const stripe = await stripeClient();
  if (!stripe) return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });

  const origin = requestOrigin(req);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: user.sub,
      metadata: { sub: user.sub },
      ...(user.email ? { customer_email: user.email } : {}),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: cfg.currency,
            unit_amount: amountCents,
            product_data: { name: "ParlamentGPT credit" },
            ...(cfg.automaticTax ? { tax_behavior: "exclusive" as const } : {}),
          },
        },
      ],
      ...(cfg.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      success_url: `${origin}/?topup=success`,
      cancel_url: `${origin}/?topup=cancelled`,
    });
    if (!session.url) throw new Error("checkout session without url");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("checkout session failed:", (err as Error)?.name ?? "error");
    return NextResponse.json({ error: "payments_unavailable" }, { status: 502 });
  }
}
