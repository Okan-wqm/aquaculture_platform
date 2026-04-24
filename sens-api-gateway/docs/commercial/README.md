# Commercial & Legal Documentation — `sens-api-gateway`

> **Status:** Template-level draft. Every commercial assertion in this tree carries a **(LEGAL REVIEW REQUIRED)** stamp. No clause in this directory is binding until reviewed and approved by qualified counsel in the applicable jurisdiction(s) and incorporated into a signed agreement.

**Product:** Suderra Edge Agent (`suderra-agent`), industrial IoT edge gateway
**Release stream covered:** v1.6.0 and successor minor releases
**Document set date:** 2026-04-24
**Audience:** Siemens vendor-assessment reviewers, procurement / legal counterparties, internal legal counsel, compliance officers.

---

## 1. Scope

This directory contains the contractual and regulatory template set for commercial distribution of the Suderra Edge Agent. The documents are structured so that the signing parties can:

1. Identify the applicable licence model and acceptable-use boundaries (`license-model.md`).
2. Verify open-source compliance posture and machine-generated attribution data (`oss-attribution.md`, `third-party-notices.md`).
3. Evaluate business-continuity protections offered via escrow (`source-code-escrow.md`).
4. Map operational obligations to the correlated support-tier matrix (`support-contract.md`, paired with `../operations/support-tiers.md`).
5. Understand liability allocation for IP and cyber exposure (`indemnification.md`, `warranty-disclaimer.md`).
6. Determine export-control classification and permissible destinations (`export-control.md`).
7. Confirm data-residency and cross-border-transfer constraints (`data-residency.md`).

Per-customer red-lining, pricing, and negotiated caps are handled separately by Suderra sales and legal during contract execution; this document set is the template input to that process.

---

## 2. Document index

| File | Purpose |
|------|---------|
| `license-model.md` | Proprietary licence structure; seat / device / site options; permitted and prohibited uses. |
| `oss-attribution.md` | Every direct and transitive open-source dependency, classified by licence family; compliance posture and regeneration procedure. |
| `third-party-notices.md` | Machine-generated NOTICES file suitable for distribution with the compiled binary. |
| `source-code-escrow.md` | Escrow clause template: deposit scope, release triggers, release conditions. |
| `support-contract.md` | Contractual half of the support relationship; tiers, response-time obligations, credits, exclusions. |
| `indemnification.md` | IP indemnification and cyber-indemnification boilerplate with scope, caps, and exclusions. |
| `warranty-disclaimer.md` | Express warranty scope, disclaimers of implied warranties, and consequential-damage caps. |
| `export-control.md` | ECCN self-classification reasoning, Mass-Market Exception qualification, prohibited-destination list. |
| `data-residency.md` | Where customer data resides, lawful-transfer mechanisms, customer-choice matrix. |

---

## 3. How to use this set

- **Sales engagement.** Supply the full set during due diligence. Mark the `{TEMPLATE}` placeholders (pricing, caps, cure periods, notice periods) with the values agreed in the commercial proposal prior to contract signature.
- **Siemens vendor-assessment package.** The set is cross-referenced from `../siemens-rfp/` deliverables; reviewers follow links from the VAQ and CSQ into this tree.
- **Internal change control.** Any change to a document in this tree requires legal-counsel sign-off before merge. The `Closes: docs/reviews/commercial-legal/…` traceability convention applies.

---

## 4. Cross-references

- Crypto inventory driving ECCN reasoning: `../security/crypto-inventory.md`
- GDPR / KVKK DPIA driving data-residency statements: `../compliance/gdpr-kvkk-dpia.md`
- Support-tier operational detail: `../operations/support-tiers.md`
- Supply-chain auditor status for vendored C code: tracked in `docs/reviews/supply-chain/`

---

## 5. Banned-phrase discipline

All files in this tree follow the banned-phrase substitution table recorded in `.claude/agents/edge-docs/README.md`. Pre-commit enforcement is wired via `tools/gates/banned-phrase.ts`.

---

## 6. Legal-review posture

**(LEGAL REVIEW REQUIRED)** is applied in every document against every commercial or legal assertion. The stamp signals that:

- The drafting agent is not a lawyer and produces template text only.
- Jurisdiction-specific language (governing law, forum, arbitration, statutory overrides) must be supplied by counsel.
- Pricing, monetary caps, cure periods, notice windows, and termination mechanics are held as `{TEMPLATE}` placeholders awaiting negotiated values.
- Where existing source-of-truth artefacts are missing (notably the Semtech SX1302 HAL `LICENSE` file — see `oss-attribution.md` §3 and `third-party-notices.md` §4), the stamp is raised to **(LEGAL REVIEW URGENT)** and the work item is tracked as a pre-distribution blocker.

---

Export-control reference date: 2026-04-24
