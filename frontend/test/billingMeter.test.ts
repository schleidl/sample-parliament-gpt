// Charging rules (docs/billing.md B5/B6), config parsing, and the metered stream wrapper.

import { loadBillingConfig, MICROS_PER_CENT } from "@/lib/billing/config";
import { chargeMicros, emptyUsage, observeEvent, SseParser, tokenCostMicros } from "@/lib/billing/meter";
import { meteredStream } from "@/lib/billing/meteredStream";

const cfg = loadBillingConfig({ BILLING_ENABLED: "true" } as NodeJS.ProcessEnv);

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""));
  // Split mid-frame to prove the parser reassembles across chunk boundaries.
  const cut = Math.floor(bytes.length / 2);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes.slice(0, cut));
      c.enqueue(bytes.slice(cut));
      c.close();
    },
  });
}

async function readAll(s: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(s).text();
}

const metrics = (i: number, o: number) => ({ type: "model_metrics", input_tokens: i, output_tokens: o });
const answer = (text = "Here is what was said.") => ({ type: "answer", answer: text, sources: [] });

describe("billing config", () => {
  test("defaults: disabled, EUR, prices in micros", () => {
    const c = loadBillingConfig({} as NodeJS.ProcessEnv);
    expect(c.enabled).toBe(false);
    expect(c.currency).toBe("eur");
    expect(c.inputPerMTokMicros).toBe(600 * MICROS_PER_CENT);
    expect(c.outputPerMTokMicros).toBe(3000 * MICROS_PER_CENT);
    expect(c.holdMicros).toBe(100 * MICROS_PER_CENT);
    expect(c.topupAmountsCents).toEqual([500, 1000, 2000]);
  });

  test("garbage values fall back instead of producing NaN or negative prices", () => {
    const c = loadBillingConfig({
      BILLING_HOLD_CENTS: "abc",
      BILLING_MIN_CHARGE_CENTS: "-5",
      BILLING_TOPUP_AMOUNTS_CENTS: "1, 5.5, 999999999, x",
    } as NodeJS.ProcessEnv);
    expect(c.holdMicros).toBe(100 * MICROS_PER_CENT);
    expect(c.minChargeMicros).toBe(2 * MICROS_PER_CENT);
    expect(c.topupAmountsCents).toEqual([500, 1000, 2000]);
  });
});

describe("charging rules", () => {
  test("token cost uses both prices and rounds up", () => {
    // 10k in @ €6/M = €0.06; 1k out @ €30/M = €0.03 -> €0.09
    expect(tokenCostMicros(cfg, 10_000, 1_000)).toBe(90_000);
    expect(tokenCostMicros(cfg, 1, 0)).toBe(6); // never rounds a non-zero cost to free
  });

  test("sums metrics across every model call in the tool loop", () => {
    const u = emptyUsage();
    [metrics(1000, 10), metrics(2000, 20), metrics(null as unknown as number, 5), answer()].forEach((e) =>
      observeEvent(u, e),
    );
    expect(u).toMatchObject({ inputTokens: 3000, outputTokens: 35, sawAnswer: true, free: false });
  });

  test("minimum charge applies to cheap answers", () => {
    const u = emptyUsage();
    observeEvent(u, metrics(10, 1));
    observeEvent(u, answer());
    expect(chargeMicros(cfg, u, cfg.holdMicros)).toBe(cfg.minChargeMicros);
  });

  test("charge never exceeds the reservation", () => {
    const u = emptyUsage();
    observeEvent(u, metrics(50_000_000, 0));
    observeEvent(u, answer());
    expect(chargeMicros(cfg, u, 123)).toBe(123);
  });

  test.each([
    ["no answer (interrupted)", [metrics(5000, 500)]],
    ["error answer", [metrics(5000, 500), answer("Error: ThrottlingException: slow down")]],
    ["guardrail intervention", [metrics(5000, 500), { type: "guardrail", action: "intervened" }, answer()]],
  ])("free: %s", (_name, events) => {
    const u = emptyUsage();
    (events as unknown[]).forEach((e) => observeEvent(u, e));
    expect(chargeMicros(cfg, u, cfg.holdMicros)).toBe(0);
  });
});

describe("SseParser", () => {
  test("reassembles frames across chunks and ignores junk", () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: {"b"')).toEqual([{ a: 1 }]);
    expect(p.push(':2}\n\n: comment\n\ndata: not-json\n\n')).toEqual([{ b: 2 }]);
    expect(p.push('data: {"c":3}')).toEqual([]);
    expect(p.flush()).toEqual([{ c: 3 }]);
  });
});

describe("meteredStream", () => {
  test("passes bytes through, settles once, appends a billing event", async () => {
    const settle = jest.fn(async (charged: number) => 1_000_000 - charged);
    const out = await readAll(
      meteredStream(sse([metrics(10_000, 1_000), answer()]), cfg, cfg.holdMicros, settle),
    );
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(90_000);
    expect(out).toContain('"type":"answer"');
    const last = JSON.parse(out.trim().split("\n\n").pop()!.slice(5));
    expect(last).toEqual({ type: "billing", currency: "eur", charged_micros: 90_000, balance_micros: 910_000 });
  });

  test("client disconnect before the answer settles for free", async () => {
    const settle = jest.fn(async () => 0);
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(metrics(9999, 999))}\n\n`));
        // never closes: the agent is still working when the user leaves
      },
    });
    const s = meteredStream(upstream, cfg, cfg.holdMicros, settle);
    const reader = s.getReader();
    await reader.read();
    await reader.cancel();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(0);
  });

  test("a failing settle still ends the stream (balance unknown)", async () => {
    const settle = jest.fn(async () => {
      throw new Error("ddb down");
    });
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await readAll(meteredStream(sse([answer()]), cfg, cfg.holdMicros, settle));
    spy.mockRestore();
    expect(out).toContain('"balance_micros":null');
  });
});
