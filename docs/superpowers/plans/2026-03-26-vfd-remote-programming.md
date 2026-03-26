# VFD Remote Programming — Implementation Plan

> **For agentic workers:** This plan is executed via ruflo swarm orchestration with specialized agents per phase. Each phase is a parallel workstream with its own agent prompt.

**Goal:** Implement enterprise-grade VFD remote parameter programming with Maker-Checker workflow, batch change sets, automation rules, and dual UI (dedicated page + SCADA widget).

**Architecture:** New `vfd-programming` bounded context within sensor-service. Extends existing `vfd` module's brand configs with writable configuration registers. Frontend gets a dedicated programming page + a SCADA builder widget. NATS events drive notifications and automation.

**Tech Stack:** NestJS, TypeORM, GraphQL (code-first), NATS, React, Apollo Client, Vite

**Spec:** `docs/superpowers/specs/2026-03-26-vfd-remote-programming-design.md`

---

## Phase Overview

| Phase | Name | Agent | Parallel? |
|-------|------|-------|-----------|
| 1 | Enums, Types & Brand Config Extensions | backend-coder-1 | Yes |
| 2 | Entity Layer (5 entities + migration) | backend-coder-2 | Yes (after Phase 1) |
| 3 | Risk Evaluator Service | backend-coder-3 | Yes (after Phase 1) |
| 4 | ChangeSet Service (Maker-Checker) | backend-coder-4 | After Phase 2+3 |
| 5 | Parameter Writer Service | backend-coder-5 | After Phase 2 |
| 6 | Automation Rule Service | backend-coder-6 | After Phase 4+5 |
| 7 | GraphQL Resolvers + Module Wiring | backend-coder-7 | After Phase 4+5+6 |
| 8 | Frontend GraphQL Operations + Hooks | frontend-coder-1 | After Phase 7 |
| 9 | VFD Programming Page | frontend-coder-2 | After Phase 8 |
| 10 | SCADA Widget (VfdProgrammer) | frontend-coder-3 | After Phase 8 |
| 11 | Integration Tests | tester | After all phases |

---

## Phase 1: Enums, Types & Brand Config Extensions

### Task 1.1: Extend VfdParameterCategory Enum

**Files:**
- Modify: `apps/sensor-service/src/vfd/entities/vfd.enums.ts`

- [ ] Add `CONFIGURATION = 'configuration'` to `VfdParameterCategory` enum
- [ ] Add new enum `VfdParameterGroup`:
```typescript
export enum VfdParameterGroup {
  RAMP_TIMES = 'ramp_times',
  FREQUENCY_LIMITS = 'frequency_limits',
  MOTOR_NAMEPLATE = 'motor_nameplate',
  CURRENT_LIMITS = 'current_limits',
  VF_CONTROL = 'vf_control',
  PID_CONTROLLER = 'pid_controller',
  DIGITAL_IO = 'digital_io',
  COMMUNICATION = 'communication',
  PROTECTION = 'protection',
  JOG = 'jog',
  ADVANCED = 'advanced',
}

registerEnumType(VfdParameterGroup, {
  name: 'VfdParameterGroup',
  description: 'VFD configuration parameter groups',
});
```
- [ ] Add new enum `VfdChangeSetStatus`:
```typescript
export enum VfdChangeSetStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  APPLYING = 'applying',
  APPLIED = 'applied',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
  FAILED = 'failed',
  ROLLED_BACK = 'rolled_back',
}

registerEnumType(VfdChangeSetStatus, {
  name: 'VfdChangeSetStatus',
  description: 'VFD change set lifecycle status',
});
```
- [ ] Add new enum `RiskLevel`:
```typescript
export enum RiskLevel {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

registerEnumType(RiskLevel, {
  name: 'RiskLevel',
  description: 'VFD parameter change risk level',
});
```

### Task 1.2: Extend VfdRegisterMappingInput Type

**Files:**
- Modify: `apps/sensor-service/src/vfd/entities/vfd.types.ts`

- [ ] Add `VfdConfigRegisterInput` interface extending `VfdRegisterMappingInput`:
```typescript
export interface VfdConfigRegisterInput extends VfdRegisterMappingInput {
  group: string;         // VfdParameterGroup value
  defaultValue?: number;
  step?: number;         // UI slider increment
  riskLevel: string;     // RiskLevel value
  requiresMotorStop: boolean;
  metadata?: Record<string, unknown>;
}
```

### Task 1.3: Danfoss FC Config Registers

**Files:**
- Modify: `apps/sensor-service/src/vfd/brand-configs/danfoss.config.ts`

- [ ] Add `DANFOSS_FC_CONFIG_REGISTERS: VfdConfigRegisterInput[]` with these parameters:
  - Ramp: `accel_time_1` (P3-41, Reg 3409), `decel_time_1` (P3-42, Reg 3419), `accel_time_2` (P3-51, Reg 3509), `decel_time_2` (P3-52, Reg 3519), `s_curve_start` (P3-80, Reg 3799), `s_curve_end` (P3-81, Reg 3809)
  - Freq: `min_frequency` (P4-11, Reg 4109), `max_frequency` (P4-13, Reg 4129), `skip_freq_1` (P4-61, Reg 4609), `skip_freq_2` (P4-63, Reg 4629), `skip_band` (P4-62, Reg 4619)
  - Motor: `motor_voltage` (P1-22, Reg 1219), `motor_current` (P1-24, Reg 1239), `motor_power` (P1-20, Reg 1199), `motor_speed_rpm` (P1-25, Reg 1249), `motor_cos_phi` (P1-26, Reg 1259)
  - Current/Torque: `current_limit_percent` (P4-16, Reg 4159), `torque_limit_motor` (P4-17, Reg 4169), `torque_limit_gen` (P4-18, Reg 4179)
  - V/f: `vf_curve_mode` (P1-00, Reg 999), `voltage_boost` (P1-03, Reg 1029)
  - PID: `pid_setpoint` (P7-00, Reg 6999), `pid_p_gain` (P7-03, Reg 7029), `pid_i_time` (P7-04, Reg 7039), `pid_d_time` (P7-05, Reg 7049)
  - Jog: `jog_frequency` (P3-19, Reg 3189), `jog_ramp_time` (P3-80, Reg 3799)
  - Protection: `thermal_protection_mode` (P1-90, Reg 1899), `stall_detection` (P14-01, Reg 14009)
  - Comm: `modbus_address` (P8-31, Reg 8309), `baudrate_select` (P8-32, Reg 8319)

### Task 1.4: ABB ACS Config Registers

**Files:**
- Modify: `apps/sensor-service/src/vfd/brand-configs/abb.config.ts`

- [ ] Add `ABB_ACS_CONFIG_REGISTERS: VfdConfigRegisterInput[]` — same parameter groups, ABB register addresses (Groups 20-53, 99)

### Task 1.5: Remaining 6 Brand Config Registers

**Files:**
- Modify: `siemens.config.ts`, `schneider.config.ts`, `yaskawa.config.ts`, `delta.config.ts`, `mitsubishi.config.ts`, `rockwell.config.ts`

- [ ] Add `*_CONFIG_REGISTERS` for each brand with manufacturer-specific register addresses

### Task 1.6: Update Brand Config Index

**Files:**
- Modify: `apps/sensor-service/src/vfd/brand-configs/index.ts`

- [ ] Export all `*_CONFIG_REGISTERS` arrays
- [ ] Add `VFD_BRAND_CONFIG_REGISTERS: Record<VfdBrand, VfdConfigRegisterInput[]>` map
- [ ] Add helper: `getVfdConfigRegisters(brand: VfdBrand): VfdConfigRegisterInput[]`
- [ ] Add helper: `getVfdConfigRegistersByGroup(brand: VfdBrand, group: VfdParameterGroup): VfdConfigRegisterInput[]`

---

## Phase 2: Entity Layer

### Task 2.1: VfdParameterDefinition Entity

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/vfd-parameter-definition.entity.ts`

- [ ] TypeORM entity with all fields from spec Section 2.1
- [ ] Table: `vfd_parameter_definitions` in `sensor` schema
- [ ] GraphQL ObjectType with `@Field()` decorators
- [ ] Indexes: `(brand)`, `(brand, group)`, `(brand, modelSeries, parameterName)` UNIQUE

### Task 2.2: VfdChangeSet Entity

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/vfd-change-set.entity.ts`

- [ ] TypeORM entity with all fields from spec
- [ ] `@OneToMany(() => VfdChangeSetItem, item => item.changeSet, { cascade: true })`
- [ ] Status as `VfdChangeSetStatus` enum column
- [ ] Indexes: `(tenantId, vfdDeviceId)`, `(tenantId, status)`

### Task 2.3: VfdChangeSetItem Entity

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/vfd-change-set-item.entity.ts`

- [ ] TypeORM entity — `@ManyToOne(() => VfdChangeSet, cs => cs.items)`
- [ ] Fields: previousValue, requestedValue, appliedValue (all `float | null`)
- [ ] Own status enum: `'pending' | 'applied' | 'verified' | 'failed' | 'rolled_back'`

### Task 2.4: VfdParameterAuditLog Entity

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/vfd-parameter-audit-log.entity.ts`

- [ ] Immutable audit entity — no `@UpdateDateColumn`
- [ ] Index: `(tenantId, vfdDeviceId, timestamp)`
- [ ] Action enum: `'apply' | 'rollback' | 'auto_apply' | 'emergency_override'`

### Task 2.5: VfdAutomationRule Entity

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/vfd-automation-rule.entity.ts`

- [ ] `triggerCondition` as JSONB column
- [ ] `parameterChanges` as JSONB column
- [ ] `targetVfdDeviceIds` as UUID array (simpleArray or JSONB)

### Task 2.6: Entity Index + App Module Registration

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/entities/index.ts`
- Modify: `apps/sensor-service/src/app.module.ts` — add entities to TypeORM `entities` array

- [ ] Export all 5 entities from index
- [ ] Import entities into app.module.ts TypeORM config

---

## Phase 3: Risk Evaluator Service

### Task 3.1: Parameter Risk Rules

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/risk/parameter-risk-rules.ts`

- [ ] Define `ParameterRiskRule` interface:
```typescript
export interface ParameterRiskRule {
  parameterPattern: string;    // glob: 'accel_time_*', 'max_frequency'
  baseRisk: RiskLevel;
  escalationCondition?: (value: number, limits: { min?: number; max?: number }) => boolean;
  escalatedRisk?: RiskLevel;
  requiresMotorStop?: boolean;
  reason: string;
}
```
- [ ] Define `PARAMETER_RISK_RULES` array with rules from spec Section 6.3:
  - `accel_time_*` → medium, escalate to critical if value < 1.0
  - `max_frequency` → high, escalate to critical if value > 60
  - `thermal_protection_mode` → critical if disabled (value === 0)
  - `motor_*` → high, requiresMotorStop: true
  - `vf_curve_mode` → high, requiresMotorStop: true
  - `decel_time_*` → medium
  - `current_limit_*` → medium
  - `pid_*` → medium
  - `jog_*` → low
  - `modbus_*` → low
  - `baudrate_*` → low

### Task 3.2: Risk Evaluator Service

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/risk/risk-evaluator.service.ts`
- Create: `apps/sensor-service/src/vfd-programming/risk/index.ts`

- [ ] `@Injectable()` service
- [ ] `evaluateRisk(parameterName: string, requestedValue: number, limits?: { min?: number; max?: number }): { riskLevel: RiskLevel; requiresMotorStop: boolean; warnings: string[] }`
- [ ] Pattern matching with `minimatch` or simple glob (startsWith/endsWith)
- [ ] Returns escalated risk if condition matches, base risk otherwise

### Task 3.3: Risk Evaluator Unit Tests

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/risk/__tests__/risk-evaluator.service.spec.ts`

- [ ] Test accel_time_1 = 0.5 → critical
- [ ] Test accel_time_1 = 5.0 → medium
- [ ] Test max_frequency = 70 → critical
- [ ] Test jog_frequency = 5 → low
- [ ] Test motor_voltage = 400 → high + requiresMotorStop
- [ ] Test thermal_protection_mode = 0 → critical

---

## Phase 4: ChangeSet Service (Maker-Checker)

### Task 4.1: DTO Layer

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/dto/create-change-set.dto.ts`
- Create: `apps/sensor-service/src/vfd-programming/dto/change-set-item.dto.ts`
- Create: `apps/sensor-service/src/vfd-programming/dto/index.ts`

- [ ] `CreateChangeSetInput`: vfdDeviceId, description, items (optional array), scheduledAt
- [ ] `ChangeSetItemInput`: parameterName, requestedValue
- [ ] `ApproveChangeSetInput`: changeSetId (ID)
- [ ] `RejectChangeSetInput`: changeSetId, reason
- [ ] `RollbackChangeSetInput`: changeSetId, reason
- [ ] Output DTOs: `VfdChangeSetDto`, `VfdChangeSetItemDto`, `VfdParameterValueDto`

### Task 4.2: VfdParameterDefinitionService

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/vfd-parameter-definition.service.ts`

- [ ] `@Injectable()`, inject `Repository<VfdParameterDefinition>` and `VfdRegisterMappingService`
- [ ] `getDefinitionsForDevice(deviceId, tenantId)` — get device brand → return definitions from DB, fallback to brand config
- [ ] `getDefinitionsByGroup(brand, group)` — filter by group
- [ ] `seedBrandDefinitions(brand)` — populate DB from `VFD_BRAND_CONFIG_REGISTERS`
- [ ] `findByParameterName(brand, parameterName)` — single lookup

### Task 4.3: VfdChangeSetService

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/vfd-change-set.service.ts`

- [ ] `@Injectable()`, inject repos for ChangeSet, ChangeSetItem, ParameterDefinition + EventEmitter
- [ ] `createChangeSet(tenantId, input, createdBy)` → draft
- [ ] `addItems(changeSetId, items[])` — validate draft status, parameter exists, value in range
- [ ] `removeItem(changeSetId, itemId)` — validate draft status
- [ ] `submitForApproval(changeSetId, submittedBy)` — validate items exist, emit NATS event
- [ ] `approveChangeSet(changeSetId, approvedBy)` — **enforce maker ≠ checker**, emit event
- [ ] `rejectChangeSet(changeSetId, rejectedBy, reason)` — emit event
- [ ] `rollbackChangeSet(changeSetId, reason, performedBy)` — create new inverse change set
- [ ] Concurrency guard: only one non-draft change set per device

### Task 4.4: ChangeSet Service Unit Tests

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/__tests__/vfd-change-set.service.spec.ts`

- [ ] Test full lifecycle: create → submit → approve → apply
- [ ] Test Maker-Checker: approvedBy === createdBy → throw BadRequestException
- [ ] Test concurrent guard: second non-draft change set → throw ConflictException
- [ ] Test reject workflow
- [ ] Test rollback creates inverse change set
- [ ] Test value out of range at submit time → validation error
- [ ] Test add/remove items on non-draft → throw BadRequestException

---

## Phase 5: Parameter Writer Service

### Task 5.1: VfdParameterWriterService

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/vfd-parameter-writer.service.ts`

- [ ] `@Injectable()`, inject `VfdCommandService`, `VfdDeviceService`, `VfdRegisterMappingService`, `RiskEvaluatorService`, repos
- [ ] `applyChangeSet(changeSet: VfdChangeSet)`:
  1. Validate device status = ACTIVE
  2. Check requiresMotorStop items → verify motor stopped via status word
  3. For each item (ordered by displayOrder):
     - Read current value (read-back) → `previousValue`
     - Write register via `adapter.writeRegister()`
     - Wait 100ms settle time
     - Read-back verification → `appliedValue`
     - Verify tolerance: `|appliedValue - requestedValue| < scalingFactor`
  4. On failure: best-effort rollback of applied items
  5. Write audit log entries
- [ ] `readParameterValue(deviceId, parameterDef)` — single register read using adapter
- [ ] `writeParameterValue(deviceId, parameterDef, value)` — single register write with scaling
- [ ] Timeout: 5s per register, 60s total
- [ ] Retry: 2 attempts with 500ms backoff on comm error

### Task 5.2: Writer Service Unit Tests

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/__tests__/vfd-parameter-writer.service.spec.ts`

- [ ] Mock VfdCommandService, adapter
- [ ] Test successful apply: read-back → write → verify → applied
- [ ] Test write failure: rollback previously applied items
- [ ] Test motor running + requiresMotorStop → abort before any writes
- [ ] Test read-back mismatch → item marked failed
- [ ] Test device offline → abort with error

---

## Phase 6: Automation Rule Service

### Task 6.1: VfdAutomationRuleService

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/vfd-automation-rule.service.ts`

- [ ] `@Injectable()`, inject AutomationRule repo, ChangeSetService, ParameterWriterService
- [ ] `onSensorReading(event)` — NATS subscriber `sensor.reading.created`:
  - Find active rules for tenant
  - Evaluate trigger conditions
  - Check cooldown period
  - If requiresApproval: create change set as `pending_approval`
  - If !requiresApproval: create, auto-approve as `system:automation`, apply
- [ ] CRUD: createRule, updateRule, deleteRule, toggleRule
- [ ] `getRuleExecutionHistory(ruleId)` — audit log filtered by automationRuleId
- [ ] Conflict resolution: higher priority rule wins

### Task 6.2: VfdChangeSetSchedulerService

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/vfd-change-set-scheduler.service.ts`

- [ ] `@Cron('*/30 * * * * *')` — every 30 seconds
- [ ] Find `approved` change sets where `scheduledAt <= now()`
- [ ] Apply via ParameterWriterService
- [ ] On failure: emit alert, do NOT auto-retry

### Task 6.3: Services Index

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/services/index.ts`

- [ ] Export all 5 services

---

## Phase 7: GraphQL Resolvers + Module Wiring

### Task 7.1: VfdProgrammingResolver

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/resolvers/vfd-programming.resolver.ts`

- [ ] Queries: vfdParameterDefinitions, vfdChangeSets, vfdChangeSet, vfdParameterAuditLog, vfdCurrentParameterValues, vfdPendingApprovalCount
- [ ] Mutations: createVfdChangeSet, addVfdChangeSetItems, removeVfdChangeSetItem, submitVfdChangeSetForApproval, approveVfdChangeSet, rejectVfdChangeSet, rollbackVfdChangeSet
- [ ] Role guards per spec Section 10.1

### Task 7.2: VfdAutomationResolver

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/resolvers/vfd-automation.resolver.ts`

- [ ] Queries: vfdAutomationRules
- [ ] Mutations: createVfdAutomationRule, updateVfdAutomationRule, deleteVfdAutomationRule, toggleVfdAutomationRule
- [ ] TENANT_ADMIN only for create/update/delete

### Task 7.3: Resolvers Index

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/resolvers/index.ts`

### Task 7.4: VfdProgrammingModule

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/vfd-programming.module.ts`

- [ ] Import TypeOrmModule.forFeature with all 5 entities
- [ ] Import VfdModule (for VfdCommandService, VfdDeviceService, VfdRegisterMappingService)
- [ ] Import ScheduleModule
- [ ] Provide all services + resolvers
- [ ] Export services

### Task 7.5: Wire into AppModule

**Files:**
- Modify: `apps/sensor-service/src/app.module.ts`

- [ ] Import VfdProgrammingModule
- [ ] Add 5 entities to TypeORM entities array
- [ ] Verify build succeeds: `npx nx run sensor-service:build`

---

## Phase 8: Frontend GraphQL Operations + Hooks

### Task 8.1: GraphQL Operations

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/graphql/vfd-programming.operations.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/graphql/vfd-programming.fragments.ts`

- [ ] Fragments: VfdParameterDefinitionFragment, VfdChangeSetFragment, VfdChangeSetItemFragment, VfdAuditLogFragment, VfdAutomationRuleFragment
- [ ] Queries: VFD_PARAMETER_DEFINITIONS, VFD_CHANGE_SETS, VFD_CHANGE_SET, VFD_PARAMETER_AUDIT_LOG, VFD_CURRENT_PARAMETER_VALUES, VFD_PENDING_APPROVAL_COUNT, VFD_AUTOMATION_RULES
- [ ] Mutations: CREATE_VFD_CHANGE_SET, ADD_VFD_CHANGE_SET_ITEMS, REMOVE_VFD_CHANGE_SET_ITEM, SUBMIT_VFD_CHANGE_SET, APPROVE_VFD_CHANGE_SET, REJECT_VFD_CHANGE_SET, ROLLBACK_VFD_CHANGE_SET, CREATE_VFD_AUTOMATION_RULE, UPDATE_VFD_AUTOMATION_RULE, DELETE_VFD_AUTOMATION_RULE, TOGGLE_VFD_AUTOMATION_RULE

### Task 8.2: React Hooks

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdParameterDefinitions.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdCurrentValues.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdChangeSets.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdPendingApprovalCount.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdAuditLog.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdAutomationRules.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/useVfdMutations.ts`
- Create: `web/modules/sensor-module/src/pages/vfd/hooks/index.ts`

- [ ] Each hook wraps corresponding Apollo useQuery/useMutation
- [ ] useVfdMutations: createChangeSet, submitChangeSet, approveChangeSet, rejectChangeSet, rollbackChangeSet + automation CRUD

---

## Phase 9: VFD Programming Page

### Task 9.1: Page Shell + Route Registration

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/VfdProgrammingPage.tsx`
- Modify: `web/modules/sensor-module/src/App.tsx` (or routing file) — add route `/sensors/vfd/:deviceId/programming`

- [ ] Page layout: header (device info + status), sidebar (parameter groups), main (parameter table + change set panel), footer (history + automation)
- [ ] Fetch device info via existing VFD device query
- [ ] Loading/error states

### Task 9.2: ParameterGroupNav Component

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/ParameterGroupNav.tsx`

- [ ] Sidebar listing parameter groups with icons
- [ ] Active state for selected group
- [ ] Count badge per group (modified params)

### Task 9.3: ParameterTable Component

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/ParameterTable.tsx`

- [ ] Table: parameterName, currentValue, newValue (editable), unit, riskLevel badge
- [ ] Editable inputs: number input with min/max/step from definition
- [ ] Risk badge component (RiskBadge.tsx): color-coded LOW/MEDIUM/HIGH/CRITICAL
- [ ] Modified row highlighting
- [ ] Read-back value polling (current values from device)

### Task 9.4: ChangeSetPanel Component

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/ChangeSetPanel.tsx`

- [ ] Summary: X parameters modified, overall risk level
- [ ] Description textarea (mandatory)
- [ ] Schedule picker (optional)
- [ ] Actions: Submit for Approval, Save Draft, Reset
- [ ] Risk warnings for high/critical params

### Task 9.5: ChangeSetApprovalModal Component

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/ChangeSetApprovalModal.tsx`

- [ ] Shows change set details: device, requester, items with before/after values
- [ ] Risk warnings prominently displayed
- [ ] Approve / Reject (with reason field) buttons
- [ ] Motor stop warning for high-risk params

### Task 9.6: ChangeSetHistoryTable + AuditLogTable Components

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/ChangeSetHistoryTable.tsx`
- Create: `web/modules/sensor-module/src/pages/vfd/components/AuditLogTable.tsx`
- Create: `web/modules/sensor-module/src/pages/vfd/components/RiskBadge.tsx`

- [ ] ChangeSetHistoryTable: paginated list of change sets with status, items, dates
- [ ] AuditLogTable: immutable audit trail with filter by parameter, date range
- [ ] RiskBadge: color-coded risk level display

### Task 9.7: AutomationRuleList + AutomationRuleEditor Components

**Files:**
- Create: `web/modules/sensor-module/src/pages/vfd/components/AutomationRuleList.tsx`
- Create: `web/modules/sensor-module/src/pages/vfd/components/AutomationRuleEditor.tsx`

- [ ] AutomationRuleList: active rules with toggle, trigger count, last triggered
- [ ] AutomationRuleEditor: modal/drawer for create/edit rule
  - Sensor tag selector
  - Condition builder (operator + value)
  - Target parameter + value
  - Cooldown period
  - Requires approval toggle

---

## Phase 10: SCADA Widget (VfdProgrammer)

### Task 10.1: VfdProgrammerConfig

**Files:**
- Create: `web/modules/sensor-module/src/components/scada-builder/widget-configs/VfdProgrammerConfig.tsx`

- [ ] Device selector dropdown (VFD devices)
- [ ] Parameter group checkboxes
- [ ] Compact mode toggle
- [ ] Allow create change set toggle
- [ ] Show audit log toggle

### Task 10.2: VfdProgrammerRenderer

**Files:**
- Create: `web/modules/sensor-module/src/components/scada-builder/widget-renderers/VfdProgrammerRenderer.tsx`

- [ ] Compact card: device name, status, key params (accel/decel/freq)
- [ ] Pending approvals badge
- [ ] Click to open full programming slide-over panel
- [ ] Edit mode: show config controls
- [ ] Preview/Simulation mode: show live values

### Task 10.3: Register Widget in SCADA Builder

**Files:**
- Modify: `web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts`
- Modify: widget renderers registry (wherever widget type → renderer mapping lives)

- [ ] Add `vfdProgrammer: VfdProgrammerConfig` to `widgetConfigMap`
- [ ] Add `vfdProgrammer: VfdProgrammerRenderer` to renderer map
- [ ] Add widget to SCADA builder toolbox/palette

---

## Phase 11: Integration Tests

### Task 11.1: Backend Integration Tests

**Files:**
- Create: `apps/sensor-service/src/vfd-programming/__tests__/vfd-programming.integration.spec.ts`

- [ ] Full Maker-Checker workflow: create → submit → approve → apply → verify
- [ ] Rejection workflow
- [ ] Rollback workflow
- [ ] Concurrent change set guard
- [ ] Automation rule trigger → change set creation

### Task 11.2: E2E Smoke Test

**Files:**
- Create: `e2e/tests/modules/sensor/vfd-programming.spec.ts`

- [ ] GraphQL mutation: create change set, verify response
- [ ] GraphQL query: list change sets, verify pagination
- [ ] GraphQL query: parameter definitions for brand
