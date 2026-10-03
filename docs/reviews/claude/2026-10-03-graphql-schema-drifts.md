# GraphQL operations that do not validate against the supergraph (2026-10-03)

Context: the operations gate `scripts/ci/validate-graphql-operations.mjs` silently skipped 223 of
1039 documents (every document with a `${…}` interpolation failed to parse and hit `continue`). The
rewrite on branch `fix/graphql-call-site-variables-gate` (FE-MEDIUM-315) validates all 1089
documents and found 10 that do not validate against the composed supergraph at `405f2ecac`; it
baselines them (ceiling 10, shrink-only).

Owner: the domain agent named per finding, okan (review). Deadlines: HIGH 2026-10-17, MEDIUM
2026-10-31.

Rule: every operation a client sends validates against the composed supergraph.

## FE-HIGH-316 — Task lifecycle mutations in farm-module do not match the schema

- `web/modules/farm-module/src/hooks/useTasks.ts:253-257` —
  `mutation StartTask($id: String!) { startTask(id: $id) }`.
- `apps/farm-service/src/task/resolvers/task.resolver.ts:222-236` —
  `startTask(@Args('input') input: TaskLifecycleInput)`.
- Same file: `CompleteTask` (BAD-ARGUMENT), `AddTaskNote` and `DeleteTask` (VAR-TYPE-MISMATCH).

Starting, completing, noting and deleting a task fail GraphQL validation before any resolver runs.
Fix: build the documents from typed operations (codegen) so a signature change breaks the build, not
the button.

## FE-MEDIUM-317 — Recurring-template and stock-movement mutations declare rejected variable types

- `web/modules/farm-module/src/hooks/useRecurringTemplates.ts` — `DeleteRecurringTemplate`,
  `ToggleRecurringTemplateActive`.
- `web/modules/farm-module/src/hooks/useMaintenance.ts` — `RecordStockMovement`.

## FE-MEDIUM-318 — The SCADA trend query selects a root field the supergraph does not expose

- `web/modules/sensor-module/src/hooks/useScadaTrend.ts:109-120` — `GetTrendData` selects
  `trendData`, absent from the composed schema (MISSING-ROOT-OP), so the trend chart cannot load.

## FE-MEDIUM-319 — The farm-management MCP tank queries select fields the supergraph does not have

- `mcp/farm-management/src/graphql/queries/tanks.ts` — `ListTanks` and `ListTanksLight`
  (MISSING-FIELD).
