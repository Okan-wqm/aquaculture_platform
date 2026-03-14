# P11: Teknik Borc Dedektifi Raporu

Tarih: 2026-03-14
Kapsam: Frontend (`web/modules/admin-panel/src/`) + Backend (`apps/admin-api-service/src/`)
Ajan: Teknik Borc Dedektifi (P11)

---

## Yonetici Ozeti

Admin panel kod tabaninda 7 kategori altinda toplam **48 teknik borc kalemi** tespit edildi. En kritik borclar: (1) ~8.176 satir dead code (kullanilmayan component/hook/API), (2) `getAuthHeader` fonksiyonunun 7 dosyada birebir kopyalanmasi, (3) `@tanstack/react-query` paketinin dependency olarak yuklu olmasina ragmen hicbir dosyada import edilmemesi, (4) 3 dosyanin tamamen bos/tek satirlik legacy dosya olarak kalmas, (5) frontend genelinde 150 catch blogunun error.message erisiminde tip guvenligi olmadan `err` degiskenini kullanmasi.

---

## 1. Dead Code (Kullanilmayan Fonksiyon, Component, Import, Export)

### 1.1 Hicbir Sayfa Tarafindan Import Edilmeyen Component'ler

| Component/Modul | Dosya(lar) | Satir | Aciklama |
|-----------------|------------|-------|----------|
| AlertRuleBuilder | `components/AlertRuleBuilder/AlertRuleBuilder.tsx` + `index.ts` | ~1.054 | Hicbir sayfa import etmiyor. Test dosyasi da 1.401 satir (toplam ~2.455 satir olus kod). |
| database/* (6 component) | `components/database/{SchemaSelector,TableList,DataGrid,RowEditor,QueryEditor,SchemaStatistics}.tsx` + `index.ts` | ~4.302 | DatabaseExplorerPage bu component'leri import etmiyor; kendi inline versiyonlarini tanimliyor. |
| UserPermissions/* (2 component) | `components/UserPermissions/{InviteUserModal,PermissionCheckboxes}.tsx` | ~555 | Hicbir sayfa veya dis component import etmiyor. |
| useUserPermissions hook | `hooks/useUserPermissions.ts` | 199 | `hooks/index.ts` export ediyor ama hicbir sayfa tuketmiyor. |
| AdminLayout + AdminSidebar | `components/{AdminLayout,AdminSidebar}.tsx` | 671 | `components/index.ts` export eder, Module.tsx kullanmiyor. Shell'de kullaniliyor olabilir -- dogrulama gerekli. |

**Toplam dead/suphelki kod: ~8.176 satir (toplam ~44.293 satirlik kod tabaninin %18.5'i)**

### 1.2 Kullanilmayan API Namespace'leri

| Export | Dosya | Satir | Durum |
|--------|-------|-------|-------|
| `reportsApi` | `services/adminApi.ts:447` | ~35 satir (fonksiyon tanimlari) | ReportsPage kendi `apiFetch` wrapper'ini yazmis; adminApi.ts'deki reportsApi'yi kullanmiyor. |
| `databaseApi` | `services/adminApi.ts:565` | ~60 satir | Yalnizca DebugToolsPage (1 endpoint) kullaniyor. DatabaseExplorerPage (asil tuketici) kendi fetch wrapper'ini kullaniyor. |

### 1.3 Legacy Dosyalar (Bos/Tek Satirlik)

| Dosya | Icerik | Oneri |
|-------|--------|-------|
| `bootstrap.tsx` | 0 satir (tamamen bos) | Silinmeli |
| `App.tsx` | 0 satir (tamamen bos) | Silinmeli |
| `routes.tsx` | 1 satir: `// Routes are defined in Module.tsx directly. This file is intentionally empty. (BUG-016)` | Silinmeli |
| `webpack.config.js` | 0 satir (tamamen bos) | Proje Vite kullandigi icin gereksiz. Silinmeli |

---

## 2. TODO/FIXME/HACK Notlari

### 2.1 Frontend (8 not)

| # | Dosya | Satir | Not |
|---|-------|-------|-----|
| 1 | `pages/MessagingPage.tsx` | 165 | `// TODO: Use actual admin name` (senderName: 'Admin' hardcoded) |
| 2 | `pages/MessagingPage.tsx` | 216 | `// TODO: Use actual admin name` (ayni sorun, ikinci yerde) |
| 3 | `pages/SubscriptionManagementPage.tsx` | 77 | `// TODO: get from auth context` ('admin' hardcoded) |
| 4 | `pages/SubscriptionManagementPage.tsx` | 95 | `// TODO: get from auth context` (ayni sorun, ikinci yerde) |
| 5 | `pages/system/DebugToolsPage.tsx` | 132 | `// TODO: Implement logs API endpoint` |
| 6 | `pages/system/DebugToolsPage.tsx` | 170 | `// TODO: Implement config API endpoint` |
| 7 | `pages/system/ErrorTrackingPage.tsx` | 67 | `// TODO: Implement API call when backend is ready` |
| 8 | `pages/system/ErrorTrackingPage.tsx` | 112 | `// TODO: Implement API call when backend is ready` |

### 2.2 Backend (4 not)

| # | Dosya | Satir | Not |
|---|-------|-------|-----|
| 1 | `tenant/__tests__/tenant.e2e.spec.ts` | 7 | `TODO: These tests are currently skipped because they require:` (e2e testler devre disi) |
| 2 | `support/services/messaging.service.ts` | 260 | `// TODO: Send email notification if configured` |
| 3 | `support/services/messaging.service.ts` | 362 | `// TODO: Send email if request.sendEmail is true` |
| 4 | `support/services/onboarding.service.ts` | 392 | `// TODO: Integrate with email service` |

**Toplam: 12 TODO, 0 FIXME, 0 HACK**

---

## 3. Duplicate (Tekrar Eden Kod Bloklari)

### 3.1 `getAuthHeader` Fonksiyonu -- 7 Kopya

Birebir ayni fonksiyon 7 dosyada tanimlanmis:

```
const getAuthHeader = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};
```

| # | Dosya |
|---|-------|
| 1 | `services/adminApi.ts:34` |
| 2 | `pages/DatabaseExplorerPage.tsx:65` |
| 3 | `components/database/QueryEditor.tsx:56` |
| 4 | `components/database/RowEditor.tsx:53` |
| 5 | `components/database/TableList.tsx:57` |
| 6 | `components/database/SchemaStatistics.tsx:56` |
| 7 | `components/database/DataGrid.tsx:54` |

**Not:** Component'ler #3-7 zaten dead code (bolum 1.1'e bakiniz), ancak DatabaseExplorerPage (#2) aktif kullanimda ve adminApi.ts'deki (#1) kopyayi kullanmiyor.

### 3.2 `apiFetch` Wrapper Kopyasi

- `services/adminApi.ts:50` -- merkezi `apiFetch` wrapper (retry + error handling iceren tam surumu)
- `pages/ReportsPage.tsx:21` -- basitlestirilmis ayri bir `apiFetch` wrapper (retry yok, error handling minimal)

ReportsPage, merkezi `adminApi.ts`'deki `reportsApi` namespace'ini bypass ediyor ve kendi basit fetch wrapper'ini yazmis.

### 3.3 Dogrudan `getAccessToken()` + fetch() Cagrilari

adminApi.ts bypass edilerek `getAccessToken()` ile dogrudan `fetch()` kullanan sayfalar (MIXED pattern):

| # | Dosya | Satir(lar) | Bypass edilen endpoint |
|---|-------|------------|----------------------|
| 1 | `pages/AnnouncementsPage.tsx` | 95, 706 | `/api/support/announcements/stats` |
| 2 | `pages/BillingDashboardPage.tsx` | 333 | `/api/billing/invoices` |
| 3 | `pages/security/AuditTrailPage.tsx` | 160, 190 | `/api/security/audit/summary` |
| 4 | `pages/security/ActivityLogPage.tsx` | 139 | `/api/security/activities/stats/overview` |
| 5 | `pages/security/CompliancePage.tsx` | 147 | `/api/security/compliance/checks/...` |

### 3.4 DatabaseExplorerPage vs database/* Component'leri

DatabaseExplorerPage (944 satir) kendi inline `RowEditorModal` component'ini tanimliyor (satir 258-267), oysa `components/database/RowEditor.tsx` (760 satir) ayni isi yapan ayri bir component olarak mevcut. Ayni sekilde schema secimi, tablo listesi ve veri grid islevi de ikisi arasinda tekrar ediyor.

---

## 4. Unused Dependencies

### 4.1 @tanstack/react-query -- KULLANILMIYOR

- `package.json:16` -- `"@tanstack/react-query": "^5.17.0"` dependency olarak tanimli
- `vite.config.ts:23` -- Module Federation shared olarak yapilandirilmis
- **Sonuc:** `src/` altindaki hicbir dosya `useQuery`, `useMutation`, `useQueryClient` veya `@tanstack/react-query`'den herhangi bir sey import etmiyor.
- Proje kendi `useAsyncData` hook'unu (315 satir) kullanarak data fetching yapiyor.

**Oneri:** react-query ya entegre edilmeli (useAsyncData yerine) ya da dependency'den kaldirilmali.

---

## 5. Type Debt

### 5.1 `any` Kullanimi

| Konum | Dosya Sayisi | Toplam Kullanim | Not |
|-------|-------------|-----------------|-----|
| Frontend src/ (test haric) | 1 | 1 | `ProvisioningSettingsPage.tsx:36` -- `data: any` parametre |
| Frontend test dosyalari | 2 | 25 | `(tenantsApi.list as any).mockResolvedValue(...)` pattern'i testlerde yaygin |
| Backend src/ (test haric) | 1 | 1 | `global-settings.controller.ts:399` -- `@Req() req: any` |
| Backend test dosyalari | ~5 | ~70+ | Test mock'larinda `as any` yaygin |

**Uretim kodunda `any` kullanimi cok dusuk (2 adet).** Test dosyalarinda ~95 adet `as any` mevcut ancak bu genellikle mock icin kabul edilebilir.

### 5.2 `as` Type Assertion (Uretim Kodu)

| Konum | Toplam | Onemli Ornekler |
|-------|--------|-----------------|
| Frontend (test haric) | ~97 | Cogunlugu `as string`, `as React.ChangeEvent<>` gibi meşru kullanim |
| Backend (test haric) | ~195 | **7 adet `{ status: 'active' as any }`** -- backup-restore, migration-management, database-monitoring service'lerinde. TypeORM where clause'da enum uyumsuzlugu. |

Backend'deki `{ status: 'active' as any }` pattern'i (7 yerde) gercek bir tip uyumsuzlugu sorununa isaret ediyor:
- `backup-restore.service.ts:460, 486, 551`
- `migration-management.service.ts:400, 445, 676`
- `database-monitoring.service.ts:107`

### 5.3 `(req as any).user` Pattern'i

`impersonation.controller.ts`'de 4 yerde `(req as any).user` kullaniliyor (satir 265, 305, 327, 341). `@CurrentUser()` decorator'u yerine dogrudan `req` uzerinden erisim.

### 5.4 eslint-disable Direktifleri

| Konum | Adet | Detay |
|-------|------|-------|
| Frontend | 4 | `eslint-disable-line react-hooks/exhaustive-deps` -- useAsyncData (2), usePagination (1), QueryEditor (1) |
| Backend | 6 | Test dosyalarinda `eslint-disable` -- no-var-requires, no-unsafe-argument, no-explicit-any |

---

## 6. Mock Veri Kullanan Sayfalar (API'ye Bagli Degil)

| Sayfa | Mock Veri | Satir |
|-------|-----------|-------|
| `DatabaseManagementPage.tsx` | `mockSchemas`, `mockMigrations`, `mockBackups`, `mockHealth` | 120-298 (~178 satir hardcoded data) |
| `OnboardingPage.tsx` | `mockSteps`, `mockProgress`, `mockResources`, `mockStats` | 105-254 (~149 satir hardcoded data) |
| `TenantConfigurationPage.tsx` | `mockConfig` | 198-324 (~126 satir hardcoded data) |

Bu 3 sayfa toplam ~453 satir mock veri iceriyor ve uretim ortaminda gercek veri gostermiyor.

---

## 7. Naming Tutarsizliklari

### 7.1 Dosya Adlandirma

- 34/35 sayfa `*Page.tsx` suffix'i kullaniyor
- **Istisna:** `AdminDashboard.tsx` (Page suffix'i yok, diger dashboard'lar `AnalyticsDashboardPage.tsx`, `BillingDashboardPage.tsx` seklinde)

### 7.2 API Base URL Tanimlari

| Pattern | Dosya | Tanim |
|---------|-------|-------|
| `adminApi.ts` | `services/adminApi.ts:15` | `const API_BASE_URL = import.meta.env.VITE_ADMIN_API_URL \|\| '/api'` |
| `DatabaseExplorerPage` | `pages/DatabaseExplorerPage.tsx:63` | `const API_BASE = '/api/database/explorer'` (hardcoded, env degiskeni yok) |
| `ReportsPage` | `pages/ReportsPage.tsx:18` | `const API_BASE_URL = import.meta.env.VITE_ADMIN_API_URL \|\| '/api'` (adminApi ile ayni ama tekrar tanim) |

### 7.3 Error Handling Tutarsizligi

Frontend genelinde 150 catch blogu mevcut. Degisken adlandirmasi tutarsiz:
- `catch (error)` -- 4 dosyada 9 kullanim
- `catch (err)` -- 43 dosyada 141 kullanim

Tip guvenligi yok: catch bloklarinda `err` degiskeni `unknown` tipinde ama `err.message` veya `error.message`'a dogrudan erisiyor (9 dosyada dogrulanmis).

### 7.4 console.log Kalintilari

| Konum | Adet | Detay |
|-------|------|-------|
| Frontend (uretim kodu, test haric) | 102 | `console.error` (cogunluk), `console.log` (CompliancePage.tsx:501 debug amaçli), `console.warn` |
| Backend (uretim kodu, test haric) | 1 | `app.module.ts:70` -- SSL uyari mesaji |

**Not:** Frontend'de `console.error` catch bloklarinda yaygin. Ama `console.log('Action:', action, 'on request:', selectedRequest?.id)` (CompliancePage.tsx:501) acik bir debug kalintisi.

---

## Ozet Tablosu

| Kategori | Kalem Sayisi | Oncelik | Etki |
|----------|-------------|---------|------|
| Dead code (component/hook/api) | 8 | YUKSEK | ~8.176 satir gereksiz kod, bundle boyutunu sisman latiyor |
| Legacy dosyalar (bos/tek satir) | 4 | DUSUK | Karisiklik, yeni gelistiriciler icin kafa karistirici |
| TODO/FIXME notlari | 12 | ORTA | Eksik ozellikler (email entegrasyonu, auth context) |
| Duplicate kod (getAuthHeader) | 7 kopya | ORTA | Bakim maliyeti, DRY ihlali |
| Duplicate kod (apiFetch) | 2 kopya | ORTA | Tutarsiz error handling, retry politikasi farki |
| MIXED fetch pattern (adminApi bypass) | 5 sayfa | ORTA | Tutarsiz hata yonetimi |
| Unused dependency (react-query) | 1 | DUSUK | Gereksiz bundle agirlik |
| Type debt (as any -- uretim) | 9 | ORTA | Tip guvenligi kaybı (ozellikle backend'deki 7 enum uyumsuzlugu) |
| (req as any).user | 4 | ORTA | @CurrentUser() decorator kullanilmali |
| Mock veri sayfalar | 3 | YUKSEK | Uretim ortaminda gercek veri gostermiyor |
| Naming tutarsizligi | 3 | DUSUK | AdminDashboard vs *Page suffix, API_BASE tanimlari |
| console.log debug kalintisi | 1 | DUSUK | CompliancePage.tsx:501 |
| eslint-disable | 10 | DUSUK | Hook dependency uyarilari bastiriliyor |

---

## Sorumluluk Notu

Bu rapor kod-seviyesi temizlik konularini kapsar. Mimari pattern tutarsizliklari (CQRS vs klasik service, global guard vs explicit guard), layer violation'lar ve SRP ihlalleri P8'in sorumlulugundadir ve bu raporda ele alinmamistir.
