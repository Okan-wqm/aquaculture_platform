# Sprint 3 - Grup S: Direct Fetch Bypass Fix Report

**Tarih:** 2026-03-14
**Bulgu:** H10/39 (7 sayfa dogrudan fetch), M5/38 (ReportsPage kendi apiFetch'i)
**Durum:** TAMAMLANDI

## Ozet

Tum 7 sayfa `adminApi` (decomposed barrel export) uzerinden calismak uzere guncellendi.
Dogrudan `fetch()` cagrilari, duplicate `getAuthHeader`, ve duplicate `apiFetch` wrapper'lari kaldirildi.
Tum API cagrilari artik su avantajlara sahip:
- Retry logic (3 denemeli exponential backoff)
- X-Request-ID header (izlenebilirlik)
- API envelope unwrap (`{success, data, meta}`)
- Tutarli hata yonetimi (ApiError tipi)
- Merkezi auth token yonetimi

## Degisiklik Detaylari

### API Servis Dosyalari (Yeni Fonksiyonlar)

#### `services/api/database.ts`
Eklenen fonksiyonlar:
- `getExplorerSchemas()` - Schema listesi
- `getExplorerTables(schema)` - Tablo listesi
- `getExplorerTableData(schema, table, params)` - Tablo verisi (paginated)
- `insertExplorerRow(schema, table, data)` - Satir ekleme
- `updateExplorerRow(schema, table, id, data)` - Satir guncelleme
- `deleteExplorerRow(schema, table, id)` - Satir silme
- `exportExplorerTable(schema, table, format, ...)` - Export URL olusturma

#### `services/api/security.ts`
Eklenen fonksiyonlar:
- `getAuditSummary()` - Audit istatistikleri
- `getAlertRules()` - Alert kurallari
- `getActivityStatsOverview()` - Aktivite istatistikleri
- `getComplianceChecks(framework)` - Uyumluluk kontrolleri

#### `services/api/support.ts`
Eklenen fonksiyonlar:
- `getAnnouncementStats()` - Duyuru istatistikleri
- `getAnnouncementAcknowledgments(id)` - Duyuru onaylamalari

#### `services/api/reports.ts`
Eklenen fonksiyonlar:
- `generateCustomReport(data)` - Rapor olusturma
- `getQuickReport(endpoint, format)` - Hizli rapor
- `getExportUrl(format, reportType)` - Export URL

### Sayfa Degisiklikleri

#### 1. DatabaseExplorerPage.tsx (DIRECT_FETCH -> adminApi)
**Onceki:** 6 dogrudan fetch fonksiyonu + duplicate `getAuthHeader` + `getAccessToken` import
**Sonra:** Tum API fonksiyonlari `databaseApi.*` uzerinden
- `fetchSchemas` -> `databaseApi.getExplorerSchemas()`
- `fetchTables` -> `databaseApi.getExplorerTables()`
- `fetchTableData` -> `databaseApi.getExplorerTableData()`
- `insertRow` -> `databaseApi.insertExplorerRow()`
- `updateRow` -> `databaseApi.updateExplorerRow()`
- `deleteRow` -> `databaseApi.deleteExplorerRow()`
- `exportTableData` -> URL `databaseApi.exportExplorerTable()` ile uretilir, blob download icin minimal fetch kalir (apiFetch JSON-based oldugundan blob desteklemez)
- **Kaldirilan:** `getAuthHeader()`, static `getAccessToken` import, `API_BASE` sabit

#### 2. ReportsPage.tsx (kendi apiFetch -> adminApi)
**Onceki:** Tam duplicate `apiFetch` wrapper + `getAccessToken` import + `API_BASE_URL`
**Sonra:** `reportsApi.*` uzerinden
- Generate rapor -> `reportsApi.generateCustomReport()`
- Quick rapor -> `reportsApi.getQuickReport()`
- Export URL -> `reportsApi.getExportUrl()`
- **Kaldirilan:** Tum `apiFetch` wrapper, `API_BASE_URL`, `getAccessToken` import, `ReportApiResponse` interface, unused `useAsyncData` import

#### 3. AuditTrailPage.tsx (MIXED -> adminApi)
**Onceki:** `securityApi` + 2 dogrudan fetch (`fetchAuditSummary`, `fetchAlertRules`)
**Sonra:** Tamamen `securityApi.*` uzerinden
- `fetchAuditSummary` -> `securityApi.getAuditSummary()`
- `fetchAlertRules` -> `securityApi.getAlertRules()`
- **Kaldirilan:** `getAccessToken` import

#### 4. ActivityLogPage.tsx (MIXED -> adminApi)
**Onceki:** `securityApi` + 1 dogrudan fetch (`fetchActivityStats`)
**Sonra:** Tamamen `securityApi.*` uzerinden
- `fetchActivityStats` -> `securityApi.getActivityStatsOverview()`
- **Kaldirilan:** `getAccessToken` import

#### 5. CompliancePage.tsx (MIXED -> adminApi)
**Onceki:** `securityApi` + 1 dogrudan fetch (`fetchComplianceChecks`)
**Sonra:** Tamamen `securityApi.*` uzerinden
- `fetchComplianceChecks` -> `securityApi.getComplianceChecks(framework)`
- **Kaldirilan:** `getAccessToken` import

#### 6. AnnouncementsPage.tsx (MIXED -> adminApi)
**Onceki:** `supportApi` + 2 dogrudan fetch (`fetchStats`, acknowledgments fetch)
**Sonra:** Tamamen `supportApi.*` uzerinden
- Stats fetch -> `supportApi.getAnnouncementStats()`
- Acknowledgments fetch -> `supportApi.getAnnouncementAcknowledgments(id)`
- **Kaldirilan:** `getAccessToken` import

#### 7. BillingDashboardPage.tsx (MIXED -> adminApi)
**Onceki:** `analyticsApi` + 1 dogrudan fetch (billing/invoices)
**Sonra:** `analyticsApi` + `billingApi` uzerinden
- Transaction fetch -> `billingApi.getInvoices({ limit: 5 })`
- **Kaldirilan:** `getAccessToken` import, dogrudan fetch URL olusturma

## Ozel Durumlar

### DatabaseExplorerPage - Blob Download
Export fonksiyonu blob response gerektirdiginden (dosya indirme), `apiFetch` (JSON parser) kullanilmaz.
Bunun yerine `databaseApi.exportExplorerTable()` URL'i uretir, fetch sadece blob icin kullanilir.
Auth token dinamik import ile alinir -- bu minimalize edilmis, kabul edilebilir bir istisnadir.

## Dogrulama

- Tum 7 sayfada dogrudan `fetch()` kaldirildi (export blob haric)
- Tum `getAccessToken` static import'lari kaldirildi
- Tum duplicate `apiFetch` ve `getAuthHeader` fonksiyonlari kaldirildi
- Barrel export (`adminApi.ts`) uzerinden import zincirleri korundu
- Loading/error state'leri degistirilmedi
- Sayfa yapisi (SOLID) korundu, sadece data source degistirildi
