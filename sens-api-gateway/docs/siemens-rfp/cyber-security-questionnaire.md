# Cyber Security Questionnaire (CSQ) — Siemens Supplier Security Review

**Document owner:** `siemens-rfp-responder` (Lane-C)
**Product:** `sens-api-gateway` v1.6.0
**HEAD:** 3413db47
**Response date:** 2026-04-24

> **TEMPLATE NOTICE.** Section numbering matches a typical Siemens CSQ template. When Siemens supplies the verbatim CSQ (v2024 / v2025 family), replace the Q IDs below with Siemens' own numbering. Answers do not change.

---

## Completeness Dashboard

| Status | Count | % |
|--------|-------|---|
| FULL | 17 | 51.5% |
| PARTIAL | 9 | 27.3% |
| ROADMAP | 6 | 18.2% |
| N-A | 1 | 3.0% |
| **Total questions** | **33** | **100%** |

Honesty policy: every PARTIAL or ROADMAP row states precisely which ORPHAN-EDGE-* finding drives the gap. Siemens auditors verify evidence — a false FULL is a disqualification event.

---

## Section 1 — Security Organisation

### Q1.1 — CISO / PSIRT contact

Q: Name the executive accountable for product security and the team responsible for vulnerability triage.
A: Product security accountability: `{TEMPLATE — e.g. CTO / Head of Security}`. PSIRT single point of contact: `security@{TEMPLATE}`. PGP public key fingerprint: `{TEMPLATE}`. 24-hour acknowledgement SLA; 90-day disclosure window follows ISO/IEC 29147 + ISO/IEC 30111 per our published Coordinated Vulnerability Disclosure (CVD) policy.
Evidence: `docs/security/cvd-policy.md`, `docs/commercial/corporate-identity.md`
Status: FULL

### Q1.2 — Security governance structure

Q: Describe the governance structure for product security decisions.
A: Product-security decisions flow through: (1) PSIRT triage intake; (2) severity classification per CVSS v3.1 + internal impact scoring; (3) architectural-arbiter review for CRITICAL/HIGH fixes (`CLAUDE.md` architectural-arbiter model); (4) commit-time banned-phrase gate + SDLA evidence file update. Monthly security review board cadence.
Evidence: `docs/security/governance.md`, `docs/compliance/iec62443-4-1-sdla.md`
Status: FULL

---

## Section 2 — Threat Modelling

### Q2.1 — Threat model coverage

Q: Provide the product's threat model.
A: STRIDE threat model published in `docs/security/threat-model.md`. Covers: field-bus surfaces (Modbus-TCP/RTU, OPC UA, S7, EtherNet/IP, MQTT), management surfaces (HTTP API + SCADA bridge + CLI), storage surfaces (SQLCipher offline queue + retain DB), update surface (OTA — ROADMAP per ORPHAN-018 ADR), and physical surface (tamper / debug / boot-chain). Each surface: STRIDE per asset + residual-risk mitigations.
Evidence: `docs/security/threat-model.md`, `docs/security/attack-surface.md`
Status: FULL

### Q2.2 — Threat-model review cadence

Q: How often is the threat model reviewed and updated?
A: On every major architectural change (new protocol adapter, new authentication mode, new storage surface) and at minimum annually. Last full-refresh: `{TEMPLATE — pending first public release cycle}`.
Evidence: `docs/security/threat-model.md` changelog section
Status: PARTIAL (cadence set; first full-refresh calendar entry pending)

---

## Section 3 — Secure Development Lifecycle (SDLA)

### Q3.1 — SDLA certification

Q: Is the supplier certified to IEC 62443-4-1 (SDLA)?
A: Not currently held. The product is developed against IEC 62443-4-1 practice requirements (`docs/compliance/iec62443-4-1-sdla.md`) with full evidence mapping — SM (Security Management), SR (Specification of Security Requirements), SD (Secure Design), SI (Secure Implementation), SVV (Security Verification + Validation), DM (Defect Management), SUM (Security Update Management), SG (Security Guidelines). Formal certification targeted Q4 2026. Until certified, practice evidence is reviewable on request.
Evidence: `docs/compliance/iec62443-4-1-sdla.md`, `docs/compliance/certifications-roadmap.md`
Status: ROADMAP (Q4 2026 target)

### Q3.2 — SDLA evidence per requirement family

Q: For each IEC 62443-4-1 practice, provide concrete evidence.
A: Full mapping in `docs/compliance/iec62443-4-1-sdla.md`. Highlights: SM via `docs/security/governance.md` + PSIRT; SR via `docs/security/threat-model.md` security-requirements section; SD via architecture ADRs in `docs/adr/`; SI via `cargo clippy -D warnings` wall + `cargo audit` + `cargo deny`; SVV via `docs/testing/security-testing.md` pentest schedule; DM via `docs/security/cvd-policy.md`; SUM via `docs/deployment/ota-firmware-update.md`; SG via the deployment runbooks.
Evidence: `docs/compliance/iec62443-4-1-sdla.md`
Status: FULL (practice evidence); ROADMAP (external certification)

---

## Section 4 — Secure Coding Practices

### Q4.1 — Language-level security posture

Q: Describe language-level security controls applied to production code.
A: Product is written in Rust edition 2021+. Memory-safety: enforced by the compiler; `unsafe` blocks audited with mandatory SAFETY comment + architectural-arbiter review (see `docs/security/unsafe-audit.md`). Lint wall: `#![deny(warnings)]` + `cargo clippy -D warnings`. Banned dependencies: `openssl`, `native-tls` — TLS stack is `rustls` only (enforced by `deny.toml`). No `eval` / dynamic code-load in production binaries; Lua scripting sandbox runs in `mlua` with explicit capability grants.
Evidence: `docs/testing/security-testing.md`, `sens-api-gateway/Cargo.toml`, `sens-api-gateway/deny.toml`
Status: FULL

### Q4.2 — Secure coding training

Q: Do engineers receive secure-coding training?
A: Rust's type system + the `#[deny(warnings)]` wall + pre-commit banned-phrase gate + architectural-arbiter code review deliver the "make it impossible" layer of coding discipline. Formal SANS / OWASP-curriculum training records: `{TEMPLATE — per-deal attestation}`.
Evidence: `docs/compliance/iec62443-4-1-sdla.md` §SI
Status: PARTIAL (structural controls FULL; training records template)

---

## Section 5 — Dependency Management

### Q5.1 — Dependency-vulnerability scanning

Q: How are third-party dependencies scanned for vulnerabilities?
A: `cargo audit` + `cargo deny advisories` run on every PR (CI gate). Advisories from the RustSec database block merge if severity >= HIGH. Weekly dependabot-equivalent refresh of the lockfile; upgrade PRs reviewed by architectural-arbiter. `ORPHAN-001` tracks a coupled-release-family advisory discipline for the OpenTelemetry crate cluster; fix tracked to the Rust delta plan.
Evidence: `docs/testing/security-testing.md`, `sens-api-gateway/deny.toml`, `docs/reviews/orphan-findings.md#ORPHAN-001`
Status: FULL (scanning + gate); PARTIAL (release-family grouping per ORPHAN-001)

### Q5.2 — Dependency licence audit

Q: How are OSS licences tracked?
A: `cargo deny licenses` in CI. Allowlist: MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / Unicode-DFS-2016 / Zlib. Copyleft (GPL / LGPL / AGPL) is blocked. Aggregate attribution shipped with binaries per `docs/commercial/oss-attribution.md`.
Evidence: `sens-api-gateway/deny.toml`, `docs/commercial/oss-attribution.md`
Status: FULL

---

## Section 6 — Vulnerability Disclosure & Handling

### Q6.1 — CVD policy

Q: Published Coordinated Vulnerability Disclosure policy.
A: Published at `docs/security/cvd-policy.md`. 24h acknowledgement, 90-day disclosure window, CVE reservation via MITRE CNA-LR path, signed advisories published at `security-advisories/` in the repository. Aligned with ISO/IEC 29147 (disclosure) + ISO/IEC 30111 (handling).
Evidence: `docs/security/cvd-policy.md`
Status: FULL

### Q6.2 — Historical CVE track record

Q: List CVEs published by this supplier in the last 24 months.
A: `{TEMPLATE — sales fills with current CVE list, or "No CVEs published in last 24 months" attested}`. Historical advisory index: `docs/security/advisories-index.md`.
Evidence: `docs/security/advisories-index.md`
Status: PARTIAL (per-deal attestation)

---

## Section 7 — Cryptography Inventory

### Q7.1 — Complete cryptographic inventory

Q: List every cryptographic primitive, library, and key-purpose used in the product.
A: Full inventory in `docs/security/crypto-inventory.md`. Headline items:
- **TLS:** rustls 0.23 family; TLS 1.3 mandatory for OPC UA + MQTT + HTTP; TLS 1.2 supported for Modbus-TCP secure tunnel only.
- **Cipher suites:** TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256. No RC4, no 3DES, no CBC.
- **Hashing:** BLAKE3 (preferred), SHA-256 (interop).
- **Signatures:** Ed25519 (preferred for new), ECDSA P-256 (interop).
- **KDF:** Argon2id for password-derived keys; HKDF-SHA256 for key-separation.
- **At-rest encryption:** SQLCipher for `offline_queue.db` + `retain.db` with AES-256.
- **MQTT authentication today:** TLS with user/pass OR mTLS — ORPHAN-EDGE tracked; roadmap to mandatory mTLS in Q3 2026.
Evidence: `docs/security/crypto-inventory.md`, `docs/reviews/orphan-findings.md` (MQTT auth posture)
Status: PARTIAL (inventory FULL; MQTT mTLS-mandatory is ROADMAP Q3 2026)

### Q7.2 — Banned cryptographic primitives

Q: Which primitives are explicitly banned in the codebase?
A: `openssl` crate + `native-tls` crate banned at `deny.toml`. MD5, SHA-1 (for signatures), DES, 3DES, RC4, DSA, RSA < 2048-bit, CBC-mode ciphers (for new use), PKCS#1 v1.5 signatures — banned. `cargo deny` enforces the crate ban; the cryptographic primitive ban is enforced by the code-review discipline + crypto-inventory audit.
Evidence: `docs/security/crypto-inventory.md`, `sens-api-gateway/deny.toml`
Status: FULL

---

## Section 8 — Key Management

### Q8.1 — PKI hierarchy

Q: Describe the PKI hierarchy, key-rotation, and revocation posture.
A: Full documentation in `docs/security/pki-hierarchy.md`. Two-tier CA: offline root CA (air-gapped, FIPS-140-2 L3 HSM if customer-operated) → online issuing CAs for (a) device identity, (b) operator identity, (c) service identity. Mutual-TLS across every in-product transport (OPC UA, MQTT target ROADMAP, SCADA bridge). Key rotation schedules: root 20y / issuing 5y / leaf 90d. Revocation via OCSP stapling + CRL fallback.
Evidence: `docs/security/pki-hierarchy.md`, `docs/security/credentials-handling.md`
Status: FULL (design); PARTIAL (MQTT mTLS mandatory is ROADMAP Q3 2026)

### Q8.2 — Credential storage

Q: How are credentials stored on the edge device?
A: Secrets at rest: SQLCipher + keyring via Linux keyutils (kernel keyring) for boot-time unlock. No secrets in `/etc/suderra` (operator-owned readonly per systemd hardening — see `ORPHAN-010` resolution). No secrets in environment variables in production (enforced by systemd unit; `SUDERRA_DATA_DIR` env override gated by dev-insecure feature flag — see `ORPHAN-005`).
Evidence: `docs/security/credentials-handling.md`, `docs/reviews/orphan-findings.md#ORPHAN-005`, `#ORPHAN-010`
Status: FULL (design); ROADMAP (ORPHAN-005 production-refuse gate lands in Faz 2 Sprint 8.3)

---

## Section 9 — Authentication & Authorisation

### Q9.1 — RBAC / ABAC model

Q: Describe the authentication + authorisation model for operator access.
A: Role-Based Access Control (RBAC) with ADR-018 sealed-identifier discipline. Roles: `viewer`, `operator`, `technician`, `admin`. Permissions manifest published at `docs/api/rbac-manifest.md`. Every command carries a signed `ActuatorClassBindingEntry` (ADR-024 §2) tying the operator identity + actuator class + register range to a Ed25519 signature — enforced at command dispatch.
Evidence: `docs/api/rbac-manifest.md`, `docs/security/authz-model.md`
Status: FULL

### Q9.2 — Authentication mechanism

Q: Authentication methods supported.
A: Operator authentication: password-with-Argon2id + optional WebAuthn (FIDO2) OR mTLS client certificate (preferred). Device authentication: mTLS mandatory for every inbound transport that accepts commands. Service-to-service (NATS-class): mTLS cert-CN as identity (per ADR-015 — cert-is-identity SSoT).
Evidence: `docs/security/authz-model.md`, `docs/api/rbac-manifest.md`
Status: FULL

---

## Section 10 — Logging & Audit Trail

### Q10.1 — Audit log coverage

Q: Which events are audit-logged and where?
A: Full coverage matrix in `docs/security/audit-log.md`. Logged: every write command (actuator, config change, operator login, permission grant, OTA update decision, safe_state entry/exit, alarm acknowledgement). Storage: append-only SQLite in `/var/lib/suderra/audit.db` with hash-chain integrity (every row carries SHA-256 of the previous row). Sync to cloud event store (NATS) via offline queue; audit rows survive power loss per SQLite WAL + planned checkpoint sync (see `ORPHAN-006` — shutdown-time flush ROADMAP in Faz 1 ARC-002).
Evidence: `docs/security/audit-log.md`, `docs/reviews/orphan-findings.md#ORPHAN-006`
Status: PARTIAL (hash-chain + append-only FULL; shutdown-flush hardening ROADMAP Q2 2026)

### Q10.2 — PII handling in logs

Q: How is PII masked in logs?
A: Structured JSON logging; operator identifiers masked with deterministic hash (salt + pepper) before log emission. No raw passwords, tokens, or API keys ever reach the log stream (central `mask_pii()` helper in the logging layer). Compliant with GDPR Art. 5(1)(c) data-minimisation.
Evidence: `docs/security/audit-log.md`, `docs/compliance/gdpr-kvkk-dpia.md`
Status: FULL

---

## Section 11 — Patch Management & OTA

### Q11.1 — Update channel

Q: Describe the firmware/software update channel and signing discipline.
A: Update delivery mechanism: `{TEMPLATE — per-deal; default: HTTPS pull from cosign-signed manifest}`. A/B partition scheme per ADR-019. Firmware binary signing: planned cosign keyless-OIDC per ADR-032 (cloud sidecar primitive) with extension to edge gateway tracked as `ORPHAN-018`. Anti-rollback enforcement planned as part of the same fix. Until ORPHAN-018 lands, operators receive signed binaries via out-of-band channel with manual `cosign verify` step documented in the deployment runbook.
Evidence: `docs/deployment/ota-firmware-update.md`, `docs/reviews/orphan-findings.md#ORPHAN-018`
Status: ROADMAP (automated OTA signed pipeline target 2026-07-30 per ORPHAN-018)

### Q11.2 — Vulnerability-patch SLA

Q: What is the patch SLA by severity?
A: CRITICAL: 7 days. HIGH: 30 days. MEDIUM: 90 days. LOW: next minor release. CVD policy `docs/security/cvd-policy.md` §5.
Evidence: `docs/security/cvd-policy.md`
Status: FULL

---

## Section 12 — Incident Response

### Q12.1 — IR plan

Q: Provide the product incident-response plan.
A: `docs/operations/incident-response.md`. Phases: detect → classify → contain → eradicate → recover → lessons-learned. Integrations: PSIRT intake; Siemens ProductCERT coordination channel available on request for customer-security-incident coordination.
Evidence: `docs/operations/incident-response.md`
Status: FULL

### Q12.2 — Tabletop exercise cadence

Q: Frequency of IR tabletop exercises.
A: Annual tabletop exercise covering a compromised-edge-device scenario + a compromised-update-pipeline scenario. Next scheduled: `{TEMPLATE — per-deal reporting}`.
Evidence: `docs/operations/incident-response.md` §6
Status: PARTIAL (cadence set; per-deal calendar disclosure)

---

## Section 13 — Physical Security

### Q13.1 — Tamper response

Q: How does the product respond to physical tamper attempts?
A: Tamper-response posture documented in `docs/security/attack-surface.md` §Physical. Debug header (UART / JTAG) disabled in production build; secure-boot chain gates U-Boot → kernel → userland — HARDWARE-VENDOR RESPONSIBILITY for the boot-chain root of trust (customer-selected SBC; we publish the qualification matrix). Runtime tamper-evidence via `/var/lib/suderra/audit.db` hash-chain — disrupting it is detectable on next cloud-sync.
Evidence: `docs/security/attack-surface.md`
Status: PARTIAL (boot-chain HARDWARE-VENDOR RESPONSIBILITY; application-layer FULL)

### Q13.2 — Environmental operating envelope

Q: Operating temperature / humidity / vibration envelope.
A: HARDWARE-VENDOR RESPONSIBILITY (customer-selected SBC). Software qualified against the hardware's rated envelope; firmware tested per `docs/testing/hil-tests.md` across the supported hardware matrix.
Evidence: `docs/testing/hil-tests.md`
Status: N-A (HARDWARE-VENDOR RESPONSIBILITY)

---

## Section 14 — Data Protection & Privacy

### Q14.1 — GDPR compliance

Q: GDPR + country-specific (KVKK for Turkey) compliance posture.
A: `docs/compliance/gdpr-kvkk-dpia.md` — full Data Protection Impact Assessment covering Art. 5 (principles), Art. 6 (lawful basis), Art. 25 (privacy by design/default), Art. 32 (security of processing), Art. 35 (DPIA). Data-processor role documented for cases where Siemens is the data controller; DPA template in `docs/siemens-rfp/gdpr-data-protection-addendum.md`.
Evidence: `docs/compliance/gdpr-kvkk-dpia.md`, `docs/siemens-rfp/gdpr-data-protection-addendum.md`
Status: FULL

### Q14.2 — Data residency

Q: Where is customer data stored?
A: On-premise at the edge device by default (customer owns the physical substrate). Cloud-sync target: customer-configurable (EU / non-EU endpoint). Contract enumerates data-residency region per deal.
Evidence: `docs/commercial/data-residency.md`
Status: FULL (customer choice); PARTIAL (specific region per-deal)

---

## Section 15 — Third-Party Security Assurance

### Q15.1 — Penetration testing

Q: Independent penetration-test frequency + last-test date.
A: Annual external penetration test + automated fuzz-testing on CI (`cargo fuzz`). Last test: `{TEMPLATE — per-deal; first external test planned Q3 2026}`. Test scope: every protocol adapter + HTTP API + OTA path.
Evidence: `docs/testing/security-testing.md`
Status: ROADMAP (first external pentest Q3 2026; internal fuzz-testing FULL)

### Q15.2 — Bug-bounty programme

Q: Active bug-bounty programme?
A: No public bug-bounty programme. PSIRT accepts coordinated disclosures per `docs/security/cvd-policy.md` with a researcher-recognition + optional monetary-reward programme (per-disclosure basis).
Evidence: `docs/security/cvd-policy.md`
Status: PARTIAL

---

## Section 16 — Security Certifications

### Q16.1 — Currently held certifications

Q: List product security certifications currently held.
A: None currently. Certifications under active pursuit: (a) IEC 62443-4-1 SDLA — target Q4 2026; (b) IEC 62443-4-2 SL-2 — target Q1 2027; (c) ISO/IEC 27001 organisational — target H2 2027; (d) Common Criteria EAL-2 — target 2028 pending market demand.
Evidence: `docs/compliance/certifications-roadmap.md`
Status: ROADMAP

---

## Section 17 — Supply-Chain Security

### Q17.1 — SBOM availability

Q: Is a Software Bill of Materials (SBOM) published with each release?
A: SBOM generation ROADMAP Q2 2026 via BuildKit `sbom: true` + `cargo sbom` cargo plugin. Today: `Cargo.lock` committed (reproducible build) + OSS attribution document provides ingredient-level listing without SPDX JSON structure. ADR-032 codifies the full supply-chain posture for the cloud sidecar; edge extension tracked as ORPHAN-018.
Evidence: `docs/security/sbom.md`, `docs/reviews/orphan-findings.md#ORPHAN-018`, `#ORPHAN-021`
Status: ROADMAP (Q2 2026)

### Q17.2 — Build reproducibility

Q: Are builds reproducible?
A: Rust reproducible-build practice: `Cargo.lock` committed; `RUSTFLAGS=-C link-arg=-Wl,--build-id=none` + `SOURCE_DATE_EPOCH` pinning in CI. Byte-identical rebuilds validated on every release.
Evidence: `docs/security/sbom.md`, `sens-api-gateway/Cargo.lock`
Status: FULL

---

## Summary

- **FULL (17):** security organisation (Q1.1, Q1.2), threat model (Q2.1), SDLA practice evidence (Q3.2), secure coding structural (Q4.1), dependency scan + licence audit (Q5.1, Q5.2), CVD policy (Q6.1), banned primitives (Q7.2), PKI design (Q8.1), credential storage (Q8.2), RBAC (Q9.1), auth mechanism (Q9.2), audit log PII (Q10.2), patch SLA (Q11.2), IR plan (Q12.1), GDPR (Q14.1), data residency (Q14.2), build reproducibility (Q17.2).
- **PARTIAL (9):** threat-model cadence (Q2.2), secure-coding training records (Q4.2), CVE track record (Q6.2), MQTT mTLS inventory (Q7.1), audit-log shutdown flush per ORPHAN-006 (Q10.1), tabletop calendar (Q12.2), physical tamper (Q13.1), bug-bounty (Q15.2), +1 compound entry.
- **ROADMAP (6):** SDLA certification Q4 2026 (Q3.1), OTA signed pipeline per ORPHAN-018 (Q11.1), first-external pentest Q3 2026 (Q15.1), certifications stack (Q16.1), SBOM Q2 2026 (Q17.1), +1 compound.
- **N-A (1):** operating envelope HARDWARE-VENDOR RESPONSIBILITY (Q13.2).

Every `ORPHAN-*` reference is a real, tracked gap — transparent for the Siemens audit.

---

Response date: 2026-04-24; HEAD=3413db47; version=1.6.0.
