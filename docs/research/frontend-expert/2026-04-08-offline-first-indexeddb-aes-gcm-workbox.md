# Research: Offline-First PWA — Workbox, IndexedDB, AES-GCM, Background Sync, Push
**Topic:** Workbox caching strategies (NetworkFirst for GraphQL, StaleWhileRevalidate for media), IndexedDB via idb-keyval, AES-GCM per-session encryption, bounded offline queue, background sync, push notifications
**Date:** 2026-04-08
**Agent:** frontend-expert

## Sources
- [Chrome Developers — Workbox strategies](https://developer.chrome.com/docs/workbox/modules/workbox-strategies)
- [Chrome Developers — Caching strategies overview](https://developer.chrome.com/docs/workbox/caching-strategies-overview)
- [Chrome Developers — workbox-background-sync](https://developer.chrome.com/docs/workbox/modules/workbox-background-sync)
- [Chrome Developers — workbox-cacheable-response](https://developer.chrome.com/docs/workbox/modules/workbox-cacheable-response)
- [web.dev — Workbox learning path](https://web.dev/learn/pwa/workbox)
- [MDN — Using IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)
- [MDN — IndexedDB key characteristics and basic terminology](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Basic_Terminology)
- [jakearchibald/idb-keyval — README](https://github.com/jakearchibald/idb-keyval)
- [MDN — Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [MDN — SubtleCrypto.encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
- [MDN — AesGcmParams](https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams)
- [MDN — SubtleCrypto.deriveKey()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)
- [W3C — Web Cryptography Level 2 (TR)](https://www.w3.org/TR/webcrypto-2/)
- [W3C — Web Cryptography API (TR)](https://www.w3.org/TR/webcrypto/)
- [W3C IndexedDB — Encrypted storage (issue #191)](https://github.com/w3c/IndexedDB/issues/191)
- [MDN — PWA push notifications tutorial](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Tutorials/js13kGames/Re-engageable_Notifications_Push)
- [web.dev — Periodic Background Sync API](https://web.dev/periodic-background-sync/)

## Key Findings

### 1. Workbox strategy matrix for an aquaculture PWA
| Resource type | Strategy | Rationale |
|---|---|---|
| GraphQL queries (mutations NEVER cached) | NetworkFirst with short timeout (3s) + fallback to cache | Frequently updated sensor/batch data. Network wins when online, cached data unblocks UI when offline. |
| GraphQL mutations | BackgroundSync queue (NOT cached) | Must replay in order on reconnect. See workbox-background-sync. |
| Media (batch photos, farm imagery) | StaleWhileRevalidate + `CacheableResponsePlugin({ statuses: [0, 200] })` | Large, rarely changes. Serve instantly, update in background. |
| Static assets (JS/CSS/fonts) | Precache with revision manifest | Versioned, deterministic. |
| App shell HTML | NetworkFirst with 3s timeout | Must reflect deploys but survive offline. |
| External maps / third-party | NetworkOnly or NetworkFirst with very short cache | Out-of-scope CSP risk if cached. |

**Critical:** NetworkFirst ALWAYS times out and falls back to cache if network is slow — never use it without an explicit `networkTimeoutSeconds`. Default is no timeout, which means on a flaky connection the UI hangs waiting.

### 2. GraphQL caching has a POST-body problem
The default Workbox route matching is URL-based. GraphQL queries are POSTs to `/graphql` with the operation in the body, so URL-only matching lumps all operations into one cache entry. Correct pattern: write a custom `Plugin.cacheKeyWillBeUsed` that reads the request body, hashes it, and appends it to the cache URL. Alternative: use persisted queries (APQ) which encode the operation hash in the URL — then the default URL matcher works.

### 3. IndexedDB + AES-GCM: the actual cryptographic rules
AES-GCM security hinges on **never reusing an IV with the same key**. Per W3C Web Crypto Level 2 and NIST SP 800-38D:
- IV MUST be 96 bits (12 bytes), generated with `crypto.getRandomValues()`.
- Each encryption operation gets a fresh random IV, stored alongside the ciphertext (IV is not secret).
- The GCM authentication tag (16 bytes, appended by SubtleCrypto) MUST be verified on decrypt — tampered ciphertext throws.
- Key rotation: a per-session key derived via `deriveKey` from a session secret + PBKDF2 (100k+ iterations) is the right model. Key MUST live only in memory (non-extractable `CryptoKey`) — never persist the raw key to IndexedDB.

**Per-session key means:**
- Key is derived on login from the access token + a random salt stored in sessionStorage (salt is not secret, but must be ephemeral).
- On logout, the CryptoKey reference is dropped, rendering all previously written ciphertext undecryptable. This is a feature: it's the cryptographic erase of offline data.
- On refresh: the session key SHOULD persist across refresh (don't re-derive, or you lose all offline data every 5–15 min).

### 4. Bounded offline queue with dedup window
idb-keyval is the right substrate: small, promise-based, uses `update()` for atomic read-modify-write. For a mutation queue:
- **Bound:** hard cap (e.g. 200 mutations). When full, reject new mutations with a user-visible error — never silently drop.
- **Dedup window:** if the same mutation (same operation + input hash) is enqueued within N seconds (e.g. 5s), merge/drop the duplicate. Prevents double-submit bugs.
- **Exponential backoff:** on replay failure, increment attempt count and delay the next retry (2^n * baseMs, capped). After N attempts (e.g. 5), move to a dead-letter store for user inspection.
- **Encrypted payloads:** mutation bodies may contain PII (observation notes, worker assignments) → encrypt at rest.

### 5. Background Sync + Push wiring
- `workbox-background-sync` Queue class persists failed requests in IndexedDB and replays on `sync` event. Browsers without native Sync fall back to replay-on-SW-startup.
- Push notifications: `self.addEventListener('push', ...)` must validate the payload origin (VAPID signature is verified by the browser, but the payload content must still be sanitized before rendering as a notification title/body — XSS via notification is a rare but real vector).
- Notification click MUST navigate via `clients.openWindow()` or `client.navigate()` with a URL that's validated against the app origin. A malicious push with `url: 'javascript:...'` must be rejected.

### 6. Data cleanup on logout is non-trivial
On logout:
1. Drop in-memory AES-GCM CryptoKey → ciphertext becomes garbage.
2. `idb-keyval.clear()` on all tenant-scoped stores.
3. Unregister background sync queues (`queue.clear()` if possible, or overwrite with sentinel).
4. Call `registration.showNotification` cleanup for any pending notifications.
5. Clear Workbox caches that contain tenant data: `caches.delete('graphql-cache')`.
6. If using `persistQueryClient`, call `queryClient.clear()` AND the persister's `removeClient()` (known latency — needs to await, not fire-and-forget).

## Security Concerns

1. **CRITICAL — IV reuse with same AES-GCM key.** Two messages encrypted with the same (key, IV) pair catastrophically break GCM's confidentiality AND authenticity. Must generate a fresh 12-byte IV per `encrypt()` call.
2. **CRITICAL — Persisting the CryptoKey to IndexedDB as extractable.** Defeats the point of encryption — anyone with disk access reads the key. Keys MUST be non-extractable and in-memory only.
3. **CRITICAL — Push notification with unvalidated click URL.** `clients.openWindow('javascript:...')` or cross-origin redirect. Validate URL scheme and origin.
4. **HIGH — Mutations enqueued without encryption.** PII on disk in plaintext.
5. **HIGH — Logout that doesn't clear Workbox caches.** Previous tenant's cached GraphQL responses are served to next login.
6. **HIGH — NetworkFirst without `networkTimeoutSeconds`.** UI hangs on flaky network.
7. **HIGH — GraphQL cache-key collision across operations.** Same `/graphql` URL, different operations → wrong data served.
8. **MEDIUM — Offline queue unbounded.** Memory/storage exhaustion as a DoS vector.
9. **MEDIUM — Dead-letter store inaccessible to user.** Silent data loss — users must be informed when a mutation permanently fails.
10. **MEDIUM — Service worker scope too broad.** A scope of `/` captures third-party iframes that should be excluded.

## Performance Concerns

1. **IndexedDB bulk writes:** `idb-keyval.update()` serializes operations — batch multiple mutations into a single `set` call where possible.
2. **AES-GCM on main thread blocks UI** for large payloads. Move encryption to a Worker for items > 100KB (e.g. photo attachments).
3. **Precache size** should be audited — aggressive precaching slows first SW install. Use revision hashing and split critical vs optional.
4. **StaleWhileRevalidate for media** is correct BUT produces a background network storm on app open if the gallery has 100+ images. Rate-limit revalidation.

## Architectural Implications for frontend-expert reviews

When reviewing `web/apps/aquamobil/`, service worker, offline queue, or encryption utilities:
1. Verify every AES-GCM `encrypt()` call uses a fresh 12-byte IV from `crypto.getRandomValues()`.
2. Verify the CryptoKey is created with `extractable: false`.
3. Verify the session key lives only in memory — not written to any storage.
4. Verify the session key is derived fresh on login and dropped on logout.
5. Verify `NetworkFirst` for GraphQL has `networkTimeoutSeconds: 3` (or similar bounded value).
6. Verify GraphQL cache keying includes the operation body hash — not URL alone.
7. Verify the mutation queue has a hard cap (200) AND dedup window AND exponential backoff AND dead-letter store.
8. Verify logout clears: CryptoKey, idb-keyval stores, Workbox caches by name, background sync queue, persistQueryClient, Zustand, tenant context.
9. Verify push notification handler validates payload origin and click URL scheme (must be same-origin https).
10. Verify dead-letter failures surface a user-visible error, not silent drop.
11. Verify heavy encryption (> 100KB) is offloaded to a Worker.
12. Verify the SW scope is correctly limited to the PWA subtree.
13. Verify `CacheableResponsePlugin` restricts statuses to `[0, 200]` — caching 4xx/5xx poisons the offline experience.
14. Verify pagination/list queries use cache key versioning tied to tenant ID — cross-tenant cache hits are CRITICAL.

## Domain Rule Additions for frontend-expert

### Offline-First (AquaMobil) — additions
- **MUST** use a fresh 12-byte IV from `crypto.getRandomValues()` for every AES-GCM encrypt. IV reuse = CRITICAL.
- **MUST** create CryptoKey with `extractable: false`. Extractable keys = CRITICAL.
- **MUST** derive session key on login, drop on logout. Persisted raw keys = CRITICAL.
- **MUST** set `networkTimeoutSeconds` on every NetworkFirst strategy. Missing = HIGH (UI hang).
- **MUST** include operation body hash in GraphQL cache key. URL-only keying = HIGH (data collision).
- **MUST** bound the offline mutation queue (hard cap, e.g. 200) with user-visible error on overflow. Unbounded = HIGH.
- **MUST** implement dedup window (e.g. 5s) for identical mutations. Missing = MEDIUM (double-submit bugs).
- **MUST** implement exponential backoff + dead-letter store for failed replays. Silent retry loop = MEDIUM.
- **MUST** dead-letter failures surface to user, not silent. Silent = HIGH (data loss).
- **MUST** clear on logout: in-memory CryptoKey, idb-keyval stores, named Workbox caches, background sync queue, persisted queryClient, Zustand, tenant contexts. Missing any = HIGH (cross-tenant leak).
- **MUST** validate push notification click URL: same-origin, https scheme only. Missing = CRITICAL (XSS via notification).
- **MUST** encrypt mutation payloads containing PII. Plaintext PII at rest = HIGH.
- **MUST** offload AES-GCM for payloads > 100KB to a Web Worker. On-main-thread large crypto = MEDIUM (UI jank).
- **MUST** restrict `CacheableResponsePlugin` to `statuses: [0, 200]`. Caching errors = MEDIUM.
- **MUST** include tenant ID in Workbox cache key for any tenant-scoped resource. Cross-tenant cache hit = CRITICAL.
