# contract-parity-enforcer — review — 2026-04-28-core-platform

## Scope

Core/cross-cutting (auth/tenant/billing) contract-parity audit across four axes:

1. OpenAPI ↔ NestJS Router metadata (auth-service, billing-service, admin-api-service, gateway-api).
2. GraphQL Federation subgraph SDL ↔ resolver coverage (gateway-api ApolloGateway composition over 11 subgraphs).
3. `sensorprotocols/*.md` ↔ Rust adapter parity (cross-cutting; flagged as core because it impacts contract-CI gating).
4. Event-contract producer ↔ consumer drift (every `createBaseEvent()` callsite and `@MessagePattern` consumer).

HEAD `a958dc66` clean. No code change in this cycle — CATCHER review only.

Files reviewed (representative): `apps/{auth,billing,admin-api}-service/src/main.ts`, `apps/gateway-api/src/app.module.ts`, all 67 `*.controller.ts`, all 86 `*.resolver.ts`, `libs/event-contracts/src/{billing,tenant,base}-events.ts`, `libs/event-contracts/src/upcasters/index.ts`, `apps/billing-service/src/billing/billing-scheduler.service.ts`, `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts`, `docs/api/openapi/*.yaml`, `sensorprotocols/*.md`, `sens-api-gateway/docs/protocols/*.md`, `infrastructure/nats/services.yaml`, `tests/invariants/*.spec.ts`.

## Executive summary

The contract-parity surface is essentially un-enforced at the cross-cutting layer:

1. All five OpenAPI spec files in `docs/api/openapi/` are 0-byte placeholders — there is no HTTP API contract source-of-truth at all. Only 1 of 16 services (admin-api-service) registers SwaggerModule at runtime, and that service declares 0 `@ApiResponse` decorators across 36 `@ApiOperation`s — response schemas don't exist.
2. `SubscriptionPastDue` and `SubscriptionExpired` events are emitted by `billing-service` (`billing-scheduler.service.ts:79,152`) with no interface definition in `libs/event-contracts/src/billing-events.ts`, no JSON Schema, no upcaster, no entry in the `BillingEvent` union — fully untyped wire contract (DATA-HIGH-004 sibling). Closes via `@platform/event-contracts` shape definition + `BillingEvent` union extension.
3. Two divergent `sensorprotocols`-style doc trees exist (`/sensorprotocols/` 2 files Turkish UI-config; `/sens-api-gateway/docs/protocols/` 15 files wire-contract reference) — the agent spec literal-pathed `sensorprotocols/*.md` matches the 2-file root, but the load-bearing wire contracts live in the 15-file `sens-api-gateway/docs/protocols/` tree. SSoT is split with no invariant binding either to the Rust adapter constants. The promised `tests/invariants/contract-parity.spec.ts` invariant has not been authored.

Verdict: BLOCK — three CRITICAL findings span all three primary contract surfaces.

## Findings (by severity)

### CRITICAL

### CONTRACT-CRITICAL-001 — OpenAPI spec files are 0-byte placeholders; SwaggerModule registered in 1/16 services

**Severity:** CRITICAL
**Layer:** 3 (ADR / contract-parity invariant)
**State:** OPEN
**Sub-kind:** `OPENAPI_ROUTE_DRIFT`

**Evidence**
- `docs/api/openapi/auth-service.yaml` — 0 bytes (verified via `wc -l` and `ls -la`).
- `docs/api/openapi/farm-service.yaml` — 0 bytes.
- `docs/api/openapi/sensor-service.yaml` — 0 bytes.
- `docs/api/openapi/alert-engine.yaml` — 0 bytes.
- `docs/api/openapi/gateway-api.yaml` — 0 bytes.
- `apps/admin-api-service/src/main.ts:22-27` — only service passing `swagger:` config.
- `apps/auth-service/src/main.ts`, `apps/billing-service/src/main.ts`, `apps/gateway-api/src/main.ts`, plus 12 other service `main.ts` files — no `swagger:` block; `bootstrapService` skips `SwaggerModule.setup()` (`libs/backend-common/src/bootstrap/create-service-app.ts:778`).
- `infra/openapi/` (path cited in agent spec as primary ownership) does not exist; the actual location is `docs/api/openapi/`.
- `apps/admin-api-service/src/__tests__/api/swagger.spec.ts` — only Swagger validation in the repo; tests a self-built `SwaggerTestController`, not actual production controllers.

**Rule violated**
Layer-3 contract-parity invariant: "OpenAPI declares route, code missing = CRITICAL (404 in production for documented endpoint). Route exists in code, missing from OpenAPI = HIGH (API client generators broken)." Empty YAML inverts the test — every route is missing from OpenAPI. The 67 NestJS controller files plus billing/admin tenant routes (24 routes in `tenant.controller.ts` alone, 30+ in `billing.controller.ts`) have zero contract coverage.

Also breaks the agent-file declared deliverable that "`infra/openapi/<service>.yaml` MUST be source-of-truth for HTTP contract."

**Proposed fix direction**
- Tier 2 (automatic): regenerate `docs/api/openapi/<service>.yaml` from NestJS Router metadata at build-time via `nx run <service>:openapi-extract` — emit YAML from `SwaggerModule.createDocument(app)` ran headless. Land for all 16 services in one commit.
- Tier 3 (detectable): land `tests/invariants/contract-parity.spec.ts` asserting (a) every `<service>.yaml` non-empty; (b) every controller method has a matching operationId; (c) `bootstrapService()` callsites in services with `*.controller.ts` files MUST pass `swagger:`. Block PR merge on drift.
- Reconcile path: agent file says `infra/openapi/**`; actual is `docs/api/openapi/`. Pick one and fix the agent spec or move the directory.

**Affected surface (ripple set)**
- `docs/api/openapi/{auth,farm,sensor,alert-engine,gateway-api,billing,admin-api,messaging,hr,hydroponics,config,notification,event-store,observability,ai}-service.yaml` (15 files; 5 currently 0-byte, 10 missing entirely).
- `apps/{auth,billing,gateway-api,farm,sensor,hr,hydroponics,messaging,alert-engine,notification,ai,config,event-store,observability}-service/src/main.ts` (14 main.ts files needing `swagger:` config).
- `tests/invariants/contract-parity.spec.ts` (new).
- `.claude/agents/contract-parity-enforcer.md` — fix the `infra/openapi/**` → `docs/api/openapi/**` path drift.

**Expected closer**
contract-parity-enforcer WRITER mode is NOT supported per agent spec. Route to `implementation-planner` for OpenAPI extract skill + invariant, with `auth-security-expert` reviewing auth-service emitted spec (deprecated PII fields) and `billing-expert` reviewing billing-service emitted spec.

---

### CONTRACT-CRITICAL-002 — `SubscriptionPastDue` + `SubscriptionExpired` events emitted with NO interface, NO union member, NO upcaster

**Severity:** CRITICAL
**Layer:** 1 (TS — branded EventId factory subverted) + 3 (ADR-006 event-contracts SSoT)
**State:** OPEN (sibling to DATA-HIGH-004 — escalated to CRITICAL on contract-parity axis because consumer-side replay is fully unsafe)
**Sub-kind:** `EVENT_CONSUMER_DRIFT`

**Evidence**
- `apps/billing-service/src/billing/billing-scheduler.service.ts:79` — `eventBus.publish({ ...createBaseEvent('SubscriptionPastDue', sub.tenantId), subscriptionId, previousStatus, newStatus })`.
- `apps/billing-service/src/billing/billing-scheduler.service.ts:152` — `eventBus.publish({ ...createBaseEvent('SubscriptionExpired', sub.tenantId), subscriptionId, previousStatus, newStatus })`.
- `libs/event-contracts/src/billing-events.ts:1-198` — defines 10 billing event interfaces; `SubscriptionPastDueEvent` and `SubscriptionExpiredEvent` are NOT among them.
- `libs/event-contracts/src/billing-events.ts:187-197` — `BillingEvent` union excludes both new event types.
- `libs/event-contracts/src/schemas/` — no JSON Schema for these events.
- `libs/event-contracts/src/upcasters/index.ts` — `TIMESTAMP_BUMP_EVENTS` excludes both; no version field discipline applied.
- `infrastructure/nats/services.yaml:170-173` — billing publishes `AQUACULTURE_EVENTS.Subscription*.>` so the wildcard accepts the events on the subject side; the schema/contract gap is the violation, not subject ACL.

**Rule violated**
ADR-006 (event flat pattern + branded `EventId` factory) — the factory permits `eventType: T['eventType']` for any `eventType` present in a `BaseEvent` extension; an inline literal like `'SubscriptionPastDue'` short-circuits the type check because the inline expansion fields (`subscriptionId, previousStatus, newStatus`) carry no compile-time pinning. Layer-2 contract-parity invariant: "When `libs/event-contracts/src/*-events.ts` shape changes, consumer services MUST have (a) upcaster, OR (b) feature flag + dual-emit period, OR (c) explicit OPT-IN documented. Producer-only bump = CRITICAL." Both events are producer-only, no contract.

**Proposed fix direction**
- Tier 1 (impossible): tighten `createBaseEvent<T>()` so `T['eventType']` MUST be one of the union of all `BillingEvent | TenantEvent | …` event types (re-derived from `index.ts` exports). An unrecognised eventType then fails at compile time — `'SubscriptionPastDue'` would not type-check.
- Add `SubscriptionPastDueEvent` and `SubscriptionExpiredEvent` interfaces in `libs/event-contracts/src/billing-events.ts`; extend `BillingEvent` union; add JSON Schema in `libs/event-contracts/src/schemas/`; register a `version: 1` upcaster placeholder.
- Audit `services.yaml` consumers of `Subscription*.>` (notification-service, admin-api-service, others) — confirm none crash on the unknown payload shape. Document explicit `subscribe` pattern (CONSUMER_BREAK if fields rename later).

**Affected surface (ripple set)**
- `libs/event-contracts/src/billing-events.ts` (add 2 interfaces, extend union).
- `libs/event-contracts/src/schemas/billing-events.schema.ts` (new — currently absent; only farm + sensor + ingest schemas exist).
- `libs/event-contracts/src/index.ts` (re-export new types).
- `libs/event-contracts/src/upcasters/index.ts` (register pre-emptive v1 upcaster slots).
- `apps/billing-service/src/billing/billing-scheduler.service.ts` (use typed events).
- Every consumer of `AQUACULTURE_EVENTS.Subscription*.>` — ripple-tracer enumerates from `services.yaml`.

**Expected closer**
data-expert WRITER mode (primary on `libs/event-contracts/**`); contract-parity-enforcer secondary CATCHER reviews consumer-drift impact.

---

### CONTRACT-CRITICAL-003 — Two divergent `sensorprotocols/`-style doc trees with NO invariant binding to Rust adapter

**Severity:** CRITICAL
**Layer:** 3 (ADR — contract-parity invariant + ADR-003 sensor-service separation)
**State:** OPEN
**Sub-kind:** `PROTOCOL_DOC_DRIFT`

**Evidence**
- `/var/aqua-saas/sensorprotocols/` — 2 files: `Modbus-TCP.md` (1667 lines, Turkish-language UI configuration spec), `mqtt-protocol.md` (581 lines).
- `/var/aqua-saas/sens-api-gateway/docs/protocols/` — 15 files: `modbus-tcp.md` (220 lines, English wire-contract reference with `src/modbus.rs:NN` line cites), `mqtt.md` (175 lines), plus 12 other protocols (ads, atlas-ezo, codesys, ethernet-ip, gpio, i2c, lorawan, modbus-rtu, opc-ua, pwm, s7comm, spi).
- `diff -q sens-api-gateway/docs/protocols/modbus-tcp.md sensorprotocols/Modbus-TCP.md` — files differ; one is a UI configuration spec, the other a wire-contract reference. Neither cross-references the other; neither has an invariant test binding it to the Rust adapter constants.
- Rust adapter file structure (`sens-api-gateway/src/`):
  - `modbus.rs`, `mqtt.rs`, `i2c.rs`, `spi.rs`, `gpio.rs`, `pwm.rs`, `atlas_ezo.rs` — top level.
  - `lora/{codec,crypto,mac,session,sx1302,types}.rs` — LoRaWAN subdir.
  - `plc_programming/{ads,codesys,ethernet_ip,opcua,s7comm}.rs` — PLC subdir.
  - **No standalone `modbus_rtu.rs` adapter** — but `sens-api-gateway/docs/protocols/modbus-rtu.md` (162 lines) declares contract; modbus-rtu support is presumably folded into `modbus.rs` as a feature variant. UNDOCUMENTED PARITY.
- Agent spec `contract-parity-enforcer.md:32-37,62-65` literally cites `sensorprotocols/*.md ↔ sens-api-gateway/src/protocols/**` — and `sens-api-gateway/src/protocols/` does NOT exist (the protocols are flat under `src/` and `src/{lora,plc_programming}/`). Agent spec drift adds to the parity gap.

**Rule violated**
Layer-3 protocol-doc parity invariant from agent spec: "`sensorprotocols/Modbus-TCP.md` documents register map + frame structure → MUST match `sens-api-gateway/src/protocols/modbus_tcp.rs` adapter constants. Drift = CRITICAL (adapter reads wrong register → wrong sensor value → potential life-safety alert miss)." Two divergent SSoTs is by definition no SSoT; the alarm-engine + calibration consequences land in ALERT and EDGE expert scope.

**Proposed fix direction**
- Tier 1 (impossible): collapse to ONE doc tree. Recommendation: keep `sens-api-gateway/docs/protocols/` (15 files, English, line-citing the Rust source) as canonical; demote `sensorprotocols/` to UI-only configuration spec OR migrate its Modbus-TCP/MQTT UI fields into the canonical doc as a "configuration UI surface" appendix. Either (a) move + redirect or (b) delete with ADR record.
- Tier 3 (detectable): author `tests/invariants/contract-parity.spec.ts` with a `sensorProtocolsDocAdapterParity` test that asserts each `<protocol>.md` in the canonical tree has a corresponding `<protocol>.rs` (or doc-cited adapter file) AND that documented register-map / topic-pattern constants match adapter constants extracted via Rust AST or regex from `src/{,plc_programming/,lora/}*.rs`.
- Fix agent spec primary-ownership path: `sensorprotocols/*.md ↔ sens-api-gateway/src/protocols/**` is wrong on both sides; the actual doc tree is at `sens-api-gateway/docs/protocols/` and the actual adapter tree is flat across `sens-api-gateway/src/{,plc_programming/,lora/}`.

**Affected surface (ripple set)**
- `sensorprotocols/` directory (collapse decision).
- `sens-api-gateway/docs/protocols/README.md` (extend with parity statement).
- `tests/invariants/contract-parity.spec.ts` (new).
- `.claude/agents/contract-parity-enforcer.md:32-37,62-65` (path correction).
- `docs/adr/` (decide canonical doc location ADR or supersede ADR-003).

**Expected closer**
edge-expert WRITER mode (primary on `sens-api-gateway/**`); contract-parity-enforcer secondary CATCHER reviews invariant test.

---

### HIGH

### CONTRACT-HIGH-001 — 74 `Date`-typed fields across 30+ event interfaces vs `BaseEvent.timestamp: string` JSONB wire contract

**Severity:** HIGH (sibling DATA-CRITICAL-003 from data-expert; cross-listed here as contract-parity since it's a producer↔consumer wire-format mismatch)
**Layer:** 1 (TS) + 3 (ADR-006)
**State:** OPEN
**Sub-kind:** `EVENT_CONSUMER_DRIFT`

**Evidence**
- `libs/event-contracts/src/base-event.ts:43-46` — `timestamp: string` with explicit comment "WHY string not Date: JSONB serialization converts Date to ISO 8601 string on the wire."
- `grep -E '^\s*\w+\??:\s*Date\s*;?\s*' libs/event-contracts/src/*-events.ts | wc -l` → **74 fields**.
- Examples in `libs/event-contracts/src/billing-events.ts`: `startDate: Date` (line 43), `cancellationDate: Date` (72), `dueDate: Date` (119), `paidAt: Date` (135), `effectiveEndDate: Date` (73), `effectiveDate: Date` (104), `refundedAt: Date` (166).
- `libs/event-contracts/src/upcasters/index.ts:30-35` — `TIMESTAMP_BUMP_EVENTS` covers only 4 event types (`BatchStatusChanged`, `SensorCalibrated`, `AlertEscalated`, `ModuleRemovedFromTenant`). The remaining 70 Date-typed fields have no upcaster pipeline.

**Rule violated**
ADR-006 + layer-1 TS discipline: TypeScript interface MUST match runtime serialization. NATS payload after JSON.stringify converts Date → ISO 8601 string but the type says `Date`. Consumers calling `.getTime()` or `instanceof Date` on a `paidAt` field receive `string`, hit a runtime TypeError or NaN — at-least-once delivery makes the failure tenant-wide and recurring.

**Proposed fix direction**
- Tier 1 (impossible): replace every per-event `Date` field with `string` (ISO 8601). Provide a typed branded `IsoDateTime = string & { __brand }` so consumers cannot accidentally treat as Date.
- Tier 3 (detectable): land an invariant `tests/invariants/event-date-fields.spec.ts` that fails the build if any `*-events.ts` interface has a non-`timestamp` `Date`-typed field.
- Tier 4 (workaround): expand `TIMESTAMP_BUMP_EVENTS` to all 30+ event types — but this just normalizes Date→string at the upcaster boundary; consumers still see drift between TypeScript types and runtime values.

**Affected surface (ripple set)**
- `libs/event-contracts/src/{billing,farm,sensor,alert,hr,messaging,notification,tenant,task,storage,water-quality,edge-device,ai,schema-migration}-events.ts` — every file with Date fields.
- `libs/event-contracts/src/upcasters/index.ts` — extend `TIMESTAMP_BUMP_EVENTS` OR delete + replace with type-level normalization.
- All event consumers — ripple via `services.yaml` subscribe lists.

**Expected closer**
data-expert WRITER mode (primary on `libs/event-contracts/**`); cross-handoff to every domain expert whose service publishes the affected events.

---

### CONTRACT-HIGH-002 — Admin-api `@ApiOperation` (36) without `@ApiResponse` (0) — response schema undeclared on every documented endpoint

**Severity:** HIGH
**Layer:** 3 (contract-parity invariant)
**State:** OPEN
**Sub-kind:** `OPENAPI_ROUTE_DRIFT`

**Evidence**
- `apps/admin-api-service/src/**/*.controller.ts` — 36 `@ApiOperation(` callsites, **0** `@ApiResponse(` callsites (verified via `grep -rE` count).
- 30+ controller files use `@nestjs/swagger` decorators (verified earlier in this review).
- Result: even where SwaggerModule renders a doc page (admin-api at `/docs`), each operation's response section says `default: ""` — clients must reverse-engineer the response shape from controller TypeScript.

**Rule violated**
Layer-3 invariant from agent spec: "`@nestjs/swagger` decorators (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiQuery`) on every controller method. Missing = HIGH (inferred OpenAPI is incomplete)." Inference falls back to `void` — clients code-generated against this spec see `Promise<void>` everywhere.

**Proposed fix direction**
- Tier 3 (detectable): ESLint rule `no-apioperation-without-apiresponse` — requires `@ApiResponse({ status: 2xx, type: <DTO> })` on every method that has `@ApiOperation`.
- Tier 2 (automatic): NestJS plugin `@nestjs/swagger/plugin` (CLI plugin) infers response types from method signatures — enable in admin-api `tsconfig.json` "plugins" + `nest-cli.json` "compilerOptions.plugins". Currently absent.

**Affected surface (ripple set)**
- `apps/admin-api-service/nest-cli.json` (add Swagger plugin).
- `apps/admin-api-service/tsconfig.json` (plugin settings).
- `apps/admin-api-service/src/**/*.controller.ts` (annotate response DTOs).

**Expected closer**
admin-expert WRITER mode (primary on `apps/admin-api-service/**`).

---

### CONTRACT-HIGH-003 — GraphQL codegen output `web/shared-ui/src/generated/graphql-types.ts` does not exist; `codegen.ts` references 8 nonexistent `apps/<svc>/schema.graphql` files

**Severity:** HIGH (cross-cuts FE-CRITICAL-001)
**Layer:** 3 (ADR-009 codegen invariant) + 2 (Federation subgraph SDL parity)
**State:** OPEN
**Sub-kind:** `CODEGEN_ORPHAN`, `GQL_SCHEMA_DRIFT`

**Evidence**
- `codegen.ts:1-20` — references `apps/{farm,sensor,hr,auth,billing,config,hydroponics,alert-engine}/schema.graphql`; **none of these files exist** (`find /var/aqua-saas/apps -name 'schema.graphql' -not -path .worktrees` returns empty).
- `web/shared-ui/src/generated/` — directory does not exist (`ls` errors).
- `apps/gateway-api/src/app.module.ts:298-348` — `RetryableIntrospectAndCompose` lists 11 federation subgraphs (auth, farm, sensor, alert, hr, billing, hydroponics, config, notification, messaging) but **codegen.ts only lists 8**. Drift between gateway compose list and codegen schema list is HIGH on its own (`messaging`, `notification`, `ai` not codegened; `ai-service` resolver exists at `apps/ai-service/src/health/health.resolver.ts`).
- Subgraph SDL doesn't materialize as a file at all — every schema is built at runtime via `@nestjs/graphql` `autoSchemaFile` mode. Codegen has no static input to read from.

**Rule violated**
Agent spec: "Codegen output (`web/shared-ui/src/generated/graphql-types.ts`) regenerated on every schema change; CI gate validates output exists + no drift." Both prerequisites are false: the schema files don't exist AND the output doesn't exist. Layer-2 federation invariant: every gateway-listed subgraph MUST appear in the codegen schema list — currently 3 are missing.

**Proposed fix direction**
- Tier 2 (automatic): switch each service's `GraphQLModule.forRoot` config to write `autoSchemaFile: 'apps/<svc>/schema.graphql'` (it currently writes ONLY in-memory). With the file present, codegen runs.
- Tier 3 (detectable): land a CI step `nx run shared-ui:codegen --check` that fails the build if `graphql-types.ts` is stale OR missing.
- Reconcile codegen.ts schema list with gateway-api subgraph list — extend with messaging, notification, ai (3 missing). Add invariant test asserting equality between the two lists.

**Affected surface (ripple set)**
- `apps/{farm,sensor,hr,auth,billing,config,hydroponics,alert-engine,messaging,notification,ai}-service/src/app.module.ts` — `autoSchemaFile` path.
- `codegen.ts` — extend schema list.
- `web/shared-ui/src/generated/graphql-types.ts` — generated artifact.
- `tests/invariants/contract-parity.spec.ts` (new) — codegen-list ↔ gateway-list parity test.

**Expected closer**
frontend-expert WRITER mode (primary on `web/shared-ui/**`); contract-parity-enforcer secondary CATCHER on the gateway↔codegen list parity invariant.

---

### CONTRACT-HIGH-004 — `tests/invariants/contract-parity.spec.ts` — agent-spec promised Phase-4 deliverable; absent

**Severity:** HIGH
**Layer:** 3 (CI invariant gate)
**State:** OPEN
**Sub-kind:** `CODEGEN_ORPHAN`

**Evidence**
- `.claude/agents/contract-parity-enforcer.md:79-84` — agent spec: "`tests/invariants/contract-parity.spec.ts` (new Phase 4 deliverable)" listing 4 specific assertions (controller↔OpenAPI, resolver↔SDL, sensorprotocols↔adapter, event↔upcaster).
- `find /var/aqua-saas/tests -name 'contract-parity*'` → empty.
- `ls /var/aqua-saas/tests/invariants/` — 32 invariant tests; no contract-parity test among them.
- `.claude/agents/contract-parity-enforcer.md:34` — primary ownership for this file. Promotion from product-audit/contract-parity-auditor frozen reference is incomplete.

**Rule violated**
Layer-2 CI invariant discipline: "Failure of this invariant = HIGH; CI gate blocks PR merge." Without the invariant file, the four CRITICAL/HIGH findings above can re-regress silently as new code lands.

**Proposed fix direction**
- Tier 3 (detectable): author the file with the four assertions per agent spec. The first two (controller↔OpenAPI, resolver↔SDL) DEPEND on CONTRACT-CRITICAL-001 (OpenAPI generation) and CONTRACT-HIGH-003 (codegen) landing first — sequence as a 3-commit chain in implementation-planner package.

**Affected surface (ripple set)**
- `tests/invariants/contract-parity.spec.ts` (new).
- `tests/invariants/jest.config.ts` (add the new spec to project glob).

**Expected closer**
contract-parity-enforcer WRITER mode is NOT supported per agent spec. Route to `implementation-planner` for the 3-commit chain.

---

### MEDIUM

### CONTRACT-MEDIUM-001 — Auth-service deprecated `refreshToken` field in `AuthPayload` GraphQL DTO with no consumer-side deprecation directive

**Severity:** MEDIUM
**Layer:** 2 (GraphQL Federation deprecation discipline)
**State:** OPEN
**Sub-kind:** `GQL_SCHEMA_DRIFT`

**Evidence**
- `apps/auth-service/src/modules/authentication/dto/auth-response.dto.ts:11-12` — `@Field({ description: 'Deprecated: refresh token is now stored in httpOnly cookie. This field returns empty string.' })` — described as deprecated in the description string but **no `@Field({ deprecationReason: ... })`** is set.
- Cross-handoff with auth-security-expert finding "deprecated JWT PII fields removal — login response shape change" — same surface; the signal here is contract-parity: clients using GraphQL introspection see `refreshToken: String!` as a normal field, not deprecated. Apollo Federation propagates deprecation only via `@deprecated`.

**Rule violated**
Layer-2 GraphQL Federation v2 contract: deprecation MUST use the `deprecationReason` SDL annotation. Description-only "Deprecated:" prefix is not machine-readable.

**Proposed fix direction**
- Tier 2 (automatic): change `@Field({ description })` to `@Field({ description, deprecationReason: 'Use httpOnly cookie; field will be removed in vN+1.' })`.
- Tier 3 (detectable): ESLint rule on auth-service DTOs forbidding the literal "Deprecated:" prefix in `@Field()` description without a paired `deprecationReason`.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/dto/auth-response.dto.ts` (one field).
- `web/` consumers of `AuthPayload.refreshToken` — likely already drop-cleaned given the empty string return.

**Expected closer**
auth-security-expert WRITER mode (primary on auth DTO); contract-parity-enforcer secondary CATCHER reviews subgraph SDL for the deprecation directive after compose.

---

### CONTRACT-MEDIUM-002 — Stripe webhook controller has 5 hardcoded event types in adapter without contract record

**Severity:** MEDIUM
**Layer:** 4 (doc only — no contract surface)
**State:** OPEN
**Sub-kind:** `OPENAPI_ROUTE_DRIFT`

**Evidence**
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:29-38` — `SUPPORTED_EVENTS = ['payment_intent.succeeded', 'payment_intent.payment_failed', 'invoice.payment_failed', 'customer.subscription.deleted', 'charge.refunded']`.
- No companion record in `docs/api/openapi/billing-service.yaml` (file is 0 bytes per CONTRACT-CRITICAL-001).
- BILLING-CRITICAL-001 (sibling): "Stripe SDK absence means OpenAPI for billing endpoints can't match implementation." This finding is the parity-axis manifestation: even the supported-events list is not contract-tracked.

**Rule violated**
Layer-3 boundary discipline: external trust-boundary surfaces (Stripe webhook payload) belong on the boundary allowlist (`.claude/allowlists/boundary-files.yaml`) AND have a written contract. Currently neither.

**Proposed fix direction**
- Tier 4 (doc): add `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` to boundary allowlist with `expires` per Stripe API stability schedule.
- Tier 3 (detectable): JSON Schema for each of the 5 supported events lives in `libs/event-contracts/src/schemas/stripe-events.schema.ts` (new); webhook controller validates payload against schema before routing. CRITICAL-002 fix opens the door for these schemas.

**Affected surface (ripple set)**
- `.claude/allowlists/boundary-files.yaml`.
- `libs/event-contracts/src/schemas/stripe-events.schema.ts` (new).
- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts` (validate-before-route).

**Expected closer**
billing-expert WRITER mode (primary on Stripe boundary).

---

## Cross-domain dependencies flagged

- CONTRACT-CRITICAL-001 → invokes `auth-security-expert` (auth-service spec PII fields), `billing-expert` (billing-service Stripe spec), `admin-expert` (admin-api `@ApiResponse` rollout).
- CONTRACT-CRITICAL-002 → invokes `data-expert` (primary; event-contract shape), `messaging-expert` (notification-service consumer drift), and ripple-tracer enumeration of `services.yaml` `Subscription*.>` subscribers.
- CONTRACT-CRITICAL-003 → invokes `edge-expert` (primary; sens-api-gateway/) and `architectural-arbiter` (collapse-or-keep doc-tree decision).
- CONTRACT-HIGH-001 → invokes `data-expert` (primary; type-level fix) and every domain expert whose service publishes Date-typed events.
- CONTRACT-HIGH-002 → invokes `admin-expert` (primary; admin-api response schema).
- CONTRACT-HIGH-003 → invokes `frontend-expert` (primary; codegen rewire), `data-expert` (federation schema reconciliation).
- CONTRACT-HIGH-004 → invokes `implementation-planner` (3-commit chain depending on CRITICAL-001 + HIGH-003 first).
- CONTRACT-MEDIUM-001 → invokes `auth-security-expert` (sibling finding).
- CONTRACT-MEDIUM-002 → invokes `billing-expert` (sibling BILLING-CRITICAL-001).

## Verdict

**BLOCK.** Three CRITICAL findings each represent a separate contract-parity axis (HTTP, event, hardware) without enforcement. None has a tracked finding ID in `docs/reviews/_registry/findings.jsonl` linkage that closes via the `Closes:` commit footer protocol.

Closing-order recommendation:
1. CONTRACT-CRITICAL-002 first (event contract — narrowest scope, immediate consumer-crash risk).
2. CONTRACT-CRITICAL-001 (OpenAPI extract pipeline; unlocks CONTRACT-HIGH-002 + CONTRACT-HIGH-004).
3. CONTRACT-HIGH-003 (codegen — unlocks the second half of CONTRACT-HIGH-004).
4. CONTRACT-CRITICAL-003 (sensor-protocol doc collapse — coordinate with edge-expert + architectural-arbiter).
5. CONTRACT-HIGH-004 (the invariant test that prevents regression).
6. CONTRACT-HIGH-001 + MEDIUM-001 + MEDIUM-002 in parallel.

## References

- `.claude/knowledge/layer-1-core.md` (TS branded types, Jest invariants, Nx affected).
- `.claude/knowledge/layer-1-nestjs.md` (Federation subgraph + Apollo Gateway composition; CQRS layer rules).
- `.claude/knowledge/layer-2-patterns.md` (event flat pattern; outbox; CI invariant discipline).
- `.claude/knowledge/layer-3-adrs.md` (ADR-006 events; ADR-008 guards; ADR-009 fetch / codegen; ADR-014/015 NATS).
- ADR-003 sensor-service separation (cited in CRITICAL-003).
- ADR-006 event-contracts flat (cited in CRITICAL-002 + HIGH-001).
- Sibling DATA-CRITICAL-003 (data-expert), DATA-HIGH-004 (data-expert), BILLING-CRITICAL-001 (billing-expert), auth-security-expert deprecated JWT PII fields finding — all referenced in evidence above.
- `.claude/agents/contract-parity-enforcer.md` (own primary-ownership spec; identified path drift `infra/openapi/**` vs actual `docs/api/openapi/`, and `sens-api-gateway/src/protocols/**` vs actual flat layout).
