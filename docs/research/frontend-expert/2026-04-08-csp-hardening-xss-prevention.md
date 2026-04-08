# Research: Content Security Policy Hardening and DOM-XSS Prevention
**Topic:** Strict CSP with nonces or hashes, `strict-dynamic`, elimination of `unsafe-inline` and `unsafe-eval`, Trusted Types for DOM sinks, XSS prevention in React
**Date:** 2026-04-08
**Agent:** frontend-expert

## Sources
- [web.dev — Mitigate XSS with a strict CSP](https://web.dev/articles/strict-csp)
- [web.dev — Prevent DOM-based XSS with Trusted Types](https://web.dev/articles/trusted-types)
- [MDN — Content Security Policy (CSP) overview](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
- [MDN — Content-Security-Policy header reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)
- [MDN — CSP script-src directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src)
- [MDN — CSP trusted-types directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/trusted-types)
- [MDN — CSP require-trusted-types-for directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for)
- [MDN — CSP Practical Implementation Guide](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/CSP)
- [MDN — Trusted Types API](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API)
- [MDN — TrustedTypePolicyFactory.createPolicy](https://developer.mozilla.org/en-US/docs/Web/API/TrustedTypePolicyFactory/createPolicy)
- [MDN — TrustedHTML](https://developer.mozilla.org/en-US/docs/Web/API/TrustedHTML)
- [W3C — Trusted Types TR](https://www.w3.org/TR/trusted-types/)
- [Chrome Developers — Lighthouse: Mitigate DOM XSS with Trusted Types](https://developer.chrome.com/docs/lighthouse/best-practices/trusted-types-xss)
- [OWASP — Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [OWASP — HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html)
- [OWASP — Cross Site Scripting Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [OWASP — DOM-based XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html)
- [OWASP — Top 10 Proactive Controls C8: Browser Security Features](https://top10proactive.owasp.org/the-top-10/c8-leverage-browser-security-features/)

## Key Findings

### 1. `unsafe-inline` and `unsafe-eval` are disqualifying
Per OWASP and web.dev, any CSP that permits `unsafe-inline` in script-src is not a strict CSP and provides no meaningful XSS protection. `unsafe-eval` similarly defeats purpose. A production-grade React + MF shell MUST eliminate both.

**React-specific:** React 18 does NOT use `eval` in production builds. Any `unsafe-eval` in a prod CSP indicates a build contamination (webpack's `eval-source-map`, a dev-only shim leaking into prod, or a third-party lib using `new Function()` — audit and remove).

### 2. Nonce-based strict CSP is the canonical pattern
The web.dev strict-CSP recipe:
```
Content-Security-Policy:
  script-src 'nonce-{random}' 'strict-dynamic' https: 'unsafe-inline';
  object-src 'none';
  base-uri 'none';
  require-trusted-types-for 'script';
```
Notes:
- The `'unsafe-inline'` token is a **fallback for old browsers** that ignore `'strict-dynamic'`. Modern browsers see `'strict-dynamic'` and ignore `'unsafe-inline'`, so it's safe to include both.
- `https:` is a fallback for browsers that don't understand `'strict-dynamic'` — same rationale.
- `'nonce-{random}'` must be a cryptographically-random value, per-response, at least 128 bits base64'd. Reusing nonces across responses breaks the model.
- `'strict-dynamic'` means: scripts loaded by a nonce'd script inherit the trust. This is critical for Module Federation, because a nonce'd shell entry dynamically loads remote entries — without `strict-dynamic`, each remote would need an individual nonce (impossible cross-origin).
- `object-src 'none'`: blocks Flash / plugin XSS vectors.
- `base-uri 'none'`: prevents `<base href>` injection attacks that rewrite relative URLs.

### 3. Hash-based CSP for static SPAs
If the shell is statically served (no server-side nonce generation), a hash-based CSP is viable: compute the sha256 of each inline script at build time and list them in `script-src 'sha256-...' 'sha256-...' 'strict-dynamic'`. Vite's `vite-plugin-csp` or a custom Rollup plugin can automate this. Nonces are still preferred because:
- Hash-based policies are brittle to any build-time change.
- Hash lists don't work for dynamic script injection without `strict-dynamic`.
- Nonces are more secure against attacker-predictable injection points.

### 4. Trusted Types kills entire classes of DOM XSS
`require-trusted-types-for 'script'` means: the browser will throw on any assignment to a DOM XSS sink (`innerHTML`, `outerHTML`, `document.write`, `eval`, `setTimeout(string)`, `location.href` with javascript: scheme, etc.) unless the value is a `TrustedHTML` / `TrustedScript` / `TrustedScriptURL` object created via a named `TrustedTypePolicy`.

The shell should declare a minimal set of policies:
- `react-html` for `dangerouslySetInnerHTML` (React 18+ integrates with Trusted Types via a dedicated policy name).
- `dompurify` for sanitized HTML input from user content.
- `default` — AVOID unless absolutely necessary. A default policy is a catch-all that weakens the guarantee.

Configuration:
```
Content-Security-Policy:
  trusted-types react-html dompurify;
  require-trusted-types-for 'script';
```

### 5. React integration with Trusted Types
React 18 respects Trusted Types when the policy is named correctly. For `dangerouslySetInnerHTML`, the sanitized HTML string must be wrapped via `trustedTypes.createPolicy('react-html', { createHTML: DOMPurify.sanitize })` and the resulting `TrustedHTML` passed in. Using raw strings with Trusted Types enforced throws a `TypeError`.

**CRITICAL React pattern audit:** search the codebase for:
- `dangerouslySetInnerHTML` (any use)
- `document.write`
- `innerHTML =`
- `outerHTML =`
- `eval(`
- `new Function(`
- `setTimeout(` with a string literal
- `location.href =` or `location.replace(` with untrusted input
- `window.open(` with untrusted URL
Each is a potential DOM-XSS sink. Trusted Types catches them at runtime; CSP blocks exploitation; code review catches them at source.

### 6. Report-only rollout, then enforce
OWASP and web.dev recommend a two-phase rollout:
1. Deploy `Content-Security-Policy-Report-Only` with the strict policy + `report-to` / `report-uri` to an aggregator. Monitor for legitimate violations (third-party libs, analytics, legacy code).
2. Fix all violations.
3. Flip to `Content-Security-Policy` (enforcing).

**Anti-pattern:** staying in Report-Only indefinitely. Report-only provides visibility but ZERO protection. Enforce, always.

### 7. Additional headers that complete the XSS defence
Per OWASP HTTP Headers Cheat Sheet, the strict CSP should be accompanied by:
- `X-Content-Type-Options: nosniff` (prevents MIME confusion that lets HTML be served as JS or vice versa).
- `Referrer-Policy: strict-origin-when-cross-origin` or `no-referrer`.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(self)` — restrict by principle of least privilege.
- `Cross-Origin-Opener-Policy: same-origin` (isolates the browsing context; defends against Spectre and tab-nabbing).
- `Cross-Origin-Embedder-Policy: require-corp` (enables SharedArrayBuffer isolation).
- `Cross-Origin-Resource-Policy: same-site` (blocks cross-origin reads).
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.

## Security Concerns

1. **CRITICAL — `unsafe-inline` in script-src.** Zero XSS protection from the CSP.
2. **CRITICAL — `unsafe-eval` in script-src.** Indicates a build contamination or dev shim in prod; XSS can bootstrap arbitrary code.
3. **CRITICAL — Report-Only CSP in production.** Visibility without protection.
4. **CRITICAL — `dangerouslySetInnerHTML` without DOMPurify.** Direct XSS sink.
5. **CRITICAL — `default` Trusted Types policy used as a catch-all.** Defeats the entire enforcement model.
6. **HIGH — Nonce reused across responses.** Attacker who sees one nonce can inject scripts at will.
7. **HIGH — Nonce too short or not cryptographically random.** Guessable nonce.
8. **HIGH — Missing `object-src 'none'`.** Flash / plugin injection surface.
9. **HIGH — Missing `base-uri 'none'`.** `<base href>` injection rewrites all relative URLs.
10. **HIGH — Missing `require-trusted-types-for 'script'`.** DOM XSS sinks open.
11. **HIGH — Third-party scripts loaded without nonce or allowlist.** Arbitrary external code in the origin.
12. **MEDIUM — `dangerouslySetInnerHTML` used for i18n strings, markdown rendering, or sanitized user content without DOMPurify wrapping.**
13. **MEDIUM — Missing HSTS, X-Content-Type-Options, COOP, CORP.** Defence-in-depth gaps.

## Performance Concerns

1. **Nonce generation on every response adds negligible CPU** (microseconds of RNG).
2. **Trusted Types enforcement adds a small runtime check on every DOM sink assignment** — unmeasurable in practice.
3. **CSP reporting endpoint** can become a DDoS target if heavily reported — use a dedicated CDN endpoint with rate limiting.

## Architectural Implications for frontend-expert reviews

When reviewing shell entry, `index.html`, service worker, security middleware, or any `dangerouslySetInnerHTML` usage:
1. Verify the production CSP contains NEITHER `unsafe-inline` in script-src (except as fallback after `strict-dynamic`) NOR `unsafe-eval`.
2. Verify `script-src` uses `'nonce-...' 'strict-dynamic'` OR hash-based equivalent.
3. Verify the nonce is cryptographically random, ≥128 bits, per-response.
4. Verify `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` (or tight allowlist).
5. Verify `require-trusted-types-for 'script'` is present.
6. Verify `trusted-types` directive lists ONLY named policies, no `default`.
7. Verify CSP is ENFORCING, not Report-Only.
8. Verify every `dangerouslySetInnerHTML` wraps input through DOMPurify via a named TrustedTypes policy.
9. Grep for DOM sink patterns (`innerHTML =`, `document.write`, `eval(`, `new Function(`, string-arg `setTimeout`, `location.href =` with variables).
10. Verify accompanying headers: HSTS, X-Content-Type-Options, COOP, CORP, Referrer-Policy, Permissions-Policy.
11. Verify `report-to` / `report-uri` is configured and the endpoint is active.
12. Verify third-party scripts (analytics, Sentry, maps) are either nonce'd or in a minimal allowlist — never `script-src *`.
13. Verify MFE remote loading respects `strict-dynamic` propagation — the shell entry is nonce'd, and remotes are loaded via that nonce'd script so they inherit trust.

## Domain Rule Additions for frontend-expert

### CSP & XSS Prevention — new subsection
- **MUST** enforce strict CSP in production: `script-src 'nonce-...' 'strict-dynamic'` (or hash-based). `unsafe-inline`/`unsafe-eval` in prod = CRITICAL.
- **MUST** include `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` (or explicit allowlist).
- **MUST** include `require-trusted-types-for 'script'` and an explicit `trusted-types` allowlist. Missing Trusted Types = HIGH.
- **MUST NOT** define a `default` Trusted Types policy as a catch-all. Catch-all `default` = CRITICAL.
- **MUST** generate nonces per-response, ≥128 bits of entropy from CSPRNG. Reused nonce = HIGH.
- **MUST NOT** deploy Report-Only CSP in production beyond a rollout window. Indefinite Report-Only = CRITICAL.
- **MUST** wrap every `dangerouslySetInnerHTML` through DOMPurify via a named `TrustedTypePolicy`. Raw string = CRITICAL.
- **MUST** ban DOM sink patterns in lint: `innerHTML =`, `outerHTML =`, `document.write`, `eval`, `new Function`, string-arg `setTimeout`/`setInterval`.
- **MUST** include HSTS, X-Content-Type-Options: nosniff, COOP, CORP, Referrer-Policy, Permissions-Policy on all responses. Missing any = HIGH.
- **MUST** ensure MF shell entry is nonce'd so `strict-dynamic` propagates to remote entries. Missing nonce on MF host = CRITICAL.
- **MUST** configure CSP reporting endpoint and monitor violation stream.
