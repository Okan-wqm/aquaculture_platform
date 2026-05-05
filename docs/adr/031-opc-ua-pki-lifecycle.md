# ADR-031: OPC UA PKI Lifecycle — Rotation + Pin Ledger + 3-Phase Rollout

**Status:** Accepted (Phase B-1, 2026-05-04)
**Supersedes:** none
**Superseded by:** none
**Plan reference:** `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-1 (Batches #266-#268)
**Plan-intended ID:** ADR-024 (renumbered to 031 because 024 was already taken twice in `docs/adr/` — `024-compliance-retention-matrix.md` + `024-edge-hardware-adapter-inventory.md`. The plan-doc cross-references that read "ADR-024" mean THIS ADR)
**SL-2 FR coverage:** FR1 (Identification & Authentication), FR3 (System Integrity)
**Sibling ADRs:** ADR-018 (Edge RBAC/ABAC), ADR-020 (Audit Log HMAC Chain), ADR-021 (Platform Key Ceremony Lifecycle), ADR-029 (Shared mTLS Handshake Pattern — same 3-phase rollout discipline applied to MQTT transport in `mtls/` module)

---

## Context

The edge agent runs an OPC UA server (`async-opcua 0.18`) that 3rd-party HMIs (Ignition, UaExpert, Kepware, Wonderware) browse and subscribe to. The server-side PKI surface accepts client certs via `ServerBuilder::trust_client_certs(true)` — the pre-Faz-B-1 trust mode.

**`trust_client_certs(true)` is structurally a Trust-On-First-Use (TOFU) blob:**

- **No rotation primitive.** A client cert presented at session establishment that passes basic X.509 chain validation is accepted forever. There is no mechanism to retire a previously-trusted cert short of manually deleting the PEM from `pki_dir/trusted/clients/`.
- **No revocation list.** A compromised HMI cert remains valid until the operator notices and runs a manual filesystem cleanup. Industry-standard CRL/OCSP responders are not consulted by `async-opcua 0.18`'s built-in trust path.
- **No fingerprint pin.** Any cert chained to a configured CA passes — including a CA-issued cert that was NEVER intended for this device's HMI surface. An attacker with control of the customer's intermediate CA can mint a fresh leaf cert and authenticate as any operator.
- **No staged rollout.** Operators migrating from `trust_client_certs(true)` to a stricter posture have no way to dry-run the new policy on their fleet — toggling the flag is all-or-nothing, with no observability into which sessions would have been rejected.

**Operator-driven cert swap structural risk:**

- Compromised HMI cert is valid until the *issuing CA* revokes it (hours-to-days under typical industrial CA practice — and self-signed HMI certs have no CA revocation surface at all).
- A fingerprint-pin discipline at the edge gives byzantine-resistant cert identity *independent of CA chain trust*. The edge owns the trust decision; the cloud-signed rotation manifest owns the rotation orchestration.

This ADR establishes the architectural contract for fingerprint-pinned, rotation-aware, staged-rollout PKI for the OPC UA server surface.

---

## Decision

### 1. PkiStore primitive (Batch #266)

A filesystem-backed primitive at `sens-api-gateway/src/opc_ua_server/pki_store.rs`:

- **Own keypair path** — `<pki_root>/own/cert.der` + `<pki_root>/own/key.pem`. First-boot generates a self-signed ed25519 keypair anchored to the device's hardware identity (`device_code` from machine UID).
- **Trusted clients dir** — `<pki_root>/trusted/clients/`. PEM-encoded client certs that the OPC UA server accepts. async-opcua reads this dir at handshake time.
- **Revoked certs dir** — `<pki_root>/rejected/`. PEM-encoded client certs that the OPC UA server REJECTS. async-opcua's built-in trust path consults this for revocation.
- **Fingerprint ledger** — `<pki_root>/rotation_ledger.json`. Suderra-specific signed JSON file recording every cert add / revoke event with monotonic sequence numbers + ed25519 signatures (signed with the same `KeyPurpose::AuditHmacChain`-derived key as the audit log per Batch 4b ADR-020). The ledger is the SSoT for "what fingerprints are accepted right now"; the filesystem PEMs are downstream views consumed by async-opcua.

**Invariants:**

- Adding a trusted cert: write PEM atomically (`tempfile + rename`); compute SHA-256 fingerprint; append `LedgerEntry::CertTrusted { fingerprint, cert_label, sequence, signed_at }` to ledger; sign + fsync.
- Revoking a cert: move PEM from `trusted/` to `rejected/` atomically; append `LedgerEntry::CertRevoked { fingerprint, reason, sequence, signed_at }` to ledger; sign + fsync. Re-adding a revoked fingerprint MUST be rejected by the PkiStore API — operator must mint a new cert with a new fingerprint.
- First-boot: keypair generation + initial empty ledger genesis entry. The ledger's first-line genesis prev-hash is `b"opc_ua_pki_ledger_v1\0"` — distinct domain-separation tag from audit log + rbac manifest + acceptance token.

### 2. CertRotation 3-phase state machine (Batch #267)

A pure state machine at `sens-api-gateway/src/opc_ua_server/cert_rotation.rs`:

```text
LegacyAccept  → trust_client_certs(true) + log every cert presented; PkiStore tracks but does NOT enforce
WarnOnMismatch → trust_client_certs(true) + log warning on fingerprint-mismatch; PkiStore tracks; audit emits
StrictPinOnly → trust_client_certs(false) + ONLY fingerprints in PkiStore.trusted_fingerprints() accept
```

**State transitions:**

- Operator drives transitions via a cloud-signed `opc_ua_pki_manifest_v1` payload (analogous to the `mtls.pinned_leaf_fingerprints_hex` config field for MQTT, but file-driven via the manifest signing infra in ADR-021).
- The transition table mirrors the MQTT mTLS `MtlsVerifierState::rebuild` Tier-1 downgrade gate (PR #227 commit a2242f36): `StrictPinOnly` → `WarnOnMismatch` / `LegacyAccept` is REJECTED. `WarnOnMismatch` → `LegacyAccept` is REJECTED. Pin-set emptying under `StrictPinOnly` is REJECTED. Operators can ALWAYS tighten the floor.
- Rotation ledger append-only: previous-fingerprint records inside `LedgerEntry::PhaseTransition` form a 72-hour rollback window so a faulty transition can be reversed by an out-of-band emergency manifest before the audit chain irreversibly normalizes.

### 3. Server wire (Batch #268)

`sens-api-gateway/src/opc_ua_server_runtime.rs::build_server` is the integration point. Pre-B-1 the wire reads:

```rust
let mut builder = ServerBuilder::new()
    .application_name("suderra-edge")
    .create_sample_keypair(true)        // ← Batch #268 replaces with PkiStore-managed keypair
    .trust_client_certs(true)            // ← Batch #268 replaces with mode-aware logic
    .pki_dir(&config.own_pki_dir)        // ← Batch #268 routes through PkiStore::root()
    .add_endpoint("default", endpoint);
```

Post-B-1:

```rust
let pki_store = PkiStore::open_or_initialize(&config.own_pki_dir, ledger_signing_key)?;
let cert_rotation = CertRotation::load_from_ledger(&pki_store)?;
let mut builder = ServerBuilder::new()
    .application_name("suderra-edge")
    // PkiStore owns keypair generation; create_sample_keypair off when pkistore manages it.
    .create_sample_keypair(false)
    // Mode-aware: Legacy/Warn → trust_client_certs(true); Strict → false.
    .trust_client_certs(cert_rotation.mode().trust_unpinned_clients())
    // Trusted dir + rejected dir come from PkiStore root.
    .pki_dir(pki_store.root())
    .add_endpoint("default", endpoint);
```

In `StrictPinOnly` mode, `trust_client_certs(false)` makes async-opcua's built-in trust path consult ONLY the PEMs in `<pki_root>/trusted/clients/` — and the PkiStore is the SSoT for what's in there. Adding/revoking certs flows through PkiStore which writes the filesystem state async-opcua reads.

The PkiStore + CertRotation are constructed BEFORE the ServerBuilder; subsequent `cmd_update_opc_ua_pki` MQTT commands (analog of `cmd_update_cert_pinning`, future Phase B-2) drive rotations through the running PkiStore handle. The OPC UA server's pki_dir contents update live (no async-opcua restart needed); next handshake picks up the new trusted set.

### 4. Audit emit

Every PkiStore mutation emits an audit event through the existing `AuditSink` HMAC chain (ADR-020). New AuditAction variants:

- `OpcUaCertTrusted` (wire_tag append at next free)
- `OpcUaCertRevoked`
- `OpcUaPkiPhaseTransition`
- `OpcUaCertRejected` — emitted from the (future Batch B-2) custom `ClientCertVerifier` callback when an unpinned fingerprint reaches a `StrictPinOnly` server.

Phase B-1 Batch #266-#268 lands the first three; the per-handshake `OpcUaCertRejected` requires an async-opcua callback hook that the 0.18 API does not currently expose — Phase B-2 follow-up tracks the upstream PR or layers a session-establishment interceptor.

### 5. Invariant test

`sens-api-gateway/tests/invariants/opc_ua_leaf_pin_enforced.rs` pins the wire shape:

- `PkiStore` symbol present + `open_or_initialize` constructor present.
- `CertRotation` 3-phase enum present with `LegacyAccept` / `WarnOnMismatch` / `StrictPinOnly` variants.
- `build_server` references `pki_store.root()` and `cert_rotation.mode().trust_unpinned_clients()` — regression that hardcodes `trust_client_certs(true)` again fails the test.
- Every PkiStore mutation method (`add_trusted_cert`, `revoke_cert`, `transition_phase`) emits an audit event (source-grep for the AuditAction variant inside the method body).

---

## Consequences

### Positive

- **Tier-1 MAKE-IT-IMPOSSIBLE on the StrictPinOnly path:** an unpinned leaf cert *cannot* authenticate to the OPC UA server because async-opcua's trust path with `trust_client_certs(false)` consults only the trusted dir, and the trusted dir is PkiStore-controlled. A poisoned CA chain cannot mint an accepted cert.
- **Operator-coordinated rollout:** the 3-phase state machine mirrors the MQTT mTLS pattern (ADR-029 + Phase 1.1.4 PR #227). Same operator mental model spans both transports — one manifest format, one rollout discipline.
- **Audit-chain forensic anchoring:** every cert add/revoke/phase-transition is HMAC-chained. Auditors can reconstruct the rotation timeline offline via `audit-verify` CLI.
- **Append-only ledger + 72h rollback:** a faulty manifest's effect is reversible within 72 hours via an out-of-band emergency manifest. Beyond 72h the rollback discipline is "mint a fresh leaf + new rotation" — the ledger never deletes history.

### Negative

- **Phase B-1 does NOT close the per-handshake `OpcUaCertRejected` audit emit.** async-opcua 0.18 does not expose a `ClientCertVerifier` callback hook on `ServerBuilder`. The fail-closed behavior in `StrictPinOnly` is delivered (unpinned cert → handshake reject by async-opcua's built-in trust path) but the *forensic emit* on the reject is shimmed via async-opcua's existing tracing log capture, not a direct audit emit. Phase B-2 tracks closing this gap (either via async-opcua upstream PR or a session-establishment interceptor at the runtime layer).
- **Cloud-side manifest signing infrastructure is required for the full rotation flow** (`opc_ua_pki_manifest_v1` deser path). Phase B-1 lands the AGENT-side primitives + a `cmd_update_opc_ua_pki` placeholder; the cloud side ships in Phase C (operator manifest signing ceremony).
- **`create_sample_keypair(true)` removal is a breaking change for legacy deployments** that auto-generated keys via the async-opcua built-in path. Migration: operators upgrading from a pre-Phase-B-1 agent must run `suderra-agent --opcua-keypair-migrate` once on first boot to copy the existing async-opcua-generated keypair into the PkiStore-managed location. The migration tool is delivered in Batch #268.

### Trade-offs considered + rejected

- **Rejected: extending async-opcua 0.18's built-in trust path with our own pin file dropped into `pki_dir/trusted/clients/` + a sidecar checker.** Rejected because the sidecar runs *after* async-opcua accepts the cert; reject decision would race with session activation. The PkiStore-managed dir + `trust_client_certs(false)` gate is the architecturally clean shape.
- **Rejected: switching to `rustls-based` OPC UA stack.** async-opcua 0.18 uses `openssl`-backed PKI; switching to `rustls` would require either upstream rewrite or vendoring a fork. Out of scope for Phase B-1 and would not change the architectural shape at the agent level.
- **Rejected: `trust_client_certs(true)` + per-handshake post-trust pin check.** Same race-condition class as the sidecar — accept-then-reject is not atomic.

---

## Implementation map (Batch #266-#268, Phase B-1)

| Batch | File | Purpose |
|-------|------|---------|
| #266a | `src/opc_ua_server/pki_store.rs` | `PkiStore` primitive — filesystem + ledger + fingerprint |
| #266b | `src/opc_ua_server/pki_store.rs::tests` | first-boot keypair, trusted add fingerprint, revoked re-add reject |
| #267a | `src/opc_ua_server/cert_rotation.rs` | 3-phase state machine + transition validator |
| #267b | `src/opc_ua_server/cert_rotation.rs::tests` | downgrade rejection + promotion + ledger rollback window |
| #268a | `src/opc_ua_server_runtime.rs::build_server` | wire pki_store + cert_rotation into ServerBuilder |
| #268b | `tests/invariants/opc_ua_leaf_pin_enforced.rs` | source-grep wire invariant |

---

## Open items (Phase B-2 / Phase C follow-ups)

- **Per-handshake `OpcUaCertRejected` audit emit** (Phase B-2). Requires async-opcua 0.18 callback hook OR runtime-layer session interceptor.
- **Cloud-signed `opc_ua_pki_manifest_v1` deser path** (Phase C). Plumbs the manifest into a future `cmd_update_opc_ua_pki` MQTT command analogous to Phase 1.1.2 `cmd_update_cert_pinning`.
- **Operator migration tool** (`suderra-agent --opcua-keypair-migrate`, Batch #268c) — copies pre-B-1 async-opcua-generated keypair into PkiStore-managed location for upgrade-in-place deployments.
- **HMI Ignition + UaExpert E2E rotation round-trip** (Plan §B-6 W9). Validates the full Legacy → Strict transition against real HMI client implementations.

---

## References

- Plan: `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` §B-1 + Batches #266-#268
- ADR-018 §6 (additive-only Permission enum — same wire-stability discipline applies to AuditAction extensions for OPC UA cert events)
- ADR-020 §1-§4 (audit HMAC chain — PkiStore ledger uses the same chain primitive)
- ADR-021 §1, §8 (platform key ceremony — cloud-side manifest signing key separation)
- ADR-029 (shared mTLS handshake pattern — same 3-phase rollout discipline for MQTT)
- async-opcua 0.18 docs: ServerBuilder reference (`pki_dir`, `trust_client_certs`, `create_sample_keypair`)
