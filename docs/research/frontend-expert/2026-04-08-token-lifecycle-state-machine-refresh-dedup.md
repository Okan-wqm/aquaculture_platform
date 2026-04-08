# Research: Token Lifecycle State Machine, Proactive Refresh, and Concurrent Deduplication
**Topic:** JWT access/refresh token state machine (INITIALIZING → REFRESHING → READY → EXPIRED), proactive refresh at 80% TTL, single-flight refresh dedup via shared promise, MFE bridge via window global, 401 retry semantics
**Date:** 2026-04-08
**Agent:** frontend-expert

## Sources
- [OWASP — JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [OWASP — OAuth2 Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP — Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP WSTG — OAuth Authorization Server Weaknesses](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/05.1-Testing_for_OAuth_Authorization_Server_Weaknesses)
- [OWASP — Attacking and Securing JWT (presentation)](https://owasp.org/www-chapter-vancouver/assets/presentations/2020-01_Attacking_and_Securing_JWT.pdf)
- [Auth0 — Refresh Tokens: What They Are and How to Use Them](https://auth0.com/blog/refresh-tokens-what-are-they-and-when-to-use-them/)
- [Axios interceptor for refresh token with multiple parallel requests (reference gist)](https://gist.github.com/Godofbrowser/bf118322301af3fc334437c683887c5f)
- [spring-security-oauth issue #834 — concurrency problems refreshing OAuth2 tokens](https://github.com/spring-attic/spring-security-oauth/issues/834)

## Key Findings

### 1. Access token TTL: OWASP recommends 5–15 minutes
OWASP explicitly recommends access token validity between 5 and 15 minutes depending on resource sensitivity. For a multi-tenant aquaculture SaaS handling PII and operational control surfaces, the lower end (5–10 min) is correct. Refresh tokens may be long-lived but MUST have an absolute expiry and MUST be rotated on use (single-use refresh tokens with reuse-detection on the AS side).

### 2. State machine is the right abstraction
The four-state model (`INITIALIZING → REFRESHING → READY → EXPIRED`) correctly models the lifecycle but must handle these edge transitions:
- `INITIALIZING → EXPIRED`: no valid token in storage at bootstrap, not an error — must route to login without triggering a refresh.
- `READY → REFRESHING`: triggered proactively at 80% TTL (e.g. 8 min into a 10 min token) AND reactively on 401.
- `REFRESHING → READY`: on success, atomically swap the token value and wake all queued callers.
- `REFRESHING → EXPIRED`: on failure (refresh token invalid/revoked/expired), must hard-logout and clear ALL cached state (tenant context, query cache, IndexedDB sensitive stores).
- `REFRESHING → REFRESHING`: NOT a valid transition — must be deduplicated to a single shared promise.
- `EXPIRED → READY`: only via a full login round-trip — never via silent refresh from EXPIRED.

### 3. Proactive refresh at 80% TTL prevents 401 storms
Waiting for a 401 means: (a) every concurrent request in flight fails, (b) the UI flashes an error state, (c) analytics logs bogus auth failures, (d) the backend burns CPU on bad token verification. Refresh proactively when `now >= issuedAt + 0.8 * ttl`. Implementation: set a `setTimeout` at `0.8 * ttl - now` on each successful refresh. On tab visibility change, check the timer (background tabs may have throttled it).

### 4. Concurrent refresh MUST deduplicate via a shared promise
This is the canonical single-flight pattern. The api-client module must hold a module-scoped variable `let refreshPromise: Promise<Token> | null = null`. The refresh function:
```ts
function refreshToken(): Promise<Token> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
```
All concurrent callers (10 in-flight GraphQL queries, 3 REST mutations, a background sync) await the same promise. On success, all callers receive the new token and retry their original request atomically. On failure, all callers reject with the same error and route to login once.

**Critical correctness detail:** the retry of the original request must use a token read AFTER the refresh resolves, NOT the token that was captured when the original request was constructed. Otherwise a fast refresh followed by a slow retry can use a stale token.

### 5. MFE bridge via `window.__SHARED_AUTH__` is necessary but dangerous
Because the shell and each remote import the auth module through MF `singleton: true`, the token state SHOULD be naturally shared. However, edge cases break this assumption:
- A remote loaded before the shell's auth bootstrap finishes initializing sees `undefined`.
- A remote that was lazy-loaded AFTER logout may instantiate a fresh module (MF cache miss) and get a stale token from window global.
- Third-party scripts can read `window.__SHARED_AUTH__` if it exposes the raw access token.

The correct pattern is:
- The window global exposes ONLY functions (`getAccessToken()`, `subscribe(callback)`, `logout()`), never the raw token value as a property.
- `getAccessToken()` returns the token from the state machine's current state — never from a cached copy.
- `subscribe()` lets remotes react to state changes (e.g. re-run queries after refresh).
- The global is set as non-configurable and non-writable (`Object.defineProperty` with `writable: false, configurable: false`) to prevent tampering from other scripts in the same origin.

### 6. 401 retry semantics — prevent infinite loops
The api-client interceptor must:
1. Intercept any response with `status === 401`.
2. Check a per-request `_retryCount` counter — abort after 1 retry.
3. Call `refreshToken()` (dedup'd).
4. If refresh succeeds, clone the original request with the new Authorization header and re-send.
5. If refresh fails or `_retryCount > 0`, hard-logout.

**Critical:** the refresh endpoint itself MUST be exempt from the interceptor, otherwise a 401 on refresh triggers infinite recursion. Same for the login endpoint.

### 7. Storage location matters
OWASP guidance: avoid localStorage for tokens (XSS-readable). Prefer:
- Access token: memory (module variable) — cleared on tab close, not XSS-exfiltrable through cross-tab mechanisms.
- Refresh token: httpOnly, Secure, SameSite=Strict cookie (invisible to JS, sent only via credentials).
If the refresh token MUST be in JS (e.g. mobile PWA without a backend session), use IndexedDB with AES-GCM encryption (see offline research doc) and a short absolute expiry.

## Security Concerns

1. **CRITICAL — Raw token exposed on window global.** If `window.__SHARED_AUTH__.token` is a plain string, any XSS (even inside a remote) can exfiltrate it. Must be function-gated.
2. **CRITICAL — Refresh endpoint not exempted from 401 interceptor.** Causes infinite refresh loop and DoS on auth server.
3. **CRITICAL — Token in localStorage.** XSS reads it trivially. MUST be in memory or httpOnly cookie.
4. **HIGH — Refresh not deduplicated.** 10 concurrent requests → 10 refresh calls → refresh token rotation race → random users logged out.
5. **HIGH — EXPIRED → READY transition without re-login.** A bug in the state machine that allows resurrection from EXPIRED is a silent session-reuse vulnerability.
6. **HIGH — Logout doesn't clear TanStack Query cache + IndexedDB.** Previous tenant's data leaks to next login on the same device.
7. **MEDIUM — Proactive refresh timer not reset on tab resume.** Background-throttled tab wakes with an expired token and has to 401 → refresh, defeating the purpose.
8. **MEDIUM — Refresh retry count not bounded.** A persistent refresh failure loops forever.

## Performance Concerns

1. **Concurrent refresh dedup is a measurable perf win.** 10x fewer refresh calls → measurable backend CPU reduction and user-perceptible latency drop during burst requests.
2. **Proactive refresh removes 401 retry latency** (typically 200–500ms per 401 round-trip) from the critical path during token expiry windows.
3. **Token validation on every request (client-side)** can use a cached `exp` read — don't re-parse the JWT on every request.

## Architectural Implications for frontend-expert reviews

When reviewing `token-lifecycle.ts`, `api-client.ts`, or `AuthContext.tsx`:
1. Verify the state machine has explicit transitions and rejects invalid ones (no free `setState(newState)`).
2. Verify `refreshPromise` dedup pattern is in place and the promise is cleared in `.finally()`.
3. Verify refresh is scheduled proactively (setTimeout at 80% TTL) AND on 401.
4. Verify the 80% TTL timer is reset on `visibilitychange` / `focus`.
5. Verify the refresh endpoint is explicitly excluded from the 401 interceptor.
6. Verify `_retryCount` is bounded at 1.
7. Verify `window.__SHARED_AUTH__` exposes ONLY functions, not raw token.
8. Verify the global is defined with `Object.defineProperty` non-writable, non-configurable.
9. Verify logout clears: memory token, refresh cookie, TanStack queryClient, Zustand stores, IndexedDB sensitive stores (see offline research), shared-ui tenant context.
10. Verify the retry request reads the token AFTER `refreshPromise` resolves (not a stale capture).
11. Verify EXPIRED state can only transition to READY via full login (no silent resurrection).
12. Verify MFE remotes use `subscribe()` to react to token state changes — polling `getAccessToken()` in a loop is MEDIUM.

## Domain Rule Additions for frontend-expert

### Token Lifecycle (Critical) — additions
- **MUST** implement single-flight refresh dedup via a module-scoped `refreshPromise` variable. Concurrent callers share the same promise.
- **MUST** schedule proactive refresh at 80% of TTL via `setTimeout`, and MUST re-check on `visibilitychange` / `focus` events (background-throttled timers).
- **MUST** exempt the refresh endpoint and login endpoint from the 401 interceptor. Infinite loop bugs are CRITICAL.
- **MUST** bound `_retryCount` at 1 per request — second 401 after refresh = hard logout.
- **MUST** expose `window.__SHARED_AUTH__` as a frozen object of functions (`getAccessToken`, `subscribe`, `logout`). Raw token as a property = CRITICAL.
- **MUST** use `Object.defineProperty(window, '__SHARED_AUTH__', { writable: false, configurable: false })` to prevent tampering.
- **MUST** store access token in memory (module variable). localStorage = CRITICAL. sessionStorage = HIGH.
- **MUST** store refresh token in httpOnly+Secure+SameSite=Strict cookie. JS-accessible refresh token without AES-GCM encryption = HIGH.
- **MUST** reject `EXPIRED → READY` transition except via full login flow. Silent resurrection from EXPIRED = CRITICAL.
- **MUST** on logout, clear: memory access token, refresh cookie, TanStack `queryClient.clear()`, all Zustand stores, IndexedDB tenant-scoped stores, shared-ui contexts. Missing any = HIGH (cross-tenant leak).
- **MUST** make retry read the token AFTER `refreshPromise` resolves, not a stale capture. Stale capture = HIGH (sporadic auth bugs).
- **MUST** state machine transitions are explicit — free `setState` bypassing validation = HIGH.
