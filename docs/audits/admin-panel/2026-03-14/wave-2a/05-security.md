# P5: Guvenlik Denetcisi Raporu

**Tarih:** 2026-03-14
**Kapsam:** Admin Panel backend (admin-api-service) + frontend (admin-panel) guvenlik denetimi
**Ajan:** Guvenlik Denetcisi (P5)

---

## Yonetici Ozeti

Admin API Service'in guvenlik posturu genel olarak orta-iyi seviyededir. JWT tabanli `PlatformAdminGuard` global APP_GUARD olarak dogru sekilde uygulanmis ve `@Public()` kullanimi makul (health + password-reset + provisioning-config). Ancak kritik seviyede 3, yuksek seviyede 5, orta seviyede 7 ve dusuk seviyede 5 bulgu tespit edilmistir. En ciddi sorunlar: (1) Database Explorer raw SQL endpoint'inde `NODE_ENV` tek savunma hatti olarak kullanilmasi ve regex-tabanli filtrelemenin bypass edilebilmesi, (2) DebugToolsController'da admin kimliginin client-supplied `@Query('adminId')` ile alinmasi, (3) `includeSensitive` flag'inin client-controlled olmasi ve hassas verilerin maskelenmesini tamamen devre disi birakabilmesi.

---

## Bulgular

### CRITICAL-001: Raw SQL Regex Bypass -- SET search_path ile Tenant Izolasyonu Kirma

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:782-844`
- **Kontrol:** B2, B3, D2
- **Aciklama:** `executeQuery` endpoint'i SQL comment'leri cikardiktan sonra `dangerousStatements` ve `blockedSchemas` regex filtrelemesi yapiyor. Ancak `SET search_path` komutu bloke listesinde degil. Saldirgan `SELECT set_config('search_path', 'tenant_abc123', true)` seklinde bir sorgu ile search_path'i degistirebilir ve ardindan ikinci bir sorguda tenant verilerine erisebilir.
- **Kanit:**
  ```typescript
  // Satir 793-804: dangerousStatements listesi
  const dangerousStatements = [
    /\bDROP\b/i, /\bDELETE\b/i, /\bTRUNCATE\b/i,
    /\bINSERT\b/i, /\bUPDATE\b/i, /\bALTER\b/i,
    /\bCREATE\b/i, /\bGRANT\b/i, /\bREVOKE\b/i,
    /\bEXEC(UTE)?\b/i, /\bCALL\b/i,
  ];
  // SET, DO, COPY gibi komutlar listede YOK
  ```
  `set_config()` fonksiyonu da `dangerousFunctions` listesinde degil. Saldirgan:
  ```sql
  SELECT set_config('search_path', 'tenant_abc123', true)
  ```
  ardindan:
  ```sql
  SELECT * FROM users -- artik tenant_abc123.users'a erisir
  ```
- **Etki:** Herhangi bir authenticated SUPER_ADMIN (dev/staging ortaminda), tenant izolasyonunu kirar ve diger tenant'larin tum verilerine erisir. `statement_timeout` sayesinde uzun sureli sorgular engellenir, ancak search_path degisikligi kalici olur (session-level).
- **Onerilen Fix:** `dangerousStatements` listesine `/\bSET\b/i` ekle. `dangerousFunctions` listesine `/\bset_config\b/i` ekle. Ideal olarak raw SQL endpoint'ini tamamen read-only bir DB kullanicisi uzerinden calistir.
- **Effort:** S

### CRITICAL-002: PL/pgSQL Anonymous Block ile Regex Bypass

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:787-788`
- **Kontrol:** B3
- **Aciklama:** `normalizedSql.startsWith('SELECT')` ve `normalizedSql.startsWith('WITH')` kontrolu yapiliyor. Ancak `DO $$ BEGIN ... END $$;` bloklari kontrol edilmiyor. Saldirgan:
  ```sql
  SELECT 1; DO $$ BEGIN EXECUTE 'DROP TABLE auth.users'; END $$;
  ```
  PostgreSQL multi-statement destekliyorsa bu yaygin bir cikarilma cikigidir. Ancak TypeORM `queryRunner.query()` varsayilan olarak tek statement calistirir, bu riski azaltir. Yine de `DO` blogu icinde `EXECUTE` cagrilabilir.
- **Kanit:**
  ```typescript
  // Satir 787-789
  const normalizedSql = sqlWithoutComments.trim().toUpperCase();
  if (!normalizedSql.startsWith('SELECT') && !normalizedSql.startsWith('WITH')) {
    throw new BadRequestException('Only SELECT queries are allowed');
  }
  ```
  `DO` keyword'u ne `startsWith` kontrolunde ne de `dangerousStatements` listesinde bulunuyor.
- **Etki:** Eger multi-statement destegi aktifse (bazi TypeORM driver konfigurasyonlarinda mumkun), DDL/DML islemleri calistirilabilir. Risk azaltici faktor: TypeORM genellikle tek statement calistirir.
- **Onerilen Fix:** `dangerousStatements` listesine `/\bDO\b\s*\$/i` ekle. Ayrica query metninde `;` karakterini yasakla (multi-statement onleme).
- **Effort:** S

### CRITICAL-003: NODE_ENV Tek Savunma Hatti -- Ortam Degiskeni Manipulasyonu

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:767-771`
- **Kontrol:** B9
- **Aciklama:** Raw SQL endpoint'inin production'da bloke edilmesi **yalnizca** `process.env['NODE_ENV'] === 'production'` kontrolune baglidir. Bu, birkac riski beraberinde getirir: (1) Staging/dev ortamlarinda endpoint tamamen aciktir -- staging gercek verilerle calisiyor olabilir, (2) NODE_ENV set edilmezse veya yanlis set edilirse endpoint production'da bile acik kalir, (3) Container olusturulurken NODE_ENV atlanirsa sessizce acik kalir.
- **Kanit:**
  ```typescript
  // Satir 767-771
  if (process.env['NODE_ENV'] === 'production') {
    throw new BadRequestException(
      'Raw SQL queries are disabled in production for security reasons',
    );
  }
  ```
- **Etki:** Staging'de gercek musterilerin verileri ile calisiyor olabilirler. NODE_ENV set edilmezse production'da bile raw SQL erisimi acik kalir.
- **Onerilen Fix:** Ek bir feature flag ekle: `ENABLE_RAW_SQL_EXPLORER=true` gibi. Varsayilan `false` olsun. Hem `NODE_ENV` hem de bu flag kontrolu yapilsin. Ayrica CRUD endpoint'lerine (INSERT/UPDATE/DELETE satir 542-682) de ayni ortam kontrolunu ekle.
- **Effort:** S

### HIGH-001: Client-Supplied Admin Identity (DebugToolsController)

- **Dosya:** `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:393,606,618,655`
- **Kontrol:** A2, G4
- **Aciklama:** `DebugToolsController`'da 4 endpoint `@Query('adminId')` parametresini kullanarak admin kimligini client'tan aliyor. Global APP_GUARD JWT dogrulamasi yapiyor ancak dogrulanan JWT'deki `req.user.id` yerine query parameter kullaniliyor. Bu, herhangi bir authenticated admin'in baska bir admin gibi islem yapmasina olanak tanir.
- **Kanit:**
  ```typescript
  // Satir 390-394
  @Post('sessions')
  async startDebugSession(
    @Body() dto: StartDebugSessionDto,
    @Query('adminId') adminId: string,  // CLIENT-SUPPLIED!
  )

  // Satir 603-607
  @Post('feature-overrides')
  async createFeatureFlagOverride(
    @Body() dto: CreateFeatureFlagOverrideDto,
    @Query('adminId') adminId: string,  // CLIENT-SUPPLIED!
  )
  ```
- **Etki:** Admin A, Admin B'nin kimligiyle debug session baslatiyor. Audit trail yaniltici olur. Feature flag override'lari yanlis admin'e atfedilir.
- **Onerilen Fix:** ImpersonationController'daki pattern'i takip et: `@Req() req: Request` kullan, `(req as any).user.id` ile JWT'den admin kimligini al.
- **Effort:** S

### HIGH-002: includeSensitive Flag Client-Controlled

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:145,361,399`
- **Kontrol:** C1
- **Aciklama:** `TableQueryDto`'daki `includeSensitive` boolean flag'i client tarafindan `?includeSensitive=true` query parametresi ile gonderiliyor. Bu flag `true` oldugunda hassas sutunlar (password_hash, api_key, token vb.) maskelenmeden dondurulur.
- **Kanit:**
  ```typescript
  // Satir 142-146 (DTO)
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeSensitive?: boolean;

  // Satir 361
  const includeSensitive = query.includeSensitive === true;

  // Satir 399-403
  const rows = includeSensitive
    ? rawRows  // Maskeleme YOK!
    : rawRows.map((row) => maskSensitiveData(row, columnsWithSensitive));
  ```
- **Etki:** Herhangi bir SUPER_ADMIN, basit bir query parametresi ile tum kullanici parolalarini, API anahtarlarini, token'lari maskelenmemis olarak goruntuleyebilir. Export endpoint'i (satir 469-471) her zaman maskeler, ancak normal data endpoint'i client'in insiyatifinde.
- **Onerilen Fix:** `includeSensitive` parametresini kaldir veya ek bir "security override" mekanizmasi ekle (ornegin ayri bir guarded endpoint). En azindan bu islem icin ayri bir audit log girdisi olustur.
- **Effort:** S

### HIGH-003: Nested SQL Comment Bypass

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:782-784`
- **Kontrol:** B4
- **Aciklama:** Comment temizleme regex'i `/* ... */` ve `-- ...` formatlarini kaldiriyor. Ancak PostgreSQL nested comment'leri destekler: `/* foo /* bar */ baz */`. Bu regex ilk `*/` gordinugunde durur ve kalan `baz */` kismini birakir, keyword'leri gizlemek icin kullanilabilir.
- **Kanit:**
  ```typescript
  // Satir 782-784
  const sqlWithoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, '') // lazy match -- nested'i handle etmez
    .replace(/--.*$/gm, '');
  ```
  Saldirgan:
  ```sql
  SELECT /* /* */ DROP TABLE users -- */ 1
  ```
  Sonuc: `SELECT  DROP TABLE users -- */ 1` -- `DROP` keyword'u artik gorunur ve bloke edilir.
  Ancak ters yonde:
  ```sql
  SELECT 1 /* nested /* comment */ SET search_path */ FROM pg_catalog.pg_tables
  ```
  Sonuc: `SELECT 1  SET search_path */ FROM pg_catalog.pg_tables` -- `*/` artik syntax error olusturur. Risk dusuktur ancak edge case'ler mevcuttur.
- **Etki:** Dusuk-orta. Cogu bypass denemesi syntax error'a yol acar, ancak dikkatle hazirlanmis sorgularda keyword gizleme mumkun olabilir.
- **Onerilen Fix:** Nested comment temizleme icin recursive regex veya iteratif parser kullan. Alternatif olarak `/*` ve `*/` karakterlerini tamamen yasakla.
- **Effort:** M

### HIGH-004: pg_catalog / information_schema Meta-Data Leak

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:836-845`
- **Kontrol:** B5
- **Aciklama:** `blockedSchemas` listesi yalnizca `['sensor', 'farm', 'hr', 'hydroponics']` ve `tenant_*` pattern'ini engelliyor. `pg_catalog` ve `information_schema` engellenmemis. Saldirgan `pg_catalog.pg_shadow` (superuser parolalari), `pg_catalog.pg_authid`, `pg_catalog.pg_stat_activity` (aktif sorgular ve baglanti bilgileri), `information_schema.columns` (tum tablolarin sutun bilgileri) gibi sistem kataloglarindan bilgi cekebilir.
- **Kanit:**
  ```typescript
  // Satir 837-838
  const blockedSchemas = ['sensor', 'farm', 'hr', 'hydroponics'];
  // pg_catalog, information_schema ENGELLENMEMIS
  ```
  Saldirgan sorgusu:
  ```sql
  SELECT rolname, rolpassword FROM pg_catalog.pg_authid
  SELECT * FROM pg_catalog.pg_stat_activity
  SELECT * FROM information_schema.columns WHERE table_schema = 'tenant_abc'
  ```
- **Etki:** DB kullanici bilgileri, aktif sorgularin tam metni, tum schemalarin tablo/sutun yapisi -- tam veritabani yapisal kesfif. `tenant_*` blogu yalnizca dogrudan tablo erisimini engelliyor, information_schema uzerinden meta-data erisilebilir.
- **Onerilen Fix:** `blockedSchemas` listesine `pg_catalog` ve `information_schema` ekle. `dangerousFunctions` listesine `pg_stat_activity` ekle.
- **Effort:** S

### HIGH-005: CRUD Endpoint'leri Ortam Kontrolu Yok

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:542-682`
- **Kontrol:** B9
- **Aciklama:** Raw SQL endpoint'i `NODE_ENV === 'production'` kontrolu ile korunurken, INSERT (`POST .../rows`, satir 542), UPDATE (`PUT .../rows/:id`, satir 589), ve DELETE (`DELETE .../rows/:id`, satir 647) endpoint'leri **hicbir ortam kontrolu olmadan** tum ortamlarda acik. Production'da dahi SUPER_ADMIN veritabanina dogrudan satir ekleyebilir, guncelleyebilir ve silebilir.
- **Kanit:**
  ```typescript
  // Satir 542 - Hicbir NODE_ENV kontrolu yok
  @Post('schemas/:schema/tables/:table/rows')
  async insertRow(...)

  // Satir 589
  @Put('schemas/:schema/tables/:table/rows/:id')
  async updateRow(...)

  // Satir 647
  @Delete('schemas/:schema/tables/:table/rows/:id')
  async deleteRow(...)
  ```
- **Etki:** Production'da admin paneli uzerinden auth.users tablosuna satir eklenebilir, admin.system_settings degistirilebilir, billing kayitlari silinebilir.
- **Onerilen Fix:** CRUD endpoint'lerine de `NODE_ENV` kontrolu ekle veya ayri bir feature flag ile kontrol et. Ideal olarak production'da read-only mod uygula.
- **Effort:** S

### MEDIUM-001: ThrottlerGuard Kaldirilmis -- Korunmasiz Endpoint'ler

- **Dosya:** `apps/admin-api-service/src/app.module.ts:128-131`
- **Kontrol:** E1
- **Aciklama:** Global ThrottlerGuard `APP_GUARD` olarak **kaldirilmis**, yorum satirinda "429 flood sorunu" belirtiliyor. Sonuc olarak raw SQL endpoint'i, CRUD endpoint'leri, bulk IP islemleri ve export endpoint'leri dahil tum endpoint'ler rate limit korumasindan yoksun.
- **Kanit:**
  ```typescript
  // Satir 128-131
  // ThrottlerGuard removed: admin-api is super-admin-only (PlatformAdminGuard).
  // Rate limiting an authenticated admin panel with ~15 concurrent dashboard
  // requests causes 429 floods.
  ```
- **Etki:** Ele gecirilmis bir SUPER_ADMIN hesabi ile DoS saldirisi yapilabilir. Ozellikle raw SQL endpoint'inde `statement_timeout = 30s` olsa bile es zamanli binlerce sorgu ile connection pool tuketilebilir.
- **Onerilen Fix:** Global throttle yerine, hassas endpoint'lere per-route `@Throttle()` ekle: raw SQL query (1 req/5s), CRUD islemleri (10 req/min), export (1 req/30s), bulk IP (1 req/min).
- **Effort:** M

### MEDIUM-002: Export Endpoint Sensitive Data -- Max Row Limiti

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:440`
- **Kontrol:** E2, C2
- **Aciklama:** Export endpoint'i max 10.000 satir donduruyor. Bu deger auth.users tablosu gibi buyuk tablolar icin ciddi DB yuku olusturabilir. Ayrica export'ta hassas veriler maskeleniyor (satir 469-471, dogru), ancak CSV export'unda `column_default` bilgisi dahil (satir 489) -- bu, default password hash pattern'leri gibi hassas bilgileri ifsa edebilir.
- **Kanit:**
  ```typescript
  // Satir 440
  const limit = Math.min(10000, Math.max(1, query.limit || 1000)); // Max 10K rows
  ```
- **Etki:** 10K satirlik auth.users export'u ciddi DB yuku olusturabilir. Throttle yoklugu ile tekrarlanan export islemleri DoS riski olusturur.
- **Onerilen Fix:** Export limit'ini 1000'e dusur. Export islemine per-route throttle ekle.
- **Effort:** S

### MEDIUM-003: Bulk IP Rule Array Boyut Siniri Yok

- **Dosya:** `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:126-148`
- **Kontrol:** E3, H2
- **Aciklama:** Bulk whitelist/blacklist endpoint'lerinde `ips` array'inin boyutu sinirlanmamis. DTO validation kullanilmiyor -- body dogrudan `{ ips: string[] }` inline type ile alinmis. Saldirgan milyonlarca IP adresi iceren bir array gonderebilir.
- **Kanit:**
  ```typescript
  // Satir 126-128 -- Inline type, DTO validation yok
  @Post('whitelist/bulk')
  async bulkWhitelist(
    @Body() body: { ips: string[]; tenantId?: string; createdBy?: string },
  )
  // Service'te her IP icin ayri createRule() cagrisi (satir 307)
  ```
- **Etki:** 100K IP adresli bir istek ile DB'de 100K satir olusturulur, es zamanli olarak N tane istek gonderilirse DB lock'a girer.
- **Onerilen Fix:** DTO sinifi olustur, `@IsArray()`, `@ArrayMaxSize(500)`, `@IsIP(4, { each: true })` validator'leri ekle.
- **Effort:** S

### MEDIUM-004: Client-Supplied createdBy (IP Access Controller)

- **Dosya:** `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:127,141`
- **Kontrol:** A2
- **Aciklama:** Bulk whitelist/blacklist endpoint'lerinde `createdBy` alani `@Body()` ile client'tan aliniyor. Audit trail'de gercek islem yapan admin yerine client'in belirledigi deger kaydedilir.
- **Kanit:**
  ```typescript
  @Body() body: { ips: string[]; tenantId?: string; createdBy?: string },
  ```
- **Etki:** Audit trail manipulasyonu -- baska bir admin'in ismi ile kurallar olusturulabilir.
- **Onerilen Fix:** `createdBy` parametresini kaldir, `req.user.id` veya `req.user.email` kullan.
- **Effort:** S

### MEDIUM-005: JSON.parse(defaultValue) Prototype Pollution

- **Dosya:** `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:647`
- **Kontrol:** H3
- **Aciklama:** `getFeatureFlagValue` endpoint'inde `defaultValue` query parametresi `JSON.parse()` ile ayristiriliyor. Kontrolsuz `JSON.parse` cagirisi `{"__proto__": {"isAdmin": true}}` gibi payload'larla prototype pollution'a yol acabilir.
- **Kanit:**
  ```typescript
  // Satir 643-648
  @Get('feature-overrides/value')
  async getFeatureFlagValue(
    @Query('tenantId') tenantId: string,
    @Query('featureKey') featureKey: string,
    @Query('defaultValue') defaultValue: string,
  ) {
    const value = await this.debugToolsService.getFeatureFlagValue(
      tenantId, featureKey, JSON.parse(defaultValue),
    );
  ```
- **Etki:** Eger `JSON.parse` sonucu bir obje olarak spread edilir veya Object.assign ile kullanilirsa, global Object prototype'i kirletilebilir. Etki, service icindeki kullanima baglidir.
- **Onerilen Fix:** `JSON.parse` sonucunu dogrulamadan once bir schema validation'dan gecir. Veya sadece primitive degerler kabul et (`string | number | boolean`).
- **Effort:** S

### MEDIUM-006: credentials:'include' + CSRF Riski

- **Dosya:** `web/modules/admin-panel/src/services/adminApi.ts:61`, `web/modules/admin-panel/src/pages/DatabaseExplorerPage.tsx:72-198`, `web/modules/admin-panel/src/components/database/QueryEditor.tsx:63-82`
- **Kontrol:** F1
- **Aciklama:** Tum fetch cagrilari `credentials: 'include'` kullanarak cookie'leri otomatik olarak gonderiyor. Backend CORS `credentials: true` (main.ts:90) ile yapilandirilmis. CSRF token mekanizmasi gorunmuyor. Bearer token Authorization header'i ile kimlik dogrulamasi yapiliyor ki bu CSRF'e karsi dogal bir koruma saglar (tarayici otomatik gondermez). ANCAK: `credentials: 'include'` session cookie tabanli bir auth mekanizmasinin da desteklendigi izlenimini verir. Eger cookie-based auth aktifse veya gelecekte eklenirse, CSRF korumasiz kalir.
- **Kanit:**
  ```typescript
  // adminApi.ts:59-62
  const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: { ...getAuthHeader(), ... }
  });
  ```
  Backend'de CSRF middleware gorulmemektedir.
- **Etki:** Mevcut durumda dusuk (Bearer token CSRF'e karsi korur). Ancak cookie-based auth eklenirse veya session cookie mevcut ise, tum state-degistiren endpoint'ler CSRF'e acik olur.
- **Onerilen Fix:** `credentials: 'include'` kullanimini gercekcten gerekmedikce kaldir (pure Bearer token auth icin `credentials: 'same-origin'` yeterli). Veya CSRF token middleware ekle.
- **Effort:** M

### MEDIUM-007: Session Ownership -- Cross-Admin Impersonation Session Manipulasyonu

- **Dosya:** `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:442-466`
- **Kontrol:** A3
- **Aciklama:** `endImpersonation` ve `terminateSession` metodlari session ID ile calisir ancak istegi yapan admin'in bu session'in sahibi olup olmadigini kontrol etmez. Admin A, Admin B'nin aktif impersonation session'ini sonlandirebilir.
- **Kanit:**
  ```typescript
  // Satir 442-466
  async endImpersonation(sessionId: string, endReason?: string, endedBy?: string) {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    // session.superAdminId !== endedBy kontrolu YOK
    if (session.status !== ImpersonationStatus.ACTIVE) {
      throw new BadRequestException(`Session is not active`);
    }
    session.status = ImpersonationStatus.ENDED;
    ...
  }
  ```
  Controller'da (satir 321-331) `user.id` JWT'den alinir ve `endedBy` olarak gonderilir, ancak service'te bu deger yalnizca log icin kullanilir -- yetki kontrolu yapilmaz.
- **Etki:** Bir SUPER_ADMIN baska bir SUPER_ADMIN'in aktif impersonation session'ini haber vermeden sonlandirebilir. Operasyonel sorun, guvenlik riski sinirli (her iki admin de SUPER_ADMIN).
- **Onerilen Fix:** `terminateSession` icin mevcut davranis kabul edilebilir (admin override). `endImpersonation` icin `session.superAdminId === endedBy` kontrolu ekle veya en azindan audit log'a "ended by different admin" uyarisi ekle.
- **Effort:** S

### LOW-001: isValidIdentifier Bypass Senaryolari

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:951-954`
- **Kontrol:** B8
- **Aciklama:** `isValidIdentifier` regex'i `/^[a-z_][a-z0-9_]*$/i` -- basit ve etkili. `"` (double-quote) icermedigi icin SQL injection icin kullanilamaz. Identifier'lar `"${identifier}"` seklinde quote ediliyor. Ancak regex case-insensitive oldugu icin Turkce karakterler (i/I -> dotless-i sorunlari) gibi locale-spesifik edge case'ler mumkun degildir cunku pattern ASCII-only kabul eder. Bu kontrol yeterli.
- **Kanit:**
  ```typescript
  private isValidIdentifier(name: string): boolean {
    const validPattern = /^[a-z_][a-z0-9_]*$/i;
    return validPattern.test(name) && name.length <= 63;
  }
  ```
- **Etki:** Dusuk. Regex guvenli gorunuyor. `"` ve `;` gibi tehlikeli karakterler reddediliyor.
- **Onerilen Fix:** Mevcut implementasyon yeterli. Ek onlem olarak PostgreSQL'in `quote_ident()` fonksiyonu kullanilabilir.
- **Effort:** N/A

### LOW-002: notifyTenantAdmin Stub Implementasyonu

- **Dosya:** `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:800-805`
- **Kontrol:** G3
- **Aciklama:** `notifyTenantAdmin` metodu sadece logger.log() cagrisi yapiyor. Gercek bildirim (email/push) gondermiyor. Ancak GrantPermissionDto'da `notifyTenantAdmin` flag'i var ve default `false` (satir 173). Bu "silent fail" durumu, admin'in bildirim gonderildigini dusunmesine yol acabilir.
- **Kanit:**
  ```typescript
  // Satir 800-805
  private async notifyTenantAdmin(session: ImpersonationSession): Promise<void> {
    // In production, this would send email/notification to tenant admin
    this.logger.log(`[Notification] Impersonation started...`);
  }
  ```
- **Etki:** Dusuk. Flag default false. Ancak admin UI'da "Notify Tenant Admin" checkbox'i varsa, admin bildirim gonderildigini zannedebilir.
- **Onerilen Fix:** `notifyTenantAdmin=true` ayarlandiginda uyari loglama yap veya exception at: "Tenant notification is not yet implemented".
- **Effort:** S

### LOW-003: In-Memory activeSessions Restart Tutarsizligi

- **Dosya:** `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:69,122-130`
- **Kontrol:** G4
- **Aciklama:** Aktif impersonation session'lari hem DB'de hem de in-memory `Map`'te tutuluyor. Servis yeniden basladiginda (satir 122-130) DB'den yukleniyor. Ancak `getActiveSessions()` (satir 811-825) yalnizca in-memory cache'den okuyor. Container restart arasinda kisa bir zaman diliminde tutarsizlik olabilir. Ayrica expired session eviction'i (satir 817-820) in-memory'den siliyor ama DB update'i yapmadan birakiyor (DB update yalnizca cron job'da oluyor, satir 759-776).
- **Kanit:**
  ```typescript
  // Satir 69
  private activeSessions: Map<string, ImpersonationSession> = new Map();
  // Satir 122-130 -- constructor'da DB'den yukleniyor
  ```
- **Etki:** Dusuk. Restart sonrasi gecici tutarsizlik. Cron job her dakika calisiyor, gap kisa.
- **Onerilen Fix:** Mevcut implementasyon kabul edilebilir seviyede. Redis'e tasinmasi ideal cozum olur.
- **Effort:** L

### LOW-004: LocalStorage Query History Hassas Veri

- **Dosya:** `web/modules/admin-panel/src/components/database/QueryEditor.tsx:113-155`
- **Kontrol:** C4
- **Aciklama:** SQL sorgu gecmisi localStorage'da saklanmaktadir. Truncation yapilmis (120 karakter, satir 124-128), bu iyi bir onlemdir. Ancak WHERE clause'larindaki hassas filtre degerleri (email adresleri, UUID'ler) 120 karakter siniri icinde kalabilir.
- **Kanit:**
  ```typescript
  // Satir 123-128
  const truncateForHistory = (query: string): string => {
    const MAX_PREVIEW = 120;
    const trimmed = query.trim();
    if (trimmed.length <= MAX_PREVIEW) return trimmed;
    return trimmed.substring(0, MAX_PREVIEW) + '...';
  };
  ```
  Ornek: `SELECT * FROM auth.users WHERE email = 'admin@example.com'` -- 57 karakter, truncation'a takiilmaz.
- **Etki:** Dusuk. Admin paneli zaten SUPER_ADMIN erisimli. Ancak paylasilan bilgisayarlarda localStorage'daki sorgular gorulebilir.
- **Onerilen Fix:** `sessionStorage` kullan (sekme kapaninca silinir). Veya WHERE clause degerlerini maskelemeden once kaydet.
- **Effort:** S

### LOW-005: pg_sleep DoS ve current_setting Config Leak

- **Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:814-834`
- **Kontrol:** B6
- **Aciklama:** `dangerousFunctions` listesinde `pg_sleep` ve `current_setting` bulunmuyor. `statement_timeout = 30s` (satir 852) sayesinde `pg_sleep` etkisi sinirli, ancak es zamanli sorgularla hala etkili bir DoS vektoru olusturabilir. `current_setting()` ile DB konfigurasyonu okunabilir (ornegin `current_setting('log_directory')`, `current_setting('data_directory')`).
- **Kanit:**
  ```typescript
  // dangerousFunctions listesi (satir 814-833):
  // pg_sleep ve current_setting LISTEDE YOK
  ```
  Saldirgan: `SELECT pg_sleep(29)` -- 30s timeout'a yakin, connection'i mesgul eder.
  Saldirgan: `SELECT current_setting('data_directory')` -- dosya sistemi yolunu ifsa eder.
- **Etki:** Dusuk-orta. statement_timeout riski azaltir. current_setting bilgi sizintisi olusturur.
- **Onerilen Fix:** `dangerousFunctions` listesine `/\bpg_sleep\b/i` ve `/\bcurrent_setting\b/i` ekle.
- **Effort:** S

---

## Spawn Talepleri

1. **DEEP-SQL-001:** Raw SQL endpoint'inin tum bypass senaryolarini (stacked queries, Unicode normalization, encoding tricks) kapsamli sekilde test eden bir pentest spawn'i.
2. **DEEP-AUTH-001:** Tum controller'lardaki `createdBy/updatedBy/cancelledBy` gibi client-supplied identity alanlarinin tam envanterini cikarip JWT-based identity ile degistiren bir fix spawn'i.
3. **DEEP-PROVISION-001:** `@Public() GET /system/settings/provisioning-config` endpoint'inin dondurdugu verilerin (mqttBrokerHost, githubRepo vb.) hassasiyet analizini yapan bir spawn.

---

## Celiskiler

### P2 Raporu ile Uyum
- P2 raporu DebugToolsController'daki `@Query('adminId')` sorununu dogru tespit etmis (bulgular bolumu #1). Bu rapor dogrulamaktadir.
- P2 raporu ThrottlerGuard kaldirilmasini dogru tespit etmis (#4). Bu rapor dogrulamaktadir.
- P2 raporu raw SQL endpoint'ini "production'da bloke" olarak belirtmis (#5). Bu rapor CRUD endpoint'lerinin ortam kontrolu olmadigini EK olarak tespit etmistir.
- P2 raporu `GET /system/settings/provisioning-config` icin `@Public()` endisesini belirtmis (#6). Bu rapor endpoint'in mqtt, github gibi altyapi bilgilerini ifsa ettigini dogrulamaktadir.

### P3 Raporu ile Uyum
- P3 raporu `QueryEditor.tsx` `{ schema, query }` vs backend `{ sql, params }` FIELD_MISMATCH sorununu dogru tespit etmis (#1). Bu bir guvenlik bulgusu degil, islevsellik bulgusudur -- sorgu motoru kirik. Ironik olarak bu FIELD_MISMATCH, raw SQL endpoint'inin frontend'den kullanilamaz olmasini saglayarak kazara bir guvenlik katmani olusturmaktadir.

---

## Oneriler

### Oncelik 1 (Hemen)
1. Raw SQL endpoint'ine `SET`, `DO`, `set_config`, `pg_sleep`, `current_setting` bloklari ekle (CRITICAL-001, CRITICAL-002, LOW-005)
2. DebugToolsController'da `@Query('adminId')` yerine `req.user.id` kullan (HIGH-001)
3. `includeSensitive` parametresini kaldir veya ek yetkilendirme mekanizmasi ekle (HIGH-002)
4. CRUD endpoint'lerine ortam kontrolu ekle (HIGH-005)

### Oncelik 2 (Sprint icinde)
1. `pg_catalog`/`information_schema` erisimini engelle (HIGH-004)
2. Hassas endpoint'lere per-route throttle ekle (MEDIUM-001)
3. Bulk IP endpoint'lerine DTO validation ve array size limit ekle (MEDIUM-003)
4. Client-supplied `createdBy` alanlarini JWT identity ile degistir (MEDIUM-004)

### Oncelik 3 (Sonraki sprint)
1. Raw SQL icin read-only DB kullanicisi olustur
2. `NODE_ENV` yerine explicit feature flag (`ENABLE_RAW_SQL_EXPLORER`) kullan (CRITICAL-003)
3. CSRF token middleware ekle veya `credentials: 'include'` kullanimini gozden gecir (MEDIUM-006)
4. localStorage yerine sessionStorage kullan (LOW-004)
