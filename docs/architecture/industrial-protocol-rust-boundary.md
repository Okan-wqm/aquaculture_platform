# Industrial Protocol Rust Boundary

The Rust protocol boundary is explicit, but this branch does not claim every industrial parser is already hot-path Rust.

## Current State

- `crates/protocol-codec` owns the Rust Modbus codec surface: TCP MBAP, RTU CRC, ASCII LRC, selected PDU decoders, golden fixtures, and fuzz harnesses.
- `apps/sensor-ingestion` consumes normalized MQTT JSON readings, not raw Modbus/OPC UA/S7 frames.
- Existing Node industrial adapters remain the runtime source for OPC UA/S7 and any protocol path not yet represented by `protocol-codec`.

## SSOT Rule

New or migrated industrial binary parsing must land in `crates/protocol-codec` first. Service code may adapt transport/session concerns, but frame parsing and validation logic belongs in Rust.

## Boundary Contract

- Rust codec returns typed decoded values or structured parse errors.
- Service boundary converts decoded values into the canonical sensor payload shape.
- Ingestion accepts only the canonical payload shape after tenant/topic/device binding checks.
- No service may add a parallel hand-rolled parser for Modbus/OPC UA/S7 once the relevant Rust codec exists.

## Adoption Gate

Before routing an industrial protocol through Rust ingestion, the protocol must have:

- golden fixtures for valid and invalid frames;
- fuzz target for panic-free parsing;
- transport/session threat model;
- service boundary test proving the Node adapter is no longer parsing that protocol's binary frames.
