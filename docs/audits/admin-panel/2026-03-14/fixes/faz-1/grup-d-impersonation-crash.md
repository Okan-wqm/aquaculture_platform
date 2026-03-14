# Grup D - ImpersonationPage Cache Crash Fix (C9)

## Bulgu
**C9**: ImpersonationPage'de `tenantsApi.search()` sonucu yanlış erisimiyle cache crash.

## Kök Neden

`apiFetch()` fonksiyonu (adminApi.ts:104-110) API envelope'unu (`{success, data}`) otomatik unwrap eder ve non-paginated response'larda dogrudan `json.data`'yi dondurur. Yani `tenantsApi.search()` dogrudan `Tenant[]` dondurur, `{data: Tenant[]}` degil.

Ancak ImpersonationPage'deki kod `res.data` seklinde erisiyordu:

```typescript
// HATALI KOD (onceki hali)
const tenantsPromise: Promise<{ data: SimpleTenant[] }> =
  tenantCacheRef.current && now - tenantCacheRef.current.fetchedAt < TENANT_CACHE_TTL
    ? Promise.resolve({ data: tenantCacheRef.current.data })
    : tenantsApi.search('', 100).then((res) => {
        tenantCacheRef.current = { data: res.data, fetchedAt: Date.now() }; // res.data = undefined!
        return res;
      });
```

### Crash Senaryosu
1. Ilk ziyaret: `tenantsApi.search()` cagrilir, `Tenant[]` doner. `res.data` -> `undefined` (array'de `.data` yok).
2. Cache'e `{ data: undefined, fetchedAt: ... }` kaydedilir.
3. `tenantsRes.value` aslinda `Tenant[]`'dir (`.then` icinde `return res` yapar), ilk ziyarette `.map()` calisir.
4. Ikinci ziyaret (cache TTL icinde): `Promise.resolve({ data: tenantCacheRef.current.data })` -> `{ data: undefined }` doner.
5. `tenantsRes.value` = `{ data: undefined }`, `tenantsRes.value.map(...)` -> `TypeError: tenantsRes.value.map is not a function`.

## Uygulanan Fix

### Dosya: ImpersonationPage.tsx

**Degisiklik 1** - Promise tipi ve cache mantigi duzeltmesi (satir 119-127):
- `Promise<{ data: SimpleTenant[] }>` -> `Promise<SimpleTenant[]>` olarak tip duzeltmesi
- Cache hit: `Promise.resolve({ data: tenantCacheRef.current.data })` -> `Promise.resolve(tenantCacheRef.current.data)`
- Cache miss: `res.data` yerine `res` (zaten `Tenant[]`) kullanilarak mapping yapilir ve cache'e dogru kaydedilir

**Degisiklik 2** - tenantsRes kullanimi (satir 148-152):
- `tenantsRes.value.map((t) => ({...}))` -> `tenantsRes.value` (mapping artik cache kaydi sirasinda yapiliyor)

## Etki Analizi
- Admin-panel'in diger sayfalarinda ayni pattern (non-paginated API sonucuna `.data` erisimi) icin grep yapildi, baska etkilenen yer bulunamadi.
- `sessionsRes.value.data` ve `permissionsRes.value.data` erisimleri dogru: `getSessions()` ve `getPermissions()` paginated API'lardir (`PaginatedResult<...>`), apiFetch bu durumlarda `{ data: [...], page, limit, total }` dondurur.

## TypeScript Dogrulama
- `npx tsc --noEmit` basariyla gecti, tip hatasi yok.

## Ilgili Dosyalar
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx` (duzeltilen dosya)
- `/var/aqua-saas/web/modules/admin-panel/src/services/adminApi.ts` (referans - apiFetch envelope unwrap mantigi, satir 104-110)
