/**
 * Client idempotency keys for sendMessage — at-most-once sends from the panel.
 *
 * WHY (FAZ 1 / MSG contract): the backend's SendMessageInput.idempotencyKey is
 * a REQUIRED UUID and the write side is at-most-once per key — a replayed send
 * (react-query retry, double click, page reload after a failed send with the
 * draft restored) returns the PREVIOUS message instead of duplicating it. The
 * key must therefore be STABLE for one logical send:
 *
 *   - stable across react-query retries → computed ONCE by the caller, before
 *     `mutate`, and carried in the mutation variables (never re-derived inside
 *     the mutationFn, which re-runs per attempt);
 *   - stable across a page reload of the same draft → memoised in
 *     sessionStorage under `msg-idem:{channelId}:{draftHash}`, so restoring a
 *     failed draft and re-sending reuses the key and the server dedupes;
 *   - distinct per content → the draft itself is hashed into the storage key,
 *     so a DIFFERENT text gets a fresh key and becomes a new message.
 *
 * sessionStorage (not localStorage): keys are per-tab, die with the session,
 * and never leak a draft hash across logins.
 */

const STORAGE_PREFIX = 'msg-idem';

/**
 * Per-channel cap on memoised keys. Unbounded growth would pin every draft
 * ever typed; the cap keeps the newest KEYS_PER_CHANNEL_MAX draft keys per
 * channel (most recent first) and drops the oldest.
 */
const KEYS_PER_CHANNEL_MAX = 8;

function safeSessionStorage(): Storage | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    // Probe access: security policies can make the getter itself throw.
    sessionStorage.getItem(STORAGE_PREFIX);
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic 64-bit-ish draft hash (FNV-1a x2, 53-bit safe) → base36.
 * NOT cryptographic — it only separates drafts within one channel+session,
 * so a fast, allocation-free string hash is the right tool.
 */
export function draftHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc2b2ae35;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(c + i, 0x9e3779b1)) >>> 0;
  }
  return `${h1.toString(36)}-${h2.toString(36)}`;
}

/** RFC4122 v4 UUID; falls back to a getRandomValues-built v4 when randomUUID is absent (older jsdom). */
export function randomIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function channelStorageKey(channelId: string, hash: string): string {
  return `${STORAGE_PREFIX}:${channelId}:${hash}`;
}

function pruneChannelKeys(storage: Storage, channelId: string, keepKey: string): void {
  const prefix = `${STORAGE_PREFIX}:${channelId}:`;
  const stale: string[] = [];
  // sessionStorage iterates insertion order, so collecting non-kept keys then
  // re-writing the kept one (in pruneChannelKeys' caller) yields MRU order.
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(prefix) && key !== keepKey) stale.push(key);
  }
  if (stale.length < KEYS_PER_CHANNEL_MAX) return;
  for (const key of stale.slice(0, stale.length - KEYS_PER_CHANNEL_MAX + 1)) {
    storage.removeItem(key);
  }
}

/**
 * Drop the memoised key for (channelId, content) once that logical send has
 * SUCCEEDED (V1 MAJOR-1 fix). Without this, re-sending the identical text in
 * the same tab ("ok", "+1"…) replays the previous key and the server's
 * at-most-once contract silently swallows the second message. Failure paths
 * keep the memo so the retry/reload of a failed draft still dedupes.
 */
export function releaseIdempotencyKey(channelId: string, content: string): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(channelStorageKey(channelId, draftHash(content)));
  } catch {
    // Disabled storage — nothing to release.
  }
}

/**
 * The idempotency key for sending `content` to `channelId` in this tab.
 * Deterministic per (channelId, content) within the session — memoised in
 * sessionStorage so a reloaded/failed draft reuses it — and a fresh UUID for
 * a draft never sent before. Storage-less environments (SSR, blocked storage)
 * still get a valid key, just without cross-reload stability.
 */
export function computeIdempotencyKey(channelId: string, content: string): string {
  const hash = draftHash(content);
  const storageKey = channelStorageKey(channelId, hash);
  const storage = safeSessionStorage();

  const existing = storage?.getItem(storageKey);
  if (existing && existing.length > 0) return existing;

  const key = randomIdempotencyKey();
  if (storage) {
    try {
      // Re-write even the kept key so per-channel MRU pruning sees recency.
      storage.removeItem(storageKey);
      storage.setItem(storageKey, key);
      pruneChannelKeys(storage, channelId, storageKey);
    } catch {
      // QuotaExceeded / disabled storage — key remains valid, just unmemoised.
    }
  }
  return key;
}
