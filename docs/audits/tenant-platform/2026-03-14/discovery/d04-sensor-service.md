# D04 - Sensor Service Audit Report

**Auditor:** D4 - Sensor Backend Expert
**Date:** 2026-03-14
**Service:** sensor-service (port 4003)
**Scope:** Data integrity, tenant isolation, performance, security

---

## 1. SERVICE OVERVIEW

Sensor-service is the IoT data backbone of the platform. It handles real-time sensor
data ingestion via MQTT, time-series storage in TimescaleDB, VFD control, IEC 61131-3
automation programs, edge device provisioning, PLC communication, and SCADA deployments.

### 1.1 Module Inventory (14 feature modules)

| Module               | Purpose                                         |
|----------------------|-------------------------------------------------|
| SensorModule         | Core sensor CRUD, ingestion, query, calibration |
| IngestionModule      | MQTT listener, data processor, batch writer     |
| SharedMqttModule     | @Global single MQTT connection                  |
| TimescaleModule      | Hypertable, continuous aggregate, retention mgmt|
| ProtocolModule       | 30+ protocol adapters (Modbus, BACnet, etc.)    |
| RegistrationModule   | Sensor self-registration and channel discovery  |
| VfdModule            | VFD device control via 7 protocol adapters      |
| AutomationModule     | IEC 61131-3 SFC/ST programs, compiler, deploy   |
| PlcControlModule     | OPC UA PLC communication, feeding params        |
| EdgeDeviceModule     | Device provisioning, heartbeat, MQTT auth       |
| ProcessModule        | SCADA packages, unified tags, deploy logs       |
| DashboardModule      | Dashboard layout persistence                    |
| SensorTypeModule     | Dynamic sensor type definitions                 |
| HealthModule         | Health check endpoints                          |

### 1.2 Codebase Scale

- ~160 TypeScript source files (excluding tests)
- 18 test files (spec.ts)
- 7 database migrations
- 35 entity definitions
- 30+ protocol adapters

---

## 2. TIMESCALEDB USAGE

### 2.1 Hypertable: sensor_metrics

**Table:** `sensor_metrics` - Narrow EAV design (one row per measurement)

- **Primary key:** `(time, sensor_id, channel_id)` - composite for time partitioning
- **Chunk interval:** 1 day
- **File:** `/apps/sensor-service/src/database/migrations/1735900000000-CreateSensorMetrics.ts`

Key columns: `time`, `sensor_id`, `channel_id`, `tenant_id`, `raw_value`, `value`,
`quality_code` (OPC-UA aligned: 192=GOOD, 64=UNCERTAIN, 0=BAD), `source_protocol`,
`source_timestamp`, `ingestion_latency_ms`, `batch_id`, plus denormalized location
fields (site_id, department_id, system_id, equipment_id, tank_id, pond_id, farm_id).

**Indexes (10 total):**
- `(sensor_id, time DESC)`, `(channel_id, time DESC)`, `(tenant_id, time DESC)`
- `(tank_id, time DESC)` partial, `(equipment_id, time DESC)` partial
- `(quality_code, time DESC)` partial (non-good only)
- `(batch_id)` partial, `(sensor_id, channel_id, time DESC)` covering
- `(tank_id, sensor_id, channel_id, time DESC)` covering

### 2.2 Compression Policy

```sql
ALTER TABLE sensor_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'tenant_id, sensor_id, channel_id',
  timescaledb.compress_orderby = 'time DESC'
);
add_compression_policy('sensor_metrics', INTERVAL '7 days');
```

**Assessment:** GOOD - segment_by includes tenant_id ensuring per-tenant compression
segments. 7-day threshold is reasonable for IoT data.

### 2.3 Retention Policy

- **Raw data:** 90 days retention (`add_retention_policy('sensor_metrics', INTERVAL '90 days')`)
- **metrics_1min:** 1 year retention
- **metrics_1hour:** 5 years retention
- **metrics_1day:** No retention (kept forever)

**Assessment:** GOOD - tiered retention strategy with cascading aggregates preserves
historical summary data while managing storage costs.

### 2.4 Continuous Aggregates (3 tiers)

| View          | Granularity | Source        | Refresh Interval | Retention |
|---------------|-------------|---------------|-------------------|-----------|
| metrics_1min  | 1 minute    | sensor_metrics| Every 1 min       | 1 year    |
| metrics_1hour | 1 hour      | metrics_1min  | Every 1 hour      | 5 years   |
| metrics_1day  | 1 day       | metrics_1hour | Every 1 day       | Forever   |

**Features:**
- `materialized_only = false` - enables real-time query pass-through for open buckets
- Cascading design (1day reads from 1hour, 1hour reads from 1min)
- Pooled standard deviation formula for statistical accuracy across buckets
- Quality percentage tracked at all levels
- Ingestion latency tracked at minute and hour levels

**Assessment:** EXCELLENT - proper cascading continuous aggregate design with
correct statistical aggregation.

### 2.5 Runtime Management Services

- `HypertableService`: chunk count, size, chunk interval queries (introspection only)
- `ContinuousAggregateService`: refresh status monitoring, manual refresh (validates
  against whitelist of known views to prevent SQL injection)
- `RetentionPolicyService`: get/set/remove retention policies programmatically

### 2.6 TimescaleDB Injection Risk

**MITIGATED:**
- `ContinuousAggregateService.refresh()` validates view name against `KNOWN_AGGREGATES`
  constant array before passing to `CALL refresh_continuous_aggregate()`
- `RetentionPolicyService.setPolicy()` uses parameterized queries (`$1`, `$2`)
- `HypertableService` uses parameterized queries throughout
- `BatchProcessorService` validates UUIDs before insertion and uses parameterized queries
- `input-sanitizer.ts` provides `validateAggregationInterval()` with strict whitelist

**FINDING [LOW]:** `RetentionPolicyService.setPolicy()` accepts a freeform
`retentionInterval` string parameter that is passed as `$2` to
`add_retention_policy()`. While this uses a parameterized query (safe against
SQL injection), an attacker with access to this service method could set an
extremely short interval (e.g., '1 second') causing data loss. Access is limited
to internal service calls only - not exposed via GraphQL.

---

## 3. MQTT INGESTION

### 3.1 Topic Structure

**Sensor data topics:**
- `sensors/#` - wildcard for all sensor data
- `aquaculture/+/sensors/#` - tenant-specific sensors
- `+/+/+/temperature-array` - array sensor pattern

**Edge device topics (legacy):**
- `edge/{deviceCode}/heartbeat|birth|death|response|responses`

**Edge device topics (v2.0 tenant-prefixed):**
- `tenants/{tenantId}/devices/{deviceCode}/telemetry|status|response|responses`
- `tenants/{tenantId}/devices/{deviceCode}/io_data|alarms|capabilities|lora_events`

### 3.2 QoS Configuration

- Default QoS: **1** (at least once delivery)
- Subscription uses single SUBSCRIBE packet for all topics (optimized)
- `clean: true` session - no persistent sessions

### 3.3 MQTT Client (MqttClientService)

- Singleton connection per service instance (@Global SharedMqttModule)
- Exponential backoff reconnection (1s base, 60s max, 20 max attempts)
- Circuit breaker pattern (opens after 20 failures, resets after 5 minutes)
- 5-second startup delay to allow HTTP server to be ready for go-auth callbacks
- Graceful shutdown with handler cleanup

### 3.4 MQTT Authentication

**File:** `/apps/sensor-service/src/edge-device/mqtt-auth.service.ts`

Two modes supported:

**HTTP mode (recommended for production):**
- Mosquitto calls HTTP endpoints: `POST /mqtt/auth`, `POST /mqtt/acl`, `POST /mqtt/superuser`
- Credentials verified against `edge_devices.mqtt_password_hash` in database
- Cross-tenant ACL enforcement by matching device's tenant_id against topic
- No file I/O, no locks

**File mode (legacy):**
- Credentials written to Mosquitto password file with atomic writes
- SIGHUP reload via `execFile` (no shell injection - uses `execFile`, not `exec`)

**Security features:**
- PBKDF2-SHA512 password hashing (600,000 iterations in HTTP mode, Mosquitto $7$ format)
- Timing-safe comparison (`crypto.timingSafeEqual`) for password verification
- Timing-safe tenant ID comparison (SHA-256 hash then `timingSafeEqual`) for ACL checks
- Revoked/decommissioned devices rejected at auth level
- No superuser accounts - all service accounts use per-topic-pattern grants
- LRU cache (max 10,000 entries, 5-min TTL) for tenant ID lookups
- Early rejection of invalid client ID formats (must start with `edge-`)
- `$SYS/` topics denied for all non-service accounts

### 3.5 Cross-Tenant Data Leak Analysis (MQTT)

**ACL enforcement chain:**

1. **Topic-level:** Device can only access `tenants/{its_own_tenant_id}/devices/{its_own_id}/`
2. **Device identity:** Topic device identifier matched against both `mqttClientId` and device UUID
3. **Tenant boundary:** Topic tenant_id compared to device's stored tenant_id using timing-safe comparison
4. **Service accounts:** Scoped per-topic-pattern grants (not superuser)

**FINDING [MEDIUM]: Legacy `edge/` topic pattern lacks tenant enforcement.**
The legacy pattern `edge/{deviceCode}/heartbeat` has no tenant_id in the topic path.
ACL check (line 223-226) only verifies `legacyMatch[1] === username` - the device can
only write to its own device code topic, but the MqttListenerService processes these
messages without tenant context. The `handleEdgeHeartbeat` method on legacy topics calls
`edgeDeviceService.updateHeartbeat()` without a `tenantId` parameter, meaning the
heartbeat handler must do a cross-schema lookup by deviceCode alone.

**MITIGATION:** The `updateHeartbeat()` method in EdgeDeviceService does perform a
cross-schema lookup that resolves the device's actual tenant, but this is less secure
than the tenant-prefixed pattern where tenantId is extracted from the topic and explicitly
passed for boundary enforcement.

**RECOMMENDATION:** Deprecate the legacy `edge/` topic pattern and require all devices
to use the `tenants/{tenantId}/devices/{deviceCode}/` pattern. Add a configuration flag
to disable legacy topic subscriptions.

### 3.6 Data Validation

**MqttListenerService message processing:**
1. Topic parsing extracts tenantId, sensorId, location
2. Sensor lookup via `SensorTopicCacheService` (Redis + local LRU cache)
3. Payload parsing with `JSON.parse()` (catches parse errors)
4. `DataProcessorService.processReading()`:
   - Type conversion (string to number)
   - Raw value range validation against sensor min/max
   - Calibration application (channel-level polynomial or sensor-level linear)
   - Post-calibration range validation
   - Alert threshold checking (warning + critical)
   - Quality score computation (0-100)
5. `BatchProcessorService`:
   - UUID validation for sensorId, channelId, tenantId
   - `Number.isFinite()` checks for raw_value and value
   - `sourceProtocol` sanitized with regex `[^a-zA-Z0-9_-]`
   - Parameterized INSERT with `ON CONFLICT` upsert

**FINDING [LOW]: No payload size limit on MQTT messages.**
The `handleMessage()` method calls `message.toString()` on the entire buffer without
checking its size. A malicious device could publish an extremely large payload causing
memory pressure. While Mosquitto itself has `message_size_limit`, this should also be
enforced application-side.

### 3.7 Batch Processing

**BatchProcessorService:**
- In-memory buffer flushed every 500ms or at 500 rows (whichever first)
- Parameterized INSERT with chunking (max 1000 rows per INSERT, respecting
  PostgreSQL's 65,535 parameter limit)
- `ON CONFLICT (time, sensor_id, channel_id) DO UPDATE` for idempotent ingestion
- Graceful shutdown: final flush on `onModuleDestroy`
- 19 columns per row

---

## 4. VFD PROTOCOL ADAPTERS

### 4.1 Architecture

Abstract base class `BaseVfdAdapter` with 7 concrete implementations:

| Adapter              | Protocol     | Status       |
|----------------------|-------------|--------------|
| VfdModbusTcpAdapter  | Modbus TCP  | Fully implemented |
| VfdModbusRtuAdapter  | Modbus RTU  | Implemented  |
| VfdBacnetAdapter     | BACnet IP   | Implemented  |
| VfdCanopenAdapter    | CANopen     | Implemented  |
| VfdEthernetIpAdapter | EtherNet/IP | Implemented  |
| VfdProfibusDpAdapter | Profibus DP | Implemented  |
| VfdProfinetAdapter   | PROFINET    | Implemented  |

### 4.2 VfdModbusTcpAdapter (Primary)

- Real TCP socket communication via Node.js `net` module
- MBAP header framing with transaction ID tracking
- Batch register reads (groups adjacent registers, max gap=10, max batch=125)
- Connection handle management with active connections Map
- CiA 402 / PROFIdrive standard status word parsing
- Configuration validation (IP/hostname, port range, timeout bounds)
- Test connection cleanup (LOW-005 fix: always disconnects even on error)

### 4.3 Brand Configurations

8 brand-specific register mapping configs: ABB, Danfoss, Delta, Mitsubishi,
Rockwell, Schneider, Siemens, Yaskawa.

### 4.4 Security Considerations

**FINDING [LOW]: VFD connection configs stored in JSONB without encryption.**
VFD IP addresses and connection parameters are stored in plain JSONB in the database.
While these are typically internal network addresses, in a multi-tenant environment,
tenant admins can see their own VFD network topology.

---

## 5. AUTOMATION (IEC 61131-3)

### 5.1 Components

- **AutomationService:** Program CRUD, step/transition/variable management, deployment
- **Compiler module:** Full Structured Text (ST) compiler with lexer, parser, semantic
  analyzer, type checker, symbol table, AST adapter, formatter
- **Worker pool:** ST compilation offloaded to worker threads
- **Deployment:** Programs deployed to edge devices via MQTT
- **DeploymentLogService:** Tracks deployment status with timeout detection

### 5.2 Program Lifecycle

`DRAFT -> APPROVED -> DEPLOYING -> DEPLOYED (or failed back to APPROVED)`

Programs have: steps, transitions, actions, variables, SFC definition (JSONB),
trigger configuration.

### 5.3 Security

- Programs are tenant-scoped (tenantId field)
- Deployment uses `SET LOCAL search_path` within transactions
- Program status transitions validated (cannot deploy from DRAFT directly)
- Deployment timeout detection via `@Interval` scheduler

---

## 6. CALIBRATION SERVICE

**Files:** `/apps/sensor-service/src/calibration/calibration.service.ts`,
`drift-detection.service.ts` (both are 1-line stubs)

**FINDING [INFO]: Calibration entity and drift detection service files exist but
contain only empty exports.** Calibration logic is actually implemented in two places:

1. **DataProcessorService:** Linear calibration via sensor-level `calibrationMultiplier`
   and `calibrationOffset`, or channel-level polynomial calibration via
   `SensorDataChannel.applyCalibration()`
2. **SensorModule's CalibrationService:** `/apps/sensor-service/src/sensor/services/calibration.service.ts`
   (has actual implementation with test coverage)

The top-level `/calibration/` directory appears to be legacy stubs that were superseded
by the implementations in the `sensor/` module.

---

## 7. EDGE DEVICE MANAGEMENT

### 7.1 Provisioning Flow

**Zero-touch provisioning with two modes:**

**Mode 1 - Per-device provisioning:**
1. Admin creates device -> gets `deviceCode` + `provisioningToken`
2. Device runs installer script: `curl /install/{deviceCode}?token={token} | sudo sh`
3. Agent calls `POST /api/devices/activate` with deviceId + token + fingerprint
4. Service validates token (timing-safe), generates MQTT credentials
5. Returns MQTT broker address, credentials, tenant_id

**Mode 2 - Tenant-level provisioning (v2.0):**
1. Admin creates tenant provisioning key (with maxDevices, autoApprove settings)
2. Device runs: `curl /install/t/{tenantToken} | sudo bash`
3. Agent calls `POST /api/devices/self-register` with tenant_token + fingerprint
4. Service validates key, checks maxDevices atomically in transaction
5. Creates device record + MQTT credentials in single transaction

### 7.2 Security Features

- **Provisioning tokens:** 256-bit random (`crypto.randomBytes(32)`)
- **Token expiry:** Configurable TTL (default 24 hours)
- **Single-use tokens:** Cleared from DB after activation
- **Timing-safe token comparison:** SHA-256 hash then `timingSafeEqual`
- **MQTT credentials:** 128-bit random password, PBKDF2-SHA512 hash
- **Rate limiting:** 3-10 requests/min per IP on public endpoints
- **Input validation:** Device code format regex, token format regex
- **Shell injection prevention:** `execFile` (not `exec`) for Mosquitto reload
- **Duplicate detection:** Fingerprint-based machine ID dedup with 1-hour recovery window
- **Transaction isolation:** Activation uses `SET LOCAL search_path` in transaction

### 7.3 Heartbeat Processing

- Legacy: `edge/{deviceCode}/heartbeat` - no tenant context
- v2.0: `tenants/{tenantId}/devices/{deviceCode}/telemetry` - tenant-scoped
- EdgeDeviceService uses `@Interval(60000)` for offline detection
- Supports both camelCase and snake_case field names (Rust serde compatibility)

### 7.4 Device Lifecycle States

`REGISTERED -> ACTIVE -> MAINTENANCE -> DECOMMISSIONED`
`REGISTERED -> PENDING_APPROVAL -> ACTIVE` (self-registration with autoApprove=false)
`ACTIVE -> REVOKED` (security incident)

---

## 8. STREAM PROCESSING

### 8.1 AnomalyDetectorService

- **Algorithm:** Welford's online algorithm for incremental mean/variance (O(1) per reading)
- **State:** Per sensor+channel running statistics (count, mean, m2, min, max)
- **Minimum samples:** 30 before declaring anomalies
- **Severity classification:** |z| < 2.5 = none, < 3.5 = mild, < 5.0 = moderate, >= 5.0 = severe
- **Batch processing:** setImmediate trampolining for arrays > 1000 to avoid event loop blocking

### 8.2 RealTimeAnalyzerService

Exists as a service file for real-time signal analysis.

### 8.3 KafkaStreamsService

Exists as a service file for Kafka Streams integration.

---

## 9. TENANT SCHEMA ISOLATION

### 9.1 Mechanism

**TenantSchemaMiddleware** sets PostgreSQL `search_path` per request:

```
SET search_path TO "tenant_{first16hex}", sensor, public
```

- Applied to all routes via `NestModule.configure()`
- UUID validation before schema name generation (SQL injection prevention)
- Schema name regex validation: `/^[a-z0-9_]+$/`
- LRU cache for schema existence checks (1000 entries, 5-min positive TTL, 30s negative TTL)
- `RESET search_path` on response `finish` and `close` events
- Default connection pool search_path: `sensor, public`

### 9.2 Search Path Order

1. Tenant-specific schema (e.g., `tenant_4b529829ea7948da`)
2. Sensor schema (shared system tables: sensor_protocols, sensor_type_definitions)
3. Public schema (extensions, common functions)

### 9.3 Cross-Tenant Safety

**GOOD practices:**
- GraphQL resolvers always filter by `tenantId` (verified in SensorResolver)
- Federation reference resolver includes tenant isolation check
- `TenantGuard` applied globally via `APP_GUARD`
- `RolesGuard` applied globally (enforces `@Roles()` decorators)
- Error handling: returns 400 instead of falling back to shared schema for authenticated requests

**FINDING [MEDIUM]: search_path reset race condition potential.**
The `res.on('finish')` and `res.on('close')` callbacks that reset `search_path`
execute asynchronously. If the connection is returned to the pool before the
`RESET search_path` query completes, the next request on that connection could
inherit the previous tenant's search_path. This is mitigated by TypeORM's connection
pool behavior (connections are typically held for the duration of the request), but
under high concurrency with connection pool exhaustion, this could theoretically
cause cross-tenant data access.

**RECOMMENDATION:** Use `SET LOCAL search_path` (transaction-scoped) instead of
`SET search_path` (session-scoped) for request-scoped operations, or implement
a connection pool interceptor that sets search_path at connection checkout.

### 9.4 Cross-Schema Lookups

Several services perform cross-schema lookups by building UNION ALL queries:

- `MqttAuthService.findDeviceAcrossSchemas()` - for MQTT auth (schema names validated by regex)
- `ProvisioningService.findDeviceAcrossSchemas()` - for device activation
- `SensorTopicCacheService.findSensorInDatabase()` - for topic-to-sensor mapping

All use parameterized queries with schema names validated against `^tenant_[a-f0-9]{16}$`
or `^[a-zA-Z_][a-zA-Z0-9_]*$` patterns.

**FINDING [LOW]: Cross-schema queries do not scale with tenant count.**
The UNION ALL approach queries every tenant schema sequentially. With 100+ tenants,
these queries become expensive. The `SensorTopicCacheService` mitigates this with
Redis caching, but `MqttAuthService.findDeviceAcrossSchemas()` is called on every
MQTT CONNECT and ACL check (mitigated by in-memory LRU cache with 10,000 entry limit).

---

## 10. GRAPHQL FEDERATION

### 10.1 Configuration

- **Driver:** Apollo Federation v2 (`@nestjs/apollo` + `ApolloFederationDriver`)
- **Schema:** Auto-generated from decorators (`autoSchemaFile: { federation: 2 }`)
- **Playground:** Disabled in production
- **Introspection:** Disabled in production

### 10.2 Security

- **Query depth limit:** 10 (configurable via `GRAPHQL_MAX_DEPTH`)
- **Query complexity limit:** 1000 (configurable via `GRAPHQL_MAX_COMPLEXITY`)
- Complexity estimation: `fieldExtensionsEstimator` + `simpleEstimator(default: 1)`
- Complexity exceeded: 400 error with `QUERY_COMPLEXITY_EXCEEDED` code

### 10.3 Federation Entities

`Sensor` is the primary federated entity with `@ResolveReference()`:
- Extracts tenantId from context or reference
- Always filters by tenantId to ensure tenant isolation
- Returns null (not error) for missing/unauthorized references

### 10.4 Key Resolvers

Verified resolvers: SensorResolver, VfdDeviceResolver, VfdCommandResolver,
VfdReadingResolver, EdgeDeviceResolver, AutomationResolver, PlcControlResolver,
ProcessResolver, UnifiedTagResolver, DashboardResolver, RegistrationResolver,
ChannelResolver, SensorTypeResolver, ProtocolResolver.

---

## 11. TEST COVERAGE

### 11.1 Test Files Inventory (18 files)

| Category                | Test File                              |
|-------------------------|----------------------------------------|
| Input sanitization      | `sensor/validation/__tests__/input-sanitizer.spec.ts` |
| Data quality            | `sensor/services/__tests__/data-quality.service.spec.ts` |
| Calibration             | `sensor/services/__tests__/calibration.service.spec.ts` |
| VFD entity              | `vfd/entities/__tests__/vfd-device.entity.spec.ts` |
| VFD enums               | `vfd/entities/__tests__/vfd.enums.spec.ts` |
| VFD reading entity      | `vfd/entities/__tests__/vfd-reading.entity.spec.ts` |
| VFD device resolver     | `vfd/resolvers/__tests__/vfd-device.resolver.spec.ts` |
| VFD command resolver    | `vfd/resolvers/__tests__/vfd-command.resolver.spec.ts` |
| VFD base adapter        | `vfd/adapters/__tests__/base-vfd.adapter.spec.ts` |
| VFD Modbus TCP adapter  | `vfd/adapters/__tests__/vfd-modbus-tcp.adapter.spec.ts` |
| VFD command service     | `vfd/services/__tests__/vfd-command.service.spec.ts` |
| VFD device service      | `vfd/services/__tests__/vfd-device.service.spec.ts` |
| VFD connection tester   | `vfd/services/__tests__/vfd-connection-tester.service.spec.ts` |
| Channel detection       | `sensor-type/__tests__/channel-detection.service.spec.ts` |
| Sensor type service     | `sensor-type/__tests__/sensor-type.service.spec.ts` |
| Dynamic sensor types    | `database/entities/__tests__/dynamic-sensor-type-entities.spec.ts` |
| Health controller       | `health/__tests__/health.controller.spec.ts` |
| Provisioning config     | `edge-device/__tests__/provisioning-config.spec.ts` |

### 11.2 Coverage Assessment

**FINDING [MEDIUM]: Critical paths lack test coverage.**

Missing test coverage for:
- `MqttListenerService` - the primary ingestion path (0 tests)
- `MqttAuthService` - MQTT authentication and ACL (0 tests)
- `TenantSchemaMiddleware` - tenant isolation (0 tests)
- `BatchProcessorService` - batch write logic (0 tests)
- `DataProcessorService` - reading processing pipeline (0 tests)
- `ProvisioningService` - device provisioning (0 tests; only config test exists)
- `EdgeDeviceService` - heartbeat handling (0 tests)
- `AnomalyDetectorService` - anomaly detection (0 tests)
- `AutomationService` - program management (0 tests)

The VFD module has excellent test coverage (10 test files). The MQTT ingestion
pipeline, tenant isolation middleware, and provisioning flow - all security-critical
paths - have zero test coverage.

---

## 12. SECURITY FINDINGS SUMMARY

### CRITICAL - None found

### HIGH - None found

### MEDIUM (3)

| ID       | Finding                                        | Location                          |
|----------|------------------------------------------------|-----------------------------------|
| SEC-M01  | Legacy `edge/` topics lack tenant enforcement  | mqtt-listener.service.ts:298-388  |
| SEC-M02  | search_path reset race condition potential      | tenant-schema.middleware.ts:137-148|
| SEC-M03  | Critical ingestion/auth paths lack test coverage| See section 11.2                 |

### LOW (4)

| ID       | Finding                                        | Location                          |
|----------|------------------------------------------------|-----------------------------------|
| SEC-L01  | RetentionPolicy accepts freeform interval      | retention-policy.service.ts:59    |
| SEC-L02  | No application-side MQTT payload size limit    | mqtt-listener.service.ts:294      |
| SEC-L03  | VFD connection configs stored unencrypted      | vfd-device.entity.ts              |
| SEC-L04  | Cross-schema UNION ALL does not scale          | mqtt-auth.service.ts:345-369      |

---

## 13. DATA INTEGRITY ASSESSMENT

### 13.1 Strengths

1. **Parameterized queries everywhere** - no string interpolation for SQL values
2. **UUID validation** before schema name generation (SQL injection prevention)
3. **Input sanitization module** with LIKE escape, schema name validation, aggregation
   interval whitelist, data path depth limiting
4. **OPC-UA aligned quality codes** - proper data quality tracking at ingestion
5. **Idempotent ingestion** - `ON CONFLICT DO UPDATE` prevents duplicate readings
6. **Timing-safe comparisons** for all security-sensitive operations
7. **Transaction isolation** for activation and self-registration flows
8. **Atomic file writes** for legacy password file mode (tmp + fsync + rename)
9. **Batch processor** validates UUIDs and uses `Number.isFinite()` checks

### 13.2 Concerns

1. **Calibration stubs** - `/calibration/calibration.service.ts` and
   `drift-detection.service.ts` are empty; actual logic exists elsewhere but
   the code organization is confusing
2. **validation.service.ts** in ingestion module is a 1-line stub
3. **lastSeenAt debounce** - sensor last-seen updates are batched every 30 seconds;
   if the service crashes, up to 30 seconds of last-seen data is lost (acceptable)

---

## 14. PERFORMANCE ASSESSMENT

### 14.1 Strengths

1. **Batch ingestion** - 500ms/500-row flush cycle, parameterized bulk INSERT
2. **Multi-level caching** - Redis + local LRU for sensor-topic mappings
3. **Negative caching** - prevents repeated expensive lookups for unknown topics
4. **Single SUBSCRIBE packet** - all topics subscribed in one MQTT operation
5. **lastSeenAt debounce** - batches sensor timestamp updates every 30 seconds
6. **Connection pool** - 50 max / 10 min connections, 5-min idle timeout
7. **Covering indexes** - optimized for DISTINCT ON queries
8. **Welford online anomaly detection** - O(1) per reading, no array passes
9. **setImmediate trampolining** - prevents event loop blocking for large batches

### 14.2 Concerns

1. **SensorTopicCacheService warm-up** queries every tenant schema sequentially
   at startup, potentially blocking initialization for large deployments
2. **Channel cache** in MqttListenerService is per-instance memory (not shared
   between service instances in a scaled deployment)

---

## 15. RECOMMENDATIONS

### Priority 1 (Security)

1. **Deprecate legacy `edge/` topic pattern** - All edge devices should use
   `tenants/{tenantId}/devices/` pattern. Add `LEGACY_EDGE_TOPICS_ENABLED=false`
   config flag.

2. **Use SET LOCAL instead of SET for search_path** - Prevents connection pool
   contamination entirely by scoping to the current transaction.

3. **Add MQTT payload size limit** - Check `message.length` before `toString()`
   in `MqttListenerService.handleMessage()`. Reject payloads > 256KB.

### Priority 2 (Testing)

4. **Add integration tests for MqttAuthService** - Test cross-tenant ACL
   enforcement, service account access patterns, timing-safe comparisons.

5. **Add unit tests for TenantSchemaMiddleware** - Test schema resolution,
   UUID validation, cache behavior, error handling paths.

6. **Add unit tests for BatchProcessorService** - Test chunking logic,
   UUID validation, flush timing, graceful shutdown.

### Priority 3 (Maintenance)

7. **Remove calibration stubs** - Delete `/calibration/calibration.service.ts`
   and `drift-detection.service.ts` (empty files) to avoid confusion with the
   actual implementations in `/sensor/services/`.

8. **Implement validation.service.ts** - The ingestion module's validation
   service is a 1-line stub. Either implement it or remove it and document
   that validation happens in DataProcessorService.

---

## 16. OVERALL ASSESSMENT

The sensor-service is architecturally sound with well-implemented security controls
for a multi-tenant IoT platform. The TimescaleDB usage is exemplary with proper
cascading continuous aggregates, compression policies, and retention tiers. MQTT
authentication features robust PBKDF2 hashing with timing-safe comparisons and
per-topic tenant isolation.

The primary concerns are:
- Legacy `edge/` topic pattern that bypasses tenant-scoped ACL
- search_path session-level SET instead of transaction-level SET LOCAL
- Critical paths (ingestion, auth, middleware) lacking test coverage

The VFD module stands out as the best-tested component. The provisioning system
implements a proper zero-touch flow with single-use tokens, rate limiting, and
transaction isolation.

**Risk Rating: LOW-MEDIUM** - No critical vulnerabilities found. The medium
findings are mitigated by defense-in-depth (multiple layers of tenant isolation)
but should be addressed to strengthen the security posture.
