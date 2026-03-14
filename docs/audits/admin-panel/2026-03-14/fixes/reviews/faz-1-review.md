# Faz 1 Review Raporu

**Reviewer:** Sprint 1 Fix Ordusu Review Ajani
**Tarih:** 2026-03-14
**Kapsam:** Grup A (SQL Security), Grup B (Identity Debug), Grup C (Identity Billing), Grup D (ImpersonationPage Crash)

---

## Genel Degerlendirme

Fix'lerin genel kalitesi yuksek; hedeflenen bulgularin buyuk cogunlugu dogru ve etkili sekilde kapatilmis. Ancak **iki somut sorun** tespit edildi: (1) Grup C'de `bulkCreateDiscountCodes` endpoint'i identity fix'inden kacmis -- `template.createdBy` hala client-supplied, (2) Grup A'da `RESET` komutu blacklist'e eklenmemis (dusuk risk -- `startsWith('SELECT')` kontrolu pratikte engeller ama defense-in-depth ihlali). Bu iki sorun disinda fix'ler production-ready kalitededir.

---

## Grup A: SQL Security

### Kontrol Listesi

- [x] **Bulgu cozulmus:** EVET
  - **C1 (Multi-statement bypass):** Semicolon kontrolu satir 803-806'da eklenmis. Comment-stripping (`/* */` ve `--`) sonrasi yapildigi icin yorum icindeki semicolonlar false positive olusturmuyor. **KANIT:** `sqlWithoutComments.includes(';')` kontrolu, comment strip islemi (satir 799-801) sonrasi calisiyor.
  - **C2/C3 (SET/DO/PERFORM/COPY bypass):** 4 yeni regex satir 827-831'de eklenmis. `\bSET\b`, `\bDO\b\s*\$`, `\bPERFORM\b`, `\bCOPY\b`. Word boundary (`\b`) kullanimi false positive'leri onluyor -- `settings`, `dataset`, `offset` gibi kelimeler eslesmiyor (dogrulandi).
  - **C2/H25 (set_config/pg_sleep/current_setting):** 3 yeni regex satir 855-858'de eklenmis. Fonksiyon bazli engelleme dogru.
  - **C4 (Fail-closed raw SQL):** `ENABLE_RAW_SQL_EXPLORER=true` feature flag kontrolu satir 779'da eklenmis. Env var set edilmezse `undefined !== 'true'` -> ForbiddenException. **Fail-closed dogru calisiyor.** NODE_ENV production kontrolu yedek savunma hatti olarak korunmus (satir 784-788).
  - **C5 (CRUD production korumasi):** INSERT (satir 544-547), UPDATE (satir 597-600), DELETE (satir 659-662) endpoint'lerine `ENABLE_DB_EXPLORER_WRITES=true` feature flag eklenmis. Fail-closed dogru.
  - **C11 (System catalog erisim engeli):** `pg_catalog` ve `information_schema` satir 869'da `blockedSchemas` dizisine eklenmis. Regex `\bschema_name\.` patterniyle kontrol ediliyor.
  - **C12 (Client-controlled sensitive data):** `includeSensitive` DTO property'si tamamen kaldirilmis (satir 143). Sensitive data her zaman maskelenir (satir 396-399).

- [x] **SOLID uyumlu:** EVET
  - SRP: Mevcut blacklist mekanizmasi genisletilmis, yeni mekanizma icat edilmemis.
  - OCP: Feature flag'ler mevcut davranisi bozmadan eklenmis, flag kapaliyken eski davranis (engelleme) korunuyor.
  - DIP: Mevcut `dangerousStatements`/`dangerousFunctions`/`blockedSchemas` dizileri kullanilmis.

- [x] **Regression riski:** DUSUK
  - Feature flag'ler varsayilan kapali. Staging/dev ortamlarinda env var set edilmezse raw SQL ve CRUD endpoint'leri calismayacak -- bu beklenen davranis ama **dokumantasyonu gerekli** (ortam degiskenleri README'ye eklenmeli).
  - `includeSensitive=true` kullanan frontend kodu artik calismayacak -- bu beklenen davranis, sensitive data artik her zaman maskelenir. Frontend'de bu parametreyi gonderen kod varsa sessizce ignore edilir (krilma yok, sadece parametre etkisiz).

- [ ] **Guvenlik bypass:** KISMI EKSIKLIK
  - **`RESET` komutu blacklist'te yok:** `RESET statement_timeout`, `RESET role` gibi komutlar `\bSET\b` regex'i ile yakalanmiyor. ANCAK `normalizedSql.startsWith('SELECT')` kontrolu (satir 810) `RESET` ile baslayan sorguyu zaten engelliyor. Bu nedenle **pratikte exploit edilemez** ama defense-in-depth ilkesine aykiri. `RESET` blacklist'e eklenmeli.
  - **`SHOW` komutu blacklist'te yok:** `SHOW` ile konfigürasyon bilgileri okunabilir (`SHOW search_path`, `SHOW server_version`). Ancak yine `startsWith('SELECT')` kontrolu bunu engeller. Defense-in-depth icin eklenmeli.
  - **`\bSET\b` false positive:** Dollar-quoted string icinde `$tag$SET role$tag$` gibi literal kullanim bloke edilir. Bu guvenli yonde hata (over-blocking) oldugu icin kabul edilebilir.
  - **Nested comment bypass:** JavaScript regex `\/\*[\s\S]*?\*\/` lazy matching kullanir -- nested `/* /* */ */` durumunda ilk `*/`'da keser, geriye kalan metin hala kontrol edilir. Bypass mumkun degil.
  - **Unicode homoglyph bypass:** PostgreSQL standard ASCII identifier'lar bekler, Unicode benzerleri syntax hatasi verir. Bypass mumkun degil.

- [x] **Bagimlilik:** EVET
  - C13 (QueryEditor fix) artik guvenle yapilabilir: raw SQL endpoint'i fail-closed, dangerous statement/function listesi genisletilmis, system catalog erisimi engellenmis.

### Sorunlar

1. **DUSUK ONCELIK:** `RESET` ve `SHOW` komutlari blacklist'e eklenmeli (defense-in-depth). Pratikte `startsWith('SELECT')` kontrolu bunlari zaten engeller, exploit riski yok.
   ```typescript
   // Onerilir ekleme (dangerousStatements dizisine):
   /\bRESET\b/i,
   /\bSHOW\b/i,
   ```

2. **BILGI:** `SET statement_timeout` (satir 884) controller'in kendi hardcoded sorgusu olarak ayni queryRunner uzerinde calisiyor. Bu blacklist kontrolunden gecmiyor cunku sadece `dto.sql` (kullanici girdisi) kontrol ediliyor. Celisme yok -- dogru tasarim.

### Sonuc: ONAYLANDI (1 dusuk oncelikli iyilestirme onerisi ile)

---

## Grup B: Identity Debug

### Kontrol Listesi

- [x] **Bulgu cozulmus:** EVET
  - **C6 Faz 1 (DebugToolsController identity spoofing):** 4 endpoint fix'lenmis:
    - `startDebugSession` (satir 398-406): `@Query('adminId')` kaldirilmis, `@Req() req: Request` ile JWT'den `(req as any).user?.id` alinyor. `adminId` yoksa `UnauthorizedException`.
    - `createFeatureFlagOverride` (satir 616-624): Ayni pattern, `@Query('adminId')` -> JWT.
    - `revertFeatureFlagOverride` (satir 632-642): `@Query('adminId') revertedBy` -> JWT.
    - `queryOverrides` (satir 674-693): `@Query('adminId')` -> JWT, artik sadece kendi ID'si ile filtreleme.
  - **KANIT:** `PlatformAdminGuard` (satir 117-123) `request.user.id = payload.sub` olarak set ediyor. Guard class-level'da uygulanmis (satir 363). JWT dogrulama BASARISIZ olursa Guard UnauthorizedException firlatir, controller'a hic ulasilmaz. Controller'daki ek `if (!adminId)` kontrolu ise Guard'in `req.user`'i set etmedigi patolojik durum icin (ornegin @Public decorator ile bypass) -- **belt-and-suspenders yaklaşimi, dogru.**

- [x] **SOLID uyumlu:** EVET
  - SRP: Sadece identity kaynagi degismis, endpoint davranisi korunmus.
  - OCP: Service method imzalari degismemis.
  - Referans pattern (`ImpersonationController`) ile tutarli.

- [x] **Regression riski:** COK DUSUK
  - Frontend'de `adminId` query parametresi gonderen kod artik etkisiz olacak ama hata vermez (parametre ignore edilir, JWT kullanilir).
  - `queryOverrides` endpoint'inde filtre artik sadece authenticated admin'in kendi ID'si ile calisiyor -- bu davranis degisikligi kasitli ve guvenli.

- [x] **Guvenlik bypass:** YOK
  - `PlatformAdminGuard` JWT dogrulama yaparak `req.user.id`'yi **guard seviyesinde** set ediyor (satir 117). Guard basarisiz olursa controller'a ulasilamaz. Controller'daki `(req as any).user?.id` null-check'i ek savunma hatti.
  - `(req as any)` type casting'i guvenlik sorunu degil -- runtime'da `req.user` Guard tarafindan set ediliyor. TypeScript tipi Express.Request'i extend etmek icin `(req as any)` gerekli (type augmentation yapilmamis). Bu estetik bir sorun, guvenlik sorunu degil.
  - Guard `@Public()` decorator ile bypass edilebilir mi? Controller'da ve method'larda `@Public()` decorator yok -- kontrol edildi. Bypass yok.

- [x] **Bagimlilik:** SORUN YOK
  - C7/C8 (useAsyncData) bu degisikliklerden etkilenmemis -- backend-only degisiklik.

### Sorunlar

Yok.

### Sonuc: ONAYLANDI

---

## Grup C: Identity Billing

### Kontrol Listesi

- [x] **Bulgu cozulmus:** BUYUK OLCUDE EVET, 1 KACAK VAR
  - 19 endpoint'in 18'i dogru fix'lenmis (rapordaki tablo ile birebir eslesiyor).
  - Her endpoint'te `@Req() req: Request` eklenmis, `const userId = (req as any).user?.id` ile JWT'den alinmis.
  - DTO-based endpoint'lerde spread operator ile override: `{ ...dto, createdBy: userId }` -- **dogru pattern**, client `createdBy` gonderse bile backend override eder.
  - Direct-param endpoint'lerde client parametresi kaldirilmis.
  - **KANIT:** Satir 112, 119, 197, 208, 247, 290, 350, 541, 552 -- tumu `userId` kullaniyor.

  **ANCAK:** `bulkCreateDiscountCodes` endpoint'i (satir 272-280) fix'ten **kacmis**:
  ```typescript
  @Post('discounts/bulk-create')
  async bulkCreateDiscountCodes(
    @Body('count') count: number,
    @Body('template') template: Omit<CreateDiscountCodeDto, 'code'>,
    @Body('codePrefix') codePrefix?: string,
  ) {
    const codes = await this.discountService.bulkCreate(count, template, codePrefix);
    return { success: true, count: codes.length, codes };
  }
  ```
  `CreateDiscountCodeDto.createdBy` field'i (service dosyasinda satir 40: `createdBy: string`) `template` DTO'su icinde client-supplied olarak geciriliyor. Bu endpoint PlatformAdminGuard ile korunuyor (class-level guard) ama identity spoofing hala mumkun -- authenticated admin baska bir admin'in ID'sini `template.createdBy` olarak gonderebilir.

- [x] **SOLID uyumlu:** EVET (fix'lenen endpoint'ler icin)
  - Service method imzalarina dokunulmamis.
  - Controller seviyesinde minimal degisiklik.

- [x] **Regression riski:** DUSUK
  - Frontend'de `createdBy`/`updatedBy` body parametresi gonderen kod artik backend tarafindan override edilir (krilma yok).
  - `cancelSubscription` (satir 354): `@Req() req?: Request` -- optional `req` parametresi. PlatformAdminGuard aktif oldugu icin `req` her zaman mevcut olacak. Optional yapmanin nedeni muhtemelen TypeScript hata onleme, guvenlik sorunu degil.

- [ ] **Guvenlik bypass:** 1 KACAK ENDPOINT
  - `bulkCreateDiscountCodes` endpoint'inde `template.createdBy` client-supplied. **Identity spoofing mumkun.**
  - Fix onerisi:
    ```typescript
    @Post('discounts/bulk-create')
    async bulkCreateDiscountCodes(
      @Body('count') count: number,
      @Body('template') template: Omit<CreateDiscountCodeDto, 'code'>,
      @Body('codePrefix') codePrefix?: string,
      @Req() req: Request,
    ) {
      const userId = (req as any).user?.id;
      const codes = await this.discountService.bulkCreate(
        count,
        { ...template, createdBy: userId },
        codePrefix,
      );
      return { success: true, count: codes.length, codes };
    }
    ```

- [x] **Bagimlilik:** SORUN YOK

### Sorunlar

1. **KRITIK:** `bulkCreateDiscountCodes` (satir 272-280) endpoint'i identity fix'inden kacmis. `template.createdBy` hala client-supplied. Yukaridaki fix onerisi uygulanmali.

### Sonuc: REDDEDILDI -- 1 kritik kacak endpoint fix'lenmeli

---

## Grup D: ImpersonationPage Crash

### Kontrol Listesi

- [x] **Bulgu cozulmus:** EVET
  - **C9 (Cache crash):** Kok neden dogru teshis edilmis. `apiFetch()` fonksiyonu (adminApi.ts satir 104-110) non-paginated response'larda `json.data`'yi dogrudan dondurur. Yani `tenantsApi.search()` -> `Tenant[]`, `{ data: Tenant[] }` degil.
  - **KANIT -- Fix oncesi crash senaryosu:**
    1. Ilk ziyaret: `res.data` -> `undefined` (array'de `.data` property yok)
    2. Cache'e `{ data: undefined }` kaydedilir
    3. Ikinci ziyaret: `Promise.resolve({ data: undefined })` -> `tenantsRes.value = { data: undefined }` -> `tenantsRes.value.map(...)` -> `TypeError: map is not a function`
  - **KANIT -- Fix sonrasi:**
    - Satir 120: `Promise<SimpleTenant[]>` -- tip dogru
    - Satir 122: Cache hit -> `Promise.resolve(tenantCacheRef.current.data)` -- dogrudan `SimpleTenant[]` donuyor, envelope yok
    - Satir 123-127: Cache miss -> `res` (zaten `Tenant[]`) uzerinde `.map()` ile `SimpleTenant` mapping yapilip cache'e kaydediliyor, sonuc olarak `SimpleTenant[]` donuyor
    - Satir 148-152: `tenantsRes.value` dogrudan kullaniliyor -- mapping artik cache kaydi sirasinda yapildigi icin tekrar mapping gerekmiyor

- [x] **SOLID uyumlu:** EVET
  - SRP: Sadece tenant cache/mapping mantigi duzeltilmis.
  - Diger `sessionsRes.value.data` ve `permissionsRes.value.data` erisimleri dokunulmamis -- bunlar paginated API'lardir, `apiFetch` bunlari `{ data: [...], page, limit, total }` olarak dondurur. **Dogru ayrım yapilmis.**

- [x] **Regression riski:** COK DUSUK
  - `SimpleTenant` mapping artik cache kaydi sirasinda yapiliyor (satir 124). Onceden `tenantsRes.value.map(...)` ile yapiliyordu (satir 148-152). Fonksiyonel olarak ayni sonuc, sadece mapping zamani degismis.
  - Paginated API sonuclari (sessions, permissions) degistirilmemis.

- [x] **Guvenlik bypass:** UYGULANAMAZ
  - Frontend-only degisiklik, guvenlik implikasyonu yok.

- [x] **Bagimlilik:** SORUN YOK
  - C7/C8 (useAsyncData) bu degisiklikten etkilenmemis -- ImpersonationPage kendi `useCallback` + `Promise.allSettled` pattern'ini kullaniyor, `useAsyncData` hook'u kullanmiyor.

### Sorunlar

Yok.

### Sonuc: ONAYLANDI

---

## Genel Sonuc

| Grup | Karar | Aciklama |
|------|-------|----------|
| Grup A: SQL Security | ONAYLANDI | 1 dusuk oncelikli defense-in-depth onerisi (RESET/SHOW blacklist) |
| Grup B: Identity Debug | ONAYLANDI | Sorunsuz |
| Grup C: Identity Billing | REDDEDILDI | `bulkCreateDiscountCodes` endpoint'i fix'ten kacmis |
| Grup D: ImpersonationPage Crash | ONAYLANDI | Sorunsuz |

- **Onaylanan:** 3/4
- **Reddedilen:** 1/4
- **Faz 2'ye gecilebilir mi:** HAYIR -- Grup C'deki kacak endpoint fix'lenmeden Faz 2'ye gecilmemeli.

### Faz 2 Icin Blocker

1. **[KRITIK]** `BillingController.bulkCreateDiscountCodes` (satir 272-280) -- `template.createdBy` client-supplied identity spoofing. Fix onerisi Grup C bolumunde verildi. **Tahmini is: 5 dakika, 4 satir degisiklik.**

### Faz 2 Icin Onerilir Iyilestirmeler (non-blocker)

1. **[DUSUK]** `dangerousStatements` dizisine `/\bRESET\b/i` ve `/\bSHOW\b/i` eklenmesi (defense-in-depth, pratikte `startsWith('SELECT')` zaten engeller).
2. **[BILGI]** `(req as any).user?.id` pattern'i icin Express.Request type augmentation yapilmasi -- tum controller'larda type safety arttirilir.
