# Deep Dive: Frontend Hook Bug'lari (BUG-001, BUG-002, BUG-003)

Tarih: 2026-03-14
Ajan: Deep-Dive Analiz Ajani (Opus 4.6)
Kaynak: P6 Bug Raporu (`wave-2a/06-bugs.md`)
Kapsam: `useAsyncData`, `usePagination`, `useFilters` hook'lari ve ImpersonationPage

---

## Yonetici Ozeti

3 kritik bug'un satir satir dogrulamasi yapildi. Sonuc:

| Bug | P6 Verdikti | Deep-Dive Verdikti | Aciklama |
|-----|-------------|---------------------|----------|
| BUG-001 | KRITIK | **DOGRULANDI - KRITIK** | useAsyncData dependency array bos, cacheKey degisince refetch YOK |
| BUG-002 | KRITIK | **DOGRULANDI - YUKSEK** (KRITIK degil) | URL param collision gercek ama pratikte AuditLogPage'de debounce + goToPage(1) ayni cycle'da calismaz |
| BUG-003 | KRITIK | **DOGRULANDI - KRITIK** | tenantsApi.search() Tenant[] dondurur, `.data` -> undefined, cache hit'te crash |

---

## BUG-001: useAsyncData filtre/pagination degisikliginde refetch yapmiyor

### Dosya
`web/modules/admin-panel/src/hooks/useAsyncData.ts`

### Satir Satir Analiz

**Satir 272-277 -- Initial fetch useEffect:**
```ts
// Initial fetch
useEffect(() => {
  if (immediate) {
    fetchData(true);
  }
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```
Dependency array GERCEKTEN BOS (`[]`). Bu effect sadece component mount'ta calisir.

**Satir 105-227 -- fetchData useCallback:**
```ts
const fetchData = useCallback(
  async (showLoading = true) => {
    // ... fetch logic ...
  },
  [cacheKey, cacheTTL, timeout, transform, onSuccess, onError]
);
```
`fetchData` dependency'lerinde `cacheKey` var. Yani `cacheKey` degistiginde `fetchData` yeni referans alir.
Ama HICBIR useEffect `fetchData` degisikligini dinleyip yeniden cagrisi yapmiyor.

**Satir 229-231 -- fetch/refresh/silentRefresh:**
```ts
const fetch = useCallback(() => fetchData(true), [fetchData]);
const refresh = useCallback(() => fetchData(true), [fetchData]);
const silentRefresh = useCallback(() => fetchData(false), [fetchData]);
```
Bunlar `fetchData` degistiginde yeniden olusturuluyor ama OTOMATIK olarak cagrilmiyor.
Sadece kullanici "Refresh" butonuna tikladiginda veya kodda manuel olarak `refresh()` cagrildiginda calisir.

**Sonuc:** P6'nin verdikti DOGRU. `cacheKey` degistiginde (filtre/pagination degisikligi) otomatik refetch mekanizmasi yok.

### Etkilenen Tuketiciler

`useAsyncData` kullanan tum dosyalar:
1. `pages/AuditLogPage.tsx` -- `cacheKey: \`audit-logs-${JSON.stringify(debouncedFilters)}-${pagination.page}\``
2. `pages/AuditLogPage.tsx` -- `cacheKey: \`audit-stats-${debouncedFilters.tenantId}\``
3. `pages/AuditLogPage.tsx` -- `cacheKey: 'audit-tenants'`
4. `pages/ModulesPage.tsx`
5. `pages/SystemSettingsPage.tsx`
6. `pages/BillingDashboardPage.tsx`
7. `pages/ProvisioningSettingsPage.tsx`
8. `pages/ReportsPage.tsx`

**Toplam: 6 sayfa, 8+ useAsyncData cagrisi etkileniyor.**

### Neden Kullanicilar Henuz Farketmemis Olabilir?

AuditLogPage'de `fetchLogs` fonksiyonu `useCallback` ile `[pagination.page, pagination.limit, debouncedFilters]` dependency'leriyle sarili. `fetchLogs` referansi her filtre/pagination degisikliginde degisiyor ve `fetcherRef.current` guncelleniyor (satir 101-103):
```ts
useEffect(() => {
  fetcherRef.current = fetcher;
}, [fetcher]);
```
AMA bu sadece ref'i gunceller -- yeni fetch TETIKLEMEZ.

Kullanici "Refresh" butonuna bastiginda dogru filtrelerle fetch yapar (cunku `fetcherRef.current` guncel). Ama **otomatik** olarak hicbir sey olmaz. Sayfa ilk yukleme sonrasi DONUK kalir.

### Onerilen Fix

```ts
// useAsyncData.ts -- Satir 272-277'yi degistir:

// Refetch when fetchData identity changes (driven by cacheKey / cacheTTL / timeout)
useEffect(() => {
  if (immediate) {
    fetchData(true);
  }
}, [fetchData]); // fetchData cacheKey'e bagli, cacheKey degisince refetch
```

**UYARI:** Bu fix'i uygulamadan once BUG-014'u de cozmelisiniz. `fetchData` dependency'lerinde `transform`, `onSuccess`, `onError` var. Tuketiciler bunlari inline arrow olarak gecerse, her renderda yeni referans olusur ve sonsuz fetch dongusu baslar.

Guvenli fix -- once callback'leri ref'e tasi:
```ts
// Satir 95-103 arasina ekle:
const transformRef = useRef(transform);
const onSuccessRef = useRef(onSuccess);
const onErrorRef = useRef(onError);

useEffect(() => { transformRef.current = transform; }, [transform]);
useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);
useEffect(() => { onErrorRef.current = onError; }, [onError]);

// Sonra fetchData icinde transform, onSuccess, onError yerine ref'leri kullan
// Ve fetchData dependency array'inden cikar:
// [cacheKey, cacheTTL, timeout]  <-- sadece bu uc
```

---

## BUG-002: usePagination + useFilters URL sync race condition

### Dosya
- `web/modules/admin-panel/src/hooks/usePagination.ts`
- `web/modules/admin-panel/src/hooks/useFilters.ts`

### Satir Satir Analiz

**usePagination -- Satir 68:**
```ts
const [searchParams, setSearchParams] = useSearchParams();
```

**useFilters -- Satir 55:**
```ts
const [searchParams, setSearchParams] = useSearchParams();
```

Her iki hook AYRI `useSearchParams()` cagrisi yapiyor. React Router'da `useSearchParams()` her cagirildiginda AYNI `searchParams` snapshot'unu dondurur (ayni render cycle icinde).

**usePagination -- updateUrl (Satir 122-132):**
```ts
const updateUrl = useCallback(
  (newPage: number, newLimit: number) => {
    if (syncUrl) {
      const newParams = new URLSearchParams(searchParams);  // <-- snapshot
      newParams.set('page', String(newPage));
      newParams.set('limit', String(newLimit));
      setSearchParams(newParams, { replace: true });
    }
  },
  [syncUrl, searchParams, setSearchParams]
);
```

**useFilters -- updateUrl (Satir 99-119):**
```ts
const updateUrl = useCallback(
  (newFilters: T) => {
    if (!syncUrl) return;
    const newParams = new URLSearchParams(searchParams);  // <-- AYNI snapshot
    Object.entries(newFilters).forEach(([key, value]) => {
      // ...
      newParams.set(key, ...);
      // ...
    });
    setSearchParams(newParams, { replace: true });
  },
  [syncUrl, searchParams, setSearchParams, initialFilters]
);
```

### Collision Senaryosu

AuditLogPage'de:
1. Kullanici "Action" dropdown'unu degistirir
2. `setFilter('action', 'CREATE')` cagirilir (useFilters, satir 146-164)
3. Bu `updateUrl(newFilters)` cagirir -> `setSearchParams({action:'CREATE', ...mevcutSnapshot})`
4. `action` debounceKeys'de DEGIL, yani `setDebouncedFilters(newFilters)` hemen cagirilir (satir 153-154)
5. AuditLogPage satir 316-318: `useEffect(() => { pagination.goToPage(1); }, [debouncedFilters]);`
6. Bu effect sonraki render cycle'da calisir ve `goToPage(1)` cagirir
7. `goToPage(1)` -> `updateUrl(1, 20)` -> `setSearchParams({page:'1', limit:'20', ...mevcutSnapshot})`

**Kritik soru: 3. ve 7. adim AYNI render cycle'da mi calisir?**

- Adim 3: `setFilter` icinde `setFiltersState` bir state update. React bunu batch eder.
- Adim 5: `useEffect([debouncedFilters])` -- effect SONRAKI render cycle'da calisir (debouncedFilters degistikten sonra).
- Adim 7: Sonraki render cycle'da `goToPage(1)` calisir. Bu noktada `searchParams` zaten adim 3'un sonucunu yansitir (React Router state guncellenmis olur).

**Ayni React render cycle icinde iki `setSearchParams` cagirilirsa**, ikincisi birincisinin parametrelerini SILER cunku ikisi de ayni `searchParams` snapshot'undan baslar.

**Pratikte ne oluyor?**

- `action` filtresi debounceKeys'de DEGIL -> `setDebouncedFilters` senkron cagirilir (satir 154)
- AMA `useEffect([debouncedFilters])` yine de sonraki render cycle'da calisir
- Bu durumda iki farkli render cycle'da iki farkli `setSearchParams` cagirilir
- `searchParams` ilk cagri sonrasi guncellenir, ikinci cagri guncel snapshot'u kullanir

**ANCAK:** `search` filtresi icin durum farkli. `search` debounceKeys'de:
1. Kullanici arama yapar
2. `setFilter('search', 'test')` cagirilir
3. `search` debounceKeys'de oldugu icin `setDebouncedFilters` HEMEN cagirilmaz (satir 153: `if (!debounceKeys.includes(key))` -- false)
4. 300ms sonra debounce effect'i calisir (satir 130-131): `setDebouncedFilters(filters)`
5. Bu da `useEffect([debouncedFilters])` -> `goToPage(1)` tetikler
6. Bu noktada `updateUrl` icindeki `searchParams` snapshot'u GUNCEL olur

**P6'nin senaryosu (ayni cycle'da iki setSearchParams) gerceklesebilir ama cok dar bir pencerede:**

Non-debounced filtre degisikliginde `setFilter` icinde `updateUrl` hemen cagirilir VE React `setFiltersState` + `setDebouncedFilters`'i batch'ler. Eger `useEffect([debouncedFilters])` ayni batch icinde triggered olursa (ki React 18 auto-batching ile OLMAZ -- useEffect her zaman commit sonrasi calisir), collision olur.

### Verdikt: DOGRULANDI - YUKSEK (KRITIK degil)

Race condition TEORIK olarak gercek ama pratikte:
- React 18 auto-batching sayesinde `setFilter` + `setDebouncedFilters` ayni commit'te olur
- `useEffect([debouncedFilters])` SONRAKI commit'te calisir
- Bu commit'te `searchParams` guncel olur

**AMA** sunu gozden kacirmayin: `updateUrl` closure'unda `searchParams` STALE olabilir cunku `updateUrl`'in kendisi `useCallback` ile sarili ve dependency'si `[syncUrl, searchParams, setSearchParams]`. Stale closure riski GERCEK.

Eger kullanici HIZLI HIZLI filtre degistirirse:
1. Render 1: `updateUrl` closure'u `searchParams_1` yakaladi
2. `setFilter('action', 'CREATE')` -> `updateUrl(filters)` -> `searchParams_1` + action
3. React re-render tetikler, `searchParams_2` olusur
4. AMA `goToPage(1)` henuz eski `updateUrl` closure'unu kullaniyorsa (memo'dan dolayi), `searchParams_1` ile calisir -> action parametresini siler

**Sonuc: Bu STALE CLOSURE problemidir, race condition degil. Ama sonuc ayni: URL parametreleri kaybolabilir.**

### Etkilenen Sayfalar

Sadece `AuditLogPage.tsx` iki hook'u da `syncUrl: true` ile kullaniyor. Diger sayfalarda bu kombinasyon yok.

**Toplam: 1 sayfa etkileniyor.**

### Onerilen Fix

**Secenek A (minimal):** `updateUrl` icinde `searchParams` yerine `window.location.search`'ten guncel degeri oku:
```ts
// usePagination.ts -- updateUrl
const updateUrl = useCallback(
  (newPage: number, newLimit: number) => {
    if (syncUrl) {
      const newParams = new URLSearchParams(window.location.search);
      newParams.set('page', String(newPage));
      newParams.set('limit', String(newLimit));
      setSearchParams(newParams, { replace: true });
    }
  },
  [syncUrl, setSearchParams]  // searchParams dependency KALDIRILDI
);
```

Ayni degisiklik `useFilters.ts` icin de uygulanmali.

**Secenek B (ideal):** Tek bir `useUrlState` hook'u olustur, iki hook'un da bunu kullanmasini sagla. Bu hook tek bir `setSearchParams` cagrisi ile tum parametreleri atomik olarak gunceller. Daha buyuk refactor gerektirir.

**Secenek C (pragmatik):** `setSearchParams` yerine React Router'in functional update formunu kullan:
```ts
setSearchParams((prev) => {
  const newParams = new URLSearchParams(prev);
  newParams.set('page', String(newPage));
  newParams.set('limit', String(newLimit));
  return newParams;
}, { replace: true });
```
Bu closure problemi tamamen cozer cunku `prev` her zaman GUNCEL degeri verir.

**Tavsiyem: Secenek C -- en az degisiklikle en buyuk etkiyi yaratir.**

---

## BUG-003: ImpersonationPage tenant cache ikinci yuklemede crash

### Dosya
`web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`

### Satir Satir Analiz

**Adim 1: tenantsApi.search() donus tipi**

`adminApi.ts` satir 2093-2094:
```ts
search: (q: string, limit?: number) =>
  apiFetch<Tenant[]>(`/tenants/search?q=${encodeURIComponent(q)}&limit=${limit || 20}`),
```

Type parameter: `Tenant[]`. Bu non-paginated bir cagri.

`apiFetch` satir 102-112'de envelope unwrap mantigi:
```ts
const json = JSON.parse(text);
if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
  if (json.meta && typeof json.meta === 'object' && 'page' in json.meta) {
    return { data: json.data, ...json.meta } as T;  // paginated
  }
  return json.data as T;  // NON-PAGINATED: data'yi dondurur
}
return json;
```

Backend `{ success: true, data: [...tenants] }` donduruyorsa:
- `apiFetch` envelope'u acar ve `json.data` yani `Tenant[]` dondurur
- Return tipi: `Tenant[]` (bir array)

**Adim 2: ImpersonationPage'de kullanim**

Satir 119-125:
```ts
const tenantsPromise: Promise<{ data: SimpleTenant[] }> =
  tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
    ? Promise.resolve({ data: tenantCacheRef.current.data })
    : tenantsApi.search('', 100).then((res) => {
        tenantCacheRef.current = { data: res.data, fetchedAt: Date.now() };
        return res;
      });
```

**Sorun 1:** `tenantsPromise` tipi `Promise<{ data: SimpleTenant[] }>` olarak tanimlanmis.
Ama `tenantsApi.search()` `Tenant[]` dondurur (duz array, `{ data: ... }` objesi degil).
- `res` = `Tenant[]` (array)
- `res.data` = `undefined` (array'lerin `.data` property'si yok)
- `tenantCacheRef.current = { data: undefined, fetchedAt: ... }`

**Sorun 2:** `return res` deniyor. `res` bir array. Ama `tenantsPromise` tipi `Promise<{ data: SimpleTenant[] }>`.
TypeScript bunu kontrol etmez cunku `then` callback'inin donus tipi inference'i karmasik.

**Adim 3: Ilk fetch -- nasil CALISIYOR?**

Satir 146-149:
```ts
setTenants(
  tenantsRes.status === 'fulfilled'
    ? tenantsRes.value.map((t) => ({ id: t.id, name: t.name, ... }))
    : []
);
```

`tenantsRes.value` = `return res` = `Tenant[]` (array).
`tenantsRes.value.map(...)` CALISIYOR cunku `tenantsRes.value` gercekten bir array.

Ama cache'e `{ data: undefined }` yazildi.

**Adim 4: Ikinci fetch (cache hit) -- CRASH**

Satir 119-121:
```ts
tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
  ? Promise.resolve({ data: tenantCacheRef.current.data })
```

`tenantCacheRef.current.data` = `undefined`
`Promise.resolve({ data: undefined })` dondurulur.

Satir 146-149:
```ts
tenantsRes.value.map(...)
```

`tenantsRes.value` = `{ data: undefined }` (Promise.resolve'dan gelen obje)
`{ data: undefined }.map` = **TypeError: tenantsRes.value.map is not a function**

### Verdikt: DOGRULANDI - KRITIK

P6'nin analizi birebir dogru. Ilk sayfa yuklemesi basarili, 5 dakika icindeki ikinci yukleme crash verir.

### Ek Gozlem: Tip uyumsuzlugu

`tenantsPromise` tipi `Promise<{ data: SimpleTenant[] }>` olarak beyan edilmis ama:
- Cache hit: `{ data: SimpleTenant[] }` dondurur (dogru tip, yanlis deger -- `data` = `undefined`)
- Cache miss: `tenantsApi.search()` `Tenant[]` dondurur (tip UYUMSUZ)

Bu TypeScript'in tip guvencesini bypass eden bir tasarim hatasi.

### Onerilen Fix

```ts
// ImpersonationPage.tsx -- Satir 119-125 degistir:

const tenantsPromise: Promise<SimpleTenant[]> =
  tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
    ? Promise.resolve(tenantCacheRef.current.data)
    : tenantsApi.search('', 100).then((res) => {
        // res zaten Tenant[] (apiFetch envelope'u acmis)
        const simplified = (res as unknown as SimpleTenant[]);
        tenantCacheRef.current = { data: simplified, fetchedAt: Date.now() };
        return simplified;
      });

// Satir 146-149 degistir:
setTenants(
  tenantsRes.status === 'fulfilled'
    ? (tenantsRes.value as SimpleTenant[]).map((t) => ({
        id: t.id, name: t.name, slug: t.slug, status: t.status, tier: t.tier
      }))
    : []
);
```

Veya daha temiz: cache'i dogrudan `SimpleTenant[]` olarak sakla ve Promise'i de `SimpleTenant[]` dondur.

---

## Etki Analizi Ozet Tablosu

| Bug | Etkilenen Sayfalar | Etki Tipi | Tetikleme Kosulu |
|-----|-------------------|-----------|------------------|
| BUG-001 | AuditLogPage, ModulesPage, SystemSettingsPage, BillingDashboardPage, ProvisioningSettingsPage, ReportsPage (6 sayfa) | Stale data -- filtre/pagination degisikliginde veri guncellenmiyor | Herhangi bir filtre veya sayfa degisikligi |
| BUG-002 | AuditLogPage (1 sayfa) | URL parametreleri kaybolabilir, browser back/forward bozuk | Non-debounced filtre degisikligi + pagination reset ayni anda |
| BUG-003 | ImpersonationPage (1 sayfa) | TypeError crash -- sayfa kullanilamaz hale gelir | Sayfayi 5 dakika icinde ikinci kez ziyaret etme veya tab icerisinde sayfa gecisi |

---

## Fix Oncelik Sirasi

### 1. BUG-003 (Hemen -- 10 dakika)
- Tek dosya, 2-3 satir degisiklik
- Crash bug -- sayfa kullanilamaz
- Regresyon riski: Cok dusuk

### 2. BUG-001 (Hemen -- 30 dakika)
- Tek dosya (useAsyncData.ts) ama tum tuketicileri etkiler
- BUG-014 ile birlikte cozulmeli (callback ref'leri)
- Regresyon riski: Orta (sonsuz dongu riski -- test gerekli)
- Fix sirasinda yapilacaklar:
  1. `transform`, `onSuccess`, `onError` icin ref'ler ekle (BUG-014)
  2. `fetchData` dependency array'ini `[cacheKey, cacheTTL, timeout]` olarak daralt
  3. Initial fetch useEffect'ini `[fetchData]` dependency ile degistir
  4. `useAsyncData.spec.ts`'e cacheKey degisikliginde refetch testi ekle

### 3. BUG-002 (Bu hafta -- 1-2 saat)
- 2 dosya (usePagination.ts, useFilters.ts)
- Secenek C (functional setSearchParams update) en hizli cozum
- Regresyon riski: Dusuk-Orta
- Fix sirasinda yapilacaklar:
  1. Her iki hook'ta `setSearchParams` cagrilarini functional update formuna cevir
  2. `updateUrl` dependency array'inden `searchParams` kaldir
  3. Mevcut testlere URL sync senaryolari ekle

---

## Ek Bulgular (Deep-Dive Sirasinda Tespit Edilen)

### EK-001: AuditLogPage fetchLogs dependency array eksik

`AuditLogPage.tsx` satir 289:
```ts
}, [pagination.page, pagination.limit, debouncedFilters]);
```
`pagination.setTotal` kullaniliyor (satir 287) ama dependency array'de yok. Bu bir eslint uyarisi uretir ama gercek bir bug degil cunku `setTotal` stabil bir callback (`useCallback` ile `[]` dependency).

### EK-002: AuditLogPage goToPage(1) effect'inde eslint-disable eksik

Satir 316-318:
```ts
useEffect(() => {
  pagination.goToPage(1);
}, [debouncedFilters]);
```
`pagination.goToPage` dependency array'de yok. `goToPage` her render'da degisebilir (`totalPages` ve `updateUrl` dependency'leri var). Bu bir lint uyarisi olabilir ama davranis olarak dogru -- filtreler degistiginde sayfa 1'e donmek isteniyor.

### EK-003: useAsyncData AbortController signal iletilmiyor (BUG-009 dogrulama)

Satir 111 ve 149:
```ts
abortControllerRef.current = new AbortController();
// ...
let result = await Promise.race([fetcherRef.current(), timeoutPromise]);
```
`AbortController.signal` fetcher'a VERILMIYOR. `abort()` cagirildiginda:
- `fetchIdRef` arttirilir (satir 244) -- bu sonraki state update'i engeller
- `abortControllerRef.current.abort()` cagirilir (satir 246) -- ama signal hicbir `fetch()`'e bagli degil
- Gercek HTTP istegi DEVAM EDER

Bu BUG-001 fix'i ile birlikte degerlendirilmeli: cacheKey degisikliginde eski fetch abort edilmeli ve signal fetcher'a iletilmeli.
