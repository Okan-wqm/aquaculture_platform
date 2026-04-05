# Review Report -- Sensor Expert: Targeted Security Audit
**Date:** 2026-04-05
**Scope:** Focused audit on 7 attack surfaces: IDOR/authorization, VFD provisioning, NATS subjects, input validation, DoS/pagination, PII logging, and orphan code
**Reviewer:** sensor-expert
**Prior Review:** 2026-04-04-full-codebase-audit.md -- prior findings escalated where still unfixed

---

## Summary

| Severity | Count | New | Escalated from Prior |
|----------|-------|-----|---------------------|
| CRITICAL | 4     | 3   | 1 (HIGH-003 escalated) |
| HIGH     | 5     | 4   | 1 (HIGH-004 re-confirmed) |
| MEDIUM   | 5     | 5   | 0 |
| LOW      | 3     | 3   | 0 |

---

## Prior Finding Status Check

Prior findings from 2026-04-04:
- **CRITICAL-001** (timing-safe provisioning): Not fixed. Remains CRITICAL.
- **HIGH-001** (`any` types in MQTT listener): Not fixed. Remains HIGH.
- **HIGH-002** (legacy `sensors/#` wildcard): Not fixed. Remains HIGH.
- **HIGH-003** (VFD `findByIdOrFail` no tenantId): Not fixed. **Escalated to CRITICAL** per escalation policy.
- **HIGH-004** (emergency rollback self-approval): Not fixed. Remains HIGH.
- **MEDIUM-004** (local MQTT topic cache not tenant-scoped): Not fixed. Remains MEDIUM.
- **LOW-002** (rollup.service.ts empty stub): Fixed -- file now contains KafkaStreamsService placeholder with proper structure.

---

## Findings

### [CRITICAL-001-ESCALATED] `findByIdOrFail` in VfdChangeSetService Has No tenantId Filter (Prior HIGH-003, Escalated)
- **File:** `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts:495-508`
- **Category:** Security / Tenant Isolation (IDOR)
- **Status:** Unfixed from 2026-04-04. Escalated to CRITICAL per policy.
- **Description:** `findByIdOrFail()` queries by `{ id: changeSetId }` alone. All state-mutating operations on change sets -- `submitForApproval`, `approveChangeSet`, `rejectChangeSet`, `rollbackChangeSet`, `removeItem`, `addItems` -- call this helper. None of the resolver mutations pass `tenantId` to the service for these operations.
- **Root Cause:** The resolver methods for `submitForApproval`, `approveChangeSet`, `rejectChangeSet`, `rollbackChangeSet`, and `removeVfdChangeSetItem` receive only `changeSetId` and `userId` from GraphQL args -- `@Tenant()` is absent. The service helper does not enforce tenant ownership.

  ```typescript
  // vfd-programming.resolver.ts:186-192 -- no @Tenant()
  async submitForApproval(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.submitForApproval(changeSetId, userId);
  }

  // vfd-change-set.service.ts:495-508 -- no tenantId filter
  private async findByIdOrFail(changeSetId: string): Promise<VfdChangeSet> {
    const changeSet = await this.changeSetRepository.findOne({
      where: { id: changeSetId },  // cross-tenant IDOR
      relations: ['items'],
    });
  ```

- **Impact:** Any authenticated user in Tenant A who can guess or enumerate a change set UUID from Tenant B can approve, reject, or rollback Tenant B's VFD parameter changes. This is a cross-tenant industrial control system manipulation vulnerability.
- **Fix:** Add `@Tenant() tenantId: string` to every affected resolver mutation and thread it into the service. Change `findByIdOrFail(changeSetId)` to `findByIdOrFail(changeSetId, tenantId)` and add `tenantId` to the `WHERE` clause.

---

### [CRITICAL-002] VFD Automation Rule Mutations Lack tenantId Enforcement (New IDOR Cluster)
- **Files:**
  - `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts:161-176` (`updateVfdAutomationRule`)
  - `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts:182-189` (`deleteVfdAutomationRule`)
  - `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts:195-202` (`toggleVfdAutomationRule`)
  - `apps/sensor-service/src/vfd-programming/services/vfd-automation-rule.service.ts:181-183` (`findById`)
  - `apps/sensor-service/src/vfd-programming/services/vfd-automation-rule.service.ts:198-206` (`findByIdOrFail`)
- **Category:** Security / Tenant Isolation (IDOR)
- **Description:** The `updateVfdAutomationRule`, `deleteVfdAutomationRule`, and `toggleVfdAutomationRule` mutations do not extract `@Tenant() tenantId`. They call `automationRuleService.updateRule(id, ...)`, `automationRuleService.deleteRule(id)`, and `automationRuleService.toggleRule(id, isActive)` respectively. The underlying `findByIdOrFail(id)` queries `{ id }` with no tenantId filter. Additionally, `getVfdAutomationRule` (the single-rule query at line 106-110) also calls `findById(id)` without tenantId.

  ```typescript
  // vfd-automation.resolver.ts:163-175 -- no @Tenant()
  async updateAutomationRule(
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateAutomationRuleInput,
  ): Promise<VfdAutomationRule> {
    return this.automationRuleService.updateRule(id, { ... });
  }

  // vfd-automation-rule.service.ts:198-206 -- no tenantId filter
  private async findByIdOrFail(id: string): Promise<VfdAutomationRule> {
    const rule = await this.ruleRepository.findOne({ where: { id } });
  ```

- **Impact:** A user in Tenant A can update, delete, or toggle a VFD automation rule belonging to Tenant B. Since automation rules trigger industrial parameter changes on VFDs, this is equivalent to cross-tenant equipment control. Additionally, `getVfdAutomationRuleHistory` queries `{ automationRuleId: ruleId }` with no tenantId filter, leaking another tenant's audit trail.
- **Fix:** Add `@Tenant() tenantId: string` to all three mutations and the single-rule query. Add `tenantId` parameter to `findById`, `findByIdOrFail`, `updateRule`, `deleteRule`, and `toggleRule` in the service. Add `tenantId` to the WHERE clause of all repository queries.

---

### [CRITICAL-003] Single VfdChangeSet Read Query Exposes Cross-Tenant Data
- **File:** `apps/sensor-service/src/vfd-programming/resolvers/vfd-programming.resolver.ts:86-91`
- **Category:** Security / Tenant Isolation (IDOR -- Information Disclosure)
- **Description:** The `vfdChangeSet` GraphQL query (line 86) does not accept or pass `tenantId`. It calls `changeSetService.findById(id)` which queries `{ id }` alone (line 448-453 of vfd-change-set.service.ts). Any authenticated user who knows a UUID can read another tenant's change set, including all parameter values, approver identity, and audit data.

  ```typescript
  // resolver line 86-91
  @Query(() => VfdChangeSet, { name: 'vfdChangeSet', nullable: true })
  async getChangeSet(
    @Args('id', { type: () => ID }) id: string,
    // Missing: @Tenant() tenantId: string
  ): Promise<VfdChangeSet | null> {
    return this.changeSetService.findById(id);  // no tenant filter
  }
  ```

- **Impact:** Cross-tenant information disclosure of VFD parameter change history including proposed frequency limits, braking parameters, and approver identities. Violates GDPR data separation requirements for industrial SaaS.
- **Fix:** Add `@Tenant() tenantId: string` and pass it to `findById`. Change `findById` to accept and apply `tenantId` in the WHERE clause.

---

### [CRITICAL-004] NATS Subject Format Has No Tenant Segment -- Cross-Tenant Event Leakage Risk
- **File:** `platform/libs/event-bus/src/nats/nats-event-bus.ts:272-276`
- **Category:** Architecture / Tenant Isolation
- **Description:** NATS subjects are formatted as `events.{eventType}` (e.g., `events.SensorReading`). There is no tenantId in the subject path. Any service subscribed to `events.SensorReading` receives ALL sensor reading events from ALL tenants. The tenantId is only in the event payload. The event bus dispatcher at lines 511-516 calls `handler.handle(event)` without any tenant filtering -- every handler receives every tenant's events.

  If a future microservice subscribes to `events.SensorReading` expecting only its own tenant's data and fails to check `event.tenantId` on every event, it will process cross-tenant data silently. This is a systemic architectural risk.

  ```typescript
  // nats-event-bus.ts:276 -- no tenantId in subject
  await this.publishTo(`events.${event.eventType}`, event, options);

  // Consumer filter (line 471) -- event-type only, no tenant segment
  filter_subject: subject,  // e.g., "events.SensorReading" -- all tenants
  ```

- **Impact:** Any consumer subscribing to an event type receives all tenants' events. Tenant isolation depends entirely on each handler checking `event.tenantId` against its own tenant context. One missed check equals cross-tenant data leakage. This violates the defense-in-depth principle for a multi-tenant SaaS.
- **Correct Architecture:** NATS subjects must include tenantId: `events.{tenantId}.{eventType}`. The event bus `publish` method already has `event.tenantId` available. Consumers subscribe to `events.{ownTenantId}.>` or use NATS subject-level access control (NATS authorization rules per tenant). This is the standard pattern for multi-tenant JetStream deployments.

---

### [HIGH-001-CONFIRMED] VfdChangeSet submitForApproval/approveChangeSet/rejectChangeSet/rollbackChangeSet Missing @Tenant (Component of CRITICAL-001-ESCALATED)
This is the resolver-level component of CRITICAL-001-ESCALATED. Listed separately for implementation tracking.
- **File:** `apps/sensor-service/src/vfd-programming/resolvers/vfd-programming.resolver.ts:185-239`
- Affected mutations: `submitVfdChangeSetForApproval` (line 185), `approveVfdChangeSet` (line 198), `rejectVfdChangeSet` (line 211), `rollbackVfdChangeSet` (line 228), `removeVfdChangeSetItem` (line 257-264)

---

### [HIGH-002] OPC UA `discoverOpcUaEndpoints` Does Not Validate Endpoint Belongs to Caller's Tenant
- **File:** `apps/sensor-service/src/plc-control/resolvers/plc-control.resolver.ts:214-222`
- **Category:** Security / SSRF / Authorization
- **Description:** `discoverOpcUaEndpoints` accepts a raw `endpointUrl` string from the caller. The URL validation in `PlcConnectionService.validateEndpointUrl()` (line 454-460) only checks `opc.tcp://` prefix. It does not check whether the target host/port corresponds to a PLC connection owned by the calling tenant, and does not block RFC 1918 ranges (10.x, 192.168.x, 172.16-31.x) or `localhost`/`127.0.0.1`.

  ```typescript
  // plc-connection.service.ts:454-460
  private validateEndpointUrl(url: string): void {
    if (!url.startsWith('opc.tcp://')) {
      throw new BadRequestException('...');
    }
    // No private IP blocking, no tenant ownership check
  }
  ```

  Since OPC UA operates on arbitrary TCP ports and the endpoint is directly connected to, a user can probe internal infrastructure addresses by constructing `opc.tcp://10.0.0.1:4840` and observing connection timing/errors to map the internal network.
- **Impact:** SSRF allows tenant users (even with MODULE_MANAGER role) to scan internal network topology, probe Kubernetes pod IPs, or attempt to connect to internal services that speak OPC UA or can be fingerprinted by connection behavior.
- **Fix:** The correct enterprise pattern is to restrict discovery to `endpointUrl` values that are already registered as `PlcConnection` records for the caller's tenant. Alternatively, if ad-hoc discovery is required, implement a private IP blocklist and resolve the hostname to verify it is not RFC 1918 before opening the TCP connection.

---

### [HIGH-003] `sensorsByProtocol` Query Is Unbounded -- Full Table Scan DoS
- **File:** `apps/sensor-service/src/registration/services/sensor-registration.service.ts:495-505`
- **File:** `apps/sensor-service/src/registration/resolvers/registration.resolver.ts:79-86`
- **Category:** Performance / DoS
- **Description:** `getSensorsByProtocol()` calls `sensorRepository.find({ where: { protocolId, tenantId } })` with no `take` limit. A tenant with thousands of sensors on a given protocol (e.g., Modbus) will trigger a full table scan returning unlimited rows into memory. The resolver passes no pagination arguments.

  ```typescript
  // sensor-registration.service.ts:495-505
  async getSensorsByProtocol(protocolCode: string, tenantId: string): Promise<Sensor[]> {
    // ...
    return this.sensorRepository.find({
      where: { protocolId: protocol.id, tenantId },
      order: { name: 'ASC' },
      // Missing: take: MAX_PAGE_SIZE
    });
  }
  ```

- **Impact:** A single GraphQL query can exhaust service memory and database connection pool. In a multi-tenant SaaS with shared infrastructure, one tenant's query can cause OOM for all tenants.
- **Fix:** Add `take: 500` cap as a hard safety limit. The resolver should accept pagination arguments. For bulk protocol queries, use cursor-based pagination.

---

### [HIGH-004] `BatchIngestInput.readings` Array Has No GraphQL-Layer Size Cap
- **File:** `apps/sensor-service/src/sensor/dto/ingest-reading.dto.ts:112-117`
- **File:** `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:319-334`
- **Category:** Security / DoS
- **Description:** The `BatchIngestInput` DTO defines `readings: IngestReadingInput[]` without an `@ArrayMaxSize()` decorator. The service-layer MAX_BATCH_SIZE is 10,000 (line 134 of sensor-ingestion.service.ts), which is itself extremely large. However, the absence of DTO-level validation means class-validator is not enforced before the service receives the array. An attacker can submit a request with arbitrarily many items that pass GraphQL parsing before the service check.

  The graphql-query-complexity plugin does not account for array sizes in input objects by default (simpleEstimator assigns complexity 1 per field regardless of array length).
- **Impact:** A single authenticated request with a very large `readings` array bypasses the complexity limiter and can cause excessive memory allocation and processing in the ingestion pipeline before the 10K check.
- **Fix:** Add `@ArrayMaxSize(500)` from `class-validator` to `BatchIngestInput.readings`. The 10,000 service-level limit should be reduced to 500 and treated as defense-in-depth, not the primary gate. Also register a custom complexity estimator that multiplies by input array length for batch operations.

---

### [HIGH-005] `process.env` Used Directly Instead of ConfigService for GitHub Credentials
- **File:** `apps/sensor-service/src/edge-device/edge-device.service.ts:2184,2190,2280`
- **Category:** Architecture / Security
- **Description:** `getAvailableFirmwareVersions()` and `bulkUpdateDeviceFirmware()` read `process.env.GITHUB_REPO` and `process.env.GITHUB_TOKEN` directly instead of using the injected `ConfigService`. This bypasses NestJS's configuration validation, `ConfigModule.cache`, and any production-required checks. The hardcoded default `'Okan-wqm/aquaculture_platform'` also exposes the developer's GitHub handle in a production binary.

  ```typescript
  // edge-device.service.ts:2184
  const repo = process.env.GITHUB_REPO || 'Okan-wqm/aquaculture_platform';
  // edge-device.service.ts:2190
  const githubToken = process.env.GITHUB_TOKEN;
  ```

  `installer-script.service.ts` correctly uses `this.configService.get(...)` for the same values (lines 52, 171, 267). This is an inconsistency that creates a configuration split-brain.
- **Impact:** In containerized environments where environment variables are injected via secrets managers (AWS SSM, K8s Secrets), the `process.env` path may read stale or empty values. The hardcoded GitHub username is an information disclosure.
- **Fix:** Replace both `process.env` calls with `this.configService.get<string>('GITHUB_REPO', 'org/repo')` and `this.configService.get<string>('GITHUB_TOKEN')`. Update the default fallback to use a placeholder that makes configuration failure obvious, not a real repo path.

---

### [MEDIUM-001] IP Address Logged at DEBUG Level in MQTT Telemetry Handler
- **File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1027`
- **Category:** Privacy / PII Logging
- **Description:** The `handleTenantEdgeTelemetry` path stores and logs `ipAddress` from device telemetry. At line 1027: `this.logger.debug('I/O data from ${deviceCode}: ${payloadStr.substring(0, 200)}')` may include IP addresses when `payloadStr` captures telemetry payloads. More directly, `handleEdgeHeartbeat` at line 457 logs `deviceCode` and health metrics, and the payload stored in `device.ipAddress` is directly from MQTT message content. If DEBUG logging is enabled in production-adjacent environments (staging, QA), device IP addresses appear in structured logs.
- **Impact:** Device IP addresses are PII/quasi-PII under GDPR Article 4(1) when associated with identified operators. Log aggregation systems (Elasticsearch, Datadog) will index them in plaintext, creating a data subject access/erasure compliance burden.
- **Fix:** IP addresses should not be logged at any level outside of security audit events. Remove `ipAddress` from debug log payloads. If IP tracking is required for security, write to a dedicated immutable audit log with access controls, not the application log stream.

---

### [MEDIUM-002] Tenant Provisioning Key `validateAndGetKey` Uses Direct String Comparison
- **File:** `apps/sensor-service/src/edge-device/tenant-key.service.ts:112-113`
- **Category:** Security / Timing Attack
- **Description:** `validateAndGetKey(token)` queries the database with `WHERE keyToken = :token` (line 112-113). This is a direct equality comparison in PostgreSQL, which is not constant-time. While the token is 64 hex characters (256 bits of entropy), timing differences in the database response (row found vs. row not found) can leak whether the first N characters match any stored token prefix, enabling a partial oracle attack at the database layer.

  ```typescript
  const key = await this.tenantKeyRepository.findOne({
    where: { keyToken: token },  // not constant-time at DB level
  });
  ```

  The activation token path (`provisioning.service.ts:298`) correctly uses `crypto.timingSafeEqual()`. The tenant key path does not.
- **Impact:** With sufficient network measurements, an attacker can determine if a partial token matches any existing token. The 256-bit entropy makes a full brute-force impractical, but the oracle can narrow the search space.
- **Fix:** Hash the token with SHA-256 before storing and before comparison (as done for device activation tokens). Store `sha256(keyToken)` in the database and compare `sha256(incomingToken) === storedHash` using `crypto.timingSafeEqual()`. The raw token is returned to the caller only at creation time.

---

### [MEDIUM-003] `sensorRawList` Query Accepts Caller-Controlled `limit` Without Upper Bound Enforcement
- **File:** `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:110-134`
- **Category:** DoS / Missing Validation
- **Description:** The `sensorRawList` query at line 110 accepts `limit` as an integer arg with `defaultValue: 20`. There is no `@Max()` constraint and no server-side cap in the resolver or service. A caller can pass `limit: 999999` and receive all sensors for the tenant in a single response.

  ```typescript
  @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
  limit: number,
  // ...
  return await this.sensorRepository.find({
    take: limit,  // caller-controlled, no cap
  });
  ```

  The paginated `sensors` query via `RegistrationResolver` correctly uses `createStandardPaginatedResult` with safe defaults. The raw list query was likely preserved for legacy compatibility but has no safety guard.
- **Impact:** A single request can exhaust the database connection pool and node.js heap by loading all sensors into memory. In a shared multi-tenant service, this creates a noisy-neighbor DoS condition.
- **Fix:** Add `const safeLimit = Math.min(limit, 200)` before the query. Add `@Max(200)` to the DTO if this moves to a proper input type. Alternatively, deprecate `sensorRawList` and require callers to use the paginated `sensors` query.

---

### [MEDIUM-004] NATS `SensorReading` Event Published Without tenantId in Subject Path
- **File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1419-1427`
- **Category:** Architecture / Tenant Isolation (Component of CRITICAL-004)
- **Description:** When a sensor reading arrives via MQTT, `publishSensorReadingEvent` publishes to the event bus. The event bus publishes to subject `events.SensorReading` for all tenants. Any service that subscribes to `SensorReading` events MUST check `event.tenantId` on every received event or it processes cross-tenant data. This is an application-level enforcement of what should be an infrastructure-level guarantee. The event bus dispatches all handlers for the subject without any tenant filter (nats-event-bus.ts:511-516). This is a systemic risk across all 18 sensor events.
- **Impact:** One incorrectly implemented event handler across any of the 12+ microservices will cause cross-tenant data processing. This cannot be detected by code review alone -- it requires runtime testing of every handler.
- **Fix:** See CRITICAL-004 for the architectural fix. Short-term mitigation: enforce `event.tenantId` validation as the first line of every `IEventHandler.handle()` implementation. Add a linting rule or base class that throws if `event.tenantId` does not match the handler's tenant context.

---

### [MEDIUM-005] `getVfdAutomationRuleHistory` Query Not Tenant-Scoped
- **File:** `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts:121-127`
- **File:** `apps/sensor-service/src/vfd-programming/services/vfd-automation-rule.service.ts:185-193`
- **Category:** Security / Information Disclosure (IDOR)
- **Description:** `getVfdAutomationRuleHistory` at resolver line 121 accepts `ruleId` without `@Tenant()`. The service queries `{ automationRuleId: ruleId }` with no tenantId filter. Any user who knows another tenant's automation rule UUID can read its execution history, including parameter names, values applied, timestamps, and which VFD device was targeted.

  ```typescript
  // resolver line 121-127 -- no @Tenant()
  async getAutomationRuleHistory(
    @Args('ruleId', { type: () => ID }) ruleId: string,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit: number,
  ): Promise<VfdParameterAuditLog[]> {

  // service line 185-193 -- no tenantId in WHERE
  return this.auditLogRepository.find({
    where: { automationRuleId: ruleId },  // cross-tenant readable
  ```

- **Impact:** Cross-tenant audit log disclosure. An attacker can enumerate historical VFD automation actions for any tenant's industrial equipment.
- **Fix:** Add `@Tenant() tenantId: string` to the resolver. Add `tenantId` to the service query WHERE clause: `{ automationRuleId: ruleId, tenantId }`.

---

### [LOW-001] Orphan Services in `stream-processing/` and `aggregation/` Directories
- **Files:**
  - `apps/sensor-service/src/stream-processing/kafka-streams.service.ts`
  - `apps/sensor-service/src/stream-processing/real-time-analyzer.service.ts`
  - `apps/sensor-service/src/stream-processing/statistical-aggregator.service.ts`
  - `apps/sensor-service/src/aggregation/rollup.service.ts`
  - `apps/sensor-service/src/aggregation/time-bucket.service.ts`
  - `apps/sensor-service/src/cleaning/data-cleaner.service.ts`
  - `apps/sensor-service/src/cleaning/interpolation.service.ts`
  - `apps/sensor-service/src/cleaning/outlier-detection.service.ts`
  - `apps/sensor-service/src/calibration/drift-detection.service.ts`
- **Category:** Architecture / DI Safety
- **Description:** None of the services in `stream-processing/`, `cleaning/`, or `calibration/` directories are registered in any NestJS module's `providers` array. `TimeBucketService` and `RollupService` in `aggregation/` are also not imported by any module. No `AggregationModule`, `StreamProcessingModule`, or `CleaningModule` exists in `app.module.ts`. The `TimescaleModule` exists at `timescale/timescale.module.ts` but is not imported in `app.module.ts` either.

  These files are reachable from the application's source tree, pass TypeScript compilation, and may fool developers into thinking they are active.
- **Impact:** Zero runtime impact (not registered = not instantiated = no DI failure). However, any future developer who attempts to inject `TimeBucketService` via constructor injection will get a NestJS `Nest can't resolve dependencies` error at startup. The `KafkaStreamsService` explicitly advertises future Kafka capability -- if a developer imports it without a module registration, the service will start without the feature active and no startup warning.
- **Fix:** Either register these services in a proper module and import that module in `app.module.ts`, or delete the files if they are not planned for near-term implementation. The `TimescaleModule` skeleton should either be populated or removed.

---

### [LOW-002] `getDeviceStatus` Public Endpoint Leaks Device Existence as Oracle
- **File:** `apps/sensor-service/src/edge-device/provisioning.controller.ts:273-310`
- **Category:** Security / Information Disclosure
- **Description:** The public `GET /api/devices/:deviceCode/status` endpoint (no authentication) returns different responses for valid vs. invalid device codes. For a valid deviceCode with a non-provisioned state, it returns `{ ready: false, status: 'NOT_AVAILABLE' }`. For an invalid/nonexistent deviceCode, it also returns `{ ready: false, status: 'NOT_AVAILABLE' }` -- but the device existence is leakable via response timing (database hit vs. no database hit) and the device code format regex only filters syntactically malformed codes.

  An attacker can enumerate valid device codes by generating codes matching the `[A-Z]{2,5}-[0-9A-F]{8}` format and timing responses. Valid device code lookups hit the database; invalid ones may differ in timing due to index scan vs. missing-key fast path.
- **Impact:** Device code enumeration allows an attacker to build a list of provisioned devices across all tenants (since device code is globally unique). This is useful for targeted provisioning attacks.
- **Fix:** Add artificial constant-time delay to equalize response times for found vs. not-found. Rate limit per IP to 1 request/minute (current limit is 5/minute). Return the same opaque response regardless of device existence.

---

### [LOW-003] MQTT Auth Controller Notes That Secret Validation Is Ineffective
- **File:** `apps/sensor-service/src/edge-device/mqtt-auth.controller.ts:58-68`
- **Category:** Security / Documentation Gap
- **Description:** The constructor comment (line 58-68) explicitly documents that `MQTT_AUTH_SECRET` header validation is not effective because `mosquitto-go-auth` does not support custom headers. The security relies entirely on Docker network isolation. This is correct for the current deployment model, but the comment states "security relies on Docker network isolation" without a corresponding infrastructure enforcement check. If the internal Docker network is misconfigured or if the auth endpoint is exposed via a misconfigured Nginx rule, the entire MQTT auth layer becomes unauthenticated.
- **Impact:** If Docker network isolation is breached (container escape, misconfigured compose network), any process on the host can call the MQTT auth endpoints and fabricate authentication results.
- **Fix:** Add a startup check that verifies the auth endpoint is not reachable from a non-localhost address. Alternatively, implement IP allowlisting at the NestJS layer: only accept requests from the Mosquitto container's IP range. A startup warning log is not sufficient for a production security control.

---

## Systemic Issues

### SYSTEMIC-001: Cross-Tenant IDOR Cluster in VFD Programming Module (3 separate violations)
Findings CRITICAL-001-ESCALATED, CRITICAL-002, and CRITICAL-003 represent the same root cause: the VFD programming module was built without consistently applying `@Tenant()` to state-mutation operations. Three distinct resolvers (`vfd-programming.resolver.ts`, `vfd-automation.resolver.ts`) and three service helpers (`findByIdOrFail` in vfd-change-set.service.ts, `findById`/`findByIdOrFail` in vfd-automation-rule.service.ts) all exhibit the same pattern. This is a SYSTEMIC issue that warrants an architectural discussion and cross-module audit of every resolver in this service to ensure no other state-mutation operation is missing tenant scoping.

**Recommended approach:** Introduce a mandatory `@TenantScoped()` custom decorator that fails build-time if `@Tenant()` is absent on mutations. Add a pre-deploy automated test that enumerates all `@Mutation()` methods and asserts they extract tenantId.

### SYSTEMIC-002: NATS Event Subjects Are Not Tenant-Partitioned (Architectural Design Gap)
Finding CRITICAL-004 and MEDIUM-004 share the same root: the event bus uses flat `events.{eventType}` subjects. This is the third occurrence of a tenant isolation concern related to the event bus architecture (HIGH-002 in the prior review covered legacy MQTT topics; MEDIUM-004 in the prior review covered the local topic cache). The pattern of tenant isolation depending on application-layer checks rather than infrastructure enforcement is recurring.

**Recommended approach:** Migrate to tenant-partitioned NATS subjects: `events.{tenantId}.{eventType}`. This is a breaking change requiring coordinated deployment across all services but is the only way to provide infrastructure-enforced cross-tenant event isolation.

---

## Architecture Positives (Confirmed Still Valid from Prior Review)

1. **Provisioning controller** correctly rate-limits all public endpoints and validates device code format with regex before any DB access.
2. **Tenant key service** correctly implements atomic TOCTOU-safe `incrementUsedCount` via `UPDATE WHERE used_count < max_devices`.
3. **PLC resolver** consistently applies `@Tenant()` across all 25+ queries and mutations. All `findById(id, tenantId)` calls are tenant-scoped.
4. **Edge device resolver** correctly passes `tenantId` to all service calls for both device management and I/O config operations.
5. **MQTT payload size limit** (256KB) enforced before any processing prevents memory exhaustion from oversized MQTT messages.
6. **Sensor ingestion via MQTT** correctly derives `tenantId` from the resolved sensor record (from DB), not from the MQTT message payload -- preventing tenant injection via message content.
7. **Readings query** (`getReadings`) has a service-layer `MAX_RESULTS_LIMIT = 10000` and uses `validateLimit()`. The batch latest-readings query caps at 100 sensors. Aggregated readings use TimescaleDB continuous aggregates.
