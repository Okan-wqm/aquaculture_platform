# Data Residency — Suderra Edge Agent

> **(LEGAL REVIEW REQUIRED)** — This document templates the data-residency posture of the Suderra Edge Agent and the lawful-transfer mechanisms available for cross-border flows. Counsel confirms applicability of Standard Contractual Clauses, KVKK Article 9 provisions, and Siemens customer-specific mandates at contract execution.

Document date: 2026-04-24

---

## 1. Design principle: edge-local by default

The Suderra Edge Agent is designed so that, in the default deployment, customer data does not leave the Licensee's physical premises or OT network. Specifically:

- **Sensor readings** are ingested locally by the Edge Agent running on the Licensee's hardware and persisted in the local SQLCipher database (feature `bundled-sqlcipher-vendored-openssl`, `sens-api-gateway/Cargo.toml:94`).
- **Control-logic execution** (IEC 61131-3 bytecode VM, `st-bytecode` feature, `Cargo.toml:367`) runs entirely on the edge device.
- **Audit chain entries** (ADR-020 §1) are persisted in the local SQLCipher store, cryptographically anchored by HMAC-SHA256 and optionally attested via Ed25519 signatures to the device's HKDF-derived attestation keypair.
- **OPC UA northbound** (feature `opc-ua-server`, `Cargo.toml:379`) serves the Licensee's on-premises HMI / SCADA only; it is not a vendor-side egress path.

No customer data is transmitted to Suderra infrastructure in the default deployment profile. This stance is the anchor of the data-residency guarantee.

**(LEGAL REVIEW REQUIRED)**

---

## 2. Data-class taxonomy

For the purpose of residency analysis, Edge Agent data is classified as follows:

| Class | Examples | Personal-data status | Residency constraint |
|-------|----------|----------------------|----------------------|
| **Operational (OT)** | Sensor readings (water quality, tank levels, pump states), control-loop telemetry, scan-cycle metrics. | Non-personal — telemetry about equipment, not about identifiable natural persons. | Edge-local by default; optional cloud relay if opted in (§3). |
| **Device identity** | `machine-id` fingerprint, MAC address (SHA-256 hashed per LOW-45 remediation; see `Cargo.toml:130`), device-attestation keypair public half. | Pseudonymous — de-identifiable but not directly identifying a natural person. | Edge-local; the public half of the attestation keypair flows to Suderra's fleet-manager for signature verification. |
| **Operator identity** | PIN hashes (not plaintext), operator session tokens, role assignments. | Personal — identifies a named operator. | Edge-local; never egressed to Suderra. |
| **Audit chain** | Append-only entries recording command receipt, signature verification, force-value operations. | Mixed — contains operator identifiers where an operator action is recorded. | Edge-local; exportable under customer control for compliance archival. |
| **Security-event telemetry** | Aggregated counters for auth failures, signature-verification failures, NATS connection errors. | Non-personal in aggregated form. | Optionally egressed to Suderra if cloud-telemetry is opted in (§3). |

Personal-data status is assessed under GDPR Article 4(1) (and the materially equivalent KVKK definition); counsel confirms at execution time.

**(LEGAL REVIEW REQUIRED)**

---

## 3. Optional cloud-relay path (customer opt-in)

Where the Licensee elects the cloud-relay package for remote fleet monitoring or managed analytics, a subset of the data classes in §2 egresses the Licensee's premises to a Suderra-operated (or customer-nominated) cloud endpoint. The Licensee selects the hosting region from the matrix below.

### 3.1 Region matrix

| Region | Hosting | Primary jurisdiction | Lawful-transfer basis (origin in EU/EEA) | Lawful-transfer basis (origin in Turkey) |
|--------|---------|---------------------|-------------------------------------------|------------------------------------------|
| **EU-Frankfurt** | Cloud provider in Germany (or a comparable EEA member state). | Germany / EEA (GDPR). | Intra-EEA — no cross-border transfer mechanism required. | KVKK Art. 9: Country on adequacy list, OR Data Controller undertaking + Turkish DPA authorisation. |
| **US-East** | Cloud provider in United States (typically US-East-1 / US-East-2). | United States. | EU–US Data Privacy Framework (DPF) if self-certified by the processor; otherwise GDPR Chapter V Standard Contractual Clauses (Module 2 or 3 as applicable) + Transfer Impact Assessment (TIA). | KVKK Art. 9: Data Controller undertaking + Turkish DPA authorisation; DPA has historically scrutinised US transfers. |
| **Turkey** | Cloud provider in Turkey. | Turkey (KVKK). | GDPR Chapter V SCCs + TIA (Turkey not on EU adequacy list). | Intra-Turkey — no cross-border transfer mechanism required. |
| **On-premises-only** | Customer-operated infrastructure; no vendor-side cloud processing. | Customer's own jurisdiction. | No cross-border flow. | No cross-border flow. |

**(LEGAL REVIEW REQUIRED)** — the EU–US DPF and the Turkish DPA adequacy posture are moving targets. Confirm at execution time.

### 3.2 Transfer mechanisms (detail)

- **Standard Contractual Clauses (SCCs):** EU Commission Implementing Decision 2021/914 SCCs are incorporated by reference into the master agreement; Module 2 (controller-to-processor) is the default Suderra-as-processor pattern, Module 3 (processor-to-processor) where a sub-processor is engaged.
- **Transfer Impact Assessment (TIA):** For exports to jurisdictions not on the EU adequacy list, a TIA is produced per the EDPB Recommendations 01/2020. Suderra provides the TIA input (technical and organisational measures) and the Licensee signs off.
- **KVKK Article 9:** For data originating in Turkey, cross-border transfer requires either (a) the destination on the adequacy list published by the Turkish DPA (KVKK Kurumu), (b) a Data Controller undertaking approved by the DPA, or (c) explicit data-subject consent. Suderra's preferred mechanism is a standing undertaking approved by the DPA, where available.
- **Additional safeguards:** Encryption in transit (TLS) and at rest (AES-256 SQLCipher on the edge; cloud-provider-native encryption at rest) are standard; pseudonymisation (SHA-256 hashing of device MAC per LOW-45, see `Cargo.toml:130`) is applied on personal-class fields before egress where compatible with the feature.

**(LEGAL REVIEW REQUIRED)**

---

## 4. Data-subject rights

Where the Licensee collects operator or data-subject personal data through the Edge Agent, the Licensee is the Data Controller and Suderra is the Processor. The Licensee discharges data-subject rights (access, rectification, erasure, portability, restriction, objection) using the export tooling exposed on the edge device (`../api/` administrative endpoints) and, where the cloud-relay is engaged, through Suderra's processor-side tooling on request.

Suderra does not use Licensee operator data for Suderra's own purposes, including training of machine-learning models, absent explicit written authorisation.

**(LEGAL REVIEW REQUIRED)**

---

## 5. Data-breach notification

- **Edge-local breaches:** The Licensee is responsible for identifying a breach in Licensee-controlled infrastructure, including the edge device. Suderra supports the forensic investigation under the cyber-indemnification clause in `indemnification.md` §2 where the root cause is attributable to a vulnerability in the Edge Agent.
- **Cloud-relay breaches:** Suderra notifies the Licensee within `{TEMPLATE: cloud-breach notice window, typically 24 hours}` of confirming a breach affecting the Licensee's cloud-resident data. The Licensee retains control of any further notifications to regulators and data subjects.

**(LEGAL REVIEW REQUIRED)**

---

## 6. Retention and deletion

- **Edge-local data:** Retained per the Licensee's own retention policy. The Edge Agent's audit-chain default is seven-year retention (ADR-020 §10a); shorter retention is supported by configuration.
- **Cloud-relay data:** Retained per the term elected on the order form (`{TEMPLATE: cloud retention}`), after which it is irreversibly deleted from production stores and from backups per Suderra's standard deletion schedule `{TEMPLATE: backup lag, typically 90 days from deletion request}`.
- **Operator-initiated deletion:** A data-subject erasure request is discharged through the Licensee; Suderra supports the operation on cloud-resident data within `{TEMPLATE: erasure response window, typically 30 days}`.

**(LEGAL REVIEW REQUIRED)**

---

## 7. Government access

Suderra's processor-side infrastructure is operated such that a government-access request is handled under the following posture:

- Suderra provides no access beyond what is compelled by a valid legal process in the hosting jurisdiction.
- Suderra notifies the Licensee of the request unless prohibited by law; where prohibited, Suderra challenges the prohibition where reasonably possible.
- Suderra publishes an annual transparency report summarising request volumes and outcomes.
- Where the request targets EU-origin data processed in a non-adequate jurisdiction, Suderra applies the TIA-mandated supplementary measures and challenges the request on that basis where reasonably possible.

**(LEGAL REVIEW REQUIRED)**

---

## 8. Sub-processors

The list of sub-processors engaged by Suderra for cloud-relay operations is maintained at `{TEMPLATE: sub-processor list URL}` and updated before any material change. The Licensee may object to a new sub-processor on reasonable data-protection grounds; Suderra accommodates the objection or, failing accommodation, releases the Licensee from the cloud-relay engagement with a pro-rata refund.

**(LEGAL REVIEW REQUIRED)**

---

## 9. Alignment with the DPIA

The Data-Protection Impact Assessment is recorded in `../compliance/gdpr-kvkk-dpia.md`. This data-residency document and the DPIA are mutually consistent; any change to the data-flow topology is reflected in both simultaneously.

---

Export-control reference date: 2026-04-24
