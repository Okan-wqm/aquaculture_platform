# Package 18: sensor-service-as-any

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: MEDIUM
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none

## Context
sensor-service has 29 `as any` casts and 54 `as unknown as` casts in production code. This is the highest `as unknown as` concentration in the codebase. Many are in protocol adapter code (industrial adapters: OPC-UA, Profinet, Modbus, S7; IoT adapters: AMQP, DDS, CoAP, MQTT, WebSocket, HTTP-REST) where hardware interface types are coerced. CLAUDE.md forbids both patterns.

## Findings

**MEDIUM-004 [security-reviewer] (sensor-service subset): 29 `as any` casts in sensor-service production code**
- 11 files affected across protocol adapters, VFD, automation, sensor-type, process, edge-device domains

**MEDIUM-016 [multi-tenant-saas-expert] (sensor-service subset): 54 `as unknown as` casts in sensor-service**
- 20+ files affected, heavily concentrated in protocol adapters and VFD services
- Protocol adapters cast hardware interface responses to typed DTOs

Closing-Findings: [MEDIUM-004-sensor, MEDIUM-016-sensor]
Source-Reviews:
- docs/reviews/orchestrator/2026-04-09-full-platform-audit.md
- docs/reviews/context-manager/2026-04-09-tier1-compaction.md

## Affected Files (as any — production code only)
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/vfd/resolvers/vfd-device.resolver.ts`
- `/var/aqua-saas/apps/sensor-service/src/automation/compiler/services/st-intellisense.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/automation/compiler/analyzer/semantic-analyzer.ts`
- `/var/aqua-saas/apps/sensor-service/src/automation/compiler/analyzer/type-checker.ts`
- `/var/aqua-saas/apps/sensor-service/src/automation/automation.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/sensor-type/sensor-type.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/process/services/scada-package.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/process/services/unified-tag.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/edge-device/edge-device.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/edge-device/provisioning.service.ts`

## Affected Files (as unknown as — production code only, top 20)
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/profinet.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/types/siemens-s7.types.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/types/opcua.types.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/types/modbus-serial.types.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/modbus-tcp.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/industrial/siemens-s7.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/amqp.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/dds.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/coap.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/mqtt.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/websocket.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/iot/http-rest.adapter.ts`
- `/var/aqua-saas/apps/sensor-service/src/plc-control/services/feeding-parameter.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/plc-control/services/plc-connection.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/sensor/services/calibration.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/vfd/services/vfd-data-reader.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/vfd/services/vfd-connection-tester.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/vfd/services/vfd-command.service.ts`
- `/var/aqua-saas/apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts`

## Dependencies
None. Type fixes are internal to sensor-service.

Note: 83 total casts across 25+ files. This is the largest type-safety package. Executor should process by domain (protocol/industrial, protocol/iot, vfd, automation, plc-control, sensor, process, edge-device). Each domain cluster is manageable in a single pass. If session runs long, split at domain boundary and create sub-packages 18a/18b.

## Atomic Commit Plan
```
refactor(sensor): remove 29 as any and 54 as unknown as casts

Replace all type-unsafe casts with proper type definitions. Heavy
concentration in protocol adapters where hardware interface responses
(OPC-UA, Modbus, S7, MQTT, etc.) are coerced to typed DTOs.

Approach for protocol adapters: Define explicit response interfaces
matching the hardware SDK types. Use generics on adapter base class.
For VFD/automation: Fix resolver and service return types.

Plan: docs/plans/2026-04-09-full-remediation/packages/18-sensor-service-as-any.md

Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-004
Closes: docs/reviews/orchestrator/2026-04-09-full-platform-audit.md#MEDIUM-016
```

## Test Plan
- Verify compilation: `npx tsc --noEmit -p apps/sensor-service/tsconfig.json`
- Run sensor-service tests: `npx jest --testPathPattern="apps/sensor-service" --coverage=false`
- Grep to confirm zero `as any` and zero `as unknown as` in sensor-service production code

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
