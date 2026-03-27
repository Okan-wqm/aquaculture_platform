# Manual Water Quality Data Entry -- Enterprise Architecture Plan

**Date:** 2026-03-27
**Author:** System Architecture Designer
**Status:** Draft
**Services:** farm-service, farm-module (web), aquamobil (PWA)

---

## 1. Problem Statement

Users currently have no UI to record manual water quality measurements. The backend
`createWaterQualityMeasurement` mutation exists but accepts a static `WaterParametersInput`
with hardcoded fields (temperature, dissolvedOxygen, pH, ...). The platform already has a
dynamic parameter configuration system (`WaterQualityParameterConfig`) and an equipment-to-
parameter mapping system (`WaterQualityParamEquipment`), but neither is leveraged during
manual data entry.

**Goals:**
- Provide a dynamic, equipment-aware measurement entry form on web and mobile.
- Show ONLY the parameters mapped to the selected equipment, with units and thresholds
  auto-populated from `WaterQualityParameterConfig`.
- Real-time visual feedback (green/yellow/red) based on configured thresholds.
- Offline-first mobile experience with queue-based sync.
- Full tenant isolation with no cross-tenant data leakage.

---

## 2. Architecture Overview

```
+------------------+      +------------------+      +-------------------+
|  farm-module     |      |   aquamobil      |      |  farm-service     |
|  (Web SPA)       |      |   (PWA)          |      |  (NestJS)         |
|                  |      |                  |      |                   |
| WaterChemistry   |      | WQRecordPage     |      | WQResolver        |
|   "Record" tab   |      |  + OfflineQueue  |      |   createWQ()      |
|                  |      |                  |      |   createBatchWQ() |
| DynamicMeasure-  |      | DynamicMeasure-  |      |                   |
|   mentForm       |      |   mentForm       |      | WQValidation-     |
|                  |      |                  |      |   Service          |
+--------+---------+      +--------+---------+      |                   |
         |                         |                 | WQEvaluation-     |
         | GraphQL                 | GraphQL         |   Service         |
         | (online)                | (queued)        |                   |
         v                         v                 | ParamConfigCache  |
+--------------------------------------------------+|                   |
|              API Gateway (nginx)                  || Equipment module  |
+--------------------------------------------------+|   (existing)      |
                                                     +-------------------+
                                                              |
                                                     +--------v---------+
                                                     |   PostgreSQL     |
                                                     |   tenant_* schema|
                                                     +------------------+
```

**Data flow (happy path):**
1. User selects System, then Equipment (tank/pond/biofilter/etc.)
2. Frontend queries `equipmentParameters(equipmentId)` -- returns active param-equipment
   mappings with full `parameterConfig` relation (code, name, unit, thresholds, dataType).
3. Frontend renders a dynamic form with one field per mapped parameter.
4. User enters values. Real-time validation compares each value to the config thresholds.
5. Submit calls `createWaterQualityMeasurement` with equipmentId and a dynamic `parameters`
   JSONB payload keyed by parameter code.
6. Backend `WaterQualityValidationService` validates values against param configs.
7. Backend `WaterQualityEvaluationService.evaluate()` runs and sets overallStatus + summary.
8. Measurement is persisted to tenant schema.

---

## 3. Backend Changes

### Phase 1: Enhanced CreateWaterQualityInput (dynamic parameters + equipmentId)

**Problem:** Current `CreateWaterQualityInput` has a static `WaterParametersInput` with
hardcoded fields. Dynamic parameters require a JSONB map keyed by parameter code.

**Files to modify:**

`apps/farm-service/src/water-quality/dto/create-water-quality.input.ts`
- Add optional `equipmentId` field (IsUUID, IsOptional).
- Add `dynamicParameters` field: `Record<string, number | string | boolean>` mapped as
  `GraphQLJSON`. This is the primary input for equipment-driven entry.
- Keep the existing `parameters: WaterParametersInput` as-is for backward compatibility
  (sensor auto-ingest still uses it).
- Add validation: at least one of `parameters` or `dynamicParameters` must be provided.

`apps/farm-service/src/water-quality/water-quality.service.ts`
- In `create()`: if `input.dynamicParameters` is provided, merge it into the `parameters`
  JSONB column. The dynamic keys map directly to parameter config codes.
- If `input.equipmentId` is provided, set it on the measurement entity.

`apps/farm-service/src/water-quality/water-quality.resolver.ts`
- No structural change needed. The existing `createWaterQualityMeasurement` mutation
  already spreads the input. The new fields flow through automatically.

**New DTO type:**

```typescript
// In create-water-quality.input.ts
@InputType()
export class CreateWaterQualityInput {
  // ... existing fields (tankId, pondId, siteId, batchId, measuredAt, source, etc.)

  @Field(() => ID, { nullable: true, description: 'Equipment UUID' })
  @IsOptional()
  @IsUUID()
  equipmentId?: string;

  @Field(() => GraphQLJSON, { nullable: true, description: 'Dynamic parameter values keyed by config code' })
  @IsOptional()
  dynamicParameters?: Record<string, number | string | boolean>;

  @Field(() => WaterParametersInput, { nullable: true, description: 'Legacy static parameters' })
  @IsOptional()
  parameters?: WaterParametersInput;
}
```

### Phase 2: WaterQualityValidationService

**Problem:** The evaluation service checks thresholds AFTER save. We need a pre-save
validation layer that rejects invalid data (out-of-physical-range values, wrong data types,
parameters not mapped to the equipment, etc.).

**New file:** `apps/farm-service/src/water-quality/services/water-quality-validation.service.ts`

Responsibilities:
1. If `equipmentId` is provided, load active param-equipment mappings for that equipment.
2. For each key in `dynamicParameters`, verify:
   - The parameter code exists in the tenant's active configs.
   - The parameter is mapped to the given equipment (if equipmentId provided).
   - The value is of the correct data type (number, enum, boolean per config.dataType).
   - For number types: value is within physical bounds (not NaN, not Infinity).
   - For enum types: value is in `config.enumValues`.
3. If `config.isRequired` is true for a mapped parameter and it is missing from
   `dynamicParameters`, reject with a validation error listing missing required params.
4. Return a validated and sanitized parameter map.

Integration into `WaterQualityService.create()`:
```
const validated = await this.validationService.validate(tenantId, input);
// Then proceed with entity creation using validated.parameters
```

**Estimated size:** ~120 lines.

### Phase 3: Batch Measurement Creation

**Problem:** Operators sometimes measure the same parameters across multiple equipment
in a single walkthrough. Submitting one-by-one is slow.

**New file:** `apps/farm-service/src/water-quality/dto/create-batch-water-quality.input.ts`

```typescript
@InputType()
export class BatchMeasurementItem {
  @Field(() => ID)
  @IsUUID()
  equipmentId: string;

  @Field(() => GraphQLJSON)
  dynamicParameters: Record<string, number | string | boolean>;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

@InputType()
export class CreateBatchWaterQualityInput {
  @Field()
  @IsDate()
  @Type(() => Date)
  measuredAt: Date;

  @Field(() => MeasurementSource)
  @IsEnum(MeasurementSource)
  source: MeasurementSource;

  @Field(() => [BatchMeasurementItem])
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BatchMeasurementItem)
  measurements: BatchMeasurementItem[];
}
```

**New resolver mutation** in `water-quality.resolver.ts`:
```typescript
@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
@Mutation(() => [WaterQualityMeasurement])
async createBatchWaterQualityMeasurements(
  @Args('input') input: CreateBatchWaterQualityInput,
  @CurrentTenant() tenantId: string,
  @CurrentUser() user: { sub: string },
): Promise<WaterQualityMeasurement[]> { ... }
```

Implementation wraps individual `create()` calls in a single DB transaction.
Max 50 items per batch to prevent abuse.

---

## 4. Frontend Web -- Data Entry Tab

### Phase 4: DynamicMeasurementForm Component

**New file:** `web/modules/farm-module/src/pages/water-chemistry/components/DynamicMeasurementForm.tsx`

This is the core reusable component shared between web and (via copy) mobile.

**Props interface:**
```typescript
interface DynamicMeasurementFormProps {
  equipmentId: string;
  equipmentName: string;
  parameterMappings: ParamEquipmentMapping[];  // from equipmentParameters query
  onSubmit: (values: Record<string, number | string | boolean>, notes: string) => void;
  isSubmitting: boolean;
}
```

**Behavior:**
- Renders one input field per `parameterMappings` entry, ordered by
  `parameterConfig.displayOrder`.
- Each field shows: parameter name, unit suffix, precision-based step attribute.
- For `dataType === 'number'`: `<input type="number">` with step based on config.precision.
- For `dataType === 'enum'`: `<select>` with options from `config.enumValues`.
- For `dataType === 'boolean'`: toggle switch.
- Real-time border coloring per field:
  - Green (`ring-green-500`): value within optimalMin..optimalMax.
  - Yellow (`ring-yellow-500`): value within warningMin..warningMax (outside optimal).
  - Red (`ring-red-500`): value outside criticalMin..criticalMax.
  - Gray (default): no value entered yet.
- Required fields (config.isRequired) marked with asterisk; form cannot submit until
  all required fields have values.
- Notes textarea at the bottom (maxLength 500, XSS-safe via class-validator on backend).
- Weather conditions input (optional, only shown for outdoor equipment types).
- Submit button with loading state.

**Estimated size:** ~250 lines.

**New hook:** `web/modules/farm-module/src/hooks/useEquipmentParameters.ts`

```typescript
export function useEquipmentParameters(equipmentId: string | null) {
  // Queries equipmentParameters(equipmentId) GraphQL query
  // Returns parameterMappings with loaded parameterConfig
  // staleTime: 5 minutes (configs rarely change)
}
```

**Estimated size:** ~80 lines.

### Phase 5: Integration into WaterChemistryPage as "Record" Tab

**File to modify:** `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx`

Current tabs: `calculator | history | parameters`
New tab:      `calculator | record | history | parameters`

The "Record" tab contains:
1. **System selector** -- dropdown of production systems (from existing useEquipmentSystems
   or similar hook).
2. **Equipment selector** -- dropdown filtered by selected system. Shows equipment name,
   code, and type icon. Most-recently-used equipment pinned to top (stored in localStorage).
3. **DynamicMeasurementForm** -- rendered once equipment is selected.
4. **Recent entries panel** -- last 5 measurements for the selected equipment (read-only
   cards), providing context for the operator.

**New file:** `web/modules/farm-module/src/pages/water-chemistry/components/RecordTab.tsx`

This component orchestrates the system/equipment selectors and renders
`DynamicMeasurementForm`. It calls `useCreateWaterQuality` on submit, constructing the
GraphQL input with `equipmentId`, `dynamicParameters`, `source: 'MANUAL'`,
`measuredAt: new Date()`.

**Estimated size:** ~200 lines.

**Tab type update (in WaterChemistryPage.tsx):**
```typescript
type TabId = 'calculator' | 'record' | 'history' | 'parameters';
```

Add to the tabs array:
```typescript
{ id: 'record', label: 'Record', icon: ClipboardEdit }
```

---

## 5. Mobile App -- AquaMobil

### Phase 6: WaterQualityRecordPage (mobile-optimized form)

**New file:** `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx`

Follows the established pattern from `RecordFeedingPage.tsx`:
- Header with gradient background and back button.
- Equipment selector using Konsta UI `ListInput` (type="select").
- Most-recently-used equipment stored in localStorage, shown first.
- `DynamicMeasurementForm` adapted for mobile:
  - Larger touch targets (min 44px height).
  - `inputMode="decimal"` for number fields.
  - Single-column layout.
  - Swipeable parameter groups (basic, nitrogen, biological, etc.).
- Camera button for lab result photo attachment (stored as base64 in notes or as a
  separate `attachmentUrl` field -- Phase 6b).
- Submit via `addToQueue('createWaterQuality', payload)` for offline support.
- Success screen identical to RecordFeedingPage pattern.

**Estimated size:** ~300 lines.

**Route registration** in `web/apps/aquamobil/src/App.tsx` or router config:
```typescript
{ path: '/water-quality/record', element: <WaterQualityRecordPage /> }
{ path: '/water-quality/record/:equipmentId', element: <WaterQualityRecordPage /> }
```

### Phase 7: Offline Queue Integration

**File to modify:** `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`

Add new operation type to the `MUTATIONS` record:
```typescript
createWaterQuality: `
  mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
    createWaterQualityMeasurement(input: $input) {
      id
      overallStatus
      hasAlarm
    }
  }
`,
```

**File to modify:** `web/apps/aquamobil/src/types/index.ts` (or wherever `OperationType` is
defined):
```typescript
type OperationType = 'recordFeeding' | 'recordMortality' | ... | 'createWaterQuality';
```

**Offline behavior:**
- Equipment list and parameter configs are cached with `staleTime: 5 * 60 * 1000` and
  `gcTime: 60 * 60 * 1000`. This allows the form to render offline.
- When the user submits offline, the measurement is queued in IndexedDB via the existing
  `queueOperation` utility.
- When connectivity returns, `syncAllOperations` sends the queued mutation to the backend.
- Conflict resolution: measurements are append-only (INSERT), so no conflicts.

---

## 6. Tenant Isolation Verification

### Security Checklist

| Checkpoint | Mechanism | Status |
|---|---|---|
| Schema isolation per request | `createTenantSchemaMiddleware('farm')` sets `search_path` | Existing |
| tenantId on every entity | `WaterQualityMeasurement.tenantId`, `WaterQualityParameterConfig.tenantId`, `WaterQualityParamEquipment.tenantId` | Existing |
| @CurrentTenant() on every resolver | `WaterQualityResolver`, `WaterQualityParameterConfigResolver` both use `@CurrentTenant()` | Existing |
| TenantGuard on resolver class | `@UseGuards(TenantGuard)` on both resolvers | Existing |
| Service-layer tenantId filter | Every `repository.find()` includes `where: { tenantId }` | Existing |
| equipmentParameters query scoped | `GetEquipmentParamsHandler` filters by `tenantId` | Existing |
| New validation service scoped | `WaterQualityValidationService.validate(tenantId, ...)` must include tenantId in all queries | New -- must verify |
| Batch mutation scoped | Each item in batch goes through `create(tenantId, ...)` | New -- must verify |
| Mobile offline sync scoped | JWT carries tenantId; backend extracts via `@CurrentTenant()` | Existing |

### Isolation Test Cases

1. **Cross-tenant parameter leak:** Tenant A's equipment must NOT show Tenant B's parameter
   configs even if UUIDs are guessed. The `equipmentParameters` query joins on tenantId.
2. **Cross-tenant measurement injection:** Submitting a measurement with Tenant B's
   equipmentId from Tenant A's session must fail (equipment not found in Tenant A schema).
3. **Cross-tenant history access:** `waterQualityMeasurements` filter always includes
   `where: { tenantId }`. Even with a known measurement UUID, `findById` checks tenantId.

---

## 7. Testing Plan

### Unit Tests

**File:** `apps/farm-service/src/water-quality/services/__tests__/water-quality-validation.service.spec.ts`

| Test Case | Description |
|---|---|
| valid-dynamic-params | All params exist in config, correct types, within physical bounds |
| missing-required-param | A required parameter is omitted -- expect ValidationError |
| unknown-param-code | A parameter code not in tenant configs -- expect rejection |
| wrong-data-type | String value for a number config -- expect rejection |
| enum-invalid-value | Value not in enumValues -- expect rejection |
| equipment-unmapped-param | Parameter exists in config but not mapped to equipment -- expect rejection |
| no-equipment-id | dynamicParameters without equipmentId -- skip equipment mapping check, validate against all configs |

**File:** `apps/farm-service/src/water-quality/services/__tests__/water-quality-evaluation.service.spec.ts`

| Test Case | Description |
|---|---|
| all-optimal | All values within optimal range -- overallStatus = OPTIMAL |
| one-warning | One value in warning range -- overallStatus = WARNING |
| one-critical | One value beyond critical -- overallStatus = CRITICAL, hasAlarm = true |
| species-override | Species-specific limits applied when speciesCode provided |
| missing-optional | Optional param missing -- not counted as warning |

**File:** `apps/farm-service/src/water-quality/__tests__/create-measurement.spec.ts`

| Test Case | Description |
|---|---|
| create-with-dynamic-params | dynamicParameters merged into entity.parameters JSONB |
| create-with-equipment-id | equipmentId set on saved entity |
| backward-compat-static | Legacy WaterParametersInput still works |
| batch-create | 3 items in batch -- 3 measurements created in single transaction |
| batch-max-exceeded | 51 items -- expect validation error |

### Integration Tests

**File:** `apps/farm-service/src/water-quality/__tests__/tenant-isolation.integration.spec.ts`

| Test Case | Description |
|---|---|
| cross-tenant-create | Create measurement as Tenant A, query as Tenant B -- not found |
| cross-tenant-equipment | Query equipmentParameters with Tenant B's equipmentId from Tenant A -- empty |
| schema-switch | Two requests with different tenant JWTs hit correct schemas |

### E2E Tests

**File:** `tests/e2e/water-quality-manual-entry.e2e.spec.ts`

| Test Case | Description |
|---|---|
| full-flow | Select equipment -> fill dynamic form -> submit -> verify in DB |
| evaluation-trigger | Submit out-of-range value -> verify overallStatus is CRITICAL |
| batch-flow | Submit batch of 3 -> verify 3 rows created |

---

## 8. File Map

### New Files

| # | Path | Size Est. | Phase |
|---|---|---|---|
| 1 | `apps/farm-service/src/water-quality/services/water-quality-validation.service.ts` | ~120 lines | 2 |
| 2 | `apps/farm-service/src/water-quality/dto/create-batch-water-quality.input.ts` | ~60 lines | 3 |
| 3 | `web/modules/farm-module/src/hooks/useEquipmentParameters.ts` | ~80 lines | 4 |
| 4 | `web/modules/farm-module/src/pages/water-chemistry/components/DynamicMeasurementForm.tsx` | ~250 lines | 4 |
| 5 | `web/modules/farm-module/src/pages/water-chemistry/components/RecordTab.tsx` | ~200 lines | 5 |
| 6 | `web/apps/aquamobil/src/pages/water-quality/WaterQualityRecordPage.tsx` | ~300 lines | 6 |
| 7 | `apps/farm-service/src/water-quality/services/__tests__/water-quality-validation.service.spec.ts` | ~150 lines | 2 |
| 8 | `apps/farm-service/src/water-quality/services/__tests__/water-quality-evaluation.service.spec.ts` | ~120 lines | 2 |
| 9 | `apps/farm-service/src/water-quality/__tests__/create-measurement.spec.ts` | ~100 lines | 3 |
| 10 | `apps/farm-service/src/water-quality/__tests__/tenant-isolation.integration.spec.ts` | ~80 lines | 6 |
| 11 | `tests/e2e/water-quality-manual-entry.e2e.spec.ts` | ~100 lines | 7 |

### Modified Files

| # | Path | Change | Phase |
|---|---|---|---|
| 1 | `apps/farm-service/src/water-quality/dto/create-water-quality.input.ts` | Add equipmentId, dynamicParameters fields; make parameters optional | 1 |
| 2 | `apps/farm-service/src/water-quality/water-quality.service.ts` | Merge dynamicParameters into entity; inject ValidationService | 1, 2 |
| 3 | `apps/farm-service/src/water-quality/water-quality.resolver.ts` | Add createBatchWaterQualityMeasurements mutation | 3 |
| 4 | `apps/farm-service/src/water-quality/water-quality.module.ts` | Register ValidationService as provider | 2 |
| 5 | `web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.tsx` | Add "Record" tab, import RecordTab | 5 |
| 6 | `web/modules/farm-module/src/hooks/useWaterQuality.ts` | Add equipmentId to CreateWaterQualityInput type; add dynamicParameters | 4 |
| 7 | `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx` | Add createWaterQuality mutation | 7 |
| 8 | `web/apps/aquamobil/src/types/index.ts` | Add 'createWaterQuality' to OperationType union | 7 |
| 9 | `web/apps/aquamobil/src/App.tsx` (or router) | Add /water-quality/record route | 6 |

---

## 9. Implementation Order with Dependencies

```
Phase 1 ─────> Phase 2 ─────> Phase 3
(DTO changes)  (Validation)   (Batch mutation)
                  |
                  v
Phase 4 ─────────────────────> Phase 5
(DynamicForm + hook)           (RecordTab in WaterChemistryPage)
                                  |
Phase 6 <─────────────────────────┘  (can start after Phase 4)
(Mobile WQRecordPage)
   |
   v
Phase 7
(Offline queue integration)
```

**Estimated timeline:**
- Phase 1: 0.5 day (DTO changes are minimal)
- Phase 2: 1 day (validation service + unit tests)
- Phase 3: 0.5 day (batch DTO + resolver + tests)
- Phase 4: 1.5 days (DynamicMeasurementForm + hook + tests)
- Phase 5: 0.5 day (RecordTab integration)
- Phase 6: 1 day (mobile page, adapted from RecordFeedingPage pattern)
- Phase 7: 0.5 day (offline queue wiring)

**Total: ~5.5 days**

---

## 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Dynamic parameters break existing sensor auto-ingest | Low | High | Keep `parameters` (static) as-is. `dynamicParameters` is additive. Both merge into the same JSONB column. Evaluation service already handles both. |
| Parameter config cache stale during form entry | Medium | Low | Cache TTL is 5 min (existing). On save, validation re-fetches from DB if cache is empty. Acceptable for manual entry cadence. |
| Offline queue sync fails silently | Medium | Medium | Existing `useOfflineQueue` already shows pending count and sync errors. Add specific error message for WQ measurement failures. |
| Large batch submissions cause timeout | Low | Medium | Max 50 items per batch. Each item's validation and evaluation are lightweight (in-memory threshold checks). DB insert is batched in a single transaction. |
| XSS via notes field | Low | High | Backend `@IsString()` + `@MaxLength(500)` on notes. Frontend renders notes with React's default escaping. No `dangerouslySetInnerHTML`. |
| Mobile form unusable with many parameters | Medium | Medium | Group parameters by `config.group` (basic, nitrogen_cycle, etc.) with collapsible sections. Only show isQuickAccess params by default, expandable for full list. |
| equipmentId foreign key violation | Low | Low | Validation service checks equipment exists in tenant schema before save. Return clear error message if not found. |
| Rate limiting absent on measurement creation | Medium | Medium | Add `@Throttle(30, 60)` (30 requests per 60 seconds) on the create mutation using NestJS throttler. Batch endpoint counts as 1 request regardless of item count. |
