# SUPER_ADMIN Panel Audit — Remediation Architecture — 2026-09-05

- **Scope:** `web/modules/admin-panel` (50 pages), `apps/admin-api-service` (34 controllers, 603 routes), the `admin` schema, and the ingress / kernel / billing / auth seams they depend on.
- **Method:** 5 phases, 24 agent runs (Phase 0 inventory → 1a/1b/1c correctness → 2 security → 3 quality → 4 synthesis → 5a architectural-arbiter). Every CRITICAL claim was re-verified by grep against the repository before it was relayed. Read-only audit; no code changed in the audit itself.
- **Directive of record (owner, 2026-09-05):** no patches. Every remediation is a Tier-1/Tier-2 architectural fix that carries a Tier-3 CI gate and is tested unit + integration + contract + e2e + invariant. Findings are not fixed one button or one field at a time.
- **Registry:** the 26 umbrella findings below are appended to `docs/reviews/_registry/findings.jsonl` (cycle `2026-09-05-superadmin-audit`). Every remediation commit carries a `Closes:` trailer pointing at one of them.
- **Arbiter ADRs:** `docs/recommendations/architectural-arbiter/2026-09-05-adr-0006-…` through `-adr-0017-…`.

## 0. Türkçe Özet

50 sayfanın **hiçbiri** eksiksiz çalışmıyor: 15 DEGRADED, 16 BROKEN, 18 FAKE. Sayfaların bir katman altında 41 UI aksiyonu, 118 client fonksiyonu ve 168 backend route ölü. Kanonik bulgu sayısı 56 CRITICAL + 56 HIGH; bunlar 17 kök neden kümesine ve 12 hakem kararına indirgendi.

Ana bulgu: ADR-002 "tek internet girişi gateway-api" diyor; nginx `/api/` isteklerini doğrudan admin-api-service'e yönlendiriyor. Erişim logu, iç başlık temizleme, act-as, MFA step-up ve kara liste guard'ı admin yüzeyinin girişi olmayan serviste monte edilmiş. Impersonation, MFA, yetki modeli ve edge sertleştirme kararlarının dördü de bu tek çelişkiden türüyor.

Üretimde çalışan yedek yok. Her iki admin projesi CI'da hem lint hem test karantinasında; hiçbir gate PR'da çalışmıyor. Tenant oluşturma NATS ACL eksikliği yüzünden her seferinde 502 veriyor.

## 1. Headline

| dimension                   | result                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pages                       | 50 audited: WORKS **0**, DEGRADED 15, BROKEN 16, FAKE 18, unresolved 1                                                                  |
| Verdict                     | FIX 23, REBUILD 18, DELETE 8                                                                                                            |
| Dead surface one layer down | 41 UI actions, 118 client functions, 168 backend routes                                                                                 |
| Canonical findings          | 56 CRITICAL + 56 HIGH (SA-001…SA-115) + 118 MEDIUM/LOW in 14 classes                                                                    |
| Root-cause clusters         | 17 (C1–C17)                                                                                                                             |
| Arbiter rulings             | ARCH-CRITICAL-000 + R1–R12; factual conflicts C1–C7 resolved                                                                            |
| Tests actually run          | admin-api-service 920 pass / 39 skip; admin-panel 132 pass; coverage 31.66% statements; both projects quarantined from CI lint AND test |
| Production backups          | none functional                                                                                                                         |

## 2. Findings (registry IDs) → architectural fix → gate

Each finding is an umbrella for one systemic root cause. The fix is the Tier-1/2 mechanism; the gate is the Tier-3 CI assertion that makes regression fail a PR. Ruling numbers (Rn) refer to the arbiter ADRs; cluster numbers (Cn) to the Phase-4 synthesis.

## SEC-CRITICAL-056 — Two internet-reachable ingresses; kernel edge controls mounted on the wrong one (ARCH-CRITICAL-000, R11)

**State:** OPEN · **Wave:** W1 · **ADR:** 0006 (supersedes ADR-002 in part)

`infrastructure/nginx/droplet.conf:423-433` proxies `/api/` straight to admin-api-service. `tests/invariants/strip-internal-headers-mounted.spec.ts:75-79` excludes admin-api behind a `// Future:` comment; `access-log-middleware-mounted.spec.ts:20-21` calls gateway-api the single ingress. `TRUST_PROXY` defaults to `'false'` and admin-api never sets it, so every `byIp` rate-limit bucket is one global bucket.

**Fix (Tier-1 + Tier-2):** `bootstrapService` applies an edge-hardening bundle (StripInternalHeaders, AccessLog, RequestContext, required `TRUST_PROXY`) to every service declaring `serviceVisibility: 'public'`. The public set is derived from `droplet.conf` upstreams, never hand-listed. The two mount invariants are merged and their hand lists deleted. Dead CSRF middleware is deleted platform-wide.
**Gate:** `tests/invariants/public-service-edge-hardening.spec.ts` parses nginx and asserts each proxied upstream boots with the bundle and sets `TRUST_PROXY` in the droplet compose.
**Depends on:** DATA-CRITICAL-013 (retention) — mounting AccessLog on admin-api without a working `shared.access_logs` policy grows an unbounded table.

## SEC-CRITICAL-057 — Impersonation is decorative (R1)

**State:** OPEN · **Wave:** W2 · **ADR:** 0007

Zero occurrences of `impersonat*` in gateway-api. The minted token has no consumer. `admin.impersonation_sessions` carries a blanket `BEFORE UPDATE OR DELETE` refusal trigger (`1800000000000-Baseline.ts:266-277`) that six service paths violate. `EffectiveTenantMiddleware` already enforces the whole control set (UUID, tenant ACTIVE fail-closed, MFA step-up, HMAC-bound effective tenant).

**Fix (Tier-1):** delete the module (controller, service, entities, tables, page, client, CORS header, and the debug-tools sub-module under it). Promote `EffectiveTenantMiddleware` + `CaptureRequestedTenantMiddleware` into `libs/backend-common/src/middleware/`; mount on every public ingress. Reason and ticket move to `X-Act-As-Reason` / `X-Act-As-Ticket`, persisted in `shared.audit_logs` (`actorHomeTenantId`, `actedOnTenantId`, `mfaVerified`).
**Gate:** `tests/invariants/cross-tenant-authority-ssot.spec.ts` — exactly one act-as implementation repo-wide, mounted on every nginx-derived ingress, zero `impersonation_session` references outside migrations.

## SEC-CRITICAL-058 — No MFA model for platform admins (R5)

**State:** OPEN · **Wave:** W3 · **ADR:** 0011 (cutover clause `proposed` — human decision)

**Fix:** auth-service `TokenService` refuses to mint a `SUPER_ADMIN` access token for a user without `mfaEnabled` (Tier-1). Step-up for cross-tenant (existing, `effective-tenant.middleware.ts:186-192`) and for irreversible operations via `@Destructive({ requiresFreshMfa: true })` + `DestructiveActionGuard`. `security.mfa_enabled` config key and `impersonation_sessions.mfaCompleted` are deleted.
**Gate:** `tests/invariants/platform-admin-mfa-ssot.spec.ts` — mint refusal asserted as unit behaviour; every `@Destructive({irreversible})` route resolves through the guard; no `MFA_REQUIRED_FOR_CROSS_TENANT=false` in any committed env; zero readers of `mfa_enabled`.
**Human decision required:** enrolment cutover date (`SUPER_ADMIN_MFA_ENFORCED_AT`) and the locked-out-operator break-glass procedure.

## SEC-HIGH-059 — Single SUPER_ADMIN bit is the whole authorization model (R10, C6)

**State:** OPEN · **Wave:** W3 · **ADR:** 0016

**Fix:** `auth.platform_capability_grants` projected into a `platformCapabilities` JWT claim at mint (same path as `modules` / `resourcePermissions`; revocation rides the existing durable token invalidation). Closed enum `billing-ops | support-ops | security-ops | platform-read-only | break-glass` (≤ 4 h, fresh MFA). `@RequiresCapability` + `PlatformCapabilityGuard` as the third `APP_GUARD`, ANDed after an untouched `PlatformAdminGuard`, so a grant can never widen. `@Destructive({scope, dualControl, dryRunDefault, requiresTypedConfirmation})` + `destructive_runs` WORM ledger modelled on `cleanup_runs`.
**Gate:** `tests/invariants/platform-capability-coverage.spec.ts` — every mutating admin route carries a capability via reflected metadata; ratcheting allowlist `{route, owner, expiry, findingId}`.

## SEC-HIGH-060 — IP access rules enforced by nothing (R4)

**State:** OPEN · **Wave:** W3 · **ADR:** 0010

**Fix (Tier-1):** delete both stacks — gateway `IpWhitelistGuard` (unregistered, fail-open, IPv4-only, in-memory Map with no writer) and `admin.ip_access_rules` + controller + service + entity + page + client. IP restriction, if required, is an nginx `allow`/`deny` block.
**Gate:** `tests/invariants/no-dead-guards.spec.ts` — every `CanActivate` in `apps/**` and `libs/**` is an `APP_GUARD`, in a `@UseGuards()`, or allowlisted with `{owner, expiry, reason}`.

## SEC-HIGH-061 — Login rate-limit tier keyed to REST paths while login is a GraphQL mutation (SA-009)

**State:** OPEN · **Wave:** W0

`rate-limit.config.ts:66` binds the login tier to `/api/auth/login` and `/auth/login`. Authentication is a GraphQL operation, so the tier never engages.
**Fix:** the tier is bound to the GraphQL login operation name resolved from the parsed document, sharing one declaration with the auth-service resolver; `TRUST_PROXY` becomes required for public services (SEC-CRITICAL-056).
**Gate:** invariant that every rate-limit tier path or operation resolves to a registered route or GraphQL operation.

## DATA-CRITICAL-012 — PROTECTED_TABLES misclassification; phantom ADR-018 (R2, C7)

**State:** OPEN · **Wave:** W2 · **ADR:** 0008 (creates the missing `018-protected-tables-ssot` record)

**Principle (binding):** a table is listed iff it is write-once at row granularity AND physically carries `id` + `legalHold`. Column-scoped triggers are rejected; mutable aggregates are split into a lifecycle row plus append-only event rows (`cleanup_runs` / `cleanup_run_events` precedent).
**Fix:** remove `admin.impersonation_sessions` with its drop; add `admin.activity_logs` and `admin.tenant_activities` (legalHold, canonical two triggers, `performedBy NOT NULL` blue-green); add the 10 missing mandatory columns to `admin.audit_logs`.
**Gate:** `tests/invariants/audit-immutability-triggers.spec.ts` iterates `PROTECTED_TABLES` and asserts legalHold, both triggers, and that no repository `.save`/`.update` in the fleet targets a listed entity.

## DATA-CRITICAL-013 — Three retention engines; the compliance window has never executed (R6, C10)

**State:** OPEN · **Wave:** W1 · **ADR:** 0012 (promotes ADR-024 to Accepted)

`retention-bootstrap.module.ts:58,97` register `timestampColumn: 'created_at'`; the physical column is `"createdAt"`, so the 7-year and 90-day policies raise and are swallowed. `audit-trail.service.ts:807-866` is a second 03:00 engine with no legal hold and no `@Min`. Eight ad-hoc crons dispose outside any registry.
**Fix (Tier-1):** `RetentionEnforcementService` is the single owner. Delete runtime CRUD, `admin.retention_policies`, `RetentionPoliciesPage` and the eight crons. `registerRetentionPolicy<T>({ entity, timestampProperty: keyof T })` derives schema, table and column from `EntityMetadata`, so a wrong column name cannot compile. `legalHoldClause` is required whenever the entity carries `legalHold`.
**Gate:** `tests/invariants/retention-authority-ssot.spec.ts` — one retention cron in the fleet; every protected table with a policy has a legal-hold clause; every timestamped table in `MODULE_SCHEMAS` has a policy or an allowlisted `{owner, expiry, reason}` entry.

## INFRA-CRITICAL-140 — No functional production backup (R3, C12/C15)

**State:** OPEN · **Wave:** W1 · **ADR:** 0009

**Fix (Tier-1):** WAL-G + `tools/scripts/database/*` is the sole backup and restore authority. Delete the admin-api backup subsystem (service, controller, 3 entities, `admin.schema_backups`, `admin.schema_restores`, 3 crons, backup/restore/PITR UI); re-point `fk_cleanup_runs_backup` at the WAL-G epoch; strike `database-restore-drill.md:548`.
**Gate:** single-authority assertion in `tests/invariants/backup-restore-verification-contract.spec.ts` — nothing outside `tools/scripts/database/` and the two DR workflows may spawn `pg_dump`/`pg_restore` or declare a backup cron.
**Sequencing:** gates every destructive migration in this plan.

## INFRA-CRITICAL-143 — nginx and service route tables disagree on five production paths

**Evidence:** `infrastructure/nginx/droplet.conf` forwarded `/api/upload/*` verbatim to a gateway serving `/api/v1/upload/*`; `/api/csp-report` to a controller at `/api/v1/api/csp-report`; `/install/*` and `/api/devices/*` (installer script + Rust edge agent) to a sensor service serving them under `/api/v1`; `/api/v2/ai/*` to a proxy that never existed; and the SCADA websocket path `/scada-ws/` the client and sensor agreed on had no nginx location. Surfaced while closing the W0 open item on the upload path.

**Fix:** nginx rewrite for uploads; gateway prefix exclusion `api/csp-report`; sensor prefix exclusions `install/*`, `api/devices/*`; dead v2 proxy location, validator route, empty module and unregistered `api/v1/sensors` proxy deleted; `/scada-ws/` websocket location to sensor-service.

**Gate:** `tests/invariants/nginx-route-resolution.spec.ts` derives the nginx location table and every public service's served route table from source and asserts both directions; Docker-internal unprefixed routes are declared with a reason in `.claude/allowlists/internal-only-http-routes.yaml`.

## INFRA-HIGH-141 — CI quarantine policy is ungoverned prose (R12)

**State:** OPEN · **Wave:** W0 · **ADR:** 0017

**Fix (Tier-1 in the consumer):** every `knownUnstableProjects` value becomes `{ owner, expiry, findingId, reason }`; `write-affected-target-report.mjs` exits 1 on a malformed, expired, unknown-finding or RESOLVED-finding entry. The test quarantine of admin-api-service and admin-panel is lifted immediately on measured evidence. Per-spec quarantine only; lint ramp admin-panel first; coverage baselines untouched in the same PR.
**Gate:** the consumer itself, plus `tests/invariants/ci-quarantine-schema.spec.ts` so an expired entry fails a normal PR even when the affected set omits the project.

## INFRA-HIGH-142 — Production is fail-closed by accident (SA-068, C15)

**State:** OPEN · **Wave:** W0

`ENABLE_DEBUG_TOOLS`, `ENABLE_DB_EXPLORER_WRITES`, `ENABLE_RAW_SQL_EXPLORER`, `DATABASE_READONLY_USER`, `BACKUP_ENCRYPTION_KEY` and admin-api `TRUST_PROXY` are absent from `docker-compose.droplet.yml`; nothing pins their absence or presence.
**Fix:** a declared per-service environment manifest (required / forbidden / pinned-false), asserted at boot and diffed against the droplet compose by an invariant. A subsystem that cannot function without a variable refuses to start.

## BILLING-CRITICAL-002 — Two plan catalogues; money in jsonb (R7, C10)

**State:** OPEN · **Wave:** W4 · **ADR:** 0013 (extends ADR-037; reverses the `apps/billing-service/CLAUDE.md` ownership clause)

**Fix (Tier-1):** `billing.plans` is the sole catalogue of record for plan id, price, cycle and Stripe ids. Delete `admin.plan_definitions`, `module_pricing`, `custom_plans`, `discount_codes`; migrate their data into billing with `numeric(12,2)` + `CHECK`, ISO-4217 currency, `discountPercent BETWEEN 0 AND 100`. Admin keeps authoring and forwards commands.
**Gate:** `tests/invariants/plan-catalog-ssot.spec.ts` — no plan/price/discount entity outside billing; no money-typed field inside `jsonb`/`simple-json` fleet-wide; Stripe ids in exactly one entity.

## BILLING-CRITICAL-003 — Raw SQL against subscriptions; dead Stripe reconciliation; no idempotency (R8, C14)

**State:** OPEN · **Wave:** W4 · **ADR:** 0014 (depends on 0013)

**Fix (Tier-1):** provisioning via `CreateSubscriptionHandler` (FREE is the only non-Stripe tier). Delete the three raw-SQL blocks in favour of Cancel / Reactivate / ExtendTrial handlers. Fix the five webhook consumers to read `internalTenantId` through a shared constant (producer rename rejected — it would orphan every existing Stripe object) plus a real customer-lookup fallback. `BillingAdminCommandMeta` gains required `idempotencyKey` + `correlationId`, receipts on all eight commands. Seed `billing.plans` for every cycle.
**Gate:** `tests/invariants/billing-command-contract-ssot.spec.ts` — sender type, consumer pattern and NATS grant derived from one declaration; metadata-key symmetry; no raw write to `billing.subscriptions` outside a command handler.

## CONTRACT-CRITICAL-003 — No machine-readable FE↔BE contract; interface DTOs disarm validation (R9, C1, C2)

**State:** OPEN · **Wave:** W2 (class DTOs) / W3 (artifact) · **ADR:** 0015

**Fix (Tier-1):** all 29 interface-typed `@Body()` parameters become classes with class-validator decorators, with DB CHECK / length / `inet` constraints in the same migration set. OpenAPI is emitted from Nest DTOs via the existing `SwaggerModule.createDocument` into a committed `apps/admin-api-service/openapi.json`; `openapi-typescript` generates `src/services/generated/`; `services/types/*`, `contract-validation.spec.ts` and `KNOWN_EXCEPTIONS` are deleted. One `Paginated<T>` and the seven enums live in `libs/event-contracts`; `AuditLogInput.action` becomes `AuditAction`.
**Gates:** `tests/invariants/admin-openapi-artifact-parity.spec.ts` (byte-equality of artifact and generated client) and `admin-body-dto-is-class.spec.ts` (no `@Body()`/`@Query()` resolving to `Object`).

## ADMIN-CRITICAL-008 — Actor from client strings; 273 mutations unaudited; audit writer swallows (C8)

**State:** OPEN · **Wave:** W2

**Fix:** actor is never a DTO property (banned property names enforced structurally) and comes from `@CurrentUser` only; the awaited transaction-aware `AuditedOperationInterceptor` is adopted across admin-api; `audit.service.log` becomes `logOrThrow` by default; the audit-forgery endpoint is deleted.
**Gate:** `tests/invariants/admin-mutation-audit-coverage.spec.ts` (reflected metadata, ratcheting allowlist); admin-api added to `SERVICES_REQUIRED` in `audited-operation-module-wired.spec.ts`.

## ADMIN-CRITICAL-009 — tenantId is a transport value; erasure is structurally impossible (C9)

**State:** OPEN · **Wave:** W3

**Fix:** `@TenantParam()` resolves the id to a verified ACTIVE `auth.tenants` row before any handler runs. Erasure targets become an explicit per-table registry (`tenant-column | cascade-via | excluded-with-reason`).
**Gate:** every table in `MODULE_SCHEMAS[].tables` is classified in the erasure registry; e2e erases a tenant holding support threads, invoices and audit rows.

**Implementation note (landed 2026-09-05):** `@TenantParam(source, { key?, optional?, allow? })` (kernel `decorators/`) attaches `VerifiedTenantPipe` (kernel `tenant/`), which resolves the id through the `TENANT_ACTIVE_CHECK` port bound by admin-api's global `TenantLookupModule` (read-only `auth.tenants`, D14): missing → 400 unless optional, non-UUID → 400, unknown → 404, and a lifecycle check — a mutation admits ACTIVE only unless the route states `allow` (lifecycle, provisioning, billing and schema routes say `'any'`), a read admits every existing tenant. 115 `@Param('tenantId')` / `@Query('tenantId')` sites, the tenant controller's 15 `:id` routes and 23 body DTOs (`tenantId` removed from the class, taken by `@TenantParam('body')` on the handler) were converted; the ESLint rule `no-unverified-tenant-param` (admin scope, error) and `tests/invariants/admin-tenant-param-verified.spec.ts` keep the raw forms out. Erasure: `libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-table-policy.ts` — every source-schema target declares `tenant-column | cascade-via | excluded(reason)` for every registered table; the executor refuses to construct on an incomplete set, confirms every named column against `information_schema` before deleting, orders cascade children before parents without relying on a database FK, and derives nothing from column names; `tests/invariants/tenant-erasure-table-policy.spec.ts` checks completeness and that every named column is declared in source. Not done here: bulk `tenantIds[]` bodies (bulk suspend/activate, broadcast targets) still pass arrays the pipe does not resolve (owner okan, W3, this finding); the live e2e that erases a tenant holding support threads, invoices and audit rows needs the running platform and is not written in this session — the kernel cascade spec (`tenant-erasure-target-executor.cascade.spec.ts`) covers the same paths against a fake database.

## ADMIN-CRITICAL-015 — Email template preview iframe has no sandbox (SA-008)

**State:** OPEN · **Wave:** W0

`EmailTemplatesPage.tsx:317` renders operator-editable HTML via `srcDoc` with no `sandbox`, a same-origin path to the SUPER_ADMIN token.
**Fix:** one `SandboxedPreview` component in shared-ui that structurally sets the sandbox and is the only permitted way to render untrusted HTML; ESLint rule banning raw `srcDoc` / `dangerouslySetInnerHTML` under `web/**`.
**Gate:** the lint rule plus a component test asserting the sandbox attribute cannot be omitted.

## ADMIN-HIGH-010 — No shared admin-panel query/mutation primitive; page-local pagination and stats (C3, C17)

**State:** OPEN · **Wave:** W6

**Fix:** migrate every page onto the existing `useAdminQuery` / `useAdminMutation` / `adminQueryKeys`; delete `useAsyncData`. One `AdminTable` contract owns server-side pagination, sort, search and dataset-scoped aggregates; materialised tenant-resource rollups and the missing indexes back it.
**Gate:** ESLint bans `useState`+`useEffect` fetching and bare `apiFetch` under `pages/**`; AST rule bans aggregates computed from a fetched array; `no-console: error` re-enabled with a shrinking allowlist; bundlesize budget.

## ADMIN-HIGH-011 — Retired stores left as 410/409/501 stubs; route shadowing (C4, C5)

**State:** OPEN · **Wave:** W3

**Fix:** retirement deletes route and client in the same commit as the store; a route-registration linter orders static segments before parameterised ones.
**Gate:** no controller method body reduces to a thrown Gone / Conflict / NotImplemented; smoke gate that every FE-called route returns something other than 404/410/501 on a booted app.

## ADMIN-HIGH-012 — Permissive physical types in the admin schema (C11)

**State:** OPEN · **Wave:** W2

**Fix:** one forward migration per class (timestamptz, uuid tenantId, numeric money, real arrays, inet) landed together with `{ type: 'timestamptz' }` on every decorator; `SCHEMA_DRIFT_FATAL` in production.
**Gate:** no admin column is `timestamp without time zone`; decorator lint bans bare `@CreateDateColumn()` / `@UpdateDateColumn()`; CHECK presence invariant on money / enum / state columns.

## ADMIN-HIGH-013 — Crons without leader election, heartbeat or lease (C12)

**State:** OPEN · **Wave:** W3

**Fix:** `@LeaderOnly()` / `pg_try_advisory_lock` primitive in backend-common placed beside `CronHeartbeatService` so adopting one forces the other; job claiming via `FOR UPDATE SKIP LOCKED`; shared batched-delete helper.
**Gate:** every `@Cron` / `@Interval` in the fleet is leader-wrapped and heartbeated; `CronJobNeverRan` / `CronJobFailingEveryRun` rules are the runtime half.

## ADMIN-HIGH-014 — Detective stores with no producer (C16)

**State:** OPEN · **Wave:** W5

**Fix per store:** outbox-backed projection from auth-service login/session events, or delete the store with its detector and dashboard. No middle state.
**Gate:** every entity registered in `MODULE_SCHEMAS[].tables` has at least one write reference in its owning service.

## OBS-CRITICAL-003 — The admin observability path does not exist (C13)

**State:** OPEN · **Wave:** W5

**Fix (ordered):** mask the message path (OBS-CRITICAL-004) → ship logs → OTLP tracing → admin-api SLO rules on existing RED metrics → in-app health surfaces return `{status: 'ok' | 'unavailable'}` → delete fabricated dashboards only after Grafana replacements exist.
**Gate:** every scraped service scrapeable; every alert metric registered; every `runbook_url` resolves to `docs/runbooks/`.

## OBS-CRITICAL-004 — StructuredLoggerService emits the message argument unmasked (SA-054)

**State:** OPEN · **Wave:** W0

`structured-logger.service.ts:72-86` masks context values; `:133-146` passes the message through verbatim.
**Fix:** the message goes through the same `maskPii` boundary in `writeLog`; unit test proves a PII-bearing message is masked on every level. Must precede any log shipping.

## PLAT-CRITICAL-902 — BeginProvisioning is missing from the admin-api NATS publish grant (SA-032)

**State:** OPEN · **Wave:** W0

`services.yaml:317-327` lacks `request.auth.tenant.BeginProvisioning`; every tenant creation 502s after the 15 s request timeout.
**Fix:** add the grant and regenerate `nats.conf` in one commit; extend the provisioning SSoT invariant so every subject a service publishes (derived from the command contract) must appear in that service's publish ACL.

## CLAUDE-LOW-016 — CLAUDE.md "Migration Runners" matches no service (ARCH-LOW-012, C7)

**State:** OPEN · **Wave:** W7

**Fix:** shrink the Tier-4 text to a pointer at `libs/backend-common/src/database/typeorm-config.factory.ts` + `apps/db-migrate`; extend `claude-md-accuracy.spec.ts` to resolve `<svc>` against the real service list.

## 3. Execution order (dependency topology)

| wave                                      | content                                                                                                                                             | edge                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W0 — make measurement trustworthy**     | INFRA-HIGH-141 (lift stale test quarantine, governed policy); OBS-CRITICAL-004; INFRA-HIGH-142; ADMIN-CRITICAL-015; SEC-HIGH-061; PLAT-CRITICAL-902 | a gate on a quarantined project never runs; tenant creation must work before anything downstream is testable; two live pre-auth paths are independent of all other work |
| **W1 — recoverability + topology**        | INFRA-CRITICAL-140 (backups); DATA-CRITICAL-013 (retention); SEC-CRITICAL-056 (edge bundle)                                                         | nothing may drop a table while no restore path exists; AccessLog on admin-api needs working retention                                                                   |
| **W2 — write boundary + authority**       | class DTOs (CONTRACT-CRITICAL-003 precondition) + ADMIN-HIGH-012 migrations; SEC-CRITICAL-057; DATA-CRITICAL-012; ADMIN-CRITICAL-008                | class DTOs re-arm ValidationPipe fleet-wide in one change; audit must fail closed before the destructive ledger is a control                                            |
| **W3 — contract, authz, execution model** | CONTRACT-CRITICAL-003 artifact; SEC-CRITICAL-058; SEC-HIGH-059; SEC-HIGH-060; ADMIN-CRITICAL-009; ADMIN-HIGH-011; ADMIN-HIGH-013                    | generation precedes FE cleanup; MFA and capabilities mount on the single act-as authority                                                                               |
| **W4 — money**                            | BILLING-CRITICAL-002 then BILLING-CRITICAL-003                                                                                                      | `CreateSubscriptionHandler` resolves `billing.plans`; receipts before catalogue migration                                                                               |
| **W5 — detective stores + observability** | ADMIN-HIGH-014; OBS-CRITICAL-003                                                                                                                    | honest replacement before deleting the dishonest window                                                                                                                 |
| **W6 — FE architecture**                  | ADMIN-HIGH-010                                                                                                                                      | consumes the generated contract                                                                                                                                         |
| **W7 — kill list + docs**                 | §4; CLAUDE-LOW-016                                                                                                                                  | dead set is machine-derived after W3                                                                                                                                    |
| **W8 — read path**                        | materialised rollups, parallel capped health fan-out, indexes, per-request connection scope                                                         | index after the type conversions                                                                                                                                        |

Critical path: `INFRA-HIGH-141 → DATA-CRITICAL-013 → SEC-CRITICAL-056 → SEC-CRITICAL-057 → {SEC-CRITICAL-058, SEC-HIGH-059}` and `INFRA-HIGH-141 → CONTRACT-CRITICAL-003 → BILLING-CRITICAL-002 → BILLING-CRITICAL-003`, with INFRA-CRITICAL-140 gating the destructive half of every wave.

## 4. Kill list

**Delete by ruling:** impersonation module + 3 tables + page + debug-tools sub-module (0007); `ip_access_rules` + page + gateway `IpWhitelistGuard` (0010); admin backup subsystem + `schema_backups` / `schema_restores` (0009); `retention_policies` + runtime CRUD + page + 8 ad-hoc crons (0012); `admin.plan_definitions` / `module_pricing` / `custom_plans` / `discount_codes` migrated to billing (0013); dead CSRF middleware platform-wide (0006); `security.mfa_enabled` key + `mfaCompleted` (0011); `services/types/*` + `contract-validation.spec.ts` + `KNOWN_EXCEPTIONS` (0015).

**Delete outright (no consumer verified):** DebugToolsPage + `debugApi` + 5 debug tables (archive encrypted or discard — they hold raw tenant SQL, bodies and `Set-Cookie` headers); PerformanceDashboardPage + `performance_metrics` / `performance_snapshots` + snapshot cron; FeatureTogglesPage + `feature_toggles`; backup/restore/PITR UI + routes; migration run/rollback/batch panel; `QueryEditor.tsx` + explorer SQL executor + explorer row CRUD; `AdminLayout.tsx`, `admin-nav-items.tsx`, `TenantSelect` / `TenantMultiSelect` / `useTenants`, `useMessaging`, `useAnnouncements`, admin-panel `graphql/messaging-operations.ts`; 118 dead client functions; `settings.controller.ts` write half; schema create/suspend/activate routes (fold into the tenant saga); cache flush; versions deploy/rollback + `system_versions`; `GET /maintenance/check?isSuperAdmin=`; `logSlowQuery` / `recordRequestMetric` / `aggregateRequestMetrics`; `createOrUpdateBillingInfo` + `tenant_billing_info`; in-memory alert-rule CRUD; `loki-values.yaml`; login-success-ratio SLO rule; 15 `wiki.internal` runbook URLs; `impersonation_sessions.originalSessionToken`; shadow FK columns `custom_plans.base_plan_id` / `plan_module_assignments.plan_id`; `shared.user_permissions` resurrection in the Baseline.

**Delete with a coupled decision:** TenantConfigurationPage, ProvisioningSettingsPage, MessagingMonitoring / AiDashboard / AiPersonas pages (delete the route first); ErrorTrackingPage (delete unless a reporter is wired); `useAsyncData` (after W6); `login_attempts` / `user_sessions` / `api_usage_logs` + detectors (ADMIN-HIGH-014); `slow_query_logs` / `database_metrics` (with the `pg_stat_statements` decision); `maintenance_modes` (if maintenance moves to the gateway); `password-reset.controller.ts` (second un-rate-limited pre-auth ingress); `tenants.ts deactivate/archive` (adopt with `@Destructive` or delete both sides); 168 dead backend routes as a set after W3; K8s alert rule files (port useful rules to `droplet/rules` first); Grafana dashboards (rebuild).

**Keep behind break-glass:** explorer export (`explorer.controller.ts:543-647`) — needs a justification field, formula-prefix escaping and a default ORDER BY. `/database/schemas/sync` moves to a CLI runbook.

## 5. Page status matrix (summary)

| status         | pages                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DEGRADED (FIX) | TenantManagement, TenantDetail, Modules, AnalyticsDashboard, Tickets, Messaging inbox, BillingDashboard, Invoices, Payments, CustomPlanBuilder, ModulePricing, UsageDashboard, BillingReports, ActivityLog, SystemSettings                                                                                     |
| BROKEN         | CreateTenant (NATS ACL), UserManagement, Onboarding, DatabaseManagement, DatabaseExplorer, EmailTemplates, SubscriptionManagement, DiscountCode, CustomPlansList, MessagingAiPersonas, MessagingRetention, MessagingAudit, AuditLog, Maintenance, JobQueue, ErrorTracking                                      |
| FAKE           | AdminDashboard, TenantConfiguration, Impersonation, Reports, Announcements, IpAccessRules, ProvisioningSettings, PlanManagement, MessagingMonitoring, MessagingAiDashboard, MessagingCompliance, MessagingTenants, SecurityDashboard, AuditTrail, Compliance, FeatureToggles, PerformanceDashboard, DebugTools |

The full per-page evidence (finding IDs per page, verdicts, per-agent reports) lives in the session artefacts and is summarised by the umbrella findings above.

## 6. Corrections to earlier phases (verified)

- `adminRoutes.ts` is LIVE (imported by AdminDashboard and AnalyticsDashboardPage) — not deletable.
- Per-tenant migration run/rollback and the explorer raw query are UNREACHABLE (unconditional throw / `NODE_ENV`), which strengthens the deletion case.
- Explorer `ALLOWED_SCHEMAS` excludes `tenant_*`; the composite-PK defect is real within the four allowed schemas; `auth.users` and `auth.tenants` remain fully readable and exportable.
- Deactivating a user DOES revoke sessions on both admin paths; the defects are labelling and attribution.
- Retention exists for several tables Phase 1b listed as unbounded, but as ad-hoc crons outside the registry with no legal hold — a third engine, not compliance.
- `docs/adr/018-protected-tables-ssot.md` cited by `protected-tables.ts:64` does not exist.

## 7. Human decisions required

1. **SEC-CRITICAL-058 cutover:** enrolment date and break-glass procedure for a locked-out operator.
2. **Ownership reassignments** (prompt-writer task): data-expert ← retention lib; billing-expert ← catalogue tables (admin-expert secondary); platform-kernel-expert ← edge bundle; auth-security-expert ← promoted effective-tenant middleware.
3. **Quarantine owners and expiries:** every remaining `knownUnstableProjects` entry now names an owner and an expiry; the fleet-wide lint entries were assigned to the repository owner with a 2026-12-31 expiry and INFRA-HIGH-141 as their finding.

## 8. Not audited

notification-service, tenant-admin twin pages, shell `ROLE_HIERARCHY`, accessibility, i18n, load under traffic, the 32nd top-level page (unnamed in the corpus). The aquamobil copy of `messaging-operations.ts` is out of scope for this review.
