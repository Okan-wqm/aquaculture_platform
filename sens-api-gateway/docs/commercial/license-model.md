# Licence Model — Suderra Edge Agent

> **(LEGAL REVIEW REQUIRED)** — Template-level commercial terms. All substantive clauses require counsel sign-off before execution. Monetary amounts, cure periods, and notice windows are `{TEMPLATE}` placeholders.

**Product:** `suderra-agent` v1.6.0 and later minor releases in the v1.x line
**Licensor:** Suderra (`info@suderra.com`)
**Document date:** 2026-04-24

---

## 1. Licence classification

The Suderra Edge Agent is licensed as **proprietary commercial software**. The `Cargo.toml` manifest declares `license = "Proprietary"` (see `sens-api-gateway/Cargo.toml:8`) and the `cargo-deny` configuration binds the crate to the `LicenseRef-Proprietary` SPDX reference (see `sens-api-gateway/deny.toml:65-68`).

### 1.1 Source-of-truth inconsistency flagged for legal review

The file `sens-api-gateway/LICENSE` currently contains the full text of the **MIT License** (`Copyright (c) 2026 Suderra`). This directly contradicts the proprietary classification declared in the Cargo manifest and the `cargo-deny` clarification block. The MIT file is the only `LICENSE*` file at the gateway root.

**(LEGAL REVIEW URGENT)** — one of the following corrective actions must be taken before any commercial distribution:

- Replace the `LICENSE` file with a proprietary End-User Licence Agreement text consistent with this document; or
- Formally adopt a dual-licence model (Proprietary + MIT) and update `Cargo.toml`, `deny.toml`, and this chapter accordingly; or
- If MIT is the true intent, retract the proprietary classification throughout the documentation set.

Distribution of binaries against an ambiguous licence creates downstream estoppel risk and is not acceptable. This inconsistency is recorded as a blocking finding.

---

## 2. Grant (template)

Subject to the Licensee's continued compliance with the executed agreement, Suderra grants to the Licensee a non-exclusive, non-transferable, revocable, limited licence to install, execute, and use the Suderra Edge Agent **solely** in accordance with the licensing metric elected in the order form (§3) and the permitted-use restrictions below (§4).

**(LEGAL REVIEW REQUIRED)**

---

## 3. Licensing metrics (elected per order form)

The Licensee elects one of the following metrics at order execution:

| Metric | Definition | Typical deployment |
|--------|------------|--------------------|
| **Per-Device** | One licence entitles installation on a single edge device identified by a unique `machine-id` fingerprint. Re-provisioning to a replacement device is permitted following the RMA procedure in `support-contract.md`. | Small fleets; pilot installations. |
| **Per-Site** | One licence entitles unlimited installations within a single physical plant or site, bounded by a geographic polygon identified in the order form. | Single-plant industrial customer. |
| **Per-Seat (HMI-only)** | One licence per named operator with OPC UA client credentials. Applies only to deployments that expose the OPC UA server (feature flag `opc-ua-server`, `Cargo.toml:379`). | Control-room deployments. |
| **Enterprise / Site-Group** | Unlimited devices across all sites operated by the Licensee entity and its wholly-owned affiliates, capped at `{TEMPLATE: max devices}`. | Fleet-scale rollouts. |

Channel / I/O and function-block instance limits enforced in software are supplied via the signed-licence JWT consumed by the `license-enforce` feature (`Cargo.toml:392`, ADR-018 §2). Limit values are commercial placeholders: `{TEMPLATE: max_io_channels, max_fb_instances, min_scan_cycle_ms}`.

**(LEGAL REVIEW REQUIRED)**

---

## 4. Permitted and prohibited uses

### 4.1 Permitted

- Internal productive use of the Edge Agent on the licensed devices or sites.
- Configuration, deployment, and operation of IEC 61131-3 programs as documented in `../product/` and `../api/`.
- Integration with the Licensee's SCADA, MES, ERP, or cloud-analytics systems via the documented northbound protocols (MQTT, OPC UA, HTTPS, NATS).
- Creation of internal backups and disaster-recovery copies as required to meet availability targets.

### 4.2 Prohibited

- **Redistribution** of the binary, source, or any derivative in whole or in part to any third party, including affiliates not named in the order form. Redistribution rights are NOT granted under the default commercial licence and require a separately negotiated distribution agreement.
- **Derivative works**, including modifications to the compiled binary, patching of shipped files, or incorporation of Edge Agent code into a product offered to third parties. Derivative rights are NOT granted under the default commercial licence.
- **Reverse engineering, decompilation, or disassembly** except to the minimum extent expressly permitted by applicable mandatory law (e.g. EU Directive 2009/24/EC Art. 6 interoperability) and only after giving Suderra written notice and a reasonable opportunity to provide the interoperability information directly.
- **Benchmarking for public disclosure** without Suderra's prior written consent. Internal benchmarking is permitted.
- **Circumvention** of any licence-enforcement mechanism, including the JWT signature verification in the `license-enforce` feature, the anti-rollback counter defined by ADR-018 §4, or the tier-downgrade guard specified in ADR-018 §2.
- **Use in prohibited jurisdictions** as identified in `export-control.md` §3.
- **Safety-critical / life-critical deployment** except under a separately qualified agreement — see `warranty-disclaimer.md` §5.

**(LEGAL REVIEW REQUIRED)**

---

## 5. Term, renewal, and termination

### 5.1 Term

The initial term is `{TEMPLATE: initial term, typically 12 months}` from the activation date recorded in the order form.

### 5.2 Renewal

Auto-renewal for successive `{TEMPLATE: renewal term, typically 12 months}` periods applies unless either party delivers written notice of non-renewal at least `{TEMPLATE: notice window, typically 60 days}` prior to the end of the then-current term.

### 5.3 Termination for cause

Either party may terminate for material breach following written notice specifying the breach and the expiry of a `{TEMPLATE: cure period, typically 30 days}` cure period during which the breach is not remedied. Termination is also permitted, with immediate effect and without cure, in the event of:

- Insolvency, bankruptcy, or equivalent proceedings against the other party.
- A breach of the export-control obligations in `export-control.md`.
- A breach of the prohibited-use clauses in §4.2 above that materially compromises Suderra's intellectual property or a third party's data-protection rights.

### 5.4 Effect of termination

On termination, the Licensee's installed Edge Agents enter **grace mode** for a `{TEMPLATE: grace period, typically 30 days}` period during which sensor ingestion and local control continue, but northbound cloud features are disabled. At end of grace, the Licensee uninstalls the software from all devices, certifies destruction in writing, and returns any licensed materials. Fees paid are non-refundable save where applicable mandatory law overrides.

**(LEGAL REVIEW REQUIRED)**

---

## 6. Source-code and keys

The Licensee receives compiled binaries only. Source code is not distributed under the commercial licence. Business-continuity protection against Suderra's cessation is provided via the escrow arrangement templated in `source-code-escrow.md`.

Signing keys, anchor keys, and PKI root material (see `../security/pki-hierarchy.md`) remain Suderra property at all times. The device-resident key material derived via HKDF from the TPM-sealed master (ADR-019 §7) is scoped to the Licensee's own device and is not disclosed to Suderra.

---

## 7. Audit

Suderra may, on `{TEMPLATE: audit notice, typically 30 days}` prior written notice and not more than once in any twelve-month period, inspect the Licensee's deployment records to verify compliance with the elected licensing metric. The audit is carried out remotely via the signed device-inventory attestation exported from the fleet manager (ADR-020 §2 attestation path); on-site audit is carried out by a mutually agreed independent auditor. Results are confidential. Any material under-licensing shortfall identified is settled at the then-current list price with a `{TEMPLATE: underpayment penalty, typically 10 %}` surcharge.

**(LEGAL REVIEW REQUIRED)**

---

## 8. Open-source components

The Edge Agent incorporates open-source components under permissive and weak-copyleft licences. A full dependency inventory, attribution text, and compliance posture are recorded in `oss-attribution.md` and `third-party-notices.md`. The Licensee's rights in respect of those components are governed by their respective licences, not by this commercial licence.

---

## 9. Governing law and dispute resolution

Governing law, forum selection, and dispute-resolution mechanism (litigation, arbitration seat, institutional rules, language) are supplied by counsel in the executed agreement. Default drafts for the `{TEMPLATE: governing law}` and `{TEMPLATE: forum or arbitration seat}` fields are provided separately.

**(LEGAL REVIEW REQUIRED)**

---

Export-control reference date: 2026-04-24
