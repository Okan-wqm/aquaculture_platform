<!-- GENERATED: render-projections.mjs@1.0.0
source-sha256=9f70beeb92d5cfaf92c9e224405c521af7fa4c9fc6e76715276d64fc5c87a7a5
generator-sha256=906ec0401fc003fa2709cf1cec75707d85b0ad5dcb66e7381a7a3304fe933ee8
DO NOT EDIT -->

# Yeni ARIA Program Progress — D0 Projection

> Generated projection; writable authority değildir. Authority:
> [`progress/events.jsonl`](progress/events.jsonl) ve [`progress/evidence/`](progress/evidence/).

- **Program ID:** `new-aria-autonomous-engineering`
- **Projection generated from event at:** `2026-09-01T21:05:01Z`
- **D0 state:** `VERIFYING`
- **Materialization evidence:**
  [D0-plan-materialization.json](progress/evidence/D0-plan-materialization.json)
- **Materialization digest:** `0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558`
- **Review evidence:**
  [D0-review-c139f40f-changes-required.json](progress/evidence/D0-review-c139f40f-changes-required.json)
- **Review evidence digest:** `b0d345a407d24b8241d97d526cc87087581fc53a9d2755f874ece02bac38118e`
- **Review verdict:** `CHANGES_REQUIRED` (non-admission)
- **Event count:** 6
- **Event-chain tail:** `53b81ee13eaec05a86f0586eb0778f09873a7cc07a1e49fabcd343f875c34644`
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
3. D0 PR merge ve actual main SHA için external signed operator readback.

Bu projection live, merge-authorized veya legacy ARIA replacement iddiası taşımaz.
