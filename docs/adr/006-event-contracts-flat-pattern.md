# ADR-006: Event Contracts — Mandated Flat Object Pattern

**Date:** 2026-02-19
**Status:** Accepted
**Deciders:** Platform Team

---

## Context

The platform had two incompatible event publishing patterns coexisting across services:

**Pattern A (flat, conforming to `BaseEvent`):**
```typescript
const event: TenantCreatedEvent = {
  eventId: crypto.randomUUID(),
  eventType: 'TenantCreated',
  timestamp: new Date(),
  tenantId: tenant.id,
  name: tenant.name,
  version: 1,
};
await this.eventBus.publish(event);
```

**Pattern B (nested payload — non-conforming):**
```typescript
this.eventBus.publish({
  eventType: 'TenantCreated',
  payload: { tenantId: ..., name: ... },
  timestamp: new Date(),
});
```

Pattern B broke consumers expecting `event.tenantId` at the top level, and was incompatible with the `BaseEvent` interface. NATS subject routing by `tenantId` was broken for all Pattern B publishers.

Additionally, `createBaseEvent()` factory was dead code — no publisher used it — meaning `eventId`, `version`, and `timestamp` were duplicated at every call site.

---

## Decision

**All publishers MUST use Pattern A** (flat object conforming to `BaseEvent`).

1. Business fields are placed directly at the top level — never under `payload` or `metadata`
2. `createBaseEvent<T>(eventType, tenantId)` factory is used to auto-generate `eventId`, `timestamp`, `version: 1`
3. `eventType` strings are PascalCase matching the interface name (e.g. `'TenantCreated'`)
4. `tenantId` MUST be at the top level for NATS routing
5. `version: number` is required (not optional) — enables schema evolution detection

---

## Consequences

**Positive:**
- Consumers can reliably read `event.tenantId`, `event.sensorId`, etc. at top level
- TypeScript type-checks enforce conformance at compile time
- `eventId` UUID generation centralized in factory — not duplicated at 15+ call sites
- `version` field now consistently set, enabling future schema evolution

**Negative:**
- All Pattern B publishers required migration (7 publisher sites updated)

---

## Migration Applied

Publishers updated from Pattern B to Pattern A:
- `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts`
- `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts` (3 events)
- `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts`
- `apps/alert-engine/src/alert/services/alert-evaluation.service.ts`
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts`
- `apps/farm-service/src/farm/handlers/create-farm.handler.ts`
- `apps/hr-service/src/leave/events/leave.events.ts` (factory functions)

---

## Reference

See `libs/event-contracts/README.md` for the full publishing guide and naming conventions.
