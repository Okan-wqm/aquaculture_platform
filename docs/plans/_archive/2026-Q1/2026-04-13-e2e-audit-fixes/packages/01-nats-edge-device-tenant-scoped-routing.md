# Package 01: nats-edge-device-tenant-scoped-routing

## Metadata
Status: PENDING
Estimated Tokens: ~12K
Priority: CRITICAL
Security-Sensitive: yes
Parallelizable: yes (with 02, 03)
Prerequisites: none

## Source Reviews
- docs/test-audits/tenant-isolation-auditor/2026-04-11-full-platform-e2e.md
- docs/test-audits/context-manager/2026-04-11-full-platform-e2e.md

## Closing Findings
Closing-Findings: [tenant-isolation-auditor/CRITICAL-001]

## Context

**IMPORTANT (verified by senior engineer — planner missed this):**

The `NatsEventBus.deriveSubject()` at `platform/libs/event-bus/src/nats/nats-event-bus.ts:341-344` already produces tenant-scoped NATS subjects:
```typescript
private deriveSubject(event: IEvent): string {
    const segment = event.tenantId ?? 'system';
    return `events.${segment}.${event.eventType}`;
}
```

So sensor-service publishes `EdgeDeviceIoData` to subject `events.{tenantId}.EdgeDeviceIoData` (confirmed at `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1028-1032` via `this.eventBus.publish()`). However, the gateway subscribes to `events.EdgeDeviceIoData` (no tenant segment) at line 193. **These subjects do NOT match in NATS.** This means either:
1. The realtime edge-device WebSocket feature is completely non-functional (most likely), OR
2. There is a separate legacy publish path that bypasses NatsEventBus (not found in codebase search)

The comment at `nats-bridge.service.ts:192` ("sensor-service publishes to subject: events.EdgeDeviceIoData (no trailing tokens)") is **stale** — it was written before `deriveSubject()` was introduced.

**The fix must:**
1. Change the gateway subscription to the tenant-scoped wildcard: `events.*.EdgeDeviceIoData` and `events.*.EdgeDeviceAlarm`
2. Extract `tenantId` from the NATS **subject** (authoritative), not from the message body (untrusted)
3. Cross-validate: subject-derived tenantId must match payload tenantId; drop event and log SECURITY warning on mismatch

This approach eliminates the tenant-isolation vulnerability AND fixes the likely-broken subscription at the same time.

## Findings
tenant-isolation-auditor CRITICAL-001: Realtime edge-device fan-out trusts payload tenantId instead of tenant-scoped routing key.
- File: `apps/gateway-api/src/websocket/nats-bridge.service.ts` lines 189-243
- The NATS subjects `events.EdgeDeviceIoData` and `events.EdgeDeviceAlarm` are subscribed without tenant segment. The handler extracts `tenantId` from the message body and broadcasts to Socket.IO rooms using that untrusted value. Additionally, the subscription subject is stale and likely does not match the publisher's tenant-scoped subject.
- Severity: CRITICAL
- Gap class: tenant-gap, access-gap, sync-gap

## Affected Files
- apps/gateway-api/src/websocket/nats-bridge.service.ts (primary — modify subscribeToEdgeIoEvents and subscribeToEdgeAlarmEvents: change subjects, extract tenantId from subject)
- apps/gateway-api/src/websocket/sensor-readings.gateway.ts (read-only reference — broadcast methods already use tenantId in room naming)
- apps/sensor-service/src/ingestion/mqtt-listener.service.ts (read-only reference — verify publish uses eventBus.publish() → deriveSubject() path)
- platform/libs/event-bus/src/nats/nats-event-bus.ts (read-only reference — confirm deriveSubject() returns `events.{tenantId}.{eventType}`)

## Dependencies
Prerequisites: none
This package touches only the gateway-api service. No shared lib changes. The sensor-service publisher is NOT modified — it already publishes to the correct tenant-scoped subject.

## Atomic Commit Plan
```
security(gateway): subscribe to tenant-scoped NATS subjects for edge device events

The NATS bridge subscribes to `events.EdgeDeviceIoData` but sensor-service
publishes to `events.{tenantId}.EdgeDeviceIoData` via NatsEventBus.deriveSubject().
The subscription subject is stale and the events likely never reach the gateway.

Fix:
1. Change subscriptions to wildcard: `events.*.EdgeDeviceIoData` and
   `events.*.EdgeDeviceAlarm`
2. Extract tenantId from the NATS subject (authoritative) instead of
   the message body (untrusted): `msg.subject.split('.')[1]`
3. Cross-validate subject tenantId against payload tenantId; drop and
   log SECURITY warning on mismatch

This fixes both the tenant-isolation vulnerability AND the broken
subscription in one atomic change.

Addresses: tenant-isolation-auditor/CRITICAL-001

Plan: docs/plans/2026-04-13-e2e-audit-fixes/packages/01-nats-edge-device-tenant-scoped-routing.md
Closes: docs/test-audits/tenant-isolation-auditor/2026-04-11-full-platform-e2e.md#CRITICAL-001
```

## Test Plan
- Unit test: publish to `events.tenant-abc.EdgeDeviceIoData`, verify subscription receives it and extracts tenantId=`tenant-abc` from subject
- Unit test: publish with subject tenantId=A but payload tenantId=B — assert event is DROPPED with security warning logged
- Unit test: publish with matching subject and payload tenantId — assert broadcast IS called with correct tenantId
- Unit test: publish to `events.EdgeDeviceIoData` (old subject, no tenant segment) — assert subscription does NOT receive it (regression guard for old format)
- Verify existing SensorReadingEvent path is not affected (it uses a different subscription path)

## Verification Command
`npx tsc --noEmit -p apps/gateway-api/tsconfig.json && npx jest --testPathPattern="apps/gateway-api/src/websocket" --coverage=false`
[Dispatch: security-reviewer]

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
