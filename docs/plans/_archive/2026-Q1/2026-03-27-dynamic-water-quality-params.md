# Dynamic Water Quality Parameters -- Enterprise Architecture Plan

**Date:** 2026-03-27
**Status:** Draft
**Author:** System Architecture Designer
**Service:** farm-service
**Affected Modules:** water-quality, farm-module (frontend)

---

## 1. Problem Statement

### Current State

Water quality measurements are stored via a `WaterQualityMeasurement` entity that uses a JSONB `parameters` column typed against a hardcoded `WaterParameters` interface containing 25+ fields (temperature, dissolvedOxygen, pH, ammonia, etc.). Five "quick-access" columns duplicate the most common parameters for indexed queries.

The evaluation logic in `evaluateParameters()` uses hardcoded default limits (optimized for trout) and a flat `Record<string, {optimalMin, optimalMax, criticalMin, criticalMax}>` override. The frontend `HistoryTab` renders fixed columns (Temp, DO, pH, NH3, NO2) and the chart plots these same five parameters with hardcoded colors and axis labels.

### Problem

1. **Tenant diversity is unserved.** Norwegian salmon farms track DO/pH/temp/ammonia. Turkish sea bass farms track ozone/salinity/turbidity. Shrimp farms track vibrio/BOD/TSS. The current model forces every tenant into the same 25-field interface.

2. **Limits are hardcoded for trout.** The default limits in `evaluateParameters()` are meaningless for sea bass (optimal temp 18-24C) or shrimp (optimal pH 7.5-8.5). Species-specific limits are mentioned in comments but never implemented.

3. **Frontend is static.** Table columns, chart lines, and form fields are identical for every tenant. A salmon farm sees empty turbidity columns; a shrimp farm cannot add vibrio counts.

4. **No admin self-service.** Adding a new parameter requires a code change, redeploy, and frontend update. Tenant admins cannot customize their parameter set.

5. **Validation is cosmetic.** The DTO `WaterParametersInput` validates Min/Max for hardcoded fields only. There is no mechanism to validate arbitrary tenant-defined parameters or reject unknown keys.

### Success Criteria

- Tenant admin can define, enable/disable, reorder, and set limits for arbitrary water quality parameters
- Pre-built templates accelerate onboarding (pick "Salmon Freshwater" and get 15 parameters pre-configured)
- Measurement creation validates each parameter value against the tenant's active config and generates per-parameter status
- Frontend dynamically renders table columns, chart lines, form fields, and filters based on the tenant's active parameter configs
- Existing data remains backward-compatible (JSONB parameters column unchanged)
- Zero schema migration per tenant for parameter changes

---

## 2. Architecture Decision

### Decision: Parameter Configuration Table + Dynamic Evaluation

Introduce a `WaterQualityParameterConfig` entity (one row per parameter per tenant) that defines the parameter's metadata, display properties, and threshold limits. Measurements continue to use the JSONB `parameters` column -- the shape of the JSON is not constrained by a TypeScript interface at the entity level but is validated at runtime against the tenant's active configs.

### Alternatives Considered

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| **A. Config table (chosen)** | No schema changes per tenant, cacheable, admin self-service, backward-compatible | Extra join/lookup on measurement creation | Chosen |
| **B. Per-tenant DB columns** | Type-safe at DB level | Requires ALTER TABLE per parameter, per tenant schema -- operational nightmare | Rejected |
| **C. JSONB schema in a metadata table** | Flexible schema definition | Complex validation, no per-parameter indexing, hard to query | Rejected |
| **D. Expand the hardcoded interface** | Simple, type-safe | Defeats the purpose, still one-size-fits-all | Rejected |

### Key Design Principles

1. **Config is read-heavy, write-rare.** Cache aggressively. Invalidate on mutation.
2. **JSONB stays.** The `parameters` JSONB column on `WaterQualityMeasurement` is the single source of truth for parameter values. No new columns per parameter.
3. **Quick-access columns stay.** The five existing indexed columns (temperature, dissolvedOxygen, pH, ammonia, nitrite) remain for performant queries on universal parameters. The `syncQuickAccessFields()` hook continues to work.
4. **Backward compatibility.** Tenants without configs get the existing hardcoded defaults. Migration is opt-in.
5. **CQRS pattern.** Follow the codebase convention (worker module) -- commands and queries routed through `CommandBus`/`QueryBus`.

---

## 3. Data Model

### 3.1 WaterQualityParameterConfig Entity

```
Table: water_quality_parameter_configs
Schema: tenant_xxx (per-tenant, same as all farm entities)
```

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | UUID (PK) | No | Primary key |
| `tenantId` | UUID | No | Tenant identifier |
| `code` | VARCHAR(50) | No | Machine-readable code, unique per tenant. E.g. `temperature`, `dissolved_oxygen`, `vibrio_count` |
| `name` | VARCHAR(100) | No | Display name. E.g. "Temperature", "Dissolved Oxygen" |
| `unit` | VARCHAR(30) | No | Measurement unit. E.g. "mg/L", "ppt", "NTU", "CFU/mL" |
| `dataType` | ENUM | No | `number`, `enum`, `boolean` |
| `precision` | SMALLINT | No | Decimal places for display (0-6). Default 2 |
| `group` | ENUM | No | `basic`, `nitrogen_cycle`, `metals`, `biological`, `organic`, `custom` |
| `optimalMin` | DECIMAL(10,4) | Yes | Optimal range lower bound |
| `optimalMax` | DECIMAL(10,4) | Yes | Optimal range upper bound |
| `warningMin` | DECIMAL(10,4) | Yes | Warning range lower bound (below optimal) |
| `warningMax` | DECIMAL(10,4) | Yes | Warning range upper bound (above optimal) |
| `criticalMin` | DECIMAL(10,4) | Yes | Critical lower threshold |
| `criticalMax` | DECIMAL(10,4) | Yes | Critical upper threshold |
| `speciesLimits` | JSONB | Yes | Optional species-specific limit overrides. Shape: `Record<string, {optimalMin, optimalMax, warningMin, warningMax, criticalMin, criticalMax}>` keyed by species code |
| `enumValues` | VARCHAR[] | Yes | For `dataType=enum`: allowed string values. E.g. `['none','low','moderate','high','bloom']` |
| `chartColor` | VARCHAR(9) | No | Hex color for chart lines. Default "#3b82f6" |
| `icon` | VARCHAR(50) | Yes | Icon identifier for frontend rendering |
| `displayOrder` | SMALLINT | No | Sort order in UI. Default 0 |
| `isVisible` | BOOLEAN | No | Show in default views. Default true |
| `isRequired` | BOOLEAN | No | Required when creating a measurement. Default false |
| `isActive` | BOOLEAN | No | Soft-disable. Inactive params are hidden but data preserved. Default true |
| `chartAxisGroup` | VARCHAR(20) | Yes | Which Y-axis to use: `left`, `right`. Default `left` |
| `isQuickAccess` | BOOLEAN | No | Whether this maps to a quick-access DB column. Read-only for system params. Default false |
| `templateSource` | VARCHAR(50) | Yes | Which template this was seeded from. Null if custom |
| `createdAt` | TIMESTAMPTZ | No | Audit |
| `updatedAt` | TIMESTAMPTZ | No | Audit |

**Indexes:**

```
@Index(['tenantId', 'code'], { unique: true })   -- code is unique per tenant
@Index(['tenantId', 'isActive', 'displayOrder'])  -- active params sorted for UI
@Index(['tenantId', 'group'])                      -- group filtering
```

### 3.2 Parameter Templates (Seed Data)

Templates are stored as TypeScript constant arrays (not in the database) and bulk-inserted into the config table when a tenant selects one. This keeps templates version-controlled and avoids a separate `parameter_templates` table.

```typescript
interface ParameterTemplate {
  templateId: string;           // 'salmon_freshwater', 'sea_bass', etc.
  name: string;                 // "Salmon Freshwater"
  description: string;
  species: string[];            // ['atlantic_salmon', 'rainbow_trout']
  parameters: Omit<WaterQualityParameterConfigData, 'tenantId'>[];
}
```

**Templates to ship:**

| Template ID | Name | Parameter Count | Key Parameters |
|-------------|------|----------------|----------------|
| `salmon_freshwater` | Salmon Freshwater | 15 | temp, DO, pH, ammonia, nitrite, nitrate, CO2, alkalinity, hardness, turbidity, conductivity, TAN, oxygenSaturation, transparency, chlorine |
| `salmon_seawater` | Salmon Seawater | 14 | temp, DO, pH, ammonia, nitrite, salinity, CO2, alkalinity, turbidity, oxygenSaturation, TAN, conductivity, transparency, H2S |
| `sea_bass` | Sea Bass / Sea Bream | 12 | temp, DO, pH, salinity, ammonia, nitrite, nitrate, turbidity, alkalinity, ozone, conductivity, oxygenSaturation |
| `shrimp` | Shrimp (Vannamei) | 16 | temp, DO, pH, salinity, ammonia, nitrite, alkalinity, hardness, turbidity, BOD, COD, TSS, bacteriaCount, vibrioCount, transparency, conductivity |
| `tilapia` | Tilapia | 11 | temp, DO, pH, ammonia, nitrite, nitrate, alkalinity, turbidity, transparency, conductivity, oxygenSaturation |

Each template provides sensible defaults for `optimalMin/Max`, `criticalMin/Max`, `chartColor`, `displayOrder`, `unit`, `precision`, and `group`.

### 3.3 Relationship Diagram

```
┌──────────────────────────────────────┐
│  WaterQualityParameterConfig         │
│  (per tenant, defines what to track) │
│                                      │
│  PK: id (UUID)                       │
│  tenantId + code (UNIQUE)            │
│  name, unit, dataType, precision     │
│  optimalMin/Max, warningMin/Max      │
│  criticalMin/Max, speciesLimits      │
│  chartColor, icon, displayOrder      │
│  isVisible, isRequired, isActive     │
└──────────────┬───────────────────────┘
               │
               │ validates & evaluates
               ▼
┌──────────────────────────────────────┐
│  WaterQualityMeasurement             │
│  (existing entity, unchanged schema) │
│                                      │
│  PK: id (UUID)                       │
│  tenantId, tankId, measuredAt        │
│  parameters: JSONB  <── dynamic keys │
│  temperature, DO, pH (quick-access)  │
│  overallStatus, summary              │
└──────────────────────────────────────┘
               │
               │ referenced by
               ▼
┌──────────────────────────────────────┐
│  Frontend: HistoryTab, Charts, Forms │
│  (reads configs to render dynamic UI)│
│                                      │
│  useParameterConfigs() → columns     │
│  useParameterConfigs() → chart lines │
│  useParameterConfigs() → form fields │
└──────────────────────────────────────┘
```

---

## 4. Backend Implementation

### Phase 1: Entity + Module + CRUD Resolver

**Goal:** Create the `WaterQualityParameterConfig` entity, DTOs, CQRS commands/queries, and GraphQL resolver.

#### 4.1.1 Entity

TypeORM entity with NestJS GraphQL decorators. All columns use proper TypeORM types with `DecimalTransformer` for decimal fields. The entity lives in the water-quality module since it is tightly coupled to water quality measurement logic.

Key considerations:
- `code` validation: lowercase alphanumeric + underscores, max 50 chars, must match regex `^[a-z][a-z0-9_]*$`
- `enumValues` is a PostgreSQL text array column, only populated when `dataType = 'enum'`
- `speciesLimits` JSONB is optional and used only when species-specific thresholds differ from the base limits

#### 4.1.2 Enums

```typescript
enum ParameterDataType {
  NUMBER = 'number',
  ENUM = 'enum',
  BOOLEAN = 'boolean',
}

enum ParameterGroup {
  BASIC = 'basic',
  NITROGEN_CYCLE = 'nitrogen_cycle',
  METALS = 'metals',
  BIOLOGICAL = 'biological',
  ORGANIC = 'organic',
  CUSTOM = 'custom',
}
```

Both registered with `registerEnumType()`.

#### 4.1.3 DTOs (Input Types)

**CreateParameterConfigInput:**
- All fields from the entity except `id`, `tenantId`, `createdAt`, `updatedAt`
- `code`: `@IsString()`, `@Matches(/^[a-z][a-z0-9_]*$/)`, `@MaxLength(50)`
- `name`: `@IsString()`, `@MinLength(1)`, `@MaxLength(100)`
- `unit`: `@IsString()`, `@MaxLength(30)`
- `dataType`: `@IsEnum(ParameterDataType)`
- `precision`: `@IsInt()`, `@Min(0)`, `@Max(6)`, default 2
- `group`: `@IsEnum(ParameterGroup)`
- All limit fields: `@IsOptional()`, `@IsNumber()`
- `chartColor`: `@IsOptional()`, `@Matches(/^#[0-9a-fA-F]{6}$/)`, default "#3b82f6"
- `enumValues`: `@IsOptional()`, `@IsArray()`, `@IsString({ each: true })`

**UpdateParameterConfigInput:**
- `id`: required UUID
- All other fields optional (partial update)

**BulkCreateFromTemplateInput:**
- `templateId`: `@IsString()` -- one of the template IDs
- `overwrite`: `@IsBoolean()`, default false -- whether to replace existing configs

#### 4.1.4 CQRS Commands and Queries

Following the worker module pattern:

**Commands:**
- `CreateParameterConfigCommand(input, tenantId, userId)`
- `UpdateParameterConfigCommand(input, tenantId, userId)`
- `DeleteParameterConfigCommand(id, tenantId)`
- `BulkCreateFromTemplateCommand(templateId, overwrite, tenantId, userId)`
- `ReorderParameterConfigsCommand(orderedIds: string[], tenantId)`

**Queries:**
- `ListParameterConfigsQuery(tenantId, filters?: { group?, isActive?, isVisible? })`
- `GetParameterConfigQuery(tenantId, id)`
- `GetParameterConfigByCodeQuery(tenantId, code)`
- `ListParameterTemplatesQuery()` -- returns available templates (no DB, from constants)

#### 4.1.5 Handlers

Each handler follows the established pattern:
- Inject `@InjectRepository(WaterQualityParameterConfig)`
- Decorated with `@CommandHandler(CommandClass)` or `@QueryHandler(QueryClass)`
- Returns the entity or entity array

The `BulkCreateFromTemplateHandler` is the most complex:
1. Look up the template by ID from the constants
2. If `overwrite=true`, delete all existing configs for the tenant
3. If `overwrite=false`, skip parameters whose `code` already exists
4. Bulk-insert the template parameters with the tenant's ID
5. Return the created configs

#### 4.1.6 Resolver

`WaterQualityParameterConfigResolver` following the existing pattern:
- `@UseGuards(TenantGuard)` at class level
- Queries available to all authenticated users
- Mutations restricted to `@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)`

### Phase 2: Template Seed Service

**Goal:** Provide pre-built parameter templates that tenants can apply.

#### 4.2.1 Template Data

A `parameter-templates.data.ts` file containing the five templates as typed constant arrays. Each parameter entry includes:

```typescript
{
  code: 'temperature',
  name: 'Temperature',
  unit: 'C',
  dataType: ParameterDataType.NUMBER,
  precision: 1,
  group: ParameterGroup.BASIC,
  optimalMin: 12,
  optimalMax: 18,
  warningMin: 8,
  warningMax: 22,
  criticalMin: 5,
  criticalMax: 25,
  chartColor: '#3b82f6',
  displayOrder: 1,
  isVisible: true,
  isRequired: false,
  isActive: true,
  isQuickAccess: true,
  chartAxisGroup: 'left',
}
```

Limits vary by template (salmon freshwater temp optimal 12-18, sea bass optimal 18-24, shrimp optimal 26-32).

#### 4.2.2 Template Query

The `ListParameterTemplatesHandler` returns template metadata (id, name, description, species, parameter count, parameter codes) without the full limit data -- used for the template picker UI.

### Phase 3: Dynamic Evaluation in WaterQualityService

**Goal:** Replace the hardcoded `evaluateParameters()` with config-driven evaluation.

#### 4.3.1 Config Cache

Introduce a `ParameterConfigCacheService`:

```typescript
@Injectable()
export class ParameterConfigCacheService {
  private cache: Map<string, { configs: WaterQualityParameterConfig[]; loadedAt: number }>;
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  async getActiveConfigs(tenantId: string): Promise<WaterQualityParameterConfig[]>;
  invalidate(tenantId: string): void;
}
```

- In-memory Map keyed by tenantId
- 5-minute TTL, invalidated on any config mutation
- Falls back to hardcoded defaults if no configs exist (backward compatibility)

#### 4.3.2 Dynamic Evaluation Service

`WaterQualityEvaluationService`:

```typescript
@Injectable()
export class WaterQualityEvaluationService {
  constructor(
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async evaluate(
    tenantId: string,
    parameters: Record<string, unknown>,
    speciesCode?: string,
  ): Promise<WaterQualitySummary>;
}
```

Logic:
1. Fetch active configs for the tenant (from cache)
2. For each config where `isActive=true`:
   a. Look up the parameter value from `parameters[config.code]`
   b. If value is undefined and `isRequired=true`, mark as `NOT_MEASURED` warning
   c. If value is undefined and `isRequired=false`, skip
   d. Determine effective limits: if `speciesCode` is provided and `speciesLimits[speciesCode]` exists, use those; otherwise use the base limits
   e. Evaluate: `criticalLow < warningLow < optimalMin ... optimalMax < warningMax < criticalMax`
   f. Build `ParameterEvaluation` with the config's unit and name
3. Aggregate: compute overallStatus, counts, and recommendations
4. Return `WaterQualitySummary`

#### 4.3.3 Integration into WaterQualityService

Modify `WaterQualityService.create()` and `WaterQualityService.update()`:

```typescript
// Before (current):
measurement.evaluateParameters();

// After:
const summary = await this.evaluationService.evaluate(
  tenantId,
  measurement.parameters,
  speciesCode, // from batch or tank
);
measurement.overallStatus = summary.overallStatus;
measurement.summary = summary;
measurement.hasAlarm = summary.criticalCount > 0;
```

The existing `evaluateParameters()` method on the entity is preserved for backward compatibility (called when no tenant configs exist) but is deprecated.

#### 4.3.4 Validation on Create

Add a `validateMeasurementParameters()` method that:
1. Fetches active configs
2. Rejects unknown parameter keys not in the config (optional, configurable)
3. Validates `dataType` matches (number is a number, enum value is in `enumValues`)
4. Validates `isRequired` parameters are present
5. Throws `BadRequestException` with details on validation failure

This is called before saving in `WaterQualityService.create()`.

---

## 5. Frontend Implementation

### Phase 4: Parameter Config Management Page

**Goal:** Tenant admins manage their parameter configurations.

#### 5.4.1 New Hook: `useParameterConfigs`

File: `web/modules/farm-module/src/hooks/useParameterConfigs.ts`

```typescript
// Types
interface ParameterConfig {
  id: string;
  code: string;
  name: string;
  unit: string;
  dataType: 'number' | 'enum' | 'boolean';
  precision: number;
  group: ParameterGroup;
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  chartColor: string;
  icon: string | null;
  displayOrder: number;
  isVisible: boolean;
  isRequired: boolean;
  isActive: boolean;
  chartAxisGroup: string | null;
  isQuickAccess: boolean;
  templateSource: string | null;
}

interface ParameterTemplate {
  templateId: string;
  name: string;
  description: string;
  species: string[];
  parameterCount: number;
  parameterCodes: string[];
}

// Hooks
function useParameterConfigList(filters?: { group?: string; isActive?: boolean }): UseQueryResult;
function useParameterTemplates(): UseQueryResult;
function useCreateParameterConfig(): UseMutationResult;
function useUpdateParameterConfig(): UseMutationResult;
function useDeleteParameterConfig(): UseMutationResult;
function useApplyTemplate(): UseMutationResult;
function useReorderParameterConfigs(): UseMutationResult;
```

Query key: `['parameterConfigs', 'list', filters]` with `staleTime: 300000` (5 minutes, matching backend cache TTL).

#### 5.4.2 Parameter Config Management UI

File: `web/modules/farm-module/src/pages/water-chemistry/components/ParameterConfigManager.tsx`

Layout:
- **Header:** "Water Quality Parameters" title + "Apply Template" button
- **Template picker modal:** Card grid showing available templates with species tags, parameter count, "Apply" button. Confirm dialog warns about overwrite.
- **Parameter list:** Sortable (drag-and-drop via `displayOrder`) table/grid of active parameters:
  - Columns: drag handle, name, code, unit, group badge, optimal range, critical range, chart color swatch, active toggle, edit button, delete button
  - Group headers collapse/expand
- **Add parameter form:** Slide-over panel with all fields
- **Edit parameter form:** Same slide-over, pre-populated

Tailwind styling consistent with existing pages. No external component libraries.

### Phase 5: Dynamic History Tab

**Goal:** The History tab dynamically renders columns, charts, and filters based on the tenant's parameter configs.

#### 5.5.1 Dynamic Table Columns

Current `HistoryTab.tsx` hardcodes columns for Temp, DO, pH, NH3, NO2. Replace with:

```typescript
const { data: configs } = useParameterConfigList({ isActive: true });
const visibleConfigs = configs
  ?.filter(c => c.isVisible)
  .sort((a, b) => a.displayOrder - b.displayOrder) ?? [];

// Table header: Date | Tank | ...dynamicColumns | Status | Source
// Each dynamic column: header = config.name + unit, cell = parameters[config.code]
```

The table renders a column for each visible+active parameter config. Values are read from `measurement.parameters[config.code]` and formatted using `config.precision` and `config.unit`.

#### 5.5.2 Dynamic Chart Lines

Current chart hardcodes five `<Line>` components. Replace with:

```typescript
const chartConfigs = visibleConfigs.filter(c => c.dataType === 'number');
const leftAxisConfigs = chartConfigs.filter(c => c.chartAxisGroup !== 'right');
const rightAxisConfigs = chartConfigs.filter(c => c.chartAxisGroup === 'right');

// Render <Line> for each config
{chartConfigs.map(config => (
  <Line
    key={config.code}
    yAxisId={config.chartAxisGroup === 'right' ? 'right' : 'left'}
    type="monotone"
    dataKey={config.code}
    name={config.name}
    stroke={config.chartColor}
    strokeWidth={2}
    dot={false}
    connectNulls
  />
))}
```

Chart data transformation maps `measurement.parameters` to flat objects keyed by `config.code`.

Y-axis labels are generated from the configs: left axis shows units of left-grouped params, right axis shows units of right-grouped params.

#### 5.5.3 Dynamic Statistics Cards

Current statistics cards show avgTemperature, avgDO, avgPH. The backend `getTankStatistics()` will be extended to compute averages dynamically based on active configs. Frontend renders a card per visible config that has `isRequired=true` or is in `ParameterGroup.BASIC`.

#### 5.5.4 Parameter Visibility Toggle

Add a dropdown/popover in the History tab filter bar where users can toggle which parameters to show in the table and chart without changing the config (session-level preference, stored in `useState`).

### Phase 6: Dynamic Measurement Form

**Goal:** The "Create Measurement" form dynamically renders input fields based on the tenant's active parameter configs.

#### 5.6.1 Dynamic Form Fields

Current `CreateWaterQualityInput.parameters` is a fixed-shape object. The new form:

1. Fetches active configs sorted by `displayOrder`
2. Renders one form field per config:
   - `dataType=number`: `<input type="number" step={10^(-config.precision)}>` with min/max from critical limits
   - `dataType=enum`: `<select>` with options from `config.enumValues`
   - `dataType=boolean`: `<input type="checkbox">`
3. Required configs (`isRequired=true`) show a red asterisk
4. Fields are grouped by `config.group` with collapsible section headers
5. Real-time validation: input value checked against warning/critical limits with color indicators (green/yellow/red border)

#### 5.6.2 GraphQL Input Change

The `WaterParametersInput` DTO currently has hardcoded fields. For backward compatibility, we add a new `DynamicParametersInput` as a `GraphQLJSON` scalar alongside the existing input:

```typescript
@Field(() => GraphQLJSON, { nullable: true, description: 'Dynamic parameters keyed by config code' })
dynamicParameters?: Record<string, number | string | boolean>;
```

The service merges both: `{ ...input.parameters, ...input.dynamicParameters }`. This keeps backward compatibility with existing API consumers while enabling dynamic parameters.

---

## 6. GraphQL API Design

### 6.1 Queries

```graphql
# List parameter configs for the current tenant
query parameterConfigs(
  filter: ParameterConfigFilterInput
): [WaterQualityParameterConfig!]!

# Get single parameter config by ID
query parameterConfig(id: ID!): WaterQualityParameterConfig

# Get parameter config by code
query parameterConfigByCode(code: String!): WaterQualityParameterConfig

# List available templates
query parameterTemplates: [ParameterTemplate!]!

# Get template details including full parameter definitions
query parameterTemplate(templateId: String!): ParameterTemplateDetail
```

### 6.2 Mutations

```graphql
# Create a single parameter config
mutation createParameterConfig(
  input: CreateParameterConfigInput!
): WaterQualityParameterConfig!

# Update a parameter config
mutation updateParameterConfig(
  input: UpdateParameterConfigInput!
): WaterQualityParameterConfig!

# Delete a parameter config (soft-delete via isActive=false recommended)
mutation deleteParameterConfig(id: ID!): Boolean!

# Apply a template (bulk-create parameters from template)
mutation applyParameterTemplate(
  input: ApplyParameterTemplateInput!
): [WaterQualityParameterConfig!]!

# Reorder parameters (update displayOrder for multiple configs)
mutation reorderParameterConfigs(
  input: ReorderParameterConfigsInput!
): [WaterQualityParameterConfig!]!
```

### 6.3 Type Definitions (Code-First)

```typescript
@ObjectType()
export class WaterQualityParameterConfig {
  @Field(() => ID) id: string;
  @Field() code: string;
  @Field() name: string;
  @Field() unit: string;
  @Field(() => ParameterDataType) dataType: ParameterDataType;
  @Field(() => Int) precision: number;
  @Field(() => ParameterGroup) group: ParameterGroup;
  @Field(() => Float, { nullable: true }) optimalMin: number | null;
  @Field(() => Float, { nullable: true }) optimalMax: number | null;
  @Field(() => Float, { nullable: true }) warningMin: number | null;
  @Field(() => Float, { nullable: true }) warningMax: number | null;
  @Field(() => Float, { nullable: true }) criticalMin: number | null;
  @Field(() => Float, { nullable: true }) criticalMax: number | null;
  @Field(() => GraphQLJSON, { nullable: true }) speciesLimits: Record<string, unknown> | null;
  @Field(() => [String], { nullable: true }) enumValues: string[] | null;
  @Field() chartColor: string;
  @Field({ nullable: true }) icon: string | null;
  @Field(() => Int) displayOrder: number;
  @Field() isVisible: boolean;
  @Field() isRequired: boolean;
  @Field() isActive: boolean;
  @Field({ nullable: true }) chartAxisGroup: string | null;
  @Field() isQuickAccess: boolean;
  @Field({ nullable: true }) templateSource: string | null;
  @Field() createdAt: Date;
  @Field() updatedAt: Date;
}

@InputType()
export class ParameterConfigFilterInput {
  @Field(() => ParameterGroup, { nullable: true }) group?: ParameterGroup;
  @Field({ nullable: true }) isActive?: boolean;
  @Field({ nullable: true }) isVisible?: boolean;
}

@InputType()
export class ApplyParameterTemplateInput {
  @Field() templateId: string;
  @Field({ defaultValue: false }) overwrite: boolean;
}

@InputType()
export class ReorderParameterConfigsInput {
  @Field(() => [ID]) orderedIds: string[];
}

@ObjectType()
export class ParameterTemplate {
  @Field() templateId: string;
  @Field() name: string;
  @Field() description: string;
  @Field(() => [String]) species: string[];
  @Field(() => Int) parameterCount: number;
  @Field(() => [String]) parameterCodes: string[];
}
```

---

## 7. Migration Strategy

### 7.1 Database Migration

The `WaterQualityParameterConfig` entity uses `TypeORM.synchronize` in development (controlled by `DATABASE_SYNC` env var). For production, generate a migration:

```bash
npx typeorm migration:generate -d apps/farm-service/src/data-source.ts -n AddWaterQualityParameterConfig
```

The migration creates the `water_quality_parameter_configs` table in the `farm` source schema. The `TenantSchemaSyncService` automatically replicates it to all existing `tenant_*` schemas.

### 7.2 Backward Compatibility

1. **No configs = hardcoded defaults.** If a tenant has zero `WaterQualityParameterConfig` rows, the existing `evaluateParameters()` method on the entity is used unchanged. This means zero risk for existing tenants.

2. **Gradual migration.** Tenants can be migrated by an admin action ("Apply Template") or by a one-time seed script that creates configs matching the current hardcoded defaults.

3. **Seed script for existing tenants.** A CLI command or admin mutation `seedDefaultParameterConfigs(tenantId)` that creates configs matching the current hardcoded interface:
   - Maps each key from the existing `WaterParameters` interface to a config row
   - Uses the existing hardcoded limits from `evaluateParameters()` as default values
   - Sets `isActive=true` for the 10 commonly used parameters, `isActive=false` for the rest

### 7.3 Data Compatibility

The JSONB `parameters` column on `WaterQualityMeasurement` does not change. Existing measurements with keys like `temperature`, `dissolvedOxygen`, etc. continue to work because:

1. The template configs use the same `code` values as the existing `WaterParameters` interface keys
2. The evaluation service reads `parameters[config.code]` -- same keys
3. The frontend reads `measurement.parameters[config.code]` -- same keys

New tenant-defined parameters (e.g., `vibrio_count`) simply use new keys that did not exist before. Old measurements for that tenant will have `undefined` for those keys, which is handled gracefully (displayed as `-`).

### 7.4 Frontend Compatibility

The existing `WaterParameters` TypeScript interface on the frontend remains for type hints but is no longer the source of truth for what to render. The dynamic rendering reads from the API. The old hardcoded columns/charts are replaced by config-driven ones. If the API returns an empty config list, the frontend falls back to the hardcoded five-column view.

---

## 8. File Map

### 8.1 New Files to Create

**Backend (farm-service):**

```
apps/farm-service/src/water-quality/
  entities/
    water-quality-parameter-config.entity.ts        # New entity
  dto/
    create-parameter-config.input.ts                # Create DTO
    update-parameter-config.input.ts                # Update DTO
    apply-parameter-template.input.ts               # Template apply DTO
    reorder-parameter-configs.input.ts              # Reorder DTO
    parameter-config-filter.input.ts                # Filter DTO
  commands/
    create-parameter-config.command.ts              # CQRS command
    update-parameter-config.command.ts              # CQRS command
    delete-parameter-config.command.ts              # CQRS command
    bulk-create-from-template.command.ts            # CQRS command
    reorder-parameter-configs.command.ts            # CQRS command
  queries/
    list-parameter-configs.query.ts                 # CQRS query
    get-parameter-config.query.ts                   # CQRS query
    get-parameter-config-by-code.query.ts           # CQRS query
    list-parameter-templates.query.ts               # CQRS query
  handlers/
    create-parameter-config.handler.ts              # Command handler
    update-parameter-config.handler.ts              # Command handler
    delete-parameter-config.handler.ts              # Command handler
    bulk-create-from-template.handler.ts            # Command handler
    reorder-parameter-configs.handler.ts            # Command handler
    list-parameter-configs.handler.ts               # Query handler
    get-parameter-config.handler.ts                 # Query handler
    get-parameter-config-by-code.handler.ts         # Query handler
    list-parameter-templates.handler.ts             # Query handler
  services/
    parameter-config-cache.service.ts               # In-memory cache
    water-quality-evaluation.service.ts             # Dynamic evaluation
  data/
    parameter-templates.data.ts                     # Template constant arrays
  water-quality-parameter-config.resolver.ts        # GraphQL resolver
```

**Frontend (farm-module):**

```
web/modules/farm-module/src/
  hooks/
    useParameterConfigs.ts                          # React Query hooks + GraphQL
  pages/water-chemistry/components/
    ParameterConfigManager.tsx                      # Admin config management UI
    ParameterConfigForm.tsx                         # Create/edit form slide-over
    TemplatePickerModal.tsx                         # Template selection modal
    DynamicMeasurementForm.tsx                      # Dynamic create measurement form
```

### 8.2 Files to Modify

**Backend:**

```
apps/farm-service/src/water-quality/
  water-quality.module.ts                           # Register new entity, handlers, services, resolver
  water-quality.service.ts                          # Inject evaluation service, replace evaluateParameters()
  dto/create-water-quality.input.ts                 # Add dynamicParameters field
  dto/index.ts                                      # Export new DTOs
```

**Frontend:**

```
web/modules/farm-module/src/
  hooks/useWaterQuality.ts                          # Add dynamicParameters to CreateInput type
  pages/water-chemistry/components/HistoryTab.tsx   # Dynamic columns, charts, stats from configs
  pages/water-chemistry/WaterChemistryPage.tsx      # Add "Parameters" tab for config management
```

---

## 9. Implementation Order

Tasks are ordered by dependency. Each phase can be implemented and tested independently before proceeding.

```
Phase 1: Core Entity + CRUD (Backend)
├── 1.1 Create entity: water-quality-parameter-config.entity.ts
├── 1.2 Create enums: ParameterDataType, ParameterGroup
├── 1.3 Create DTOs: create, update, filter, apply-template, reorder inputs
├── 1.4 Create CQRS commands and queries (plain classes)
├── 1.5 Create command handlers (create, update, delete, reorder)
├── 1.6 Create query handlers (list, get, get-by-code)
├── 1.7 Create resolver: water-quality-parameter-config.resolver.ts
├── 1.8 Update water-quality.module.ts (register everything)
└── 1.9 Test: verify CRUD via GraphQL playground

Phase 2: Templates (Backend)
├── 2.1 Create parameter-templates.data.ts (5 templates)
├── 2.2 Create list-parameter-templates.handler.ts
├── 2.3 Create bulk-create-from-template.handler.ts
├── 2.4 Add template queries/mutations to resolver
└── 2.5 Test: apply template, verify configs created

Phase 3: Dynamic Evaluation (Backend)
├── 3.1 Create parameter-config-cache.service.ts
├── 3.2 Create water-quality-evaluation.service.ts
├── 3.3 Modify water-quality.service.ts (inject evaluation service)
├── 3.4 Add dynamicParameters to CreateWaterQualityInput
├── 3.5 Add validation logic (validateMeasurementParameters)
└── 3.6 Test: create measurement with dynamic params, verify evaluation

Phase 4: Config Management UI (Frontend)
├── 4.1 Create useParameterConfigs.ts hook
├── 4.2 Create TemplatePickerModal.tsx
├── 4.3 Create ParameterConfigForm.tsx
├── 4.4 Create ParameterConfigManager.tsx
├── 4.5 Add "Parameters" tab to WaterChemistryPage.tsx
└── 4.6 Test: end-to-end config management flow

Phase 5: Dynamic History Tab (Frontend)
├── 5.1 Modify HistoryTab.tsx - dynamic table columns
├── 5.2 Modify HistoryTab.tsx - dynamic chart lines
├── 5.3 Modify HistoryTab.tsx - dynamic statistics cards
├── 5.4 Add parameter visibility toggle
└── 5.5 Test: verify table/chart adapts to config changes

Phase 6: Dynamic Measurement Form (Frontend)
├── 6.1 Create DynamicMeasurementForm.tsx
├── 6.2 Update useWaterQuality.ts types
├── 6.3 Integrate form into measurement creation flow
├── 6.4 Add real-time limit validation with color indicators
└── 6.5 Test: create measurement with dynamic form fields
```

Estimated effort per phase:

| Phase | Files | Estimated Lines | Dependency |
|-------|-------|----------------|------------|
| 1 | 18 | ~1200 | None |
| 2 | 3 | ~600 | Phase 1 |
| 3 | 4 | ~400 | Phase 1 |
| 4 | 5 | ~800 | Phase 1, 2 |
| 5 | 1 (major edit) | ~300 (net change) | Phase 1, 4 |
| 6 | 2 | ~400 | Phase 1, 3, 4 |

---

## 10. Risk Assessment

### 10.1 Performance Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Config cache miss on every measurement creation | Low | Medium | 5-min TTL cache, warm on first request. Config changes are rare (~once per month per tenant). |
| Large number of configs per tenant slows table rendering | Low | Low | Cap at 100 configs per tenant. Pagination if needed. Most tenants will have 10-20 params. |
| Chart with 20+ lines is unreadable | Medium | Medium | Default `isVisible=false` for non-essential params. User toggles visibility. Show max 10 lines by default. |
| JSONB parameters column grows unbounded | Low | Low | JSON keys are short strings, values are numbers. 30 parameters ~ 500 bytes. Negligible. |

### 10.2 Data Integrity Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tenant deletes a config but historical data uses that code | Medium | Medium | Soft-delete (`isActive=false`) is recommended over hard delete. If hard-deleted, historical data shows the raw code as column header (graceful degradation). |
| Config code collision across templates | Low | High | Unique constraint `(tenantId, code)`. Apply-template skips existing codes by default. |
| Species-specific limits JSONB has invalid structure | Low | Medium | Validate `speciesLimits` shape at DTO level with a custom validator. |
| Existing measurements have keys not in configs | None | None | Config-driven rendering shows `-` for missing values. No data loss. |

### 10.3 UX Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Tenant admin overwhelmed by config complexity | Medium | Medium | Template system reduces friction. "Apply Template" is the primary onboarding path. Individual config editing is for power users. |
| Dynamic form is confusing vs. the old static form | Low | Medium | Group parameters by category. Show only `isRequired` fields by default, expandable sections for optional params. |
| Chart axis confusion with mixed units | Medium | Medium | Two Y-axes (left/right) as currently implemented. Group similar-unit params on same axis. Tooltip shows unit explicitly. |

### 10.4 Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Cache desync across farm-service replicas | Medium | Low | In-memory cache is per-instance. Each replica builds its own cache. For multi-replica deployments, consider Redis cache in a future iteration. The 5-min TTL bounds staleness. |
| Migration fails on tenant schemas | Low | High | `TenantSchemaSyncService` handles DDL propagation automatically. Test with a representative tenant schema before production deploy. |
| Template data drifts from best practices | Low | Medium | Templates are version-controlled TypeScript constants. Aquaculture domain experts review template changes in PR. |

### 10.5 Open Questions

1. **Should we allow tenants to define calculated parameters?** E.g., TAN = ammonia + ammonium. This is excluded from v1 scope but the `dataType` enum could be extended with `calculated` in a future iteration.

2. **Should parameter configs be scoped to sites/ponds as well as tenants?** Some tenants may track different parameters at different sites. v1 scopes to tenant only; site-level overrides can be added later via a `siteId` nullable FK on the config.

3. **Should we expose a "diff" when applying a template over existing configs?** Useful for transparency but adds UI complexity. Deferred to v2.

4. **Redis cache vs. in-memory.** In-memory is sufficient for single-replica deployments. If the farm-service scales to multiple replicas, introduce Redis with pub/sub invalidation. Document the upgrade path but do not implement in v1.
