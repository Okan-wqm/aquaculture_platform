# event-store `stored_events` crypto-shred — design + threat model

**Closes:** the last open piece of DB-INFRA-HIGH-003 (see `ORPHAN-HIGH-351`). The deletable event-store tables are already erased via `source-schema-tenant-column`; `stored_events` is immutable append-only and cannot be row-deleted (breaks event-sourcing), so GDPR Art-17 erasure of its PII-bearing `payload`/`metadata` is achieved by **crypto-shredding** — destroy the tenant's key, the ciphertext becomes unrecoverable, the event envelope (position/type/version) survives for replay integrity.

## Why crypto-shred (not deletion, not the existing transformer)

- `stored_events` is append-only + immutability-triggered (`EventLedgerHardening`). Deleting a tenant's rows renumbers/gaps the global position stream and corrupts projections/replay.
- The platform's `createEncryptedColumnTransformer` (AES-256-GCM) uses ONE key per column (env-sourced). Destroying it shreds ALL tenants. Crypto-shred needs a **per-tenant Data Encryption Key (DEK)**.

## Architecture

**Envelope encryption (KEK/DEK):**

- One master **Key-Encryption-Key (KEK)** from env (`EVENT_STORE_PAYLOAD_KEK`, 32-byte hex; production sources it from the secret store, never committed).
- Per-tenant **DEK** (random 32 bytes), stored WRAPPED (AES-256-GCM-encrypted by the KEK) in a new key store.

**Key store — `event_store.tenant_payload_keys`** (cross-tenant infra table, registered in `MODULE_SCHEMAS['event_store'].infrastructureTables`):
| column | note |
|---|---|
| `tenant_id uuid PK` | one DEK per tenant |
| `wrapped_dek text NOT NULL` | `enc:<v>:<iv>:<tag>:<ct>` of the raw DEK under the KEK |
| `key_version smallint` | KEK rotation without re-wrap-all |
| `created_at timestamptz` | |
| `shredded_at timestamptz NULL` | set on erasure; when set the DEK is destroyed |

**`TenantPayloadCryptoService`** (built + tested in this change, NOT yet wired to the live path):

- `encrypt(tenantId, plaintext)` → get-or-create the tenant DEK, AES-256-GCM encrypt.
- `decrypt(tenantId, ciphertext)` → if the tenant key row is shredded, throw `TenantPayloadShreddedError`; else unwrap DEK + decrypt. Plaintext (`enc:`-less) passes through (pre-encryption backward-compat).
- `shred(tenantId)` → overwrite `wrapped_dek` with random bytes + set `shredded_at`, evict cache. Idempotent. After this, no ciphertext for that tenant is recoverable.

## Integration (GATED ON SECURITY REVIEW — not in the foundation commit)

1. **Append path** (`event-store.service.ts#appendToStream`): before insert, replace `payload`/`metadata` with `crypto.encrypt(tenantId, JSON.stringify(...))`. New events only.
2. **Read path**: on read, `crypto.decrypt`; on `TenantPayloadShreddedError` return a tombstone event — envelope preserved, `payload = { __gdpr_erased: true }` — so replay/audit see a shredded marker, not a crash.
3. **Erasure handler**: the event-store erasure target currently EXCLUDES `stored_events` from deletion (registry `excludedTables`). Add a service-local `TenantErasureRequested` step that calls `crypto.shred(tenantId)` (the shred IS the erasure for stored_events), recorded in the same proof.
4. **Backfill of existing plaintext events**: two options for the review — (a) lazy: encrypt-on-next-read is impossible (append-only); so (b) a one-time backfill migration that reads each tenant's plaintext events, encrypts under the new DEK, and rewrites the ciphertext IN PLACE (allowed: the immutability trigger must be temporarily bypassed under an audited maintenance window, or the backfill runs before the trigger is armed). This is the highest-risk step and needs a staged, per-tenant, resumable job with verification.

## Threat model (STRIDE, abbreviated)

- **Spoofing/Tampering:** AES-256-GCM is authenticated — a tampered ciphertext or wrong key fails `final()`. Key store rows are tenant-isolated by RLS + PK.
- **Repudiation:** shred sets `shredded_at` + emits the erasure proof event (existing ledger) — auditable.
- **Info disclosure:** the KEK is the crown jewel; it lives only in the secret store / env, never in the DB (only wrapped DEKs are stored). A DB dump without the KEK yields nothing. Post-shred, even the KEK cannot recover the tenant's data (DEK destroyed).
- **DoS:** DEK unwrap is cached per-tenant; encrypt/decrypt is O(payload).
- **Elevation:** `shred` is only reachable from the erasure handler (cert-gated `TenantErasureRequested`).

## Rollout order (each a reviewed step)

1. **(this commit)** key store table + migration + `TenantPayloadCryptoService` + unit tests. Inert — not called by the live path.
2. Wire the erasure handler `shred` (safe: only affects erased tenants; no live-path change).
3. Wire append-path encryption for NEW events (feature-flagged; validate replay end-to-end on infra).
4. Backfill existing plaintext events (staged, resumable, verified) — only after 2+3 are proven.

Keeping the crypto core isolated + tested first is deliberate: mis-encrypting a live event-sourcing write path corrupts replay irrecoverably, so the encryption primitive is proven in isolation before it ever touches `appendToStream`.
