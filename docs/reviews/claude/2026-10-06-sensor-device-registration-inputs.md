# Add-device (MQTT) inputs rejected at the GraphQL boundary (2026-10-06)

Operator question: does adding a new MQTT device from `/sensor/devices` work?
A read-only sensor-expert audit traced the wizard end to end; the findings
below were re-verified before being recorded. Not every audit claim is here:
the broker-identity and DRAFT-lifecycle items depend on a design decision and
are listed under "Open, needs a decision".

## SENSOR-HIGH-140 — the wizard sends SensorType values where GraphQL wants names

`registration.types.ts` mirrors the backend `SensorType` with its TypeScript
VALUES (`temperature`, `multi_parameter`). A registered GraphQL enum is
serialized by member NAME, so the wire accepts `TEMPERATURE` only.
`graphql-js getVariableValues` against the emitted sensor SDL: `temperature`
fails coercion ("Value does not exist in SensorType enum"), `TEMPERATURE`
passes. Every child whose type was not copied from the parameter catalog —
hand-added parameters, the MULTI_PARAMETER fallback, type-definition picks —
rejected the whole `registerParentWithChildren` request.

The parity invariant compared member NAMES only and passed; the module's
contract fixture declared the enum with lowercase members, so the contract
spec validated against a schema that does not exist.

Fix: the frontend enum carries the wire names; `sensorTypeFromKey` maps
lowercase domain keys; the parity invariant also requires value = name; the
fixture enum is copied from the emitted SDL; the registration inputs are the
codegen types and `toRegisterChildInput` builds the child explicitly (form-only
keys dropped, `precision` → `decimalPlaces`), with variable-coercion tests.

## SENSOR-HIGH-141 — 92 sensor-service input fields have no validator

The global pipe runs with whitelist + forbidNonWhitelisted, so an input
property with only `@Field` is rejected as "should not exist". Affected:
the wizard child `alertThresholds` / `displaySettings` (nested inputs),
`updateSensorProtocol` / `updateSensorInfo`, `registerEdgeDevice`,
`updateEdgeDevice`, `addIoConfig`, `updateIoConfig`, and six PLC / VFD inputs.
`device-registration-inputs.validation.spec.ts` pushes the UI payloads through
the production pipe: 4 of 4 rejected on main.

Fix: each field gets the validator its type implies. The invariant
`tests/invariants/graphql-input-validators.spec.ts` scans every `@InputType`
in `apps/**`.

## PLAT-HIGH-922 — the same gap in farm, hr and auth (83 fields)

Held by per-file ceilings in the invariant above; they may only shrink. Owner
claude, deadline 2026-10-27.

## Open, needs a decision

- A plain MQTT sensor has no broker identity. The broker admits service
  accounts and edge devices only, and only `sensor_service` may publish under
  `sensors/` — an account that also reaches every tenant's topics. Topics are
  free text and resolved by scanning tenants, first match wins.
- The connection test dials the configured broker through the outbound SSRF
  guard, which rejects RFC-1918 hosts; the platform broker (`aqua-mosquitto`,
  172.20.0.0/16) is one, so the test fails and the device stays DRAFT.
