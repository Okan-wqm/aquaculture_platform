# Sprint 3 Fix -- Grup Q: Mock Sayfa Entegrasyon Raporu

**Tarih:** 2026-03-14
**Grup:** Q (Mock Sayfa Entegrasyon Uzmani)
**Durum:** TAMAMLANDI

---

## Ozet

Uc sayfa mock data'dan gercek API entegrasyonuna gecrildi:

| Bulgu | Sayfa | Zorluk | Durum |
|-------|-------|--------|-------|
| C10/34 | OnboardingPage | Kolay | TAMAMLANDI |
| H27/35 | ErrorTrackingPage | Kolay | TAMAMLANDI |
| C10/36 | TenantConfigurationPage | Orta | TAMAMLANDI |

---

## 1. OnboardingPage (C10/34)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/pages/OnboardingPage.tsx`
**API Namespace:** `supportApi` (`/var/aqua-saas/web/modules/admin-panel/src/services/api/support.ts`)

### Yapilanlar
- **Mock data kaldirildi:** `mockSteps`, `mockProgress`, `mockResources`, `mockStats`, `guides` -- tumu silindi (~140 satir mock)
- **API cagrilari eklendi:**
  - `supportApi.getOnboardingSteps()` -- adim tanimlari
  - `supportApi.getTenantOnboardings({ status })` -- tenant ilerlemeleri (PaginatedResult)
  - `supportApi.getOnboardingStats()` -- istatistikler
  - `supportApi.getTrainingResources()` -- egitim kaynaklari
- **Action handler'lar gercek API'ye baglandi:**
  - `supportApi.initializeOnboarding(tenantId, tenantName)` -- onboarding baslatma
  - `supportApi.assignOnboardingGuide(tenantId, guideId, guideName)` -- rehber atama
  - `supportApi.skipOnboarding(tenantId)` -- atlama
- **Loading state eklendi:** Spinner ile yukleme ekrani
- **Error state eklendi:** Hata mesaji + Retry butonu
- **Action loading state eklendi:** Butona ozel disabled + spinner

### Tip Uyumlulugu
- Yerel `OnboardingProgress` tipi kaldirildi, API'nin `TenantOnboarding` tipi kullanildi
- `TenantOnboarding` alanlari: `tenantId`, `tenantName`, `status`, `completedSteps`, `currentStep`, `progress`, `startedAt`, `completedAt`, `lastActivityAt`, `assignedTo`, `notes`
- Status degerleri: `not_started | in_progress | completed | stalled` (eskiden `skipped` vardi, API'de `stalled`)
- `completionPercent` -> `progress` (API alan adi)
- `mockSteps` referanslari -> `steps` state'i (API'den yuklenen)
- `mockResources` referanslari -> `resources` state'i (API'den yuklenen)

### Backend Dogrulama
- **OnboardingController:** `support/onboarding` prefix, 14 endpoint (02-backend-map.md, satir 287)
- **OnboardingService:** `src/support/services/onboarding.service.ts` (satir 352)
- Entity: `admin.onboarding_progress` tablosu

---

## 2. ErrorTrackingPage (H27/35)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx`
**API Namespace:** `systemSettingsApi` (`/var/aqua-saas/web/modules/admin-panel/src/services/api/settings.ts`)

### Yapilanlar
- **Import duzeltildi:** `systemApi` -> `systemSettingsApi`
  - `systemApi` sadece sistem metrikleri icin (`/system/metrics` endpoint'leri)
  - Error tracking endpoint'leri `systemSettingsApi` altinda (`/system/errors/*`)
- **Yorum acilan API cagrilari:**
  - `systemSettingsApi.getErrorGroups({ status, severity, service, search, startDate, endDate })` -- hata gruplari
  - `systemSettingsApi.getErrorDashboard()` -- dashboard istatistikleri
  - `systemSettingsApi.getErrorOccurrences(groupId)` -- hata oluslari (detay modal)
- **Action handler'lar gercek API'ye baglandi:**
  - `systemSettingsApi.resolveError(id, 'admin')` -- cozumleme
  - `systemSettingsApi.ignoreError(id)` -- yoksayma
  - `systemSettingsApi.updateErrorStatus(id, 'acknowledged')` -- onaylama
- **Optimistic update'ler kaldirildi:** Artik API response'u kullaniliyor

### Tip Uyumlulugu
- `ErrorGroup` ve `ErrorOccurrence` tipleri zaten dogru import edilmisti
- `getErrorOccurrences` donusu `PaginatedResult<ErrorOccurrence>`, `.data` ile erisiilyor
- `getErrorGroups` donusu `PaginatedResult<ErrorGroup>`, `.data` ile erisiilyor
- `getErrorDashboard` `todayErrors` icin `errorTrend` array'inin son elemani kullaniliyor

### Backend Dogrulama
- **ErrorTrackingController:** `system/errors` prefix, 18 endpoint (02-backend-map.md, satir 300)
- **ErrorTrackingService:** `src/system-management/services/error-tracking.service.ts` (satir 355)
- Entity: `admin.error_groups`, `admin.error_occurrences` tablolari

---

## 3. TenantConfigurationPage (C10/36)

**Dosya:** `/var/aqua-saas/web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx`
**API Namespace:** `settingsApi` (`/var/aqua-saas/web/modules/admin-panel/src/services/api/settings.ts`)

### Yapilanlar
- **Import eklendi:** `settingsApi` ve `TenantConfiguration as ApiTenantConfiguration`
- **loadConfiguration() guncellendi:**
  - Mock config objesi (~120 satir) kaldirildi
  - `settingsApi.getTenantConfig(tenantId)` cagrildi
  - API'nin duz `{ tenantId, configuration: Record<string,unknown>, branding?, apiKeys?, webhooks?, updatedAt }` yapisini yerel detayli `TenantConfiguration` tipine mapleme eklendi
  - Eksik alanlar icin guvenli varsayilan degerler kullanildi
- **handleSave() guncellendi:**
  - Mock `setTimeout` kaldirildi
  - `settingsApi.updateTenantConfig(tenantId, config)` cagrildi
  - Yerel config yapisini API formatina donusturuyor
- **API key olusturma guncellendi:**
  - Mock `setNewApiKey('aq_prod_xxx')` kaldirildi
  - `settingsApi.createTenantApiKey(tenantId, { name, scopes })` cagrildi
  - Basarili olusturma sonrasi config yeniden yukleniyor
  - Form `name="keyName"` attribute'u eklendi

### Tip Uyumlulugu
- API `TenantConfiguration` tipi ile yerel `TenantConfiguration` tipi arasinda onemli farklar var:
  - API: duz `configuration: Record<string, unknown>` + `branding?` + `apiKeys?` + `webhooks?`
  - Yerel: detayli alt-interfaceler (UserLimitsConfig, StorageConfig, vb.)
  - Cozum: `loadConfiguration()` icinde mapping yapildi, her alt-section API'nin `configuration` Record'undan cast ediliyor
- API key tipleri: API `scopes`, yerel `permissions` -- mapping uygulanmis

### Backend Dogrulama
- **TenantConfigurationController:** `settings/tenant` prefix, 30+ endpoint (02-backend-map.md, satir 268-269)
- **TenantConfigurationService:** `src/settings/services/tenant-configuration.service.ts` (satir 338)
- Entity: `admin.tenant_configurations` tablosu
- Alt endpoint'ler: domain, branding, security, notifications, features, data-retention (03-contract-map.md, satir 233)

---

## Riskler & Notlar

1. **Tip Uyumsuzlugu (TenantConfigurationPage):** API'nin `configuration: Record<string,unknown>` yapisina cok detayli yerel config nesnesi gonderiliyor. Backend bu alanlari dogru parse etmeli. Ideal cozum backend'e ozel sub-endpoint'ler uzerinden yapmak olabilir (zaten 30+ endpoint var, alt-bolum endpoint'leri mevcut olabilir).

2. **Pagination:** OnboardingPage `getTenantOnboardings` PaginatedResult donuyor ancak sayfa henuz pagination UI'i icerrmiyor. Ilk sayfadaki veriler gosteriliyor.

3. **ErrorTrackingPage todayErrors:** Dashboard API'sinde `todayErrors` alani yok, `errorTrend` array'inin son elemani kullaniliyor. Yanlis hesaplanabilir eger trend baska periyotlarda ise.

4. **OnboardingPage guides dropdown:** Eski mock'ta `guides` dizisi vardi. API'de rehber listesi icin endpoint yok. Assign guide islemi `supportApi.assignOnboardingGuide(tenantId, guideId, guideName)` ile yapiliyor ama guide secim dropdown'u kaldirildi. Ileride guide listesi endpoint'i eklenirse dropdown geri eklenebilir.
