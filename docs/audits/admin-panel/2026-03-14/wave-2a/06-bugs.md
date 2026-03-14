# P6: Bug Avcisi Raporu

Tarih: 2026-03-14
Kapsam: `web/modules/admin-panel/src/` hooks, services, sayfalar
Ajan: Bug Avcisi (P6)

---

## Yonetici Ozeti

Admin panel frontend'inde 14 bug tespit edildi: 3 kritik, 4 yuksek, 5 orta, 2 dusuk. En ciddi sorunlar: (1) `useAsyncData` hook'u filtre/pagination degisikliginde veriyi yeniden cekmiyor -- AuditLogPage ve diger tuketiciler ilk yuklemeden sonra stale data gosteriyor; (2) `usePagination` ve `useFilters` ayni sayfada URL sync kullandiginda birbirlerinin parametrelerini siliyor; (3) ImpersonationPage tenant cache'i ikinci yuklemede crash veriyor; (4) global cache Map'te boyut siniri ve eviction yok, her unique cacheKey sonsuza dek kalir.

---

## Bulgular

### BUG-001: useAsyncData filtre/pagination degisikliginde yeniden fetch yapmiyor [KRITIK]

- **Dosya:** `hooks/useAsyncData.ts:273-277`
- **Kanit:** Initial fetch `useEffect` bos dependency array kullaniyor (`[]`). `fetchData` callback'i `cacheKey` degistiginde yeniden olusturuluyor ama hicbir `useEffect` bu degisikligi dinleyip `fetchData`'yi cagirmiyor.
- **Etki:** `AuditLogPage`, `SystemSettingsPage`, `ModulesPage`, `BillingDashboardPage`, `ProvisioningSettingsPage` ve `ReportsPage` -- tum `useAsyncData` tuketicileri -- filtreler veya sayfa degistiginde veriyi otomatik olarak yeniden CEKMIYOR. Kullanici manueel "Refresh" tiklamak zorunda. AuditLogPage'de `cacheKey` her filtre/sayfa kombinasyonu icin unique oldugu icin cache hit olmaz, ama yeni fetch de tetiklenmez. Sayfa ilk yuklemeden sonra donuk kalir.
- **Fix:** `useAsyncData`'ya `deps` parametresi ekle veya `cacheKey` degistiginde otomatik refetch yapan bir `useEffect` ekle:
  ```ts
  useEffect(() => {
    if (immediate) fetchData(true);
  }, [fetchData]); // fetchData cacheKey'e bagli, cacheKey degisince refetch
  ```
- **Effort:** Dusuk (5-10 satir). Ama tum tuketicilerin davranisini etkiler -- regression testi gerekli.

---

### BUG-002: usePagination + useFilters URL sync race condition [KRITIK]

- **Dosya:** `hooks/usePagination.ts:122-132` ve `hooks/useFilters.ts:99-119`
- **Kanit:** Her iki hook da `useSearchParams()` kullanir ve `setSearchParams` ile URL'yi gunceller. Her biri `new URLSearchParams(searchParams)` ile AYNI snapshot'tan baslar. Ayni render cycle'da ikisi de calisirsa, sonraki cagri oncekinin parametrelerini siler.
- **Senaryo:** AuditLogPage'de kullanici "Action" filtresini degistirdiginde:
  1. `useFilters.setFilter('action', 'CREATE')` -> `updateUrl` -> `setSearchParams({action:'CREATE', ...mevcut})` cagirir.
  2. Ayni cycle'da `useEffect([debouncedFilters])` -> `pagination.goToPage(1)` -> `updateUrl` -> `setSearchParams({page:'1', limit:'20', ...mevcut})` cagirir.
  3. Ikinci cagri `action` parametresini SILMIS olur cunku eski `searchParams` snapshot'indan baslamistir.
- **Etki:** URL state ile gercek state uyumsuz hale gelir. Browser back/forward durumlarinda yanlis veri gosterilir.
- **Fix:** Tek bir `useSearchParams` instance'ini context veya shared hook uzerinden paylas, veya her iki hook'un `updateUrl`'ini birlestir.
- **Effort:** Orta (hooks restructure).

---

### BUG-003: ImpersonationPage tenant cache ikinci yuklemede crash [KRITIK]

- **Dosya:** `pages/system/ImpersonationPage.tsx:119-150`
- **Kanit:**
  - Satir 122: `tenantsApi.search('', 100)` `apiFetch` ile cagirilir. `apiFetch` (adminApi.ts:104-111) API envelope'u acar ve `Tenant[]` array dondurur.
  - Satir 123: `.then((res) => { tenantCacheRef.current = { data: res.data, ... }; return res; })` -- `res` bir array'dir, array'lerin `.data` property'si yoktur. `res.data` = `undefined`. Cache `{ data: undefined }` saklar.
  - Satir 121: Ikinci cagri cache hit olur: `Promise.resolve({ data: tenantCacheRef.current.data })` = `Promise.resolve({ data: undefined })`.
  - Satir 148: `tenantsRes.value.map(...)` -- `tenantsRes.value` artik `{ data: undefined }` objesidir, `.map()` fonksiyonu yoktur -> **TypeError: tenantsRes.value.map is not a function**.
- **Etki:** Ilk sayfa yuklemesi basarili olur, sonraki sayfa gecisleri veya 5 dakika icindeki donusler crash verir. Tenant dropdown'u bos kalir.
- **Fix:** Satir 122-124'te `res.data` yerine `res` kullan:
  ```ts
  tenantCacheRef.current = { data: res as SimpleTenant[], fetchedAt: Date.now() };
  ```
  Ve satir 148'de `.data` erisimi ekle veya Promise resolve'u duzelt.
- **Effort:** Dusuk (2 satir).

---

### BUG-004: Global cache Map boyut limiti yok -- memory leak [YUKSEK]

- **Dosya:** `hooks/useAsyncData.ts:60`
- **Kanit:** `const cache = new Map<string, { data: unknown; timestamp: number }>()` modul seviyesinde tanimli. Yeni entry eklenir ama suresi dolmus entry'ler SILINMEZ. `clearAsyncCache` sadece manueel cagirildiginda veya logout event'inde temizlenir. AuditLogPage her unique filtre+sayfa kombinasyonu icin yeni `cacheKey` olusturur (`audit-logs-${JSON.stringify(debouncedFilters)}-${pagination.page}`).
- **Etki:** Admin kullanicisi farkli filtrelerle sayfalarda gezindikce Map surekli buyur. Uzun sureli oturumlarda (admin paneli tum gun acik kalir) bellek tuketimi artar. Tab kapanana kadar GC tarafindan toplanamaz.
- **Fix:** LRU eviction veya max-size policy ekle. Ornegin:
  ```ts
  const MAX_CACHE_SIZE = 100;
  if (cache.size > MAX_CACHE_SIZE) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < oldest.length - MAX_CACHE_SIZE; i++) cache.delete(oldest[i][0]);
  }
  ```
- **Effort:** Dusuk (10-15 satir).

---

### BUG-005: usePagination setTotal sonrasi page out-of-bounds [YUKSEK]

- **Dosya:** `hooks/usePagination.ts:173-175`
- **Kanit:** `setTotal` sadece `setTotalState(newTotal)` cagirir, `page` degerini KONTROL ETMEZ. Eger mevcut `page > Math.ceil(newTotal / limit)` ise, sayfa sinirlarin disinda kalir.
- **Senaryo:** Kullanici 5. sayfadayken filtre degistirir, yeni sonuc sadece 2 sayfa. `setTotal` cagrilir ama `page` 5'te kalir. API 5. sayfa icin bos veri dondurur.
- **Etki:** Bos sayfa goruntulenir, kullanici hata oldugunu anlamaz. `canNext` false olur ama `canPrev` true -- geriye gidince dogru veri gorunur.
- **Fix:** `setTotal` icinde page clamp ekle:
  ```ts
  const setTotal = useCallback((newTotal: number) => {
    setTotalState(newTotal);
    const newTotalPages = Math.max(1, Math.ceil(newTotal / limit));
    setPage((prev) => Math.min(prev, newTotalPages));
  }, [limit]);
  ```
- **Effort:** Dusuk (3 satir).

---

### BUG-006: CSV export -- CSV injection ve memory leak [YUKSEK]

- **Dosya:** `pages/AuditLogPage.tsx:333-349`
- **Kanit (CSV injection):** Satir 344: `rows.map((row) => row.join(','))` -- hucre degerleri escape edilmiyor. Eger `log.performedByEmail` virgul, cift tirnak veya newline icerirse CSV bozulur. Eger `=SUM(...)` gibi formul icerirse Excel'de formula injection riski.
- **Kanit (Memory leak):** Satir 347: `URL.createObjectURL(blob)` ile olusturulan Object URL `URL.revokeObjectURL()` ile serbest birakilmiyor. Her export'ta ~birkaç KB kalici bellek sizintisi.
- **Kanit (Stale filter):** Satir 321-329: Export `filters` (non-debounced) kullanir ama `filters.search` export parametrelerine DAHIL EDILMIYOR (satir 323-329'da `search` yok). Arama filtresi export'a yansimaz.
- **Etki:** Bozuk CSV dosyalari, potansiyel formula injection, progressive memory leak.
- **Fix:** (1) CSV hucre escape fonksiyonu ekle, (2) `URL.revokeObjectURL(link.href)` ekle, (3) `search` filtresini export params'a ekle.
- **Effort:** Dusuk (15-20 satir).

---

### BUG-007: ReportsPage kendi apiFetch'i retry ve error handling bypass [YUKSEK]

- **Dosya:** `pages/ReportsPage.tsx:21-39`
- **Kanit:** ReportsPage kendi `apiFetch` wrapper'ini tanimlamis (satir 21-39). Bu wrapper:
  - Retry mantigi YOK (adminApi.ts'deki 3x retry'i bypass eder).
  - `X-Request-ID` header'i YOK (tracing kaybi).
  - API envelope unwrap YOK (adminApi.ts:104-111'deki `{ success, data }` unwrap'i bypass).
  - `response.json()` dogrudan dondurur -- eger backend envelope donuyorsa `{ success: true, data: ... }` objesi gelir, sayfa `data[0]` yerine `success` field'ini gorebilir.
- **Etki:** Rapor uretme suresinde gecici network hatalari dogal retry ile kurtarilamaz. Ayrica `useAsyncData` hook'u bu wrapper'i sararsa, `useAsyncData`'nin kendi timeout'u ile `apiFetch`'in timeout'u arasinda catisma olmaz (cunku custom wrapper'da timeout yok), ama retry yok.
- **Fix:** `adminApi.ts`'deki `reportsApi` namespace'ini kullan (zaten tanimli ama KULLANILMIYOR).
- **Effort:** Orta (sayfa genelinde refactor).

---

### BUG-008: AdminDashboard 5 paralel API cagrisi -- Promise.allSettled'da error swallow [ORTA]

- **Dosya:** `pages/AdminDashboard.tsx:384-401`
- **Kanit:** Satir 384: `Promise.allSettled` ile 5 API cagrisi paralel yapilir. Her biri icin `apiFetch` otomatik 3x retry yapar (adminApi.ts:57). En kotu durumda: 5 cagri x 4 deneme x 10s max delay = 200 saniyeye kadar beklenebilir. `loading: true` 200 saniye boyunca gorunebilir ve kullanici timeout'u hissetmez cunku `Promise.allSettled` TUMU bitmeden donmez.
- **Ayrica:** 30 saniyede bir `setInterval` ile yeniden cekiliyor (satir 431). Onceki fetch hala devam ediyorken yeni fetch baslar. `abortController` kullanilmiyor -- eski ve yeni response'lar karisiyor, `setData` yanlis siraya gore calisir.
- **Etki:** Yavas baglantilarda dashboard donuk goruntulenir. Concurrent fetch'ler state corruption'a neden olabilir.
- **Fix:** (1) AbortController kullan, (2) her fetch icin individual timeout ekle, (3) interval'i onceki fetch tamamlanmadan baslama.
- **Effort:** Orta (20-30 satir).

---

### BUG-009: useAsyncData AbortController fetcher'a iletilmiyor [ORTA]

- **Dosya:** `hooks/useAsyncData.ts:107-111, 148-149`
- **Kanit:** Satir 111: `abortControllerRef.current = new AbortController()` olusturuluyor. Satir 149: `fetcherRef.current()` cagirilir ama `AbortController.signal` fetcher'a ILETILMIYOR. `apiFetch` icindeki `fetch()` cagrisinda signal yoksa, abort islemi yalnizca `fetchIdRef` kontrolu ile state guncellemesini engeller ama gercek network istegi DEVAM EDER.
- **Etki:** `abort()` cagirildiginda veya component unmount oldugunuda, HTTP istegi arka planda devam eder. Bant genisligi israf edilir. Ozellikle buyuk rapor veya 10000 satir export islemlerinde belirgin olur.
- **Fix:** `useAsyncData`'nin fetcher tipini `(signal: AbortSignal) => Promise<T>` olarak degistir ve signal'i ilet.
- **Effort:** Orta (hook + tum tuketicileri guncelle).

---

### BUG-010: BillingDashboardPage hardcoded metrikler [ORTA]

- **Dosya:** `pages/BillingDashboardPage.tsx:65-77`
- **Kanit:** `transformRevenueData` fonksiyonunda:
  - Satir 72: `churnRate: 2.3` -- sabit deger, "Would come from separate API" yorumu.
  - Satir 73: `outstandingInvoices: 12` -- sabit deger.
  - Satir 74: `growth: 15.5` -- sabit deger.
  - Satir 75: `paymentSuccessRate: 98.5` -- sabit deger.
- **Etki:** Dashboard 4 kritik metrikte YANLIS veri gosteriyor. Kullanici gercek churn rate'i degil sabit %2.3 goruyor.
- **Fix:** Ilgili API endpoint'lerinden gercek veri cek veya bu kartlari "N/A" olarak isaretle.
- **Effort:** Orta (4 ek API cagrisi + backend kontrol).

---

### BUG-011: BillingDashboardPage dogrudan fetch -- retry yok, envelope unwrap yok [ORTA]

- **Dosya:** `pages/BillingDashboardPage.tsx:326-352`
- **Kanit:** `fetchTransactions` icinde dogrudan `fetch()` kullanilmis (satir 328-338). adminApi.ts bypass ediliyor:
  - Retry yok.
  - Hata durumunda `catch` blogu bos array donduruyor (satir 349-351) -- hata SESSIZCE yutulur. Kullanici hata oldugunu bilmez.
  - `data.data` erisiyor (satir 341) -- eger `apiFetch` envelope unwrap yapiyorsa `data` zaten icerik olur, ama dogrudan `fetch` + `response.json()` envelope'u acmaz. Bu durumda `data` = `{ success: true, data: [...] }` ve `data.data` dogru calisir. AMA eger backend envelope donmuyorsa `data.data` = `undefined`.
- **Etki:** Son islemler bolumu sessizce bos gorunur, kullanici hata oldugunu bilmez.
- **Fix:** `billingApi.getInvoices` kullan (zaten adminApi.ts'de tanimli).
- **Effort:** Dusuk (10 satir).

---

### BUG-012: useFilters clearFilters boolean/number icin yanlis "bos" deger [ORTA]

- **Dosya:** `hooks/useFilters.ts:184-206`
- **Kanit:** `clearFilters` fonksiyonu (satir 184-206) tiplere gore "bos" deger atar:
  - `number` -> `0` (satir 193): Eger `0` gecerli bir filtre degeriyse (ornegin `minPrice: 0`), "temizlendiginde" `0` atanir ama bu gercek bir filtre degeri olabilir.
  - `boolean` -> `false` (satir 195): Ayni sorun -- `false` gecerli bir filtre degeri olabilir (`isActive: false`).
  - `hasActiveFilters` (satir 208-219) `currentValue === initialValue` kontrolu yapar. Clear sonrasi eger `initialValue` zaten `0` veya `false` ise, filtre "aktif" olarak gorulmez ama davranis dogru olur. Ancak eger `initialValue` farkli ise (ornekin `initialFilters.minPrice = 10`), clear sonrasi `minPrice = 0` olur ve `hasActiveFilters` true doner -- yanlis.
- **Etki:** "Clear All Filters" dugmesi beklenmeyen filtre degerleri uretebilir.
- **Fix:** `clearFilters`'i `resetFilters` ile birlestir veya `initialFilters` degerlerine geri don.
- **Effort:** Dusuk (5 satir).

---

### BUG-013: AuditLogPage audit-stats cacheKey tenantId'ye bagli ama date range'e degil [DUSUK]

- **Dosya:** `pages/AuditLogPage.tsx:310-313`
- **Kanit:** Satir 311: `cacheKey: \`audit-stats-${debouncedFilters.tenantId}\`` -- yalnizca `tenantId`'ye bagli. Ama `fetchStats` (satir 302-308) ayrica `startDate` ve `endDate` kullanir. Kullanici ayni tenant icin farkli tarih araligini secerse, eski istatistikler cache'den doner.
- **Etki:** Stale istatistik karti. 60 saniye TTL sonrasi duzeltilir ama kisa sure yanlis deger gorunur.
- **Fix:** `cacheKey`'e `startDate` ve `endDate` ekle:
  ```ts
  cacheKey: `audit-stats-${debouncedFilters.tenantId}-${debouncedFilters.startDate}-${debouncedFilters.endDate}`
  ```
- **Effort:** Trivial (1 satir).

---

### BUG-014: useAsyncData onSuccess/onError/transform callback stale closure [DUSUK]

- **Dosya:** `hooks/useAsyncData.ts:226`
- **Kanit:** `fetchData` dependency array'inde `transform`, `onSuccess`, `onError` bulunuyor. Bu callback'ler tuketici tarafindan inline olarak gecilirse, her renderda yeni referans olusur, `fetchData` yeniden olusturulur, bu da `fetch`/`refresh`/`silentRefresh`/`retry`'i yeniden olusturur. Downstream component'ler bu fonksiyonlari prop olarak aliyorsa gereksiz re-render olur.
- **Etki:** Performans degradation. Eger `BUG-001` fix'i uygulanir ve `fetchData` degisikliginde otomatik refetch yapilirsa, inline callback'ler sonsuz fetch dongusu yaratir.
- **Fix:** `onSuccess`, `onError`, `transform`'u da ref'lere tasi (fetcher'da yapildigi gibi).
- **Effort:** Dusuk (6 satir).

---

## Spawn Talepleri

| # | Hedef | Aciklama | Oncelik |
|---|-------|----------|---------|
| S1 | BUG-001 Fix | `useAsyncData`'ya otomatik refetch mekanizmasi ekle | P0 (tum data-fetch sayfalarini etkiliyor) |
| S2 | BUG-002 Fix | URL sync icin tek `useSearchParams` instance paylas | P1 |
| S3 | BUG-003 Fix | ImpersonationPage tenant cache `.data` erisimini duzelt | P0 (crash) |
| S4 | BUG-004 Fix | Cache Map'e LRU eviction + max-size ekle | P1 |
| S5 | BUG-005 Fix | `setTotal`'a page clamp ekle | P1 |
| S6 | BUG-006 Fix | CSV export: escape + revoke URL + search filtre dahil et | P1 |
| S7 | BUG-007 Fix | ReportsPage'i `reportsApi` namespace'ine gecir | P2 |
| S8 | BUG-008 Fix | AdminDashboard'a AbortController + concurrent fetch guard ekle | P2 |

---

## Oneriler

1. **useAsyncData refetch mekanizmasi (BUG-001):** Bu en kritik bug. Tum `useAsyncData` tuketicileri (6 sayfa) etkileniyor. Hook'a `deps` array veya `cacheKey` bazli otomatik refetch eklenmeli. Bu fix ayni zamanda BUG-014'u de dikkate almali -- inline callback'ler sonsuz dongu yaratmasin.

2. **URL sync mimarisi (BUG-002):** `usePagination` ve `useFilters` ayri `useSearchParams` instance'lari kullanmak yerine tek bir "URL state manager" hook olusturulmali. Bu hook tum URL parametrelerini tek bir `setSearchParams` cagrisiyla guncellemeli.

3. **MIXED fetch pattern'leri (BUG-007, BUG-011):** 5 sayfa (Announcements, BillingDashboard, AuditTrail, ActivityLog, Compliance) hem `adminApi` hem dogrudan `fetch()` kullaniyor. Tum dogrudan `fetch` cagrilari `adminApi.ts`'deki namespace'lere tasinmali. Bu sekilde retry, error handling, envelope unwrap ve request tracing tutarli hale gelir.

4. **Test onceligi:** BUG-001 ve BUG-003 icin regression testleri yazilmali. `useAsyncData.spec.ts` (705 satir) mevcut ama `cacheKey` degisikliginde refetch davranisini test etmiyor. ImpersonationPage icin cache hit senaryosu test edilmeli.
