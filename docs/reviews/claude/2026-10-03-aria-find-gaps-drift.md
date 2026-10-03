# ARIA find-gaps: the drift scan has no transport or ownership model (G3)

- Date: 2026-10-03
- Cycle: 2026-10-03-aria-find-gaps
- Author: claude (owner_user: okan)
- Measured on: main 405f2ecac

## ARIA-HIGH-333

ARIA's mechanical drift scan (`tools/aria-poc/poc.py`, seeded into findings by
`tools/aria-poc/seed_drift_findings.py`) decides whether a UI option list agrees with the
backend. It cannot answer that question correctly, because it never asks what travels.

### What the scan did

Where, on main 405f2ecac:

- `poc.py:175-176`: `lower_values` case-folds both sides of every comparison.
- `poc.py:942-946`, `1001-1003`, `1033`, `1052`: every TS-SQL and UI verdict goes through it.
- `poc.py:517`: `detect_ts_enums` keeps the member KEY; the value after `=` is dropped.
- Nowhere: `registerEnumType` and the composed supergraph are never read.
- `poc.py:238-244`: `service_of` makes ownership the path prefix.
- `poc.py:1071`: `cross_service` is true for every `web/` vs `apps/` pair.
- `seed_drift_findings.py:230`: severity HIGH whenever `cross_service`.
- `poc.py:781`: inline `options={[...]}` groups are named `{component}Options`.

### Consequences, measured

- `apps/hr-service/src/leave/entities/leave-request.entity.ts:18-32` declares
  `LeaveRequestStatus { DRAFT = 'draft', PENDING = 'pending', ... }` and registers it with
  `registerEnumType`, so the GraphQL wire carries the UPPER-case keys. The hr-module status
  filter (`web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:391`) sends `'pending'`.
  Folded, the two agree; the scan saw only a "missing draft/withdrawn" subset (ARIA's own
  F-002..F-008, seeded 2026-07-02 as HIGH cross_service).
- The farm-module finance scope list `FARM_OPEX`/`FARM_REVENUE` was compared with
  `libs/event-contracts/src/finance-events.ts:38` (`... | 'HR_EXPENSE'`) and minted HIGH
  cross-service (F-001, F-004, F-006). `HR_EXPENSE` is produced only by `apps/hr-service`;
  farm-module reaches only the farm subgraph's `FinanceCategoryScope`. That subset is correct.
- At HEAD the scan reports 0 drifts: the inline-options naming turned the leave filter into
  `unknownOptions` (suppressed as `unsafe_name`), so even the folded signal disappeared.
