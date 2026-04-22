# Package 07: edge-modbus-write-whitelist

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [EDGE-HIGH-003]
Source-Reviews:
  - docs/reviews/edge-expert/2026-04-05-s2-high-findings.md

## Context
Modbus write operations (write_register, write_coil) validate only a binary allow_writes flag and function code whitelist. No per-device register address whitelist exists. An authenticated cloud operator or compromised credential can write to arbitrary register addresses including pump relays, feed dispensers, aerator outputs, and chemical dosing actuators. IEC 62443 requires register-granularity access control for physical actuator writes.

## Findings

**EDGE-HIGH-003** (edge-expert, HIGH)
File: sens-api-gateway/src/modbus.rs (lines 977-1039)
File: sens-api-gateway/src/config.rs (lines 953-993)
write_register(address, value) and write_coil(address, value) have no address whitelist. ModbusSecurityConfig has allowed_function_codes and max_register_count but no allowed_write_addresses range list. Writes can target undeclared registers outside the device model. IEC 62443 FR-2/FR-3.

## Affected Files
- sens-api-gateway/src/modbus.rs
- sens-api-gateway/src/config.rs

## Dependencies
None. Rust edge agent is standalone.

## Atomic Commit Plan
```
security(edge): add per-device Modbus write address whitelist

Modbus write operations validate only a binary allow_writes flag with no
per-register address access control. Any authenticated cloud command can
target arbitrary register addresses including safety-critical actuators
(pumps, aerators, chemical dosing). Violates IEC 62443 FR-2/FR-3.

Add ModbusWriteRange to ModbusSecurityConfig, implement validate_write_address()
in ModbusClient, call from both write_register() and write_coil(). Block all
writes when allowed_write_registers is None and allow_writes is true (fail-closed).

Plan: docs/plans/2026-04-09-high-fixes/packages/07-edge-modbus-write-whitelist.md
Closes: docs/reviews/edge-expert/2026-04-05-s2-high-findings.md#H-03
```

## Test Plan
- Unit test: write to address within whitelist range succeeds
- Unit test: write to address outside whitelist range is rejected
- Unit test: write with no whitelist configured but allow_writes=true is rejected
- Unit test: config validation errors when allow_writes=true and no ranges defined
- Unit test: write_coil also validates address range

## Verification Command
`cd sens-api-gateway && cargo test --lib modbus:: && cargo clippy -- -D warnings`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
