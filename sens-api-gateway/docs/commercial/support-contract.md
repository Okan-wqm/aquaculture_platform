# Support Contract — Template

> **(LEGAL REVIEW REQUIRED)** — Contractual half of the support relationship. The operational half is recorded in `../operations/support-tiers.md`; this document records the binding obligations that flow from the elected tier. All monetary caps, credits, and response-time values are `{TEMPLATE}` placeholders.

Document date: 2026-04-24

---

## 1. Scope

This document templates the support services provided by Suderra to the Licensee in respect of the Suderra Edge Agent (`suderra-agent`). It binds together:

- The support-tier matrix in `../operations/support-tiers.md`.
- The SLA targets (availability, observability) in `../operations/sla.md`.
- The security-update obligations underlying the escrow trigger in `source-code-escrow.md` §5.
- The export-compliance posture constraining cross-border remote support (see `export-control.md`).

**(LEGAL REVIEW REQUIRED)**

---

## 2. Support tiers

Three tiers are offered at the time of writing. The Licensee elects a single tier per order form. Material tier features are summarised below; full operational detail is in `../operations/support-tiers.md`.

| Tier | Response time (P1) | Response time (P2) | Coverage hours | Channels | Annual fee |
|------|-------------------|-------------------|----------------|----------|-----------|
| **Standard** | `{TEMPLATE: e.g. 8 business hours}` | `{TEMPLATE: e.g. 2 business days}` | Business hours, licensee local timezone | Email, customer portal | `{TEMPLATE}` |
| **Business-Critical** | `{TEMPLATE: e.g. 4 clock hours}` | `{TEMPLATE: e.g. 8 clock hours}` | 24×5 | Email, portal, phone | `{TEMPLATE}` |
| **Mission-Critical** | `{TEMPLATE: e.g. 1 clock hour}` | `{TEMPLATE: e.g. 4 clock hours}` | 24×7 | Email, portal, phone, named engineer | `{TEMPLATE}` |

**(LEGAL REVIEW REQUIRED)**

### 2.1 Severity definitions

| Severity | Definition |
|----------|------------|
| **P1 — Critical** | Production Edge Agent is down, unable to ingest sensor data, unable to enforce safe-state logic; the Licensee's operational process is materially impacted. |
| **P2 — High** | Production Edge Agent is degraded but operational; a major feature is unavailable. |
| **P3 — Medium** | Non-production issue, workaround available, or minor feature defect. |
| **P4 — Low** | Cosmetic, documentation, or enhancement request. |

Security vulnerabilities with confirmed exploitation paths are treated as P1 irrespective of operational impact.

---

## 3. Service credits

Where Suderra fails to meet the target response time for a P1 incident by more than `{TEMPLATE: service-credit threshold, typically 100 % of target}`, the Licensee is entitled to a service credit equal to `{TEMPLATE: credit percentage, typically 5 %}` of the monthly-prorated annual fee for the affected month. Service credits are capped at `{TEMPLATE: service-credit cap, typically 15 %}` of the monthly-prorated fee in any single calendar month and at `{TEMPLATE: annual credit cap, typically 50 %}` of the annual fee in any rolling twelve-month period. Credits are the Licensee's sole and exclusive financial remedy for an SLA breach short of termination for cause; no consequential damages are payable in respect of SLA miss.

**(LEGAL REVIEW REQUIRED)**

---

## 4. Exclusions

The support obligation does not extend to:

- Hardware faults in the underlying edge device (Raspberry Pi, Revolution Pi, TPM module, sensors, actuators) — these are the Licensee's or the hardware supplier's responsibility.
- Defects caused by unauthorised modification of the Edge Agent binary, bypass of the signed-deploy feature, or disabling of hardening mechanisms (ADR-019 §5).
- Defects caused by use outside the documented specifications (`../product/`, `../api/`, `../protocols/`).
- Defects caused by the Licensee's own software, scripts, or IEC 61131-3 programs beyond the bytecode safety envelope (ADR-017 §10).
- Third-party integrations (SCADA / MES / ERP / cloud analytics) beyond the documented northbound protocols.
- Operator error, negligence, or failure to apply a security patch that Suderra has made available within the agreed window.
- Force majeure events (§7 below).

---

## 5. Security-update obligation

Suderra commits to:

- Issue security patches for CRITICAL-severity CVEs affecting the Edge Agent within `{TEMPLATE: critical-CVE patch window, typically 30 days}` of confirmed disclosure.
- Issue patches for HIGH-severity CVEs within `{TEMPLATE: high-CVE patch window, typically 60 days}`.
- Maintain a Coordinated Vulnerability Disclosure (CVD) process conforming to ISO/IEC 30111 (see `../security/cvd-policy.md`).

The security-update obligation survives the expiry of any single support tier while the Licensee continues to operate a version of the Edge Agent that Suderra has declared as supported. End-of-support (EOS) timelines are published at least twelve months in advance per `../operations/support-lifecycle.md`.

Failure to meet the security-update obligation beyond `{TEMPLATE: security-breach window, typically 180 days}` is a material breach and may trigger the escrow release procedure in `source-code-escrow.md` §5 (3).

**(LEGAL REVIEW REQUIRED)**

---

## 6. Change control

### 6.1 Upgrades

Minor-version upgrades (e.g. v1.6.x → v1.7.0) are distributed under the existing support tier without additional charge. Major-version upgrades (e.g. v1.x → v2.0) may carry an upgrade fee `{TEMPLATE}` and may require re-provisioning of per-device keys (ADR-019 §7 rekey path).

### 6.2 Customer-requested changes

Customer-requested feature work is out of standard support and is quoted separately on a time-and-materials basis or as a fixed-price statement of work. Engagement under this clause does not alter the ownership of the resulting intellectual property, which remains with Suderra unless separately agreed in writing.

**(LEGAL REVIEW REQUIRED)**

---

## 7. Force majeure

Neither Party is liable for failure to perform a non-monetary obligation to the extent caused by circumstances beyond its reasonable control (acts of government, natural disaster, large-scale internet outage, sustained third-party critical-infrastructure failure). The affected Party gives written notice and uses reasonable efforts to resume performance. Force-majeure delay does not give rise to a service credit under §3.

---

## 8. Remote-support access

Where remote support requires connection to the Licensee's edge devices, access is brokered through the zero-trust relay documented in `../deployment/remote-support-relay.md` using ephemeral credentials bound to a named Suderra engineer. The Licensee may revoke access at any time by withdrawing the session approval in the fleet manager. Remote access is logged in the audit chain (ADR-020 §2) and the logs are made available to the Licensee on request.

Cross-border remote support is constrained by the export-compliance posture in `export-control.md` §4; support to a prohibited destination is not provided.

---

## 9. Termination

### 9.1 Termination for convenience

Either Party may terminate the support agreement on `{TEMPLATE: convenience notice, typically 90 days}` prior written notice delivered not less than `{TEMPLATE: convenience notice}` before the end of the then-current annual term. Fees paid are non-refundable save where applicable mandatory law overrides.

### 9.2 Termination for cause

Either Party may terminate for material breach following written notice and the expiry of a `{TEMPLATE: cure period, typically 30 days}` cure period during which the breach is not remedied. Suderra may additionally terminate with immediate effect on the Licensee's breach of the export-control obligations in `export-control.md`, circumvention of licence enforcement, or failure to pay an undisputed invoice beyond `{TEMPLATE: payment overdue window, typically 45 days}`.

**(LEGAL REVIEW REQUIRED)**

### 9.3 Effect of termination

On termination, the Licensee's entitlement to new patches, upgrades, and channels ends. The licence to use the previously-delivered Edge Agent continues per `license-model.md` §5.4 grace terms.

---

## 10. Relationship to internal compliance programme

Internal export-compliance programme structure is handled separately (see `commercial/support-contract.md`); referenced here for completeness. Specifically, cross-border remote-support sessions under §8 are screened against the restricted-destination list maintained under that programme before any session is authorised.

---

Export-control reference date: 2026-04-24
