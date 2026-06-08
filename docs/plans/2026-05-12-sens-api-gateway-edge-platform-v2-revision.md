# Sens API Gateway Edge Platform v2.0 Revision

**Date:** 2026-05-12
**Owner:** Okan (platform owner)
**Status:** Active v2.0 planning source of truth
**Supersedes on conflict:** `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md`
**Authoritative schema ADR:** `docs/adr/034-edge-schema-sensor-per-tenant-ownership.md`

This revision narrows v2.0 to a pilot-ready edge platform release: real hardware path, safe provisioning, tenant-isolated MQTT, billing-owned license, existing event/UI/ops contracts, and release evidence. Fleet dashboard, crypto agility, broad gold image rollout, JSON runtime deprecation, and SIL alignment stay tracked as v2.1 non-closures.

## Phase 0 Gate

ADR-034 is the active schema placement source of truth. ADR-022 is historical only and is explicitly superseded for edge schema ownership.

Phase 2 platform schema work must follow these ownership rules:

| Surface | v2.0 ownership |
|---|---|
| Source schema migrations | `apps/sensor-service/src/database/migrations` |
| Edge v2 entities | `apps/sensor-service/src/edge-device/entities/v2` |
| Tenant fan-out | db-migrate tenant schema provisioner |
| Admin API | Open Host Service consumer only; no direct SQL writes or reads |
| Dedicated edge schema | Not active in v2.0 |

v2.0 ships the ADR-034 table set under the `sensor` source schema and per-tenant clones:

| Table | v2.0 disposition |
|---|---|
| `sensor.devices` | Included |
| `sensor.policies` | Included |
| `sensor.licenses` | Included |
| `sensor.firmware_releases` | Included |
| `sensor.provisioning_records` | Included |
| `sensor.witnesses` | Included |
| `sensor.audit_archive_v1` | Included |

These tables remain outside v2.0 and require an accepted ADR amendment before implementation:

| Table | v2.0 disposition |
|---|---|
| `enrollment_tokens` | Excluded |
| `fleet_rollouts` | Excluded |
| `compromise_incidents` | Excluded |

Phase 0 also requires a finding coverage matrix. Every open edge finding must be marked as one of:

| Status | Meaning |
|---|---|
| `covered` | A v2.0 phase has an implementation and evidence gate. |
| `superseded with evidence` | A newer accepted ADR or merged implementation replaces the finding. |
| `v2.1 non-closure` | Tracked explicitly as not closed by v2.0. |

OPC UA is not considered done until the following gates have production evidence: cert reject audit, keypair migration flag, PKI manifest command, auth throttling, lease release, subscription notifier, and reload/SIGHUP.

## Production Status

`sensor-service` is production-active and remains the cloud owner for edge v2 metadata. `sensor-ingestion` is registered/inactive for v2.0 planning purposes until a rollout slice activates the Rust sidecar path with production evidence. Catalog registration is not the same as production-active status.

## Provisioning Trust Anchor

The activation/self-register API must not add raw trust-root PEM fields.

The staged v2.0 compatible response extension is:

| Field | Required | Meaning |
|---|---:|---|
| `provisioning_blob_b64` | No | Canonical signed provisioning bundle bytes, base64 encoded. |
| `provisioning_signature_b64` | No | Detached signature over the bundle, base64 encoded. |
| `provisioning_key_epoch` | No | Provisioning signing key epoch. |
| `provisioning_bundle_version` | No | Bundle schema version. |

The edge may parse these fields but must not trust tenant, MQTT, RBAC, firmware, program, or license roots from the bundle until it verifies the bundle with the baked provisioning public key.

QR remains presentation over the existing tenant provisioning/self-register flow. v2.0 does not add `enrollment_tokens`.

Static config remains `/etc/suderra/config.yaml`; runtime state and certs remain `/var/lib/suderra`.

## Command And License Ownership

Auth-service only produces signed command envelopes. Billing-service owns edge licensing.

Billing-service must provide `EdgeLicenseService` that issues compact Ed25519 JWS licenses and writes:

| ADR column | Contract |
|---|---|
| `sensor.licenses.license_jwt` | Compact JWS, RFC 7519-compatible text. |
| `sensor.licenses.license_sha256` | SHA-256 digest of the exact license JWT bytes. |

The billing implementation must carry a mapping table:

`PlanLimits -> ADR license columns -> JWS claims -> Rust EdgeLicenseLimits`

Legacy command wire format keeps `commandId` camelCase. In production Enforcing mode, legacy mutating commands are rejected. `debug_step` is envelope-only, signature-required, bounded, forbidden in emergency mode, audited, and requires the relevant write permission for write-step operations.

The command registry is the single source of truth:

```text
{ wire_name, handler, permission, mutating, two_person_required, legacy_allowed }
```

## Event, MQTT, And UI Contracts

EventBus subject taxonomy does not change:

```text
events.{tenantId}.{eventType}
```

`deviceId` stays in the payload or aggregate identity, not in the subject.

MQTT control/data topics standardize on:

```text
tenants/{tenantId}/devices/{deviceId}/...
```

MQTT ACL has two v2.0 modes:

| Mode | Behavior |
|---|---|
| Compatibility default | Allows the device's own legacy `edge/{mqttClientId}/#` topic with WARN and metric; denies cross-tenant and cross-device access. |
| Strict | Rejects legacy `edge/{mqttClientId}/#` entirely. |

Live Monitor must use the existing gateway-api Socket.IO `/sensors` path:

```text
subscribeEdgeIo({ deviceCode })
edgeIoData
edgeAlarm
```

v2.0 does not add a new admin-api SSE/Apollo bridge.

## Phase Plan

| Phase | Scope | Exit gates |
|---|---|---|
| 0 | ADR-034 status/table/migration/grant gates, threat model, finding coverage matrix, CI cleanup, command registry SSoT, v2.1 deferral register. | ADR-034 accepted, exact table set pinned, all edge findings classified. |
| 1 | Edge runtime and safety/security foundations. | `gpio` build first; I2C private bus handles with no `unwrap`; Modbus coalescing by `data_type` width and FC1/FC2/FC3/FC4; `ProcessImage.update_tag` change events; polling uses precomputed `PollPlan`; no `AppState` guard across await; PRF-004/PRF-007 included. |
| 1 | Command/security hardening. | Registry fields above; DebugStep handler/mapping/audit; fuzz targets for provisioning blob, QR bootstrap, command authorization matrix, mTLS pins; Kani only after real harnesses exist. |
| 2 | Platform schema. | Ordered sensor-service migrations and entities under sensor-service ownership; db-migrate tenant schema provisioner clones the table set; exact table/grant/invariant coverage. |
| 2 | Device cutover. | Backfill from existing tenant device tables; dual-write rollout; sensor-service repository adapter; MQTT auth/provisioning/heartbeat/UI switch behind `edge_schema_v2_enabled`; rollback keeps tenant-table reads. |
| 2 | Contracts/UI. | Edge events in TS schemas, validators, `AnyPlatformEvent`, and `event-contracts-rs`; tenant-admin extends existing device/detail/installer surfaces; edge audit is a filtered sensor-service view; RBAC adds `edge` category to backend/frontend permission metadata. |
| 3 | Ops/release. | Observability before pilot: metric-label reconciliation, deployed alerts, dashboards, black-box probes, logs, traces. Sidecar v2.0 scope is topology/no-overlap/manual rollback, not automatic 60s no-loss failover. Deployment matrix covers droplet compose, prod compose, Helm. |
| 3 | Field rollout. | Pilot manifest required before Day 0; QR uses existing tenant provisioning flow; no new enrollment-token table. |
| 4 | Release. | Cut `v2.0.0-rc.1`, run a 7-day Enforcing-mode pilot after rollback rehearsal, then GA. |

## v2.1 Non-Closures

These are tracked but cannot be represented as closed by v2.0 evidence:

| Item | Reason |
|---|---|
| Fleet dashboard | v2.0 extends existing tenant device/detail/installer surfaces only. |
| Crypto agility | v2.0 ships current Ed25519 contracts; broader agility requires separate ADR. |
| Gold image broad rollout | Pilot-ready release only. |
| JSON runtime deprecation | Coexistence remains; removal requires separate migration plan. |
| SIL alignment | Not a v2.0 release blocker; legal/field-ops evidence remains separate. |
| `.deb`, `.img.xz`, GHCR verification | Release contract remains tarball; packaging expansion is v2.1/ADR work. |
| `enrollment_tokens` | QR is presentation over existing flow. |
| `fleet_rollouts` | Fleet rollout tables are not a v2.0 blocker. |
| `compromise_incidents` | Incident table requires accepted ADR amendment. |
| Automatic 60s no-loss sidecar failover | v2.0 sidecar scope is topology/no-overlap/manual rollback. |

## Release Artifact Contract

v2.0 release artifact contract remains tarball-based:

```text
agent-v2.0.0/
  suderra-agent_2.0.0_<target>.tar.gz
  suderra-agent
  suderra-agent_2.0.0_<target>.tar.gz.sha256
  suderra-agent_2.0.0_<target>.tar.gz.sig
  suderra-agent_2.0.0_<target>.tar.gz.pem
  suderra-agent_2.0.0_<target>.tar.gz.intoto.jsonl
  suderra-agent_2.0.0_<target>.tar.gz.sbom.cdx.json
  suderra-agent_2.0.0_<target>.tar.gz.notices.txt
```

## Test Gates

Executable gates:

```bash
npm run codegen:check
npm run invariants:full
npm run test:schema-invariants
npx nx run migration-harness:test
cd e2e && npm run test:node -- <edge specs>
```

Rust gates inside `sens-api-gateway`:

```bash
cargo check --locked --all-targets --features gpio
cargo check --locked --all-targets --features scada-display,gpio
cargo test --locked --all-targets --features "$SENS_API_GATEWAY_CI_FEATURES" --no-fail-fast
cargo bench --locked --no-run
```

Non-merge evidence gates:

| Evidence | Gate |
|---|---|
| Criterion p99 | Fixed hardware or nightly only. |
| Fuzz | 24h scheduled after targets exist. |
| Kani | Accepted only after proof harnesses exist. |
| Pilot/chaos/100-device evidence | Stored with workflow/run IDs. |

E2E catalog keeps all 41 historical scenarios. v2.0 blocks on the 31 applicable production scenarios. The 10 v2.1 scenarios remain tracked as explicit non-closures.

## Assumptions

ADR-034 is the schema source of truth. v2.0 prioritizes production correctness over broad fleet features. Backward compatibility means wire/data/API compatibility with v1.6, not insecure production fallback. No new edge metadata table ships without an accepted ADR amendment.
