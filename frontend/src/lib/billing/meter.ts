// Pure metering: observe the agent's SSE events and turn them into a charge.
// No I/O here, so every charging rule (docs/billing.md B5/B6) is unit-testable.

import type { BillingConfig } from "./config";

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  sawAnswer: boolean;
  /** True when the run must not be charged (error answer or guardrail intervention). */
  free: boolean;
};

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, sawAnswer: false, free: false };
}

const nonNegInt = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** Fold one parsed SSE event into the running usage. */
export function observeEvent(usage: Usage, event: unknown): void {
  if (!event || typeof event !== "object") return;
  const ev = event as Record<string, unknown>;
  switch (ev.type) {
    case "model_metrics":
      usage.inputTokens += nonNegInt(ev.input_tokens);
      usage.outputTokens += nonNegInt(ev.output_tokens);
      break;
    case "guardrail":
      usage.free = true;
      break;
    case "answer":
      usage.sawAnswer = true;
      if (typeof ev.answer === "string" && ev.answer.startsWith("Error:")) usage.free = true;
      break;
  }
}

/** Raw token cost in micros (rounded up so fractions never round to free). */
export function tokenCostMicros(cfg: BillingConfig, inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * cfg.inputPerMTokMicros + outputTokens * cfg.outputPerMTokMicros) / 1_000_000,
  );
}

/** What to actually charge for a finished run, never more than was reserved. */
export function chargeMicros(cfg: BillingConfig, usage: Usage, reservedMicros: number): number {
  if (!usage.sawAnswer || usage.free) return 0;
  const cost = Math.max(cfg.minChargeMicros, tokenCostMicros(cfg, usage.inputTokens, usage.outputTokens));
  return Math.min(cost, Math.max(0, reservedMicros));
}

/**
 * Incremental SSE parser: feed decoded text chunks, get complete `data:` payloads back.
 * Mirrors page.tsx:consumeStream so both sides agree on frame boundaries.
 */
export class SseParser {
  private buffer = "";

  push(text: string): unknown[] {
    this.buffer += text;
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop() ?? "";
    return frames.flatMap(parseFrame);
  }

  flush(): unknown[] {
    const rest = this.buffer;
    this.buffer = "";
    return parseFrame(rest);
  }
}

function parseFrame(frame: string): unknown[] {
  const out: unknown[] = [];
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const json = trimmed.slice(5).trim();
    if (!json) continue;
    try {
      out.push(JSON.parse(json));
    } catch {
      /* malformed frame: ignore, like the browser does */
    }
  }
  return out;
}
