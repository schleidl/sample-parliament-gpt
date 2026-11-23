// Billing routes: webhook (real Stripe signature verification, offline), checkout, and
// the /api/ask reserve -> meter -> settle path.

import { NextRequest } from "next/server";
import Stripe from "stripe";

const WHSEC = "whsec_test_secret";
const realStripe = new Stripe("sk_test_dummy");
const createSessionMock = jest.fn();
let stripeAvailable = true;

jest.mock("@/lib/billing/stripe", () => ({
  stripeClient: async () =>
    stripeAvailable
      ? { webhooks: realStripe.webhooks, checkout: { sessions: { create: createSessionMock } } }
      : null,
  webhookSecret: async () => (stripeAvailable ? WHSEC : null),
}));

const ledger = {
  ledgerConfigured: jest.fn(() => true),
  getBalance: jest.fn(),
  reserve: jest.fn(),
  settle: jest.fn(),
  creditPayment: jest.fn(),
};
jest.mock("@/lib/billing/ledger", () => ({
  ledgerConfigured: () => ledger.ledgerConfigured(),
  getBalance: (...a: unknown[]) => ledger.getBalance(...a),
  reserve: (...a: unknown[]) => ledger.reserve(...a),
  settle: (...a: unknown[]) => ledger.settle(...a),
  creditPayment: (...a: unknown[]) => ledger.creditPayment(...a),
}));

const requireUserMock = jest.fn();
jest.mock("@/lib/authGuard", () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }));

const streamAgentRuntimeMock = jest.fn();
jest.mock("@/app/api/ask/agentClient", () => ({
  hasLocalAgent: false,
  streamAgentRuntime: (...a: unknown[]) => streamAgentRuntimeMock(...a),
  streamLocalAgent: jest.fn(),
}));

const OLD = process.env;
beforeEach(() => {
  jest.resetModules();
  process.env = { ...OLD, BILLING_ENABLED: "true", BILLING_CURRENCY: "eur" };
  stripeAvailable = true;
  Object.values(ledger).forEach((m) => m.mockReset());
  ledger.ledgerConfigured.mockReturnValue(true);
  createSessionMock.mockReset();
  streamAgentRuntimeMock.mockReset();
  requireUserMock.mockReset().mockResolvedValue({
    sub: `sub-${Math.random().toString(36).slice(2)}`,
    email: "a@example.com",
    issuedAt: 0,
  });
});
afterAll(() => {
  process.env = OLD;
});

function checkoutEvent(type: string, session: Record<string, unknown>) {
  return {
    id: "evt_1",
    object: "event",
    type,
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        client_reference_id: "user-1",
        metadata: { sub: "user-1" },
        amount_subtotal: 1000,
        amount_total: 1190,
        currency: "eur",
        payment_status: "paid",
        ...session,
      },
    },
  };
}

function webhookReq(event: unknown, secret = WHSEC) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return new NextRequest("http://localhost/api/billing/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

describe("webhook", () => {
  test("paid checkout credits the NET amount (excl. tax) in micros, once per session", async () => {
    ledger.creditPayment.mockResolvedValue(true);
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(webhookReq(checkoutEvent("checkout.session.completed", {})));
    expect(res.status).toBe(200);
    expect(ledger.creditPayment).toHaveBeenCalledWith("user-1", "cs_test_1", 1000 * 10_000, "eur");
  });

  test("forged signature is rejected and credits nothing", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(webhookReq(checkoutEvent("checkout.session.completed", {}), "whsec_attacker"));
    expect(res.status).toBe(400);
    expect(ledger.creditPayment).not.toHaveBeenCalled();
  });

  test("missing signature header is rejected", async () => {
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(
      new NextRequest("http://localhost/api/billing/webhook", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(400);
  });

  test("unpaid (async pending) completion credits nothing; async success does", async () => {
    ledger.creditPayment.mockResolvedValue(true);
    const { POST } = await import("@/app/api/billing/webhook/route");
    await POST(webhookReq(checkoutEvent("checkout.session.completed", { payment_status: "unpaid" })));
    expect(ledger.creditPayment).not.toHaveBeenCalled();
    await POST(
      webhookReq(checkoutEvent("checkout.session.async_payment_succeeded", { payment_status: "paid" })),
    );
    expect(ledger.creditPayment).toHaveBeenCalledTimes(1);
  });

  test("currency mismatch is acknowledged but not credited", async () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(webhookReq(checkoutEvent("checkout.session.completed", { currency: "usd" })));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(ledger.creditPayment).not.toHaveBeenCalled();
  });

  test("503 while Stripe keys are not filled in (Stripe retries later)", async () => {
    stripeAvailable = false;
    const { POST } = await import("@/app/api/billing/webhook/route");
    const res = await POST(webhookReq(checkoutEvent("checkout.session.completed", {})));
    expect(res.status).toBe(503);
  });
});

function jsonReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("checkout", () => {
  test("creates a session for an offered amount, bound to the verified user", async () => {
    createSessionMock.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1" });
    const { POST } = await import("@/app/api/billing/checkout/route");
    const res = await POST(jsonReq("https://app.example.com/api/billing/checkout", { amountCents: 1000 }));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    const params = createSessionMock.mock.calls[0][0];
    const sub = (await requireUserMock.mock.results[0].value).sub;
    expect(params.client_reference_id).toBe(sub);
    expect(params.line_items[0].price_data).toMatchObject({ currency: "eur", unit_amount: 1000 });
  });

  test("arbitrary amounts are refused", async () => {
    const { POST } = await import("@/app/api/billing/checkout/route");
    for (const amountCents of [1, 999, -500, "1000"]) {
      const res = await POST(jsonReq("http://localhost/api/billing/checkout", { amountCents }));
      expect(res.status).toBe(400);
    }
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  test("401 unauthenticated, 404 when billing is off", async () => {
    requireUserMock.mockResolvedValueOnce(null);
    let { POST } = await import("@/app/api/billing/checkout/route");
    expect((await POST(jsonReq("http://localhost/x", { amountCents: 500 }))).status).toBe(401);

    jest.resetModules();
    process.env.BILLING_ENABLED = "false";
    ({ POST } = await import("@/app/api/billing/checkout/route"));
    expect((await POST(jsonReq("http://localhost/x", { amountCents: 500 }))).status).toBe(404);
  });
});

function sse(events: unknown[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

describe("/api/ask with prepaid credits", () => {
  const ask = () => jsonReq("http://localhost/api/ask", { question: "Was sagte der Bundestag zur Rente?" });

  test("402 without credit, and the agent is never invoked", async () => {
    ledger.reserve.mockResolvedValue(null);
    const { POST } = await import("@/app/api/ask/route");
    const res = await POST(ask());
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("insufficient_credit");
    expect(streamAgentRuntimeMock).not.toHaveBeenCalled();
  });

  test("reserve -> stream -> settle with the metered charge, billing event appended", async () => {
    ledger.reserve.mockResolvedValue(1_000_000);
    ledger.settle.mockResolvedValue(4_000_000);
    streamAgentRuntimeMock.mockResolvedValue(
      sse([
        { type: "model_metrics", input_tokens: 10_000, output_tokens: 1_000 },
        { type: "answer", answer: "Antwort", sources: [] },
      ]),
    );
    const { POST } = await import("@/app/api/ask/route");
    const res = await POST(ask());
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(ledger.settle).toHaveBeenCalledWith(expect.any(String), 1_000_000, 90_000);
    expect(text).toContain('"type":"billing"');
    expect(text).toContain('"balance_micros":4000000');
  });

  test("agent invocation failure releases the whole reservation", async () => {
    ledger.reserve.mockResolvedValue(1_000_000);
    ledger.settle.mockResolvedValue(0);
    streamAgentRuntimeMock.mockRejectedValue(new Error("boom"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/ask/route");
    const res = await POST(ask());
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(ledger.settle).toHaveBeenCalledWith(expect.any(String), 1_000_000, 0);
  });

  test("ledger outage fails closed (503), no free model calls", async () => {
    ledger.reserve.mockRejectedValue(Object.assign(new Error("x"), { name: "ServiceUnavailable" }));
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/ask/route");
    const res = await POST(ask());
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(streamAgentRuntimeMock).not.toHaveBeenCalled();
  });

  test("billing disabled: upstream stream passes through untouched", async () => {
    process.env.BILLING_ENABLED = "false";
    streamAgentRuntimeMock.mockResolvedValue(sse([{ type: "answer", answer: "a", sources: [] }]));
    const { POST } = await import("@/app/api/ask/route");
    const text = await (await POST(ask())).text();
    expect(text).not.toContain("billing");
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
});
