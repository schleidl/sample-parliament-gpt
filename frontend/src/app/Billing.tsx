"use client";

// Prepaid-credit UI: header balance badge, top-up menu, and the post-checkout balance
// poll (docs/billing.md). Renders nothing when billing is disabled for the deployment.

import { useCallback, useEffect, useRef, useState } from "react";

import { MESSAGES } from "@/lib/messages";

export type BillingState = {
  enabled: true;
  currency: string;
  balance_micros: number;
  topup_amounts_cents: number[];
  topup_available: boolean;
};

/** Money for display. Balances round DOWN so we never show credit that isn't there. */
export function formatMoney(micros: number, currency: string, mode: "floor" | "nearest" = "floor"): string {
  const cents = mode === "floor" ? Math.floor(micros / 10_000) : Math.round(micros / 10_000);
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** Per-answer cost: below one cent, show "< 0.01" rather than a misleading zero. */
export function formatCost(micros: number, currency: string): string {
  if (micros <= 0) return formatMoney(0, currency);
  if (micros < 10_000) return `< ${formatMoney(10_000, currency)}`;
  return formatMoney(micros, currency, "nearest");
}

export function useBilling() {
  const [billing, setBilling] = useState<BillingState | null>(null);

  const refresh = useCallback(async (): Promise<BillingState | null> => {
    try {
      const res = await fetch("/api/billing");
      if (!res.ok) return null;
      const data = await res.json();
      if (!data?.enabled) {
        setBilling(null);
        return null;
      }
      const next: BillingState = {
        enabled: true,
        currency: String(data.currency ?? "eur"),
        balance_micros: Number(data.balance_micros ?? 0),
        topup_amounts_cents: Array.isArray(data.topup_amounts_cents) ? data.topup_amounts_cents : [],
        topup_available: Boolean(data.topup_available),
      };
      setBilling(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // After a Stripe redirect the webhook may land a moment later: poll briefly until the
  // balance moves, then drop the query flag so a reload doesn't poll again.
  useEffect(() => {
    void (async () => {
      const first = await refresh();
      const params = new URLSearchParams(window.location.search);
      if (params.get("topup") !== "success" || !first) {
        if (params.has("topup")) clearTopupFlag();
        return;
      }
      const start = first.balance_micros;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await refresh();
        if (now && now.balance_micros !== start) break;
      }
      clearTopupFlag();
    })();
  }, [refresh]);

  const setBalance = useCallback((micros: number) => {
    setBilling((b) => (b ? { ...b, balance_micros: micros } : b));
  }, []);

  return { billing, refresh, setBalance };
}

function clearTopupFlag() {
  const url = new URL(window.location.href);
  url.searchParams.delete("topup");
  window.history.replaceState(null, "", url);
}

export async function startTopup(amountCents: number): Promise<string | null> {
  try {
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountCents }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && typeof data?.url === "string" && data.url.startsWith("https://")) {
      window.location.href = data.url;
      return null;
    }
    return MESSAGES.topupUnavailable;
  } catch {
    return MESSAGES.topupUnavailable;
  }
}

export function TopupButtons({ billing }: { billing: BillingState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!billing.topup_available) {
    return <p className="billing-note">{MESSAGES.topupUnavailable}</p>;
  }
  return (
    <div className="topup-options">
      {billing.topup_amounts_cents.map((c) => (
        <button
          key={c}
          type="button"
          className="btn btn-normal"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(await startTopup(c));
            setBusy(false);
          }}
        >
          {formatMoney(c * 10_000, billing.currency)}
        </button>
      ))}
      {error && <p className="billing-note">{error}</p>}
    </div>
  );
}

export function BillingBadge({ billing }: { billing: BillingState }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="billing-badge" ref={ref}>
      <span className="billing-balance" title={MESSAGES.balanceTitle}>
        {formatMoney(billing.balance_micros, billing.currency)}
      </span>
      <button
        type="button"
        className="btn-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {MESSAGES.topUp}
      </button>
      {open && (
        <div className="billing-menu" role="dialog" aria-label={MESSAGES.topUp}>
          <p className="billing-menu-title">{MESSAGES.topupHeading}</p>
          <TopupButtons billing={billing} />
          <p className="billing-note">{MESSAGES.topupFinePrint}</p>
        </div>
      )}
    </div>
  );
}
