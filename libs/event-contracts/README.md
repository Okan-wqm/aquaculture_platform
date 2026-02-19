# @platform/event-contracts

Shared event interface library for the aquaculture platform. All services MUST use these interfaces when publishing or consuming events over NATS JetStream.

---

## Mandated Publishing Pattern

All publishers MUST use the **flat-object pattern**. Never wrap business fields in a nested `payload` or `metadata` object.

```typescript
// CORRECT — flat object conforming to BaseEvent
import { createBaseEvent } from '@platform/event-contracts';
import type { TenantCreatedEvent } from '@platform/event-contracts';

const event: TenantCreatedEvent = {
  ...createBaseEvent<TenantCreatedEvent>('TenantCreated', tenant.id),
  name: tenant.name,
  slug: tenant.slug,
};
await this.eventBus.publish(event);

// WRONG — nested payload, breaks consumers
await this.eventBus.publish({
  eventType: 'TenantCreated',
  payload: { tenantId: tenant.id, name: tenant.name }, // ❌ never do this
  timestamp: new Date(),
});
```

Use `createBaseEvent()` to auto-generate `eventId`, `timestamp`, `version: 1`, and `tenantId`. Spread its return, then add the domain-specific fields.

---

## `eventType` Naming Convention

- **PascalCase, no separators**: `TenantCreated`, `SensorReading`, `LeaveRequestSubmitted`
- Must exactly match the interface name minus the `Event` suffix: `TenantCreatedEvent` → `'TenantCreated'`
- Never use dot-separated strings (`tenant.created`) — these break NATS subject routing

---

## NATS Subject Naming

Events are routed by the event bus using the pattern:

```
platform.events.<eventType>
```

Tenant-scoped routing uses `tenantId` at the top level of the event (required by `BaseEvent`).

---

## How to Add a New Event

1. **Choose the correct domain file** (`tenant-events.ts`, `farm-events.ts`, `sensor-events.ts`, `alert-events.ts`, `hr-events.ts`, `billing-events.ts`, `notification-events.ts`).

2. **Define the interface** extending `BaseEvent`:
   ```typescript
   export interface MyNewEvent extends BaseEvent {
     eventType: 'MyNew';    // PascalCase
     myField: string;
     optionalField?: number;
   }
   ```

3. **Add it to the domain union type** at the bottom of the same file:
   ```typescript
   export type FarmEvent = ... | MyNewEvent;
   ```

4. **Add it to `AnyPlatformEvent`** in `index.ts` via the domain union (the domain union re-export handles this automatically).

5. **Publish using the flat pattern** (see above).

6. **Export** — `index.ts` already re-exports everything via `export * from './farm-events'`, so no changes needed there.

---

## Version Bump Policy

`BaseEvent.version` is set to `1` by `createBaseEvent()`.

| Change type | Action |
|-------------|--------|
| Adding optional fields | No version bump needed |
| Renaming a field | Bump `version` to next integer; update all publishers |
| Removing a field | Bump `version` to next integer; update all publishers |
| Changing a field's type | Bump `version` to next integer; update all publishers |

When bumping, update the version constant in the publisher and document it in a comment above the interface.

---

## Dead-Letter / Retry Strategy

`BaseEvent` includes a `retryCount?: number` field. The NATS infrastructure increments this on each re-delivery. Consumers that cannot process an event should:

1. Check `event.retryCount` — if it exceeds the configured limit (e.g. 3), send to the dead-letter subject `platform.dlq.<eventType>`.
2. Publish a compensation event (e.g. `SubscriptionProvisioningFailedEvent`) to notify upstream services of the failure.

Dead-letter subjects follow the pattern: `platform.dlq.<eventType>`.

---

## Domain Files

| File | Events |
|------|--------|
| `base-event.ts` | `BaseEvent`, `PlanTier`, `BillingCycle`, `createBaseEvent()` |
| `tenant-events.ts` | Tenant lifecycle, subscription, module assignment |
| `farm-events.ts` | Batches, mortality, growth, feeding, sites, equipment |
| `sensor-events.ts` | Sensor readings, registration, calibration, discovery |
| `alert-events.ts` | Alert triggered, acknowledged, resolved, escalated |
| `hr-events.ts` | Leave requests, employee, payroll, training |
| `billing-events.ts` | Subscriptions, invoices, payments |
| `notification-events.ts` | User invited, notification sent/delivered/failed |
