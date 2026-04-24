# MindSphere Connector

**Scope:** How `sens-api-gateway` would ingest data into Siemens MindSphere (now rebranded Insights Hub — see `insights-hub.md` for the post-rebrand naming).

**Honest posture:** MindSphere / Insights Hub ingestion is **NOT IMPLEMENTED** in the gateway today. This chapter documents the intended architecture so a customer RFP can evaluate feasibility, not installed behaviour.

---

## Siemens version compatibility matrix

| MindSphere / Insights Hub component | Connector path | Status |
|---|---|---|
| MindConnect Library v3.x (C++ / C#) | Embedded agent mode | NOT IMPLEMENTED — ROADMAP Q3 2026 |
| MindConnect IoT Extension (MQTT bridge) | Bridge topology | NOT IMPLEMENTED — ROADMAP Q3 2026 (preferred path) |
| MindConnect Nano (gateway appliance) | Hardware alternative — NOT our product | — |
| MindConnect IoT 2040 / 2050 | Agent co-hosted on IoT 2050 | POSSIBLE via SIMATIC IPC deployment; no MindSphere code shipped |
| Insights Hub OpenAPI (v3 REST) | Server-side ingestion API | Gateway does not call OpenAPI directly; NOT IMPLEMENTED |

---

## Today's state

The gateway publishes telemetry to our own MQTT broker via the topic tree documented in `src/config.rs:1294-1312`:

```
tenants/{tenant_id}/devices/{device_id}/status
tenants/{tenant_id}/devices/{device_id}/telemetry
tenants/{tenant_id}/devices/{device_id}/commands
tenants/{tenant_id}/devices/{device_id}/config
```

There is **no MindConnect code**, no IoT Extension bridge configuration, and no MindSphere SDK binding anywhere in the repository. A customer currently consumes telemetry from our MQTT broker or our cloud HTTP API — not from MindSphere.

### Finding ID

**ORPHAN-EDGE-012** — "MindSphere / Insights Hub connector not implemented". Severity: MEDIUM. Owner: cloud integration team. Target: Q3 2026 (preferred path via MindConnect IoT Extension MQTT bridge).

---

## Roadmap path A — MindConnect IoT Extension (preferred)

MindConnect IoT Extension is the Siemens-supported MQTT bridge that accepts JSON payloads over MQTT and forwards them into Insights Hub as time-series readings. It is the lowest-friction path for a Rust edge agent because no C++ SDK binding is required.

```
┌──────────────────┐                    ┌────────────────────────────┐
│ sens-api-gateway │  MQTT (TLS)        │ MindConnect IoT Extension  │
│ (Rust)           │ ────────────────>  │ (Siemens broker endpoint)  │
└──────────────────┘                    └───────────┬────────────────┘
                                                    │ Insights Hub REST
                                                    ▼
                                        ┌────────────────────────────┐
                                        │ Insights Hub Asset / Aspect│
                                        │ Time-series store          │
                                        └────────────────────────────┘
```

Required work (Q3 2026):

1. **Topic mapping.** Our topic tree must be mapped to the MindConnect IoT Extension convention:
   - Our `tenants/{tenant_id}/devices/{device_id}/telemetry` →
     MindConnect `s/us/{client_id}/m/{aspect_id}` (or a customer-specified remap).
2. **Payload shape.** MindConnect expects a specific JSON schema per aspect. The gateway must either emit the MindConnect shape directly or route via a lightweight transform service (preferred architecture: transform inside the gateway, emit once per aspect variable).
3. **Asset / aspect binding.** Each `device_id` → Insights Hub Asset ID; each telemetry metric → Aspect Variable. Binding is provisioned during device onboarding and stored in gateway config.
4. **TLS + device certificate auth.** MindConnect IoT Extension requires mTLS with a Siemens-issued device certificate. The gateway's MQTT layer already supports mTLS (`src/mqtt.rs` module doc, FR1 claim); the PKI issuance workflow is new.
5. **Data ingestion schema.** Define a per-tenant catalogue of aspects and variables aligned with `insights-hub.md`.

---

## Roadmap path B — MindConnect Library embedded (alternative)

MindConnect Library is a native C++ SDK that handles onboarding, certificate rotation, and payload framing internally. Embedding it into a Rust agent requires an FFI wrapper and brings a proprietary dependency.

Status: **NOT PREFERRED** — architectural cost of FFI plus proprietary library coupling outweighs benefits over Path A for our use-case. Would only be selected if a specific customer RFP mandates MindConnect Library directly.

---

## Roadmap path C — MindSphere OpenAPI direct calls

The gateway calls `POST https://gateway.{region}.mindsphere.io/api/iottimeseries/v3/timeseries/{entityId}/{propertySetName}` directly.

Status: **NOT PREFERRED** — per-telemetry REST call has worse throughput and higher latency than the MQTT bridge, and the onboarding dance (OAuth2 + exchange of onboarding JWT for device credentials) is non-trivial. Reserved as a fallback.

---

## Tenant binding and onboarding (roadmap)

MindSphere / Insights Hub ingestion is scoped per tenant. Mapping rules (Q3 2026 target):

| Gateway concept | MindSphere / Insights Hub concept |
|---|---|
| `tenant_id` (our multi-tenant key) | Customer-owned MindSphere tenant |
| `device_id` | Asset with an Asset Type binding |
| Telemetry metric name | Aspect Variable inside an Aspect Type |
| Device serial | Asset `externalId` |

Onboarding workflow (roadmap, not implemented):

1. Operator registers the device in Insights Hub, downloads the onboarding configuration JSON.
2. Operator places it at `/etc/suderra/mindsphere/onboarding.json` on the gateway.
3. Gateway exchanges the one-time JWT for device credentials and a client certificate; credentials stored under `/etc/suderra/mindsphere/credentials/`.
4. Gateway initiates MQTT connection to MindConnect IoT Extension endpoint and begins publishing.

---

## Cross-reference

- Insights Hub semantic layer (asset types, aspect types, variables): `insights-hub.md`
- MQTT topic tree today: `sparkplug-b.md`
- Security architecture for mTLS / PKI: `sens-api-gateway/docs/security/`
- Finding registry: `sens-api-gateway/docs/reviews/orphan-findings.md` — ORPHAN-EDGE-012
