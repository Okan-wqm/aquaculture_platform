# CRITICAL — Read BEFORE and AFTER every change

- Run `nx affected --target=test` and `nx affected --target=lint` after changes. Never commit with red tests.
- Every fix must be an architectural root-cause fix. No workarounds, patches, defensive `?.`, `as any`, or compat shims. See **Architectural Approach** below for the 4-tier hierarchy and banned-phrase list — both are load-bearing, not decoration.
- Keep domain entities separate from persistence entities. ORM decorators do not belong in the domain layer.
- Every `@Entity()` declares `schema:` UNLESS it belongs to a tenant-scoped service (`farm`, `sensor`, `hr`, `messaging`, `hydroponics`, `ai`, `alert`) AND the table is per-tenant (cloned by `TenantSchemaSyncService`). Per-tenant entities OMIT `schema:` so search_path tenant routing places them in `tenant_<uuid>` at runtime. Cross-tenant tables within those services (outbox, audit_logs) keep `schema:` explicit. Architecture spec at `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts` enforces. Never add tables to `public`.
- NATS identity is cert CN only (ADR-015). No user/pass in CONNECT frame.
- Batch operations: run all file reads/writes and bash commands in parallel within a single message.
- `git push` after every commit on the active branch. No force push.

---

## Behavioral Rules

- Do what has been asked; nothing more, nothing less
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create docs (`*.md`) or READMEs unless explicitly requested
- NEVER save working files, scratch notes, or tests to the repo root
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or `.env` files (`.claude/settings.json` deny rule active)

## Commands

```bash
# Dev
npm run infra:up                 # Postgres + Redis + NATS + MinIO + Mosquitto
npm run dev:backend              # All backend services (Nx run-many)
npm run dev:web                  # Shell + microfrontends

# Build & Test
nx affected --target=build       # Affected build
nx affected --target=test        # Affected tests
nx affected --target=lint        # Lint
nx test <service> --coverage     # Single service with coverage
npm run type-check               # tsc --noEmit (platform-wide)

# Docker
docker compose -f docker-compose.droplet.yml up -d      # Production droplet
docker compose -f docker-compose.yml up -d              # Full dev stack
docker compose -f docker-compose.dev.yml up -d          # Dev (pre-built artifacts)

# Codegen & Format
npm run codegen                  # GraphQL codegen
npm run format                   # Prettier write
```

## Architecture Map

Nx monorepo. NestJS microservices (`apps/`), React microfrontends (`web/`), platform libs (`platform/libs/`), shared libs (`libs/`), Rust edge gateway (`sens-api-gateway/`).

### Backend Services (`apps/`) — 17 services (15 runtime + `sensor-ingestion` Rust sidecar + `db-migrate` CLI)
| Service | Schema | Responsibility |
|---|---|---|
| `gateway-api` | — | API gateway, auth guard, rate limiting, CSP, OPA |
| `auth-service` | `auth` | JWT (RS256), RBAC, tenant provisioning, refresh token rotation, MFA |
| `farm-service` | `farm` | Farm, pond, batch, feed, harvest, water quality (schema-per-tenant) |
| `sensor-service` | `sensor` | Sensor ingestion, calibration, aggregation, MQTT/LoRaWAN (schema-per-tenant) |
| `sensor-ingestion` | `sensor` | Rust sidecar for high-throughput sensor payload decode + NATS publish (ADR per `project_rust_migration.md` hybrid plan) |
| `hydroponics-service` | `hydroponics` | Hydroponics config, grow cycles (schema-per-tenant) |
| `alert-engine` | `alert` | Alert rules, risk scoring, escalation (schema-per-tenant) |
| `billing-service` | `billing` | Subscription, invoicing, Stripe webhook/API |
| `hr-service` | `hr` | Personnel, leave, payroll, shifts (schema-per-tenant) |
| `messaging-service` | `messaging` | Channels, messages, GDPR, AI bridge (schema-per-tenant) |
| `admin-api-service` | `admin` | Platform management, analytics, audit, impersonation |
| `notification-service` | `notification` | Push, email, SMS dispatch |
| `ai-service` | `ai` | AI agents, conversation, cost tracking, guardrails (schema-per-tenant) |
| `config-service` | `config` | Dynamic configuration |
| `event-store-service` | `event_store` | Event persistence, projections |
| `observability-service` | — | Prometheus, tracing, security events |
| `db-migrate` | — | Standalone migration runner CLI (not a long-running service) |

### Platform Libs (`platform/libs/`)
- `@platform/cqrs` — Command/Query bus, handler decorators
- `@platform/event-bus` — NATS event bus abstraction, handler registration
- `@platform/outbox` — Transactional outbox (entity base, worker, publisher, metrics)

### Shared Libs (`libs/`)
- `libs/backend-common` — dual-aliased as `@aquaculture/backend-common` (primary — used by every app) and `@platform/backend-common` (equivalent alias). Bootstrap, guards, tenant context, RLS, health, audit, telemetry, pagination, Redis, NATS factory, signed HTTP client, schema-drift validator, migration-runner factory.
- `@platform/event-contracts` — `BaseEvent` with branded `EventId`, all domain event interfaces, JSON Schema validators, upcasters
- `@platform/testing` — Mock factories (repository, datasource, event bus)
- `@platform/shared` — Cross-cutting utilities
- `@platform/storage` — File storage abstraction

### Web (`web/`)
React microfrontends via Module Federation. `shell` is host. Modules: dashboard, farm-module, sensor-module, hr-module, admin-panel, tenant-admin, hydroponics-module. Design system: `shared-ui`.

### Edge Gateway (`sens-api-gateway/`)
Rust. Sensor protocol gateway: Modbus-TCP, MQTT, I2C, Atlas EZO. Alarm engine, calibration, GPIO, backup, SCADA deploy orchestrator.

---

## Architectural Approach (Root-Cause Only — TIME IS NOT AN EXCUSE)

**ABSOLUTE RULE:** Every fix, every time, must be an ARCHITECTURAL solution. Patches are FORBIDDEN. Taking the easy way out is FORBIDDEN. Going around the problem is FORBIDDEN. Ignoring it is FORBIDDEN. **However long the architectural fix takes, it takes that long — the architectural fix still gets done.**

The test for every bug: *"If the upstream were correct, would this code need to exist?"*

- Interface/type mismatch → fix the interface or the implementation
- Missing entity field → add `@Column` to the entity and the field to the DTO
- Cross-service inconsistency → fix the event contract AND both service sides
- NEVER: hide the crash with defensive `?.`
- NEVER: escape to a JSON column to bypass the type system
- NEVER: add a compat shim / adapter layer (one-off workaround)

**Architectural-solution hierarchy (always pick the highest tier that applies):**

1. **Make it impossible** (best) — the type system, compiler, or runtime structurally prevents the wrong behaviour
2. **Make it automatic** (great) — the correct behaviour becomes the zero-effort default
3. **Make it detectable** (good) — the wrong behaviour is caught at build/test time
4. **Document it** (last resort) — only when 1–3 are genuinely impossible

**Phrases BANNED as gating excuses:**

- "for now" / "interim solution" / "temporary"
- "pragmatic" / "simpler approach" / "middle ground"
- "for momentum" / "just this commit"
- "follow-up commit will handle it" — follow-up must be in the SAME PR or a tracked plan phase, never a vague future
- "deferred" — deferral is FORBIDDEN without an explicit owner + deadline + tracked finding ID
- "out of scope" — extend the scope or refuse the work; silent deferral is FORBIDDEN
- "good enough" / "sufficient for now"

**If the architectural fix genuinely cannot land in this session:**

- Open a CRITICAL/HIGH severity tracked finding
- Update the plan or ADR: explicit owner + deadline + finding ID
- DO NOT ship a partial fix as if it were complete — the commit message must say exactly what was NOT done and WHY
- List the unresolved architectural debt in the PR description

The cost of a quick fix is paid forever; the cost of the right fix is paid once.

## Code Quality Standards

- `as any` is FORBIDDEN — find the correct type or write a generic
- `// @ts-ignore`, `// @ts-expect-error` are FORBIDDEN — fix the type error
- `as unknown as X` casting hacks are FORBIDDEN — fix the interface or the implementation
- `getRepository()` is FORBIDDEN → use `getScopedRepository()` (tenant isolation)
- Floating promises are FORBIDDEN → every async call must be `await`ed
- `console.*` is FORBIDDEN (ESLint enforced: `no-console: error`) → use NestJS `Logger`
- Every public function needs an explicit return type
- Event objects must conform exactly to `@platform/event-contracts` interfaces

## Layer Rules

Each bounded context (`apps/{service}/src/{domain}/`):
```
{domain}/
├── commands/        # Command definitions
├── handlers/        # Command handlers
├── query-handlers/  # Query handlers
├── queries/         # Query definitions
├── dto/             # Input/Output DTOs
├── entities/        # TypeORM entities — @Entity('table'[, { schema: '<svc>' }]). Per-tenant entities in tenant-scoped services OMIT schema; cross-tenant + platform-level entities REQUIRE schema.
├── services/        # Domain/application services
├── controllers/     # HTTP controllers or GraphQL resolvers
├── __tests__/       # Unit + integration tests
└── {domain}.module.ts
```

**Inviolable rules:**
1. Controller → Service → Command/Query Bus → Handler → Repository. No layer skipping.
2. `@Entity()` schema discipline (ADR-011): platform-level + cross-tenant entities include `schema:` explicitly; per-tenant entities in tenant-scoped services (`farm`, `sensor`, `hr`, `messaging`, `hydroponics`, `ai`, `alert`) OMIT `schema:` so search_path tenant routing handles placement at runtime. Architecture spec at `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts` enforces.
3. Never add new tables to `public`. Use the owning service's schema.
4. Use `createBaseEvent()` factory. Inline event construction is a compile-time error (branded `EventId`).
5. Events are flat objects. No nested `payload` / `metadata` wrappers (ADR-006).
6. Use `getScopedRepository()`. `getRepository()` bypasses tenant isolation.
7. Handler, entity, DTO, event for one domain live in the same domain directory.

## Schema Ownership (ADR-011) & Drift (ADR-012)

- `@Entity()` schema discipline (Wave 4-A.2 update): tenant-scoped services (`farm`, `sensor`, `hr`, `messaging`, `hydroponics`, `ai`, `alert`) OMIT `schema:` on per-tenant entities so search_path routes them into `tenant_<uuid>` clones via `TenantSchemaSyncService`. Cross-tenant tables in those same services (e.g. `farm_outbox`, `messaging_outbox`, `hr_outbox`, `farm_audit_logs`, `payroll_audit`, `alert_audit_log`, `tool_execution_audit`) keep `schema:` explicit. Platform-level services (`auth`, `billing`, `admin`, `notification`, `event_store`, `observability`, `config`, `gateway`, `shared`) always declare `schema:` explicitly. SchemaDriftValidator enforces at boot; architecture spec `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts` enforces at CI time.
- Each service registers `SchemaDriftModule.forRoot({ serviceName: '<svc>' })` in `app.module.ts`. Runtime validator fires at cold start; CI invariant test (`e2e/tests/integration/schema-invariants.spec.ts`) runs every PR.
- Cross-service shared tables live in the `shared` schema only (`audit_logs`, `gdpr_data_requests`, `user_consents`, `user_permissions`, `access_logs`). Adding a 6th shared table requires an ADR + architectural-arbiter approval AND updating `SHARED_SCHEMA_TABLES` in the invariant spec.

## Migration Runners (ADR-011, ADR-012)

- Each service owns `apps/<svc>/src/database/migrations/`
- Each service has `apps/<svc>/src/database/data-source.ts` (TypeORM CLI entry point)
- Each `app.module.ts` registers `createMigrationRunnerService('<schema>')` as a provider
- `TypeOrmModule` config: `migrations: [...classes], migrationsRun: false` (the runner owns execution, not TypeORM)
- Production REQUIRES `DATABASE_MIGRATIONS_RUN=false` — the runner hard-fails otherwise
- Never hand-edit migration files — generate a new migration instead
- Blue-green safe migrations: nullable column → backfill → NOT NULL constraint

## NATS Authentication (ADR-014 / ADR-015 — cert-is-identity SSoT)

- NATS identity comes ONLY from the mTLS client cert CN (`verify_and_map: true`). User/pass auth is FORBIDDEN — the server ignores CONNECT-frame user/pass.
- `infrastructure/nats/services.yaml` is the single source of truth. Adding a NATS service = edit services.yaml + mint a cert CN + run `scripts/nats/generate-nats-conf.py`, all in the same commit (CI invariant enforces).
- `infrastructure/docker/nats/nats.conf` `authorization.users[]` block is **GENERATED** between `# BEGIN GENERATED` / `# END GENERATED` sentinels. Hand-editing the region fails the invariant test.
- `nats.conf` forbids `password:` fields and `$NATS_*_USER/PASS` variable substitution — cert-only means cert ONLY.
- The client connection factory (`libs/backend-common/src/nats/nats-connection.factory.ts`) in `mtls-cert` mode does not write user/pass/token into the CONNECT frame.
- Operator how-to: `docs/runbooks/nats-service-addition.md`. CI invariant: `e2e/tests/integration/nats-invariants.spec.ts`.

## Event Contract Rules

All event interfaces live in `libs/event-contracts/src/`. When adding a new event:
1. Add the interface to the relevant `*-events.ts` file, extending `BaseEvent`
2. Export it from `index.ts`
3. `eventType` in PascalCase: `BatchHarvested`, `SensorCalibrated`
4. Add a JSON Schema validator for trust-boundary crossings (`libs/event-contracts/src/schemas/`)
5. Write an upcaster for breaking changes (`libs/event-contracts/src/upcasters/`)

## Test Rules

- London School TDD: mock collaborators (use `@platform/testing` factories)
- Test files: `{domain}/__tests__/*.spec.ts`
- Integration: `apps/{svc}/src/__tests__/integration/` or `e2e/tests/integration/`
- E2E: `e2e/tests/` (Playwright + Jest), `tests/e2e/`
- The schema invariant test runs on every PR
- New feature → test first, then implement

## Security

- `.env` files are never committed (deny rule active in `.claude/settings.json`)
- Mask PII in logs (hash or `***`). The central `maskPii()` helper is auto-applied by `StructuredLoggerService`
- Structured JSON logging. String concatenation in log calls is banned
- Input validation: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`
- **Tenant-ID sourcing:** JWT claims are the trust anchor when an authenticated user is present (preferred by `TenantContextMiddleware`). The `x-tenant-id` header is accepted only on explicit pre-auth / cross-tenant admin / edge-device ingestion paths; every such callsite is reviewed individually. Gateway→subgraph HMAC binds tenantId into the signature (`libs/backend-common/src/utils/service-identity.util.ts`) so a compromised intermediary cannot swap tenants in flight.
- **Tenant row placement (D14, clarified by W1 audit):** the authoritative tenant record lives in the `auth` schema (`auth.tenants`), NOT in the `shared` schema. `auth` is cross-tenant by design (every login resolves a tenant before any other context). The `billing` schema holds the per-tenant subscription record (`billing.subscriptions`) keyed by `tenantId` — the billing service is the SSoT for subscription state, not shared. The `shared` schema is reserved for 4 canonical cross-tenant tables only: `audit_logs`, `gdpr_data_requests`, `user_consents`, `user_permissions`. Adding a 5th requires an ADR per ADR-011 + architectural-arbiter approval (W5 `add-shared-table` skill gate — BLOCKER-15).

## Git & Deployment Rules

- Co-Authored-By lines are NEVER added to commit messages
- Always `git push` after a commit (on the active branch)
- Force push (`--force`, `--force-with-lease`) is FORBIDDEN
- `--no-verify`, `--no-gpg-sign` and other hook-bypass flags are FORBIDDEN

**Commit format:**
```
{type}({scope}): {subject}

{body explaining WHY — the diff shows WHAT}

Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{finding-id}
```

Type vocabulary: `fix`, `feat`, `refactor`, `security`, `test`, `chore`. A `BREAKING CHANGE:` footer is required for event contract shape changes, column drops, and public API changes.

## Review Finding Traceability (MANDATORY)

Every fix commit must formally reference the review finding it closes. Otherwise `docs/reviews/` becomes audit theater — an infinitely growing knowledge base with no link to committed work.

**Rules:**
- Finding ID format: `{severity}-{sequential}` — e.g. `CRITICAL-001`, `HIGH-003`, `MEDIUM-012`
- One fix may close multiple findings — one `Closes:` line each
- Missing `Closes:` on a fix commit = PROCESS MEDIUM finding against the author
- Missing `Closes:` on a security CRITICAL fix = PROCESS HIGH finding

**State machine (tracked by context-manager):**
- `OPEN` → finding raised, no commit yet
- `IN-PROGRESS` → included in an implementation-planner package, commit pending
- `RESOLVED` → merged commit carries the matching `Closes:` line
- `STALE` → 30 days `OPEN`, weekly escalation
- `BLOCKED` → fix attempt failed or escalated to architectural-arbiter

## Concurrency (tool use)

- All operations MUST be concurrent/parallel in a single message when independent
- Batch file reads/writes/edits in ONE message
- Batch independent bash commands in ONE message

## Agent system invocation

- Canonical dispatch: `Agent(subagent_type="<agent-name>")` in a Claude Code CLI session. Claude Code auto-discovers `.claude/agents/**/*.md` (Lane-A at root, Lane-B at `.claude/agents/product-audit/`). No background runner, no API-key dispatch, no external CLI binary.
- Lane-B meta-agents use a `product-audit-*` name prefix (`product-audit-orchestrator`, `product-audit-context-manager`, `product-audit-arbiter`) to stay globally unique across both lanes. Enforced by `tests/invariants/agent-name-uniqueness.spec.ts`.
- Knowledge SSoT lives in `.claude/knowledge/layer-{1,2,3}-*.md`. Agent files reference it via `@.claude/knowledge/...` lines — these are READER BOOKMARKS only (no auto-import). Agents use the `Read` tool to load each cited file at the start of every invocation.
- Shared review contract lives at `.claude/shared/` as four fragments: `operating-modes.md`, `tier-claim-syntax.md`, `handoff-protocol.md`, `output-format.md` — plus `orchestrator-{phases,routing-table}.md` for dispatch.
- Full architectural map: `.claude/README.md`.

## ADR References (canonical location: `docs/adr/`)

001-monorepo-vs-polyrepo, 002-gateway-api-pattern, 003-sensor-service-separation,
004-temporal-workflow-adoption, 005-opensearch-logging, 006-event-contracts-flat-pattern,
007-cqrs-usage-strategy, 008-guard-strategy-defense-in-depth, 009-frontend-data-fetch-pattern,
010-frontend-styling-strategy, 011-schema-ownership-model, 012-schema-drift-prevention,
013-messaging-isolation-convergence, 014-nats-mtls-only-auth, 015-nats-cert-is-identity-ssot.

> **Known drift:** `docs/architecture/ADR-010-AI-SELF-LEARNING.md`, `docs/architecture/ADR-011-operations-hub-restructuring.md`, `docs/architecture/ADR-012-messaging-service.md`, and `docs/architecture/ADR-013-nestjs-v11-upgrade.md` are misfiled — they use ADR numbering but live outside `docs/adr/` and collide with the canonical IDs. Treat `docs/adr/` as authoritative. Moving or renumbering the misfiled files is tracked work, not done here.

## Extended Documentation Pointers

@docs/adr/           — Architectural Decision Records (canonical)
@docs/runbooks/      — Operational runbooks (chart-v2-upgrade, secret-rotation, nats-service-addition, schema-drift-response, …)
@docs/security/      — Security policies, audit reports, hardening gap reports
@docs/api/           — API conventions (OpenAPI, Postman collections)
@docs/DEPLOY.md      — DigitalOcean deployment procedure
@docs/architecture/  — Architecture diagrams (note: contains misfiled ADR-* files — see above)
@docs/guides/        — Developer guides (SCADA, VFD)

## ARIA Snowball (continuous-mode meta-system, scoped to `snowball` branch)

ARIA is a repository-shaped intelligence experiment that runs between PR cycles,
complementary to the specialized review agents that run on PR cycles.

- `@docs/aria/SPEC.md` — boundaries (laws, engines, mastery, claim authority)
- `@docs/aria/IDENTITY.md` — behavior (daily rhythm, refusals, nuance protocol, debt discipline)
- `@docs/aria/CONTRACTS.md` — schemas, adapter contracts, CLI execution model, and Phase-1 PoC
- `@.claude/knowledge/layer-1-aria.md` — discoverable anchor for other agents
- `tools/aria-poc/poc.py` — zero-LLM operator decision tool
- `/aria-poc` — Claude Code slash command wrapper

Branch policy: ARIA work lives on `snowball`. Do not merge or push ARIA work to
`main` without an explicit operator decision after the PoC decision gate.

ARIA is not one of the specialized agents. It is a meta-layer: observes first,
records evidence, and lets skills emerge from recurring repo pressure.

---

# CRITICAL — Final check (primacy/recency reinforcement)

- `nx affected --target=test && nx affected --target=lint` green before every commit.
- Architectural root-cause fix only. The banned phrases above are truly banned.
- `@Entity()` schema discipline: per-tenant entities in tenant-scoped services omit `schema:` (search_path routing); platform-level + cross-tenant entities declare `schema:`. `public` schema is off-limits for new tables.
- `createBaseEvent()` for events. Flat object pattern. No nested payload wrappers.
- NATS identity = cert CN only. No user/pass in the CONNECT frame.
- Every fix commit carries `Closes: docs/reviews/…#finding-id`.
- Keep domain entities separate from persistence. ORM decorators do not belong in the domain layer.
