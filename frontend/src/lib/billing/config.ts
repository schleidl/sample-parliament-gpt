// Prepaid-credit configuration, read once from the environment (set by the CDK stack).
// Money is handled as integer micro-units: 1 currency unit = 1_000_000 micros,
// 1 cent = 10_000 micros. See docs/billing.md.

export const MICROS_PER_CENT = 10_000;

export type BillingConfig = {
  enabled: boolean;
  currency: string;
  /** Retail price per 1M input tokens, in micros. */
  inputPerMTokMicros: number;
  /** Retail price per 1M output tokens, in micros. */
  outputPerMTokMicros: number;
  minChargeMicros: number;
  holdMicros: number;
  freeCreditMicros: number;
  topupAmountsCents: number[];
  automaticTax: boolean;
  secretArn: string;
};

function cents(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  const n = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback * MICROS_PER_CENT;
  return Math.round(n * MICROS_PER_CENT);
}

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const read = (name: string) => env[name];
  const topups = (read("BILLING_TOPUP_AMOUNTS_CENTS") ?? "500,1000,2000")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 100 && n <= 100_000);
  return {
    enabled: (read("BILLING_ENABLED") ?? "").toLowerCase() === "true",
    currency: (read("BILLING_CURRENCY") ?? "eur").toLowerCase(),
    inputPerMTokMicros: cents(env, "BILLING_INPUT_PRICE_PER_MTOK_CENTS", 600),
    outputPerMTokMicros: cents(env, "BILLING_OUTPUT_PRICE_PER_MTOK_CENTS", 3000),
    minChargeMicros: cents(env, "BILLING_MIN_CHARGE_CENTS", 2),
    holdMicros: cents(env, "BILLING_HOLD_CENTS", 100),
    freeCreditMicros: cents(env, "BILLING_FREE_CREDIT_CENTS", 50),
    topupAmountsCents: topups.length ? topups : [500, 1000, 2000],
    automaticTax: (read("BILLING_AUTOMATIC_TAX") ?? "").toLowerCase() === "true",
    secretArn: read("BILLING_SECRET_ARN") ?? "",
  };
}

let cached: BillingConfig | undefined;
export function billingConfig(): BillingConfig {
  if (!cached) cached = loadBillingConfig();
  return cached;
}

/** Test hook. */
export function resetBillingConfig(): void {
  cached = undefined;
}
