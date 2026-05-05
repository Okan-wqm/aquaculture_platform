# Coordinated Vulnerability Disclosure (CVD) Policy — `sens-api-gateway` v1.6.0

**Alignment:** ISO/IEC 30111:2019 *Information technology — Security techniques — Vulnerability handling processes*; ISO/IEC 29147:2018 *Vulnerability disclosure*.
**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.

---

## 1. Intake contact

- **Primary email (security issues):** `security@suderra.example` *(PLACEHOLDER — replace with the real PSIRT distribution list at productization; agent spec forbids inventing a real address here)*
- **Signed-mail support:** PGP key ID / fingerprint TBD; published at `https://suderra.example/.well-known/security.txt` following RFC 9116. Until the real key is minted, signed-mail intake is not enforced — plaintext reports are accepted at the placeholder address.
- **security.txt location (when published):** `https://suderra.example/.well-known/security.txt` with `Contact:`, `Encryption:`, `Policy:`, `Expires:` fields populated per RFC 9116.

Escalation path if the primary address bounces: open a private GitHub security advisory at `https://github.com/suderra/edge-agent/security/advisories/new`.

---

## 2. Scope

### 2.1 In scope

- `suderra-agent` Rust binary (`sens-api-gateway/src/**`) and all crates pinned in `sens-api-gateway/Cargo.toml`.
- Build scripts, provisioning CSR flow (when live), OTA firmware manifest verification.
- Signed artifacts shipped to edge: firmware manifests, RBAC manifests, license JWTs, acceptance tokens.
- Documentation that affects deployment security posture (this folder, `../deployment/**`, `../compliance/**`).

### 2.2 Not covered by this policy (handled elsewhere)

- Cloud-side services (billing, auth, farm, sensor services) — see `docs/security/` at the monorepo root.
- Third-party hardware vulnerabilities (SoC silicon, TPM hardware, PLC firmware) — HARDWARE-VENDOR RESPONSIBILITY (vendor PSIRT paths: Broadcom, Infineon, Kunbus, Siemens PSIRT for S7 stack issues).
- Vulnerabilities in deployed operator workflow (social engineering of operator; physical security of the HMI kiosk) — customer network design responsibility.

### 2.3 Not in PSIRT intake

- Missing-feature requests (file a GitHub issue).
- Protocol-level limitations inherent to Modbus, S7, EtherNet/IP that are documented in `docs/protocols/**`.
- Non-default insecure configurations the operator explicitly opted into (e.g. file-backed keystore via signed acceptance token per ADR-018 §5 — the acceptance IS the operator's opt-in; we will NOT treat the presence of the feature as a vulnerability).

---

## 3. SLAs

| Phase | SLA | Notes |
|-------|-----|-------|
| **Acknowledge receipt** | 24 hours from first inbound mail (excluding public holidays in TR and DE) | Automated + personal response |
| **Triage — severity confirmation** | 72 hours | CVSS v3.1 scoring; severity class bucketing |
| **Fix delivery — Critical (CVSS 9.0–10.0)** | 7 days | Includes coordinated hotfix release if needed |
| **Fix delivery — High (CVSS 7.0–8.9)** | 30 days | Next planned minor release |
| **Fix delivery — Medium (CVSS 4.0–6.9)** | 90 days | Can slip to next minor if no exploit in the wild |
| **Fix delivery — Low (CVSS 0.1–3.9)** | 180 days | Scheduled with routine maintenance |

When the reporter has set an earlier disclosure deadline, we negotiate; our default disclosure timeline is aligned to the Google Project Zero 90-day window, extendable to 104 days for deployment-in-progress at the reporter's agreement.

---

## 4. Triage workflow

```
Inbound report
  → PSIRT ack (24h) + ticket creation
  → Reproduce on clean environment
  → CVSS v3.1 score (Base + Temporal; Environmental on customer request)
  → Severity bucket assigned (Critical / High / Medium / Low)
  → Root-cause fix designed per CLAUDE.md architectural-hierarchy
      (Tier-1 make-it-impossible preferred)
  → Fix PR opened in private fork
  → CVE reservation requested from GitHub CNA or MITRE
  → Coordinated disclosure date set with reporter
  → Patch released; advisory published
  → Retrospective added to docs/security/hardening-changelog.md
```

Every fix commit carries `Closes: docs/reviews/<review-path>#<finding-id>` per CLAUDE.md finding-traceability rules.

---

## 5. Disclosure

- **Default timeline:** 90 days from triage completion.
- **Extensions:** up to +14 days at reporter's request when the fix is complex and the embargo benefits end users.
- **Emergency exceptions:** active exploitation in the wild → expedited release + immediate public advisory.

Advisories published at:

- GitHub Security Advisory on the `suderra/edge-agent` repository.
- `https://suderra.example/security/advisories/` (PLACEHOLDER — real URL populated at productization).
- Release notes for the containing `sens-api-gateway-vX.Y.Z` tag.

Each advisory includes:

- Summary + affected versions
- Impact + CVSS v3.1 vector
- Fixed version
- Reporter credit (opt-in)
- CVE ID (if assigned)
- Mitigation steps for operators who cannot upgrade immediately

---

## 6. CVE assignment

The project uses CVE Numbering Authority delegation via GitHub for advisories in repositories under `suderra/`. For pre-disclosure embargoes requiring MITRE-direct coordination (for example when the issue overlaps a bundled crate also published to RustSec), the PSIRT engages MITRE's CNA-LR directly.

Historic edge-agent vulnerabilities are tracked by CVE ID in `docs/security/hardening-changelog.md` (source file `sens-api-gateway/SECURITY_HARDENING_CHANGELOG.md`).

---

## 7. Safe-harbor statement

Researchers acting in good faith under this policy — meaning they (a) report vulnerabilities promptly and privately, (b) do NOT disclose publicly before the coordinated date, (c) do NOT access data beyond what is necessary to prove the vulnerability, (d) do NOT degrade service for other customers — are not subject to legal action from us for the technical acts of discovering and demonstrating the vulnerability.

We will not pursue civil or criminal remedies against researchers who act within these bounds. Acts outside these bounds (extortion, public disclosure before the coordinated date, lateral movement into customer environments) are not covered.

---

## 8. Reporter recognition

We maintain a public Hall of Fame at `https://suderra.example/security/credits/` (PLACEHOLDER) listing reporters who opted in to credit. No monetary bounty program is active at v1.6.0 — we consider a private bug bounty under ROADMAP-Q4 after the external attack surface of the agent has been further narrowed by the Faz 2 sprints.

---

## 9. Supply-chain components

Vulnerabilities discovered in pinned dependencies (for example a new RustSec advisory against `bincode = "=1.3.3"`, `Cargo.toml:194`) follow the same SLAs as first-party issues. Remediation path:

- Bump or replace the crate, passing every invariant test including the `bincode` limit-on-external-input invariant declared in `Cargo.toml:192-193`.
- Re-issue an SBOM + advisory referencing the original upstream CVE.

---

## 10. Cross-references

- `sbom.md` — SBOM policy feeds CVE correlation.
- `docs/security/hardening-changelog.md` — historical CVE list.
- `threat-model.md` — STRIDE context for triage.
- `Cargo.toml:186-193` — bincode limit invariant; pinned for long-term audit readability.
