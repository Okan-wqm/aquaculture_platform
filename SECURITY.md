# Security Policy

## Supported Versions

| Component | Version | Status |
|-----------|---------|--------|
| Backend services (`apps/`) | `main` (rolling) | Supported |
| Web microfrontends (`web/`) | `main` (rolling) | Supported |
| Edge gateway (`sens-api-gateway/`) | v1.6.x | Supported |
| Edge gateway | v1.5.x and older | Not supported |

This repo follows trunk-based development. The `main` branch is the only supported line; tagged releases for `sens-api-gateway` carry a 36-month LTS commitment per the lifecycle policy in `sens-api-gateway/docs/operations/lifecycle-eol.md`.

## Reporting a Vulnerability

We follow ISO/IEC 30111 + 29147 vulnerability handling. The full policy lives at `sens-api-gateway/docs/security/cvd-policy.md`.

**Intake channel (PSIRT):**

- **Email:** `security@suderra.example` *(PLACEHOLDER — operator must replace before any external publication. See ORPHAN-EDGE-DOCS-002 closure path.)*
- **PGP key fingerprint:** *(PLACEHOLDER — to be published before external disclosure flow goes live.)*
- **Embargo:** 90 days default, coordinated disclosure
- **Bug bounty:** not currently offered; safe-harbor language applies to good-faith research

**Service-level objectives:**

| Stage | SLO |
|-------|-----|
| Acknowledge intake | 24 hours |
| Triage + severity confirmation | 72 hours |
| Fix CRITICAL | 7 days |
| Fix HIGH | 30 days |
| Fix MEDIUM | 90 days |
| Fix LOW | 180 days |
| CVE reservation | Per fix release, before public disclosure |

**Out of intake scope:**

The following do not count as security vulnerabilities:

- Self-inflicted misconfiguration of customer-deployed instances (consult `docs/runbooks/`)
- Issues in unsupported versions
- Theoretical issues with no demonstrated exploit path
- Social-engineering of operator personnel

For these, open a regular GitHub Issue or contact support per `SUPPORT.md`.

## Architectural Posture

- **IEC 62443-4-2 SL2 target** (life-safety components targeted at SL3) — gap inventory at `sens-api-gateway/docs/compliance/iec62443-4-2-gap.md`.
- **Trust-boundary cryptographic envelope** for every command path (`@platform/event-contracts` JSON Schema validators are tracked under ORPHAN-EDGE-CONTRACT-002 for runtime-wiring closure).
- **Tamper-evident audit log** — HMAC-chained per ADR-020.
- **Coordinated Vulnerability Disclosure** — registered as a process commitment, not a marketing claim.

## Supply-Chain

- **SBOM:** generated per release via `cargo-cyclonedx` (Rust) + `cargo-auditable` for binary artefact embedding. Tracked under ORPHAN-021 + ORPHAN-EDGE-DEP-003.
- **SLSA target:** Level 3. Currently Level 1 (lockfiles + provenance from GHA).
- **Dependabot:** monitored; remediation cadence registered as ORPHAN-EDGE-DEP-001.

## References

- Full CVD policy: `sens-api-gateway/docs/security/cvd-policy.md`
- IEC 62443-4-1 SDLA evidence: `sens-api-gateway/docs/compliance/iec62443-4-1-sdla.md`
- Crypto inventory: `sens-api-gateway/docs/security/crypto-inventory.md`
- Threat model: `sens-api-gateway/docs/security/threat-model.md`
- Open security findings: `docs/reviews/orphan-findings.md`
