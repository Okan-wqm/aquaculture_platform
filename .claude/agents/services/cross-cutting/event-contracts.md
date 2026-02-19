---
name: event-contracts
description: Knowledge base for libs/event-contracts - all NATS event definitions, BaseEvent interface, and domain event categories used across all platform services
---

# Event-Contracts Knowledge Base

## Overview

`libs/event-contracts` defines all event interfaces and contracts used for inter-service communication via NATS JetStream. It is a TypeScript-only library (no runtime code beyond `createBaseEvent`). All backend services that publish or subscribe to events import from this library.

## Directory Structure

```
libs/event-contracts/src/
  base-event.ts           # BaseEvent interface + createBaseEvent() factory
  tenant-events.ts        # Tenant lifecycle + subscription + module events
  farm-events.ts          # Farm, batch, pond, equipment, feeding, harvest events
  sensor-events.ts        # Sensor CRUD, readings, discovery, calibration events
  alert-events.ts         # Alert triggered, acknowledged, resolved, escalated events
  hr-events.ts            # HR employee, leave, attendance events
  billing-events.ts       # Subscription, invoice, payment events
  notification-events.ts  # (implied by index.ts re-export)
  index.ts                # Barrel re-export of all events
  README.md
```

## Key Files & Configurations

### BaseEvent Interface (base-event.ts)

All domain events MUST extend `BaseEvent`:

```typescript
export interface BaseEvent {
  eventId: string;          // UUID, auto-generated
  eventType: string;        // Event name (matches interface name, e.g., 'FarmCreated')
  timestamp: Date;          // When event occurred
  tenantId: string;         // Multi-tenant isolation
  correlationId?: string;   // Distributed tracing correlation
  causationId?: string;     // ID of the event that caused this one
  userId?: string;          // Who triggered it
  version?: number;         // Schema version (default: 1)
}

// Factory function
export function createBaseEvent(
  eventType: string,
  tenantId: string,
  overrides?: Partial<BaseEvent>,
): BaseEvent {
  return {
    eventId: crypto.randomUUID(),
    eventType,
    timestamp: new Date(),
    tenantId,
    version: 1,
    ...overrides,
  };
}
```

### Tenant Events (tenant-events.ts)

| Event Interface | eventType | Key Fields |
|----------------|-----------|------------|
| `TenantCreatedEvent` | `TenantCreated` | `name`, `slug`, `plan`, `status` |
| `TenantUpdatedEvent` | `TenantUpdated` | `name?`, `plan?`, `status?`, `maxUsers?` |
| `TenantStatusChangedEvent` | `TenantStatusChanged` | `previousStatus`, `newStatus`, `reason?` |
| `TenantDeactivatedEvent` | `TenantDeactivated` | `reason?` |
| `TenantSubscriptionChangedEvent` | `TenantSubscriptionChanged` | `previousPlan`, `newPlan`, `effectiveDate` |
| `TenantModuleAssignedEvent` | `TenantModuleAssigned` | `moduleCodes[]` |
| `TenantSubscriptionRequestedEvent` | `TenantSubscriptionRequested` | `tenantName`, `moduleIds[]`, `moduleQuantities?`, `trialDays?`, `tier`, `billingCycle`, `billingEmail?`, `createdBy` |
| `TenantModulesAssignedEvent` | `TenantModulesAssigned` | `moduleIds[]`, `pricing?`, `assignedBy` |
| `ModuleRemovedFromTenantEvent` | `ModuleRemovedFromTenant` | `moduleId`, `removedBy` |

**Key flow**: `admin-api-service` publishes `TenantSubscriptionRequestedEvent` after tenant creation. `billing-service` subscribes and creates the subscription.

### Farm Events (farm-events.ts)

**Farm/Site/Department/System/Equipment CRUD**:

| Event | eventType | Key Fields |
|-------|-----------|------------|
| `FarmCreatedEvent` | `FarmCreated` | `farmId`, `name`, `location: {lat, lng}` |
| `FarmUpdatedEvent` | `FarmUpdated` | `farmId`, `name?`, `location?`, `isActive?` |
| `SiteCreatedEvent` | `SiteCreated` | `siteId`, `name`, `code`, `country`, `region?`, `status` |
| `SiteUpdatedEvent` | `SiteUpdated` | `siteId`, `changes: Record<string, unknown>` |
| `SiteDeletedEvent` | `SiteDeleted` | `siteId`, `name`, `code`, `deletedAt` |
| `DepartmentCreatedEvent` | `DepartmentCreated` | `departmentId`, `siteId`, `name`, `code`, `type` |
| `DepartmentUpdatedEvent` | `DepartmentUpdated` | `departmentId`, `siteId`, `changes` |
| `DepartmentDeletedEvent` | `DepartmentDeleted` | `departmentId`, `siteId`, `name`, `code`, `deletedAt` |
| `SystemCreatedEvent` | `SystemCreated` | `systemId`, `siteId`, `departmentId?`, `name`, `code`, `type`, `status` |
| `SystemUpdatedEvent` | `SystemUpdated` | `systemId`, `siteId`, `changes` |
| `SystemDeletedEvent` | `SystemDeleted` | `systemId`, `siteId`, `name`, `code`, `deletedAt` |
| `EquipmentCreatedEvent` | `EquipmentCreated` | `equipmentId`, `siteId`, `systemId?`, `name`, `code`, `typeId`, `category`, `status` |
| `EquipmentUpdatedEvent` | `EquipmentUpdated` | `equipmentId`, `siteId`, `changes` |
| `EquipmentDeletedEvent` | `EquipmentDeleted` | `equipmentId`, `siteId`, `name`, `code`, `deletedAt` |

**Batch lifecycle**:

| Event | eventType | Key Fields |
|-------|-----------|------------|
| `PondCreatedEvent` | `PondCreated` | `pondId`, `farmId`, `name`, `capacity`, `waterType: 'freshwater'\|'saltwater'\|'brackish'` |
| `BatchCreatedEvent` | `BatchCreated` | `batchId`, `farmId`, `pondId`, `name`, `species`, `quantity`, `stockedAt` |
| `BatchHarvestedEvent` | `BatchHarvested` | `batchId`, `harvestedQuantity`, `harvestedAt`, `averageWeight?`, `totalWeight?` |
| `BatchStatusChangedEvent` | `BatchStatusChanged` | `batchId`, `previousStatus`, `newStatus`, `reason?` |
| `BatchTransferredEvent` | `BatchTransferred` | `batchId`, `sourceTankId`, `destinationTankId`, `quantity`, `biomassKg`, `transferDate` |
| `BatchAllocatedToTankEvent` | `BatchAllocatedToTank` | `batchId`, `tankId`, `quantity`, `biomassKg`, `allocationType: 'initial'\|'transfer_in'\|'split'` |
| `BatchClosedEvent` | `BatchClosed` | `batchId`, `closeReason`, `finalQuantity`, `finalBiomassKg`, `finalFCR`, `totalMortality`, `mortalityRate`, `daysInProduction` |
| `MortalityRecordedEvent` | `MortalityRecorded` | `batchId`, `tankId?`, `quantity`, `reason`, `newTotalMortality`, `newMortalityRate` |
| `GrowthSampleRecordedEvent` | `GrowthSampleRecorded` | `batchId`, `sampleSize`, `averageWeightG`, `weightCV`, `performance?` |

**Operational alerts**:

| Event | eventType | Key Fields |
|-------|-----------|------------|
| `FeedingRecordedEvent` | `FeedingRecorded` | `batchId`, `tankId?`, `feedId`, `plannedAmountKg`, `actualAmountKg`, `variance` |
| `TankDensityAlertEvent` | `TankDensityAlert` | `tankId`, `currentDensityKgM3`, `maxDensityKgM3`, `alertLevel: 'warning'\|'critical'` |
| `FCRAlertEvent` | `FCRAlert` | `batchId`, `currentFCR`, `targetFCR`, `variancePercent`, `trend`, `alertLevel` |
| `FeedInventoryLowEvent` | `FeedInventoryLow` | `inventoryId`, `feedId`, `siteId`, `currentQuantityKg`, `reorderPointKg`, `status: 'low_stock'\|'critical'` |

### Sensor Events (sensor-events.ts)

```typescript
// Union type
export type SensorEvent =
  | SensorReadingEvent        // 'SensorReading'
  | SensorRegisteredEvent     // 'SensorRegistered'
  | SensorCalibratedEvent     // 'SensorCalibrated'
  | SensorOfflineEvent        // 'SensorOffline'
  | SensorOnlineEvent         // 'SensorOnline'
  | SensorConnectionTestedEvent  // 'SensorConnectionTested'
  | SensorProtocolChangedEvent   // 'SensorProtocolChanged'
  | SensorRegistrationStartedEvent   // 'SensorRegistrationStarted'
  | SensorRegistrationCompletedEvent // 'SensorRegistrationCompleted'
  | SensorConfigurationUpdatedEvent  // 'SensorConfigurationUpdated'
  | SensorSuspendedEvent     // 'SensorSuspended'
  | SensorReactivatedEvent   // 'SensorReactivated'
  | SensorDiscoveryStartedEvent   // 'SensorDiscoveryStarted'
  | SensorDiscoveryCompletedEvent // 'SensorDiscoveryCompleted'
```

`SensorReadingEvent` payload:
```typescript
readings: {
  temperature?: number;
  ph?: number;
  dissolvedOxygen?: number;
  salinity?: number;
  ammonia?: number;
  nitrite?: number;
  nitrate?: number;
  turbidity?: number;
  [key: string]: number | undefined;  // Extensible for custom sensor types
}
```

`SensorDiscoveryCompletedEvent`:
```typescript
discoveredDevices: Array<{ address: string; name?: string; manufacturer?: string; model?: string }>
```

### Alert Events (alert-events.ts)

| Event | eventType | Key Fields |
|-------|-----------|------------|
| `AlertTriggeredEvent` | `AlertTriggered` | `alertId`, `ruleId`, `ruleName`, `severity: 'info'\|'warning'\|'critical'`, `message`, `channels[]`, `recipients[]`, `triggeringData` |
| `AlertAcknowledgedEvent` | `AlertAcknowledged` | `alertId`, `acknowledgedBy`, `acknowledgedAt`, `notes?` |
| `AlertResolvedEvent` | `AlertResolved` | `alertId`, `resolvedBy?`, `resolvedAt`, `resolution?`, `autoResolved: boolean` |
| `AlertEscalatedEvent` | `AlertEscalated` | `alertId`, `escalationLevel`, `escalatedTo[]`, `reason` |
| `AlertRuleCreatedEvent` | `AlertRuleCreated` | `ruleId`, `name`, `conditions[]`, `notificationChannels[]` |
| `AlertRuleUpdatedEvent` | `AlertRuleUpdated` | `ruleId`, `changes: Record<string, unknown>` |

### HR Events (hr-events.ts)

Employee, leave request, attendance events (exact fields follow same pattern as other modules).

### Billing Events (billing-events.ts)

Subscription lifecycle, invoice, payment events.

## NATS Subject Naming Convention

Based on eventType, NATS subjects follow: `{domain}.{eventType}` pattern. Examples:
- `farm.BatchCreated`
- `sensor.SensorReading`
- `tenant.TenantCreated`
- `alert.AlertTriggered`

## Dependencies / Integrations

- **All backend services** import event interfaces from `@app/event-contracts`
- **NATS JetStream**: Events published as persistent messages; services subscribe with durable consumers
- **admin-api-service → billing-service**: `TenantSubscriptionRequestedEvent` cross-service workflow
- **sensor-service → alert-engine**: `SensorReadingEvent` triggers alert rule evaluation
- **farm-service → notification-service**: `TankDensityAlertEvent`, `FCRAlertEvent` trigger notifications
- **alert-engine → notification-service**: `AlertTriggeredEvent` triggers email/push notifications

## Known Gotchas

1. **`eventType` must exactly match the interface name** - The `eventType` string must be the exact interface name (e.g., `'BatchCreated'`, not `'batch_created'`). Services routing events use this string for matching.

2. **`tenantId` is required on every event** - All inter-service events must include `tenantId` for multi-tenant isolation. The alert-engine and notification-service use `tenantId` to look up tenant-specific config.

3. **`version?: number` for schema evolution** - When adding fields to an event, increment `version` to help subscribers detect schema changes. Existing events without `version` default to `version: 1`.

4. **`causationId` for event chains** - Set `causationId` to the `eventId` of the triggering event when publishing a downstream event. This enables full event chain tracing.

5. **Interface-only, no classes** - All event types are TypeScript interfaces. There are no class constructors or validators. Validation must be done by the publisher before emitting.

6. **`SensorReadingEvent.readings` is extensible** - The `[key: string]: number | undefined` index signature allows custom sensor parameters beyond the standard ones. Services should handle unknown keys gracefully.

7. **`TenantSubscriptionRequestedEvent` links provisioning to billing** - This is the async handoff between admin-api-service and billing-service. If billing-service doesn't consume this event (e.g., NATS down), the tenant gets no subscription. Implement retry/dead-letter handling.

8. **No event versioning migration** - There is no schema registry or automatic migration for old event formats. If you rename a field in an event interface, all consumers must be updated simultaneously.

9. **`notification-events.ts` referenced in index.ts** - The index.ts re-exports `notification-events` but this file may not be fully implemented. Check before importing `NotificationXxxEvent` types.
