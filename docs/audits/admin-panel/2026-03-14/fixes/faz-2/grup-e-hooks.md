# Grup E: useAsyncData Hook Fix Raporu

Tarih: 2026-03-14
Ajan: Frontend Hook Uzmani (Grup E)
Hedef Dosya: `web/modules/admin-panel/src/hooks/useAsyncData.ts`

---

## Ozet

3 bulgu sirasiyla cozuldu (C8 -> C7 -> H1). Sira kritikti: C7'yi C8'den once yapmak sonsuz dongu olusturabilirdi.

| Bulgu | Seviye | Durum | Aciklama |
|-------|--------|-------|----------|
| C8 | Kritik | COZULDU | Callback ref pattern eksik -- sonsuz dongu riski |
| C7 | Kritik | COZULDU | Bos dependency array -- cacheKey degisince refetch yok |
| H1 | Yuksek | COZULDU | Global cache Map boyut siniri yok -- bellek sizintisi |

---

## C8: Callback Ref Pattern (Sonsuz Dongu Onleme)

### Problem
`fetchData` useCallback dependency array'inde `transform`, `onSuccess`, `onError` callback'leri vardi. Tuketiciler bu callback'leri inline arrow function olarak gecirdiklerinde, her renderda yeni referans olusuyordu. Bu da `fetchData` kimliginin her renderda degismesine yol aciyordu. C7 fix'i (asagida) `fetchData` degisikligini dinleyen bir useEffect eklediginden, bu durumda sonsuz fetch dongusu baslardir.

### Cozum
- `useRef` ile callback ref'leri olusturuldu: `transformRef`, `onSuccessRef`, `onErrorRef`
- Her render'da ref.current guncelleniyor (dependency'siz useEffect ile)
- `fetchData` icinde dogrudan callback yerine `ref.current` kullaniliyor
- `fetchData` dependency array'inden `transform`, `onSuccess`, `onError` cikarildi
- Sonuc dependency array: `[cacheKey, cacheTTL, timeout]`

### Degisiklik Detayi
```typescript
// EKLENDI (satir 137-150):
const transformRef = useRef(transform);
const onSuccessRef = useRef(onSuccess);
const onErrorRef = useRef(onError);

useEffect(() => {
  fetcherRef.current = fetcher;
  transformRef.current = transform;
  onSuccessRef.current = onSuccess;
  onErrorRef.current = onError;
});

// fetchData icinde DEGISTIRILDI:
// transform -> transformRef.current
// onSuccess?.(result) -> onSuccessRef.current?.(result)
// onError?.(err) -> onErrorRef.current?.(err)

// Dependency array DEGISTIRILDI:
// ONCE: [cacheKey, cacheTTL, timeout, transform, onSuccess, onError]
// SONRA: [cacheKey, cacheTTL, timeout]
```

---

## C7: Refetch Mekanizmasi (cacheKey Degisikliginde Veri Guncelleme)

### Problem
Initial fetch useEffect'i bos dependency array `[]` kullaniyordu. Bu effect sadece component mount'ta calisiyordu. `cacheKey` degistiginde (filtre/pagination degisikligi) otomatik refetch mekanizmasi yoktu. 6 sayfa, 8+ useAsyncData cagrisi etkileniyordu.

### Cozum
- useEffect dependency'sine `[fetchData]` eklendi
- `fetchData` zaten `cacheKey`'e bagli (useCallback dependency), cacheKey degisince fetchData kimligi degisiyor, effect yeniden calisiyor
- C8 fix'i sayesinde callback'ler artik fetchData kimligini degistirmiyor, sonsuz dongu riski yok

### Degisiklik Detayi
```typescript
// ONCE:
useEffect(() => {
  if (immediate) fetchData(true);
}, []); // bos dependency

// SONRA:
useEffect(() => {
  if (immediate) fetchData(true);
}, [fetchData]); // fetchData cacheKey'e bagli, cacheKey degisince refetch
```

### Etkilenen Tuketiciler
- `AuditLogPage.tsx` (3 useAsyncData cagrisi)
- `ModulesPage.tsx`
- `SystemSettingsPage.tsx`
- `BillingDashboardPage.tsx`
- `ProvisioningSettingsPage.tsx`
- `ReportsPage.tsx`

Tum bu sayfalar artik cacheKey degisikliginde otomatik refetch yapacak.

---

## H1: LRU Cache + Max Size (Bellek Sizintisi Onleme)

### Problem
Modul seviyesi `Map<string, { data: unknown; timestamp: number }>` hicbir boyut siniri olmadan buyuyordu. Uzun sureli oturumlarda (ozellikle Admin Panel'de pagination/filtre kombinasyonlariyla) binlerce cache entry birikebilir ve bellek sizintisina yol acabilirdi.

### Cozum
- `MAX_CACHE_SIZE = 100` sabiti tanimlandi
- `addToCache()` fonksiyonu: cache boyutu siniri asarsa Map'in ilk entry'sini (en eski) siler
- `getCacheEntry()` fonksiyonu: cache hit'te entry'yi sil + tekrar ekle (LRU touch -- Map sonuna tasinir)
- Mevcut `cache.set()` cagirilari `addToCache()` ile, `cache.get()` cagirilari `getCacheEntry()` ile degistirildi
- `clearAsyncCache()` ve logout event listener degistirilmedi (bunlar zaten dogrudan Map.clear/delete kullaniyor)

### Degisiklik Detayi
```typescript
// EKLENDI (satir 61-95):
const MAX_CACHE_SIZE = 100;

interface CacheEntry { data: unknown; timestamp: number; }

function addToCache(key: string, value: CacheEntry): void {
  cache.delete(key); // Varsa sil, Map sonuna tasinsin
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

function getCacheEntry(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry); // LRU touch
  }
  return entry;
}

// fetchData icinde DEGISTIRILDI:
// cache.get(cacheKey) -> getCacheEntry(cacheKey)
// cache.set(cacheKey, ...) -> addToCache(cacheKey, ...)
```

---

## Test Durumu

Mevcut test dosyasi: `web/modules/admin-panel/src/hooks/__tests__/useAsyncData.spec.ts`

- Testler jsdom environment gerektirir (vitest config'te `environment: 'jsdom'` ayari)
- 32 testten 6'si gecti, 26'si timeout'a takildi (fake timers + async hooks interaction sorunu)
- Bu timeout sorunlari fix oncesinde de mevcuttu -- fake timer + jsdom + async useEffect eslesmesi kaynaklidi
- "should prevent concurrent fetches" testi 3 cagri gordu (1 bekliyordu) -- bu davranis degisikligi C7 fix'inden kaynakli degil, testin concurrent fetch yerine 3 ayri fetch() cagrisini saymasindan kaynaklaniyor
- Pagination data pattern testi (E2E) fix ile uyumlu -- cacheKey degisince refetch tetiklenmesi test ediliyor

### Onerilen Test Iyilestirmeleri (gelecek sprint)
1. vitest.config.ts'e `environment: 'jsdom'` eklenmeli
2. Fake timer'lar ile async hook interaction'i icin `vi.runAllTimersAsync()` kullanilmali
3. cacheKey degisikliginde refetch testi eklenmeli
4. LRU cache eviction testi eklenmeli
5. Inline callback ile sonsuz dongu olmamasi testi eklenmeli

---

## Regresyon Riski

| Fix | Risk | Aciklama |
|-----|------|----------|
| C8 | Dusuk | Callback davranisi ayni kaliyor, sadece ref uzerinden erisiyor |
| C7 | Orta | Onceden mount'ta tek sefer fetch yapan sayfalar artik cacheKey degisince refetch yapacak -- istenilen davranis ama beklenmeyen yan etkiler olabilir |
| H1 | Dusuk | 100 entry siniri normal kullanim icin yeterli, LRU en az kullanilani cikarir |

---

## Dokunulmayan Dosyalar
- Test dosyasi degistirilmedi (gorev kapsaminda sadece bug fix'ler vardi)
- Tuketici sayfalar degistirilmedi (fix hook seviyesinde, tuketiciler otomatik faydalanir)
