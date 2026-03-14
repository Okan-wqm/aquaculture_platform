# Admin Panel Audit -- Final Sentez Raporu

**Tarih:** 2026-03-14
**Hazirlayan:** P17 Bas Analist
**Kapsam:** Admin Panel frontend (`web/modules/admin-panel/src/`) + Admin API Service backend (`apps/admin-api-service/src/`)

---

## Yonetici Ozeti

Admin panel audit sureci 16 planli ajan ve 3 deep-dive analizi ile tamamlanmistir. Toplam 19 rapor, ~44.293 satirlik frontend ve ~181 dosyalik backend kod tabanini kapsamaktadir. **En kritik bulgular:** (1) Database Explorer raw SQL endpoint'inde semicolon kontrolu olmamasi, `SET`/`set_config`/`DO` komutlarinin bloke edilmemesi ve CRUD endpoint'lerinin production'da ortam kontrolsuz acik kalmasi ile birlestiginde **tam tenant izolasyonu kirma** ve **production veritabaninda dogrudan veri manipulasyonu** mumkundur. (2) 34 endpoint'te admin kimligi client'tan alinmakta, audit trail tamamen guvenilmez hale gelmektedir. (3) `useAsyncData` hook'undaki refetch eksikligi 6 sayfada stale data gosterilmesine, `ImpersonationPage` cache bug'i crash'e, sinirsiz cache Map'i bellek sizintisina neden olmaktadir. (4) 3 sayfa tamamen mock veri, 1 sayfa stub, 5 kontrat kirik durumdadir. (5) Test kapsamasi frontend %8.3, backend %16.6 olup guvenlik-kritik modullerin (Billing, Impersonation, DebugTools) hicbiri test edilmemistir. Onerilen yol haritasi: Sprint 1'de guvenlik aciklari ve crash bug'lari kapatilmali, Sprint 2'de mimari ve performans iyilestirmeleri yapilmali, Sprint 3'te feature gap'ler ve teknik borc temizlenmeli.

---

## Istatistikler

| Metrik | Deger |
|--------|-------|
| Toplam ajan | 16 planli + 3 deep-dive |
| Toplam rapor | 19 |
| CRITICAL | 13 |
| HIGH | 28 |
| MEDIUM | 36 |
| LOW | 18 |

---

## Oncelikli Bulgu Listesi

### CRITICAL Bulgular

| # | Baslik | Kaynak | Dosya/Satir | Etki | Fix Ozet | Effort | Bagimlilik |
|---|--------|--------|-------------|------|----------|--------|------------|
| C1 | Multi-statement SQL bypass -- semicolon kontrolu yok | P5/CRITICAL-001, DD-SQL | `explorer.controller.ts:782-844` | `SELECT 1; SET search_path TO tenant_abc` ile tenant izolasyonu kirilir. `pg` driver multi-statement destekliyor, semicolon yasaklanmamis. Ayni servisteki `database-monitoring.service.ts:303` semicolon yasagi var ama explorer'da YOK. | `sqlWithoutComments.includes(';')` kontrolu ekle | S | - |
| C2 | SET/set_config ile tenant veri sizintisi | P5/CRITICAL-001, DD-SQL | `explorer.controller.ts:793-805` | `SELECT set_config('search_path','tenant_abc',false)` session-level search_path degistirir. `dangerousStatements`'ta SET, `dangerousFunctions`'ta set_config yok. Pool'a geri donerken search_path kalici. | `dangerousStatements`'a `/\bSET\b/i`, `dangerousFunctions`'a `/\bset_config\b/i` ekle | S | - |
| C3 | DO $$ PL/pgSQL anonymous block bypass | P5/CRITICAL-002, DD-SQL | `explorer.controller.ts:787-789` | Multi-statement ile `SELECT 1; DO $$ BEGIN PERFORM set_config(...); END $$;` calistirilabilir. `DO`, `PERFORM` ne `dangerousStatements`'ta ne `startsWith` kontrolunde. | C1 fix'i (semicolon yasagi) cogu senaryoyu kapatir. Ek olarak `/\bDO\b\s*\$/i` ve `/\bPERFORM\b/i` ekle | S | C1 |
| C4 | NODE_ENV tek savunma hatti -- raw SQL | P5/CRITICAL-003, DD-SQL, XA-6 | `explorer.controller.ts:767-771` | Raw SQL engeli yalnizca `NODE_ENV === 'production'` kontrolune bagli. NODE_ENV bos/staging = acik. Ayni risk DebugToolsController icin de gecerli (`impersonation.module.ts:27`). | Fail-closed: `ENABLE_RAW_SQL_EXPLORER=true` flag ekle, varsayilan kapali | S | - |
| C5 | CRUD endpoint'leri production'da ortam kontrolsuz acik | P5/HIGH-005, DD-SQL, XA-6 | `explorer.controller.ts:542,589,647` | INSERT/UPDATE/DELETE satirlari hicbir NODE_ENV kontrolu olmadan tum ortamlarda acik. SUPER_ADMIN production'da `auth.users`'a satir ekleyebilir, `billing.subscriptions` degistirebilir, `audit_logs` silebilir. | `ENABLE_DB_EXPLORER_WRITES=true` feature flag, varsayilan kapali | S | - |
| C6 | Client-supplied admin identity -- 34 endpoint | DD-Identity, P5/HIGH-001, P2 | `debug-tools.controller.ts:393,606,618` + `billing.controller.ts` (11 endpoint) + `settings.controller.ts` (5) + `tenant-configuration.controller.ts` (8) + `ip-access.controller.ts` (2) + `compliance.controller.ts` (1) + hardcoded (3) | 30 aktif zafiyet: `@Query('adminId')`, `@Body('cancelledBy')`, `@Query('updatedBy')` vb. ile herhangi bir admin baska admin'in kimligiyle islem yapabilir. Audit trail tamamen guvenilmez. Fatura sahteciligi, abonelik iptali, IP whitelist manipulasyonu mumkun. | Tum endpoint'lerde `req.user.id` (JWT) kullan, client-supplied identity kaldir | M | - |
| C7 | useAsyncData refetch yapmıyor -- 6 sayfa stale data | P6/BUG-001, DD-Hook | `useAsyncData.ts:273-277` | Initial fetch `useEffect` bos dependency array `[]`. cacheKey degistiginde (filtre/pagination) yeni fetch tetiklenmiyor. AuditLogPage, SystemSettingsPage, ModulesPage, BillingDashboardPage, ProvisioningSettingsPage, ReportsPage etkileniyor. | `useEffect` dependency'sine `fetchData` ekle. Once BUG-014 (callback ref) fix'i gerekli, aksi halde sonsuz dongu. | S | C8 |
| C8 | useAsyncData callback ref eksik -- sonsuz dongu riski | P6/BUG-014, DD-Hook | `useAsyncData.ts:226` | `transform`, `onSuccess`, `onError` fetchData dependency array'inde. Inline callback gecilirse her renderda yeni referans = sonsuz fetch dongusu (C7 fix'i uygulanirsa). | `transform/onSuccess/onError` icin ref pattern uygula, fetchData dep'ten cikar | S | - |
| C9 | ImpersonationPage cache crash | P6/BUG-003, DD-Hook | `ImpersonationPage.tsx:119-150` | `tenantsApi.search()` `Tenant[]` dondurur, `res.data` = undefined. Cache `{data: undefined}` saklar. Ikinci ziyarette `.map()` cagirilir: TypeError crash. | `res.data` yerine `res` kullan, tip uyumunu duzelt | S | - |
| C10 | 3 sayfa tamamen mock veri -- uretimde gercek veri yok | P1, P12 | `DatabaseManagementPage.tsx`, `OnboardingPage.tsx`, `TenantConfigurationPage.tsx` | ~453 satir hardcoded mock data. Kullanicilar gercek veri goremiyor. OnboardingPage backend tam hazir, hemen baglanabilir. | Mock kaldir, adminApi fonksiyonlarini cagir | M | - |
| C11 | pg_catalog/information_schema engellenmemis | P5/HIGH-004, DD-SQL | `explorer.controller.ts:837` | `blockedSchemas` sadece `['sensor','farm','hr','hydroponics']`. `pg_catalog.pg_authid` ile DB credential hash'leri, `information_schema.columns` ile tum tenant schema yapisi okunabilir. | `blockedSchemas`'a `pg_catalog`, `information_schema` ekle | S | - |
| C12 | includeSensitive flag client-controlled | P5/HIGH-002 | `explorer.controller.ts:145,361,399` | `?includeSensitive=true` query parametresi ile password_hash, api_key, token maskelenmeden doner. Export endpoint her zaman maskeler ama data endpoint client insiyatifinde. | Parametreyi kaldir veya ek yetkilendirme mekanizmasi ekle | S | - |
| C13 | QueryEditor field mismatch -- SQL motoru tamamen kirik | P3/FIELD_MISMATCH-1 | `QueryEditor.tsx:82` vs `explorer.controller.ts:182-188` | Frontend `{schema, query}` gonderiyor, backend `{sql, params}` bekliyor. `forbidNonWhitelisted: true` ile 400 Bad Request. Ironik olarak SQL bypass'a kazara koruma ama fix edildiginde C1-C4 fix'leri de zorunlu. | `query` -> `sql` olarak degistir. BIRLIKTE C1-C4 fix'lerini uygula. | S | C1,C2,C3,C4 |

### HIGH Bulgular

| # | Baslik | Kaynak | Dosya/Satir | Etki | Fix Ozet | Effort | Bagimlilik |
|---|--------|--------|-------------|------|----------|--------|------------|
| H1 | Global cache Map boyut siniri yok -- bellek sizintisi | P6/BUG-004, P7/PERF-002 | `useAsyncData.ts:60` | Modul seviyesi Map, hicbir eviction yok. Uzun sureli oturumlarda onlarca MB birikebilir. | LRU eviction + max-size (100 entry) ekle | S | - |
| H2 | usePagination + useFilters URL sync stale closure | P6/BUG-002, DD-Hook | `usePagination.ts:122-132`, `useFilters.ts:99-119` | Ayri `useSearchParams` instance'lari, stale closure ile URL parametreleri kaybolabilir. AuditLogPage etkileniyor. | `setSearchParams` functional update formu kullan (prev => ...) | S | - |
| H3 | Monolitik bundle -- React.lazy yok | P1, P7/PERF-001, P8/ARCH-007 | `Module.tsx:1-54` | 38 route, 35 sayfa eager import, ~44K satir tek bundle. Tahmini 500-800KB. Initial load 2-4s ek LCP. | React.lazy + Suspense ile code splitting | M | - |
| H4 | N+1 query -- Database Explorer tablo listeleme | P7/PERF-003 | `explorer.controller.ts:311-322` | Her tablo icin 3 ayri `information_schema` sorgusu. 20 tablo = ~60 sorgu. | Toplu query ile tek sorguda cek, JS'te grupla | M | - |
| H5 | Waterfall queries -- InvoiceManagementService.getStats() | P7/PERF-004 | `invoice-management.service.ts:240-332` | 5 bagimsiz DB sorgusu seri calistirilir. Promise.all ile %50-60 iyilestirme. | 5 sorguyu `Promise.all` icine al | S | - |
| H6 | N+1 query -- CustomPlanService.calculateModulePricing() | P7/PERF-005 | `custom-plan.service.ts:463-466` | Her modul icin ayri DB sorgusu. 6 modul = 6 seri sorgu. | Toplu `WHERE code IN (...)` sorgusu | S | - |
| H7 | N+1 INSERT -- SubscriptionCoreService | P7/PERF-006 | `subscription-core.service.ts:472-503` | Her modul icin ayri INSERT. | Bulk INSERT kullan | S | - |
| H8 | ThrottlerGuard kaldirilmis | P5/MEDIUM-001, P2 | `app.module.ts:128-131` | Tum endpoint'ler rate limit korumasindan yoksun. Ele gecirilmis SUPER_ADMIN ile DoS mumkun. | Hassas endpoint'lere per-route `@Throttle()` ekle | M | - |
| H9 | adminApi.ts SRP ihlali -- 3116 satirlik god file | P8/ARCH-001 | `adminApi.ts` | 15 domain API, ~90 tip tanimi, HTTP altyapisi tek dosyada. Merge conflict, bagimsiz test imkansiz. | `http-client.ts` + `types/` + `api/` + barrel export ile dekompoze | M | - |
| H10 | Katman bypass -- 7 sayfa dogrudan fetch() | P8/ARCH-002, P6/BUG-007, P6/BUG-011 | `DatabaseExplorerPage.tsx`, `ReportsPage.tsx`, `AuditTrailPage.tsx`, `ActivityLogPage.tsx`, `CompliancePage.tsx`, `AnnouncementsPage.tsx`, `BillingDashboardPage.tsx` | Retry yok, X-Request-ID yok, envelope unwrap yok, tutarsiz hata yonetimi. Auth token yonetimi dagitilmis. | Tum sayfalari adminApi uzerinden calistir, eksik endpoint'leri adminApi'ye ekle | M | H9 |
| H11 | Frontend test kapsamasi %8.3 -- guvenlik-kritik sayfalar test disinda | P9 | Frontend test dosyalari | ImpersonationPage, DatabaseExplorerPage, SecurityDashboardPage, BillingDashboardPage icin sifir test. AlertRuleBuilder testi (1401 satir) kullanilmayan component icin. | Oncelik sirasi: ImpersonationPage > DatabaseExplorerPage > BillingDashboardPage | L | - |
| H12 | Backend test kapsamasi %16.6 -- BillingController, ImpersonationController, DebugToolsController sifir test | P9 | Backend test dosyalari | ~96 endpoint tamamen test disinda. Client-supplied identity dogrulanmiyor. | BillingController > ImpersonationController > DebugToolsController | L | - |
| H13 | Placeholder guvenlik testleri -- 32x expect(true).toBe(true) | P9, XA-Test | `tenant.security.spec.ts` | 9 guvenlik kategorisinde sahte guvence. CI/CD'de "PASSED" gosterir ama hicbir sey dogrulamiyor. | Gercek assertion'larla degistir veya dosyayi sil | S | - |
| H14 | 18 controller implicit guard -- global guard kaldirilirsa acik kalir | XA-Security, P2 | `app.module.ts:125-127` | DebugToolsController (30+), TenantConfigurationController (30+), IpAccessController (11) dahil 18 controller explicit guard yok. | Tum controller'lara explicit `@UseGuards(PlatformAdminGuard)` ekle | S | - |
| H15 | DebugToolsModule domain karisimi -- ImpersonationModule icinde | P8/ARCH-004, XA-Security | `impersonation.module.ts` | Debug entity/service'ler production'da yukleniyor. NODE_ENV bos = DebugToolsController aktif. | Ayri DebugToolsModule cikar, production'da import etme | S | - |
| H16 | Nested SQL comment bypass | P5/HIGH-003 | `explorer.controller.ts:782-784` | Lazy regex nested comment'leri handle etmez. PostgreSQL `/* /* */ ... */` destekler. Pratik etki dusuk ama edge case'ler mevcut. | `/*` ve `*/` tamamen yasakla veya iteratif parser | M | - |
| H17 | AdminDashboard concurrent fetch -- state corruption | P6/BUG-008, P14/KESISIM-2 | `AdminDashboard.tsx:384-401,431` | 30s interval, onceki fetch bitmeden yeni baslar. AbortController yok. N+1 + waterfall ile kaskad DB yuku: en kotu 200+ DB sorgusu. | AbortController ekle, interval'i fetch sonrasi setTimeout'a cevir | M | H4,H5 |
| H18 | Announcement unpublish kirik kontrat -- 404 | P3/FIELD_MISMATCH-2, P12, P16 | `adminApi.ts:893-894` | `POST /:id/unpublish` -- backend'de yok, `/cancel` var. | Path'i `/cancel` yap | S | - |
| H19 | Settings path kaymasi -- 404 | P3/FIELD_MISMATCH-3 | `adminApi.ts` settingsApi.get/update | Frontend `/settings/${key}`, backend `/settings/key/:key}`. | Path'i `/settings/key/${key}` olarak duzelt | S | - |
| H20 | SystemSettingsPage security/rate-limits PUT -- backend'de yok | P12, P16 | `settings.controller.ts` | Guvenlik ayarlari ve rate limit update islemleri 404/405 donuyor. Admin guvenlik konfigurasyonunu degistiremiyor. | Backend'e PUT endpoint ekle | M | - |
| H21 | ImpersonationPage extendSession/revokeSession path uyumsuzlugu | P12, P16 | `adminApi.ts` impersonationApi | `extend` backend'de yok, `revoke` vs `terminate` path farki. | revoke->terminate fix (FE), extend endpoint ekle (BE) | S-M | - |
| H22 | CSV export -- injection, memory leak, stale filter | P6/BUG-006, P14/KESISIM-5 | `AuditLogPage.tsx:333-349` | CSV escape yok (formula injection), `revokeObjectURL` yok, `filters.search` export'a dahil degil. | CSV escape fonksiyonu, revokeURL, search parametresi ekle | S | - |
| H23 | Bulk IP array boyut siniri yok | P5/MEDIUM-003 | `ip-access.controller.ts:126-148` | Inline type, DTO yok. Sinirsiz array ile 100K IP + N paralel istek = DB lock. | DTO sinifi + `@ArrayMaxSize(500)` + `@IsIP()` | S | - |
| H24 | JSON.parse prototype pollution | P5/MEDIUM-005 | `debug-tools.controller.ts:647` | `JSON.parse(defaultValue)` kontrolsuz. `{"__proto__":{"isAdmin":true}}` riski. | Schema validation veya primitive-only kabul | S | - |
| H25 | pg_sleep DoS + current_setting config leak | P5/LOW-005 | `explorer.controller.ts:814-834` | `dangerousFunctions`'ta yok. `statement_timeout=30s` azaltir ama throttle yok = paralel DoS. | `/\bpg_sleep\b/i` ve `/\bcurrent_setting\b/i` ekle | S | - |
| H26 | Session ownership kontrolu yok | P5/MEDIUM-007 | `impersonation.service.ts:442-466` | `endImpersonation` session sahibini kontrol etmiyor. Admin A, Admin B'nin oturumunu sonlandirebilir. | `session.superAdminId === endedBy` kontrolu ekle | S | - |
| H27 | ErrorTrackingPage tamamen stub | P12 | `ErrorTrackingPage.tsx` | Tum API cagrilari yorumda, bos tablo. Import hatali (systemApi yerine systemSettingsApi olmali). | Import duzelt, yorumlari ac | S | - |
| H28 | 80+ kullanilmayan API fonksiyonu | P12, P16 | `adminApi.ts` | reportsApi (12), databaseApi (23), onboarding (9), tenant config (7) vb. ~45'i mock sayfa entegrasyonuyla aktif olacak. | Mock sayfa entegrasyonlari + temizlik | M | C10 |

### MEDIUM Bulgular (24 adet -- basliklar)

| # | Baslik | Kaynak | Effort |
|---|--------|--------|--------|
| M1 | CQRS tutarsizligi -- yalnizca tenant modulu kullanir | P8/ARCH-003 | S (ADR yaz) |
| M2 | Data fetch pattern tutarsizligi -- 4 farkli yaklasim | P8/ARCH-006 | M |
| M3 | Sayfa monolitizmi -- 20 sayfa 600+ satir, inline component | P8/ARCH-005 | L |
| M4 | usePagination setTotal page out-of-bounds | P6/BUG-005 | S |
| M5 | ReportsPage kendi apiFetch'i -- retry ve error handling bypass | P6/BUG-007 | M |
| M6 | BillingDashboardPage hardcoded metrikler (churnRate: 2.3 vb.) | P6/BUG-010 | M |
| M7 | BillingDashboardPage dogrudan fetch -- sessiz hata yutma | P6/BUG-011 | S |
| M8 | useFilters clearFilters boolean/number yanlis bos deger | P6/BUG-012 | S |
| M9 | Cache invalidation eksik -- mutation sonrasi stale data | P7/PERF-008 | S |
| M10 | Database Explorer 10K satir client-side export | P7/PERF-009 | M |
| M11 | @tanstack/react-query yuklu ama kullanilmiyor | P4/DEP-01, P7/PERF-007 | S |
| M12 | zustand MF shared phantom dependency | P4/DEP-02 | S |
| M13 | @aquaculture/shared-ui MF shared config uyumsuzlugu | P4/DEP-03 | S |
| M14 | MF expose -- 3/4 endpoint kullanilmiyor | P4/DEP-04 | S |
| M15 | tailwind.config.js ESM + CJS karisimi | P4/DEP-05 | S |
| M16 | credentials:'include' + CSRF riski | P5/MEDIUM-006 | M |
| M17 | Export endpoint max 10K row -- DB yuku | P5/MEDIUM-002 | S |
| M18 | i18n tutarsizligi -- Turkce/Ingilizce karisimi 4+ sayfada | P10 | M |
| M19 | Sidebar ARIA eksiklikleri (nav landmark, aria-expanded) | P10/B01-B03 | S |
| M20 | Mobile sidebar focus trap yok | P10/B05 | M |
| M21 | Header butonlari aria-label eksik | P10/B06-B08 | S |
| M22 | Loading state tutarsiz pattern | P10/B15 | M |
| M23 | Wizard step validasyon geri bildirimi yetersiz | P10/B14 | M |
| M24 | ~33 ORPHAN_FE -- frontend cagiriyor, backend endpoint yok | P3 | L |

### LOW Bulgular (18 adet -- sadece sayim)

Dead code ~8176 satir, legacy placeholder dosyalar (4 adet), TODO notlari (12 adet), getAuthHeader 7 kopya, naming tutarsizliklari, console.log kalintisi, eslint-disable (10), noUnusedLocals/Parameters kapal, AdminDashboard sub-component memo eksik, useAsyncData callback dep stabilizasyon, AuditLogPage stale stats cacheKey, in-memory session restart tutarsizligi, localStorage query history, QueryEditor Tab key override, DataGrid table caption eksik, error state retry butonu yok, InviteUserModal responsive grid, Tailwind dinamik class JIT sorunu.

---

## Kok Neden Analizi

### Tema 1: "Hizli Prototipleme Kalintilari"
Mock sayfalar (3 adet), TODO notlari (12 adet), placeholder testler (32 adet), inline type'lar (IP access DTO yok), hardcoded metrikler (BillingDashboard), stub sayfalar (ErrorTracking) -- tumu hizli prototipleme surecinin uretim koduna tasinmis kalintilaridir. Backend endpoint'leri hazir olmasina ragmen frontend entegrasyonu tamamlanmamis.

### Tema 2: "Guvenlik Bilinci Gecikmesi"
`ImpersonationController` SECURITY FIX comment'leriyle duzeltilmis (4 endpoint), ancak ayni modul icindeki `DebugToolsController`'a uygulanmamis. `BillingController` (11 endpoint), `SettingsController` (5 endpoint), `TenantConfigurationController` (8 endpoint) tamamen duzeltme disinda kalmis. Bu, guvenlik duzeltmelerinin sistematik degil noktasal yapildigini gosteriyor.

### Tema 3: "Merkezi Tasarim Eksikligi"
`adminApi.ts` 3116 satirlik god file. 4 farkli data fetch pattern (adminApi, useAsyncData, mixed, direct fetch). `getAuthHeader` 7 dosyada kopyalanmis. `apiFetch` wrapper 2 dosyada ayri tanimlanmis. Ortak CSV utility yok. Ortak loading state component'i yok. Bu daginiklin kok nedeni: mimari standartlarin resmilesmemis (ADR yok) ve enforced edilmemis (lint kurali yok) olmasi.

### Tema 4: "NODE_ENV'e Asiri Guven"
11 guvenlik karari `NODE_ENV` kontrolune bagli. NODE_ENV bos/staging/yanlis = raw SQL acik, DebugTools aktif, JWT dev secret, CORS gevsetilmis, DB password gerekmez. Fail-open yaklasim yerine fail-closed olmaliydi.

### Tema 5: "Test Piramidi Ters"
Frontend %8.3, backend %16.6 kapsam. E2E testleri `describe.skip`. 32 placeholder test sahte guvence. Guvenlik-kritik 3 modul (Billing, Impersonation, DebugTools) = ~96 endpoint, sifir test. Kontrat testleri sifir -- 3 FIELD_MISMATCH production'da 400/404 uretiyor ama CI/CD yakalayamiyor.

---

## Aksiyon Plani

### Sprint 1: Acil -- Guvenlik ve Crash Fix'leri (Bu hafta, ~3-5 gun)

| # | Is | Tur | Effort | Bulgu |
|---|---|-----|--------|-------|
| 1 | Semicolon yasagi ekle (explorer.controller.ts) | BE fix | S | C1 |
| 2 | `SET`, `DO`, `PERFORM`, `set_config`, `pg_sleep`, `current_setting` blokla | BE fix | S | C2,C3,H25 |
| 3 | `pg_catalog`, `information_schema` blokla | BE fix | S | C11 |
| 4 | CRUD endpoint'lerine feature flag kontrolu ekle | BE fix | S | C5 |
| 5 | Raw SQL endpoint'ini feature flag ile kontrol et (NODE_ENV'e ek) | BE fix | S | C4 |
| 6 | `includeSensitive` parametresini kaldir/yetkilendir | BE fix | S | C12 |
| 7 | DebugToolsController `@Query('adminId')` -> `req.user.id` | BE fix | S | C6 (Faz 1) |
| 8 | BillingController 11 client-supplied identity -> JWT | BE fix | M | C6 (Faz 2) |
| 9 | ImpersonationPage cache crash fix | FE fix | S | C9 |
| 10 | useAsyncData callback ref fix (BUG-014) | FE fix | S | C8 |
| 11 | useAsyncData refetch mekanizmasi (BUG-001) | FE fix | S | C7 (C8'e bagimli) |
| 12 | Cache Map LRU eviction + max-size | FE fix | S | H1 |
| 13 | Placeholder testleri temizle/sil | Test | S | H13 |
| 14 | Explorer bypass testleri yaz (SET, set_config, DO, pg_catalog) | Test | S | H11,H12 |

### Sprint 2: Bu ay -- Mimari ve Performans (2-3 hafta)

| # | Is | Tur | Effort | Bulgu |
|---|---|-----|--------|-------|
| 15 | Settings/TenantConfig/IpAccess/Compliance identity -> JWT | BE fix | M | C6 (Faz 3-5) |
| 16 | 18 implicit controller'a explicit guard ekle | BE fix | S | H14 |
| 17 | DebugToolsModule ayri module cikar | BE refactor | S | H15 |
| 18 | Hassas endpoint'lere per-route throttle ekle | BE fix | M | H8 |
| 19 | QueryEditor `query` -> `sql` fix (C1-C5 fix'leri ile birlikte) | FE fix | S | C13 |
| 20 | Announcement unpublish -> cancel path fix | FE fix | S | H18 |
| 21 | Settings path fix (`/settings/key/${key}`) | FE fix | S | H19 |
| 22 | ImpersonationPage revoke -> terminate fix | FE fix | S | H21 |
| 23 | Module.tsx React.lazy + Suspense | FE refactor | M | H3 |
| 24 | AdminDashboard AbortController + interval guard | FE fix | M | H17 |
| 25 | CSV export fix (escape + revokeURL + search filter) | FE fix | S | H22 |
| 26 | adminApi.ts dekompoze (http-client + domain API'ler) | FE refactor | M | H9 |
| 27 | InvoiceManagement.getStats() Promise.all | BE fix | S | H5 |
| 28 | CustomPlan/Subscription N+1 bulk query | BE fix | S | H6,H7 |
| 29 | Database Explorer N+1 toplu query | BE refactor | M | H4 |
| 30 | Bulk IP DTO validation + array limit | BE fix | S | H23 |
| 31 | usePagination + useFilters URL sync fix | FE fix | S | H2 |
| 32 | usePagination setTotal page clamp | FE fix | S | M4 |
| 33 | @tanstack/react-query + zustand temizligi | FE fix | S | M11,M12 |

### Sprint 3: Sonraki ay -- Feature Gap ve Teknik Borc (2-4 hafta)

| # | Is | Tur | Effort | Bulgu |
|---|---|-----|--------|-------|
| 34 | OnboardingPage mock -> API gecisi | FE refactor | S | C10 |
| 35 | ErrorTrackingPage import duzelt + yorumlari ac | FE fix | S | H27 |
| 36 | TenantConfigurationPage mock -> API | FE refactor | M | C10 |
| 37 | DatabaseManagementPage kismi entegrasyon | FE+BE | M | C10 |
| 38 | ReportsPage -> adminApi.reportsApi gecisi | FE refactor | M | M5 |
| 39 | Dogrudan fetch kullanan 7 sayfayi adminApi'ye tasi | FE refactor | M | H10 |
| 40 | SystemSettingsPage security/rate-limits PUT backend ekle | BE ekle | M | H20 |
| 41 | ImpersonationPage extend endpoint backend ekle | BE ekle | M | H21 |
| 42 | Dead code temizligi (~8176 satir) | FE temizlik | M | LOW |
| 43 | i18n standardizasyonu (react-i18next veya tek dil) | FE refactor | L | M18 |
| 44 | Sidebar ARIA + focus trap + header a11y | FE fix | S | M19-M21 |
| 45 | Impersonation/Billing/DebugTools controller testleri | Test | L | H11,H12 |
| 46 | Frontend-backend kontrat testi altyapisi | Test | M | H12 |
| 47 | ADR'ler: CQRS, guard stratejisi, stil tercihi | Dok | S | M1 |

---

## Quick Wins

S effort + HIGH/CRITICAL impact -- hemen yapilabilecek, yuksek deger ureten isler:

| # | Is | Effort | Impact | Dosya | Tahmini Sure |
|---|---|--------|--------|-------|-------------|
| 1 | Semicolon yasagi ekle | S | CRITICAL | `explorer.controller.ts:~791` | 10 dk |
| 2 | `SET`, `set_config`, `pg_sleep`, `current_setting` blokla | S | CRITICAL | `explorer.controller.ts:793-828` | 15 dk |
| 3 | `pg_catalog`, `information_schema` blokla | S | CRITICAL | `explorer.controller.ts:837` | 5 dk |
| 4 | CRUD feature flag ekle | S | CRITICAL | `explorer.controller.ts:542,589,647` | 30 dk |
| 5 | `includeSensitive` kaldir | S | CRITICAL | `explorer.controller.ts:145` | 15 dk |
| 6 | ImpersonationPage cache crash fix | S | CRITICAL | `ImpersonationPage.tsx:119-125` | 10 dk |
| 7 | useAsyncData callback ref + refetch fix | S | CRITICAL | `useAsyncData.ts:95-277` | 1 saat |
| 8 | Cache Map LRU siniri | S | HIGH | `useAsyncData.ts:60` | 30 dk |
| 9 | DebugToolsController adminId -> req.user.id | S | HIGH | `debug-tools.controller.ts:393,606,618` | 30 dk |
| 10 | Placeholder testleri sil/duzelt | S | HIGH | `tenant.security.spec.ts` | 1 saat |
| 11 | Announcement unpublish -> cancel | S | HIGH | `adminApi.ts:893-894` | 5 dk |
| 12 | Settings path fix | S | HIGH | `adminApi.ts` settingsApi | 5 dk |
| 13 | Impersonation revoke -> terminate | S | HIGH | `adminApi.ts` impersonationApi | 5 dk |
| 14 | CSV export fix | S | HIGH | `AuditLogPage.tsx:333-349` | 30 dk |
| 15 | Bulk IP DTO + array limit | S | HIGH | `ip-access.controller.ts:126-148` | 30 dk |
| 16 | 18 controller'a explicit guard | S | HIGH | 18 controller dosyasi | 1 saat |
| 17 | InvoiceManagement Promise.all | S | HIGH | `invoice-management.service.ts:240` | 30 dk |
| 18 | ErrorTrackingPage stub -> aktif | S | HIGH | `ErrorTrackingPage.tsx` | 30 dk |
| 19 | usePagination setTotal page clamp | S | MEDIUM | `usePagination.ts:173-175` | 10 dk |
| 20 | react-query + zustand temizligi | S | MEDIUM | `package.json`, `vite.config.ts` | 15 dk |

---

## Bagimlilik Grafi

```
C8 (callback ref)
  |
  v
C7 (useAsyncData refetch) ---> H1 (LRU cache) icin birlikte planla
  |
  v
C10 (mock sayfalar) -- ErrorTrackingPage icin C7 gerekli (useAsyncData calismali)

C1 (semicolon yasagi)
  |
  +---> C3 (DO bypass kapatilir)
  |
  v
C13 (QueryEditor query->sql fix) -- C1,C2,C3,C4 fix'leri ONCESINDE veya BIRLIKTE yapilmali
                                     Yoksa raw SQL endpoint frontend'den erisilebilir hale gelir
                                     ama guvenlik korumasi eksik kalir

C4 (NODE_ENV fail-closed) + C5 (CRUD feature flag) -- birbirinden bagimsiz, paralel yapilabilir

C6 (identity fix Faz 1-5) -- Fazlar sirali: DebugTools > Billing > Settings > TenantConfig > IP/Compliance

H9 (adminApi dekompoze)
  |
  v
H10 (katman bypass giderme) -- once adminApi parcalanmali, sonra sayfalar gecmeli

H3 (React.lazy)
  |
  v
H2 (URL sync) -- React.lazy sayfa gecislerinde unmount/remount zorunlu kilar, URL collision azalir
                  Ama tam fix icin setSearchParams functional update (H2) da gerekli

H4 (N+1 explorer) + H5 (waterfall invoice)
  |
  v
H17 (AdminDashboard concurrent fetch) -- backend optimizasyonu ONCESINDE yapilabilir
                                          ama birlikte yapilirsa kaskad yuk riski tamamen kalkar

H14 (explicit guard) -- H15 (DebugToolsModule ayristirma) ile birlikte veya bagimsiz yapilabilir

H18, H19, H21 (kontrat fix'leri) -- birbirinden bagimsiz, paralel yapilabilir
```

### Kritik Bagimlilik Uyarisi

**C13 (QueryEditor fix) kesinlikle C1-C5 ile birlikte yapilmalidir.** Mevcut durumda FIELD_MISMATCH kazara bir guvenlik katmani olusturmaktadir -- raw SQL endpoint frontend'den kullanilamaz. Bu fix yapilip SQL motoru calisir hale geldiginde, tum SQL bypass vektorleri de acilmis olur. Bu nedenle:

1. Once C1 (semicolon yasagi) + C2 (SET/set_config) + C3 (DO/PERFORM) + C4 (feature flag) + C5 (CRUD kontrolu) + C11 (pg_catalog) + C12 (includeSensitive) + H25 (pg_sleep/current_setting) fix'lerini uygula
2. Ardindan C13 (QueryEditor query->sql) fix'ini uygula
3. Bu iki adim ayni PR'da olabilir ama sira kritik

---

## Ek: Rapor Kaynak Haritasi

| Wave | Rapor | Ajan | Kapsam |
|------|-------|------|--------|
| Wave 1 | 01-frontend-map | P1 | Frontend dosya envanteri, route haritasi, fetch pattern'leri |
| Wave 1 | 02-backend-map | P2 | Backend controller/service/entity haritasi, guard analizi |
| Wave 1 | 03-contract-map | P3 | Frontend-backend API uyumsuzluklari |
| Wave 1 | 04-dependency-map | P4 | Dependency, MF, build konfigurasyonu |
| Wave 2a | 05-security | P5 | Guvenlik denetimi (3 CRITICAL, 5 HIGH) |
| Wave 2a | 06-bugs | P6 | Bug tespiti (3 CRITICAL, 4 HIGH) |
| Wave 2a | 07-performance | P7 | Performans analizi (1 CRITICAL, 4 HIGH) |
| Wave 2a | 08-architecture | P8 | Mimari elestiri (9 bulgu) |
| Wave 2b | 09-testing | P9 | Test kapsam denetimi |
| Wave 2b | 10-ux-a11y | P10 | UX ve erisilebilirlik (22 bulgu) |
| Wave 2b | 11-tech-debt | P11 | Teknik borc envanteri (48 kalem) |
| Wave 2b | 12-feature-completeness | P12 | Feature tamamlanmislik analizi |
| Deep-dive | dd-sql-security | DD-SQL | SQL bypass vektor dogrulamasi |
| Deep-dive | dd-identity-spoofing | DD-Identity | Identity spoofing tam envanter |
| Deep-dive | dd-hook-bugs | DD-Hook | Hook bug'lari satir-satir dogrulama |
| Wave 3 | 13-security-x-arch | XA-Security | Guvenlik x Mimari capraz analiz |
| Wave 3 | 14-bug-x-perf | XA-BugPerf | Bug x Performans capraz analiz |
| Wave 3 | 15-test-x-security | XA-Test | Test x Guvenlik capraz analiz |
| Wave 3 | 16-completeness-x-contract | XA-Feature | Feature x Kontrat capraz analiz |
