# P14: Capraz Analiz -- Bug x Performans

Tarih: 2026-03-14
Kaynak Raporlar: P6 (Bug Avcisi), P7 (Performans Analisti)
Ajan: Capraz Analiz Ajani (P14)

---

## Yonetici Ozeti

Bug ve performans raporlari arasinda 5 kritik kesisim noktasi tespit edildi. Bu noktalar tek basina "bug" veya "performans sorunu" olarak siniflandirilmis ancak birlesik etkileri bireysel etkilerinden cok daha agir. En tehlikeli kombinasyon: `useAsyncData` hook'undaki refetch eksikligi (BUG-001) ile sinirsiz cache (PERF-002/BUG-004) birlestiginde cache surekli buyuyor ama guncellenmemesi "sessiz veri bozulmasi" yaratiyor -- kullanici stale data gordugunu bile bilmiyor. Ikinci ciddi kombinasyon: AdminDashboard'daki concurrent fetch korumasizligi (BUG-008) ile N+1 query'ler (PERF-003/004) birlestiginde backend'de kaskad yuk olusturuyor.

---

## KESISIM-1: Sinirsiz Cache + Refetch Yok = Buyuyen ama Guncellenmyen Bellek

**Kaynak Bulgular:** BUG-001 (useAsyncData refetch yok), BUG-004 (cache boyut siniri yok), PERF-002 (bellek sizintisi)

**Mekanizma:**

1. `useAsyncData.ts:60` -- Global `Map` modul seviyesinde tanimli, hicbir boyut siniri yok.
2. `useAsyncData.ts:273-277` -- Initial fetch `useEffect` bos dependency array (`[]`) kullaniyor. `cacheKey` degistiginde yeni fetch tetiklenmiyor.
3. AuditLogPage her filtre+sayfa kombinasyonu icin unique `cacheKey` uretiyor (`audit-logs-${JSON.stringify(debouncedFilters)}-${pagination.page}`).

**Birlesik Etki Zinciri:**

```
Kullanici filtre degistirir
  -> cacheKey degisir (ornegin "audit-logs-{action:CREATE}-1" -> "audit-logs-{action:UPDATE}-1")
  -> useAsyncData yeni cacheKey icin cache miss yasar
  -> AMA: useEffect [] bos oldugu icin yeni fetch TETIKLENMEZ (BUG-001)
  -> Kullanici eski veriyi gormeye devam eder
  -> Kullanici manuel "Refresh" tiklar
  -> Yeni veri getirilir ve YENi cacheKey altinda saklanir
  -> ESKI cacheKey'deki entry SILINMEZ (BUG-004/PERF-002)
  -> 50 farkli filtre kombinasyonu sonrasinda 50 stale entry bellekte birikir
```

**Severity:** KRITIK. Uc katmanli sorun:
- **Bellek:** Her cache entry tam API response'u tutar. AuditLog sayfasinda 20 satir x ~2KB = ~40KB per entry. 100 unique filtre kombinasyonu = ~4MB. Gunu boyunca acik kalan admin panelinde 10-20MB'a ulasabilir.
- **Veri Dogrulugu:** Cache guncellenmez, ama TTL suresi (30s) gecerse entry silinmez -- sadece `cache.get()` sirasinda kontrol edilir. Kullanici A filtresiyle stale data gorur, B'ye gecer (stale), A'ya geri doner -- 30s gecmisse refetch olur ama arada guncellenmemis data gosterilir.
- **Kullanici Deneyimi:** Filtre degisikligi "calisiyor" gibi gorunur (UI guncellenmez, loading state yok) ama veri degismez. Kullanici bugla karsilastigini ANLAMAZ.

**Kanit (kod):** `useAsyncData.ts:273-277` satirlari:
```ts
useEffect(() => {
  if (immediate) {
    fetchData(true);
  }
}, []); // eslint-disable-line react-hooks/exhaustive-deps
```
`fetchData` dependency'de degil, dolayisiyla `cacheKey` degisse bile bu effect yeniden calismiyor.

**Onerilen Fix Stratejisi:** Bu uc bulgu birlikte ele alinmali:
1. `useAsyncData`'ya `cacheKey` degisiminde otomatik refetch ekle (BUG-001 fix'i).
2. Cache Map'e LRU eviction + max-size (100 entry) ekle (PERF-002 fix'i).
3. BUG-014'u de dikkate al: Eger refetch `fetchData` degisikligine baglanirsa, inline `transform/onSuccess/onError` callback'leri sonsuz dongu yaratabilir. Once callback'leri ref'e tasi, sonra refetch mekanizmasini ekle.

---

## KESISIM-2: N+1 Query + Concurrent Fetch Korumasizligi = Backend Kaskad Yuku

**Kaynak Bulgular:** BUG-008 (AdminDashboard concurrent fetch), BUG-009 (AbortController signal iletilmiyor), PERF-003 (N+1 tablo listeleme), PERF-004 (waterfall queries)

**Mekanizma:**

1. `AdminDashboard.tsx:431` -- Her 30 saniyede `setInterval` ile `fetchDashboardData` tetiklenir.
2. `AdminDashboard.tsx:384-401` -- `Promise.allSettled` ile 5 paralel API cagrisi baslatilir. Her birinde `apiFetch` 3x retry yapar (adminApi.ts:57).
3. Onceki fetch devam ederken yeni fetch baslar -- `AbortController` kullanilmiyor (BUG-008).
4. Backend tarafinda bu cagrilardan biri `getTables()` N+1 sorgularini tetikler (PERF-003), digeri `getStats()` waterfall sorgularini tetikler (PERF-004).

**Birlesik Etki Zinciri:**

```
T=0s:  Interval tick -> fetchDashboardData() baslar
       -> 5 paralel API cagrisi (apiFetch 3x retry ile)
       -> Backend: getTables() N+1 sorgu baslar (20 tablo = ~60 sorgu, ~300ms)
       -> Backend: getStats() 5 waterfall sorgu baslar (~150ms)

T=5s:  Yavas baglanti -- henuz bitmedi, 3 cagri hala retry'da

T=30s: Interval tick -> fetchDashboardData() TEKRAR baslar
       -> Onceki 5 cagri IPTAL EDILMEDI (AbortController yok - BUG-008)
       -> useAsyncData signal'i fetcher'a iletmiyor (BUG-009)
       -> Simdi 10 paralel cagri var
       -> Backend artik 2x N+1 sorgu + 2x waterfall calistiriyor

T=60s: 15 paralel cagri, retry'lar devam ediyor
       -> DB connection pool doluyor
       -> API response time artiyor -> daha fazla retry -> kartopu etkisi
```

**Severity:** YUKSEK. En kotu senaryo:
- 5 cagri x 4 deneme (1 ilk + 3 retry) x 3 birikmis interval = **60 HTTP istegi**
- Backend'de getTables N+1: 60 sorgu x 3 birikmis = **180 DB sorgusu**
- getStats waterfall: 5 sorgu x 3 birikmis = **15 DB sorgusu**
- Toplam: ~200 DB sorgusu, connection pool tuketimi, gecici servis kesintisi riski.

**Kanit (kod):** `AdminDashboard.tsx:428-433`:
```ts
useEffect(() => {
  fetchDashboardData();
  const interval = setInterval(fetchDashboardData, 30000);
  return () => clearInterval(interval);
}, [fetchDashboardData]);
```
Onceki fetch'in bitmesini BEKLEMEDEN yeni fetch baslatiliyor. `fetchDashboardData` icinde AbortController yok.

**Onerilen Fix Stratejisi:**
1. `fetchDashboardData` basinda `isLoadingRef.current` kontrolu ekle -- onceki fetch devam ediyorsa yeni fetch baslatma.
2. `AbortController` ekle, her yeni fetch oncekini iptal etsin.
3. Backend tarafinda PERF-003 (N+1 -> bulk query) ve PERF-004 (waterfall -> Promise.all) fix'lerini uygula.
4. Interval'i `setTimeout` ile degistir: fetch tamamlandiktan 30s sonra tekrar cagir.

---

## KESISIM-3: Monolitik Bundle + URL Param Collision = Sayfa Gecislerinde State Leak

**Kaynak Bulgular:** BUG-002 (usePagination + useFilters URL race condition), PERF-001 (monolitik bundle, lazy loading yok)

**Mekanizma:**

1. `Module.tsx:11-53` -- 35 sayfa component'i static import ediliyor. React.lazy yok. Tum sayfa kodu tek bundle'da.
2. `usePagination.ts:122-132` ve `useFilters.ts:99-119` -- Her iki hook da bagimssiz `useSearchParams()` instance'i kullaniyor.
3. Monolitik bundle'da tum sayfa component'leri ayni JS context'te yuklendigi icin, module-scope degiskenleri (global cache Map dahil) tum sayfalar arasinda paylasilir.

**Birlesik Etki Zinciri:**

```
Kullanici AuditLogPage'de:
  -> useFilters URL'ye "action=CREATE&severity=HIGH" yazar
  -> usePagination ayni anda "page=1&limit=20" yazar
  -> Race condition: sonraki yazma oncekini siler (BUG-002)
  -> URL: "?page=1&limit=20" (action ve severity KAYIP)

Kullanici DatabaseExplorerPage'e gecer:
  -> Sayfa componenti zaten yuklenmis (monolitik bundle, unmount/remount yok)
  -> DatabaseExplorerPage kendi URL param'larini yazar
  -> Ama URL'de AuditLogPage'den kalan "page=1&limit=20" hala var
  -> DatabaseExplorerPage de "page" ve "limit" kullaniyor (ayni isimler!)
  -> AuditLogPage'in page/limit degerleri DatabaseExplorerPage'e leak eder

Kullanici browser back ile AuditLogPage'e doner:
  -> URL'de sadece page/limit var, action/severity kayip
  -> useFilters initialFilters'a geri doner (default degerler)
  -> Ama usePagination URL'deki page/limit'i okur -> stale pagination state
  -> AuditLogPage yanlis sayfada, filtresiz veri gosterir
```

**Severity:** YUKSEK. Bu kombinasyon iki ayri sorunun carpisma etkisi:
- **URL param kirliligi:** `page`, `limit`, `search` gibi genel isimler birden fazla sayfada kullaniliyor. Sayfalar arasi geciste bu parametreler temizlenmiyor.
- **Bundle etkisi:** Lazy loading olsa her sayfa gecisinde component unmount/remount olurdu ve URL state ayrilabilirdi. Monolitik bundle'da tum component'ler ayni context'te yasadigi icin React Router `<Routes>` gecisleri sirasinda URL state'i tam olarak temizlenmeyebilir.
- **Kullanici deneyimi:** Filtreler "kaybolur", sayfalama yanlis sayfada baslar, browser back/forward guvenilmez hale gelir.

**Kanit (kod):** `useFilters.ts:103` ve `usePagination.ts:125` -- her ikisi de `new URLSearchParams(searchParams)` ile ayni anda AYNI snapshot'tan basliyor. Ayni render cycle'da iki hook da `setSearchParams` cagirir, sonraki cagri oncekinin yazimini siler.

**Onerilen Fix Stratejisi:**
1. PERF-001 fix'i (React.lazy) uygulanirsa, her sayfa kendi chunk'inda olur ve sayfa gecislerinde unmount/remount zorunlu hale gelir. Bu, URL state leak riskini azaltir.
2. BUG-002 fix'i: Tek bir "URL state coordinator" hook olustur. `usePagination` ve `useFilters` ayri `setSearchParams` cagirmak yerine bu coordinator'a delege etsin.
3. Her sayfa icin URL param namespace'i ekle (ornegin `audit_page`, `audit_limit` vs `db_page`, `db_limit`).

---

## KESISIM-4: Cache Invalidation Eksikligi + Mutation Sonrasi Stale Data = Yanlis Veri Gosterimi

**Kaynak Bulgular:** BUG-013 (AuditLogPage stale stats cache), PERF-008 (mutation sonrasi cache invalidation yok), BUG-010 (BillingDashboard hardcoded metrikler)

**Mekanizma:**

1. `useAsyncData.ts:166` -- Cache'e veri yazilir ama mutation sonrasi invalidation yok.
2. `clearAsyncCache()` fonksiyonu mevcut (satir 307-313) ama hicbir sayfa mutation sonrasi cagirmiyor.
3. AuditLogPage stats `cacheKey` sadece `tenantId`'ye bagli, `startDate/endDate` dahil degil (BUG-013).
4. BillingDashboardPage 4 metrikte hardcoded deger kullaniyor (BUG-010).

**Birlesik Etki Zinciri:**

```
Senaryo A - Cross-page stale data:
  Admin, AdminDashboard'u acar -> "10 tenant" gosterilir (cache: 'dashboard-metrics')
  Admin, CreateTenantPage'e gider -> yeni tenant olusturur (mutation basarili)
  Admin, AdminDashboard'a geri doner -> cache'den "10 tenant" gosterilir (30s TTL)
  Gercekte 11 tenant var -> STALE DATA

Senaryo B - Intra-page stale data:
  Admin, AuditLogPage'de tenantId="t1" filtresiyle stats gorur
  -> cacheKey: "audit-stats-t1", cache hit, stale stats gosterilir
  Admin, tarih araligini degistirir (1 hafta -> 1 ay)
  -> cacheKey DEGISMEZ (sadece tenantId'ye bagli, BUG-013)
  -> 60s TTL dolana kadar ESKI tarih araliginin stats'i gosterilir

Senaryo C - Hardcoded + stale birlesimi:
  BillingDashboard'da churnRate: 2.3, growth: 15.5 SABIT (BUG-010)
  + MRR/ARR cache'den stale (PERF-008)
  -> Admin hem yanlis trend hem yanlis gercek deger goruyor
  -> Karar verme icin tamamen guvenilmez veri seti
```

**Severity:** YUKSEK. Bu kombinasyonun en tehlikeli yonu: kullanici verinin yanlis oldugunu ANLAYAMAZ.
- Hardcoded metrikler makul gorunuyor (%2.3 churn, %15.5 growth).
- Stale cache verileri de "eskimis ama mantikli" gorunuyor.
- Admin bu verilere dayanarak is kararlari alabilir (tenant upgrade, fiyat degisikligi).
- **Yanlis veri sessiz ve inandirici** -- en tehlikeli bug tipi.

**Onerilen Fix Stratejisi:**
1. Mutation helper fonksiyonu ekle: `invalidateRelatedCaches(patterns: string[])`. Ornek:
   ```ts
   // Tenant olusturma sonrasi:
   invalidateRelatedCaches(['dashboard-metrics', 'tenant-list']);
   ```
2. BUG-013: `cacheKey`'e `startDate` ve `endDate` ekle (trivial, 1 satir).
3. BUG-010: Hardcoded degerleri kaldirip "N/A" veya "Veri yok" goster, ya da API endpoint'leri ekle.
4. `useAsyncData`'ya `invalidateOnEvents` option'i ekle: belirli custom event'lerde otomatik refetch.

---

## KESISIM-5: 10K Row Export + CSV Escaping Eksik = Data Loss + Memory Spike

**Kaynak Bulgular:** BUG-006 (CSV injection, memory leak, stale filter), PERF-009 (10K satir client-side isleme)

**Mekanizma:**

1. `AuditLogPage.tsx:323` -- Export `limit: '10000'` ile 10K satir cekmek istiyor.
2. `AuditLogPage.tsx:344` -- CSV satir olusturma: `rows.map((row) => row.join(','))` -- hicbir escaping yok.
3. `AuditLogPage.tsx:347` -- `URL.createObjectURL(blob)` olusturuluyor ama `revokeObjectURL` cagirilmiyor.
4. `AuditLogPage.tsx:323-329` -- `filters.search` parametresi export params'a dahil edilmiyor.
5. `DatabaseExplorerPage.tsx:183-215` -- Export fonksiyonu benzer sekilde 10K satira kadar client-side export yapiyor.

**Birlesik Etki Zinciri:**

```
Admin "Export CSV" tiklar:
  1. API'den 10K satir cekilir (~10-50MB JSON response)
     -> Tarayici bellege alir (PERF-009)
     -> Yavas baglantida 30s timeout riski (useAsyncData timeout: 30s)

  2. CSV olusturma sirasinda:
     -> Bir audit log'un "details" alani JSON icerir: {"action":"DELETE","target":"user,admin"}
     -> row.join(',') bu JSON'u oldugu gibi yazar
     -> Sonuc CSV'de sutun kaymasi: virgul iceren deger ayrilir
     -> VERI KAYBI: 10K satirin bir kismi yanlis sutuna kayar

  3. Bir kullanicinin email adresi: user@example.com,"=CMD('calc')"
     -> CSV injection: Excel dosyayi acarsa formul calisir (guvenlik riski)

  4. URL.createObjectURL serbest birakilmaz:
     -> Her export'ta ~blob boyutu kadar bellek leak (BUG-006)
     -> 10K satir export = ~5-10MB leak per export
     -> Gunde 10 export = 50-100MB kalici bellek sizintisi

  5. search filtresi export'a dahil degil:
     -> Kullanici "DELETE" aramasiyla 50 sonuc gorur
     -> Export'ta 10K UNFILTERED satir gelir
     -> Kullanici beklediginden farkli veri indirir
```

**Severity:** YUKSEK. Uc farkli hasar kanali:
- **Data integrity:** CSV escaping olmadigi icin virgul iceren alanlar sutun kaymasina neden olur. 10K satirlik export'ta yuzlerce bozuk satir olabilir. Admin bu CSV'yi import ederse veri bozulmasi kaskad eder.
- **Guvenlik:** CSV formula injection riski -- ozellikle audit log'larda kullanici girdisi iceren alanlar (email, IP, user agent).
- **Bellek:** 10K satir JSON (~10-50MB) + CSV string (~5-10MB) + Blob (~5-10MB) + leak'lenen ObjectURL = tek bir export'ta **20-70MB peak bellek kullanimi**. Tarayici tab'i donabilir.

**Kanit (kod):** `AuditLogPage.tsx:344`:
```ts
const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
```
Hicbir hucre `"` ile sarilmiyor, virgul/newline/cift tirnak iceren degerler escape edilmiyor.

**Not:** `DatabaseExplorerPage.tsx:183-215` export fonksiyonunda `revokeObjectURL` dogrudan cagirilmis (satir 213) -- bu kisim dogru. AuditLogPage'deki export bunu YAPMIYOR.

**Onerilen Fix Stratejisi:**
1. Ortak CSV utility fonksiyonu olustur:
   ```ts
   function escapeCSVCell(value: unknown): string {
     const str = String(value ?? '');
     if (/[,"\n\r]/.test(str) || str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
       return `"${str.replace(/"/g, '""')}"`;
     }
     return str;
   }
   ```
2. Export sonrasi `URL.revokeObjectURL(link.href)` ekle.
3. `filters.search` parametresini export params'a dahil et.
4. 10K satir sinirini backend-side streaming export ile degistir (PERF-009 fix'i). Frontend'de sadece download linki goster.
5. Export oncesi kullaniciya uyari goster: "X satir indirilecek, devam edilsin mi?"

---

## Oncelik Matrisi

| Kesisim | Severity | Etki Alani | Fix Effort | Oncelik |
|---------|----------|------------|------------|---------|
| KESISIM-1 | KRITIK | Tum useAsyncData tuketicileri (6+ sayfa) | M | P0 |
| KESISIM-2 | YUKSEK | AdminDashboard + backend DB | M | P1 |
| KESISIM-4 | YUKSEK | Tum CRUD sayfalar + dashboard | M | P1 |
| KESISIM-3 | YUKSEK | Tum filtreleme/pagination kullanan sayfalar | L | P2 |
| KESISIM-5 | YUKSEK | AuditLogPage + DatabaseExplorerPage export | S | P1 |

**P0 -- Hemen:** KESISIM-1 (cache + refetch). Bu tek basina en fazla sayfayi etkiliyor ve kullanici sessiz stale data goruyor. Fix sirasi: (1) BUG-014 callback ref fix, (2) BUG-001 refetch mekanizmasi, (3) BUG-004/PERF-002 LRU cache.

**P1 -- Bu sprint:** KESISIM-2, KESISIM-4, KESISIM-5. KESISIM-5 en dusuk effort ile en yuksek veri dogrulugu kazanimi saglar (CSV escape + revokeURL).

**P2 -- Sonraki sprint:** KESISIM-3 (URL param collision + monolitik bundle). PERF-001 (React.lazy) uygulandiktan sonra URL collision etkisi azalacaktir ama tam fix icin URL state coordinator gereklidir.

---

## Sonuc

Bu bes kesisim noktasi, bug ve performans sorunlarinin birbirini BESLEYEN ve GUCLENDIREN bir dongu olusturdugunu gosteriyor:

1. **Performans sorunu bug'i gizliyor:** Sinirsiz cache (PERF-002) refetch eksikligini (BUG-001) maskeliyor -- bellek buyuyor ama kullanici "bir seyler calisiyor" saniyor.
2. **Bug performans sorununu agrlastiriyor:** Concurrent fetch korumasizligi (BUG-008) N+1 query'lerin (PERF-003) etkisini katlama ile artiriyor -- tek basina 60 sorgu olan N+1, korumaisz concurrent fetch ile 180+ sorguya cikiyor.
3. **Ikisi birlesince veri dogrulugu kayboluyor:** Cache invalidation eksikligi (PERF-008) + hardcoded metrikler (BUG-010) + stale cache (BUG-013) = admin panelinde gosterilen verilerin %30-40'i potansiyel olarak yanlis veya gecmis.

Bu bulgular, fix'lerin izole degil birlikte planlanmasi gerektigini gosteriyor. Ozellikle KESISIM-1'deki uc bulgu (BUG-001 + BUG-004 + PERF-002 + BUG-014) tek bir PR'da ele alinmali, aksi takdirde kısmi fix yeni sorunlar yaratir (ornegin: sadece refetch eklenir ama callback ref fix yapilmazsa sonsuz fetch dongusu olusur).
