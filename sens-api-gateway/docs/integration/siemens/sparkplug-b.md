# Sparkplug B Compatibility Declaration

**Scope:** Declared compatibility of `sens-api-gateway`'s MQTT surface with the Eclipse Tahu Sparkplug B specification (v3.0.0). Sparkplug B is the de-facto industrial MQTT schema used by Siemens MindConnect, Ignition, HiveMQ Edge and other Siemens-ecosystem tools.

---

## Core declaration

**The gateway is NOT Sparkplug B compliant today.**

Compliance level: **(a) NOT COMPATIBLE** — the topic tree, payload encoding, and birth/death semantics do not follow the Sparkplug B specification.

---

## Siemens version compatibility matrix

| Sparkplug consumer | Can it ingest gateway MQTT today? | Status |
|---|---|---|
| Eclipse Tahu library (Java / Python / C) | NO — payload is JSON, not Sparkplug B protobuf | NOT COMPLIANT |
| HiveMQ Edge (Sparkplug compliant) | NO — topic tree is not `spBv1.0/...` | NOT COMPLIANT |
| Ignition MQTT Engine | NO | NOT COMPLIANT |
| MindConnect IoT Extension | N/A — MindConnect has its own schema (see `mindsphere-connector.md`) | — |
| Siemens Unified Namespace (UNS) deployments that require Sparkplug B | NO | NOT COMPLIANT |

---

## Spec comparison

Side-by-side, Sparkplug B spec vs. gateway today.

### Topic tree

| Concern | Sparkplug B spec | Gateway today |
|---|---|---|
| Namespace prefix | `spBv1.0` | `tenants` |
| Hierarchy | `spBv1.0/{group_id}/{message_type}/{edge_node_id}/{device_id}` | `tenants/{tenant_id}/devices/{device_id}/{status|telemetry|commands|config}` |
| Group concept | `group_id` per edge node cluster | No group — tenant is top-level |
| Edge node vs device | Separate (NBIRTH/DBIRTH) | Single level — no edge-node identity separate from device |
| Evidence | Sparkplug B spec §5 | `src/config.rs:1294-1312` |

The gateway's topic tree is documented in:

```
tenants/{tenant_id}/devices/{device_id}/status
tenants/{tenant_id}/devices/{device_id}/telemetry
tenants/{tenant_id}/devices/{device_id}/commands
tenants/{tenant_id}/devices/{device_id}/config
tenants/{tenant_id}/devices/{device_id}/responses
tenants/{tenant_id}/devices/{device_id}/capabilities
tenants/{tenant_id}/devices/{device_id}/io_data
```

Evidence: `src/config.rs:1293-1315`.

### Payload encoding

| Concern | Sparkplug B spec | Gateway today |
|---|---|---|
| Serialization | Protocol Buffers (Google Protobuf, Sparkplug B `.proto`) | Serde JSON (UTF-8) |
| Schema | Sparkplug B `Payload` message with `metrics[]`, `timestamp`, `seq`, `uuid` | `TelemetryMessage` struct with `device_id`, `device_code`, `timestamp`, `agent_version`, `metrics{}` |
| Per-metric typing | `alias`, `datatype`, `value` (union) | JSON fields typed by Serde |
| Metric aliases | `uint64` alias after birth | Not used (full metric name on every publish) |
| Evidence | Sparkplug B spec §6 | `src/mqtt.rs:91-138` |

### Session semantics

| Concern | Sparkplug B spec | Gateway today |
|---|---|---|
| Birth certificate | `NBIRTH` (Node Birth) + `DBIRTH` (Device Birth) REQUIRED | A `StatusMessage { status: Online }` sent once on connect (`src/mqtt.rs:307`) — not NBIRTH/DBIRTH shape |
| Death certificate | `NDEATH` set as MQTT Last Will | MQTT Last Will IS used (`src/mqtt.rs:260-265`) but payload is not NDEATH — it is our JSON `DeviceStatus::Offline` shape |
| Sequence numbers | Monotonic `seq` per session, wrap on 256 | Not used |
| BDSEQ | Birth-death sequence number match REQUIRED | Not used |
| Rebirth on `NCMD/Node Control/Rebirth` | MUST be honoured | Not implemented |

### Command flow

| Concern | Sparkplug B spec | Gateway today |
|---|---|---|
| Command topic | `spBv1.0/{group_id}/DCMD/{edge_node_id}/{device_id}` | `tenants/{tenant_id}/devices/{device_id}/commands` |
| Command payload | Protobuf metric-write shape | Gateway-defined JSON (command name + args) |
| Command ack | Implicit via metric write confirmation | Explicit via `responses` topic |

---

## Why the gateway does not ship Sparkplug B today

1. **Multi-tenant segregation.** The gateway's first-class concept is `tenant_id` — every topic is rooted at the tenant to enforce broker-ACL isolation between customers. Sparkplug B has no native tenant concept; `group_id` is a flat namespace. Adopting Sparkplug B requires either encoding `tenant_id` into `group_id` (with ACL complications) or adding a tenant-aware Sparkplug broker in front.
2. **JSON is sufficient for the current MQTT consumer chain.** Our backend (`gateway-api` + `sensor-service`) consumes JSON directly; adding Protobuf would require a schema registry and a decode step on every ingestion.
3. **No Siemens customer has flagged Sparkplug B as a blocker yet.** When flagged, the path is known — see "Roadmap if required" below.

---

## Roadmap if required — ORPHAN-EDGE-013

If a Siemens customer RFP flags Sparkplug B as required for Unified Namespace integration:

| Phase | Scope | Estimated effort |
|---|---|---|
| 1 | Dual-emit mode: gateway publishes today's JSON AND a Sparkplug B protobuf parallel stream, rooted at `spBv1.0/{tenant_id_as_group_id}/...`. No change to consumers of the JSON stream. | 4-6 weeks |
| 2 | Full NBIRTH / DBIRTH / NDEATH / DDEATH life cycle with BDSEQ tracking. | 3-4 weeks |
| 3 | Sparkplug B metric aliases to reduce payload overhead. | 1-2 weeks |
| 4 | NCMD rebirth handling and session restart on `Node Control/Rebirth`. | 2 weeks |
| 5 | Integration test against Eclipse Tahu Java client and HiveMQ Edge in a CI soak. | 2 weeks |

Total estimated effort: 12-16 weeks of a single engineer. This is tracked as ORPHAN-EDGE-013; status OPEN, no committed milestone until a customer RFP escalates.

---

## Workaround — MQTT-to-Sparkplug bridge

Customers who need Sparkplug B today can deploy an external bridge (HiveMQ Edge, Node-RED with `node-red-contrib-sparkplug`, or a small Python adapter) that:

1. Subscribes to `tenants/+/devices/+/telemetry` on our MQTT broker.
2. Transforms the JSON payload into Sparkplug B protobuf.
3. Publishes to `spBv1.0/{mapped_group_id}/DDATA/{edge_node_id}/{device_id}` on the customer's broker.

This bridge lives outside the gateway and is not distributed by us. Documenting a reference bridge configuration is a candidate for `docs/integration/siemens/sparkplug-b-bridge-reference.md` — NOT YET WRITTEN.

---

## Cross-reference

- MQTT topic defaults: `src/config.rs:1294-1312`
- Telemetry payload shape: `src/mqtt.rs:91-138`
- Alternative Siemens ingestion: `mindsphere-connector.md`, `insights-hub.md`
- Finding ORPHAN-EDGE-013: `sens-api-gateway/docs/reviews/orphan-findings.md`
