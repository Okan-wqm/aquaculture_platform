# Package 01: sensor-channel-idor-tenant-scoping

## Metadata
Status: PENDING
Estimated Tokens: 28K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: no
Prerequisites: none
Closing-Findings: [SENSOR-HIGH-001, SENSOR-HIGH-002]
Source-Reviews:
  - docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md

## Context
The ChannelManagementService in sensor-service has zero tenant enforcement on 7 operations (5 mutations + 2 queries). The resolver extracts @Tenant() into _tenantId (underscore = intentionally discarded) but never passes it to service methods. This is a cross-tenant IDOR cluster enabling read/write/delete of another tenant's calibration configuration, alert thresholds, and data channel mappings. Life-safety adjacent: corrupted calibration parameters directly affect water quality readings.

## Findings

**SENSOR-HIGH-001** (sensor-expert, HIGH)
File: apps/sensor-service/src/registration/resolvers/channel.resolver.ts (lines 57-251)
File: apps/sensor-service/src/registration/services/channel-management.service.ts (lines 130-206)
5 resolver methods extract @Tenant() _tenantId but discard it. Service methods getChannel, updateChannel, deleteChannel, reorderChannels, deleteChannelsForSensor have no tenantId parameter. All WHERE clauses query by channelId or sensorId alone -- cross-tenant IDOR on read/write/delete.

**SENSOR-HIGH-002** (sensor-expert, HIGH)
File: apps/sensor-service/src/registration/resolvers/channel.resolver.ts (lines 42-54)
File: apps/sensor-service/src/registration/services/channel-management.service.ts (lines 182-197)
dataChannelsBySensor and enabledChannelsBySensor queries have no @Tenant() extraction at all. Service methods query WHERE { sensorId } only. Any authenticated user knowing a sensorId UUID can enumerate all calibration configuration for another tenant's sensor.

## Affected Files
- apps/sensor-service/src/registration/resolvers/channel.resolver.ts
- apps/sensor-service/src/registration/services/channel-management.service.ts

## Dependencies
None. This is a self-contained tenant isolation fix within sensor-service.

## Atomic Commit Plan
```
security(sensor): enforce tenant scoping on channel management IDOR cluster

7 channel management operations (5 mutations + 2 queries) accept channelId/sensorId
without tenantId verification, enabling cross-tenant read/write/delete of calibration
configuration, alert thresholds, and data channel mappings.

Add tenantId parameter to all ChannelManagementService methods. Pass tenantId from
resolver @Tenant() decorator through to WHERE clauses. Mirrors the already-correct
pattern in bulkUpdateDataChannels.

BREAKING CHANGE: ChannelManagementService method signatures gain required tenantId param.

Plan: docs/plans/2026-04-09-high-fixes/packages/01-sensor-channel-idor-tenant-scoping.md
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#HIGH-S2-001
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#HIGH-S2-002
```

## Test Plan
- Unit test: each of the 7 operations rejects when channelId/sensorId belongs to different tenant
- Unit test: each operation succeeds when channelId/sensorId matches tenant
- Verify bulkUpdateDataChannels pattern is referenced as the correct baseline
- Existing channel.resolver.spec.ts tests must pass with tenantId added

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/registration" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
