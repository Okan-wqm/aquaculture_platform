# P13: Capraz Analiz -- Guvenlik x Mimari

**Tarih:** 2026-03-14
**Kapsam:** Admin Panel backend + frontend guvenlik bulgularinin mimari kararlarla kesisim analizi
**Girdi:** P5 (Guvenlik), P8 (Mimari), P2 (Backend Haritaci)

---

## Yonetici Ozeti

Mimari kararlar ile guvenlik posturu arasinda 7 kritik kesisim noktasi tespit edilmistir. En ciddi sorun **mimari tek noktalilik ile guvenlik tek noktaliliginin ust uste binmesidir**: adminApi.ts god-file'i (3116 satir, 15 domain) frontend'te guvenlik tutarliligi bozarken, backend'te global APP_GUARD tek savunma hatti olarak kaliyor. Bu iki mimari karar birlikte ele alindiginda, tek bir hata veya degisikligin sistematik guvenlik cokusune yol acabilecegi gorulmektedir.

Onem sirasi: (1) CRUD endpoint'lerinin ortam kontrolsuz olmasi (mimari: guard tutarsizligi x guvenlik: NODE_ENV boslugu), (2) DebugTools domain karisiminin guvenlik yuzeyini genisletmesi, (3) 4 fetch pattern'inin guvenlik davranisini parcalamasi.

---

## Bulgu XA-1: adminApi.ts God File -- Guvenlik Yuzey Buyuteci

**Kesisim:** P8/ARCH-001 (SRP ihlali) x P5/MEDIUM-006 (CSRF) x P5/HIGH-002 (includeSensitive)
**Ciddiyet:** HIGH

### Mimari Gercek

`adminApi.ts` tek dosyada 3 sorumluluk tasiyor: HTTP altyapisi (retry, auth, envelope unwrap), ~90 tip tanimi ve 15 domain API nesnesi. Bu 3116 satirlik dosya tum endpoint cagrilerinin merkezi gecis noktasi.

### Guvenlik Sonuclari

1. **Blast radius:** `apiFetch` fonksiyonundaki (satir 50-131) herhangi bir hata -- ornegin `getAuthHeader()` fonksiyonunda bir regression -- tum 200+ endpoint cagrisini etkiler. Auth header'i gondermemeye baslayan bir degisiklik, tum isteklerin 401 almasi yerine (eger backend cookie-based fallback eklerse) kimlik dogrulamasiz gecmesine yol acabilir.

2. **Guvenlik konfigurasyonu dagitilamamasi:** `credentials: 'include'` (satir 61) ve retry (satir 57, 3 deneme) tum endpoint'lere uygulanir. Ancak hassas endpoint'ler (raw SQL, CRUD, impersonation) icin retry yapilmasi istenmeyen bir davranistir -- basarisiz bir DELETE retry edilmemelidir. Tek dosyada per-endpoint guvenlik politikasi uygulanamaz.

3. **Merge conflict guvenlik riski:** 15 domain API'nin tek dosyada olmasi, paralel gelistirmede merge conflict olasiligini arttirir. Merge sirasinda yapilan bir hata (ornegin `includeSensitive` parametresinin yanlis bir endpoint'e tasinmasi) review'dan kacabilir.

### Kanit

```
adminApi.ts:59-61 -- credentials: 'include' GLOBAL
adminApi.ts:57 -- retry GLOBAL (hassas endpoint'ler dahil)
adminApi.ts:34-37 -- getAuthHeader tek nokta
```

### Onerilen Yaklasim

ARCH-001 dekompoze edilirken guvenlik katmanlari eklenmeli:
- `http-client.ts` icinde endpoint-tipine gore retry politikasi (read-only: retry, mutating: no-retry)
- Domain API modulleri olusturulurken hassas endpoint'ler (database/, debug/, impersonation/) icin ayri guvenlik wrapper'i
- `credentials` ayarinin endpoint bazli override edilebilmesi

---

## Bulgu XA-2: Global APP_GUARD Tek Nokta Hatasi -- Defense-in-Depth Eksikligi

**Kesisim:** P8/ARCH-009 (guard tutarsizligi) x P5/CRITICAL-003 (NODE_ENV tek savunma) x P2/Bulgu-7
**Ciddiyet:** CRITICAL

### Mimari Gercek

`PlatformAdminGuard` `APP_GUARD` olarak `app.module.ts:125-127`'de kayitli. 33 controller'dan:
- **15 controller** ek olarak `@UseGuards(PlatformAdminGuard)` kullaniyor (redundant ama defensive)
- **18 controller** yalnizca global guard'a guveniyor (implicit)
- **7 endpoint** `@Public()` ile bypass ediyor

### Guvenlik Sonuclari

1. **Kaldirilma senaryosu:** Global guard satiri silinirse veya comment'e alinirsa, implicit olan 18 controller aninda korumasiz kalir. Bu 18 controller arasinda:
   - `DebugToolsController` (30+ endpoint, raw debug islemleri)
   - `SecurityMonitoringController` (17 endpoint, guvenlik olaylari)
   - `IpAccessController` (11 endpoint, IP whitelist/blacklist)
   - `JobQueueController` (18 endpoint, is kuyrugu yonetimi)
   - `TenantConfigurationController` (30+ endpoint, tenant ayarlari)

2. **Degistirilme senaryosu:** Guard logigindeki bir degisiklik (ornegin role mapping hatasi) tum 200+ endpoint'i etkiler. Explicit guard'li 15 controller icin en azindan ikinci bir guard katmani vardir (TypeORM duplicate guard olsa da davranis aynidir). Implicit 18 controller icin tek katman vardir.

3. **Test kapsamliligi:** `guards/__tests__/platform-admin.guard.spec.ts` guard'in kendi unit test'lerini icerir ancak "global guard kaldirilirsa hangi controller'lar acik kalir" integration testi yoktur.

### Kanit

```typescript
// app.module.ts:125-127 -- Tek satir kaldirilirsa 18 controller acik kalir
{
  provide: APP_GUARD,
  useClass: PlatformAdminGuard,
}
```

### Onerilen Yaklasim

**Defense-in-depth standardizasyonu:** Tum 33 controller'a explicit `@UseGuards(PlatformAdminGuard)` eklenmeli. Global guard korunmali (ikinci katman), ancak her controller kendi guard'ina da sahip olmali. Bu, herhangi bir katmanin kaldirilmasi durumunda diger katmanin koruma saglamasini garantiler.

Ek olarak: "no-unguarded-controller" lint kurali eklenmeli -- yeni controller olusturulurken explicit guard eksikligini build-time'da yakalasin.

---

## Bulgu XA-3: 18 Implicit Controller -- Somut Saldiri Senaryosu

**Kesisim:** P2/Guard Analizi x P5/CRITICAL-003 x P8/ARCH-009
**Ciddiyet:** HIGH

### Analiz

Global guard'a guvenen 18 controller'in risk profili esit degildir. Asagida "guard kaldirilirsa etki" siralamasiyla:

| Risk | Controller | Endpoint Sayisi | Acik Kalirsa Etki |
|------|-----------|----------------|------------------|
| CRITICAL | DebugToolsController | 30+ | Debug session, feature flag override, cache snapshot -- tam sistem ici gorus |
| CRITICAL | IpAccessController | 11 | IP whitelist/blacklist manipulasyonu -- erisim kontrolu bypass |
| CRITICAL | TenantConfigurationController | 30+ | API key olusturma, tenant limitleri degistirme |
| HIGH | SecurityMonitoringController | 17 | Guvenlik olayi/incident olusturma/guncelleme -- audit trail manipulasyonu |
| HIGH | GlobalSettingsController | 25+ | Sistem konfigurasyonu, provisioning-config (1 endpoint zaten @Public) |
| HIGH | JobQueueController | 18 | Is kuyrugu yonetimi, cron job tetikleme |
| HIGH | ErrorTrackingController | 18 | Hata gruplari manipulasyonu, alert sessizlestirme |
| MEDIUM | ComplianceController | 13 | GDPR/CCPA veri talepleri, compliance rapor |
| MEDIUM | AuditTrailController | 13 | Audit trail sorgulama, retention politikasi |
| MEDIUM | Diger 9 controller | ~95 | Destek, mesajlasma, performans izleme |

Bu tablo, global guard'in tek basina yeterli olmadigini, ozellikle CRITICAL risk grubundaki 3 controller icin explicit guard'in zorunlu oldugunu gostermektedir.

---

## Bulgu XA-4: ImpersonationModule Icinde DebugToolsController -- Domain Karisimi Guvenlik Riski

**Kesisim:** P8/ARCH-004 (domain kohezyon ihlali) x P5/HIGH-001 (client-supplied adminId) x P5/MEDIUM-005 (prototype pollution)
**Ciddiyet:** HIGH

### Mimari Gercek

`ImpersonationModule` tek moduldde 2 farkli bounded context tasiyor:
- Impersonation: 2 entity, 1 service, 1 controller -- production'da aktif
- Debug Tools: 5 entity, 6 service, 1 controller -- production'da controller devre disi

### Guvenlik Sonuclari

1. **Entity/Service yuklenmesi:** Production'da `DebugToolsController` devre disi birakilmis (impersonation.module.ts:30-31), ancak **tum debug entity'leri ve service'leri** hala yukleniyor (satir 41-51, 54-63). Bu demektir ki:
   - `DebugSession`, `CapturedQuery`, `CapturedApiCall`, `CacheEntrySnapshot`, `FeatureFlagOverride` tablolari TypeORM ile sync ediliyor
   - 6 debug service production memory'de yasyor
   - Baska bir kod parcasi (ornegin middleware, interceptor) bu service'leri inject edebilir

2. **NODE_ENV bypass riski:** Controller devre disi birakma `process.env['NODE_ENV'] === 'production'` kontrolune dayanir (satir 27). Bu, P5/CRITICAL-003'teki ayni tek savunma hatti sorununu tekrarlar. NODE_ENV set edilmezse DebugToolsController production'da aktif olur.

3. **Guvenlik bulgulari tasma riski:** DebugToolsController'daki `@Query('adminId')` sorunu (P5/HIGH-001) ve `JSON.parse(defaultValue)` prototype pollution riski (P5/MEDIUM-005), ImpersonationModule'un "production guvenli" algisini zedeler. Bir gelistirici ImpersonationModule'u guvenli kabul edip code review'da dikkatini azaltabilir.

### Onerilen Yaklasim

`DebugToolsModule` tamamen ayri modul olarak cikarilmali. Production'da `app.module.ts`'den import edilmemeli (conditionally import ile degil, tamamen cikarilmali). Entity ve service'ler debug modulu ile birlikte tasimali.

---

## Bulgu XA-5: Error Handling Stratejisi -- Bilgi Sizintisi Analizi

**Kesisim:** P8 (mimari kalitesi) x P5 (guvenlik posturu)
**Ciddiyet:** MEDIUM

### Mevcut Durum

`GlobalExceptionFilter` (filters/global-exception.filter.ts) 3 katmanli hata yonetimi uyguliyor:

| Hata Tipi | Development | Production |
|-----------|-------------|------------|
| HttpException | Tam mesaj + details | Tam mesaj + details |
| QueryFailedError (bilinen kodlar: 23505, 23503, 23502) | Genel mesaj, detay yok | Genel mesaj, detay yok |
| QueryFailedError (bilinmeyen) | `Database operation failed: {exception.message}` | `Database operation failed` |
| Generic Error | `{exception.message}` | `An unexpected error occurred` |
| Unknown | `An unexpected error occurred` | `An unexpected error occurred` |

### Guvenlik Degerlendirmesi

**Olumlu noktalar:**
- Production'da generic/unknown hatalar icin mesaj gizleniyor (satir 167-168)
- Unique constraint hatasinda conflicting deger gosterilmiyor (satir 106-108, "LOW-006 fix" yorumu)
- `ValidationPipe` production'da `disableErrorMessages: true` (main.ts:109) -- validation hatalari detaysiz

**Sorunlu noktalar:**
1. **HttpException mesajlari filtresiz:** `BadRequestException('Query contains disallowed statements')` gibi mesajlar production'da da aynen dondurulur. Bu, saldirganin SQL filtreleme mekanizmasini reverse-engineer etmesine yardimci olur -- hangi keyword'lerin bloke edildigini mesajlardan cikarabilir.

2. **Development/production geciS noktasi:** `process.env['NODE_ENV'] === 'development'` (satir 152) ve `process.env['NODE_ENV'] === 'production'` (satir 167) farkli kontroller -- NODE_ENV 'staging' ise her iki kontrol de false olur ve development davranisi gorulur (cunku `!== 'production'` kosulu saglanir). Staging'de gercek veriler ile calisiliyorsa bu bilgi sizintisi riski olusturur.

3. **Stack trace loglama:** 500 hatalarinda stack trace sunucu loglarinda gorunur (satir 39-44) -- bu dogru. Ancak response'da stack trace gonderilmiyor -- bu da dogru.

### Onerilen Yaklasim

- HttpException mesajlarini da production'da genellestir veya en azindan SQL/DB ile ilgili olanlari filtrele
- `NODE_ENV` kontrollerini normallestir: `isProduction` flag'i kullan, 'staging' davranisini explicit tanimla

---

## Bulgu XA-6: NODE_ENV Korumasindaki Endpoint'ler -- Production'a Kacma Analizi

**Kesisim:** P5/CRITICAL-003 x P8/ARCH-004
**Ciddiyet:** CRITICAL

### NODE_ENV'e Bagli Guvenlik Kararlari Envanteri

| Konum | NODE_ENV Kontrolu | Koruma | Kacma Riski |
|-------|-------------------|--------|-------------|
| explorer.controller.ts:767 | `=== 'production'` | Raw SQL endpoint bloke | NODE_ENV bos = ACIK |
| impersonation.module.ts:27 | `=== 'production'` | DebugToolsController devre disi | NODE_ENV bos = AKTIF |
| main.ts:24 | `=== 'production'` | Helmet CSP, HSTS | NODE_ENV bos = gevsetilmis |
| main.ts:71 | `!corsOriginsEnv && isProduction` | CORS origin zorunlulugu | NODE_ENV bos = varsayilan dev origin'ler |
| main.ts:109 | `isProduction` | Validation hata mesajlari gizleme | NODE_ENV bos = detayli hata |
| main.ts:128 | `!isProduction` | Swagger docs | NODE_ENV bos = aktif |
| app.module.ts:43 | `=== 'production'` | DB password zorunlulugu | NODE_ENV bos = sifresiz baglanti |
| app.module.ts:59 | `=== 'development'` | TypeORM SQL loglama | NODE_ENV bos = loglama kapali |
| global-exception.filter.ts:152 | `=== 'development'` | DB hata detayi | NODE_ENV bos = genel mesaj |
| global-exception.filter.ts:167 | `=== 'production'` | Generic hata gizleme | NODE_ENV bos = detayli mesaj |
| guard:43-44 | `=== 'production'` | JWT_SECRET zorunlulugu | NODE_ENV bos = dev secret |

### Kacma Senaryolari

**Senaryo 1 -- Docker ortam degiskeni unutma:**
```yaml
# docker-compose.prod.yml -- NODE_ENV satiri atlanirsa:
services:
  admin-api:
    image: ghcr.io/.../admin-api-service:latest
    # environment:
    #   NODE_ENV: production  <-- UNUTULMUS
```
Sonuc: Raw SQL endpoint acik, DebugToolsController aktif, Swagger acik, JWT auto-generated, CORS gevsetilmis, DB password gerekmez.

**Senaryo 2 -- Staging gercek veri:**
Staging ortaminda NODE_ENV=staging set edilmisse, `=== 'production'` kontrolleri false doner. Staging gercek musterilerin verileri ile calisiyorsa, raw SQL endpoint'i ve DebugToolsController gercek verilere erisim saglar.

### Onerilen Yaklasim

1. **Fail-closed yaklasim:** `NODE_ENV !== 'development'` kontrolu kullanilmali (production'u acikca kontrol etmek yerine development'i acikca kontrol et)
2. **Explicit feature flag'ler:** `ENABLE_RAW_SQL=true`, `ENABLE_DEBUG_TOOLS=true` -- varsayilan false
3. **Startup dogrulama:** Production'da kritik env var eksikliginde uygulama baslatilmamali (DB password icin mevcut, diger guvenlik ayarlari icin eksik)

---

## Bulgu XA-7: 4 Frontend Fetch Pattern -- Guvenlik Tutarliligi Analizi

**Kesisim:** P8/ARCH-002 (katman bypass) x P8/ARCH-006 (data fetch tutarsizligi) x P5/MEDIUM-006 (CSRF)
**Ciddiyet:** MEDIUM

### Pattern Matrisi

| Pattern | Sayfalar | Auth | Retry | Envelope Unwrap | Error Detail | Request ID |
|---------|----------|------|-------|----------------|-------------|------------|
| A: adminApi.apiFetch | 20 sayfa | Bearer (merkezi) | 3x exponential | Otomatik | Zengin (status, code, details) | Var |
| B: adminApi + useAsyncData | 5 sayfa | Bearer (merkezi) | 3x + hook-level | Otomatik | Zengin + loading/error state | Var |
| C: adminApi + dogrudan fetch (karisik) | 5 sayfa | Bearer (merkezi + lokal) | Kismi | Kismi | Karisik | Kismi |
| D: Dogrudan fetch (bypass) | 2 sayfa | Bearer (lokal kopya) | Yok | Manuel | Minimal | Yok |

### Guvenlik Sonuclari

1. **Auth token yonetimi dagilmasi:** Pattern D'de `DatabaseExplorerPage` (satir 65-68) ve `ReportsPage` (satir 21-39) kendi `getAuthHeader()` kopyalarini tanimliyor. Token yenileme veya rotation mekanizmasi eklendikce, bu kopyalar guncellenmeyi kacirabilir. Ozellikle DatabaseExplorerPage'in CRUD endpoint'leri (INSERT/UPDATE/DELETE) bu lokal auth ile calisiyor.

2. **Retry davranisi farki:** adminApi 5xx hatalarinda 3 kez retry yapar. Dogrudan fetch retry yapmaz. Guvenlik acisindan: adminApi uzerinden bir DELETE istegi 5xx alirsa 3 kez denenir (istenmeyen). Dogrudan fetch uzerinden ise denenmez. Her iki davranis da sorunlu ama farkli yonlerde.

3. **Hata bilgisi farki:** adminApi hata durumunda `errorBody.message`, `errorBody.code`, `errorBody.details` alanlarini parse eder ve kullaniciya gosterir. Dogrudan fetch ise raw JSON dondurur. Eger backend development modunda calisiyorsa, dogrudan fetch kullaniciya DB hata detaylarini gosterebilir (cunku envelope unwrap yapilmaz ve raw error response gosterilir).

4. **Envelope beklentisi uyumsuzlugu:** `AuditTrailPage` dogrudan fetch ile `/api/security/audit/summary` cagiriyor (satir 161-172) ve `response.json()` donderiyor. Backend `ResponseInterceptor` envelope sariyorsa (success/data), sayfa `{success: true, data: {...}}` alir ve bunu dogrudan render etmeye calisir. Bu islevsel bir hatanin yani sira, kullaniciya backend envelope yapisinin gosterilmesi bilgi sizintisi olusturur.

### Onerilen Yaklasim

Tum sayfalarin adminApi uzerinden calismasi saglanmali (P8/ARCH-002 fix'i). Ek olarak:
- `apiFetch`'e `mutating: boolean` parametresi eklenip, mutating isteklerde retry devre disi birakilmali
- Dogrudan fetch kullanan 7 sayfanin adminApi'ye tasinmasi sirasinda, eksik endpoint'ler eklenmeli

---

## Onceliklendirilmis Aksiyon Plani

### Acil (Bu Sprint)

| # | Aksiyon | Ilgili Bulgular | Effort |
|---|---------|----------------|--------|
| 1 | CRUD endpoint'lerine NODE_ENV kontrolu ekle | XA-6, P5/HIGH-005 | S |
| 2 | DebugToolsModule'u ayri module cikar, production'da import etme | XA-4, P8/ARCH-004 | S |
| 3 | 18 implicit controller'a explicit @UseGuards ekle | XA-2, XA-3 | S |
| 4 | NODE_ENV kontrollerini fail-closed'a cevir (development kontrolu) | XA-6 | S |

### Kisa Vade (Sonraki Sprint)

| # | Aksiyon | Ilgili Bulgular | Effort |
|---|---------|----------------|--------|
| 5 | adminApi.ts dekompoze: http-client + domain API'ler | XA-1, P8/ARCH-001 | M |
| 6 | Mutating endpoint'lerde retry devre disi birak | XA-1, XA-7 | S |
| 7 | Dogrudan fetch kullanan 7 sayfayi adminApi'ye tasi | XA-7, P8/ARCH-002 | M |
| 8 | HttpException mesajlarini production'da genellestir | XA-5 | S |

### Orta Vade

| # | Aksiyon | Ilgili Bulgular | Effort |
|---|---------|----------------|--------|
| 9 | Feature flag sistemi: ENABLE_RAW_SQL, ENABLE_DEBUG_TOOLS | XA-6, P5/CRITICAL-003 | M |
| 10 | "no-unguarded-controller" ESLint/custom lint kurali | XA-2 | M |
| 11 | Startup env-var dogrulama genisletmesi | XA-6 | S |

---

## Celiskiler ve Dogrulamalar

### P5 x P8 Uyumluluk

- P5/MEDIUM-001 (ThrottlerGuard kaldirilmis) ve P8/ARCH-009 (guard tutarsizligi) **birbirini pekistirir**: hem rate limiting hem auth guard'da "tek katman" yaklasimi uygulanmis.
- P5/HIGH-001 (client-supplied adminId) ve P8/ARCH-004 (domain kohezyon ihlali) **bagimlidir**: DebugToolsController'in ImpersonationModule icinde olmasi, bu guvenlik bulgusunun review'dan kacmasina katkida bulunmustur.
- P5'in "FIELD_MISMATCH kazara guvenlik katmani" tespiti (P3 ile celiskiler bolumu) ilginc bir capraz bulgu olusturuyor: frontend raw SQL endpoint'ine `{schema, query}` gonderirken backend `{sql, params}` bekliyor. Bu islevsel hata, raw SQL endpoint'inin frontend'den fiilen kullanilamaz olmasini sagliyor. **ANCAK** bu "koruma" tamir edildiginde guvenlik korumasi ortadan kalkar -- FIELD_MISMATCH fix'i ile birlikte P5/CRITICAL-001,002,003 fix'leri de uygulanmalidir.

### P2 Dogrulamalari

- P2'nin 18 "guard'siz controller" listesi bu raporda dogrulanmis ve risk siralamasina (XA-3) konmustur.
- P2'nin 11 client-supplied identity alani tespiti, bu raporun XA-2 bulgusundaki "guard kaldirilirsa" senaryosu ile birlestiginde, audit trail manipulasyonu riskini CRITICAL seviyesine cikarir: hem guard yok hem de identity client-supplied ise, anonim bir saldirgan baska birinin adiyla islem yapabilir.
