# Research: SCADA Runtime Script Sandboxing + Expression Evaluator Security

**Topic:** How to safely execute user-authored SCADA scripts and expressions in a browser runtime — Web Worker isolation, expression whitelists, prototype pollution prevention.
**Date:** 2026-04-08
**Agent:** sensor-expert

## Sources
- [Alex Griss: The Architecture of Browser Sandboxes — JavaScript Code Isolation](https://alexgriss.tech/en/blog/javascript-sandboxes/)
- [DEV Community: Browser Sandbox Architecture Deep Dive](https://dev.to/alexgriss/the-architecture-of-browser-sandboxes-a-deep-dive-into-javascript-code-isolation-1dnj)
- [HackTricks: Content Security Policy (CSP) Bypass](https://book.hacktricks.xyz/pentesting-web/content-security-policy-csp-bypass)
- [Trend Micro: Hacker Machine Interface — State of SCADA HMI Security](https://documents.trendmicro.com/assets/wp/wp-hacker-machine-interface.pdf)
- [FUXA — Web-based SCADA/HMI (GitHub)](https://github.com/frangoteam/FUXA)
- [Fortinet: What Is Sandboxing?](https://www.fortinet.com/resources/cyberglossary/what-is-sandboxing)

## Key Findings

1. **`eval()` / `Function()` in the main thread is NEVER acceptable.** User-authored SCADA script must execute in a Web Worker at minimum, ideally inside an iframe sandbox AS WELL. Main-thread eval with user content = CRITICAL.
2. **Web Worker isolation** gives a separate global scope and a message-passing boundary but does NOT prevent prototype pollution within the worker, DoS via infinite loop, or memory exhaustion. Add execution time budget, memory budget, and max-worker-count limits.
3. **Prototype pollution** is the single most common sandbox escape. User code modifying `Object.prototype`, `__proto__`, or `constructor.prototype` affects all objects — even in a worker, it can poison the worker's own context. Explicit rejection of property paths containing `__proto__`, `constructor`, `prototype` is mandatory.
4. **Frozen builtin function registry.** Expose a fixed set of allowed functions (math, time bucketing, logic) via a frozen `BUILTIN_FUNCTIONS` object. Runtime extension of the registry = CRITICAL (opens arbitrary capability).
5. **Code size limits** prevent resource exhaustion. User code > N KB rejected at submission time.
6. **Tag write rate limiting** inside the expression evaluator prevents runaway scripts from flooding the control system with writes. No rate limit = HIGH (potential life-safety concern on automation tags).
7. **Worker pool bound** (e.g., 4 max workers) prevents resource exhaustion.
8. **Execution timeout** (e.g., 500ms per expression) kills runaway scripts via worker termination.
9. **Content Security Policy (CSP)** must forbid `unsafe-eval` and `unsafe-inline` in production. A CSP bypass via `unsafe-eval` negates the entire Web Worker isolation.
10. **Tag snapshot scoping** — the expression evaluator sees only the current SCADA package's tags. Cross-package or cross-tenant tag access must be structurally impossible, not merely filtered at query time.
11. **Script execution audit log** — every deployment or execution of a user script is logged with the user, tenant, and script hash for incident forensics.

## Security Concerns
- `eval()` in main thread on user input = CRITICAL.
- `new Function()` on user input = CRITICAL.
- Missing prototype pollution guard = CRITICAL.
- `BUILTIN_FUNCTIONS` extensible at runtime = CRITICAL.
- CSP with `unsafe-eval` in production = HIGH.
- CSP with `unsafe-inline` in production = HIGH.
- Missing code size limit = HIGH (memory DoS).
- Missing execution time budget = HIGH (infinite loop DoS).
- Missing worker pool bound = HIGH.
- Cross-package tag access in snapshot = CRITICAL (cross-tenant if packages span tenants).
- Missing tag write rate limit in expression evaluator = HIGH (potential life-safety on PLC control tags).
- Missing script execution audit log = HIGH (compliance / forensics).

## Performance Concerns
- Worker startup cost is non-trivial. Use worker pool with pre-warmed workers.
- Message passing to worker via structured-clone is synchronous on the main thread; large payloads block UI.
- Frequent worker termination for timeouts leaks memory — use worker recycling.

## Architectural Implications for sensor-expert reviews
- Any SCADA runtime code path that passes user input to `eval`, `new Function`, `Function.prototype.constructor`, or similar = CRITICAL.
- Missing property path validation (rejecting `__proto__`, `constructor`, `prototype`) = CRITICAL.
- `BUILTIN_FUNCTIONS` registry exposed to user code or extensible = CRITICAL.
- CSP configuration allowing `unsafe-eval` or `unsafe-inline` in production = HIGH.
- Missing worker timeout enforcement = HIGH.
- Missing worker pool bound = HIGH.
- Missing tag write rate limiting = HIGH (life-safety concern on control tags).
- Tag snapshot filtered at query time rather than structurally scoped = HIGH (race conditions).

## Domain Rule Additions for sensor-expert

Add to `## Domain Rules → SCADA Runtime Security (Critical)`:
- `eval()`, `new Function()`, or any dynamic code execution on user input in the MAIN thread = CRITICAL.
- User scripts execute ONLY in Web Worker sandboxes with: 500ms execution timeout, 4 max workers (bounded pool), code size limit at submission, tag write rate limiter. Missing any of these = CRITICAL.
- `ScriptExecutor` expression evaluator MUST use a frozen `BUILTIN_FUNCTIONS` registry. Runtime extension or user-extensible registry = CRITICAL.
- Property path validation MUST reject `__proto__`, `constructor`, `prototype` to prevent prototype pollution. Missing rejection = CRITICAL.
- Tag value snapshots MUST be filtered to the CURRENT SCADA package's visible tags only; cross-package tag access MUST be structurally impossible (not filtered post-hoc). Structural bypass = CRITICAL.
- Script deployment and execution MUST be audit-logged with user, tenant, and script hash. Missing audit = HIGH (compliance + forensics).
- CSP configuration in production MUST forbid `unsafe-eval` and `unsafe-inline` in `script-src`. Either = HIGH.
- Tag write rate limiter in the expression evaluator MUST bound writes per script per second on automation/control tags. Missing rate limiter = HIGH (potential life-safety concern on control outputs).
