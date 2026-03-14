# Grup P: adminApi.ts God File Decomposition

**Bulgu:** H9 -- adminApi.ts SRP ihlali (3120 satir, 15 domain API, ~90 tip, HTTP altyapisi tek dosyada)
**Tarih:** 2026-03-14
**Durum:** TAMAMLANDI

---

## Ozet

3120 satirlik monolitik `adminApi.ts` dosyasi SOLID/SRP prensiplerine uygun olarak 28 odakli dosyaya decompose edildi. Geriye uyumluluk barrel export ile saglanmis, mevcut consumer'larin hicbirinde degisiklik yapilmamistir.

## Oncesi

```
services/adminApi.ts  -- 3120 satir, 15 API namespace, ~90 tip, HTTP client
```

## Sonrasi

```
services/
  adminApi.ts           --   80 satir (barrel re-export, geriye uyumluluk)
  http-client.ts        --  156 satir (apiFetch, buildQueryString, retry logic)
  types/
    index.ts            --   20 satir (barrel)
    common.ts           --   23 satir (PaginatedResult, PaginationParams, DateRangeParams)
    tenant.ts           --  218 satir (Tenant, TenantStatus, TenantTier, TenantDetail vb.)
    system.ts           --   49 satir (SystemMetrics, ServiceHealth, CircuitBreaker)
    analytics.ts        --   71 satir (DashboardSummary, KpiComparison, RevenueAnalytics vb.)
    reports.ts          --   44 satir (ReportDefinition, ReportExecution, ReportData)
    database.ts         --   83 satir (TenantSchema, SchemaMigration, DatabaseBackup vb.)
    support.ts          --  208 satir (SupportTicket, Message, Announcement, Onboarding)
    security.ts         --  113 satir (ActivityLog, SecurityEvent, ComplianceReport vb.)
    settings.ts         --  235 satir (FeatureToggle, MaintenanceWindow, ErrorGroup, JobQueue vb.)
    impersonation.ts    --   48 satir (ImpersonationPermission, Session, Action)
    debug.ts            --   85 satir (DebugSession, CapturedQuery, CacheEntry vb.)
    users.ts            --   96 satir (User, RoleTemplate, Permission vb.)
    modules.ts          --   39 satir (SystemModule, ModuleStats, TenantModuleAssignment)
    audit.ts            --   27 satir (AuditLog, AuditLogStats)
    billing.ts          --  567 satir (PlanDefinition, DiscountCode, Subscription, CustomPlan vb.)
  api/
    system.ts           --   19 satir (systemApi)
    analytics.ts        --   92 satir (analyticsApi)
    reports.ts          --   47 satir (reportsApi)
    database.ts         --   72 satir (databaseApi)
    support.ts          --  133 satir (supportApi)
    security.ts         --  124 satir (securityApi)
    settings.ts         --  246 satir (settingsApi + systemSettingsApi)
    impersonation.ts    --   62 satir (impersonationApi)
    debug.ts            --  105 satir (debugApi)
    tenants.ts          --   61 satir (tenantsApi)
    users.ts            --   57 satir (usersApi)
    modules.ts          --   44 satir (modulesApi)
    audit.ts            --   34 satir (auditApi)
    billing.ts          --  207 satir (billingApi)

Toplam: 3465 satir (28 dosya) -- header/import artisi sebebiyle %11 artis, ancak her dosya tek sorumluluk tasiyor.
```

## Geriye Uyumluluk

`adminApi.ts` artik barrel re-export dosyasi. Tum mevcut import path'leri degismeden calisiyor:

```typescript
// ONCEKI (ve hala calisan):
import { systemApi } from '../services/adminApi';
import { TenantTier, TenantStatus } from '../services/adminApi';
import type { Tenant, AuditLog } from '../services/adminApi';

// YENI (opsiyonel, dogrudan import):
import { systemApi } from '../services/api/system';
import type { Tenant } from '../services/types/tenant';
```

## Consumer Analizi (Etkilenen Sayfalar)

42 import statement taranmistir. Hicbirinde degisiklik yapilmamistir.

| Sayfa | Import Edilen Semboller |
|-------|------------------------|
| AdminDashboard | systemApi, analyticsApi, supportApi, tenantsApi, usersApi + tipler |
| TenantManagementPage | tenantsApi, Tenant, TenantTier, TenantStatus |
| TenantDetailPage | tenantsApi, billingApi, modulesApi + tipler |
| CreateTenantPage | tenantsApi, modulesApi, billingApi + tipler |
| UserManagementPage | usersApi + tipler |
| RoleManagementPage | usersApi + tipler |
| AuditLogPage | auditApi, tenantsApi + tipler |
| BillingDashboardPage | analyticsApi, RevenueAnalytics |
| PlanManagementPage | billingApi + tipler |
| SubscriptionManagementPage | billingApi + tipler |
| InvoicesPage | billingApi, InvoiceOverview |
| DiscountCodePage | billingApi + tipler |
| CustomPlanBuilderPage | billingApi + tipler |
| ModulePricingPage | billingApi + tipler |
| ModulesPage | modulesApi |
| AnalyticsDashboardPage | analyticsApi, systemApi |
| MessagingPage | supportApi + tipler |
| AnnouncementsPage | supportApi + tipler |
| TicketsPage | supportApi + tipler |
| SystemSettingsPage | settingsApi |
| ProvisioningSettingsPage | systemSettingsApi |
| EmailTemplatesPage | settingsApi, EmailTemplate |
| IpAccessRulesPage | settingsApi, IpAccessRule |
| SecurityDashboardPage | securityApi |
| ActivityLogPage | securityApi |
| AuditTrailPage | securityApi |
| CompliancePage | securityApi |
| DebugToolsPage | debugApi, systemApi, databaseApi + CacheEntry |
| PerformanceDashboardPage | systemSettingsApi + tipler |
| ImpersonationPage | impersonationApi + tipler |
| MaintenancePage | systemSettingsApi |
| ErrorTrackingPage | systemApi + tipler |
| FeatureTogglesPage | systemSettingsApi + FeatureToggle |
| JobQueuePage | systemSettingsApi + tipler |
| __tests__/ | tenantsApi, modulesApi, TenantTier, TenantStatus |

## TypeScript Dogrulama

- `npx tsc --noEmit` -- 0 yeni hata. Mevcut hatalar (jest-dom typing, @platform/shared-ui module resolution) onceden de vardir ve bu refactoring ile ilgili degildir.
- `adminApi` ile ilgili import hatasi: **0**

## Dosya Yapisi (Sorumluluk Dagilimi)

| Katman | Dosya | Sorumluluk |
|--------|-------|------------|
| Altyapi | `http-client.ts` | apiFetch, buildQueryString, retry, envelope unwrap, auth header |
| Tip | `types/*.ts` (15 dosya) | Interface/Type/Enum tanimlari, domain bazli ayrilmis |
| API | `api/*.ts` (14 dosya) | Her biri tek domain API namespace |
| Barrel | `adminApi.ts` | Geriye uyumlu re-export |

## SOLID Uyum Analizi

| Prensip | Oncesi | Sonrasi |
|---------|--------|---------|
| **SRP** | Tek dosya 15 sorumluluk | Her dosya tek sorumluluk |
| **OCP** | Yeni domain eklemek icin god file'i degistirmek gerekiyor | Yeni api/ ve types/ dosyasi ekle, barrel'a bir satir ekle |
| **DIP** | HTTP client ile domain logic karismis | Domain API'ler http-client'i import eder, bagimsiz test edilebilir |
