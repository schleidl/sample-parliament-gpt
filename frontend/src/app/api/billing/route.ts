import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/authGuard";
import { billingConfig } from "@/lib/billing/config";
import { getBalance, ledgerConfigured } from "@/lib/billing/ledger";
import { stripeClient } from "@/lib/billing/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Balance + offer for the header badge and top-up menu (docs/billing.md B1). */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = billingConfig();
  if (!cfg.enabled || !ledgerConfigured()) return NextResponse.json({ enabled: false });

  const balance = await getBalance(user.sub, cfg.freeCreditMicros);
  return NextResponse.json({
    enabled: true,
    currency: cfg.currency,
    balance_micros: balance,
    topup_amounts_cents: cfg.topupAmountsCents,
    // Lets the UI tell the user up front whether a top-up is possible right now.
    topup_available: Boolean(await stripeClient()),
    pricing: {
      input_per_mtok_micros: cfg.inputPerMTokMicros,
      output_per_mtok_micros: cfg.outputPerMTokMicros,
      min_charge_micros: cfg.minChargeMicros,
      hold_micros: cfg.holdMicros,
    },
  });
}
