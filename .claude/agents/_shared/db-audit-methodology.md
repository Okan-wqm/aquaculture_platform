# Lane-D DB-Audit — Shared Methodology

**Consumed by:** the eight `db-audit-*` agents under `.claude/agents/db-audit/`. This shard is the single source of the audit method; agent files reference it and never copy it. It is an authoring fragment (no frontmatter) — not a dispatchable agent.

## Objective

For every durable column in the assigned partition, establish: (1) **provenance** — which code writes it and from what source, (2) **read exposure** — which code reads it and over which API surface, (3) **frontend reachability** — whether a user-facing surface renders or edits it. Both directions matter: durable surfaces with no product counterpart, and product surfaces with no durable counterpart. Additionally, record **every incidental defect** observed while tracing (see the mandate below).

## Column provenance matrix (compact — one row per column)

```
| column | writer | read | fe | class |
```

- **writer** (source class of writes): `FE-FORM` (user input via DTO → resolver/controller → handler), `EVENT` (NATS consumer), `SYSTEM` (cron/scheduler/derived computation), `EXTERNAL` (third-party API ingest, e.g. weather/marine/satellite/Stripe), `MIGRATION` (backfill or default only), `NONE` (no write path found).
- **read**: `GRAPHQL` (exposed on a subgraph), `REST` (controller response DTO), `BE-INTERNAL` (queries/jobs only), `NONE`.
- **fe**: `<module>/<page-or-component>`, `AQUAMOBIL`, or `NONE`.
- **class**: `OK`, `DEAD` (no write AND no read), `WRITE-ONLY` (written, never read anywhere), `BE-ONLY` (read server-side, never surfaced — legitimate only with a visible derived/audit/internal purpose), `UI-WITHOUT-DB` (FE field/action with no durable counterpart), `DUPLICATE` (same business datum persisted in 2+ places with no single physical owner), `SUSPECT` (trace inconclusive — say exactly what was searched).

Deep evidence (file:line on both sides of the edge) is REQUIRED for every non-`OK` row and FORBIDDEN as bulk padding for `OK` rows. Why: the matrix must stay scannable; evidence belongs where a decision will be made. Consequence if ignored: the report bloats past reviewability and real findings drown.

## Trace recipes

1. **Entity discovery.** Glob `apps/<svc>/src/**/*.entity.ts` AND grep `@Entity(` — several services pack many classes per file (admin-api: 33 files, 71 classes). Enumerate per class. Capture `schema:` presence for the ADR-011 placement check.
2. **Write path.** Grep the property/column name across the owning service: `dto/`, `handlers/`, `services/`; persistence via `@InjectRepository`, `TenantScopedRepository`, `withTenant(`; NATS consumers subscribe via `eventBus.subscribeWildcard` in `onModuleInit` (the `@EventHandler` decorator registry is dead code — do not trust it); migration backfills under the service's migrations dir.
3. **Read path.** `query-handlers/`, `@Resolver`/`@ObjectType`/`@Field` exposure, REST controllers + response DTOs. A GraphQL field only reaches the product if its subgraph is federated: registry `infrastructure/apollo-router/subgraphs.json` (auth, farm, sensor, hr, hydroponics, messaging, alert, billing). Resolvers in non-federated services are backend-internal.
4. **Frontend surface.** Web: `web/modules/*/src/graphql/*.operations.ts` — hand-written and NOT codegen-validated (documented in root `codegen.ts`), so a field named there may no longer exist in the schema: check both directions. Admin: `web/modules/admin-panel/src/services/api/*.ts` + hand-written types in `web/modules/admin-panel/src/services/types/*.ts` (no OpenAPI codegen — highest drift surface). Mobile: `web/apps/aquamobil/src/graphql/*` + generated `src/generated/graphql.ts` (separate client contract from web).
5. **Views.** Live migrations contain `CREATE VIEW` (farm ×3, sensor ×2). A view column's provenance is its base-table column; flag `VIEW-STALE` when the view projects dropped/renamed columns.
6. **Schema placement (ADR-011).** Per-tenant tables OMIT `schema:` (search_path routing); cross-tenant tables in tenant-scoped services DECLARE it; the authoritative cross-tenant set is `MODULE_SCHEMAS[].infrastructureTables` in `libs/backend-common/src/database/schema-manager.service.ts`. Verdict `WRONG-SCHEMA-PLACEMENT` on any mismatch. `public` is off-limits for product tables.

## Table-level verdicts

`ORPHAN-TABLE` (no meaningful write/read/FE role), `MISSING-TABLE` (FE or BE references a table/column that does not exist), `VIEW-STALE`, `WRONG-SCHEMA-PLACEMENT`, `DUPLICATE-STRUCTURE` (same concept modeled in 2+ tables/services without a declared single owner), `UNREGISTERED` (table outside MODULE_SCHEMAS / drift-validator coverage).

## Mandatory incidental findings (operator directive, 2026-07-11)

Rule: every deficiency noticed while tracing MUST be recorded in the report's **Incidental Findings** appendix, even when outside the partition scope — security vulnerabilities (tenant isolation, RLS gaps, unguarded endpoints, PII in logs), correctness bugs, duplicate structures, dead code, missing validation. Why: the audit walks surfaces no reviewer regularly visits; an unrecorded observation is lost evidence. Protected invariant: the synthesis phase sees the complete defect picture, not just parity gaps. Consequence if ignored: the platform pays for a second full traversal to rediscover what was already seen.

## Report contract

- Path: `docs/reviews/db-audit/<agent-name>/{YYYY-MM-DD}-{partition}.md` (English).
- Structure: the report skeleton from `@.claude/shared/output-format.md` (Scope, Executive summary ≤200 words, Findings by severity, Cross-domain dependencies, Verdict, References) PLUS **Appendix A: provenance matrix** (one `###` per table) and **Appendix B: incidental findings**.
- Finding IDs: the agent's own `DB-<AREA>-{SEVERITY}-{NNN}` prefix. Severity calibration: CRITICAL = cross-tenant/RLS/security or data-loss risk; HIGH = core business data unpersisted, unreachable, or double-owned; MEDIUM = partial drift, write-only accumulation, unregistered surface; LOW = inert hygiene (harmless dead column).
- Context discipline: build the report file incrementally — after finishing each domain directory, Write the full accumulated report to the same path (last Write wins). Why: a context overflow late in the run must not lose completed domains. Consequence if ignored: hours of tracing evaporate with the agent context.
- The final agent message returns ONLY: report path, row counts per class, finding counts per severity, and one-line summaries of the top findings. The report file is the deliverable; the message is a receipt.
- Evidence honesty: never fabricate a file:line. If a trace is inconclusive, class the row `SUSPECT` and state the exact greps attempted. Why: synthesis spot-checks findings first-hand; a fabricated citation invalidates the whole partition's credibility.

## Known prior signals (verify against the working tree — do not assume still true)

- `event-store-service` and `config-service` carry `@Entity()` classes without `schema:` — recorded as pre-existing ADR-011 violations in `tests/invariants/_constants.ts`.
- `billing` is registered in MODULE_SCHEMAS but appears in neither the tenant-scoped nor the platform-level module set (de-facto platform).
- hr-module GraphQL fragments have live schema drift (`Payroll.earnings/deductions`, `PerformanceGoal.keyResults`) — documented in root `codegen.ts`, which also explains why module-side operations are not codegen-checked.
- messaging-module web remote is a 4-file scaffold; the live messaging UI ships in aquamobil.
- `feed_inventory` → `storage_inventory` convergence is in flight: two untracked farm migrations (`1801300000000-*`, `1801310000000-*`) exist in the working tree as another session's work — read-only reference; `feed_inventory` may be a base table or a view depending on migration state.
- Tank over-capacity is a legitimate admin-override flow with an audit trail — not a defect by itself.
- Prior parity work: `docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md`, `docs/product-audits/schema-surface-parity-auditor/`, `docs/db/` (24 numbered architecture docs), `docs/reviews/orphan-findings.md`.
