# Package 35: sensor-pagination-installer-fix

## Metadata
Status: PENDING
Estimated Tokens: 10K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Sprint: 2

## Closing-Findings
Closing-Findings: [sensor-expert/HIGH-001, sensor-expert/HIGH-002]

## Source-Reviews
- /var/aqua-saas/docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md
- /var/aqua-saas/docs/reviews/context-manager/2026-04-10-full-repo-audit.md

## Context
Two sensor-service defects: (1) `sensorRawList` computes `skip` from unbounded `page`/`limit` before clamping, enabling tenant-level query DoS via large OFFSET; (2) the installer script hardcodes `mqtt.tls.enabled: true` even when provisioning resolves to plain MQTT, breaking device activation on fallback deployments.

## Findings
`HIGH-001` (sensor-expert): `sensorRawList` computes `skip` from unbounded `page`/`limit` before clamping. File: `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts:111-132`. `skip` is calculated as `(page - 1) * limit` before any validation.

`HIGH-002` (sensor-expert): Installer script hardcodes `mqtt.tls.enabled: true` even when provisioning resolves to plain MQTT. File: `apps/sensor-service/src/edge-device/installer-script.service.ts:40-49,201-214,300-308`.

## Affected Files
- /var/aqua-saas/apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts
- /var/aqua-saas/apps/sensor-service/src/edge-device/installer-script.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(sensor): clamp pagination before computing skip, emit correct TLS config

sensorRawList computed skip from unbounded page/limit before clamping,
enabling DoS via large OFFSET. The installer script hardcoded
mqtt.tls.enabled: true regardless of the resolved broker mode. This
clamps both page and limit before computing skip (or replaces with
cursor-based pagination), and emits mqtt.tls.enabled from the resolved
mqttTlsEnabled value with port/TLS consistency validation.

Plan: docs/plans/2026-04-10-v2-audit-fixes/packages/35-sensor-pagination-installer-fix.md
Closes: docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md#HIGH-001
Closes: docs/reviews/sensor-expert/2026-04-10-full-repo-audit.md#HIGH-002
```

## Test Plan
- Unit test: page and limit are clamped before skip computation.
- Unit test: very large page value does not produce unbounded OFFSET.
- Unit test: installer emits `mqtt.tls.enabled: false` when mqttTlsEnabled is false.
- Unit test: port/TLS mismatch (1883 + TLS true) fails validation.
- Negative test: unclamped skip computation is not possible.

## Verification Command
`npx tsc --noEmit -p apps/sensor-service/tsconfig.json && npx jest --testPathPattern="apps/sensor-service/src" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes

