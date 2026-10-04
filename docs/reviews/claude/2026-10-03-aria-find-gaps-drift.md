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
  F-002..F-008, seeded 2026-07-02 as HIGH `cross_service`).
- The farm-module finance scope list `FARM_OPEX`/`FARM_REVENUE` was compared with
  `libs/event-contracts/src/finance-events.ts:38` (`... | 'HR_EXPENSE'`) and minted HIGH
  cross-service (F-001, F-004, F-006). `HR_EXPENSE` is produced only by `apps/hr-service`;
  farm-module reaches only the farm subgraph's `FinanceCategoryScope`. That subset is correct.
- At HEAD the scan reports 0 drifts: the inline-options naming turned the leave filter into
  `unknownOptions` (suppressed as `unsafe_name`), so even the folded signal disappeared.

## Fix

`tools/aria-poc/drift_wire.py` (new) and `poc.py`, `seed_drift_findings.py`:

1. **Keys and values.** `detect_ts_enums` records `keys` and runtime `values`;
   `registerEnumType(X, { name })` marks `X` GraphQL-exposed (`graphql_name`,
   `wire_values = keys`). SDL enums are on the wire by definition.
2. **Wire facts from the composed supergraph** — the artifact
   `scripts/ci/validate-graphql-operations.mjs` validates against, written by
   `scripts/apollo-router/build-supergraph.mjs` at `dist/graphql/supergraph.graphql`
   (`--supergraph` overrides). Read: enum owners (`@join__type`), per-value owners
   (`@join__enumValue`), root-field owners (`@join__field`); graphs map to `apps/<project>`
   through `infrastructure/apollo-router/subgraphs.json`. A UI module's backends are the
   subgraphs its operations' root fields hit. Missing or unparseable inputs give
   `status=unavailable` with a named reason (`supergraph_not_found`,
   `subgraph_registry_not_found`, `subgraph_unregistered:<name>`, ...); every UI pair is then
   `wire_unverifiable:<reason>`, never matched.
3. **Exact, per transport.** GraphQL (the source is on the wire and owned by a subgraph the
   module hits): compare with the wire values. A source owned by such a service but not on
   the wire is `source_not_on_ui_transport`. DB (SQL enums) and REST: runtime values.
   Case-folded similarity only selects candidate pairs. Frontend types and Rust variant
   names are not transport contracts and are not compared; SDL keys and Rust variants are
   not DB values and leave the TS-SQL comparison.
4. **Classification decides severity.** UI value not on the wire: HIGH
   `ui_value_not_on_wire`. Subset whose missing values the module's own backend owns: LOW
   `own_service_subset`. Subset whose missing values another service owns (per-value owner
   from the supergraph, else a literal index of `apps/<svc>` source): no finding.
   TS-SQL: `ts_value_not_in_db` HIGH, `ts_subset_of_db` LOW. `cross_service` is true only
   when the source owners and the module's backends are disjoint. The seeder mints the
   scanner's severity; an unclassified drift is unmintable, and the kernel's `spine_drift`
   floor (MEDIUM) refuses LOW subsets, which the seeder discloses.
5. **Group naming.** An inline options group takes its element's `id`/`name`
   (`leave-filter-status`, `new-category-scope`).

## Evidence

Red on unfixed code, green after:

- `tools/aria-poc/invariants/test_drift_wire_semantics.py` (6 tests; CI runs this directory
  in `aria-kernel.yml`): red 5 errors + 1 failure (`load_wire` absent, `keys` absent,
  `BatchStatus` 'ACTIVE' vs 'active' not a drift); green 6/6. On the same fixtures the
  unfixed comparison reports `missing ['draft', 'withdrawn']` with `cross_service` True for
  the lower-case filter, and `missing ['hr_expense']` with `cross_service` True for the
  `FARM_*` subset.
- `aria-kernel/tests/test_seed_mint_migration.py`: red 3 (cross_service HIGH, MEDIUM for a
  same-service HIGH, unclassified minted); green.

Repo run at 405f2ecac with a supergraph composed from the same commit: wire ok (271 enums,
1170 root fields, 10 web modules mapped). One UI drift: `LeavesPage.tsx:389`
`leave-filter-status` vs `LeaveRequestStatus` HIGH `ui_value_not_on_wire` over graphql,
cross_service False. `new-category-scope`: `FinanceCategoryScope` match,
`FinanceScope` `foreign_service_subset`, the SQL enum `source_not_on_ui_transport`.
TS-SQL above threshold: 0. Without a supergraph (the CI acceptance lane) every UI pair is
`wire_unverifiable:supergraph_not_found` and the acceptance harness still accepts.

## Boundary

`aria-auto-cycle.yml` runs the seeder on the self-hosted runner without composing a
supergraph, so in that lane every UI pair is `wire_unverifiable:supergraph_not_found` and the
seeder prints `WIRE UNAVAILABLE`. Composing there (eleven ts-node SDL emits on the runner
that shares the production box) or fetching the `supergraph-sdl` artifact of
`apollo-supergraph-validate.yml` is an operator decision this change does not make; the
scan states the gap by name instead of judging without the wire.
