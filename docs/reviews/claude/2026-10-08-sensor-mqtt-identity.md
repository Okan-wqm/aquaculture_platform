# A directly publishing sensor has no broker identity (2026-10-08)

Tracks the implementation of ADR-047 (`docs/adr/047-per-sensor-mqtt-identity.md`),
the operator's decision of 2026-10-06 ("sensör başına kimlik").

## SENSOR-CRITICAL-173 — plain MQTT sensors publish under a shared service account

- The broker admits three service accounts and edge devices. A sensor that
  speaks MQTT itself has no principal of its own.
- Field devices are handed `sensor_service`, the account the ingestion listener
  uses. It reads and writes every tenant's sensor, device, alert and command
  topics; the repo's simulator publishes with it today.
- Plain-sensor topics are free text and resolved by scanning tenants, first
  match wins. Another tenant registering the same or a wildcard topic captures
  the stream.
- The wizard's connection test cannot reach the platform broker (the SSRF
  guard), so such a sensor stays DRAFT.

### Decision and scope

ADR-047, accepted after an edge-expert review (2026-10-06) and three
sensor-expert rounds (2026-10-08). The implementation closes this finding and
includes:

- a principal per standalone or parent sensor, a server-assigned topic and an
  ACL that admits that one topic;
- per-class client-ID bindings and the go-auth auth-cache rule;
- data-driven promotion with one `SensorRegistrationCompleted`, and no
  cloud-initiated test on a platform sensor;
- the tenant-erasure hook for `sensor_mqtt_directory` and for
  `edge_device_directory`, which has the same gap today;
- `mqtt-acl.mosquitto.spec.ts` as a required CI job with production's cache
  settings;
- the legacy-publisher list (the simulator first), with the client IDs kept
  reserved until each publisher moves.

Prerequisite: #1805 (SENSOR-CRITICAL-143), which brings the edge directory
pattern this decision reuses and settles the auth-cache question for the
current broker.

Owner: claude. Deadline: 2026-10-22.
