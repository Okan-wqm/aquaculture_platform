# P16: Feature Completeness x Kontrat -- Capraz Analiz

Tarih: 2026-03-14
Girdiler: P12 (Feature Completeness), P3 (Contract Map), P6 (Bugs)
Ajan: Capraz Analiz Ajani (P16)

---

## Yonetici Ozeti

4 mock/stub sayfa, 80+ kullanilmayan API fonksiyonu, 5 kirik kontrat ve 41 yetim backend
endpoint'i birlikte degerlendirildiginde ortaya cikan tablo: frontend-backend entegrasyonu
%64 tamamlanmis, ancak kalan %36'lik dilim birbiriyle baglantili sorunlar iceriyor.
Mock sayfalar icin adminApi fonksiyonlari HAZIR ama cagrilmiyor; kirik kontratlar runtime
404/400 hatasi uretiyor; yetim backend endpoint'lerinin cogu tenant-configuration alt
kaynaklari olup TenantConfigurationPage entegrasyonunda degerlendirilmeli.

---

## 1. Mock/Stub Sayfalarin Backend Entegrasyon Yol Haritasi

### 1.1 DatabaseManagementPage (MOCK_ONLY -- 1355 satir)

**Soru:** `adminApi.databaseApi` kullanilmali mi?

**Cevap:** KISMEN. `databaseApi` namespace'inde 24 fonksiyon tanimli, ancak P3 raporuna gore
bunlarin **16'si ORPHAN_FE** -- backend'de karsiligi yok veya farkli path'te:

| Tab | adminApi Fonksiyonu | Backend Durumu | Kullanilabilir mi? |
|-----|---------------------|----------------|---------------------|
| Schemas | `getSchemas` | BE: `GET /database/schemas` VAR | EVET |
| Schemas | `getSchema` | BE: `GET /database/schemas/:id` -- info endpoint farkli | KISMI (path uyumu gerekli) |
| Schemas | `createSchema` | BE: `POST /database/schemas` VAR | EVET |
| Schemas | `deleteSchema` | BE: `DELETE /database/schemas/:tenantId` VAR | EVET |
| Schemas | `resetSchema` | BE'de YOK (suspend/activate var) | HAYIR -- ORPHAN_FE |
| Schemas | `optimizeSchema` | BE'de YOK | HAYIR -- ORPHAN_FE |
| Schemas | `analyzeSchema` | BE'de YOK | HAYIR -- ORPHAN_FE |
| Migrations | `getMigrations` | BE: list yok, `history` var | HAYIR -- path farki |
| Migrations | `runMigration` | BE: `tenant/:tenantId/run` (farkli param) | HAYIR -- path farki |
| Migrations | `rollbackMigration` | BE: `tenant/:tenantId/rollback` | HAYIR -- path farki |
| Migrations | `getPendingMigrations` | BE: `tenant/:tenantId/pending` | HAYIR -- path farki |
| Backups | `getBackups` | BE: `GET /database/backups` VAR | EVET (TYPE_MISMATCH var) |
| Backups | `createBackup` | BE: `POST /database/backups` VAR | EVET |
| Backups | `restoreBackup` | BE path farki: body icinde backupId | KISMI |
| Backups | `deleteBackup` | BE: `DELETE /database/backups/:id` VAR | EVET |
| Monitoring | `getDatabaseStats` | BE: `/monitoring/health` var, `stats` yok | HAYIR -- ORPHAN_FE |
| Monitoring | `getSlowQueries` | BE: `GET /monitoring/slow-queries` VAR | EVET |
| Monitoring | `getConnectionStats` | BE: `GET /monitoring/connections` VAR | EVET |

**Sonuc:** 24 fonksiyondan sadece ~8 tanesi dogrudan kullanilabilir. Migration ve monitoring
tab'lari icin ya backend endpoint'leri eklenmeli ya da adminApi fonksiyonlari backend'e
uyumlu hale getirilmeli. Oneri: once Schemas + Backups + Monitoring (getSlowQueries,
getConnectionStats) baglansin (8 fonksiyon), Migration tab'i backend uyumlulasmasi beklesin.

### 1.2 OnboardingPage (MOCK_ONLY -- 804 satir)

**Soru:** `adminApi.supportApi.onboarding*` fonksiyonlari kullanilmali mi?

**Cevap:** EVET -- tam uyum. Backend `onboarding.controller.ts` ile frontend
`supportApi` onboarding fonksiyonlari 1:1 eslesiyor:

| adminApi Fonksiyonu | Backend Endpoint | Uyum |
|---------------------|------------------|------|
| `getOnboardingSteps` | `GET /support/onboarding/steps` | TAM |
| `getTenantOnboardings` | `GET /support/onboarding` | TAM |
| `getTenantOnboarding` | `GET /support/onboarding/:tenantId` | TAM |
| `initializeOnboarding` | `POST /support/onboarding/initialize` | TAM |
| `completeOnboardingStep` | `POST /:tenantId/step/:stepId/complete` | TAM |
| `skipOnboardingStep` | `POST /:tenantId/step/:stepId/skip` | TAM |
| `assignOnboardingGuide` | `POST /:tenantId/assign-guide` | TAM |
| `getOnboardingStats` | `GET /support/onboarding/stats` | TAM |
| `getTrainingResources` | `GET /support/onboarding/resources/all` | TAM |

**Sonuc:** En kolay entegrasyon. Mock veri kaldirilip supportApi fonksiyonlari dogrudan
cagrilabilir. Backend ek olarak `welcome-email`, `training sessions` ve
`tutorial/getting-started view` endpoint'leri sunuyor -- bunlar da sayfaya eklenebilir.
**Oncelik: P0 -- hemen uygulanabilir.**

### 1.3 TenantConfigurationPage (MOCK_ONLY -- 1057 satir)

**Soru:** `adminApi.settingsApi.tenant*` fonksiyonlari kullanilmali mi?

**Cevap:** EVET -- temel CRUD uyumlu, ama backend cok daha zengin.

| adminApi Fonksiyonu | Backend Endpoint | Uyum |
|---------------------|------------------|------|
| `getTenantConfig(tenantId)` | `GET /settings/tenant/:tenantId` | TAM |
| `updateTenantConfig(tenantId, config)` | `PUT /settings/tenant/:tenantId` | TAM |
| `createTenantApiKey` | `POST /settings/tenant/:tenantId/api-keys` | TAM |
| `revokeTenantApiKey` | `DELETE /settings/tenant/:tenantId/api-keys/:keyId` | TAM |
| `createWebhook` | `POST /settings/tenant/:tenantId/webhooks` | TAM |
| `deleteWebhook` | `DELETE /settings/tenant/:tenantId/webhooks/:webhookId` | TAM |
| `testWebhook` | `POST /:tenantId/webhooks/:webhookId/test` | TAM |

Backend ayrica 15+ ek alt-endpoint sunuyor (ORPHAN_BE #41 grubunun parcasi):
`user-limits`, `storage`, `api`, `domain/verify`, `branding`, `security`,
`notifications`, `features`, `data-retention`. TenantConfigurationPage'in mock verisi
zaten bu alt bolumleri iceriyor (userLimits, storageConfig, apiConfig, dataRetention).
Sayfa entegre edilirken hem `settingsApi` fonksiyonlari hem de bu ek backend
endpoint'leri birlikte kullanilmali.

**Sonuc:** Entegrasyon orta zorlukta. adminApi'ye ek fonksiyonlar eklenmeli
(user-limits, storage, domain, branding, security, notifications, features,
data-retention alt-endpoint'leri). **Oncelik: P1.**

### 1.4 ErrorTrackingPage (STUB -- 594 satir)

**Soru:** Yorumlanmis API cagrilari acilmali mi?

**Cevap:** EVET -- ama import duzeltmesi gerekli.

**Mevcut sorun:** Sayfa `systemApi` import ediyor (satir 10), ancak error tracking
fonksiyonlari `systemSettingsApi` altinda tanimli:
- `systemSettingsApi.getErrorDashboard` -> `GET /system/errors/dashboard`
- `systemSettingsApi.getErrorGroups` -> `GET /system/errors/groups`
- `systemSettingsApi.getErrorOccurrences` -> `GET /system/errors/groups/:id/occurrences`
- `systemSettingsApi.resolveError` -> `POST /system/errors/groups/:id/resolve`
- `systemSettingsApi.ignoreError` -> `POST /system/errors/groups/:id/ignore`
- `systemSettingsApi.updateErrorStatus` -> `PUT /system/errors/groups/:id/status` (P3'e gore `PUT /groups/:id`)

Backend `error-tracking.controller.ts` tum bu endpoint'leri sunuyor ve ek olarak
`report`, `acknowledge`, `assign`, `merge`, `alert-rules` CRUD, `stats` gibi
endpoint'ler de mevcut.

**Yapilmasi gerekenler:**
1. Import: `systemApi` -> `systemSettingsApi`
2. Yorumlari ac: `loadData` icindeki `getErrorGroups` cagrisi ve `loadErrorDetails`
   icindeki `getErrorOccurrences` cagrisi
3. `handleResolve` fonksiyonundaki optimistic update'i gercek API cagrisiyla degistir
4. Stats icin `getErrorDashboard` kullan

**Sonuc:** Dusuk eforlu entegrasyon. **Oncelik: P0.**

---

## 2. 80+ UNUSED_API Fonksiyonu -- Mock Sayfalara Baglanti Analizi

| Grup | Sayi | Mock/Stub Sayfaya Baglanmali mi? | Aksiyon |
|------|------|----------------------------------|---------|
| `databaseApi` (23 fonk.) | 23 | EVET -- DatabaseManagementPage | 8 tanesi dogrudan, 15'i backend uyumu sonrasi |
| `supportApi.onboarding*` (9 fonk.) | 9 | EVET -- OnboardingPage | Dogrudan baglanabilir |
| `settingsApi.tenant*` (7 fonk.) | 7 | EVET -- TenantConfigurationPage | Dogrudan baglanabilir |
| `systemSettingsApi.error*` (6 fonk.) | 6 | EVET -- ErrorTrackingPage | Import duzelt + yorumlari ac |
| `reportsApi` (12 fonk.) | 12 | HAYIR -- ReportsPage kendi wrapper'ini kullaniyor | ReportsPage'i reportsApi'ye gecir |
| `systemSettingsApi.jobs*` (4 fonk.) | 4 | HAYIR -- JobQueuePage zaten entegre | Sayfaya ek ozellik olarak eklenebilir |
| `tenantsApi` cesitli (10 fonk.) | 10 | HAYIR -- Mevcut sayfalarda kullanilmiyor | Ihtiyac analizi gerekli |
| `billingApi` cesitli (9 fonk.) | 9 | KISMI -- InvoicesPage markPaid/void, DiscountCode update | Eksik CRUD olarak eklenebilir |
| `analyticsApi` ORPHAN_FE (4 fonk.) | 4 | HAYIR -- Backend endpoint'leri yok | SIL veya backend ekle |
| `impersonationApi.checkPermission` | 1 | HAYIR -- Path uyumsuzlugu | Path duzelt |

**Ozet:** 80+ kullanilmayan fonksiyonun **45 tanesi** (%56) mock/stub sayfalara
dogrudan baglanabilir. **12 tanesi** ReportsPage refactor'u ile aktif hale gelir.
**4 tanesi** backend'i olmayan ORPHAN_FE -- silinmeli. Kalan **~20 tanesi**
mevcut sayfalara ek CRUD operasyonu olarak veya yeni sayfalar olarak eklenebilir.

---

## 3. BROKEN_CONTRACT Sayfalari -- Fix Onceligi

| # | Sayfa | Sorun | Backend Gercegi | Etki | Fix | Oncelik |
|---|-------|-------|-----------------|------|-----|---------|
| 1 | AnnouncementsPage | `unpublishAnnouncement` POST `/:id/unpublish` | BE: `POST /:id/cancel` var, `/unpublish` yok | 404 -- duyuru geri alinmiyor | adminApi.ts satir 893-894: path'i `/cancel` yap, fonksiyon adini `cancelAnnouncement` olarak degistir | **P0** -- tek satir fix |
| 2 | SystemSettingsPage | `updateSecurityConfig` PUT `/settings/config/security` | BE: sadece `GET /settings/config/security` var, PUT yok | 404/405 -- guvenlik ayarlari KAYDEDILMIYOR | Backend'e `PUT /settings/config/security` ekle VEYA frontend'i `PUT /settings/key/:key` bulk update'e cevir | **P0** -- admin guvenlik ayarlarini degistiremiyor |
| 3 | SystemSettingsPage | `updateRateLimits` PUT `/settings/config/rate-limits` | BE: sadece GET var, PUT yok | 404/405 -- rate limit degismiyor | Ayni fix -- backend PUT ekle | **P0** |
| 4 | ImpersonationPage | `extendSession` POST `/:id/extend` | BE'de yok | 404 -- oturum uzatilmiyor | Backend'e `POST /sessions/:id/extend` ekle (service metodu gerekli) | **P1** -- workaround: yeni oturum baslat |
| 5 | ImpersonationPage | `revokeSession` POST `/:id/revoke` | BE: `POST /:id/terminate` var | 404 -- oturum sonlandirilmiyor | adminApi.ts: path'i `/terminate` yap | **P0** -- tek satir fix |

**P6 raporu ile kesisim:** BUG-007 (ReportsPage bypass) ve BUG-011 (BillingDashboard
dogrudan fetch) kirik kontrat sayilmasa da, ayni kok neden: adminApi bypass'i. Bu
sayfalar da kontrat uyumsuzlugu riski tasiyor cunku envelope unwrap, retry, ve
X-Request-ID yoklugundan tutarsiz hata davranisi sergiliyorlar.

**Onerilen fix sirasi:**
1. AnnouncementsPage `unpublish->cancel` (1 satir, FE)
2. ImpersonationPage `revoke->terminate` (1 satir, FE)
3. SystemSettingsPage security/rate-limits PUT (BE endpoint ekleme)
4. ImpersonationPage `extend` (BE endpoint ekleme)

---

## 4. ORPHAN_BE Endpoint'leri -- Frontend Karsiligi Analizi

41 yetim backend endpoint'i 5 kategoriye ayrilabilir:

### Kategori A: TenantConfigurationPage entegrasyonunda kullanilacak (15 endpoint)
`/settings/tenant/:tenantId/` altindaki: `user-limits`, `storage`, `storage/check-limit`,
`api`, `api-keys/validate`, `webhooks` (GET/PUT), `domain`, `domain/verify`,
`domain/confirm`, `branding`, `security` (ip-whitelist/blacklist), `notifications`,
`features` (modules enable/disable), `data-retention`.

**Sonuc:** TenantConfigurationPage mock->API gecisi sirasinda bu endpoint'lerin hepsi
kullanilmali. adminApi.ts'ye ek fonksiyonlar eklenmeli.

### Kategori B: DatabaseManagementPage entegrasyonunda kullanilacak (12 endpoint)
`/database/monitoring/` altinda: `health`, `query-performance`, `analyze-query`,
`storage`, `storage/by-tenant`, `index-recommendations`, `metrics`.
`/database/schemas/` altinda: `summary`, `sync`, `suspend`, `activate`, `validate`,
`refresh-stats`, `connections/pool`, `connections/by-tenant`.
`/database/backups/` altinda: `summary`, `tenant/:tenantId`, `restore/point-in-time`.
`/database/migrations/` altinda: `available`, `summary`, `batch/run`, `batch/:version/status`.

**Sonuc:** DatabaseManagementPage'in monitoring tab'i bu endpoint'leri kullanabilir.
Migration tab'i `batch/run` ve `tenant/:tenantId/run` ile calismali. adminApi.databaseApi
fonksiyonlarinin path'leri bu gercek backend endpoint'lerine uyumlu hale getirilmeli.

### Kategori C: Mevcut sayfalara ek ozellik olarak eklenebilir (8 endpoint)
- `/security/activities/login-attempts/:ip` -> ActivityLogPage
- `/security/activities/sessions/user/:userId` -> ActivityLogPage
- `/security/activities/sessions/user/:userId/terminate` -> ActivityLogPage
- `/security/audit/export` -> AuditTrailPage
- `/security/audit/retention-stats` -> AuditTrailPage
- `/security/audit/retention-policies/apply` -> AuditTrailPage
- `/tenants/:id/provision` -> CreateTenantPage (otomatik provision)
- `/tenants/:id/provision/status` -> TenantDetailPage

### Kategori D: Altyapi/saglik -- frontend karsiligi gerekmez (4 endpoint)
- `/health/metrics`, `/health/live`, `/health/ready`, `/health/startup`

**Sonuc:** Kubernetes probelari ve monitoring araclari icin. Admin panel'de gosterilmesi
gerekmez (PerformanceDashboard zaten systemSettingsApi uzerinden metrik aliyor).

### Kategori E: Zengin backend -- gelecek ozellikler (2+ endpoint)
- `system-management` version/config/threshold endpoint'leri (global-settings.controller)
- `database/explorer` ek endpoint'leri: `tables` shortcut, `structure`

**Toplam:** 41 ORPHAN_BE'nin **27 tanesi** (%66) mock sayfa entegrasyonlariyla
otomatik olarak karsilanacak. **8 tanesi** mevcut sayfalara ek ozellik. **4 tanesi**
altyapi (FE gerekmez). **2+ tanesi** gelecek ozellik.

---

## 5. Frontend Error Handling x Backend Hata Formati Uyumu

### Backend hata formati (global-exception.filter.ts):
```
{ success: false, statusCode, message, error, timestamp, path, requestId, details? }
```

### Frontend apiFetch hata islemesi (adminApi.ts:70-75):
```ts
const errorBody = await response.json().catch(() => ({ message: 'API Error' }));
const error = new Error(errorBody.message || `HTTP ${response.status}`);
error.status = response.status;
error.code = errorBody.code;         // BE gondERMIYOR -- her zaman undefined
error.details = errorBody.details;   // BE gonderiyor -- uyumlu
```

### Uyumsuzluklar:

| # | Alan | Backend | Frontend | Sorun |
|---|------|---------|----------|-------|
| 1 | `code` | Gondermiyor | `errorBody.code` okuyor | Her zaman `undefined` -- hata tipi ayristirilmiyor |
| 2 | `error` (string) | Gonderiyor ("Bad Request", "Not Found") | Okumuyor | Kullanilmayan bilgi |
| 3 | `statusCode` | Gonderiyor (sayi) | `response.status` kullaniyor | Uyumlu ama farkli kaynak |
| 4 | `timestamp`, `path` | Gonderiyor | Okumuyor | Loglama icin faydali olabilir |
| 5 | `requestId` | Gonderiyor (FE'nin gonderdigini echo) | Okumuyor | Tracing kaybi |
| 6 | Bypass sayfalar | -- | Kendi fetch wrapper'i | retry YOK, envelope unwrap YOK, requestId YOK |

### Kritik sorun: Bypass sayfalar
ReportsPage (kendi apiFetch'i) ve BillingDashboardPage (dogrudan fetch) backend hata
envelope'unu HICBIR SEKILDE parse etmiyor. Hata durumunda:
- ReportsPage: `response.json()` dondurur -> `{ success: false, statusCode: 400, message: ... }` objesi sayfa verisimis gibi islenir
- BillingDashboardPage: catch blogunda sessizce bos array atar -> kullanici hata gormez

### Oneri:
1. `apiFetch`'e `requestId` echo kontrolu ekle (response header'da donebilir)
2. `ApiError` interface'ine `errorType` (backend'in `error` field'i) ekle
3. Bypass sayfalarini adminApi namespace'lerine gecir (P6-BUG-007, P6-BUG-011)
4. `ValidationPipe` hatalarinda (400) `message` array donebilir -- frontend bunu
   `string | string[]` olarak handle etmeli

---

## 6. Oncelikli Aksiyon Plani

### Sprint 1 -- Hemen (1-2 gun)
| # | Is | Tur | Dosya | Etki |
|---|---|-----|-------|------|
| 1 | AnnouncementsPage unpublish->cancel | FE fix | adminApi.ts:893-894 | 404 giderilir |
| 2 | ImpersonationPage revoke->terminate | FE fix | adminApi.ts | 404 giderilir |
| 3 | ErrorTrackingPage yorumlari ac + import duzelt | FE fix | ErrorTrackingPage.tsx | Bos sayfa canlanir |
| 4 | OnboardingPage mock->API gecisi | FE refactor | OnboardingPage.tsx | Mock veri gider |

### Sprint 2 -- Kisa vade (3-5 gun)
| # | Is | Tur | Dosya | Etki |
|---|---|-----|-------|------|
| 5 | SystemSettingsPage security/rate-limits PUT | BE ekleme | settings.controller.ts | Ayar kaydetme calismaya baslar |
| 6 | TenantConfigurationPage mock->API | FE refactor | TenantConfigurationPage.tsx + adminApi.ts | Mock veri gider, 15 ORPHAN_BE karsilanir |
| 7 | ReportsPage adminApi.reportsApi gecisi | FE refactor | ReportsPage.tsx | 12 UNUSED_API aktif olur |
| 8 | BillingDashboardPage dogrudan fetch kaldir | FE refactor | BillingDashboardPage.tsx | Sessiz hata yutma gider |

### Sprint 3 -- Orta vade (1-2 hafta)
| # | Is | Tur | Etki |
|---|---|-----|------|
| 9 | DatabaseManagementPage kismi entegrasyon | FE+BE | 8 fonksiyon aktif, monitoring canlanir |
| 10 | databaseApi path uyumlulastirma (migration) | BE refactor | 16 ORPHAN_FE giderilir |
| 11 | ImpersonationPage extend endpoint | BE ekleme | Oturum uzatma calismaya baslar |
| 12 | Eksik CRUD ekleme (EmailTemplates delete, DiscountCode update, Invoices markPaid/void) | FE | 6 UNUSED_API aktif olur |

### Sprint 4 -- Temizlik
| # | Is | Tur | Etki |
|---|---|-----|------|
| 13 | 4 ORPHAN_FE analyticsApi fonksiyonunu sil | FE temizlik | Dead code azalir |
| 14 | Kalan UNUSED_API fonksiyonlari icin karar: sil veya bagla | Tasarim | ~20 fonksiyon karara baglanir |
| 15 | PARTIALLY_INTEGRATED sayfalardaki dogrudan fetch'leri adminApi'ye tasi | FE refactor | 7 sayfa tutarli hale gelir |

---

## 7. Risk Matrisi

| Risk | Olasilik | Etki | Azaltma |
|------|----------|------|---------|
| Mock sayfa entegrasyonunda TYPE_MISMATCH | Yuksek | Backend farkli field seti donebilir | Her entegrasyonda response mapping testi yaz |
| ErrorTrackingPage import duzeltmesi sirasinda BUG-001 tetiklenmesi | Orta | useAsyncData refetch sorunu (P6-BUG-001) canlanir | BUG-001 fix'ini once uygula |
| TenantConfigurationPage icin ek adminApi fonksiyonlari eklenirken path hatasi | Orta | Yeni ORPHAN_FE olusabilir | Backend controller ile birebir eslestir |
| databaseApi migration path duzeltmesi sirasinda DatabaseExplorerPage kirilmasi | Dusuk | Explorer kendi fetch'ini kullaniyor, etkilenmez | Ayri PR'larda ilerle |

---

## 8. Metrik Ozeti

| Metrik | Deger |
|--------|-------|
| Toplam sayfa | 39 |
| Tam entegre (isleyen) | 25 (%64) |
| Entegrasyon bekleyen (mock/stub/bypass) | 8 (%21) |
| Kirik kontrat (runtime hata) | 3 sayfa, 5 endpoint (%8) |
| Kismi entegre (karisik pattern) | 7 (%18) |
| Kullanilmayan adminApi fonksiyonu | ~80 |
| Mock->API gecisiyle aktif olacak fonksiyon | ~45 |
| ORPHAN_BE (frontend karsiligi yok) | 41 |
| Mock entegrasyonuyla karsilanacak ORPHAN_BE | ~27 |
| Kalici ORPHAN_BE (altyapi, gelecek) | ~6 |
| FE error handling uyumsuzlugu | 3 alan (code, error, requestId) |
| Bypass sayfa (tutarsiz hata yonetimi) | 2 sayfa + 5 kismi bypass |
