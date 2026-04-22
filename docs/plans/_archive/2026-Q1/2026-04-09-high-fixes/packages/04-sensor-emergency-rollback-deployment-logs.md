# Package 04: sensor-emergency-rollback-deployment-logs

## Metadata
Status: IMPLEMENTED
Estimated Tokens: 18K
Priority: HIGH
Security-Sensitive: yes
Parallelizable: yes
Prerequisites: none
Closing-Findings: [SENSOR-HIGH-004]
Source-Reviews:
  - docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md

## Context
Two remaining sensor-service HIGH findings: (1) emergency rollback allows self-approval bypass -- the same user who created a deployment can approve its emergency rollback, violating four-eyes principle; (2) deployment_logs uses raw SQL with no tenant scoping via search_path, and token partial disclosure in error responses leaks credential fragments. These are grouped because both affect the deployment/rollback subsystem.

## Findings

**SENSOR-HIGH-004** (sensor-expert, HIGH)
Note: This finding ID maps to the user-provided list items: emergency rollback self-approval bypass, deployment_logs raw SQL no tenant, legacy sensors/# wildcard, token partial disclosure. These are grouped as a single sensor deployment safety package.

Files:
- apps/sensor-service/src/automation/services/automation.service.ts (emergency rollback)
- apps/sensor-service/src/edge-device/edge-device.service.ts (deployment_logs SQL, token disclosure)
- apps/sensor-service/src/ingestion/mqtt-listener.service.ts (sensors/# wildcard)

Emergency rollback self-approval: the approveRollback() method does not check that approver !== initiator. deployment_logs: raw SQL queries without tenant schema scoping. Token partial disclosure: error messages include truncated token values. Legacy sensors/# MQTT wildcard: subscribes to all sensor topics without tenant prefix.

## Affected Files
- apps/sensor-service/src/automation/services/automation.service.ts
- apps/sensor-service/src/edge-device/edge-device.service.ts
- apps/sensor-service/src/ingestion/mqtt-listener.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
security(sensor): fix emergency rollback self-approval, deployment SQL tenant scoping, token disclosure

Emergency rollback allows self-approval (same user as initiator), violating
four-eyes principle for safety-critical PLC deployments. deployment_logs uses
raw SQL without tenant search_path isolation. Error responses include partial
token values. sensors/# wildcard subscribes to all tenants' MQTT topics.

Add approver !== initiator check, scope deployment_logs queries via
search_path, redact token values in error responses, scope MQTT wildcard
to tenant prefix.

Plan: docs/plans/2026-04-09-high-fixes/packages/04-sensor-emergency-rollback-deployment-logs.md
Closes: docs/reviews/sensor-expert/2026-04-05-s2-high-findings-audit.md#HIGH-S2-004
```

## Test Plan
- Unit test: rollback approval rejected when approver === initiator
- Unit test: deployment_logs query includes tenant schema in search_path
- Unit test: error response does not contain token fragments
- Unit test: MQTT subscription uses tenant-scoped topic pattern

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src/(automation|edge-device|ingestion)" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
