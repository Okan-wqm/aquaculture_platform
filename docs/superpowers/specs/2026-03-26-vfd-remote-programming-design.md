# VFD Remote Programming System — Enterprise Design Spec

**Date:** 2026-03-26
**Status:** Draft
**Module:** `vfd-programming` (new bounded context within sensor-service)
**Standards:** IEC 61800-7-201, IEC 62443 SL-2, ISA-95 Level 2-3

---

## 1. Overview

Enterprise-grade remote VFD parameter programming system with Maker-Checker approval workflow, batch change sets, full audit trail, automation rule engine, and dual UI surface (dedicated programming page + SCADA builder widget).

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Dedicated domain module (`vfd-programming`) | DDD bounded context, clean separation from existing `vfd` command module |
| Approval model | Maker-Checker (4-eye principle) | IEC 62443 SL-2 compliance, industrial safety standard |
| Parameter scope | Full register access (brand config driven) | Extensible — add parameters by editing brand config, no code changes |
| Write strategy | Change Set (batch) | ISA-95 change management, related parameters written atomically |
| UI | Dedicated page + SCADA widget | Engineers (commissioning) + Operators (daily use) |
| Users | Engineers + Operators + Automation system | Full lifecycle coverage |

---

## 2. Domain Model

### 2.1 Entities

#### `VfdParameterDefinition`

Writable VFD parameter definitions. Seeded from brand config files, can be customized per-tenant via DB.

```
id:                  UUID (PK)
tenantId:            UUID | null (null = system-wide brand default)
brand:               VfdBrand
modelSeries:         string | null
parameterName:       string (unique per brand+model: 'accel_time_1', 'max_frequency')
displayName:         string ('Acceleration Time 1')
description:         string ('Ramp-up time from 0 to max frequency')
category:            VfdParameterCategory.CONFIGURATION
group:               string ('ramp_times', 'freq_limits', 'motor_nameplate', 'protection', 'pid', 'io', 'communication', 'jog', 'vf_control', 'current_limits')
registerAddress:     number
registerCount:       number (default 1)
functionCode:        number (default 6 for single write, 16 for multi)
dataType:            VfdDataType
scalingFactor:       number (default 1)
offset:              number (default 0)
unit:                string | null ('s', 'Hz', 'A', '%', 'V', 'RPM')
byteOrder:           ByteOrder (default BIG)
wordOrder:           ByteOrder (default BIG)
minValue:            number | null
maxValue:            number | null
defaultValue:        number | null
step:                number | null (UI slider increment)
riskLevel:           'low' | 'medium' | 'high' | 'critical'
requiresMotorStop:   boolean
isReadable:          boolean (default true)
isWritable:          boolean (default true — this entity is for writable params)
isActive:            boolean (default true)
displayOrder:        number
metadata:            JSONB (brand-specific: danfossParameter, abbGroup, etc.)
createdAt:           timestamptz
updatedAt:           timestamptz
```

**Indexes:** `(brand)`, `(brand, group)`, `(brand, modelSeries, parameterName)` UNIQUE

#### `VfdChangeSet`

Batch parameter change request — the core Maker-Checker entity.

```
id:                  UUID (PK)
tenantId:            UUID
vfdDeviceId:         UUID (FK → vfd_devices)
status:              'draft' | 'pending_approval' | 'approved' | 'applying' | 'applied' | 'verified' | 'rejected' | 'failed' | 'rolled_back'
description:         string (mandatory — change reason)
createdBy:           UUID (maker)
approvedBy:          UUID | null (checker — MUST differ from createdBy)
rejectedBy:          UUID | null
rejectionReason:     string | null
appliedAt:           timestamptz | null
verifiedAt:          timestamptz | null
scheduledAt:         timestamptz | null (null = apply immediately after approval)
automationRuleId:    UUID | null (if triggered by automation)
rollbackOfId:        UUID | null (if this change set is a rollback of another)
metadata:            JSONB (client IP, user-agent, source: 'ui' | 'api' | 'automation')
createdAt:           timestamptz
updatedAt:           timestamptz
```

**Indexes:** `(tenantId, vfdDeviceId)`, `(tenantId, status)`, `(createdBy)`, `(approvedBy)`

**Status machine:**
```
draft → pending_approval → approved → applying → applied → verified
                         ↘ rejected                      ↘ rolled_back
                                              ↘ failed → rolled_back
```

#### `VfdChangeSetItem`

Individual parameter change within a change set.

```
id:                  UUID (PK)
changeSetId:         UUID (FK → vfd_change_sets)
parameterDefinitionId: UUID (FK → vfd_parameter_definitions)
parameterName:       string (denormalized for audit readability)
previousValue:       float | null (read-back before write)
requestedValue:      float
appliedValue:        float | null (read-back after write — verification)
status:              'pending' | 'applied' | 'verified' | 'failed' | 'rolled_back'
errorMessage:        string | null
appliedAt:           timestamptz | null
createdAt:           timestamptz
```

**Indexes:** `(changeSetId)`

#### `VfdParameterAuditLog`

Immutable audit trail for compliance (IEC 62443).

```
id:                  UUID (PK)
tenantId:            UUID
vfdDeviceId:         UUID
changeSetId:         UUID | null
parameterName:       string
previousValue:       float | null
newValue:            float
action:              'apply' | 'rollback' | 'auto_apply' | 'emergency_override'
performedBy:         string (userId or 'system:automation:{ruleId}')
clientIp:            string | null
userAgent:            string | null
automationRuleId:    UUID | null
timestamp:           timestamptz
metadata:            JSONB
```

**Indexes:** `(tenantId, vfdDeviceId, timestamp)`, `(tenantId, performedBy)`, `(changeSetId)`
**Retention:** Never delete. Partition by month for performance.

#### `VfdAutomationRule`

Event-driven automation rules that create change sets based on sensor conditions.

```
id:                  UUID (PK)
tenantId:            UUID
name:                string
description:         string
triggerCondition:    JSONB ({
                       conditions: [
                         { sensorTag: string, operator: '>' | '<' | '>=' | '<=' | '==' | '!=', value: number }
                       ],
                       logicalOperator: 'AND' | 'OR',
                       cooldownSeconds: number (prevent rapid re-triggering)
                     })
targetVfdDeviceIds:  UUID[]
parameterChanges:    JSONB ([{ parameterName: string, value: number }])
requiresApproval:    boolean (true = creates pending change set; false = auto-apply)
priority:            number (lower = higher priority, for conflict resolution)
isActive:            boolean
lastTriggeredAt:     timestamptz | null
triggerCount:        number (default 0)
createdBy:           UUID
createdAt:           timestamptz
updatedAt:           timestamptz
```

**Indexes:** `(tenantId, isActive)`, `(tenantId, targetVfdDeviceIds)` GIN

---

## 3. Service Layer

### 3.1 `VfdParameterDefinitionService`

Manages parameter definitions. Seeds from brand configs, supports per-tenant customization.

- `getDefinitionsForDevice(deviceId, tenantId)` — Returns writable parameters based on device brand/model
- `getDefinitionsByGroup(brand, group)` — Filter by parameter group
- `seedBrandDefinitions(brand)` — Populate DB from brand config `*_CONFIG_REGISTERS`
- `evaluateRiskLevel(parameterName, requestedValue, currentValue)` — Dynamic risk assessment based on `PARAMETER_RISK_RULES`

### 3.2 `VfdChangeSetService`

Change set lifecycle management — Maker-Checker workflow orchestrator.

- `createChangeSet(input: CreateChangeSetInput)` → status: `draft`
- `addItems(changeSetId, items[])` — Add parameters to draft change set
- `removeItem(changeSetId, itemId)` — Remove from draft
- `submitForApproval(changeSetId, submittedBy)` → `pending_approval`
  - Validates: all items have valid parameter definitions, values within min/max range
  - Emits: `vfd.changeset.pending` NATS event
- `approveChangeSet(changeSetId, approvedBy)` → `approved`
  - Validates: `approvedBy !== createdBy` (Maker-Checker enforcement)
  - If `scheduledAt` is null: immediately triggers apply
  - Emits: `vfd.changeset.approved`
- `rejectChangeSet(changeSetId, rejectedBy, reason)` → `rejected`
  - Emits: `vfd.changeset.rejected`
- `rollbackChangeSet(changeSetId, reason, performedBy)` → creates new change set with reversed values
  - Only for `applied` or `verified` change sets
  - New change set references `rollbackOfId`
  - If rollback reason is 'emergency': bypass Maker-Checker, log as `emergency_override`

### 3.3 `VfdParameterWriterService`

Physical VFD register write orchestrator. Uses existing `VfdCommandService` connection pool.

- `applyChangeSet(changeSet: VfdChangeSet)` → `applying` → `applied` | `failed`

**Write algorithm (per change set):**

```
1. Acquire device connection (via existing VfdCommandService.getOrCreateConnection)
2. Pre-flight checks:
   a. Device status === ACTIVE
   b. If any item.requiresMotorStop: verify motor is stopped (status word bit check)
   c. If any item.riskLevel === 'critical': double-check risk rules
3. For each item (ordered by displayOrder):
   a. READ current value (read-back) → store as previousValue
   b. WRITE requested value using adapter.writeRegister()
   c. Wait 100ms (register settle time — configurable per brand)
   d. READ new value (verification read-back) → store as appliedValue
   e. Verify: |appliedValue - requestedValue| < tolerance (scalingFactor dependent)
   f. If verify fails: mark item FAILED, continue or abort based on policy
4. If ALL items verified → change set status = 'applied'
5. If ANY item failed:
   a. Best-effort rollback: write previousValue for all successfully applied items
   b. Change set status = 'failed'
   c. Emit vfd.changeset.failed alert
6. Write audit log entries for all items
```

**Timeout and retry:**
- Per-register write timeout: 5s (configurable)
- Retry on communication error: 2 attempts with 500ms backoff
- Total change set timeout: 60s (fail-safe)

### 3.4 `VfdAutomationRuleService`

Event-driven rule engine. Listens to sensor readings via NATS.

- `onSensorReading(event: SensorReadingEvent)` — NATS subscriber for `sensor.reading.created`
  - Evaluates all active rules for the tenant
  - Checks cooldown period
  - If triggered and `requiresApproval: true` → creates change set in `pending_approval`
  - If triggered and `requiresApproval: false` → creates change set, auto-approves as `system:automation`, applies
- `createRule(input)` / `updateRule(id, input)` / `deleteRule(id)`
- `getRuleExecutionHistory(ruleId)` — Returns trigger history with change set references

### 3.5 `VfdChangeSetSchedulerService`

Handles scheduled change sets that should apply at a specific time.

- Cron job every 30s: check for `approved` change sets where `scheduledAt <= now()`
- Apply matching change sets via `VfdParameterWriterService`
- On failure: emit alert, do not auto-retry (manual intervention required)

---

## 4. GraphQL API

### 4.1 Queries

```graphql
# Get writable parameter definitions for a device
vfdParameterDefinitions(vfdDeviceId: ID!, group: String): [VfdParameterDefinition!]!

# Get change sets for a device (with pagination)
vfdChangeSets(
  vfdDeviceId: ID!
  status: VfdChangeSetStatus
  limit: Int = 20
  offset: Int = 0
): VfdChangeSetConnection!

# Get a single change set with items
vfdChangeSet(id: ID!): VfdChangeSet

# Get audit log for a device
vfdParameterAuditLog(
  vfdDeviceId: ID!
  parameterName: String
  fromDate: DateTime
  toDate: DateTime
  limit: Int = 50
): [VfdParameterAuditEntry!]!

# Get current parameter values (live read from device)
vfdCurrentParameterValues(vfdDeviceId: ID!, parameterNames: [String!]): [VfdParameterValue!]!

# Get automation rules
vfdAutomationRules(vfdDeviceId: ID): [VfdAutomationRule!]!

# Get pending change sets count (for notification badge)
vfdPendingApprovalCount: Int!
```

### 4.2 Mutations

```graphql
# === Change Set Lifecycle ===
createVfdChangeSet(input: CreateVfdChangeSetInput!): VfdChangeSet!
addVfdChangeSetItems(changeSetId: ID!, items: [VfdChangeSetItemInput!]!): VfdChangeSet!
removeVfdChangeSetItem(changeSetId: ID!, itemId: ID!): VfdChangeSet!
submitVfdChangeSetForApproval(changeSetId: ID!): VfdChangeSet!
approveVfdChangeSet(changeSetId: ID!): VfdChangeSet!
rejectVfdChangeSet(changeSetId: ID!, reason: String!): VfdChangeSet!
rollbackVfdChangeSet(changeSetId: ID!, reason: String!): VfdChangeSet!

# === Automation Rules ===
createVfdAutomationRule(input: CreateVfdAutomationRuleInput!): VfdAutomationRule!
updateVfdAutomationRule(id: ID!, input: UpdateVfdAutomationRuleInput!): VfdAutomationRule!
deleteVfdAutomationRule(id: ID!): Boolean!
toggleVfdAutomationRule(id: ID!, isActive: Boolean!): VfdAutomationRule!
```

### 4.3 Subscriptions

```graphql
# Real-time change set status updates
vfdChangeSetUpdated(vfdDeviceId: ID!): VfdChangeSet!

# Automation rule triggered notification
vfdAutomationRuleTriggered(tenantId: ID!): VfdAutomationEvent!
```

---

## 5. NATS Events

All events follow the project's `BaseEvent` interface from `libs/event-contracts`.

| Event Subject | Payload | Producer | Consumers |
|---------------|---------|----------|-----------|
| `vfd.changeset.created` | `{ changeSetId, deviceId, tenantId, createdBy, itemCount }` | vfd-programming | — |
| `vfd.changeset.pending` | `{ changeSetId, deviceId, tenantId, createdBy, description, riskSummary }` | vfd-programming | notification-service |
| `vfd.changeset.approved` | `{ changeSetId, deviceId, tenantId, approvedBy }` | vfd-programming | vfd-programming (self → apply) |
| `vfd.changeset.rejected` | `{ changeSetId, deviceId, tenantId, rejectedBy, reason }` | vfd-programming | notification-service |
| `vfd.changeset.applying` | `{ changeSetId, deviceId, progress: number }` | vfd-programming | frontend (subscription) |
| `vfd.changeset.applied` | `{ changeSetId, deviceId, tenantId, successCount, failCount }` | vfd-programming | notification-service, audit |
| `vfd.changeset.failed` | `{ changeSetId, deviceId, tenantId, error, rolledBack }` | vfd-programming | alert-engine, notification-service |
| `vfd.changeset.rolledback` | `{ changeSetId, deviceId, tenantId, reason, performedBy }` | vfd-programming | notification-service, audit |
| `vfd.automation.triggered` | `{ ruleId, deviceId, tenantId, condition, changeSetId }` | vfd-programming | audit, notification |

---

## 6. Brand Config Extensions

### 6.1 New Category

Add `CONFIGURATION = 'configuration'` to `VfdParameterCategory` enum.

### 6.2 Parameter Group Enum

New enum `VfdParameterGroup`:
```
RAMP_TIMES, FREQUENCY_LIMITS, MOTOR_NAMEPLATE, CURRENT_LIMITS,
VF_CONTROL, PID_CONTROLLER, DIGITAL_IO, COMMUNICATION,
PROTECTION, JOG, ADVANCED
```

### 6.3 Risk Level Assessment

Dynamic risk evaluation system. Base risk from parameter definition, escalated by value analysis:

```typescript
interface ParameterRiskRule {
  parameterPattern: string;          // glob: 'accel_time_*', 'max_frequency'
  baseRisk: RiskLevel;               // default risk for this parameter
  escalationCondition?: (value: number, limits: { min: number; max: number }) => boolean;
  escalatedRisk?: RiskLevel;         // risk when escalation triggers
  requiresMotorStop?: boolean;
  reason: string;                    // displayed in UI as warning
}
```

### 6.4 Brand Config Structure

Each brand config file gets a new export:

```typescript
// danfoss.config.ts — existing exports stay unchanged
export const DANFOSS_FC_REGISTERS: VfdRegisterMappingInput[] = [...]; // existing
export const DANFOSS_CONTROL_COMMANDS = {...};                         // existing

// NEW: configuration parameters (writable)
export const DANFOSS_FC_CONFIG_REGISTERS: VfdConfigRegisterInput[] = [
  // Ramp Times
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'accel_time_1',
    displayName: 'Acceleration Time 1',
    description: 'Ramp 1 up time — time for motor to accelerate from 0 Hz to max frequency (P3-41)',
    group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 3409,
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 's',
    minValue: 0.05,
    maxValue: 3600,
    defaultValue: 10,
    step: 0.1,
    riskLevel: 'medium',
    requiresMotorStop: false,
    metadata: { danfossParameter: '3-41', danfossGroup: '3-4* Ramps' },
  },
  {
    brand: VfdBrand.DANFOSS,
    parameterName: 'decel_time_1',
    displayName: 'Deceleration Time 1',
    description: 'Ramp 1 down time — time for motor to decelerate from max frequency to 0 Hz (P3-42)',
    group: VfdParameterGroup.RAMP_TIMES,
    registerAddress: 3419,
    dataType: VfdDataType.UINT16,
    scalingFactor: 0.01,
    unit: 's',
    minValue: 0.05,
    maxValue: 3600,
    defaultValue: 10,
    step: 0.1,
    riskLevel: 'medium',
    requiresMotorStop: false,
    metadata: { danfossParameter: '3-42' },
  },
  // ... Frequency Limits, Motor Nameplate, Protection, PID, etc.
];
```

### 6.5 Initial Brand Coverage

Phase 1 delivery includes configuration registers for all 8 brands. Each brand gets the 10 parameter groups defined in Section 3 of the design, mapped to brand-specific register addresses from manufacturer documentation:

- **Danfoss FC**: P1-xx, P3-xx, P4-xx, P5-xx, P7-xx, P8-xx, P14-xx
- **ABB ACS**: Groups 20-53, 99
- **Siemens G120**: P0xxx-P2xxx parameter numbers
- **Schneider Altivar**: Standard Modbus profile
- **Yaskawa**: A1-xx, b1-xx, C1-xx, d1-xx register areas
- **Delta VFD**: Pr.00-xx through Pr.14-xx
- **Mitsubishi FR**: Pr.0-Pr.999 parameter table
- **Rockwell PowerFlex**: CIP parameter objects

---

## 7. Frontend — Dedicated Programming Page

### 7.1 Route

`/sensors/vfd/:deviceId/programming` — nested under existing VFD device detail page.

### 7.2 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  VFD Programming — Danfoss FC302 #pump-inlet-1                  │
│  Status: ACTIVE  │  Motor: RUNNING  │  Freq: 42.5 Hz            │
├────────────┬─────────────────────────────────────────────────────┤
│            │                                                     │
│  Groups    │  Parameter Table                                    │
│            │  ┌───────────┬──────────┬──────────┬─────┬────────┐│
│  ▸ Ramp    │  │ Parameter │ Current  │ New Value│ Unit│ Risk   ││
│    Times   │  ├───────────┼──────────┼──────────┼─────┼────────┤│
│  ▸ Freq    │  │ Accel T1  │ 10.00    │ [  5.0 ] │ s   │ 🟡 MED ││
│    Limits  │  │ Decel T1  │ 10.00    │ [  8.0 ] │ s   │ 🟡 MED ││
│  ▸ Motor   │  │ Accel T2  │ 20.00    │ —        │ s   │ 🟢 LOW ││
│  ▸ Current │  │ Decel T2  │ 20.00    │ —        │ s   │ 🟢 LOW ││
│  ▸ V/f     │  │ S-Curve   │ 0        │ —        │ %   │ 🟢 LOW ││
│  ▸ PID     │  └───────────┴──────────┴──────────┴─────┴────────┘│
│  ▸ I/O     │                                                     │
│  ▸ Comms   │  Change Set Summary                                 │
│  ▸ Protect │  ┌─────────────────────────────────────────────────┐│
│  ▸ Jog     │  │ 2 parameters modified                          ││
│            │  │ Risk: MEDIUM (no motor stop required)           ││
│            │  │ Description: [Pompa ramp süresi optimizasyonu] ││
│            │  │                                                 ││
│            │  │ [Submit for Approval]    [Save Draft]  [Reset] ││
│            │  └─────────────────────────────────────────────────┘│
├────────────┴─────────────────────────────────────────────────────┤
│  Recent Change Sets                                              │
│  ┌──────────┬───────────┬──────────┬──────────┬────────────────┐ │
│  │ #CS-042  │ 3 params  │ Okan     │ Approved │ 2026-03-26     │ │
│  │ #CS-041  │ 1 param   │ System   │ Applied  │ 2026-03-25     │ │
│  │ #CS-040  │ 5 params  │ Okan     │ Rejected │ 2026-03-24     │ │
│  └──────────┴───────────┴──────────┴──────────┴────────────────┘ │
│                                                                   │
│  Automation Rules                                                 │
│  ┌───────────────────────────────────────────┬────────┬─────────┐│
│  │ Su sıcaklığı <15°C → accel_time +5s       │ Active │ [Edit] ││
│  │ Basınç >3bar → max_frequency -10Hz         │ Active │ [Edit] ││
│  └───────────────────────────────────────────┴────────┴─────────┘│
└──────────────────────────────────────────────────────────────────┘
```

### 7.3 Approval Panel (for checkers)

Separate view or modal accessible from notification badge:

```
┌─────────────────────────────────────────────────────┐
│  Pending Approval: CS-043                           │
│  Device: pump-inlet-1 (Danfoss FC302)              │
│  Requested by: okan@aqua.com at 14:32              │
│  Reason: "Havuz dolum hızı artırılıyor"            │
│                                                     │
│  ┌───────────┬──────────┬──────────┬──────────────┐│
│  │ Parameter │ Current  │ New      │ Risk         ││
│  ├───────────┼──────────┼──────────┼──────────────┤│
│  │ Accel T1  │ 10.00 s  │ 5.00 s   │ 🟡 MEDIUM   ││
│  │ Max Freq  │ 50.00 Hz │ 55.00 Hz │ 🔴 CRITICAL ││
│  └───────────┴──────────┴──────────┴──────────────┘│
│                                                     │
│  ⚠️  CRITICAL: Max frequency exceeds 50Hz.          │
│  Motor bearings may be damaged at elevated speed.   │
│                                                     │
│  [Approve]  [Reject: _________ ]                   │
└─────────────────────────────────────────────────────┘
```

### 7.4 Frontend Hooks

```typescript
// Core hooks
useVfdParameterDefinitions(deviceId: string, group?: string)
useVfdCurrentValues(deviceId: string, parameterNames: string[])
useVfdChangeSet(changeSetId: string)          // single change set with items
useVfdChangeSets(deviceId: string, status?)   // list with pagination
useVfdPendingApprovalCount()                  // notification badge
useVfdAuditLog(deviceId: string, filters?)
useVfdAutomationRules(deviceId?: string)

// Mutation hooks
useCreateVfdChangeSet()
useSubmitVfdChangeSet()
useApproveVfdChangeSet()
useRejectVfdChangeSet()
useRollbackVfdChangeSet()
useCreateVfdAutomationRule()
useToggleVfdAutomationRule()
```

---

## 8. Frontend — SCADA Widget

### 8.1 Widget Type

New SCADA builder widget: `vfdProgrammer`

### 8.2 Widget Config

```typescript
interface VfdProgrammerWidgetConfig {
  vfdDeviceId: string;                // bound VFD device
  visibleGroups: VfdParameterGroup[]; // which parameter groups to show
  compactMode: boolean;               // true = only show most-used params
  allowCreateChangeSet: boolean;      // false = read-only monitoring
  showAuditLog: boolean;
  showAutomationStatus: boolean;
}
```

### 8.3 Widget Renderer

Compact card showing:
- VFD device name + status
- Key parameters (accel/decel time, freq limits) as read-only or editable
- "Pending Approvals" badge
- Quick-action buttons: "Create Change Set", "View Audit Log"
- Click to open full programming panel as slide-over

### 8.4 Widget Config Panel

Added to `widgetConfigMap` in `widget-configs/index.ts`:
- Device selector (dropdown of registered VFD devices)
- Parameter group checkboxes
- Compact mode toggle
- Permission toggles

---

## 9. Error Handling

### 9.1 Write Failures

| Failure Mode | Behavior |
|--------------|----------|
| Communication timeout | Retry 2x with 500ms backoff, then fail item |
| Register not writable | Fail item, continue others |
| Read-back mismatch | Fail item, log expected vs actual, continue |
| Motor running + requiresMotorStop | Abort entire change set before any writes |
| Device offline | Abort entire change set |
| Any item fails | Best-effort rollback of previously applied items |
| Rollback fails | Change set status = 'failed', alert-engine notified |

### 9.2 Workflow Failures

| Failure Mode | Behavior |
|--------------|----------|
| Maker === Checker | Reject with error: "Approver must differ from requester" |
| Value out of range | Reject at submitForApproval validation |
| Parameter definition not found | Reject at addItems validation |
| Concurrent change set for same device | Block: only one active (non-draft) change set per device |
| Scheduled apply misses window | Retry within 5 minutes, then fail with alert |

### 9.3 Automation Failures

| Failure Mode | Behavior |
|--------------|----------|
| Rule triggers too frequently | Cooldown period prevents re-trigger |
| Conflicting rules | Higher priority rule wins, lower priority skipped with log |
| Auto-apply fails | Alert generated, rule deactivated after 3 consecutive failures |

---

## 10. Security

### 10.1 Authorization Matrix (IEC 62443 SL-2)

| Action | VIEWER | OPERATOR | MODULE_MANAGER | TENANT_ADMIN |
|--------|--------|----------|----------------|--------------|
| View parameters | ✓ | ✓ | ✓ | ✓ |
| View change sets | ✓ | ✓ | ✓ | ✓ |
| View audit log | ✓ | ✓ | ✓ | ✓ |
| Create change set (maker) | ✗ | ✗ | ✓ | ✓ |
| Approve change set (checker) | ✗ | ✗ | ✗ | ✓ |
| Reject change set | ✗ | ✗ | ✗ | ✓ |
| Emergency rollback | ✗ | ✗ | ✓ | ✓ |
| Create automation rule | ✗ | ✗ | ✗ | ✓ |
| Toggle automation rule | ✗ | ✗ | ✓ | ✓ |
| Set requiresApproval=false | ✗ | ✗ | ✗ | ✓ |

### 10.2 Audit Requirements

- Every parameter write is logged with: who, when, what, from-value, to-value, why
- Audit logs are immutable (no UPDATE/DELETE)
- Client IP and user-agent captured for forensics
- Automation-triggered changes logged with rule ID and trigger condition

### 10.3 Concurrent Access

- Pessimistic lock: only one non-draft change set per device at a time
- Draft change sets: multiple allowed (different users preparing)
- Device-level mutex during `applying` status (prevents read/write conflicts)

---

## 11. Testing Strategy

### 11.1 Unit Tests

- `VfdChangeSetService`: all state transitions, Maker-Checker validation, edge cases
- `VfdParameterWriterService`: mock adapter, verify write sequence, rollback logic
- `VfdAutomationRuleService`: rule evaluation, cooldown, conflict resolution
- Risk level evaluation: dynamic escalation for boundary values

### 11.2 Integration Tests

- Full workflow: create → submit → approve → apply → verify → audit log check
- Rejection workflow: create → submit → reject
- Rollback workflow: applied → rollback → new change set created
- Automation: sensor event → rule trigger → change set → apply
- Concurrent access: two users creating change sets for same device

### 11.3 E2E Tests

- UI flow: navigate to programming page, modify parameters, submit, approve
- SCADA widget: add widget, configure, create change set from widget
- Notification: pending approval badge appears for checker

---

## 12. File Structure

```
apps/sensor-service/src/vfd-programming/
├── vfd-programming.module.ts
├── entities/
│   ├── vfd-parameter-definition.entity.ts
│   ├── vfd-change-set.entity.ts
│   ├── vfd-change-set-item.entity.ts
│   ├── vfd-parameter-audit-log.entity.ts
│   ├── vfd-automation-rule.entity.ts
│   └── index.ts
├── dto/
│   ├── create-change-set.dto.ts
│   ├── change-set-item.dto.ts
│   ├── automation-rule.dto.ts
│   ├── parameter-value.dto.ts
│   └── index.ts
├── services/
│   ├── vfd-parameter-definition.service.ts
│   ├── vfd-change-set.service.ts
│   ├── vfd-parameter-writer.service.ts
│   ├── vfd-automation-rule.service.ts
│   ├── vfd-change-set-scheduler.service.ts
│   └── index.ts
├── resolvers/
│   ├── vfd-programming.resolver.ts
│   ├── vfd-automation.resolver.ts
│   └── index.ts
├── risk/
│   ├── parameter-risk-rules.ts
│   ├── risk-evaluator.service.ts
│   └── index.ts
└── __tests__/
    ├── vfd-change-set.service.spec.ts
    ├── vfd-parameter-writer.service.spec.ts
    ├── vfd-automation-rule.service.spec.ts
    ├── risk-evaluator.service.spec.ts
    └── vfd-programming.resolver.spec.ts

# Brand config extensions (in existing vfd module)
apps/sensor-service/src/vfd/brand-configs/
├── danfoss.config.ts          # + DANFOSS_FC_CONFIG_REGISTERS
├── abb.config.ts              # + ABB_ACS_CONFIG_REGISTERS
├── siemens.config.ts          # + SIEMENS_G120_CONFIG_REGISTERS
├── schneider.config.ts        # + SCHNEIDER_ATV_CONFIG_REGISTERS
├── yaskawa.config.ts          # + YASKAWA_CONFIG_REGISTERS
├── delta.config.ts            # + DELTA_VFD_CONFIG_REGISTERS
├── mitsubishi.config.ts       # + MITSUBISHI_FR_CONFIG_REGISTERS
├── rockwell.config.ts         # + ROCKWELL_PF_CONFIG_REGISTERS
└── index.ts                   # updated exports

# Frontend — dedicated page
web/modules/sensor-module/src/pages/vfd/
├── VfdProgrammingPage.tsx
├── components/
│   ├── ParameterTable.tsx
│   ├── ParameterGroupNav.tsx
│   ├── ChangeSetPanel.tsx
│   ├── ChangeSetApprovalModal.tsx
│   ├── ChangeSetHistoryTable.tsx
│   ├── AutomationRuleList.tsx
│   ├── AutomationRuleEditor.tsx
│   ├── RiskBadge.tsx
│   └── AuditLogTable.tsx
├── hooks/
│   ├── useVfdParameterDefinitions.ts
│   ├── useVfdCurrentValues.ts
│   ├── useVfdChangeSets.ts
│   ├── useVfdPendingApprovalCount.ts
│   ├── useVfdAuditLog.ts
│   ├── useVfdAutomationRules.ts
│   └── index.ts
└── graphql/
    ├── vfd-programming.operations.ts
    └── vfd-programming.fragments.ts

# Frontend — SCADA widget
web/modules/sensor-module/src/components/scada-builder/
├── widget-configs/VfdProgrammerConfig.tsx        # new
├── widget-renderers/VfdProgrammerRenderer.tsx    # new
└── ... (existing files updated: widgetConfigMap, widgetRenderers)
```

---

## 13. Dependencies

### Backend

| Dependency | Purpose | Existing? |
|-----------|---------|-----------|
| `vfd` module | Connection pool, adapters, register mappings | Yes |
| `backend-common` | TenantGuard, Roles, decorators | Yes |
| `event-contracts` | NATS event definitions | Yes — needs new events added |
| `notification-service` | Approval notifications | Yes |
| `alert-engine` | Failed write alerts | Yes |
| `@nestjs/schedule` | Change set scheduler (cron) | Yes (used in sensor-service) |

### Frontend

| Dependency | Purpose | Existing? |
|-----------|---------|-----------|
| `shared-ui` | UI components, forms, tables | Yes |
| `@apollo/client` | GraphQL queries/mutations | Yes |
| SCADA builder infrastructure | Widget registration | Yes |

### No new external dependencies required.

---

## 14. Migration

Single TypeORM migration adding 5 new tables to the `sensor` schema:
- `vfd_parameter_definitions`
- `vfd_change_sets`
- `vfd_change_set_items`
- `vfd_parameter_audit_logs`
- `vfd_automation_rules`

All within the existing `sensor` schema — no new schema needed.
