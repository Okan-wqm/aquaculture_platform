# CRITICAL — Read BEFORE and AFTER every change

- Run `nx affected --target=test` and `nx affected --target=lint` in GitHub-hosted Actions after publishing changes; required checks must pass before merge or deploy. Local hooks check metadata only; do not run tests, builds, lint, type-check, codegen, or dependency installation on the production droplet.
- Every fix is an architectural root-cause fix. No workarounds, patches, defensive `?.`, `as any`, or compat shims. The 4-tier hierarchy and banned-phrase list under **Architectural Approach** are load-bearing, not decoration.
- Keep domain entities separate from persistence entities. ORM decorators do not belong in the domain layer.
- `@Entity()` declares `schema:` UNLESS it is a **per-tenant** table in a tenant-scoped service (`farm`, `sensor`, `hr`, `messaging`, `hydroponics`, `ai`, `alert`) — those OMIT `schema:` so search_path routes them into `tenant_<uuid>` at runtime. The split is **per-table, not per-service**: cross-tenant tables inside those services (outbox, audit ledgers, idempotency) KEEP `schema:`. The authoritative per-service cross-tenant set is `MODULE_SCHEMAS[].infrastructureTables` (`libs/backend-common/src/database/schema-manager.service.ts`). Enforced by `tests/invariants/entity-schema-declaration.spec.ts` (source, every PR) + `e2e/tests/integration/schema-invariants.spec.ts` (live DDL, `db-migration-check.yml`). Never add tables to `public`.
- NATS identity is cert CN only (ADR-015). No user/pass in the CONNECT frame.
- Batch operations: run all independent file reads/writes and bash commands in parallel within a single message.
- `git push` after every commit on the active branch. No force push.

> Some directories carry a nested `CLAUDE.md` with domain-specific rules, loaded on demand when you edit files there. It adds to — never overrides — these root rules.

---

## Behavioral Rules

- Do what has been asked; nothing more, nothing less.
- ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create docs (`*.md`) or READMEs unless explicitly requested.
- NEVER save working files, scratch notes, or tests to the repo root.
- ALWAYS read a file before editing it.
- NEVER commit secrets, credentials, or `.env` files (`.claude/settings.json` deny rule active).

## Commands

```bash
npm run infra:up                 # Postgres + Redis + NATS + MinIO + Mosquitto
npm run dev:backend              # Backend services (Nx run-many)
npm run dev:web                  # Shell + microfrontends
nx affected --target=build       # Affected build
nx affected --target=test        # Affected tests
nx affected --target=lint        # Lint
npm run type-check               # tsc --noEmit (platform-wide)
npm run codegen                  # GraphQL codegen (npm run format — Prettier write)
docker compose -f docker-compose.droplet.yml up -d   # Production droplet (also .dev.yml for pre-built)
```

## Architecture Map

Nx monorepo: NestJS microservices (`apps/`), React microfrontends (`web/`), platform libs (`platform/libs/`), shared libs (`libs/`), Rust edge gateway (`sens-api-gateway/`).

### Backend Services (`apps/`) — 17 services (15 runtime + `sensor-ingestion` Rust sidecar + `db-migrate` CLI)
| Service | Schema | Responsibility |
|---|---|---|
| `gateway-api` | — | API gateway, auth guard, rate limiting, CSP |
| `auth-service` | `auth` | JWT (RS256), RBAC, tenant provisioning, refresh rotation, MFA |
| `farm-service` | `farm` | Farm, pond, batch, feed, harvest, water quality (schema-per-tenant) |
| `sensor-service` | `sensor` | Sensor ingestion, calibration, aggregation, MQTT/LoRaWAN (schema-per-tenant) |
| `sensor-ingestion` | `sensor` | Rust sidecar: high-throughput sensor decode + NATS publish (ADR-025; `docs/plans/sensor-rust-migration/PLAN.md`) |
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
| `db-migrate` | — | Standalone migration-runner CLI (not a long-running service) |

### Platform & Shared Libs
- `platform/libs/`: `@platform/cqrs` (command/query bus), `@platform/event-bus` (NATS abstraction), `@platform/outbox`. Also `@platform/event-contracts` (BaseEvent + branded `EventId`, validators, upcasters), `@platform/testing`, `@platform/shared`, `@platform/storage`.
- `libs/backend-common` — dual-aliased `@aquaculture/backend-common` (primary) and `@platform/backend-common`. Bootstrap, guards, tenant context, RLS, health, audit, telemetry, Redis, NATS factory, signed HTTP client, schema-drift validator, migration-runner factory.

### Web (`web/`)
Module Federation via `@module-federation/vite`. `web/shell` is the host; `web/shared-ui` is the design system + federation shared-deps SSoT; `web/modules/*` are the 8 federated remotes (dashboard, farm-module, sensor-module, hr-module, admin-panel, tenant-admin, hydroponics-module, messaging-module); `web/apps/aquamobil` is a standalone offline-first Vite PWA (not a remote).

### Edge Gateway (`sens-api-gateway/`)
Rust sensor protocol gateway: Modbus-TCP, MQTT, I2C, Atlas EZO. Alarm engine, calibration, GPIO, backup, SCADA deploy orchestrator.

---

## Architectural Approach (Root-Cause Only — TIME IS NOT AN EXCUSE)

**ABSOLUTE RULE:** Every fix must be an ARCHITECTURAL solution. Patches, going around the problem, and ignoring it are FORBIDDEN. However long the architectural fix takes, it still gets done.

The test for every bug: *"If the upstream were correct, would this code need to exist?"* Interface/type mismatch → fix the interface or implementation. Missing field → add the `@Column` + DTO field. Cross-service inconsistency → fix the event contract AND both sides. NEVER hide a crash with defensive `?.`, escape to a JSON column to bypass the type system, or add a one-off compat shim/adapter.

**Architectural-solution hierarchy (pick the highest tier that applies):**
1. **Make it impossible** — the type system/compiler/runtime structurally prevents the wrong behaviour.
2. **Make it automatic** — the correct behaviour becomes the zero-effort default.
3. **Make it detectable** — the wrong behaviour is caught at build/test time.
4. **Document it** — last resort, only when 1–3 are genuinely impossible.

**Phrases BANNED as gating excuses:**

- "for now" / "interim solution" / "interim" / "temporary" / "pragmatic" / "simpler approach" / "middle ground" / "for momentum" / "just this commit" / "good enough" / "sufficient for now"
- "follow-up commit will handle it" (SAME PR or a tracked plan phase); "deferred" / "out of scope" — FORBIDDEN without an explicit owner + deadline + tracked finding ID

**If the architectural fix genuinely cannot land this session:** open a CRITICAL/HIGH tracked finding (owner + deadline + ID), state in the commit message exactly what was NOT done and WHY, and list the debt in the PR. Never ship a partial fix as if complete. The cost of a quick fix is paid forever; the right fix is paid once.

## Code Quality Standards

- `as any`, `as unknown as X`, `// @ts-ignore`, `// @ts-expect-error` are FORBIDDEN — fix the type or write a generic.
- `getRepository()` is FORBIDDEN → use `getScopedRepository()` (tenant isolation).
- Floating promises are FORBIDDEN → every async call is `await`ed.
- `console.*` is FORBIDDEN (ESLint `no-console: error`) → use NestJS `Logger`.
- Every public function needs an explicit return type.
- Event objects must conform exactly to `@platform/event-contracts` interfaces.

## Layer Rules

Each bounded context lives in `apps/{service}/src/{domain}/` with: `commands/`, `handlers/`, `query-handlers/`, `queries/`, `dto/`, `entities/`, `services/`, `controllers/`, `__tests__/`, `{domain}.module.ts`.

1. Controller → Service → Command/Query Bus → Handler → Repository. No layer skipping.
2. `@Entity()` schema discipline per the CRITICAL block above (ADR-011) — per-table, not per-service.
3. Never add new tables to `public`. Use the owning service's schema.
4. Use `createBaseEvent()`. Inline event construction is a compile-time error (branded `EventId`).
5. Events are flat objects. No nested `payload`/`metadata` wrappers (ADR-006).
6. Use `getScopedRepository()`; `getRepository()` bypasses tenant isolation.
7. Handler, entity, DTO, event for one domain live in the same domain directory.

## Schema Ownership (ADR-011) & Drift (ADR-012)

- Per-tenant vs cross-tenant placement: see the CRITICAL block. The cross-tenant table set per service is `MODULE_SCHEMAS[].infrastructureTables` (`schema-manager.service.ts`) — do not hardcode a copy. Platform-level services (`auth`, `billing`, `admin`, `notification`, `event_store`, `observability`, `config`, `gateway`) always declare `schema:` explicitly.
- Each service registers `SchemaDriftModule.forRoot({ serviceName: '<svc>' })`; the runtime validator fires at cold start. `e2e/tests/integration/schema-invariants.spec.ts` runs per PR in `db-migration-check.yml` — in its own `schema-invariants` job (a freshly migrated Postgres) and again inside `tenant-clone-parity` after the provisioning gate has left a real tenant, so B.5a asserts against one; it had appeared only in that workflow's `paths:` filters and never in a `run:` step, so it triggered the workflow without ever executing (FARM-MEDIUM-303). `tests/invariants/test-target-ci-reachability.spec.ts` now covers root-`package.json` `test:*` scripts as well as Nx targets, so a test entrypoint nothing invokes fails the build.
- The `shared` schema holds ONLY the canonical cross-service tables enforced by `SHARED_SCHEMA_TABLES` in `schema-invariants.spec.ts` (+ `tests/invariants/shared-schema-canonical.spec.ts`) — that spec is the SSoT for the list and count. Adding one requires an ADR + architectural-arbiter approval AND updating that SSoT (W5 `add-shared-table` gate, BLOCKER-15).

## Migration Runners (ADR-011, ADR-012)

- Each service owns `apps/<svc>/src/database/migrations/` + `data-source.ts` (TypeORM CLI entry) and registers `createMigrationRunnerService('<schema>')`. `TypeOrmModule`: `migrationsRun: false` (the runner owns execution).
- Production REQUIRES `DATABASE_MIGRATIONS_RUN=false`. Never hand-edit migration files — generate a new one. Blue-green safe: nullable column → backfill → NOT NULL.

## NATS Authentication (ADR-014 / ADR-015 — cert-is-identity SSoT)

- Identity comes ONLY from the mTLS client cert CN (`verify_and_map: true`). User/pass auth is FORBIDDEN — the server ignores CONNECT-frame user/pass.
- `infrastructure/nats/services.yaml` is the SSoT. Adding a service = edit it + mint a cert CN + run `scripts/nats/generate-nats-conf.py`, all in one commit. The `authorization.users[]` block in `infrastructure/docker/nats/nats.conf` is GENERATED between `# BEGIN/END GENERATED` sentinels; hand-editing fails the invariant.
- The client factory (`libs/backend-common/src/nats/nats-connection.factory.ts`) in `mtls-cert` mode writes no user/pass/token. CI invariant: `e2e/tests/integration/nats-invariants.spec.ts`. Operator how-to: `docs/runbooks/nats-service-addition.md`.

## Event Contract Rules

Event interfaces live in `libs/event-contracts/src/`. New event: add the interface (extends `BaseEvent`) to the relevant `*-events.ts`, export from `index.ts`, `eventType` in PascalCase (`BatchHarvested`), add a JSON Schema validator for trust-boundary crossings (`schemas/`), and an upcaster for breaking changes (`upcasters/`).

## Test Rules

- London School TDD: mock collaborators (`@platform/testing` factories). Test files: `{domain}/__tests__/*.spec.ts`.
- Integration: `apps/{svc}/src/__tests__/integration/` or `e2e/tests/integration/`; E2E: `e2e/tests/`, `tests/e2e/`. farm-service's integration lane (`test:integration` — the Testcontainers suites; the former schema-routing architecture spec was a weaker copy of `tests/invariants/entity-schema-declaration.spec.ts` and is gone) runs per PR via `ci-affected.yml`. A test target nothing invokes is not a gate: `tests/invariants/test-target-ci-reachability.spec.ts` enforces both directions (every `test*` target reachable from CI; every CI-driven target exists) — both failure modes are otherwise silently green. New feature → test first, then implement.

## Security

- `.env` files are never committed (deny rule in `.claude/settings.json`).
- Mask PII in logs (hash or `***`). The central `maskPii()` helper is auto-applied by `StructuredLoggerService`. Structured JSON logging only; string concatenation in log calls is banned.
- Input validation: `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.
- **Tenant-ID sourcing:** JWT claims are the trust anchor when an authenticated user is present (preferred by `TenantContextMiddleware` in `libs/backend-common`). The `x-tenant-id` header and request subdomain are accepted only on explicit pre-auth / cross-tenant admin / edge-ingestion paths (each callsite reviewed; fail-closed in prod). Gateway→subgraph HMAC binds tenantId into the signature (`libs/backend-common/src/utils/service-identity.util.ts`) so a compromised intermediary cannot swap tenants in flight.
- **Tenant row placement (D14):** the authoritative tenant record lives in `auth.tenants` (NOT `shared`) — `auth` is cross-tenant by design (login resolves a tenant first). The per-tenant subscription record lives in `billing.subscriptions` keyed by `tenantId` — billing is the SSoT for subscription state. The `shared` schema is reserved for the canonical cross-service tables only (see Schema Ownership); adding one requires an ADR + arbiter approval.

## Git & Deployment Rules

- Co-Authored-By lines are NEVER added to commit messages. This rule is the SSoT and overrides any harness/tooling default that would add one.
- Always `git push` after a commit (active branch). Force push (`--force`, `--force-with-lease`) is FORBIDDEN. `--no-verify`, `--no-gpg-sign`, and other hook-bypass flags are FORBIDDEN.

**Commit format:**
```
{type}({scope}): {subject}

{body explaining WHY — the diff shows WHAT}

Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{finding-id}
```
Type vocabulary: `fix`, `feat`, `refactor`, `security`, `test`, `chore`. A `BREAKING CHANGE:` footer is required for event-contract shape changes, column drops, and public API changes.

## Review Finding Traceability (MANDATORY)

Every fix commit must reference the finding it closes, else `docs/reviews/` becomes audit theater.
- Finding ID format: `{severity}-{sequential}` (e.g. `CRITICAL-001`). One `Closes:` line per finding. Missing `Closes:` on a fix = PROCESS MEDIUM; on a security CRITICAL = PROCESS HIGH.
- State machine (context-manager): `OPEN` → `IN-PROGRESS` → `RESOLVED` (merged commit carries `Closes:`) → `STALE` (30d) / `BLOCKED`.

## Agent system invocation

- Canonical dispatch: `Agent(subagent_type="<agent-name>")` in a Claude Code CLI session. Claude Code auto-discovers `.claude/agents/**/*.md`. Active lanes are Lane-A root code review (`orchestrator`), Lane-B product audit (`.claude/agents/product-audit/`, `product-audit-orchestrator`), Lane-C edge documentation (`.claude/agents/edge-docs/`, `edge-docs-orchestrator`), and ARIA (`.claude/agents/aria-*.md` plus ARIA maintenance prompts, invoked only by ARIA operator/kernel workflows). Retired prompt folders are deleted after useful guidance is migrated because stale rosters create duplicate ownership, wrong IDs, and invalid output paths. No background runner, no API-key dispatch, no external CLI binary.
- Lane-B meta-agents use a `product-audit-*` name prefix to stay globally unique (enforced by `tests/invariants/agent-name-uniqueness.spec.ts`).
- Knowledge SSoT: `.claude/knowledge/layer-{1,2,3}-*.md`. Agent files cite it via `@.claude/knowledge/...` lines — these are READER BOOKMARKS only in agent bodies (Claude Code expands `@` only inside CLAUDE.md). Agents `Read` each cited file at invocation.
- Shared review contract: `.claude/shared/{operating-modes,tier-claim-syntax,handoff-protocol,output-format}.md` + `orchestrator-{phases,routing-table}.md`. Full map: `.claude/README.md`.

## ADR References — canonical location `docs/adr/`

ADRs run 001–045, plus a few date-named files (`2026-04-30-*`). Filenames are authoritative and the directory has historical number collisions, so never assume a clean sequence. Key: schema ownership/drift (011, 012), NATS (014, 015), events flat (006), CQRS (007), guards (008), frontend data-fetch/styling (009, 010 — admin-panel-scoped), messaging isolation (013), Rust sidecar (025), ARIA (031, 033, 035, 036), SCADA multi-tenant runtime (045).

> **Known drift:** `docs/architecture/ADR-010-AI-REVIEW.md`, `ADR-010-AI-SELF-LEARNING.md`, `ADR-011-operations-hub-restructuring.md`, `ADR-012-messaging-service.md`, `ADR-013-nestjs-v11-upgrade.md` are misfiled — they use ADR numbering but live outside `docs/adr/` and collide with canonical IDs. Treat `docs/adr/` as authoritative; moving them is tracked work.

## Extended Documentation (plain paths — read with the Read tool as needed)

`docs/adr/` (ADRs), `docs/runbooks/` (operational runbooks: secret-rotation, nats-service-addition, schema-drift-response, …), `docs/security/` (policies, audits, hardening reports), `docs/api/` (API conventions), `docs/DEPLOY.md` (DigitalOcean deploy), `docs/architecture/` (diagrams + misfiled ADRs — see above), `docs/guides/` (SCADA, VFD).

## ARIA (continuous-mode meta-system)

ARIA is a repository-shaped intelligence experiment that runs between PR cycles, complementary to the PR-cycle review agents. Its design-of-record is on `main` (ADRs 031/033/035/036 in `docs/adr/`); the older `snowball` line is superseded. Boundaries, behavior, and contracts: `docs/aria/{SPEC,IDENTITY,CONTRACTS}.md`. Discoverable anchor: `.claude/knowledge/layer-1-aria.md`. Operator tool: `tools/aria-poc/poc.py` (`/aria-poc`). ARIA is a meta-layer that observes and records evidence — not one of the specialized review agents.

---

# Working Style

- Answer in the user's language. Lead with the result; keep it short and specific. No preamble, no restating the request, no self-congratulation.
- Report faithfully. If a step failed, was skipped, or is unverified, say so with the evidence. Never present a partial fix as complete.
- Verification is judgment, not ritual: check what is risky or irreversible, and prefer a tool that proves the answer over a claim that asserts it.
- **This file is Tier 4.** Before adding a rule here, try to make it a type, a lint rule, or an invariant test instead — Tier 4 is the last resort. Budget: 200 lines, enforced by `tests/invariants/claude-md-accuracy.spec.ts`. Every rule that a gate already enforces should shrink to a pointer at that gate.
