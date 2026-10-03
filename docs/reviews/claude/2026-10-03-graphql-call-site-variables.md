# GraphQL call-site variables are unchecked, and interpolated documents are skipped (G5)

- Date: 2026-10-03
- Cycle: 2026-10-03-aria-find-gaps
- Author: claude (owner_user: okan)
- Measured on: main 405f2ecac

## FE-MEDIUM-315

`scripts/ci/validate-graphql-operations.mjs` validates frontend operation documents against the
composed supergraph. It never looks at the call that sends a document, and it does not validate
every document either.

### What the gate did

- `:118` deletes every `${...}` interpolation, so `items { ${FIELDS} }` becomes `items { }`.
- `:121-123` a document that then fails to parse is skipped with `continue`. On 405f2ecac that
  is 223 of 1039 operation documents: a vacuous pass the gate's own header forbids.
- Nothing reads a call site. The variables passed by `graphqlRequest(client, DOC, vars)`,
  `graphqlClient.request(DOC, vars)`, `graphqlFetch`, `useGraphQLQuery(key, DOC, opts)` and
  `{ query, variables }` bodies are never compared with what the operation declares.

### Consequences, measured

GraphQL ignores a variable the operation does not declare, so a key the operation lacks is a
filter the server never applies. A probe over 684 call sites (639 resolved, 45 unresolved)
found 14 such call sites, all undeclared keys:

- `web/modules/hr-module/src/hooks/useLeaves.ts:145` sends `{ filter, pagination }` to
  `GetLeaveRequests`, which declares `employeeId`, `status`, `leaveTypeId`, `startDate`,
  `endDate`, `page` and `limit` (`web/modules/hr-module/src/graphql/leave.operations.ts:56`).
- `useLeaves.ts:194` sends `{ approverId }` to `GetPendingLeaveApprovals`
  (`$departmentId $page $limit`).
- `web/modules/hr-module/src/hooks/useCertifications.ts:280` sends `{ filter, pagination }`.
- Eleven in hr-module in all; three in farm-module, where a react-query `enabled` flag sits
  inside the variables object.

## Fix

- `scripts/ci/lib/graphql-documents.mjs` reads documents from the TypeScript AST
  (`ts.createSourceFile`), so a comment backtick no longer pairs with a literal. A `${...}`
  inside a selection set is validated as `__typename`; between definitions it is a fragment
  constant and drops out; inside an argument list it is named unvalidatable. Document constants
  resolve through local consts, named and namespace imports, re-exports, `export *`, each
  file's nearest tsconfig paths (`ts.resolveModuleName`; aquamobil's `@/*` lives there) and
  codegen `DocumentNode` objects.
- `scripts/ci/lib/graphql-call-sites.mjs` finds every call that passes an operation document
  (`graphqlRequest`, `graphqlClient.request`, `graphqlFetch`, `apiClient.graphql`,
  `useGraphQLQuery` options, local wrappers), every `{ query, variables }` object, and every
  call of a known transport whose document it cannot resolve. A literal variables object is
  compared with the operation: undeclared keys and missing required variables (non-null, no
  default) are mismatches. A spread, a computed key, a non-literal value, `mutate(vars)` after
  `useGraphQLMutation`, or an unresolvable document is unresolved and counted, never passed.
- `scripts/ci/validate-graphql-operations.mjs` runs both and ratchets them against
  `scripts/ci/graphql-call-site-variables.baseline.json` the way it ratchets drift: a new
  mismatch, unparseable document or extra unresolved site fails; a fixed one must leave the
  baseline. `--call-sites-only` runs the schema-free half. Baselines are written through the
  repository's Prettier so a regenerated file is commit-clean.
- CI: `apollo-supergraph-validate.yml` runs the gate (its path filter now names the new files
  and the tsconfigs that resolution depends on). The layer-1 invariant
  `tests/invariants/graphql-call-site-variables.spec.ts` (`invariants:fast`, every PR) pins the
  fixtures, the repo run against the baseline, and the ceilings (14 mismatches, 53 unresolved,
  0 unparseable).

## Evidence

- Red on 405f2ecac: the new spec failed 7 of 7 (each fixture exited 0; the interpolated
  `GetThings { things { ${FIELDS} } bogusRoot }` was skipped; no call-site output, no
  baseline). Green after: 7 of 7, with the drift no-grow spec, the CI-reachability spec and the
  fixture-tree spec.
- Repo run on 405f2ecac with a supergraph composed from that commit: 1694 files, 1089 operation
  documents validated (the regex saw 1039 and skipped 223), 0 unparseable; 1063 call sites,
  1010 resolved, 53 unresolved (19 non-literal variables, 12 later `mutate()`, 7 spread,
  15 unresolvable documents, mostly wrapper internals); 14 mismatches, the same 14 the probe
  found: 11 in hr-module, 3 `enabled` flags in farm-module.

## Drift the skipped documents hid

Validating the documents the regex lost found 10 schema drifts that were live on main. They are
not new, so `graphql-fe-drift.baseline.json` now records them and its no-grow ceiling moves from
0 to 10 with that provenance; the product files are not changed here.

- `web/modules/farm-module/src/hooks/useTasks.ts`: `StartTask` and `CompleteTask` call
  `startTask(id:)`/`completeTask(id:)`; the schema takes `input: TaskLifecycleInput!`.
  `DeleteTask`, `AddTaskNote` declare `String!` where `ID!` is expected.
- `useRecurringTemplates.ts`: `DeleteRecurringTemplate`, `ToggleRecurringTemplateActive`
  (`String!` for `ID!`).
- `useMaintenance.ts`: `RecordStockMovement` passes `StockMovementInput!` where
  `RecordStockMovementInput!` is expected.
- `web/modules/sensor-module/src/hooks/useScadaTrend.ts`: `GetTrendData` queries `trendData`,
  which no subgraph serves.
- `mcp/farm-management/src/graphql/queries/tanks.ts`: `ListTanks`, `ListTanksLight` select
  `offset` and `hasMore`, absent from `TankListResponse`.
