// Only the signature-verified Stripe webhook may bypass the auth middleware; the rest of
// /api/billing (balance, checkout) must stay behind sign-in.
jest.mock("@/lib/auth", () => ({ ID_TOKEN_COOKIE: "pg_id", verifyIdToken: async () => null }));
import { config } from "@/middleware";

const gated = (path: string) => config.matcher.some((m) => new RegExp(`^${m}$`).test(path));

test.each([
  ["/", true],
  ["/api/ask", true],
  ["/api/billing", true],
  ["/api/billing/checkout", true],
  ["/api/billing/webhook", false],
  ["/api/auth/login", false],
])("%s gated=%s", (path, expected) => {
  expect(gated(path)).toBe(expected);
});
