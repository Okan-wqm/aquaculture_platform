# Source-Code Escrow Clause — Template

> **(LEGAL REVIEW REQUIRED)** — This file contains template text for a source-code escrow addendum appended to the master agreement executed with Licensees that require business-continuity protection. All monetary amounts, notice windows, and escrow-agent identities are `{TEMPLATE}` placeholders until selected by counsel and operations.

Document date: 2026-04-24

---

## 1. Purpose

The escrow arrangement provides the Licensee with a legally enforceable route to obtain the source code, build instructions, and release-signing material for the Suderra Edge Agent in the event that Suderra ceases to support the product under the circumstances set out in §5 below. The arrangement is business-continuity insurance; it is not a substitute for the confidentiality and intellectual-property terms of the master agreement.

**(LEGAL REVIEW REQUIRED)**

---

## 2. Escrow agent

The Parties appoint `{TEMPLATE: escrow agent identity, candidate shortlist: Iron Mountain Intellectual Property Management; NCC Group Software Resilience; Escrow London}` as the independent escrow agent. The chosen agent shall be an organisation whose standing as a neutral third party is reasonably acceptable to both Parties and whose operational locations align with the Licensee's data-residency constraints (see `data-residency.md`).

The escrow agreement is a tripartite contract (Suderra, Licensee, escrow agent) separately executed, and the terms of the escrow agreement prevail over this template to the extent of any conflict in respect of the mechanical deposit-and-release process. This clause records the commitment; the tripartite document records the operational detail.

**(LEGAL REVIEW REQUIRED)**

---

## 3. Deposit scope

On the Effective Date and on every subsequent release tag (minor or major) of the Suderra Edge Agent licensed to the Licensee, Suderra deposits with the escrow agent:

### 3.1 Source tree

- Complete source tree of `sens-api-gateway/` at the release tag, including:
  - `Cargo.toml`, `Cargo.lock`, `deny.toml`, `Cross.toml`
  - `src/**`, `tests/**`, `fuzz/**`, `build.rs`
  - `systemd/**`, `scripts/**`, `static/**`
  - `docs/**` (all documentation chapters including this one)
  - `vendor/**` (excluding any upstream code whose licence forbids sub-deposit; such items are replaced by a pinned Git reference and the upstream licence text — see §3.5)

### 3.2 Build toolchain specification

- Pinned Rust toolchain version (`rust-version` from `Cargo.toml:5`, currently `1.85`, edition `2024`).
- Pinned system-level tool versions: `bindgen`, `cc`, system OpenSSL / libtss2 / SQLCipher bundled-build versions.
- Cross-compilation configuration for the supported target triples (`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `armv7-unknown-linux-gnueabihf` per `deny.toml:8-12`).
- Dockerfile(s) producing a reproducible build environment, pinned by SHA-256 digest.

### 3.3 Build and release instructions

- A written runbook enabling an engineer of reasonable skill to reproduce the release binary from the deposited tree. The runbook references the `scripts/` deploy automation.
- Verification checklist: after reproduction, the engineer computes the SHA-256 of the output binary and compares to the published release manifest.

### 3.4 Release-signing material

- Public keys corresponding to the release-signing key, sufficient to verify binaries already distributed.
- The private signing key itself is **not** deposited; the key is scoped to Suderra's production HSM per ADR-021 §1 and its release would compromise the integrity of every deployed device. Instead, the escrow deposit includes the procedure by which the Licensee (or its successor-in-interest as permitted by the release conditions) may mint a fresh key, re-sign the reproduced binary, and enrol the new public key with the device fleet via the rekey procedure documented in `../deployment/rekey-runbook.md`.

**(LEGAL REVIEW REQUIRED)** — the decision to withhold the private signing key from escrow and replace it with a re-signing procedure is a deliberate security-driven choice. Counsel to confirm that the Licensee's continuity rights are adequately preserved by the re-signing path.

### 3.5 Vendored third-party code

Where upstream licences permit, the vendored tree is deposited in full. Where they do not (notably the Semtech SX1302 HAL; see `oss-attribution.md` §3.1), the deposit substitutes a pinned Git commit reference and the upstream licence text; reconstitution is performed by the recipient by cloning the upstream repository at that commit.

### 3.6 Verification deposits

The escrow agent performs a format-and-media verification on every deposit (readability, check-sum, tree-completeness scan against a published manifest). Full-build verification by the agent is available as a premium option elected per order form (`{TEMPLATE: full-build verification fee}`). The default option is format-and-media verification only.

---

## 4. Deposit frequency

- Every production release (minor or major version) within `{TEMPLATE: deposit lag, typically 10 business days}` of general availability.
- Security-patch releases within `{TEMPLATE: security-patch deposit lag, typically 5 business days}` of release.
- A "zero deposit" delta-only update mechanism is permitted provided the cumulative deposit remains reproducible.

---

## 5. Release trigger events

The escrow agent releases the deposit to the Licensee on occurrence of any of the following events, verified per the procedure in §6:

1. **Insolvency.** Suderra's adjudication as insolvent, bankrupt, or equivalent under applicable law, resulting in the appointment of an administrator or liquidator.
2. **Cessation of operations.** Suderra ceases to carry on the business of developing and supporting the Edge Agent for a continuous period exceeding `{TEMPLATE: cessation window, typically 90 days}`.
3. **Material breach of support obligations.** Suderra fails to deliver a security update for a confirmed CRITICAL-severity CVE affecting the Licensee's deployment within `{TEMPLATE: security-update breach window, typically 180 days}` of coordinated disclosure, and the breach is not cured within a further `{TEMPLATE: cure period, typically 30 days}` after written notice from the Licensee.
4. **Assignment without consent.** Suderra assigns the Edge Agent codebase to a third party in breach of the assignment clauses of the master agreement.

The trigger list is exhaustive; release for any reason not enumerated above is not permitted.

**(LEGAL REVIEW REQUIRED)**

---

## 6. Release conditions

On occurrence of a claimed trigger:

1. The Licensee delivers written notice to the escrow agent and to Suderra, citing the trigger and attaching initial evidence.
2. Suderra has `{TEMPLATE: trigger-dispute window, typically 30 days}` to dispute the trigger in writing. A disputed trigger is resolved by an independent auditor acceptable to both Parties, whose determination is final absent manifest error.
3. If Suderra does not dispute, or if the auditor confirms the trigger, the escrow agent releases the deposit to the Licensee under the licence terms recorded in §7 below.
4. If the trigger is disputed and not confirmed, the deposit remains sealed and the Licensee bears the auditor's fee; otherwise Suderra bears the fee.

---

## 7. Licence on release

On release of the deposit, the Licensee receives a non-exclusive, non-transferable, perpetual licence to:

- Use, modify, and build the deposited source code **solely for the purpose of continuing to operate the Licensee's existing deployments of the Edge Agent** as at the trigger date.
- Create derivative works for the sole purpose of maintenance, security patching, and interoperability with the Licensee's existing systems.

The released licence does **not** include:

- The right to distribute the source or derivative binaries to any third party other than a qualified maintenance contractor engaged by the Licensee under a written confidentiality obligation.
- The right to use the released materials to compete with Suderra or any successor-in-interest in the general market.
- Ownership of the underlying intellectual property, which remains with Suderra (or its successor).

**(LEGAL REVIEW REQUIRED)**

---

## 8. Confidentiality

The deposit is the confidential information of Suderra until the moment of release. After release, the released materials remain confidential as between the Licensee and any third party, and the Licensee extends equivalent confidentiality obligations to its employees, contractors, and agents.

---

## 9. Costs

- Initial escrow-agent fees and annual renewal fees are borne by `{TEMPLATE: fee allocation — commonly Licensee bears renewal, Suderra bears initial deposit}`.
- Extraordinary costs (verification deposit, auditor fees on a confirmed trigger) are borne per §3.6 and §6 respectively.

**(LEGAL REVIEW REQUIRED)**

---

## 10. Term and termination of the escrow

The escrow arrangement remains in force while the Licensee holds a valid licence to the Edge Agent. It terminates on the later of (a) expiry of the master licence without renewal, and (b) any applicable mandatory-retention period for deposited materials under the law of the escrow agent's operating jurisdiction. On termination, deposits are returned to Suderra or destroyed at Suderra's election.

---

Export-control reference date: 2026-04-24
