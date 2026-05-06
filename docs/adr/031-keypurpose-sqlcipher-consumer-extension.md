# ADR-031: KeyPurpose enum extension for D-3 SQLCipher consumer-migration arc

**Status:** Accepted
**Date:** 2026-04-28
**Owner:** edge platform team
**Related:** Plan §5 Faz 2 D-3 (UH-017), ADR-018 §6 (key rotation discipline), Batches #329-#340 (D-3 primitives)
**Closes:** ORPHAN-MEDIUM-031 (KeyPurpose enum projects 4 SqlCipher consumers but defines only 2 variants — surfaced by auth-security-expert audit during Batch #332 review)

## Context

The D-3 SQLCipher v1→v2 migration arc landed across Batches #329-#340 in PR-194 ships every architectural primitive needed for the rekey roundtrip:

- Sidecar manifest (#329) — `.key-source.json` + atomic write via shared SSoT helper (#338).
- Boot-time backlog detector (#330) — operator-visible WARN signal for the migration backlog.
- v1 legacy-key derivation kernel (#331, #335) — pure-crypto SSoT delegated to from `offline_queue::derive_db_encryption_key`.
- v2 keystore-derived key shim (#332, #336, #337) — async wrapper around `Keystore::derive_key` with wrong-purpose runtime guard, Zeroize harness, `KeyPurpose::is_sqlcipher_variant` SSoT predicate.
- Wire-status invariant family (#333, #339, #340) — Tier-3 detection seams + operator runbook.

PR-195 will ship the orchestration layer: `db-migrate-cli` rekey binary + per-consumer migration adoption + operator runbook for the migration ceremony.

The unblocked path to PR-195 has ONE remaining architectural prerequisite: the `KeyPurpose` enum at `src/keystore/purpose.rs` defines only 2 of the 4 projected SQLCipher consumers. This ADR fills the gap.

## Current state (pre-ADR-031)

`KeyPurpose` defines:

| Variant                       | hkdf_info string                                | Consumer               |
|-------------------------------|-------------------------------------------------|------------------------|
| `SqlCipherOfflineQueue`       | `b"suderra:sqlcipher:offline-queue:v2"`         | `offline_queue.rs`     |
| `SqlCipherRetainPersistence`  | `b"suderra:sqlcipher:retain-persistence:v1"`    | `scripting/persistence.rs` (RETAIN VM state) |
| `AuditHmacChain`              | `b"suderra:audit:hmac-chain:v1"`                | `audit/sink.rs`        |
| `ReplayCache`                 | `b"suderra:replay-cache:v1"`                    | jti dedup (Moka+SQLCipher) |
| `DekEscrow`                   | `b"suderra:dek-escrow:v1"`                      | DEK escrow recovery    |
| `ConfigVerify`                | `b"suderra:config-verify:v1"`                   | config integrity       |

Two of the four projected SQLCipher consumers have no enumerated purpose:

- `src/license_cache.rs` — license-tier enforcement DB. Currently uses `offline_queue::derive_db_encryption_key` (the v1 path). Migration to v2 needs `SqlCipherLicenseCache`.
- `src/scripting/bytecode_retain.rs` — ST VM bytecode retention persistence. Distinct from `scripting/persistence.rs` (which IS covered by `SqlCipherRetainPersistence`). Migration to v2 needs `SqlCipherBytecodeRetain`.

(`scripting/persistence.rs` is already covered by `SqlCipherRetainPersistence` per the existing variant's per-variant doc comment + matches on `program-artifact-SHA256` context bytes.)

## Decision

**Extend `KeyPurpose` with two new variants:**

| Variant                       | hkdf_info string                                  | Context-bytes contract |
|-------------------------------|---------------------------------------------------|------------------------|
| `SqlCipherLicenseCache`       | `b"suderra:sqlcipher:license-cache:v2"`           | deployment-instance UUID (same as `SqlCipherOfflineQueue` — license cache is a sibling deployment artifact, not a per-program-tied cache) |
| `SqlCipherBytecodeRetain`     | `b"suderra:sqlcipher:bytecode-retain:v1"`         | program artifact SHA-256 (same as `SqlCipherRetainPersistence` — bytecode retain shares the program-bound lifecycle with the persistence module) |

### Why these specific choices

1. **`v2` suffix on the LicenseCache variant** matches `SqlCipherOfflineQueue`'s v2 suffix — both modules will land at the v2-keystore-derived target directly when PR-195 wires them; there is no v1-on-keystore intermediate. The `:v1` suffix on `SqlCipherBytecodeRetain` matches `SqlCipherRetainPersistence`'s scheme — these are first-time enumerations, no migration history.

2. **Context-bytes choice mirrors the closest sibling consumer.** `SqlCipherLicenseCache` uses deployment-instance UUID because the license cache is bound to the device, not to any program artifact. `SqlCipherBytecodeRetain` uses program-artifact SHA-256 because retain state is program-bound (a re-deployed program with new bytecode loses retain access — this matches the existing `SqlCipherRetainPersistence` contract per ADR-017 §7).

3. **`#[non_exhaustive]` is preserved.** The enum was made `non_exhaustive` in Batch #329 to enable forward-compat for v3 additions. Adding two variants today does not affect that property — external pattern-matchers retain their wildcard arms.

### Why this needs an ADR

The `KeyPurpose` enum's per-variant doc comment declares the stability contract:

> Adding a variant is an ADR-level decision because the derivation domain is part of the compatibility contract (changing an existing variant's HKDF info would invalidate every previously-derived key on-fleet).

The contract pre-binds new variants to ADR review. This document is that ADR.

### Migration impact

**Pre-PR-195 (post-ADR-031, no consumer flip):**

- The new variants exist in the enum + are accepted by the v2 shim's `is_sqlcipher_purpose` predicate.
- No existing consumer call site uses them yet.
- The boot detector + manifest sidecar primitives are unchanged.
- Existing fleet devices have v1 DBs for license_cache + bytecode_retain (no manifests). The boot detector classifies these as legacy-v1-default backlog entries — operator sees the migration backlog but no action required until PR-195 ships.

**PR-195 (consumer flip):**

- `license_cache.rs` constructs its DB using `derive_v2_sqlcipher_key(keystore, KeyPurpose::SqlCipherLicenseCache, deployment_uuid_bytes)` instead of calling `offline_queue::derive_db_encryption_key`.
- `scripting/bytecode_retain.rs` similarly switches to `SqlCipherBytecodeRetain` + program-SHA256 context.
- `db-migrate-cli` rekey binary uses the new variants for the v1→v2 PRAGMA rekey path.
- Existing v1 DBs in the field migrate via the operator-run rekey ceremony documented in `docs/runbooks/db-migration-detection-failure.md` (already shipped) + the future `docs/runbooks/db-migration-rekey.md` (PR-195 scope).

### Why we don't need a v1→v2 fleet rotation

The new variants are FIRST-TIME enumerations. No deployed device has previously derived a key under `b"suderra:sqlcipher:license-cache:v2"` or `b"suderra:sqlcipher:bytecode-retain:v1"`. So adding them does NOT invalidate any existing derived key. The migration concern is only the v1→v2 transition for the `offline_queue` + `retain_persistence` consumers (which were already on v1 per `derive_db_encryption_key`); those transitions are handled by the rekey binary in PR-195.

## Consequences

**Positive:**
- PR-195 consumer-migration arc unblocked.
- The `KeyPurpose` enum + `is_sqlcipher_variant` predicate become the canonical SSoT for "which consumers can run SQLCipher rekey" — extending the predicate at the enum (Batch #337) is a one-line change per new variant; the wire-status invariant 15 + consumer-flip call sites are the only other update points.
- The v2 shim's wrong-purpose runtime guard (Batch #332/#336/#337) automatically extends to the new variants without code change — `is_sqlcipher_variant` returns `true` for all `SqlCipher*` variants by construction.

**Negative:**
- Two new branded HKDF info strings on the fleet-stability contract surface. Any future change to either string is an ADR-level decision (per the enum's stability contract).
- The wire-status invariant 15 (db_migration_wire_status.rs) needs to assert all 5 SqlCipher* variants in the predicate — landing this ADR's enum extension WITHOUT updating the invariant would let the predicate silently lose coverage.

## Implementation

Lands in Batch #341 (this commit batch):

1. Add `SqlCipherLicenseCache` + `SqlCipherBytecodeRetain` variants to `KeyPurpose` in `src/keystore/purpose.rs`.
2. Add their `hkdf_info` match arms.
3. Extend `KeyPurpose::is_sqlcipher_variant` to match the new variants.
4. Extend the `hkdf_info_strings_golden_pinned` + `hkdf_info_strings_pairwise_distinct` tests to cover all 8 variants.
5. Extend the v2 shim's `shim_rejects_all_non_sqlcipher_purposes` test (it iterates non-SqlCipher variants — the iteration list does NOT need to add the new SqlCipher variants because they're now correctly classified as SqlCipher).
6. Extend wire-status invariant 15 to assert the predicate matches BOTH new variants.

## Alternatives considered

**(a) Per-consumer KeyPurpose generic over a context type.** Rejected — would require const-generics-over-enums (not stable in Rust today) or trait-object indirection that defeats the const-fn ergonomics.

**(b) Single `SqlCipherGeneric` variant with a string discriminator.** Rejected — would lose the per-variant stability contract (typo in caller-supplied discriminator would silently produce a different key); the type-level distinct variants are the architectural property the enum's doc-comment commits to.

**(c) Defer the variants until PR-195.** Rejected — would couple the ADR review (cross-team) with the consumer-migration code review (single-team). Landing the ADR + enum extension as a standalone batch (#341) decouples them so PR-195 review focuses on the consumer-flip mechanics, not on the cross-cutting KeyPurpose contract.
