# ADR-028 — Lib-creation rubric (when to make a new lib, and where)

- **Status:** Accepted — 2026-04-23
- **Deciders:** orchestrator, data-expert, frontend-expert, platform-kernel-expert
- **Supersedes:** none (first formal rubric; prior implicit pattern documented in the 2026-04-22 cold-audit Phase C.1)
- **Tracked finding:** none (this ADR itself is the architectural answer to the "no documented rule" gap surfaced in the cold audit)

## Context

The 2026-04-22 cold audit surfaced ~5000 lines of duplicate domain code, all of it "should have been extracted to a shared lib" work (AUDIT-HIGH-004 water-chemistry, AUDIT-HIGH-005 ST-AST, AUDIT-HIGH-006 node-components edges, AUDIT-HIGH-007 AI-safety). In every case the right home already existed — `libs/aquaculture-engines`, `libs/node-components`, `libs/backend-common` — but web/service teams wrote local copies instead.

The root cause, per the Phase 2 Explore agent's Q3 analysis, is that **no documented rule defines "when to make a new lib vs. put it in backend-common vs. keep app-local"**. New contributors reinvent the decision each time, and the answers drift.

This ADR fixes that. It lists the exact criteria a piece of code must meet to live in each home, so the decision becomes lookup-not-reasoning.

## Decision

Every shared module lives in exactly one of the following locations. Choose the FIRST row whose criteria all match:

| Home | Primary criteria | Secondary / tie-breakers |
|---|---|---|
| `apps/<svc>/src/_shared/` | one consumer service; zero risk of a second consumer emerging within the next release cycle | strictly service-specific (references the service's domain events, entities, or endpoints) |
| `libs/backend-common/src/<subdir>/` | cross-cutting NestJS-ecosystem primitives (guards, middleware, interceptors, decorators, providers, tenant/auth/database wiring) | depends on `@nestjs/*` packages; no domain-specific semantics |
| `libs/event-contracts/` | domain event shapes shared across emitter and consumer service | pure types + small validators; no NestJS runtime |
| `libs/<domain-specific-lib>/` (new) | ≥2 consumers in `apps/`, OR ≥1 `apps/` and ≥1 `web/` consumer | pure or pure-algorithmic code; no service-specific NestJS decorators; no tight coupling to a single bounded context |
| `web/shared-ui/` | UI components or hooks with React peer dep; consumed by ≥2 web modules | Module Federation exposed if cross-MFE |
| `libs/node-components/` | ReactFlow primitives (nodes, edges, handles) | used by at least one SCADA / process-editor / automation canvas |
| `platform/libs/<name>/` | cross-cutting platform concern that crosses the app/lib boundary (CQRS bus, event bus, outbox) | always has a corresponding ADR establishing the pattern |

### Examples mapped onto this rubric

| Example | Home | Rationale |
|---|---|---|
| `libs/aquaculture-engines/water-chemistry/water-quality.ts` | `libs/<domain>/` | pure thermodynamics; used by ai-service (backend) and farm-module (web). Two-tier consumer ⇒ lib. |
| `libs/sensor-automation-types/` (new per AUDIT-HIGH-005) | `libs/<domain>/` | pure IEC-61131 AST types; used by sensor-service parser AND sensor-module simulator. Two-tier consumer ⇒ lib. |
| `libs/backend-common/src/ai-safety/` (new per AUDIT-HIGH-007) | `libs/backend-common/<subdir>/` | cross-cutting security (SSRF validation, PII scrubber) used by ≥3 backend services; NestJS @Injectable form. Single-tier cross-service ⇒ backend-common subdir. |
| `libs/node-components/edges/OrthogonalEdge.tsx` | `libs/node-components/` | ReactFlow edge primitive; web-only with React peer dep. |
| `web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx` (new per AUDIT-MEDIUM-012) | `apps/<svc>/src/_shared/` | consumed only within aquamobil (cull/mortality/harvest record pages). Single-consumer scoped helper ⇒ app-local. |
| `web/shared-ui/src/components/Layout/Sidebar.tsx` (parameterized per AUDIT-MEDIUM-011) | `web/shared-ui/` | consumed by admin-panel, tenant-admin, sensor-module etc. Multi-MFE UI component. |

### Inviolable rules

1. **No backward extraction without an ADR.** If a lib already exists as the canonical home, writing a local copy in `apps/` or `web/` is architecturally forbidden. The fix is always to import from the lib, never to fork.
2. **New `libs/<name>/` requires a row in the inventory table of this ADR** (see "Lib inventory" below). The invariant test `tests/invariants/lib-creation-rubric.spec.ts` (Phase E.1 of the cold-audit plan) enforces this.
3. **`libs/backend-common/` is one lib, many sub-barrels.** Add a new subdir under `src/` instead of creating a sibling backend-common-adjacent lib.
4. **Cross-tier coupling is explicit.** A web module importing from `libs/<domain>/` is legal; a web module importing from `libs/backend-common/` is NOT (the latter is NestJS-only).

## Lib inventory (authoritative — maintained by this ADR)

Every path below has a Nx project.json + tsconfig.json + package.json. Columns describe the rubric row that justifies the lib's existence.

| Path | Rubric row | Consumers (examples) |
|---|---|---|
| `libs/alarm-core` | libs/<domain>/ | apps/sensor-service SCADA-runtime alarm engine (drift-zero decision core via `@platform/alarm-core` wasm; twin of the Rust `crates/alarm-core` the edge consumes natively) |
| `libs/aquaculture-engines` | libs/<domain>/ | ai-service, farm-management-mcp, web/farm-module, web/hydroponics-module |
| `libs/protocol-codec` | libs/<domain>/ | apps/sensor-service VFD + industrial Modbus adapters (drift-zero Modbus SSoT via `@platform/protocol-codec` wasm; twin of the Rust `crates/protocol-codec`, ADR-026) |
| `libs/backend-common` | libs/backend-common/ | every backend service (apps/*) |
| `libs/event-contracts` | libs/event-contracts/ | 30+ emitters + consumers across apps/, platform/libs/ |
| `libs/farm-shared` | libs/<domain>/ | web/farm-module |
| `libs/node-components` | libs/node-components/ | web/sensor-module (process-editor, scada-builder) |
| `libs/migration-harness` | libs/backend-common/ (deploy-time only) | apps/db-migrate CLI |
| `libs/shared-contracts` | libs/event-contracts/ (schema SSoT sibling) | event-contracts consumers |
| `libs/sdk` | libs/<domain>/ (TypeScript SDK generator outputs) | scripts/sdk codegen, agent harness |
| `libs/sensor-automation-types` | libs/<domain>/ (IEC 61131 ST AST types) | apps/sensor-service parser/analyzer/formatter, web/modules/sensor-module simulator |
| `libs/sensor-contracts` | libs/event-contracts/ (sensor-domain contract SSoT sibling — branded TagRef, tag-ref JSON Schema; deploy-payload schemas + ScadaPackageDoc upcasters join in later plan phases) | apps/sensor-service (TagResolutionService, deploy pipeline), web/modules/sensor-module (widget tag bindings), sens-api-gateway via JSON Schemas |
| `libs/shared` | libs/backend-common/ (cross-service decorators + errors) | every backend service via `@platform/shared` |
| `libs/storage` | libs/backend-common/ (MinIO object storage client) | messaging, ai, billing services |
| `libs/testing` | libs/backend-common/ (test factories + fixtures) | every backend service's spec files |
| `platform/libs/cqrs` | platform/libs/<name>/ | every CQRS handler in apps/ |
| `platform/libs/event-bus` | platform/libs/<name>/ | every event-emitting service in apps/ |
| `platform/libs/outbox` | platform/libs/<name>/ | services using the transactional outbox pattern |
| `platform/libs/pagination-contracts` | platform/libs/<name>/ | admin-api-service list producers, admin-panel HTTP consumers, farm-service resolvers, farm-module hooks — the versioned paginated-result shape both tiers must agree on |
| `platform/libs/service-catalog` | platform/libs/<name>/ | service-catalog artifact generator, deploy SSOT gates, gateway subgraph registry |
| `web/shared-ui` | web/shared-ui/ | every web module (admin-panel, farm-module, etc.) |

**Pending additions (not yet on disk — will join the inventory above when the cold-audit remediation commits land):**

_(None currently pending. `libs/sensor-automation-types` was promoted from this list to the main table when AUDIT-HIGH-005 landed on 2026-04-23.)_

## Enforcement (Phase E.1 of the cold-audit plan)

`tests/invariants/lib-creation-rubric.spec.ts` (created under AUDIT finding E.1 follow-up) reads this ADR's Lib-inventory table and asserts:

1. Every dir under `libs/`, `platform/libs/`, `web/shared-ui`, `web/node-components` (if that ever exists) has a row in the table.
2. Every row in the table points at a dir that exists with `package.json#name`, `tsconfig.json` present.
3. Every new path committed under these roots must add a matching table row OR the invariant fails the PR.

Adding a new lib without updating this ADR is therefore architecturally impossible — the test blocks the commit.

## Alternatives considered

### A. Leave the rubric informal

Continue letting each contributor decide. This is the status quo, which produced the ~5000 lines of duplicate code the cold audit surfaced. Rejected — the cost is paid every audit cycle.

### B. Put everything in `libs/backend-common/`

Simpler to find but pollutes the semantics: non-NestJS pure algorithms (water chemistry) would sit next to @Injectable providers. Rejected — already tried and abandoned in the pre-2026-04 architecture refactor that created the separate `libs/aquaculture-engines` and `platform/libs/*` split.

### C. One lib per consumer pair

Extreme granularity (e.g., `libs/water-chemistry-for-farm-module`). Rejected — explodes the project graph and duplicates maintenance.

## Consequences

- **Positive:** C.2–C.7 of the cold-audit remediation has a deterministic home-assignment for each duplicate cluster. Future duplicate detections have a ready-to-apply answer.
- **Positive:** E.1 invariant makes it structurally impossible to add a new lib without updating this ADR.
- **Positive:** New contributors read one table instead of inferring from surrounding code.
- **Negative:** Moving an existing lib to a different row (e.g., reclassifying from `<domain>/` to `backend-common/<subdir>/`) requires an ADR amendment. This is intentional — rows are meant to be stable.
- **Mitigation:** The rubric permits app-local `_shared/` for single-consumer cases, so the pressure to create a lib prematurely is lower.

## References

- `/root/.claude/plans/cold-audit-architectural-remediation-2026-04-23.md` — the plan section that specifies C.1 as the blocker for C.2–C.7.
- `docs/reviews/_audit/2026-04-22-cold-audit/02-jscpd-clusters.md` — 1946 duplicate clones, top 33 ≥100 lines, which drove the rubric's criteria.
- `docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-HIGH-004` through `#AUDIT-HIGH-007` — the specific extractions this rubric governs.
