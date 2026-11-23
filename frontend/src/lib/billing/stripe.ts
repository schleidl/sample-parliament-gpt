// Stripe access. Keys come from Secrets Manager at runtime (never env vars or the image):
// the secret is created empty by CDK and filled by the operator, so the app has to cope
// with "not configured yet" and pick up a newly filled value without a restart.

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";

import { billingConfig } from "./config";

const REGION = process.env.AWS_REGION ?? "eu-central-1";
const CACHE_MS = 5 * 60 * 1000;
// Re-check sooner while unconfigured, so a freshly filled secret is picked up quickly.
const MISS_CACHE_MS = 30 * 1000;

type StripeKeys = { secretKey: string; webhookSecret: string };

let sm: SecretsManagerClient | undefined;
let cache: { at: number; keys: StripeKeys | null; client: Stripe | null } | undefined;

/** Parse the secret JSON; anything incomplete counts as "not configured". */
export function parseStripeSecret(raw: string | undefined): StripeKeys | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StripeKeys>;
    const secretKey = typeof v.secretKey === "string" ? v.secretKey.trim() : "";
    const webhookSecret = typeof v.webhookSecret === "string" ? v.webhookSecret.trim() : "";
    if (!/^(sk|rk)_(test|live)_/.test(secretKey) || !webhookSecret.startsWith("whsec_")) return null;
    return { secretKey, webhookSecret };
  } catch {
    return null;
  }
}

async function load(): Promise<{ keys: StripeKeys | null; client: Stripe | null }> {
  if (cache && Date.now() - cache.at < (cache.keys ? CACHE_MS : MISS_CACHE_MS)) return cache;
  const arn = billingConfig().secretArn;
  let keys: StripeKeys | null = null;
  if (arn) {
    try {
      sm ??= new SecretsManagerClient({ region: REGION });
      const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      keys = parseStripeSecret(out.SecretString);
    } catch (err) {
      console.error("stripe secret unavailable:", (err as Error)?.name ?? "error");
    }
  }
  const client = keys ? new Stripe(keys.secretKey, { maxNetworkRetries: 2, timeout: 15_000 }) : null;
  cache = { at: Date.now(), keys, client };
  return cache;
}

export async function stripeClient(): Promise<Stripe | null> {
  return (await load()).client;
}

export async function webhookSecret(): Promise<string | null> {
  return (await load()).keys?.webhookSecret ?? null;
}

/** Test hook. */
export function resetStripeCache(): void {
  cache = undefined;
}
