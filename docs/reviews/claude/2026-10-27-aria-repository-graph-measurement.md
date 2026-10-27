# ARIA repository graph: measured against the TypeScript compiler (2026-10-27)

This review comes from an evaluation of codebase-memory-mcp, an external MCP server that builds a
code graph (tree-sitter, call edges, route matching) for coding agents. The question was which of
its capabilities ARIA lacks. `aria-kernel/aria_kernel/twin.py:7` keeps symbol-level edges out of
ARIA's repository map until a consumer proves it needs them, so the first item measured is the
import layer that `impact_graph.impact_closure` walks. Its consumers are plan coverage
(`plan_coverage.py:388`, depth `PLAN_CLOSURE_DEPTH = 1`) and the admission scope
(`plan_origin.py:476`, full depth).

All numbers are at `6b7ebca3`. The measurement found two defects in the graph itself before the
granularity question could be answered. Three findings are registered: ARIA-HIGH-993,
ARIA-MEDIUM-994 and ARIA-MEDIUM-995. Plan 038 (`docs/aria/plans/038-repository-graph-soundness.md`)
sequences their closure.

## Method

- **ARIA's graph.** `impact_graph._project_graph(root, nx_graph_file=None)`. This is the graph
  `cached_service_analysis_order` builds for `impact_closure`; plan coverage passes no nx graph file.
  It has 73 projects, and `graph_source` is `local_import_scan_v1`.
- **Compiler graph.** TypeScript 5.9.3 (the repository pin) over every `.ts`/`.tsx` file under
  those 73 project roots: 8,790 files, skipping `node_modules`, `dist`, `build`, `coverage`, `target`
  and `tmp`.
  - Parsing: `ts.createSourceFile` per file. It reads import declarations, `export … from`,
    `import x = require()`, `import()`, `require()` and `jest`/`vi` mocks.
  - Resolution: `ts.resolveModuleName` under the nearest `tsconfig.json`, then `tsconfig.base.json`.
    A result under `node_modules` counts as in-repo when its real path lies inside the repository and
    outside `node_modules` (npm workspaces link `@aquaculture/*` there).
  - Named imports: each is resolved to its declaring file through `export *`, `export { } from` and
    re-exported import bindings. 45,016 resolved, 0 unresolved.
  - Unresolved specifiers: 38 repository-looking ones stay unresolved. All are css/svg/png assets,
    archived migrations whose target was removed, or an adapter fixture. None is a TypeScript module.
- **Closures.**
  - Project-level: ARIA's reverse dependents, minus the touched projects, as `impact_closure`
    reports them.
  - File-level: the projects holding a file that imports a declaration of the changed file. Inside
    the changed project the change propagates file by file: a file there that imports the changed
    file counts as changed.
  - Both are computed at depth 1 and at full depth. Contract edges (`event`, `gateway_subgraph`) are
    identical in both and left out.
- **History.**
  - `tools/plans/events.jsonl` on `aria/state`: 45 `coverage_computed` events of 42 plans.
  - The 403 non-merge commits with a parent in this clone (2026-10-16..27). The shallow clone's
    parentless graft roots diff against an empty tree and are excluded.
- **Not measured.** Symbol-level call edges, CQRS bus dispatch, NATS subjects, REST routes.

## Results

### ARIA's own plans have not exercised the closure

In all 45 coverage events the closure reached at most 2 projects. The plans touched
`.github/workflows/*`, one hr-module page with its entity, `web/modules/admin-panel/vite.config.ts`
and review documents. None touched a library. History therefore shows no over-reach, and it cannot
rule over-reach out either.

### The project graph is unsound in both directions (ARIA-HIGH-993)

ARIA finds 182 edges, the compiler 192.

Phantom edges: 7, every one an import-shaped text in a comment or string literal.

| Edge                              | Site                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `aria-adapters → outbox`          | `tools/aria-adapters/module-schemas-source.test.ts:56` (string)    |
| `backend-common → shared`         | `libs/backend-common/src/filters/http-exception.filter.ts:21`      |
| `invariants → billing-service`    | `tests/invariants/stripe-calls-via-canonical-client.spec.ts:80`    |
| `invariants → messaging-service`  | `tests/invariants/legal-hold-drop-partition-guard.spec.ts:89`      |
| `invariants → sensor-module`      | `tests/invariants/web-preview-data-path.spec.ts:82`                |
| `tools-eslint-rules → ai-service` | `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts:72`            |
| `tools-eslint-rules → shared-ui`  | `tools/eslint-rules/rules/no-bare-tenant-query-key.ts:64` (string) |

Missed edges: 17. Fifteen are relative imports across a project boundary, which
`_project_for_import` (`impact_graph.py:946-968`) never resolves against the importing file. Two
import `@aquaculture/farm-shared`, a workspace package that has no `tsconfig.base.json` path.

| Edge                               | Site                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `config-service → service-catalog` | `apps/config-service/src/configuration/handlers/config-runtime-nats.handler.ts:27`    |
| `sensor-service → sensor-module`   | `apps/sensor-service/src/scada-runtime/scada-types.ts:24`                             |
| `shared-ui → event-contracts`      | `web/shared-ui/src/types/__tests__/messaging-ws.spec.ts:31`                           |
| `farm-module → farm-shared`        | `web/modules/farm-module/src/hooks/useEquipmentParameters.ts:11` (workspace)          |
| `web-apps-aquamobil → farm-shared` | `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx:1` (workspace) |
| `aqua-scripts → backend-common`    | `scripts/ci/validate-signals-manifest.ts:32`                                          |
| `aqua-scripts → db-migrate`        | `scripts/schema-registry/generate-init-schemas.ts:45`                                 |
| `aqua-scripts → service-catalog`   | `scripts/service-catalog/generate-artifacts.ts:8`                                     |
| `invariants → admin-api-service`   | `tests/invariants/admin-api-production-posture.spec.ts:22`                            |
| `invariants → aria-adapters`       | `tests/invariants/module-schemas-source-parity.spec.ts:4`                             |
| `invariants → db-migrate`          | `tests/invariants/platform-service-catalog-parity.spec.ts:6`                          |
| `invariants → event-store-service` | `tests/invariants/value-transformer-column-default.spec.ts:58`                        |
| `invariants → farm-service`        | `tests/invariants/value-transformer-column-default.spec.ts:61`                        |
| `invariants → hr-module`           | `tests/invariants/web-console-series-contrast.spec.ts:31`                             |
| `invariants → outbox`              | `tests/invariants/tenant-erasure-ssot.spec.ts:15`                                     |
| `invariants → service-catalog`     | `tests/invariants/deploy-startup-budget-ssot.spec.ts:39`                              |
| `invariants → shell`               | `tests/invariants/web-console-nav-coverage.spec.ts:42`                                |

ARIA reads TypeScript imports twice, with two different rules. `twin.py:78` reads relative
specifiers only and resolves them itself; `impact_graph.py:22` reads every specifier and resolves
none of the relative ones. `source_facts.py` documents the same failure for Python, where two
parsers of one module drifted, and closed it with one owner of the parse.

### The cache that feeds the closure never sees a new import (ARIA-MEDIUM-994)

The trees at `68e992a1` (2026-10-18) and `6b7ebca3` have the same `_graph_fingerprint`. Over the
same trees `_project_graph` returns 181 and 182 edges. The fingerprint (`impact_graph.py:382-399`)
digests project names, roots and `tsconfig.base.json` only. None of those inputs changed in the 403
commits measured, so a cache built on 2026-10-16 is the one still served at `6b7ebca3`. The edge
that differs between the two trees is the `aria-adapters → outbox` phantom; a real new edge is
dropped by the same mechanism.

### File-level edges halve the closure (ARIA-MEDIUM-995)

**Per library source file.** 757 non-test files in the 16 projects with two or more reverse
dependents.

- Depth 1: the median project-level closure is 19 projects; the file-level median is 7 (p90 14).
- Full depth: 23 against 8.
- 12% of these files have no consumer outside their own project.

| Project                             | Files | Project-level (depth 1) | File-level median | File-level max |
| ----------------------------------- | ----: | ----------------------: | ----------------: | -------------: |
| `backend-common`                    |   334 |                      21 |                 7 |             18 |
| `shared-ui`                         |   227 |                      12 |                 8 |             10 |
| `event-contracts`                   |    77 |                      19 |                 3 |             19 |
| `aquaculture-engines`               |    18 |                       4 |                 2 |              5 |
| `sensor-contracts`                  |    17 |                       2 |                 1 |              2 |
| `event-bus`                         |    14 |                      18 |                14 |             17 |
| `@aquaculture/shared-contracts`     |    13 |                      21 |                 4 |             19 |
| `testing`                           |    12 |                      32 |                 3 |             15 |
| `outbox`                            |    11 |                      15 |                13 |             14 |
| `platform-cqrs`                     |     8 |                       3 |                 2 |              3 |
| `storage`                           |     8 |                       5 |                 3 |              4 |
| `shared`                            |     6 |                       3 |                 0 |              1 |
| `migration-harness`                 |     5 |                       6 |                 0 |              6 |
| `service-catalog`                   |     3 |                       3 |                 5 |              6 |
| `@platform/sensor-automation-types` |     2 |                       2 |                 2 |              2 |
| `pagination-contracts`              |     2 |                       6 |                 6 |              6 |

`service-catalog` is the one row where the file-level closure exceeds the project-level one. It
grows through the edges ARIA-HIGH-993 lists as missed.

**Real commits.** 15 of the 403 commits have a non-empty project-level import closure. Over those 15:

- Depth 1: 155 projects in total, against 78 at file level (median 10 against 4).
- Full depth: 202 against 107 (median 11 against 7).
- 14 shrink and one grows: `7440952a`, through the missed `service-catalog` edges.

| Commit     | Date       | Touched projects                                           | Depth 1: project → file | Full: project → file |
| ---------- | ---------- | ---------------------------------------------------------- | ----------------------: | -------------------: |
| `36558f75` | 2026-10-22 | testing, invariants, web-apps-aquamobil, sensor-module     |                 29 → 11 |              34 → 11 |
| `c081976e` | 2026-10-17 | farm-service, @aquaculture/shared-contracts, invariants, … |                  22 → 7 |               34 → 7 |
| `2fb15008` | 2026-10-22 | hr-service, @aquaculture/e2e-tests, backend-common, …      |                 26 → 21 |              27 → 21 |
| `a2490e0c` | 2026-10-18 | farm-service, event-contracts                              |                  18 → 9 |              23 → 16 |
| `1070bf1c` | 2026-10-18 | farm-service, event-contracts, invariants                  |                  17 → 8 |              22 → 15 |
| `7440952a` | 2026-10-20 | service-catalog, invariants, aria-adapters                 |                   3 → 4 |              22 → 18 |
| `9aeeb8fd` | 2026-10-17 | shared-ui, shell                                           |                  11 → 8 |               11 → 8 |
| `a248b8a5` | 2026-10-17 | shared-ui, shell                                           |                  11 → 9 |              11 → 10 |
| `a14b1577` | 2026-10-17 | invariants, shared-ui, shell                               |                  10 → 0 |               10 → 0 |
| `2df292f3` | 2026-10-17 | invariants, admin-panel, dashboard, farm-module, …         |                   2 → 1 |                2 → 1 |
| `4ffd0a72` | 2026-10-17 | invariants, admin-panel, dashboard, farm-module, …         |                   2 → 0 |                2 → 0 |
| `0777def0` | 2026-10-22 | sensor-service                                             |                   1 → 0 |                1 → 0 |
| `6ad5e20c` | 2026-10-18 | sensor-service                                             |                   1 → 0 |                1 → 0 |
| `9f456183` | 2026-10-18 | sensor-service                                             |                   1 → 0 |                1 → 0 |
| `bbf02e02` | 2026-10-22 | sensor-module                                              |                   1 → 0 |                1 → 0 |

`a14b1577` checks the method. Its only TypeScript change in `shared-ui` is
`src/styles/__tests__/suderra-workspace-motif.spec.ts`, which nothing imports. Its other changes
there are `.svg` motifs, which neither graph has a node for. Those svg files bound the file-level
design: a changed file with no node in the file graph has to fall back to the project-level edge.

## ARIA-HIGH-993

- Severity: HIGH. Plan coverage is a gate, and a closure that misses a reached project lets a plan
  through without addressing it. ARIA's reverse dependents of `service-catalog` are `backend-common`,
  `db-migrate` and `event-store-service`. A plan whose affected surfaces include
  `platform/libs/service-catalog/src/index.ts` is held to a closure without `config-service`, which
  imports it at `config-runtime-nats.handler.ts:27`. The admission scope (`plan_origin.py:476`) is
  computed over the same closure.
- Root cause: TypeScript imports are read by a regex over raw text (`impact_graph.py:22`) and
  resolved by alias prefixes plus a root-prefix heuristic (`:946-968`). TypeScript's own parser and
  module resolver are not used. A second reader with other rules sits at `twin.py:78`.
- Rule: one exact reader per language owns import facts; `source_facts.py` sets this for Python.
- Owner: Okan-wqm. Deadline: 2026-11-17. Plan 038 G1.

## ARIA-MEDIUM-994

- Severity: MEDIUM. The failure is fail-open in the same gate, but the measured rate of new real
  cross-project edges is low: none landed in the ten days measured.
- Root cause: the cache key (`impact_graph.py:382-399`) omits the files the cached edges are read
  from. `cached_service_analysis_order` (`:421-455`) returns cached `dependencies` while the key
  matches, and `impact_closure` (`:102-111`) builds its import edges from them.
- Rule: a derived index is keyed by everything it is derived from.
- Owner: Okan-wqm. Deadline: 2026-11-17. Plan 038 G1.

## ARIA-MEDIUM-995

- Severity: MEDIUM. The cost is over-reach: plan coverage asks a plan to cover or waive projects
  its change cannot reach, and the admission scope widens to them. ARIA's own plans have not paid
  this yet, because none touched a library. Any plan that does will pay it, at twice the measured
  file-level closure.
- Root cause: the import edge is project-level and carries no site (`impact_graph.py:78-79`).
- Rule: an impact closure names what a change can reach.
- Owner: Okan-wqm. Deadline: 2026-12-15. Plan 038 G2. The file-level layer is the twin's
  conditional deep layer, built on the G1 reader; symbol-level call edges remain unmeasured and are
  not part of it.
