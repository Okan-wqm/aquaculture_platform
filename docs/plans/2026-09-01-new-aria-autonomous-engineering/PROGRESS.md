<!-- GENERATED: render-projections.mjs@1.0.0; source-sha256=352dd09a8184833a87bc61db8c1d2ac7481556064f0da603a5e627247567124f; generator-sha256=15efcf6b67ee508afc15f407962d227585b00fed485b0d259f0e86432c087ac6; DO NOT EDIT -->

# Yeni ARIA Program Progress — D0 Projection

> Generated projection; writable authority değildir. Authority:
> [`progress/events.jsonl`](progress/events.jsonl) ve [`progress/evidence/`](progress/evidence/).

- **Program ID:** `new-aria-autonomous-engineering`
- **Projection generated from event at:** `2026-09-01T19:10:37Z`
- **D0 state:** `VERIFYING`
- **Materialization evidence:** [D0-plan-materialization.json](progress/evidence/D0-plan-materialization.json)
- **Materialization digest:** `0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558`
- **Review evidence:** [D0-review-c6065d6d-changes-required.json](progress/evidence/D0-review-c6065d6d-changes-required.json)
- **Review evidence digest:** `02056a2752414ff180b1ff7e19758da2dd9e2a225a007510925c92054f3647d2`
- **Review verdict:** `CHANGES_REQUIRED` (non-admission)
- **Event count:** 5
- **Event-chain tail:** `3939569ef02719e9167b3b82c5cf0d57dc373561148ee5af9768e7a767caa696`
- **Corrective status:** pending fresh external twelve-role review
- **D0 merge:** pending

## Projection

| Scope         | State       | Evidence / next gate                                        |
| ------------- | ----------- | ----------------------------------------------------------- |
| D0 correction | `VERIFYING` | APP remediation authored; fresh review has not admitted it. |
| P01 / S01-S08 | `PLANNED`   | D0 merge and P01 external 12-role gate required.            |
| P02 / S09-S16 | `PLANNED`   | P01 evidence seal required.                                 |
| P03 / S17-S24 | `PLANNED`   | P02 no-side-effect seal required.                           |
| P04 / S25-S32 | `PLANNED`   | P03 `EXECUTE_NO_PUSH` seal required.                        |
| P05 / S33-S40 | `PLANNED`   | P04 `PR_OPEN` seal required; merge disabled.                |
| P06 / S41-S48 | `PLANNED`   | P05 adversarial seal required.                              |
| P07 / S49-S56 | `PLANNED`   | P06 burn-in evidence required.                              |
| P08 / S57-S64 | `PLANNED`   | P07 low-risk evidence required.                             |
| P09 / S65-S72 | `PLANNED`   | High-risk activation remains prohibited.                    |

## Sprint counts

| State         | Count |
| ------------- | ----: |
| `PLANNED`     |    72 |
| `READY`       |     0 |
| `IN_PROGRESS` |     0 |
| `VERIFYING`   |     0 |
| `DONE`        |     0 |
| `BLOCKED`     |     0 |
| `SUPERSEDED`  |     0 |

D0 program sprint'i değildir; D0 ayrıca `VERIFYING` olarak yukarıda gösterilir.

## Remaining before D0 can leave VERIFYING

1. Corrective head için fresh, exact-head twelve-role reports ve independent appellate verdict.
2. Fresh verdict `ACCEPTED` ise ayrı immutable admission evidence/event.
3. D0 PR merge ve actual main SHA için ayrı ledger-close event.

Bu projection live, merge-authorized veya legacy ARIA replacement iddiası taşımaz.
