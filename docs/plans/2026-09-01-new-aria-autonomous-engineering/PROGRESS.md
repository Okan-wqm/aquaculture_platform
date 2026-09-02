<!-- GENERATED: render-projections.mjs@1.0.0; source-sha256=1c8ecc681a9df385d45c1661dbf34002ea01ee7c987b0df29a18ce4dc34dd9ee; generator-sha256=f658c906876a0c141f577fab96399535649a15c8b49c57ac1a2b9416a1271d1c; DO NOT EDIT -->

# Yeni ARIA Program Progress — D0 Projection

> Generated projection; writable authority değildir. Authority:
> [`progress/events.jsonl`](progress/events.jsonl) ve [`progress/evidence/`](progress/evidence/).

- **Program ID:** `new-aria-autonomous-engineering`
- **Projection generated from event at:** `2026-09-01T21:05:01Z`
- **D0 state:** `VERIFYING`
- **Materialization evidence:** [D0-plan-materialization.json](progress/evidence/D0-plan-materialization.json)
- **Materialization digest:** `0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558`
- **Review evidence:** [D0-review-c139f40f-changes-required.json](progress/evidence/D0-review-c139f40f-changes-required.json)
- **Review evidence digest:** `dad30caa52dac7f16910560472ca54072ee4e2f3ea973f66a5b58b376cfdcc5d`
- **Review verdict:** `CHANGES_REQUIRED` (non-admission)
- **Event count:** 6
- **Event-chain tail:** `355732936afe3b121e88f9f03b09bdef7cbcee2813e2e0a1347da491d47ddc50`
- **Corrective status:** pending fresh external twelve-role review
- **D0 merge:** pending

## Projection

| Scope         | State       | Evidence / next gate                                           |
| ------------- | ----------- | -------------------------------------------------------------- |
| D0 correction | `VERIFYING` | c139 D remediation authored; fresh review has not admitted it. |
| P01 / S01-S08 | `PLANNED`   | D0 merge and P01 external 12-role gate required.               |
| P02 / S09-S16 | `PLANNED`   | P01 evidence seal required.                                    |
| P03 / S17-S24 | `PLANNED`   | P02 no-side-effect seal required.                              |
| P04 / S25-S32 | `PLANNED`   | P03 `EXECUTE_NO_PUSH` seal required.                           |
| P05 / S33-S40 | `PLANNED`   | P04 `PR_OPEN` seal required; merge disabled.                   |
| P06 / S41-S48 | `PLANNED`   | P05 adversarial seal required.                                 |
| P07 / S49-S56 | `PLANNED`   | P06 burn-in evidence required.                                 |
| P08 / S57-S64 | `PLANNED`   | P07 low-risk evidence required.                                |
| P09 / S65-S72 | `PLANNED`   | High-risk activation remains prohibited.                       |

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
