"use strict";
// E-mail domain allowlist for the Cognito PreSignUp trigger. Plain CommonJS, no
// dependencies, so the Lambda asset needs no bundling.
//
// Pattern semantics (comma-separated, OR-combined, case-insensitive):
//   "example.com"    exactly that domain
//   "*.example.com"  the domain and any subdomain
//   "amazon.*"       that label under any TLD, incl. multi-label (co.uk); no subdomains
//   "*" / empty      no restriction

function domainOf(email) {
  const s = String(email || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return "";
  return s.slice(at + 1);
}

function matches(domain, pattern) {
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  if (pattern.endsWith(".*")) {
    const label = pattern.slice(0, -2);
    if (!domain.startsWith(`${label}.`)) return false;
    const rest = domain.slice(label.length + 1);
    // TLD part: one or two short labels (com, de, co.uk, co.jp) — never a subdomain chain.
    return /^[a-z]{2,}(\.[a-z]{2,3})?$/.test(rest) && !rest.includes("..");
  }
  return domain === pattern;
}

function emailDomainAllowed(email, allowlist) {
  const patterns = String(allowlist || "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0 || patterns.includes("*")) return true;
  const domain = domainOf(email);
  if (!domain) return false;
  return patterns.some((p) => matches(domain, p));
}

module.exports = { emailDomainAllowed };
