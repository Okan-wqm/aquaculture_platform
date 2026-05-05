# GDPR / KVKK — Data Protection Impact Assessment

**Regulations:**

- **GDPR** — Regulation (EU) 2016/679 — *General Data Protection Regulation*. Article 35 mandates a Data Protection Impact Assessment (DPIA) for "high-risk" processing.
- **KVKK** — Kişisel Verilerin Korunması Kanunu (Law No. 6698, Turkey) — data-controller registration (VERBIS) + cross-border transfer controls.

**Scope:** Personal data touched by `suderra-agent` v1.6.0 during normal operation. The agent is an **industrial edge gateway** — its primary data class is process telemetry (not PII). PII exposure is secondary and bounded.

## Personal data inventory

| Data class | Source | PII status | Storage | Retention | Legal basis |
|------------|--------|------------|---------|-----------|-------------|
| Sensor telemetry (temperature, pH, NH3, DO, turbidity, flow, pressure) | Field Level-1 PLCs / sensors | NOT PII alone | `src/scada_db.rs` SQLCipher at-rest; forwarded to cloud via MQTT | Cloud-side 2 years + archive per `docs/adr/024-compliance-retention-matrix.md` | Legitimate interest (operator operations management) |
| Device MAC address | Hardware NIC at boot | POTENTIALLY PII (aggregation risk) | SHA-256 hashed before any log / wire emission (`src/provisioning.rs` — ORPHAN-EDGE bind step) | Hash only — raw MAC never stored | Legitimate interest — device identification |
| Operator PIN (local console) | Operator input at local console | PII — personal credential | Hashed + salted via `src/keystore/secret.rs`; never logged in clear | Rotated per policy; purged on operator offboarding | Legal obligation (IEC 62443 FR1 authentication) + legitimate interest |
| RBAC actor identity (operator label) | Provisioned per-operator | PII when combined with PIN / cert | Persisted in audit log via `AuditActor` (`src/audit/entry.rs:86-108`); `label` is the authoritative human-readable identifier | Per retention policy (see below) | Legitimate interest (audit + non-repudiation) |
| mTLS client certificate subject (CN) | Cert generation at provisioning | PII when CN encodes human identity | `src/mtls/` + `docs/security/pki-hierarchy.md` | Cert lifecycle (typical 2 years, rotated per `docs/runbooks/secret-rotation.md`) | Legal obligation (IEC 62443 FR1 + ADR-015) |
| Audit log entries (action, operator, timestamp, target) | Every actuator write + config change + alarm transition | PII (contains operator identity) | `src/audit/chain.rs` HMAC-chained local log + cloud sync | Per `docs/adr/024-compliance-retention-matrix.md` — regulated actions 7 years | Legal obligation (IEC 62443 FR6) + legitimate interest (non-repudiation) |

**Non-PII classes:** Firmware version strings, alarm definitions (process parameter + threshold), function block configuration — these contain no personal data.

## Processing activities (GDPR Art 30 register — edge portion)

| Purpose | Data classes | Recipients | Retention | Transfer |
|---------|--------------|------------|-----------|----------|
| Process supervisory control (operator logins, actuator writes) | Operator PIN hash, RBAC actor, mTLS cert, audit entries | On-device only (local SCADA); cloud sync of audit entries | Audit 7 years per ADR-024; telemetry 2 years | Edge → cloud (within EU or Türkiye — see "Cross-border transfer" below) |
| Alarm acknowledgement + shelving | RBAC actor, timestamp, alarm context | On-device + cloud sync | 7 years (regulated actions) | Edge → cloud |
| Device telemetry forwarding | Telemetry + hashed device ID | Cloud backend + operator dashboard users | 2 years | Edge → cloud |
| Maintenance & diagnostic access | Operator PIN hash, RBAC actor, command log | On-device log + cloud sync | 7 years | Edge → cloud |

## Data subject rights (GDPR Art 15-22) — edge-side fulfilment paths

| Right | Edge-side path | Status |
|-------|----------------|--------|
| Art 15 Access | Cloud-side (SaaS backend owns the primary data export API via `apps/admin-api-service/`); edge-local audit log export via `src/audit/` + operator-console path | PASS (cloud) / PARTIAL (edge export CLI ROADMAP-Q3) |
| Art 16 Rectification | Cloud-side PII records corrected at source; edge operator records re-provisioned | PASS |
| Art 17 Erasure | Cloud-side tenant-termination cascade is **ROADMAP** — `eraseTenantData` handler is ORPHAN-EDGE (pending). Edge-side secure-wipe runbook ROADMAP-Q3. | PARTIAL |
| Art 18 Restriction of processing | Cloud-side admin toggle; edge agent respects per-tenant feature flags via `docs/adr/027-per-tenant-ingest-backend-toggle.md` | PASS |
| Art 20 Data portability | Cloud-side JSON/CSV export owned by SaaS backend | PASS (cloud) |
| Art 21 Objection | Cloud-side consent withdrawal; edge agent stops forwarding telemetry on tenant disable | PASS |
| Art 22 Automated decision-making | The agent does **not** make automated decisions that produce legal / similarly significant effects on a data subject — actuator writes affect machinery not persons. N/A. | N/A |

## Cross-border transfer (KVKK Art 9 + GDPR Chapter V)

**Primary deployment topology:** Turkish customers → Turkish-hosted cloud (İstanbul region). No cross-border transfer for the typical deployment.

**Secondary topology (export customers):** Turkey → EU: relies on Standard Contractual Clauses (SCCs) per GDPR Art 46; Turkish data-controller KVKK Art 9 compliance via explicit consent + adequacy evaluation of the EU destination.

**VERBIS registration:** The data-controller entity (SaaS operator — not the edge gateway vendor alone) registers with Türkiye's Veri Sorumluları Sicili (VERBIS). Registration references:

- Data controller: SaaS operator legal entity.
- Processing purposes: aquaculture / hydroponics process management, operator authentication, audit + compliance.
- Data subjects: operators (employees of customer), device owners.
- Recipients: cloud operator staff (with scoped roles), customer operators.
- Retention schedule: per ADR-024 compliance retention matrix.
- Security measures: TLS 1.3 in transit, SQLCipher AES-256 at rest, HMAC-chained audit (ADR-020).

## Edge-specific DPIA risk matrix

| Risk | Likelihood | Impact | Mitigation | Residual |
|------|------------|--------|------------|----------|
| Operator PIN exfiltration from device memory | LOW | HIGH | SQLCipher at-rest encryption; systemd sandbox `MemoryDenyWriteExecute`, `LockPersonality`; keystore zeroize on scope drop | LOW |
| Raw MAC address leaks via log / wire | LOW | MEDIUM | SHA-256 hashing at provisioning boundary; no log call sites emit raw MAC (verified during sens-api-gateway Batch 2 audit) | VERY LOW |
| Audit log tampering (hiding operator actions) | LOW | HIGH | HMAC-chained append-only log (ADR-020); chain verification on every read; tamper = detectable offset | VERY LOW |
| Cloud audit log gap during WAN outage | MEDIUM | MEDIUM | Durable offline queue (`src/offline_queue.rs`); graceful-shutdown flush ORPHAN-EDGE-006 is GAP — data-loss bounded by `TimeoutStopSec` until fix lands | MEDIUM → LOW once ORPHAN-EDGE-006 closes |
| Tenant-termination erasure incomplete | MEDIUM | HIGH | Tenant-termination `eraseTenantData` handler is ROADMAP (ORPHAN-EDGE) — today erasure is a manual cloud-side runbook. ROADMAP-Q3. | HIGH → LOW once handler lands |
| Cross-tenant data leak on the edge (multi-tenant agent) | LOW | HIGH | `docs/adr/022-edge-schema-placement.md` + per-tenant scoping enforced at `src/authz/`; edge agent is predominantly single-tenant per-device per deployment | LOW |
| Operator-authentication bypass via local console | LOW | HIGH | Cert + PIN (PARTIAL — local MFA ROADMAP-Q3 per FR1 SL2 blocker in [iec62443-4-2-gap.md](./iec62443-4-2-gap.md)) | MEDIUM → LOW once MFA lands |

## DPIA conclusion

The edge component's PII exposure is **bounded and defensible**. The high-risk items are all on an owner + deadline track:

- **HIGH → blocking:** Tenant-termination cascade (ORPHAN-EDGE `eraseTenantData` handler). GDPR Art 17 enforceability cannot be fully claimed until this lands. ROADMAP-Q3.
- **MEDIUM → tracked:** Offline-queue flush on graceful shutdown (ORPHAN-EDGE-006) — data-loss window is `TimeoutStopSec`-bounded, not unbounded.
- **MEDIUM → tracked:** Local-console MFA (operator PIN + cert) — ROADMAP-Q3, also a FR1 SL2 blocker.

No novel high-risk processing is introduced that requires GDPR Art 36 prior consultation with the supervisory authority.

## Cross-references

- `docs/adr/024-compliance-retention-matrix.md` — retention schedule per data class.
- `docs/security/pki-hierarchy.md` — mTLS cert lifecycle.
- `docs/security/crypto-inventory.md` — algorithmic evidence for KVKK "appropriate technical measures".
- `docs/runbooks/secret-rotation.md` — cert + key rotation SLA.
- [soc2.md](./soc2.md) — SOC 2 Privacy Trust Services Category cross-map.
- `docs/reviews/orphan-findings.md#ORPHAN-006` — offline-queue flush gap.

Compliance snapshot: 2026-04-24, v1.6.0, HEAD=3413db47
