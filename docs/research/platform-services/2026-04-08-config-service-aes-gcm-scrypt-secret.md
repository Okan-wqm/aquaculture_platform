# Research: Config Service — AES-256-GCM Secret Encryption, Scrypt KDF, ENC_V1 Envelope, LRU Cache

**Topic:** Encrypting `secret`-typed config values at rest with AES-256-GCM + scrypt KDF, ENC_V1 envelope format, LRU cache invalidation on update, tenant+global fallback resolution, and change-history audit trail
**Date:** 2026-04-08
**Agent:** platform-services

## Sources
- [NIST SP 800-38D - Galois/Counter Mode (GCM) and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- [NIST SP 800-56C Rev 2 - Recommendation for Key-Derivation Methods](https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-56Cr2.pdf)
- [NIST SP 800-132 - Password-Based Key Derivation](https://csrc.nist.gov/pubs/sp/800/132/final)
- [RFC 7914 - The scrypt Password-Based Key Derivation Function](https://datatracker.ietf.org/doc/html/rfc7914)
- [Node.js v22 LTS - Crypto API (createCipheriv, scrypt, timingSafeEqual)](https://nodejs.org/api/crypto.html)
- [OWASP - Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP - Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

## Key Findings

1. **AES-256-GCM provides authenticated encryption with associated data (AEAD).** Per NIST SP 800-38D, GCM is an approved block cipher mode that provides confidentiality *and* integrity in a single operation. A ciphertext tampered in-flight or at-rest fails the tag verification on decrypt, and the decryption MUST throw — not silently return partial plaintext. This makes GCM strictly superior to CBC+HMAC for new designs.
2. **IV / nonce is the most dangerous parameter.** GCM requires a unique IV per encryption *with the same key*. Repeating an IV with the same key is catastrophic: an attacker can XOR two ciphertexts to recover the plaintext XOR, and can forge arbitrary messages by recovering the authentication subkey. NIST recommends 96-bit IVs (12 bytes) as the interoperable default. For high-volume encryption, the 2^32 birthday bound on random 96-bit IVs is reached around ~4 billion encryptions per key — rotate keys well before that.
3. **Scrypt KDF for password-to-key derivation.** Per RFC 7914, scrypt is a memory-hard KDF that resists GPU/ASIC brute-force better than PBKDF2. Parameters:
   - `N` (CPU/memory cost): must be a power of 2. RFC suggests `2^14` for interactive logins (< 100ms) and `2^20` for file encryption (< 5s). For a server-side config-service where decrypt happens on each cache miss, `2^14` to `2^15` is a reasonable middle ground.
   - `r` (block size): 8 is the standard.
   - `p` (parallelization): 1 for server-side single-threaded decrypt.
   - **Memory cost:** `128 * N * r * p` bytes ≈ 16 MB at `N=2^14`, 32 MB at `N=2^15`. Node.js default scrypt maxmem is 32 MB and must be raised explicitly for `N > 2^14`.
4. **Node.js `crypto.scryptSync`** interface:
   ```
   crypto.scryptSync(password, salt, keyLen, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
   ```
   The salt must be unique per derived key (typically 16 bytes random). For config-service where a *master* key is derived from an env secret, the salt can be global (one salt for the whole service) — but then the derived key is also global and must be kept in memory only.
5. **Two-layer key architecture for config-service secrets:**
   - **Master key (KEK — Key Encryption Key):** derived from `CONFIG_SECRET_MASTER_PASSWORD` env var via scrypt with a fixed salt per environment. Never persisted.
   - **Data encryption key (DEK):** 256-bit random, generated per secret OR per tenant. The DEK encrypts the actual config value with AES-256-GCM. The DEK is then wrapped (encrypted) with the KEK and stored alongside the ciphertext.
   - This pattern is **envelope encryption** — standard in AWS KMS, GCP Cloud KMS, HashiCorp Vault. It allows key rotation of the KEK without re-encrypting every secret (only unwrap and re-wrap DEKs).
   - For the simpler aqua-saas config-service that doesn't need per-secret key rotation, a single-layer design is acceptable: scrypt-derive one key per environment, encrypt all secrets with that key under unique 96-bit IVs. Rotation = re-encrypt all.
6. **The `ENC_V1:` envelope format.** A version-prefixed string that unambiguously identifies the algorithm, KDF, and layout:
   ```
   ENC_V1:{base64url(salt)}:{base64url(iv)}:{base64url(tag)}:{base64url(ciphertext)}
   ```
   Or more compact: `ENC_V1:{base64url(salt || iv || tag || ciphertext)}` with fixed-length parsing (16 + 12 + 16 = 44 bytes of header).
   The version prefix is mandatory — it allows future migration to `ENC_V2:` (say, ChaCha20-Poly1305 or X25519-sealed-box) without ambiguity. Decrypt code MUST dispatch on prefix and reject unknown versions.
7. **AAD binds context.** In AES-GCM, Additional Authenticated Data is covered by the tag but not encrypted. For config values, AAD should bind:
   - `tenantId` (or `GLOBAL` for tenant-less defaults)
   - `configKey` (the config entry's unique key)
   - `contextVersion` (the version of the AAD schema, for forward compatibility)
   Binding tenantId prevents an attacker who swaps ciphertexts across rows from revealing cross-tenant secrets — the tag verification fails.
8. **LRU cache for hot-path reads.** Config values are read on every request but updated rarely. An LRU cache with `MAX_CACHE_SIZE=1000` and `TTL=60s` bounds memory and bounds staleness. Cache entries MUST be the *decrypted* plaintext for performance (otherwise every read triggers GCM + scrypt). The cache keys must be tenant-scoped: `{tenantId}:{configKey}`.
9. **Cache invalidation on update.** When an `UpdateConfigValueCommand` handler writes a new value, it must:
   1. Write the new ciphertext to DB.
   2. Write the old → new change to `ConfigChangeHistory`.
   3. Publish a `ConfigValueChanged` event on NATS.
   4. Invalidate the local in-memory LRU entry for that key.
   The NATS event is consumed by *other* config-service replicas to invalidate their LRU entries. Without the NATS fan-out, replica B returns stale values for up to 60s after replica A handled the update — in a distributed SaaS, that's a stale-config bug that surfaces inconsistently.
10. **Tenant + global fallback resolution.** A config key resolution proceeds:
    1. Look for `{tenantId, configKey}` — tenant-specific override.
    2. If not found, look for `{tenantId: GLOBAL, configKey}` — platform default.
    3. If not found, return the hardcoded-in-code default (the `@DefaultConfig()` annotation on the consuming service).
    This lets operators set a platform-wide default and allow per-tenant overrides. The cache must respect the fallback semantics — caching an empty result for a tenant key is fine, but the cache lookup chain must mirror the DB lookup chain.
11. **Change history audit trail.** Every config mutation writes a `ConfigChangeHistory` row with:
    - `tenantId`, `configKey`
    - `previousValue` (ENCRYPTED if the config is `secret` type — never plaintext in history)
    - `newValue` (encrypted same as above)
    - `changedBy` (actor user ID)
    - `changedAt` (timestamp)
    - `changeReason` (free-text, required for `secret`-type changes)
    - `actorIp`, `actorUserAgent`, `correlationId`
    The history table is append-only; it does NOT inherit the parent row's encryption state automatically — the history writer must re-encrypt under the current key. This allows auditing "who changed the Stripe webhook secret on 2026-03-15 and why" without exposing the secret itself.
12. **Secret type enforcement.** The config entry's `type` column drives storage and retrieval behavior:
    - `string`, `number`, `boolean`, `json` → stored plaintext in a `value TEXT` column
    - `secret` → stored as `ENC_V1:...` in the same `value TEXT` column
    - Read path dispatches on `type`: for `secret`, always decrypt; for others, return as-is
    - GraphQL/REST exposure: `secret` values never serialized in query responses. A `GetConfigValue` query for a secret returns `{ type: 'secret', value: '***REDACTED***' }` unless the caller has a specific `CONFIG_SECRET_READ` permission.
13. **Bootstrap secret chain.** The KDF input (`CONFIG_SECRET_MASTER_PASSWORD`) cannot itself live in the config-service (chicken-and-egg). It must come from a higher-trust source: Kubernetes Secret, AWS Secrets Manager, HashiCorp Vault, or `.env` at boot. The `.env` path is acceptable for dev; production MUST use a KMS. The service must fail-fast on boot if the master secret is missing — silent fallback to unencrypted storage is a CRITICAL misconfiguration.

## Security Concerns

- **CRITICAL:** Repeating a 96-bit IV with the same key in AES-GCM destroys confidentiality and integrity. Every encryption MUST call `crypto.randomBytes(12)` for a fresh IV.
- **CRITICAL:** Catching the `decipher.final()` exception and returning plaintext-like fallback bytes. Authentication-tag failure means tampering — it MUST throw and the request MUST fail loudly.
- **CRITICAL:** `CONFIG_SECRET_MASTER_PASSWORD` hardcoded in source, committed to Git, or logged at startup. Must come from a secrets manager or boot-time env.
- **CRITICAL:** Storing `secret`-typed config values plaintext in the DB (e.g., because encryption "failed silently"). On decrypt path, reject any `secret` row whose value does not start with `ENC_V1:`.
- **CRITICAL:** Returning plaintext secret values in GraphQL/REST query responses accessible to non-admin users. Implement the `CONFIG_SECRET_READ` permission gate and redact by default.
- **HIGH:** Not binding `tenantId` as AAD means an attacker with DB write access can swap ciphertexts between tenants and exfiltrate a victim tenant's secret to their own tenant's read endpoint.
- **HIGH:** LRU cache not invalidated across replicas on update → stale secrets served for up to TTL seconds after rotation → rotation doesn't actually rotate until all replicas flush.
- **HIGH:** Storing previous/new values in `ConfigChangeHistory` as PLAINTEXT for `secret`-typed entries leaks every historical secret via the audit table.
- **HIGH:** Scrypt parameters too low (`N=2^10`) for a production environment — brute-force resistance is halved per bit of `N` reduction.
- **MEDIUM:** Missing `changeReason` on `secret`-type changes removes the paper trail for rotation incidents.
- **MEDIUM:** LRU cache holds plaintext secrets in memory indefinitely after TTL expiry if the entry is repeatedly accessed — add an absolute max-age (force re-decrypt every N minutes regardless of access pattern).
- **MEDIUM:** Bootstrap secret missing at startup → service continues and writes unencrypted. Fail-fast is the only correct behavior.

## Performance Concerns

- Scrypt at `N=2^14` with `maxmem=64MB` takes ~50-100ms. Deriving the master key on every decrypt is impossibly slow. Derive once at bootstrap, cache the 32-byte derived key in memory for the process lifetime, never persist.
- AES-GCM encrypt/decrypt is ~1 GB/s on AES-NI CPUs — negligible cost per config value.
- LRU cache hit rate should be > 99% for normal traffic. Measure and alert on miss-rate spikes (indicates cache thrash, config churn, or an attack scanning all keys).
- NATS cache-invalidation fan-out adds ~5ms end-to-end latency on updates — acceptable because updates are rare.
- `ConfigChangeHistory` grows monotonically. Partition by month; retain 5+ years for secret changes (compliance), 1 year for non-secret.

## Architectural Implications for platform-services reviews

- A single `SecretCipherService` in `apps/config-service/src/configuration/crypto/secret-cipher.service.ts` owns:
  - `deriveMasterKey(masterSecret, salt) → Buffer` via `crypto.scryptSync(masterSecret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64*1024*1024 })`. Called once at bootstrap.
  - `encrypt(plaintext, context: { tenantId, configKey }) → 'ENC_V1:...' string`. Generates fresh IV, runs GCM with AAD = JSON.stringify(context).
  - `decrypt(ciphertext, context) → plaintext string`. Parses version prefix, routes to the correct decrypt impl, throws on version mismatch or tag failure.
  - `isEncrypted(value) → boolean` — prefix sniff.
- `ConfigValue.value` is always `@Column('text')`; the entity's getter/setter uses `SecretCipherService` iff `type === 'secret'`. Accessing `.plaintextValue` without the `secret-read` permission throws.
- LRU cache lives in `ConfigResolverService` with `{ max: 1000, ttl: 60_000 }` and per-entry `maxEntryAge` = 300_000 absolute.
- `UpdateConfigValueCommand` handler:
  1. Loads current row.
  2. Writes new row (encrypted if `secret`).
  3. Writes `ConfigChangeHistory` row with encrypted previous/new values (for `secret` type).
  4. Invalidates local cache entry.
  5. Publishes `ConfigValueChanged` domain event on NATS with `{ tenantId, configKey }`.
- Other replicas subscribe to `ConfigValueChanged` and `cache.delete(key)`.
- `GetConfigValue` query handler:
  1. Cache lookup → return if hit (plaintext).
  2. DB lookup with tenant+global fallback.
  3. If `secret`, decrypt via `SecretCipherService`.
  4. Store in cache.
  5. Return; if caller lacks `CONFIG_SECRET_READ`, replace with `***REDACTED***`.
- Bootstrap fail-fast: `main.ts` verifies `CONFIG_SECRET_MASTER_PASSWORD` env var presence and non-empty, derives master key, exits with non-zero on failure.
- Integration tests: (a) encrypt/decrypt round-trip, (b) tampered ciphertext → throws, (c) wrong AAD (`tenantId` swap) → throws, (d) `ENC_V2:` prefix → rejected, (e) cache invalidation fan-out across 3 replicas via NATS, (f) bootstrap without master password → process exits non-zero.

## Domain Rule Additions for platform-services (Config Service Security subsection)

- **[CRITICAL]** `secret`-typed config values MUST be encrypted with AES-256-GCM. 96-bit random IV per encryption, 128-bit auth tag, ENC_V1 version prefix, AAD binding `{tenantId, configKey}`. Tag-verification failure MUST throw — no silent fallback.
- **[CRITICAL]** The master key MUST be derived from `CONFIG_SECRET_MASTER_PASSWORD` via scrypt (RFC 7914) with N >= 2^14, r = 8, p = 1. Raw password used as key is a blocking review failure.
- **[CRITICAL]** `CONFIG_SECRET_MASTER_PASSWORD` MUST come from a secrets manager or boot-time env (never hardcoded, never in Git, never logged). Missing at startup MUST fail-fast.
- **[CRITICAL]** `ConfigChangeHistory` previous/new values for `secret`-type entries MUST be encrypted with the same scheme as the live row. Plaintext history for secrets is a blocking review failure.
- **[CRITICAL]** GraphQL/REST responses MUST redact `secret`-type values unless the caller holds `CONFIG_SECRET_READ`. Default behavior is `***REDACTED***`.
- **[HIGH]** AAD MUST bind `tenantId` to prevent cross-tenant ciphertext swap. Missing AAD or AAD that binds only `configKey` is a HIGH finding.
- **[HIGH]** LRU cache MUST be invalidated across all replicas on update via NATS `ConfigValueChanged` event fan-out. Local-only invalidation is a HIGH finding.
- **[HIGH]** Decrypt code MUST dispatch on the ENC prefix (`ENC_V1:`) and reject unknown versions. A fall-through that treats unknown-prefix as plaintext is a HIGH finding.
- **[HIGH]** Every `secret`-type change MUST carry a `changeReason`. Missing reason rejects the command.
- **[MEDIUM]** LRU cache entries MUST have an absolute max age (e.g., 300s) in addition to TTL, forcing periodic re-decrypt and picking up silent rotations.
- **[MEDIUM]** `ConfigChangeHistory` for `secret`-type rows MUST be retained >= 5 years; non-secret rows >= 1 year. Partition by month.
- **[MEDIUM]** Scrypt master-key derivation MUST happen once at bootstrap; per-request re-derivation is a performance failure and a tight-loop DoS vector.

Research: `docs/research/platform-services/2026-04-08-config-service-aes-gcm-scrypt-secret.md`
