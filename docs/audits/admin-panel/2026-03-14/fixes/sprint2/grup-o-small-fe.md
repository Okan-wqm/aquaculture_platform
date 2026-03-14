# Grup O - Frontend Kucuk Fix Raporu

**Tarih:** 2026-03-14
**Kapsam:** admin-panel MFE - usePagination, useFilters, dependency cleanup

---

## H2: usePagination + useFilters URL sync stale closure

**Sorun:** Her iki hook ayri `useSearchParams()` instance kullaniyor. `updateUrl` fonksiyonlari `searchParams` degerini closure uzerinden yakaliyordu. Bir hook URL'i guncellediginde diger hook eski `searchParams` snapshot'ini kullanarak karsi tarafin parametrelerini siliyordu.

**Fix:** `setSearchParams` cagrilarini functional update formuna cevirdik:
- `setSearchParams(prev => { ... return next; })` kullanarak her zaman guncel URL parametrelerini okuyoruz
- `searchParams` dependency'si `updateUrl` useCallback bagimlilik dizisinden kaldirildi

**Dosyalar:**
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/usePagination.ts` - `updateUrl` fonksiyonu (satir 121-134)
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/useFilters.ts` - `updateUrl` fonksiyonu (satir 98-121)

---

## M4: usePagination setTotal page out-of-bounds

**Sorun:** `setTotal` cagirildiginda (`totalPages` azaldiginda) mevcut `page` degeri toplam sayfa sayisini asabiliyordu. Kullanici gecersiz bir sayfada kaliyordu ve API'ye gecersiz offset gonderiyordu.

**Fix:** `setTotal` icinde `setPage` functional update ile clamp eklendi:
```ts
setPage(prev => {
  const maxPage = Math.max(1, Math.ceil(newTotal / limit));
  return Math.min(prev, maxPage);
});
```

**Dosyalar:**
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/usePagination.ts` - `setTotal` fonksiyonu (satir 175-182)
- `/var/aqua-saas/web/modules/admin-panel/src/hooks/__tests__/usePagination.spec.ts` - Test guncellendi: `setTotal` sonrasi sayfa otomatik clamp beklentisi (satir 258-279)

---

## M11: @tanstack/react-query kullanilmiyor - kaldirildi

**Dogrulama:** `src/` altinda `@tanstack/react-query` veya `react-query` import eden hicbir dosya bulunamadi (grep ile dogrulandi).

**Fix:**
- `package.json` dependencies'den `"@tanstack/react-query": "^5.17.0"` kaldirildi
- `vite.config.ts` shared singleton'lardan `'@tanstack/react-query': { singleton: true, requiredVersion: '^5.17.0' }` kaldirildi

**Dosyalar:**
- `/var/aqua-saas/web/modules/admin-panel/package.json` (satir 17 kaldirildi)
- `/var/aqua-saas/web/modules/admin-panel/vite.config.ts` (shared blogundan kaldirildi)

---

## M12: zustand MF shared phantom dependency - kaldirildi

**Dogrulama:**
- `package.json`'da `zustand` dependency olarak hic yoktu
- `src/` altinda `zustand` import eden hicbir dosya bulunamadi (grep ile dogrulandi)
- Ancak `vite.config.ts` shared singleton'larda `zustand: { singleton: true, requiredVersion: '^4.4.0' }` vardi -- phantom dependency

**Fix:**
- `vite.config.ts` shared singleton'lardan `zustand` kaldirildi

**Dosyalar:**
- `/var/aqua-saas/web/modules/admin-panel/vite.config.ts` (shared blogundan kaldirildi)

---

## Test Etkisi

- Mevcut test `usePagination.spec.ts` "should handle total becoming less than current page offset" M4 fix'ine uygun guncellendi
- Davranis degisikligi: `setTotal(50)` artik sayfa 5'ten 3'e otomatik clamp ediyor (onceden elle `goToPage` gerekiyordu)
- Diger testler etkilenmedi
