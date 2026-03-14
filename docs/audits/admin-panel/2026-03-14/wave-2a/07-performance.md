# P7: Performans Analisti Raporu

Tarih: 2026-03-14
Kapsam: Admin Panel (frontend + backend)
Ajan: Performans Analisti (P7)

---

## Yonetici Ozeti

Admin panel performans analizi 10 kontrol noktasinda yapildi. **1 kritik, 4 yuksek, 5 orta** severity bulgu tespit edildi. En buyuk darbogazlar: (1) 38 sayfa route'unun tamaminin eager import edilmesi (~44K satir tek bundle), (2) useAsyncData global cache Map'inin buyukluk siniri olmamasi (bellek sizintisi), (3) Database Explorer controller'inda tablo listeleme icinde N+1 sorgu, (4) InvoiceManagementService.getStats() icinde 5 ardisik (waterfall) DB sorgusu, (5) Module Federation shared config'inde React Query paylasiliyor ama hicbir sayfa kullanmiyor.

---

## Bulgular

### PERF-001 [KRITIK] Monolitik Bundle - React.lazy Kullanilmiyor
- **Dosya:** `web/modules/admin-panel/src/Module.tsx:1-54`
- **Kanit:** 38 route icin 35 sayfa component'i satirlar 11-53'te static import ediliyor. `React.lazy()` veya dinamik `import()` kullanan hicbir satir yok. Toplam ~44.293 satir kod tek bundle'a dahil.
- **Etki:** Admin panel acildiginda tum sayfa kodu indirilir. Bundle boyutu tahmini ~500-800KB (minified). Ilk yukleme suresi LCP'yi 2-4 saniye artirabilir. Bu panel sadece SUPER_ADMIN icin oldugu halde tum kod monolitik.
- **Fix:** Her route icin `React.lazy(() => import('./pages/XPage'))` + `<Suspense fallback={<Spinner />}>` kullanilmali. Ornek:
  ```tsx
  const AdminDashboard = React.lazy(() => import('./pages/AdminDashboard'));
  ```
  38 route icin bunu uygulamak initial bundle'i %60-70 kucultebilir.
- **Effort:** M (yaklasik 2-3 saat, mekanik degisiklik)

---

### PERF-002 [YUKSEK] Global Cache Map - Buyukluk Siniri Yok (Bellek Sizintisi)
- **Dosya:** `web/modules/admin-panel/src/hooks/useAsyncData.ts:60`
- **Kanit:** Satir 60: `const cache = new Map<string, { data: unknown; timestamp: number }>();` -- modul seviyesinde global Map. Cache'e yeni key eklenir ama TTL dolmus entry'ler sadece `cache.get()` sirasinda kontrol edilir (satir 118-119). Kullanilmayan key'ler hicbir zaman temizlenmez. `cache.clear()` sadece logout event'inde cagrilir (satir 64).
- **Etki:** Uzun sureli admin session'larinda (saatlerce acik kalan panel) farkli cacheKey'lerle yapilan cagrilar birikir. Her cacheKey icin tam API yaniti bellekte tutulur. Large dataset (ornegin database explorer, audit log) cache'lenirse onlarca MB birikebilir.
- **Fix:** (1) Cache Map'e maksimum boyut siniri ekle (LRU: en eski entry'yi sil). (2) Periyodik bir temizlik (setInterval ile TTL-expired entry'leri sil). (3) Cache size icin hard limit (ornegin 100 entry veya 10MB).
- **Effort:** S (1-2 saat)

---

### PERF-003 [YUKSEK] N+1 Query - Database Explorer Tablo Listeleme
- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:311-322`
- **Kanit:** `getTables()` metodu satirlar 311-322:
  ```typescript
  for (const table of filteredTables) {
    const columns = await this.getColumnInfo(queryRunner, schema, table.table_name);
    result.push({ ... });
  }
  ```
  Her tablo icin ayri bir `information_schema.columns` sorgusu yapiliyor. `public` semasinda 20+ tablo varsa 20+ ardisik sorgu calisir.
- **Etki:** Schema'da N tablo varsa N+1 sorgu. Her `getColumnInfo` cagrisi 3 subquery iceriyor (columns + primary key + foreign key). 20 tablo icin ~60 sorgu. Yaklasik 200-500ms ek latency.
- **Fix:** Tum tablolarin sutun bilgilerini tek bir sorguda cekmek. `information_schema.columns` sorgusunu `WHERE table_schema = $1` ile toplu calistir, sonra JS'te tablo bazinda grupla.
- **Effort:** M (2-3 saat, SQL refactoring)

---

### PERF-004 [YUKSEK] Waterfall Queries - InvoiceManagementService.getStats()
- **Dosya:** `apps/admin-api-service/src/billing/services/invoice-management.service.ts:240-332`
- **Kanit:** `getStats()` metodu 5 ardisik `await this.dataSource.query()` cagrisi yapiyor (satirlar 242, 255, 282, 296, 309). Bu sorgular birbirinden bagimsiz oldugu halde seri olarak calistirilir.
- **Etki:** Her sorgu ~20-50ms surse toplam ~100-250ms. `Promise.all()` ile paralel calistirilsa ~50ms'e duser. Dashboard yukleme suresinde %50-60 iyilestirme.
- **Fix:** 5 sorguyu `Promise.all([...])` icine al. Ornek:
  ```typescript
  const [totalResult, statusResult, currencyResult, paymentTimeResult, thisMonthResult] =
    await Promise.all([...]);
  ```
- **Effort:** S (30 dakika)

---

### PERF-005 [YUKSEK] N+1 Query - CustomPlanService.calculateModulePricing()
- **Dosya:** `apps/admin-api-service/src/billing/services/custom-plan.service.ts:463-466`
- **Kanit:** Satir 463-466:
  ```typescript
  for (const input of moduleInputs) {
    const pricing = await this.modulePricingService.getModulePricingByCode(input.moduleCode);
  ```
  Her modul icin ayri bir DB sorgusu. Tipik bir custom plan 4-6 modul icerdiginde 4-6 seri sorgu.
- **Etki:** Her modul icin 1 DB round-trip. 6 modul = 6 seri sorgu. Yaklasik 60-120ms ek latency.
- **Fix:** `getModulePricingByCode` yerine toplu `getModulePricingByCodes(codes: string[])` metodu ekle, tek `WHERE code IN (...)` sorgusu calistir.
- **Effort:** S (1 saat)

---

### PERF-006 [YUKSEK] N+1 Query - SubscriptionCoreService.createSubscription()
- **Dosya:** `apps/admin-api-service/src/billing/services/subscription-core.service.ts:472-503`
- **Kanit:** Satir 472:
  ```typescript
  for (const moduleConfig of modules) {
    const itemResult = await manager.query(`INSERT INTO billing.subscription_module_items ...`);
  ```
  Her modul icin ayri INSERT sorgusu, transaction icinde seri calisir.
- **Etki:** 6 modul icin 6 ardisik INSERT. Yaklasik 30-60ms ek latency. Yuksek hacimli subscription olusturma senaryolarinda onemli.
- **Fix:** Tek bir `INSERT ... VALUES ($1), ($2), ... RETURNING id` kullan veya `unnest()` ile bulk insert.
- **Effort:** S (1 saat)

---

### PERF-007 [ORTA] Module Federation - Kullanilmayan Shared Dependency
- **Dosya:** `web/modules/admin-panel/vite.config.ts:23`
- **Kanit:** Satir 23: `'@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' }` -- React Query singleton olarak paylasilmakta. Ancak admin panel kod tabaninda (68 dosya, ~44K satir) `useQuery`, `useMutation`, `QueryClient` veya `@tanstack/react-query` import'u **yok**. Tum data fetching `useAsyncData` hook'u veya dogrudan `fetch()` ile yapiliyor.
- **Etki:** React Query runtime'i (~40-50KB minified) admin panel bundle'ina dahil ediliyor ama hicbir yerde kullanilmiyor. Module Federation shared singleton'lari her zaman yuklendiginden bu gereksiz bellek ve network maliyeti olusturur.
- **Fix:** `@tanstack/react-query` satirini `shared` config'inden cikar. Eger gelecekte kullanilacaksa `eager: false` ile isaretlenebilir.
- **Effort:** XS (5 dakika)

---

### PERF-008 [ORTA] useAsyncData - Mutation Sonrasi Cache Invalidation Eksik
- **Dosya:** `web/modules/admin-panel/src/hooks/useAsyncData.ts:166` + tuketici sayfalar
- **Kanit:** `useAsyncData` cache'e veriyi `cache.set(cacheKey, ...)` ile yazar (satir 166). Ancak mutation islemleri (ornegin tenant olusturma, kullanici guncelleme) sonrasi ilgili cacheKey'ler invalidate edilmiyor. `clearAsyncCache()` fonksiyonu mevcut (satir 307-313) ama hicbir sayfa mutation sonrasi cagirmiyor. Sayfalar genellikle `silentRefresh()` veya `refresh()` kullanarak yeniden fetch yapiyor ama baska sayfalardaki cache stale kaliyor.
- **Etki:** Admin Dashboard'da tenant sayisi gorulur, yeni tenant olusturulur, dashboard'a geri donulurse eski (stale) veri cache'den gosterilir (30 saniye TTL surene kadar). Veri tutarsizligi.
- **Fix:** (1) Mutation helper'i ekle: mutation basarili oldugunda ilgili cacheKey'leri temizleyen bir `invalidateCache(keys)` fonksiyonu. (2) veya `clearAsyncCache()` cagrisini mutation sonrasi yerlestir.
- **Effort:** S (1-2 saat)

---

### PERF-009 [ORTA] Database Explorer - Large Result Set Client-Side Isleme
- **Dosya:** `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx:90-114`
- **Kanit:** Tablo verisi `fetchTableData()` ile cekilir ve `setTableData(data)` ile state'e yazilir. Limit 50 satir olsa da export fonksiyonu (satir 183-215) 10.000 satira kadar izin veriyor ve tum veriyi `blob` olarak client-side indiriyor. Tablo gosterim tarafinda pagination dogru uygulanmis (limit=50, server-side).
- **Etki:** Export sirasinda 10K satirlik veri client belleginde tutulur. Buyuk tablolarda (ornegin audit_logs) bu 50-100MB olabilir. Tarayici tab'i donabilir.
- **Fix:** Export islemini backend'de streaming olarak yap (server-side CSV/JSON stream). Frontend'de sadece download linki goster. Mevcut export limiti 10K'da sabitlenmis ama bunu admin'e uyari ile gostermek ve streaming'e gecmek gerekir.
- **Effort:** M (3-4 saat, backend streaming + frontend entegrasyon)

---

### PERF-010 [ORTA] AdminDashboard - Sub-component Memoization Eksikligi
- **Dosya:** `web/modules/admin-panel/src/pages/AdminDashboard.tsx:62-111, 117-146, 153-216`
- **Kanit:** `ServiceStatusCard`, `DatabaseStatsCard`, `RecentActivityCard`, `CircuitBreakerCard`, `CacheStatsCard` component'leri dosya ici tanimlanmis ama `React.memo` ile sarilmamis. Dashboard state degistiginde (ornegin sadece `resettingBreaker` degistiginde) tum sub-component'ler yeniden renderlanir.
- **Etki:** Dashboard 5-6 farkli veri kaynagindan beslenir. Her state degisikligi tum card'larin re-render'ini tetikler. Tipik olarak ~100-200 DOM element yeniden olusturulur. Kullanici deneyiminde gozle gorulebilir bir etki olmayabilir ama performans butcesini gereksiz harcar.
- **Fix:** `React.memo()` ile sub-component'leri sar. `fetchDashboardData` callback'i zaten `useCallback` ile sarilmis (iyi). Sub-component'lerin prop'lari basit oldugu icin `React.memo` yeterli olacaktir.
- **Effort:** XS (15-20 dakika)

---

### PERF-011 [ORTA] useAsyncData - fetchData Dependency Array'de transform ve Callback'ler
- **Dosya:** `web/modules/admin-panel/src/hooks/useAsyncData.ts:226`
- **Kanit:** Satir 226: `[cacheKey, cacheTTL, timeout, transform, onSuccess, onError]` -- `fetchData` callback'inin dependency array'inde `transform`, `onSuccess`, `onError` fonksiyonlari var. Bu fonksiyonlar tuketici component'lerde inline tanimlanirsa her renderda yeni referans olusur ve `fetchData` yeniden olusturulur, bu da `useEffect` (satir 273) tetiklenmese bile `fetch/refresh/retry` callback'lerinin yeniden olusmasina yol acar.
- **Etki:** `fetcher` icin ayni pattern (ref kullanarak stabilize etme - satir 97) uygulanmis ama `transform/onSuccess/onError` icin uygulanmamis. Tuketici `useCallback` ile sarmazsa gereksiz re-render zincirine yol acabilir. Mevcut 6 tuketici sayfa icin gercek etkisi dusuk (cogu inline callback kullanmiyor).
- **Fix:** `transform`, `onSuccess`, `onError` icin de ref pattern uygula (fetcher ile ayni sekilde).
- **Effort:** XS (15 dakika)

---

## Ozet Tablosu

| # | Severity | Kategori | Dosya | Effort | Aciklama |
|---|----------|----------|-------|--------|----------|
| PERF-001 | KRITIK | Bundle | Module.tsx | M | 38 route eager import, lazy loading yok |
| PERF-002 | YUKSEK | Memory | useAsyncData.ts:60 | S | Global cache Map sinir yok |
| PERF-003 | YUKSEK | N+1 | explorer.controller.ts:311 | M | Tablo listeleme loop icinde column sorgusu |
| PERF-004 | YUKSEK | Waterfall | invoice-management.service.ts:240 | S | 5 ardisik sorgu, Promise.all yok |
| PERF-005 | YUKSEK | N+1 | custom-plan.service.ts:463 | S | Modul fiyat loop icinde sorgu |
| PERF-006 | YUKSEK | N+1 | subscription-core.service.ts:472 | S | Loop icinde INSERT |
| PERF-007 | ORTA | Bundle | vite.config.ts:23 | XS | React Query yuklu ama kullanilmiyor |
| PERF-008 | ORTA | Cache | useAsyncData.ts:166 | S | Mutation sonrasi invalidation yok |
| PERF-009 | ORTA | Memory | DatabaseExplorerPage.tsx:183 | M | 10K satir client-side export |
| PERF-010 | ORTA | Render | AdminDashboard.tsx:62 | XS | Sub-component memo eksik |
| PERF-011 | ORTA | Render | useAsyncData.ts:226 | XS | Callback dep array stabilizasyon |

---

## Spawn Talepleri

| Spawn | Hedef Bulgu | Islem |
|-------|------------|-------|
| S-PERF-001 | PERF-001 | Module.tsx'te 38 route icin React.lazy + Suspense uygulamasi |
| S-PERF-002 | PERF-002 | useAsyncData cache Map'ine LRU siniri + TTL sweep eklenmesi |
| S-PERF-003 | PERF-003 | DatabaseExplorerController.getTables() N+1 sorgu optimizasyonu |
| S-PERF-004 | PERF-004 | InvoiceManagementService.getStats() Promise.all donusumu |
| S-PERF-005 | PERF-005 + PERF-006 | Billing service bulk query/insert refactoring |
| S-PERF-006 | PERF-007 | vite.config.ts'den @tanstack/react-query cikarilmasi |

---

## Oneriler

1. **Oncelik Sirasi:** PERF-001 (bundle) > PERF-004 (waterfall, 30dk fix) > PERF-003 (N+1) > PERF-002 (memory) > PERF-005/006 (N+1 billing).
2. **Olcum:** Bundle boyutu icin `npx vite-bundle-visualizer` calistirilmali. Mevcut monolitik bundle boyutu bilinmiyor -- lazy loading oncesi/sonrasi karsilastirma icin baseline olusturulmali.
3. **Backend Cache:** AnalyticsService.getDashboardSummary() Redis cache'i iyi uygulanmis (5dk TTL). Ayni pattern InvoiceManagementService.getStats() ve ModulesService.getModuleStats() icin de uygulanabilir.
4. **React Query Karari:** Admin panel ya React Query'ye gecmeli (tum sayfalar icin) ya da shared config'den cikarilmali. Mevcut durum (yuklu ama kullanilmiyor) hem bundle hem bellek israf ediyor.
5. **Database Index Kontrolu:** `auth.users` tablosunda `"tenantId"`, `"isActive"`, `"lastLoginAt"`, `"createdAt"` sutunlarina index olmasi gerekir. `billing.invoices` tablosunda `status`, `"issueDate"`, `"tenantId"` icin de index kontrol edilmeli. Bu analiz DBA tarafindan `pg_stat_user_indexes` ile dogrulanmali.
