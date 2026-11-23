import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { billingConfig, MICROS_PER_CENT } from "@/lib/billing/config";
import { creditPayment, ledgerConfigured } from "@/lib/billing/ledger";
import { stripeClient, webhookSecret } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook: the ONLY place credit is added (docs/billing.md B3). Unauthenticated by
 * design (Stripe calls it), so it trusts nothing but a valid signature, and it is excluded
 * from the auth middleware.
 */
export async function POST(req: NextRequest) {
  const cfg = billingConfig();
  if (!cfg.enabled || !ledgerConfigured()) {
    return NextResponse.json({ error: "billing_disabled" }, { status: 404 });
  }
  const [stripe, secret] = await Promise.all([stripeClient(), webhookSecret()]);
  if (!stripe || !secret) {
    // 503 makes Stripe retry later, once the secret is filled.
    return NextResponse.json({ error: "payments_unavailable" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  const payload = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, secret);
  } catch {
    return NextResponse.json({ error: "bad_signature" }, { status: 400 });
  }

  const paid =
    (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") ||
    event.type === "checkout.session.async_payment_succeeded";
  if (!paid) return NextResponse.json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;
  const sub = session.client_reference_id ?? session.metadata?.sub ?? "";
  // Net of tax: tax collected for the authorities is not the user's spendable credit.
  const netCents = session.amount_subtotal ?? 0;
  if (!sub || netCents <= 0 || (session.currency ?? "").toLowerCase() !== cfg.currency) {
    // Acknowledge (no retry storm) but leave a trail: this needs a human.
    console.error("unusable checkout session; not credited:", session.id);
    return NextResponse.json({ received: true, credited: false });
  }

  const credited = await creditPayment(sub, session.id, netCents * MICROS_PER_CENT, cfg.currency);
  return NextResponse.json({ received: true, credited });
}
