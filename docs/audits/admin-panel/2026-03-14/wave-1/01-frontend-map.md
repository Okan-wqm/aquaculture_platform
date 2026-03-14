# P1: Frontend Haritaci Raporu

Tarih: 2026-03-14
Kapsam: `web/modules/admin-panel/src/`
Ajan: Frontend Haritaci (P1)

---

## Yonetici Ozeti

Admin panel frontend'i 68 dosyadan olusuyor (toplam ~44.293 satir). Merkezi API katmani `adminApi.ts` (3116 satir) 15 farkli API namespace'i sunuyor. 35 sayfa component'i var, bunlarin 22'si `adminApi.ts` uzerinden veri cekiyor, 5'i kendi `fetch()` cagrisini yapiyor (adminApi bypass), 3'u mock/hardcoded data kullaniyor, 5'i karisik pattern uyguluyor. React.lazy KULLANILMIYOR; tum sayfalar Module.tsx'te eager import ediliyor. AlertRuleBuilder component'i ve database/* component'leri (6 adet) hicbir sayfa tarafindan import edilmiyor -- olasi kullanilmayan kod.

---

## Dosya Envanteri

| # | Dosya Yolu (src/ altinda) | Satir | Etiket |
|---|--------------------------|-------|--------|
| 1 | services/adminApi.ts | 3116 | [BUYUK] |
| 2 | components/AlertRuleBuilder/__tests__/AlertRuleBuilder.spec.tsx | 1401 | [BUYUK] |
| 3 | pages/DatabaseManagementPage.tsx | 1355 | [BUYUK] |
| 4 | pages/system/ImpersonationPage.tsx | 1276 | [BUYUK] |
| 5 | pages/CreateTenantPage.tsx | 1129 | [BUYUK] |
| 6 | pages/TenantConfigurationPage.tsx | 1057 | [BUYUK] |
| 7 | components/AlertRuleBuilder/AlertRuleBuilder.tsx | 1048 | [BUYUK] |
| 8 | pages/security/CompliancePage.tsx | 959 | [BUYUK] |
| 9 | pages/DatabaseExplorerPage.tsx | 944 | [BUYUK] |
| 10 | pages/security/AuditTrailPage.tsx | 934 | [BUYUK] |
| 11 | pages/TenantDetailPage.tsx | 913 | [BUYUK] |
| 12 | components/database/DataGrid.tsx | 907 | [BUYUK] |
| 13 | pages/UserManagementPage.tsx | 902 | [BUYUK] |
| 14 | pages/AnalyticsDashboardPage.tsx | 901 | [BUYUK] |
| 15 | pages/security/SecurityDashboardPage.tsx | 889 | [BUYUK] |
| 16 | pages/security/ActivityLogPage.tsx | 879 | [BUYUK] |
| 17 | pages/system/DebugToolsPage.tsx | 872 | [BUYUK] |
| 18 | pages/MessagingPage.tsx | 845 | [BUYUK] |
| 19 | pages/AnnouncementsPage.tsx | 807 | [BUYUK] |
| 20 | pages/OnboardingPage.tsx | 804 | [BUYUK] |
| 21 | pages/TicketsPage.tsx | 803 | [BUYUK] |
| 22 | components/database/QueryEditor.tsx | 795 | [BUYUK] |
| 23 | pages/system/MaintenancePage.tsx | 770 | [BUYUK] |
| 24 | components/database/RowEditor.tsx | 760 | [BUYUK] |
| 25 | pages/system/PerformanceDashboardPage.tsx | 756 | [BUYUK] |
| 26 | pages/ModulePricingPage.tsx | 754 | [BUYUK] |
| 27 | pages/ReportsPage.tsx | 744 | [BUYUK] |
| 28 | hooks/__tests__/useAsyncData.spec.ts | 705 | [BUYUK] |
| 29 | pages/system/JobQueuePage.tsx | 695 | [BUYUK] |
| 30 | pages/CustomPlanBuilderPage.tsx | 683 | [BUYUK] |
| 31 | pages/SystemSettingsPage.tsx | 679 | [BUYUK] |
| 32 | components/database/SchemaStatistics.tsx | 663 | [BUYUK] |
| 33 | pages/__tests__/CreateTenantPage.spec.tsx | 662 | [BUYUK] |
| 34 | components/database/TableList.tsx | 646 | [BUYUK] |
| 35 | pages/AdminDashboard.tsx | 637 | [BUYUK] |
| 36 | pages/DiscountCodePage.tsx | 625 | [BUYUK] |
| 37 | pages/TenantManagementPage.tsx | 620 | [BUYUK] |
| 38 | pages/AuditLogPage.tsx | 616 | [BUYUK] |
| 39 | hooks/__tests__/useFilters.spec.ts | 616 | [BUYUK] |
| 40 | pages/system/ErrorTrackingPage.tsx | 594 | [BUYUK] |
| 41 | pages/system/FeatureTogglesPage.tsx | 590 | [BUYUK] |
| 42 | pages/__tests__/TenantManagementPage.spec.tsx | 582 | [BUYUK] |
| 43 | hooks/__tests__/usePagination.spec.ts | 553 | [BUYUK] |
| 44 | pages/IpAccessRulesPage.tsx | 541 | [BUYUK] |
| 45 | components/database/SchemaSelector.tsx | 531 | [BUYUK] |
| 46 | pages/EmailTemplatesPage.tsx | 527 | [BUYUK] |
| 47 | pages/BillingDashboardPage.tsx | 509 | [BUYUK] |
| 48 | pages/SubscriptionManagementPage.tsx | 505 | [BUYUK] |
| 49 | components/AdminSidebar.tsx | 464 | |
| 50 | pages/PlanManagementPage.tsx | 420 | |
| 51 | pages/InvoicesPage.tsx | 413 | |
| 52 | pages/ModulesPage.tsx | 370 | |
| 53 | components/UserPermissions/InviteUserModal.tsx | 335 | |
| 54 | pages/RoleManagementPage.tsx | 322 | |
| 55 | hooks/useAsyncData.ts | 315 | |
| 56 | hooks/useFilters.ts | 252 | |
| 57 | components/UserPermissions/PermissionCheckboxes.tsx | 220 | |
| 58 | pages/ProvisioningSettingsPage.tsx | 217 | |
| 59 | hooks/usePagination.ts | 214 | |
| 60 | components/AdminLayout.tsx | 207 | |
| 61 | hooks/useUserPermissions.ts | 199 | |
| 62 | Module.tsx | 135 | |
| 63 | hooks/index.ts | 34 | |
| 64 | main.tsx | 26 | |
| 65 | components/database/index.ts | 23 | |
| 66 | pages/system/index.ts | 11 | |
| 67 | components/index.ts | 6 | |
| 68 | components/AlertRuleBuilder/index.ts | 6 | |
| 69 | pages/security/index.ts | 4 | |
| 70 | styles.css | 3 | |
| 71 | routes.tsx | 1 | |
| 72 | bootstrap.tsx | 0 | |
| 73 | App.tsx | 0 | |

**Toplam: ~44.293 satir, 48 dosya 500+ satirlik ([BUYUK])**

---

## Data Fetch Pattern Haritasi

Her sayfa icin: "Bu sayfa gercekten API'ye baglanmis mi?"

| Sayfa | Pattern | adminApi Import | Detay |
|-------|---------|-----------------|-------|
| AdminDashboard | [API] | systemApi, usersApi, tenantsApi, auditApi, debugApi | EVET - Birden fazla adminApi namespace kullanir |
| UserManagementPage | [API] | usersApi, tenantsApi | EVET - Kullanici listesi ve islemleri |
| RoleManagementPage | [API] | usersApi | EVET - Rol hierarchy ve permission islemleri |
| TenantManagementPage | [API] | tenantsApi | EVET - Tenant CRUD |
| TenantDetailPage | [API] | tenantsApi, modulesApi | EVET - Tenant detay ve modul bilgileri |
| CreateTenantPage | [API] | tenantsApi, modulesApi, billingApi | EVET - Wizard ile tenant olusturma |
| SystemSettingsPage | [API]+[ASYNC] | settingsApi + useAsyncData | EVET - Settings CRUD, useAsyncData hook ile |
| AuditLogPage | [API]+[ASYNC] | auditApi, tenantsApi + useAsyncData, usePagination, useFilters | EVET - Tam hook entegrasyonu |
| SubscriptionManagementPage | [API] | billingApi | EVET - Abonelik yonetimi |
| PlanManagementPage | [API] | billingApi | EVET - Plan CRUD |
| DiscountCodePage | [API] | billingApi | EVET - Indirim kodu yonetimi |
| TenantConfigurationPage | [MOCK] | YOK | HAYIR - `mockConfig` hardcoded, "replace with API call" yorumu var |
| EmailTemplatesPage | [API] | settingsApi | EVET - Template CRUD |
| IpAccessRulesPage | [API] | settingsApi | EVET - IP kural yonetimi |
| AnalyticsDashboardPage | [API] | analyticsApi, systemApi | EVET - KPI ve metrik verileri |
| ReportsPage | [DIRECT_FETCH]+[ASYNC] | useAsyncData (hook) | KISMI - Kendi apiFetch wrapper'i var, adminApi.ts'deki reportsApi'yi kullanmiyor |
| DatabaseManagementPage | [MOCK] | YOK | HAYIR - Tamamen mock data (mockSchemas, mockMigrations, mockBackups, mockHealth...) |
| MessagingPage | [API] | supportApi | EVET - Thread ve mesaj islemleri |
| AnnouncementsPage | [MIXED] | supportApi + getAccessToken + dogrudan fetch() | KISMI - supportApi.getAnnouncements + dogrudan fetch('/api/support/announcements/stats') |
| TicketsPage | [API] | supportApi | EVET - Ticket yonetimi |
| OnboardingPage | [MOCK] | YOK | HAYIR - Tamamen mock data (mockSteps, mockProgress, mockResources, mockStats) |
| ModulesPage | [API]+[ASYNC] | modulesApi + useAsyncData | EVET - Modul listesi ve istatistikler |
| BillingDashboardPage | [MIXED] | analyticsApi + useAsyncData + dogrudan fetch() | KISMI - analyticsApi + dogrudan fetch('/api/billing/invoices') |
| InvoicesPage | [API] | billingApi | EVET - Fatura listesi ve islemler |
| DatabaseExplorerPage | [DIRECT_FETCH] | YOK | EVET ama bypass - Kendi fetch wrapper'i, adminApi.ts'deki databaseApi'yi kullanmiyor |
| ModulePricingPage | [API] | billingApi | EVET - Modul fiyatlandirma CRUD |
| CustomPlanBuilderPage | [API] | billingApi | EVET - Ozel plan olusturucu |
| ProvisioningSettingsPage | [API]+[ASYNC] | systemSettingsApi + useAsyncData | EVET - Provisioning ayarlari |
| SecurityDashboardPage | [API] | securityApi | EVET - Tehdit izleme, olaylar |
| AuditTrailPage | [MIXED] | securityApi + getAccessToken + dogrudan fetch() | KISMI - securityApi + dogrudan fetch('/api/security/audit/summary') |
| ActivityLogPage | [MIXED] | securityApi + getAccessToken + dogrudan fetch() | KISMI - securityApi + dogrudan fetch('/api/security/activities/stats/overview') |
| CompliancePage | [MIXED] | securityApi + getAccessToken + dogrudan fetch() | KISMI - securityApi + dogrudan fetch('/api/security/compliance/checks/...') |
| MaintenancePage | [API] | systemSettingsApi | EVET - Bakim penceresi yonetimi |
| PerformanceDashboardPage | [API] | systemSettingsApi | EVET - Performans metrikleri |
| JobQueuePage | [API] | systemSettingsApi | EVET - Is kuyrugu izleme |
| FeatureTogglesPage | [API] | systemSettingsApi | EVET - Feature flag yonetimi |
| ErrorTrackingPage | [API] | systemApi | EVET - Hata takibi |
| ImpersonationPage | [API] | impersonationApi, tenantsApi | EVET - Kullanici taklit etme |
| DebugToolsPage | [API] | debugApi, systemApi, databaseApi | EVET - Cache, log, config islemleri |

### Pattern Ozeti

| Pattern | Sayfa Sayisi | Sayfalar |
|---------|-------------|----------|
| [API] (saf adminApi) | 20 | AdminDashboard, UserManagement, RoleManagement, TenantManagement, TenantDetail, CreateTenant, Subscription, Plan, Discount, EmailTemplates, IpAccessRules, Analytics, Messaging, Tickets, ModulePricing, CustomPlanBuilder, SecurityDashboard, Maintenance, Performance, JobQueue, FeatureToggles, ErrorTracking, Impersonation, Invoices |
| [API]+[ASYNC] (adminApi + useAsyncData) | 5 | SystemSettings, AuditLog, Modules, BillingDashboard, ProvisioningSettings |
| [MIXED] (adminApi + dogrudan fetch) | 5 | Announcements, BillingDashboard, AuditTrail, ActivityLog, Compliance |
| [DIRECT_FETCH] (adminApi bypass) | 2 | DatabaseExplorer, Reports |
| [MOCK] (API yok) | 3 | TenantConfiguration, DatabaseManagement, Onboarding |

---

## Dependency Graph

```
Module.tsx (root router)
  |
  +-- useAuthContext (@aquaculture/shared-ui)
  |
  +-- pages/* (35 sayfa component'i, hepsi eager import)
       |
       +--[adminApi.ts kullananlar]
       |    |
       |    +-- services/adminApi.ts
       |         |-- systemApi         <-- AdminDashboard, Analytics, ErrorTracking, DebugTools
       |         |-- analyticsApi      <-- Analytics, BillingDashboard
       |         |-- tenantsApi        <-- AdminDashboard, UserMgmt, TenantMgmt, TenantDetail, CreateTenant, AuditLog, Impersonation
       |         |-- usersApi          <-- AdminDashboard, UserMgmt, RoleMgmt
       |         |-- billingApi        <-- CreateTenant, Subscription, Plan, Discount, Invoices, ModulePricing, CustomPlanBuilder
       |         |-- modulesApi        <-- TenantDetail, CreateTenant, Modules
       |         |-- auditApi          <-- AdminDashboard, AuditLog
       |         |-- settingsApi       <-- SystemSettings, EmailTemplates, IpAccessRules
       |         |-- supportApi        <-- Messaging, Announcements, Tickets
       |         |-- securityApi       <-- SecurityDashboard, AuditTrail, ActivityLog, Compliance
       |         |-- systemSettingsApi <-- MaintenancePage, Performance, JobQueue, FeatureToggles, ProvisioningSettings
       |         |-- impersonationApi  <-- Impersonation
       |         |-- debugApi          <-- AdminDashboard, DebugTools
       |         |-- databaseApi       <-- DebugTools (NOT DatabaseExplorerPage!)
       |         |-- reportsApi        <-- HICBIR SAYFA KULLANMIYOR
       |
       +--[useAsyncData kullananlar]
       |    |
       |    +-- hooks/useAsyncData.ts  <-- SystemSettings, AuditLog, Modules, BillingDashboard, ProvisioningSettings, Reports
       |    +-- hooks/usePagination.ts <-- AuditLog
       |    +-- hooks/useFilters.ts    <-- AuditLog
       |
       +--[dogrudan fetch kullananlar]
            |
            +-- getAccessToken (@platform/shared-ui)
            +-- fetch() -- DatabaseExplorer, Reports, AuditTrail, ActivityLog, Compliance, Announcements, BillingDashboard

components/
  +-- AdminLayout.tsx      <-- AdminSidebar import eder, Module.tsx KULLANMIYOR (Shell'de kullaniliyor)
  +-- AdminSidebar.tsx     <-- AdminLayout import eder
  +-- AlertRuleBuilder/    <-- HICBIR SAYFA IMPORT ETMIYOR
  +-- UserPermissions/     <-- HICBIR SAYFA IMPORT ETMIYOR (hooks/useUserPermissions.ts da kullanilmiyor)
  +-- database/            <-- HICBIR SAYFA IMPORT ETMIYOR (DatabaseExplorerPage kendi RowEditorModal'ini tanimliyor)

hooks/
  +-- useAsyncData.ts      <-- 6 sayfada kullaniliyor
  +-- usePagination.ts     <-- Sadece AuditLogPage
  +-- useFilters.ts        <-- Sadece AuditLogPage
  +-- useUserPermissions.ts <-- HICBIR SAYFADA KULLANILMIYOR (hooks/index.ts export eder ama hicbir tüketici yok)
```

---

## Kullanilmayan Export'lar

### KRITIK - Hic kullanilmayan moduller

| Export | Tanimlanan Dosya | Durum |
|--------|-----------------|-------|
| `reportsApi` | services/adminApi.ts:447 | KULLANILMIYOR - ReportsPage kendi apiFetch wrapper'ini yazmis |
| `AlertRuleBuilder` component | components/AlertRuleBuilder/ (1048 + 1401 satir test) | KULLANILMIYOR - Hicbir sayfa import etmiyor |
| `database/*` components (6 adet) | components/database/ (toplam ~4302 satir) | KULLANILMIYOR - DatabaseExplorerPage bunlari import etmiyor, kendi inline component'lerini kullaniyor |
| `UserPermissions/*` components (2 adet) | components/UserPermissions/ (555 satir) | KULLANILMIYOR - Hicbir sayfa veya component import etmiyor |
| `useUserPermissions` hook | hooks/useUserPermissions.ts (199 satir) | KULLANILMIYOR - hooks/index.ts export eder ama hicbir consumer yok |
| `AdminLayout` + `AdminSidebar` | components/ (671 satir) | KISMI - components/index.ts export eder ama Module.tsx kullanmiyor (Shell'de kullanilabilir) |

### Toplam kullanilmayan/suphelki kod: ~8176 satir (%18.5 of toplam)

---

## Route Haritasi

Module.tsx'ten (tum route'lar `/admin` prefix'i altinda):

| # | Path | Component | Guard |
|---|------|-----------|-------|
| 1 | `/admin` (index) | AdminDashboard | SUPER_ADMIN |
| 2 | `/admin/analytics` | AnalyticsDashboardPage | SUPER_ADMIN |
| 3 | `/admin/analytics/reports` | ReportsPage | SUPER_ADMIN |
| 4 | `/admin/tenants` | TenantManagementPage | SUPER_ADMIN |
| 5 | `/admin/tenants/new` | CreateTenantPage | SUPER_ADMIN |
| 6 | `/admin/tenants/:tenantId` | TenantDetailPage | SUPER_ADMIN |
| 7 | `/admin/tenants/:tenantId/configuration` | TenantConfigurationPage | SUPER_ADMIN |
| 8 | `/admin/users` | UserManagementPage | SUPER_ADMIN |
| 9 | `/admin/users/roles` | RoleManagementPage | SUPER_ADMIN |
| 10 | `/admin/modules` | ModulesPage | SUPER_ADMIN |
| 11 | `/admin/billing` | BillingDashboardPage | SUPER_ADMIN |
| 12 | `/admin/billing/subscriptions` | SubscriptionManagementPage | SUPER_ADMIN |
| 13 | `/admin/billing/invoices` | InvoicesPage | SUPER_ADMIN |
| 14 | `/admin/billing/plans` | PlanManagementPage | SUPER_ADMIN |
| 15 | `/admin/billing/discounts` | DiscountCodePage | SUPER_ADMIN |
| 16 | `/admin/billing/module-pricing` | ModulePricingPage | SUPER_ADMIN |
| 17 | `/admin/billing/custom-plan-builder` | CustomPlanBuilderPage | SUPER_ADMIN |
| 18 | `/admin/support/tickets` | TicketsPage | SUPER_ADMIN |
| 19 | `/admin/support/messaging` | MessagingPage | SUPER_ADMIN |
| 20 | `/admin/support/announcements` | AnnouncementsPage | SUPER_ADMIN |
| 21 | `/admin/support/onboarding` | OnboardingPage | SUPER_ADMIN |
| 22 | `/admin/security/activity` | ActivityLogPage | SUPER_ADMIN |
| 23 | `/admin/security/audit` | AuditTrailPage | SUPER_ADMIN |
| 24 | `/admin/security/compliance` | CompliancePage | SUPER_ADMIN |
| 25 | `/admin/security/threats` | SecurityDashboardPage | SUPER_ADMIN |
| 26 | `/admin/system/features` | FeatureTogglesPage | SUPER_ADMIN |
| 27 | `/admin/system/maintenance` | MaintenancePage | SUPER_ADMIN |
| 28 | `/admin/system/performance` | PerformanceDashboardPage | SUPER_ADMIN |
| 29 | `/admin/system/errors` | ErrorTrackingPage | SUPER_ADMIN |
| 30 | `/admin/system/jobs` | JobQueuePage | SUPER_ADMIN |
| 31 | `/admin/system/impersonation` | ImpersonationPage | SUPER_ADMIN |
| 32 | `/admin/system/debug` | DebugToolsPage | SUPER_ADMIN |
| 33 | `/admin/database` | DatabaseManagementPage | SUPER_ADMIN |
| 34 | `/admin/database/explorer` | DatabaseExplorerPage | SUPER_ADMIN |
| 35 | `/admin/audit` | AuditLogPage | SUPER_ADMIN |
| 36 | `/admin/settings` | SystemSettingsPage | SUPER_ADMIN |
| 37 | `/admin/settings/email` | EmailTemplatesPage | SUPER_ADMIN |
| 38 | `/admin/settings/integrations` | IpAccessRulesPage | SUPER_ADMIN |
| 39 | `/admin/settings/provisioning` | ProvisioningSettingsPage | SUPER_ADMIN |
| 40 | `/admin/*` (fallback) | Navigate to /admin | SUPER_ADMIN |

### React.lazy Kontrolu

**KULLANILMIYOR.** Tum 35 sayfa Module.tsx'te eager (static) import ediliyor. Code splitting yok. Bu, admin paneli acildiginda tum sayfalarin bundle'a dahil oldugu anlamina gelir.

---

## Bulgular

### Kritik Sorunlar

1. **MOCK sayfalar (3 adet):** TenantConfigurationPage, DatabaseManagementPage ve OnboardingPage hicbir API'ye baglanmamis. Tamamen hardcoded mock data kullaniyor. Uretim ortaminda gercek veri gostermiyor.

2. **Kullanilmayan bilesenler (~8176 satir):** AlertRuleBuilder, database/*, UserPermissions/*, useUserPermissions hook'u ve reportsApi hicbir sayfa tarafindan tuketilmiyor. Dead code olarak isaretle veya temizle.

3. **Tutarsiz data fetch pattern'leri:** 5 sayfa (Announcements, BillingDashboard, AuditTrail, ActivityLog, Compliance) hem adminApi hem dogrudan fetch() kullaniyor. Bu MIXED pattern bakim yukunu artiriyor ve hata yonetimi tutarsizligi olusturuyor (adminApi retry + error handling vs raw fetch).

4. **React.lazy eksikligi:** 35 sayfa eager import ediliyor. Admin paneli sadece SUPER_ADMIN kullancilari icin oldugu halde tum sayfa kodu tek bundle'da. Lazy loading ile initial bundle %60-70 kucultulubilir.

5. **adminApi.ts buyuklugu (3116 satir):** Tek dosyada 15 API namespace. Parcalanmasi gerekiyor (ornegin: billingApi.ts, securityApi.ts, supportApi.ts, systemApi.ts vb.).

6. **DatabaseExplorerPage vs database/* components:** DatabaseExplorerPage kendi inline RowEditorModal'ini tanimliyor ama components/database/ altinda ayni isi yapan RowEditor.tsx mevcut. Kod tekrari var.

### Spawn Talepleri

Bu rapor yalnizca arastirma icin hazirlanmistir. Dosya duzenleme yapilmamistir.
Asagidaki spawn'lar sonraki dalgalar icin onerilir:

- **S1:** TenantConfigurationPage, DatabaseManagementPage ve OnboardingPage sayfalarini gercek API'ye baglama
- **S2:** MIXED pattern sayfalarini (5 adet) tutarli sekilde adminApi.ts uzerinden calismaya donusturme
- **S3:** Kullanilmayan kodlarin (AlertRuleBuilder, database/*, UserPermissions/*) temizlenmesi veya entegrasyonu
- **S4:** React.lazy + Suspense ile code splitting eklenmesi
- **S5:** adminApi.ts'in domain bazli dosyalara parcalanmasi
