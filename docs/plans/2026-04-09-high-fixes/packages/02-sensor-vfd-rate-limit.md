# Package 02: sensor-vfd-rate-limit

## Metadata
Status: PENDING
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [SENSOR-HIGH-003]
Source-Reviews:
  - docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md

## Context
All 7 VFD command mutations (sendVfdCommand, startVfd, stopVfd, setVfdFrequency, setVfdSpeed, resetVfdFault, emergencyStopVfd) have no rate limiting. SimpleRateLimitGuard is REST-only (switchToHttp). Rapid START/STOP cycling risks VFD capacitor damage and equipment stress. emergencyStop has no @Roles restriction and is unlimited, enabling operational DoS against aeration/recirculation systems.

## Findings

**SENSOR-HIGH-003** (sensor-expert, HIGH)
File: apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts (lines 44-146)
File: apps/sensor-service/src/vfd/services/vfd-command.service.ts (lines 64-159)
No rate limiting on any VFD command mutation. SimpleRateLimitGuard only works on REST (switchToHttp fails for GraphQL context). emergencyStop is callable unlimited times by any authenticated user. Rapid cycling risks equipment damage per IEC 62443 SL-2.

## Affected Files
- apps/sensor-service/src/vfd/resolvers/vfd-command.resolver.ts
- apps/sensor-service/src/vfd/services/vfd-command.service.ts
- apps/sensor-service/src/app.module.ts (ThrottlerModule registration)

## Dependencies
None.

## Atomic Commit Plan
```
security(sensor): add GraphQL-aware rate limiting to VFD command mutations

VFD command mutations have no rate limiting because SimpleRateLimitGuard uses
switchToHttp() which fails silently for GraphQL contexts. Rapid START/STOP
cycling risks VFD capacitor damage and operational DoS via unlimited
emergencyStop calls.

Register ThrottlerModule.forRoot() with GqlExecutionContext support. Apply
@Throttle per-mutation limits (5 writes/10s for normal commands, 10/min for
emergencyStop). Add per-device command cooldown (200ms minimum inter-command
gap) in VfdCommandService.

Plan: docs/plans/2026-04-09-high-fixes/packages/02-sensor-vfd-rate-limit.md
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#HIGH-S2-003
```

## Test Plan
- Unit test: 6th command within 10s window is rejected with 429
- Unit test: emergencyStop allows 10/min but rejects 11th
- Unit test: per-device cooldown rejects commands within 200ms
- Integration test: GraphQL mutation receives throttle error correctly

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/vfd" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
