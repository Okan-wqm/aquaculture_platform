# Review Report -- Sensor Expert
**Date:** 2026-04-10
**Scope:** Full repo audit of `apps/sensor-service/**`, `web/modules/sensor-module/**`, and `sensorprotocols/**` where relevant
**Reviewer:** sensor-expert

## Summary
| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 2 |
| MEDIUM | 0 |
| LOW | 0 |

**Deployment Decision:** `BLOCK`

## Findings

### [CRITICAL-001] `getLastReadings()` Scans `sensor_metrics` Without Any Time-Range Predicate
- **File:** `apps/sensor-service/src/sensor/services/metric-query.service.ts:298-315`
- **Category:** Performance / TimescaleDB pruning
- **Description:** `getLastReadings()` queries `sensor_metrics` by `channel_id` and `tenant_id` only, then orders by `time DESC` and applies `LIMIT`. There is no `time >= ...` / `time < ...` predicate, so this path bypasses chunk pruning on the hypertable and can devolve into a scan across the full retention window.
- **Impact:** A "latest readings" call can become a full hypertable scan under load, which is exactly the failure mode the sensor-domain rules try to prevent. If this method is used by a UI or future resolver, one tenant can force expensive scans on shared infrastructure.
- **Remediation:** Require a bounded time window for this API, or move latest-reading access to a dedicated latest-value table / materialized view that is cheap to probe without scanning historical chunks.
- **Cross-Domain Dependency:** `database-reviewer` for hypertable/index design; frontend consumers of latest readings should be updated to pass an explicit range or switch to a dedicated latest-value query.

### [HIGH-001] `sensorRawList` Computes `skip` From Unbounded `page`/`limit` Before Clamping
- **File:** `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:111-132`
- **Category:** Performance / DoS
- **Description:** `skip` is calculated as `(page - 1) * limit` before any validation or clamping, while only `take` is capped to `200`. A caller can supply a very large `page` and `limit` to force a huge SQL `OFFSET`, which is expensive even if the returned row count is small.
- **Impact:** This is an easy tenant-level query DoS vector against a shared sensor listing endpoint. Large `OFFSET` queries are one of the fastest ways to waste CPU and I/O on a hot table.
- **Remediation:** Clamp `page` and `limit` before computing `skip`, or replace the endpoint with cursor-based pagination so the query cost is independent of the requested page number.
- **Cross-Domain Dependency:** Frontend sensor list consumers should move to cursor pagination; `database-reviewer` can confirm supporting index coverage for the new access pattern.

### [HIGH-002] Installer Script Hardcodes `mqtt.tls.enabled: true` Even When Provisioning Resolves to Plain MQTT
- **File:** `apps/sensor-service/src/edge-device/installer-script.service.ts:40-49,201-214,300-308`
- **Category:** Architecture / Provisioning correctness
- **Description:** The provisioning config tracks both `MQTT_BROKER_PORT` and `MQTT_TLS_ENABLED`, but both generated installer configs hardcode `mqtt.tls.enabled: true`. The constructor still defaults the broker port to `1883`, and `mqttTlsEnabled` can be `false`, so the emitted config can contradict the actual broker mode.
- **Impact:** Provisioned edge agents can be configured with TLS enabled against a plaintext broker port, which breaks activation and update flows. In fallback/default deployments, that creates a repeatable provisioning failure instead of a working device config.
- **Remediation:** Emit `mqtt.tls.enabled` from the resolved `mqttTlsEnabled` value, and validate the port/TLS pair before rendering the script so the generator fails closed on inconsistent settings.
- **Cross-Domain Dependency:** `edge-expert` for device-side protocol expectations; `infra-expert` for broker port/TLS deployment defaults.

## Notes
- I did not run the test suite for this audit.
- I did not find additional sensor-domain CRITICALs in the current tree beyond the hypertable scan issue above.
