# Modular Pricing System Implementation Plan

## Executive Summary

Bu plan, aquaculture platformu için esnek, metered-billing destekli modüler fiyatlandırma sistemi tasarımını içerir.

**Hedef**: Stripe/Chargebee benzeri bir sistem - modül bazlı fiyatlandırma + metrik bazlı kullanım ölçümü + esnek plan oluşturma.

---

## Mevcut Durum Analizi

### Var Olanlar ✅
1. **Module Entity** (auth-service) - code, name, description, isActive
2. **TenantModule** (auth-service) - tenant-module assignment, configuration, expiration
3. **PlanDefinition** (admin-api-service) - tier, limits, pricing, features
4. **Subscription** (billing-service) - tenant subscription, status, billing cycle
5. **Invoice/Payment** (billing-service) - line items, payments

### Eksikler ❌
1. **Module Pricing** - Modül başına fiyat tanımı (tier bazlı)
2. **Pricing Metrics** - per_user, per_farm, per_sensor fiyatları
3. **Subscription-Module Link** - Hangi modüller aboneliğe dahil
4. **Usage Tracking** - Tenant kullanım metrikleri
5. **Custom Plan Builder** - Modül kombinasyonlarından plan oluşturma

---

## Yeni Database Schema

### 1. Pricing Metric Types (Enum)

```typescript
enum PricingMetricType {
  BASE_PRICE = 'base_price',      // Modül temel ücret
  PER_USER = 'per_user',          // Kullanıcı başına
  PER_FARM = 'per_farm',          // Çiftlik başına
  PER_POND = 'per_pond',          // Havuz başına
  PER_SENSOR = 'per_sensor',      // Sensör başına
  PER_GB_STORAGE = 'per_gb_storage',  // GB başına depolama
  PER_API_CALL = 'per_api_call',  // API çağrısı başına
  PER_ALERT = 'per_alert',        // Alarm başına
  PER_REPORT = 'per_report',      // Rapor başına
}
```

### 2. Module Pricing Entity (NEW)

```sql
CREATE TABLE module_pricing (
  id UUID PRIMARY KEY,
  module_id UUID REFERENCES system_modules(id),

  -- Fiyatlandırma metrikleri (JSONB)
  pricing_metrics JSONB NOT NULL DEFAULT '[]',
  -- Örnek:
  -- [
  --   { "type": "base_price", "price": 50.00, "currency": "USD" },
  --   { "type": "per_user", "price": 10.00, "currency": "USD" },
  --   { "type": "per_sensor", "price": 2.00, "currency": "USD" }
  -- ]

  -- Tier bazlı fiyat çarpanı
  tier_multipliers JSONB DEFAULT '{}',
  -- { "STARTER": 1.0, "PROFESSIONAL": 0.9, "ENTERPRISE": 0.7 }

  -- Geçerlilik
  effective_from TIMESTAMP NOT NULL DEFAULT NOW(),
  effective_to TIMESTAMP,

  -- Meta
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(module_id, effective_from)
);
```

### 3. Plan Module Assignment (NEW)

```sql
CREATE TABLE plan_module_assignments (
  id UUID PRIMARY KEY,
  plan_id UUID REFERENCES plan_definitions(id),
  module_id UUID REFERENCES system_modules(id),

  -- Dahil edilen miktarlar
  included_quantities JSONB DEFAULT '{}',
  -- { "users": 5, "farms": 2, "sensors": 10, "storage_gb": 5 }

  is_required BOOLEAN DEFAULT false,  -- Planın zorunlu parçası mı
  sort_order INT DEFAULT 0,

  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(plan_id, module_id)
);
```

### 4. Subscription Module Line Items (NEW)

```sql
CREATE TABLE subscription_module_items (
  id UUID PRIMARY KEY,
  subscription_id UUID REFERENCES subscriptions(id),
  module_id UUID REFERENCES system_modules(id),

  -- Kullanım miktarları
  quantities JSONB NOT NULL DEFAULT '{}',
  -- { "users": 15, "farms": 3, "sensors": 50, "storage_gb": 20 }

  -- Hesaplanan fiyatlar
  line_items JSONB NOT NULL DEFAULT '[]',
  -- [
  --   { "metric": "base_price", "qty": 1, "unit_price": 50, "total": 50 },
  --   { "metric": "per_user", "qty": 15, "unit_price": 10, "total": 150 },
  --   { "metric": "per_sensor", "qty": 50, "unit_price": 2, "total": 100 }
  -- ]

  subtotal DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) NOT NULL,

  status VARCHAR(20) DEFAULT 'active',  -- active, cancelled, upgraded
  activated_at TIMESTAMP DEFAULT NOW(),
  cancelled_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(subscription_id, module_id)
);
```

### 5. Tenant Usage Metrics (NEW)

```sql
CREATE TABLE tenant_usage_metrics (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  module_id UUID REFERENCES system_modules(id),

  -- Billing period
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,

  -- Usage counts
  metrics JSONB NOT NULL DEFAULT '{}',
  -- {
  --   "users": { "current": 15, "peak": 18, "average": 14.5 },
  --   "farms": { "current": 3, "peak": 3, "average": 3 },
  --   "sensors": { "current": 50, "peak": 55, "average": 48 },
  --   "storage_gb": { "current": 20.5, "peak": 22.1, "average": 18.3 },
  --   "api_calls": { "total": 125000 }
  -- }

  -- Hesaplanan maliyet
  calculated_cost DECIMAL(12,2),

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(tenant_id, module_id, period_start)
);
```

### 6. Custom Plans (NEW)

```sql
CREATE TABLE custom_plans (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,  -- Hangi tenant için

  name VARCHAR(100) NOT NULL,
  description TEXT,

  -- Kaynak plan (varsa)
  base_plan_id UUID REFERENCES plan_definitions(id),

  -- Custom yapılandırma
  modules JSONB NOT NULL DEFAULT '[]',
  -- [
  --   { "module_id": "uuid", "quantities": { "users": 20, "sensors": 100 } },
  --   { "module_id": "uuid", "quantities": { "users": 10 } }
  -- ]

  -- Fiyatlandırma
  monthly_total DECIMAL(12,2) NOT NULL,
  discount_percent DECIMAL(5,2) DEFAULT 0,
  final_monthly DECIMAL(12,2) NOT NULL,

  -- Geçerlilik
  valid_from DATE NOT NULL,
  valid_to DATE,

  status VARCHAR(20) DEFAULT 'draft',  -- draft, active, expired
  approved_by UUID,
  approved_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

---

## Backend Implementation

### Phase 1: Database & Entities

#### 1.1 Module Pricing Entity

**File**: `apps/admin-api-service/src/billing/entities/module-pricing.entity.ts`

```typescript
@Entity('module_pricing')
export class ModulePricing {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  moduleId: string;

  @ManyToOne(() => SystemModule)
  @JoinColumn({ name: 'module_id' })
  module: SystemModule;

  @Column('jsonb', { default: [] })
  pricingMetrics: PricingMetric[];

  @Column('jsonb', { default: {} })
  tierMultipliers: Record<PlanTier, number>;

  @Column({ type: 'timestamp', default: () => 'NOW()' })
  effectiveFrom: Date;

  @Column({ type: 'timestamp', nullable: true })
  effectiveTo: Date | null;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

interface PricingMetric {
  type: PricingMetricType;
  price: number;
  currency: string;
  description?: string;
}
```

#### 1.2 Subscription Module Item Entity

**File**: `apps/billing-service/src/billing/entities/subscription-module-item.entity.ts`

```typescript
@Entity('subscription_module_items')
export class SubscriptionModuleItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  subscriptionId: string;

  @ManyToOne(() => Subscription, sub => sub.moduleItems)
  @JoinColumn({ name: 'subscription_id' })
  subscription: Subscription;

  @Column('uuid')
  moduleId: string;

  @Column('jsonb', { default: {} })
  quantities: ModuleQuantities;

  @Column('jsonb', { default: [] })
  lineItems: ModuleLineItem[];

  @Column('decimal', { precision: 12, scale: 2 })
  subtotal: number;

  @Column('decimal', { precision: 12, scale: 2, default: 0 })
  discountAmount: number;

  @Column('decimal', { precision: 12, scale: 2 })
  total: number;

  @Column({ default: 'active' })
  status: 'active' | 'cancelled' | 'upgraded';

  @Column({ type: 'timestamp', default: () => 'NOW()' })
  activatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  cancelledAt: Date | null;
}

interface ModuleQuantities {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  storageGb?: number;
  apiCalls?: number;
}

interface ModuleLineItem {
  metric: PricingMetricType;
  quantity: number;
  unitPrice: number;
  total: number;
}
```

### Phase 2: Services

#### 2.1 Module Pricing Service

**File**: `apps/admin-api-service/src/billing/services/module-pricing.service.ts`

```typescript
@Injectable()
export class ModulePricingService {

  // Get active pricing for a module
  async getModulePricing(moduleId: string): Promise<ModulePricing | null>

  // Get all module pricings with modules info
  async getAllModulePricings(): Promise<ModulePricingWithModule[]>

  // Create/Update module pricing
  async setModulePricing(dto: SetModulePricingDto): Promise<ModulePricing>

  // Calculate price for specific module with quantities
  async calculateModulePrice(
    moduleId: string,
    quantities: ModuleQuantities,
    tier: PlanTier,
    billingCycle: BillingCycle
  ): Promise<ModulePriceCalculation>

  // Get pricing history for a module
  async getPricingHistory(moduleId: string): Promise<ModulePricing[]>
}
```

#### 2.2 Pricing Calculator Service

**File**: `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts`

```typescript
@Injectable()
export class PricingCalculatorService {

  // Calculate total for multiple modules
  async calculateTotal(
    modules: ModuleSelection[],
    tier: PlanTier,
    billingCycle: BillingCycle,
    discountCode?: string
  ): Promise<PricingCalculation>

  // Generate quote for tenant
  async generateQuote(dto: QuoteRequestDto): Promise<Quote>

  // Compare pricing between configurations
  async comparePricing(
    config1: ModuleSelection[],
    config2: ModuleSelection[],
    tier: PlanTier
  ): Promise<PricingComparison>
}

interface ModuleSelection {
  moduleId: string;
  quantities: ModuleQuantities;
}

interface PricingCalculation {
  modules: ModulePriceBreakdown[];
  subtotal: number;
  discount: { code?: string; amount: number; percent: number };
  tax: number;
  total: number;
  billingCycle: BillingCycle;
  effectiveDate: Date;
}
```

#### 2.3 Custom Plan Service

**File**: `apps/admin-api-service/src/billing/services/custom-plan.service.ts`

```typescript
@Injectable()
export class CustomPlanService {

  // Create custom plan for tenant
  async createCustomPlan(dto: CreateCustomPlanDto): Promise<CustomPlan>

  // Get custom plan by tenant
  async getCustomPlanByTenant(tenantId: string): Promise<CustomPlan | null>

  // Approve custom plan
  async approveCustomPlan(planId: string, approverId: string): Promise<CustomPlan>

  // Convert to subscription
  async activateCustomPlan(planId: string): Promise<Subscription>
}
```

### Phase 3: API Endpoints

#### 3.1 Module Pricing Controller

**File**: `apps/admin-api-service/src/billing/module-pricing.controller.ts`

```typescript
@Controller('billing/module-pricing')
export class ModulePricingController {

  @Get()
  async getAllPricings(): Promise<ModulePricingDto[]>

  @Get(':moduleId')
  async getModulePricing(@Param('moduleId') moduleId: string): Promise<ModulePricingDto>

  @Post()
  async setModulePricing(@Body() dto: SetModulePricingDto): Promise<ModulePricingDto>

  @Post('calculate')
  async calculatePrice(@Body() dto: CalculatePriceDto): Promise<PricingCalculation>

  @Get(':moduleId/history')
  async getPricingHistory(@Param('moduleId') moduleId: string): Promise<ModulePricingDto[]>
}
```

#### 3.2 Quote Controller

**File**: `apps/admin-api-service/src/billing/quote.controller.ts`

```typescript
@Controller('billing/quotes')
export class QuoteController {

  @Post()
  async generateQuote(@Body() dto: QuoteRequestDto): Promise<Quote>

  @Post('compare')
  async compareConfigurations(@Body() dto: CompareDto): Promise<PricingComparison>

  @Get('estimate')
  async getEstimate(@Query() query: EstimateQueryDto): Promise<QuickEstimate>
}
```

#### 3.3 Custom Plan Controller

**File**: `apps/admin-api-service/src/billing/custom-plan.controller.ts`

```typescript
@Controller('billing/custom-plans')
export class CustomPlanController {

  @Get()
  async listCustomPlans(@Query() query: ListCustomPlansDto): Promise<PaginatedResult<CustomPlan>>

  @Get('tenant/:tenantId')
  async getByTenant(@Param('tenantId') tenantId: string): Promise<CustomPlan>

  @Post()
  async createCustomPlan(@Body() dto: CreateCustomPlanDto): Promise<CustomPlan>

  @Post(':id/approve')
  async approvePlan(@Param('id') id: string): Promise<CustomPlan>

  @Post(':id/activate')
  async activatePlan(@Param('id') id: string): Promise<Subscription>
}
```

---

## Frontend Implementation

### Phase 4: Admin Panel UI

#### 4.1 Module Pricing Editor Page

**File**: `web/modules/admin-panel/src/pages/ModulePricingPage.tsx`

**Özellikler**:
- Tüm modülleri listele (grid/table)
- Her modül için pricing metrics düzenleme
- Tier multiplier ayarları
- Pricing history görüntüleme
- Bulk pricing update

**UI Bileşenleri**:
```
┌─────────────────────────────────────────────────────────────┐
│ Module Pricing Management                        [Save All] │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ IoT Sensors Module                          [Edit] [▼] │ │
│ │ ├─ Base Price: $50/month                               │ │
│ │ ├─ Per User: $10/month                                 │ │
│ │ ├─ Per Sensor: $2/month                                │ │
│ │ └─ Per GB: $0.10/month                                 │ │
│ │                                                         │ │
│ │ Tier Multipliers: STARTER(1.0) PRO(0.9) ENT(0.7)      │ │
│ └─────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Advanced Analytics Module                   [Edit] [▼] │ │
│ │ ├─ Base Price: $100/month                              │ │
│ │ ├─ Per User: $25/month                                 │ │
│ │ └─ Per Report: $1/report                               │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

#### 4.2 Plan Builder Page

**File**: `web/modules/admin-panel/src/pages/PlanBuilderPage.tsx`

**Özellikler**:
- Mevcut planı base olarak seç veya sıfırdan başla
- Modülleri drag-drop ile ekle
- Her modül için quantity ayarla
- Real-time fiyat hesaplama
- Plan preview ve compare

**UI Bileşenleri**:
```
┌─────────────────────────────────────────────────────────────┐
│ Plan Builder                                                │
├─────────────────────────────────────────────────────────────┤
│ ┌──────────────────────┐  ┌────────────────────────────────┐│
│ │ Available Modules    │  │ Plan Configuration             ││
│ │                      │  │                                ││
│ │ [+] IoT Sensors     │→ │ Plan Name: [Ultra Farming    ] ││
│ │ [+] Analytics       │  │ Base Plan: [Professional    ▼] ││
│ │ [+] Farm Management │  │                                ││
│ │ [+] HR Module       │  │ Selected Modules:              ││
│ │ [+] Alerts          │  │ ┌────────────────────────────┐ ││
│ │ [+] Reports         │  │ │ IoT Sensors        [Remove]│ ││
│ │                      │  │ │ Users: [15] Sensors: [100]│ ││
│ │                      │  │ │ Subtotal: $350/mo         │ ││
│ │                      │  │ └────────────────────────────┘ ││
│ │                      │  │ ┌────────────────────────────┐ ││
│ │                      │  │ │ Analytics          [Remove]│ ││
│ │                      │  │ │ Users: [15]                │ ││
│ │                      │  │ │ Subtotal: $475/mo         │ ││
│ │                      │  │ └────────────────────────────┘ ││
│ └──────────────────────┘  └────────────────────────────────┘│
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ Price Summary                                           │ │
│ │ Modules Subtotal:     $825.00                          │ │
│ │ Tier Discount (10%):  -$82.50                          │ │
│ │ ─────────────────────────────────                      │ │
│ │ Monthly Total:        $742.50                          │ │
│ │                                                         │ │
│ │ [Save as Template]  [Create for Tenant]  [Get Quote]   │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

#### 4.3 Enhanced Tenant Creation

**File**: `web/modules/admin-panel/src/pages/CreateTenantPage.tsx` (UPDATE)

**Değişiklikler**:
- Step 3'te modül seçimi + quantity input
- Real-time pricing calculation
- Custom plan auto-generation
- Price breakdown preview

#### 4.4 Subscription Details Page (NEW/UPDATE)

**File**: `web/modules/admin-panel/src/pages/SubscriptionDetailsPage.tsx`

**Özellikler**:
- Module line items görüntüleme
- Usage metrics dashboard
- Upgrade/downgrade modüller
- Proration hesaplama

---

## API Service Updates

### admin-api.service.ts Updates

```typescript
// Module Pricing
export const modulePricingApi = {
  getAll: () => apiClient.get('/billing/module-pricing'),
  getByModule: (moduleId: string) => apiClient.get(`/billing/module-pricing/${moduleId}`),
  set: (dto: SetModulePricingDto) => apiClient.post('/billing/module-pricing', dto),
  calculate: (dto: CalculatePriceDto) => apiClient.post('/billing/module-pricing/calculate', dto),
};

// Quotes
export const quoteApi = {
  generate: (dto: QuoteRequestDto) => apiClient.post('/billing/quotes', dto),
  compare: (dto: CompareDto) => apiClient.post('/billing/quotes/compare', dto),
};

// Custom Plans
export const customPlanApi = {
  list: (params?: ListParams) => apiClient.get('/billing/custom-plans', { params }),
  getByTenant: (tenantId: string) => apiClient.get(`/billing/custom-plans/tenant/${tenantId}`),
  create: (dto: CreateCustomPlanDto) => apiClient.post('/billing/custom-plans', dto),
  approve: (id: string) => apiClient.post(`/billing/custom-plans/${id}/approve`),
  activate: (id: string) => apiClient.post(`/billing/custom-plans/${id}/activate`),
};
```

---

## Implementation Phases

### Phase 1: Database Foundation (Backend)
1. ✅ Create migration for new tables
2. ✅ Create TypeORM entities
3. ✅ Update existing entities with relations
4. ✅ Seed default module pricing data

### Phase 2: Core Services (Backend)
1. ✅ ModulePricingService
2. ✅ PricingCalculatorService
3. ✅ CustomPlanService
4. ✅ Update SubscriptionManagementService

### Phase 3: API Layer (Backend)
1. ✅ ModulePricingController
2. ✅ QuoteController
3. ✅ CustomPlanController
4. ✅ Update existing billing endpoints

### Phase 4: Admin UI (Frontend)
1. ✅ ModulePricingPage
2. ✅ PlanBuilderPage
3. ✅ Update CreateTenantPage
4. ✅ SubscriptionDetailsPage enhancements

### Phase 5: Integration & Testing
1. ✅ End-to-end tenant creation flow
2. ✅ Pricing calculation accuracy tests
3. ✅ Invoice generation with module breakdown
4. ✅ Usage tracking integration

---

## Default Module Pricing Data

```typescript
const defaultModulePricing = [
  {
    moduleCode: 'farm',
    name: 'Farm Management',
    metrics: [
      { type: 'base_price', price: 50 },
      { type: 'per_user', price: 10 },
      { type: 'per_farm', price: 25 },
    ]
  },
  {
    moduleCode: 'sensor',
    name: 'IoT Sensors',
    metrics: [
      { type: 'base_price', price: 75 },
      { type: 'per_user', price: 10 },
      { type: 'per_sensor', price: 2 },
      { type: 'per_gb_storage', price: 0.10 },
    ]
  },
  {
    moduleCode: 'alert',
    name: 'Alert Engine',
    metrics: [
      { type: 'base_price', price: 30 },
      { type: 'per_user', price: 5 },
      { type: 'per_alert', price: 0.05 },
    ]
  },
  {
    moduleCode: 'analytics',
    name: 'Advanced Analytics',
    metrics: [
      { type: 'base_price', price: 100 },
      { type: 'per_user', price: 25 },
      { type: 'per_report', price: 1 },
      { type: 'per_gb_storage', price: 0.50 },
    ]
  },
  {
    moduleCode: 'hr',
    name: 'HR Management',
    metrics: [
      { type: 'base_price', price: 40 },
      { type: 'per_user', price: 8 },
    ]
  },
  {
    moduleCode: 'billing',
    name: 'Billing & Invoicing',
    metrics: [
      { type: 'base_price', price: 25 },
      { type: 'per_user', price: 5 },
    ]
  },
];
```

---

## Success Criteria

1. **Module Pricing**: Admin can set per-metric prices for each module
2. **Real-time Calculation**: Tenant creation shows accurate pricing
3. **Custom Plans**: Can create tenant-specific module combinations
4. **Invoice Breakdown**: Invoices show module-level line items
5. **Usage Tracking**: System tracks tenant usage per metric
6. **Plan Templates**: Pre-defined plans with module bundles

---

## File Changes Summary

### New Files (Backend)
- `apps/admin-api-service/src/billing/entities/module-pricing.entity.ts`
- `apps/admin-api-service/src/billing/entities/plan-module-assignment.entity.ts`
- `apps/admin-api-service/src/billing/entities/custom-plan.entity.ts`
- `apps/billing-service/src/billing/entities/subscription-module-item.entity.ts`
- `apps/billing-service/src/billing/entities/tenant-usage-metrics.entity.ts`
- `apps/admin-api-service/src/billing/services/module-pricing.service.ts`
- `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts`
- `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
- `apps/admin-api-service/src/billing/module-pricing.controller.ts`
- `apps/admin-api-service/src/billing/quote.controller.ts`
- `apps/admin-api-service/src/billing/custom-plan.controller.ts`

### New Files (Frontend)
- `web/modules/admin-panel/src/pages/ModulePricingPage.tsx`
- `web/modules/admin-panel/src/pages/PlanBuilderPage.tsx`
- `web/modules/admin-panel/src/components/pricing/PricingCalculator.tsx`
- `web/modules/admin-panel/src/components/pricing/ModuleSelector.tsx`
- `web/modules/admin-panel/src/components/pricing/PriceSummary.tsx`

### Updated Files
- `apps/billing-service/src/billing/entities/subscription.entity.ts` - Add moduleItems relation
- `apps/admin-api-service/src/billing/billing.module.ts` - Register new services/controllers
- `web/modules/admin-panel/src/pages/CreateTenantPage.tsx` - Enhanced module selection
- `web/modules/admin-panel/src/services/adminApi.ts` - New API methods

---

## Estimated Effort

| Phase | Estimated Time |
|-------|----------------|
| Phase 1: Database | 4-6 hours |
| Phase 2: Services | 6-8 hours |
| Phase 3: API | 3-4 hours |
| Phase 4: Frontend | 8-10 hours |
| Phase 5: Testing | 4-6 hours |
| **Total** | **25-34 hours** |

---

**Plan Created**: 2025-11-30
**Status**: Ready for Implementation
