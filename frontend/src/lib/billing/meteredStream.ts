// Wrap the agent's SSE byte stream: pass every byte through unchanged, meter it on the
// side, and settle the reservation exactly once when the stream ends, errors, or the
// client goes away. On a normal end a final `billing` event is appended (B7).

import type { BillingConfig } from "./config";
import { chargeMicros, emptyUsage, observeEvent, SseParser } from "./meter";

export type Settle = (chargedMicros: number) => Promise<number>;

export function meteredStream(
  upstream: ReadableStream<Uint8Array>,
  cfg: BillingConfig,
  reservedMicros: number,
  settle: Settle,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new SseParser();
  const usage = emptyUsage();
  let settled: Promise<{ charged: number; balance: number | null }> | undefined;

  const finish = () => {
    if (!settled) {
      for (const ev of parser.flush()) observeEvent(usage, ev);
      const charged = chargeMicros(cfg, usage, reservedMicros);
      settled = settle(charged)
        .then((balance) => ({ charged, balance }))
        .catch((err) => {
          // The reservation stays deducted; logged so an operator can reconcile.
          console.error("billing settle failed:", (err as Error)?.name ?? "error");
          return { charged, balance: null };
        });
    }
    return settled;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        await finish();
        controller.error(err);
        return;
      }
      if (chunk.done) {
        const { charged, balance } = await finish();
        const event = {
          type: "billing",
          currency: cfg.currency,
          charged_micros: charged,
          balance_micros: balance,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
        return;
      }
      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        observeEvent(usage, ev);
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      // Client disconnected: normal rules apply, so a run is free unless its answer was
      // already streamed (B6).
      await finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
