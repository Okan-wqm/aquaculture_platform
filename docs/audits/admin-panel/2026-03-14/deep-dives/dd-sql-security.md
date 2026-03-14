# Deep Dive: Database Explorer SQL Guvenlik Bypass Vektorleri

**Tarih:** 2026-03-14
**Tetikleyen:** P5 Guvenlik Raporu (CRITICAL-001, CRITICAL-002, CRITICAL-003, HIGH-005)
**Kapsam:** `explorer.controller.ts` -- raw SQL endpoint + CRUD endpoint'leri
**Hedef Dosya:** `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`

---

## 1. Blocked Statements Listesi (Tam Envanter)

### 1a. dangerousStatements (satir 793-805)

```typescript
// explorer.controller.ts:793-805
const dangerousStatements = [
  /\bDROP\b/i,        // satir 794
  /\bDELETE\b/i,      // satir 795
  /\bTRUNCATE\b/i,    // satir 796
  /\bINSERT\b/i,      // satir 797
  /\bUPDATE\b/i,      // satir 798
  /\bALTER\b/i,       // satir 799
  /\bCREATE\b/i,      // satir 800
  /\bGRANT\b/i,       // satir 801
  /\bREVOKE\b/i,      // satir 802
  /\bEXEC(UTE)?\b/i,  // satir 803
  /\bCALL\b/i,         // satir 804
];
```

**EKSIK olanlar:** `SET`, `DO`, `COPY` (sadece `copy to`/`copy from` fonksiyon olarak var), `LISTEN`, `NOTIFY`, `PREPARE`, `DEALLOCATE`, `DISCARD`, `RESET`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `LOCK`, `VACUUM`, `ANALYZE`, `CLUSTER`, `REINDEX`, `COMMENT`, `SECURITY LABEL`.

### 1b. dangerousFunctions (satir 814-828)

```typescript
// explorer.controller.ts:814-828
const dangerousFunctions = [
  /\bpg_read_file\b/i,        // satir 815
  /\bpg_read_binary_file\b/i, // satir 816
  /\bpg_write_file\b/i,       // satir 817
  /\bpg_ls_dir\b/i,           // satir 818
  /\bpg_stat_file\b/i,        // satir 819
  /\bpg_terminate_backend\b/i,// satir 820
  /\bpg_cancel_backend\b/i,   // satir 821
  /\bpg_reload_conf\b/i,      // satir 822
  /\blo_import\b/i,           // satir 823
  /\blo_export\b/i,           // satir 824
  /\bcopy\s+to\b/i,           // satir 825
  /\bcopy\s+from\b/i,         // satir 826
  /\bdblink\b/i,              // satir 827
];
```

**EKSIK olanlar:** `set_config`, `current_setting`, `pg_sleep`, `pg_advisory_lock`, `pg_notify`, `pg_catalog.pg_shadow`, `query_to_xml`, `xpath`, `pg_execute_server_program`, `inet_server_addr`, `pg_postmaster_start_time`, `pg_conf_load_time`, `txid_current`.

### 1c. blockedSchemas (satir 837)

```typescript
// explorer.controller.ts:837
const blockedSchemas = ['sensor', 'farm', 'hr', 'hydroponics'];
```

**EKSIK olanlar:** `pg_catalog`, `information_schema`, `pg_toast`, `pg_temp_*`.

---

## 2. CRITICAL-001: SET search_path / set_config() Bypass

### Dogrulama: DOGRULANDI

`SET` keyword'u `dangerousStatements` listesinde **YOK** (satir 793-805).
`set_config` fonksiyonu `dangerousFunctions` listesinde **YOK** (satir 814-828).

### Exploit Senaryosu

**Adim 1:** search_path'i degistir (fonksiyon yoluyla, SELECT ile baslar):
```sql
SELECT set_config('search_path', 'tenant_abc123,public', true)
```
- `normalizedSql.startsWith('SELECT')` --> GECTI (satir 788)
- `dangerousStatements` --> `set_config` icinde SET var ama `\bSET\b` regex'i `set_config` icindeki "set" ile eslesir MI? HAYIR -- `set_config` kelimesinde "set" kismini `\b` (word boundary) ile ayirir. `set` ile `_` arasinda word boundary VAR cunku `\b` alfanumerik ile `_` arasini ayirmaz -- aslinda `_` word character'dir, dolayisiyla `set` ve `config` arasinda `_` oldugu icin `\bSET\b` paterni `set_config` icindeki `set` ile eslesmez. DOGRULANDI: `set_config` bypass eder.

Ek dogrulama: `\bSET\b` regex'i yalnizca "SET" kelimesini tek basina yakalar. `set_config(...)` fonksiyon cagrisinda `set` kelimesi `_config` ile birlesik oldugu icin `\b` word boundary `set_` arasinda tetiklenmez (`_` word character'dir).

**Adim 2:** Ikinci istekte tenant verilerine eris:
```sql
SELECT * FROM users
```
Bu sorgu artik `tenant_abc123.users` tablosuna yonelir cunku search_path degismis.

**ANCAK**: QueryRunner'in session scope'u onemli. `queryRunner.release()` (satir 863) connection'i pool'a geri dondurur. Ayni connection yeniden alinirsa search_path hala degismis olabilir. `set_config(..., true)` **local** (transaction-scope) ayarlar, connection-level degil. `set_config(..., false)` ise **session-level** ayarlar ve pool'a geri donerken kalici kalir.

**Gercek risk:**
- `set_config('search_path', 'tenant_abc123', false)` --> session-level, pool'daki diger istekleri de etkiler
- `set_config('search_path', 'tenant_abc123', true)` --> transaction-scope, yalnizca mevcut transaction icinde gecerli; ancak `executeQuery` method'u explicit transaction acmiyor, bu yuzden davranis PostgreSQL driver implementasyonuna baglidir

**Alternatif bypass -- saf SET komutu:**
SET komutu SELECT ile baslamaz, dolayisiyla `startsWith('SELECT')` kontrolune takilir. Ancak:
```sql
SELECT 1; SET search_path TO tenant_abc123
```
Bu multi-statement gerektirir. TypeORM `queryRunner.query()` node-postgres (`pg`) driver'ini kullanir. `pg` driver'i varsayilan olarak **multi-statement destekler** -- tek bir `query()` cagrisinda `;` ile ayrilmis birden fazla statement calistirilabilir. Bu, CRITICAL bir risktir.

**Multi-statement dogrulamasi:** `explorer.controller.ts` icinde `;` (semicolon) kontrolu **YOK**. Karsilastirma icin ayni servisin `database-monitoring.service.ts:303-305` dosyasinda semicolon acikca yasaklanmis:
```typescript
// database-monitoring.service.ts:303-305
if (query.includes(';')) {
  return { valid: false, error: 'Semicolons are not allowed in queries' };
}
```
Explorer controller'da bu kontrol **MEVCUT DEGIL**.

### Risk Degerlendirmesi: CRITICAL

Multi-statement destegi + semicolon kontrolu olmamasi + SET/set_config bloke edilmemesi = tam tenant izolasyonu kirma.

### Fix Onerisi

1. `dangerousStatements` listesine ekle: `/\bSET\b/i`
2. `dangerousFunctions` listesine ekle: `/\bset_config\b/i`
3. **Semicolon'u yasakla** (en etkili tek onlem):
```typescript
if (sqlWithoutComments.includes(';')) {
  throw new BadRequestException('Semicolons are not allowed in queries');
}
```
4. Her `executeQuery` cagrisinda `SET search_path TO public,auth,admin,billing` zorunlu olarak calistir (defense-in-depth).

---

## 3. CRITICAL-002: DO $$ Anonymous Block Bypass

### Dogrulama: KISMI DOGRULANDI

`DO` keyword'u ne `dangerousStatements` listesinde (satir 793-805) ne de `startsWith` kontrolunde (satir 788).

### Exploit Senaryosu

**Senaryo A -- Dogrudan DO blogu:**
```sql
DO $$ BEGIN EXECUTE 'DROP TABLE auth.users'; END $$;
```
- `normalizedSql.startsWith('SELECT')` --> BASARISIZ, `DO` ile basliyor
- Bu senaryo `startsWith` kontrolune takilir. **BLOKE EDILIR.**

**Senaryo B -- SELECT + multi-statement DO:**
```sql
SELECT 1; DO $$ BEGIN EXECUTE 'DROP TABLE auth.users'; END $$;
```
- `normalizedSql.startsWith('SELECT')` --> GECTI
- `dangerousStatements` --> `DO` listede yok, `DROP` ve `EXECUTE` `$$` icinde string literal olarak --> HAYIR, regex comment temizlemesinden sonra tum metin uzerinde calisir. `DROP` kelimesi `EXECUTE 'DROP TABLE...'` icinde mevcuttur:
  - `/\bDROP\b/i.test("SELECT 1; DO $$ BEGIN EXECUTE 'DROP TABLE auth.users'; END $$;")` --> **TRUE**
  - `DROP` keyword'u string literal icinde olsa bile regex tum metni tarar. **BLOKE EDILIR.**

**Senaryo C -- DO blogu icinde encoded/obfuscated komut:**
```sql
SELECT 1; DO $$ BEGIN EXECUTE chr(68)||chr(82)||chr(79)||chr(80)||' TABLE auth.users'; END $$;
```
- `startsWith('SELECT')` --> GECTI
- `dangerousStatements` --> `DROP` kelimesi metinde yok, `chr()` ile olusturuluyor --> TESPITSIZ
- `EXECUTE` keyword'u var: `/\bEXEC(UTE)?\b/i` --> **TRUE**, BLOKE EDILIR

**Senaryo D -- DO blogu icinde PERFORM (EXEC/EXECUTE olmadan):**
```sql
SELECT 1; DO $$ BEGIN PERFORM set_config('search_path','tenant_abc',false); END $$;
```
- `startsWith('SELECT')` --> GECTI
- `dangerousStatements` --> `PERFORM` listede yok, `SET` listede yok
- `dangerousFunctions` --> `set_config` listede yok
- Semicolon kontrolu yok
- **BYPASS BASARILI** (multi-statement destegi gerekli)

### Risk Degerlendirmesi: HIGH (multi-statement gerekli)

DO blogu dogrudan kullanilamaz (startsWith kontrolu), ama multi-statement ile birlestirildiqinde ve PERFORM kullanildiginda bypass mumkun.

### Fix Onerisi

1. Semicolon'u yasakla (Senaryo B, C, D'yi tamamen onler)
2. `dangerousStatements` listesine ekle: `/\bDO\b\s*\$/i`, `/\bPERFORM\b/i`
3. `dangerousFunctions` listesine ekle: `/\bset_config\b/i`
4. `$` ve `$$` karakter dizisini yasakla (dollar-quoting onleme)

---

## 4. CRITICAL-003: NODE_ENV Tek Savunma Hatti

### Dogrulama: DOGRULANDI

```typescript
// explorer.controller.ts:767-771
if (process.env['NODE_ENV'] === 'production') {
  throw new BadRequestException(
    'Raw SQL queries are disabled in production for security reasons',
  );
}
```

### Analiz

Docker compose dosyalarindan dogrulama:
- `docker-compose.yml` (dev): `NODE_ENV: development` -- raw SQL ACIK
- `docker-compose.dev.yml`: `NODE_ENV: development` -- raw SQL ACIK
- `docker-compose.watch.yml`: `NODE_ENV=development` -- raw SQL ACIK
- `docker-compose.prod.yml`: `NODE_ENV: production` -- raw SQL KAPALI
- `docker-compose.droplet.yml`: `NODE_ENV: production` -- raw SQL KAPALI

**Risk 1:** `NODE_ENV` set edilmezse `undefined !== 'production'` --> raw SQL ACIK. Strict equality (`===`) kullanildigi icin sadece tam eslesme calisir.

**Risk 2:** Staging ortami icin ayri bir compose dosyasi gorunmuyor. Staging genellikle `NODE_ENV=staging` veya `NODE_ENV=development` ile calisir -- her iki durumda da raw SQL ACIK.

**Risk 3:** Container baslatilirken `NODE_ENV` env var'i atlanirsa (ornegin `docker run` ile), sessizce raw SQL acik kalir.

### Fix Onerisi

1. Mantigi ters cevir -- whitelist yaklasimi:
```typescript
const ALLOW_RAW_SQL = process.env['ENABLE_RAW_SQL_EXPLORER'] === 'true';
if (!ALLOW_RAW_SQL) {
  throw new BadRequestException('Raw SQL queries are disabled');
}
```
2. Varsayilan olarak KAPALI, sadece explicit `ENABLE_RAW_SQL_EXPLORER=true` ile acilsin.
3. CRUD endpoint'lerine de ayni kontrolu ekle (bkz. bolum 5).

---

## 5. HIGH-005: CRUD Endpoint'leri -- Ortam Kontrolu Yok

### Dogrulama: DOGRULANDI

Uc CRUD endpoint'i hicbir ortam kontrolu icermez:

| Endpoint | Satir | NODE_ENV Kontrolu | Guard |
|----------|-------|-------------------|-------|
| `POST .../rows` (INSERT) | 542 | YOK | PlatformAdminGuard |
| `PUT .../rows/:id` (UPDATE) | 589 | YOK | PlatformAdminGuard |
| `DELETE .../rows/:id` (DELETE) | 647 | YOK | PlatformAdminGuard |

Karsilastirma:
| Endpoint | Satir | NODE_ENV Kontrolu |
|----------|-------|-------------------|
| `POST /query` (raw SQL) | 767 | `=== 'production'` kontrolu VAR |

### Exploit Senaryosu

Production ortaminda, gecerli SUPER_ADMIN JWT token'i ile:

**Adim 1:** Admin kullanici olustur:
```
POST /database/explorer/schemas/auth/tables/users/rows
Body: { "data": { "email": "attacker@evil.com", "role": "SUPER_ADMIN", "password_hash": "$2b$10$..." } }
```

**Adim 2:** Billing kayitlarini manipule et:
```
PUT /database/explorer/schemas/billing/tables/subscriptions/rows/{id}
Body: { "data": { "planTier": "enterprise", "status": "active" } }
```

**Adim 3:** Audit log'lari sil:
```
DELETE /database/explorer/schemas/admin/tables/audit_logs/rows/{id}
```

### Koruma Analizi

Mevcut korumalar:
1. `PlatformAdminGuard` (controller-level, satir 230) -- JWT + SUPER_ADMIN/PLATFORM_ADMIN rol kontrolu
2. `validateExplorerAccess` (satir 243-250) -- schema ve tablo whitelist kontrolu
3. `isValidIdentifier` (satir 951-954) -- SQL injection onleme

Eksik korumalar:
1. NODE_ENV kontrolu YOK
2. Feature flag kontrolu YOK
3. Per-route throttle YOK
4. Confirmation/MFA kontrolu YOK

### Fix Onerisi

1. Her CRUD method'un basina ortam kontrolu ekle:
```typescript
private assertWriteAccess(): void {
  const allowWrites = process.env['ENABLE_DB_EXPLORER_WRITES'] === 'true';
  if (!allowWrites) {
    throw new BadRequestException('Database write operations are disabled');
  }
}
```
2. Varsayilan: KAPALI. Yalnizca dev ortaminda `ENABLE_DB_EXPLORER_WRITES=true` ile acilsin.
3. Production compose dosyalarinda bu env var'i TANIMLAMAYIN.

---

## 6. Ek Bypass Vektorleri

### 6a. information_schema ve pg_catalog Erisimi

**Durum:** ENGELLENMEMIS

```typescript
// explorer.controller.ts:837
const blockedSchemas = ['sensor', 'farm', 'hr', 'hydroponics'];
// pg_catalog ve information_schema YOK
```

**Exploit:**
```sql
SELECT rolname, rolpassword FROM pg_catalog.pg_authid
```
- `startsWith('SELECT')` --> GECTI
- `blockedSchemas` kontrolu `pg_catalog` icermiyor --> GECTI
- Sonuc: PostgreSQL kullanici adi ve sifre hash'leri ifsa

```sql
SELECT * FROM information_schema.columns WHERE table_schema LIKE 'tenant_%'
```
- `tenant_[a-f0-9]` regex kontrolu (satir 843) `information_schema.columns` tablosundaki VERI icindeki `table_schema` degerini kontrol ETMEZ -- yalnizca SQL metnindeki `tenant_` referansini kontrol eder
- Sonuc: Tum tenant schemalarinin tablo ve sutun yapisi ifsa

**Fix:** `blockedSchemas` listesine `pg_catalog` ve `information_schema` ekle. Veya whitelist yaklasimi: yalnizca `ALLOWED_SCHEMAS` icindeki schemalara referans ver.

### 6b. pg_sleep DoS Vektoru

**Durum:** ENGELLENMEMIS ama `statement_timeout` ile azaltilmis

```sql
SELECT pg_sleep(29)
```
- `dangerousFunctions` listesinde `pg_sleep` YOK
- `statement_timeout = 30000` (satir 852) sayesinde max 30s
- Ancak throttle olmadigi icin (ThrottlerGuard kaldirilmis) paralel 100 istek = 100 connection 30s mesgul = connection pool tukenmesi

**Fix:** `dangerousFunctions` listesine `/\bpg_sleep\b/i` ekle.

### 6c. current_setting ile Konfigrasyon Sizintisi

**Durum:** ENGELLENMEMIS

```sql
SELECT current_setting('data_directory')
SELECT current_setting('log_directory')
SELECT current_setting('hba_file')
SELECT current_setting('config_file')
SELECT current_setting('ssl_cert_file')
```

Tum bu sorgular sunucu dosya sistemi yollarini ifsa eder.

**Fix:** `dangerousFunctions` listesine `/\bcurrent_setting\b/i` ekle.

### 6d. Nested Comment Bypass

**Durum:** TEORIK RISK, PRATIK ETKI DUSUK

```typescript
// explorer.controller.ts:782-784
const sqlWithoutComments = sql
  .replace(/\/\*[\s\S]*?\*\//g, '') // lazy match
  .replace(/--.*$/gm, '');
```

PostgreSQL nested comment'leri destekler: `/* outer /* inner */ still comment */`. Regex lazy match (`*?`) ilk `*/`'da durur ve kalan metni birakir. Ancak test edilen cogu bypass denemesi syntax error olusturur veya keyword'ler gorunur hale gelir (bu durumda `dangerousStatements` tarafindan yakalanir).

**Fix:** `/*` ve `*/` karakterlerini tamamen yasakla veya iteratif nested comment parser kullan.

### 6e. Unicode Normalization / Encoding Tricks

PostgreSQL, identifier'larda Unicode destekler. Ancak `explorer.controller.ts`'deki regex'ler JavaScript'in `\b` word boundary ve `\i` case-insensitive flag'leri ile calisir. JavaScript regex motoru Unicode normalization yapmaz, bu yuzden `\u0053ELECT` (Unicode S + ELECT) gibi bir bypass mumkun degildir -- JavaScript string'leri zaten UTF-16'dir ve `\b` ASCII word boundary kullanir. **Risk dusuk.**

### 6f. COPY Komutu (Standalone)

**Durum:** KISMI ENGELLENMIS

`copy to` ve `copy from` engellenmis (satir 825-826). Ancak `COPY (SELECT ...) TO STDOUT` formati kontrol edilmemis:
```sql
SELECT 1; COPY (SELECT * FROM auth.users) TO STDOUT
```
- Multi-statement gerekli (semicolon kontrolu yok)
- `copy to` regex'i `COPY (...)  TO` ile eslesir mi? `/\bcopy\s+to\b/i` --> `COPY (SELECT...) TO` icinde `copy` ile `to` arasinda `(SELECT...)` var, `\s+` ile eslesmez --> **BYPASS BASARILI**

**Fix:** Semicolon yasakla. `/\bCOPY\b/i` olarak genislet.

---

## 7. Multi-Statement: En Kritik Tek Zafiyet

Tum bypass senaryolarinin cogu **multi-statement** (semicolon ile statement zincirleme) yetenegi gerektirir. Explorer controller'da semicolon kontrolu **MEVCUT DEGIL**.

Karsilastirma olarak ayni servisteki `database-monitoring.service.ts:303-305`:
```typescript
// database-monitoring.service.ts:303-305
if (query.includes(';')) {
  return { valid: false, error: 'Semicolons are not allowed in queries' };
}
```

Bu kontrol explorer controller'a da eklenirse, CRITICAL-001'in multi-statement vektoru, CRITICAL-002'nin tum senaryolari ve 6f COPY bypass'i tamamen kapatilir.

**Tek satirlik fix (en yuksek etki/effort orani):**
```typescript
// explorer.controller.ts:791 (normalizedSql taniminin hemen altina)
if (sqlWithoutComments.includes(';')) {
  throw new BadRequestException('Semicolons are not allowed in queries');
}
```

---

## 8. Ozet Tablo

| Bulgu | P5 ID | Dogrulandi? | Multi-stmt Gerekli? | Tek Semicolon Fix Yeterli? |
|-------|-------|-------------|---------------------|---------------------------|
| SET search_path via set_config() | CRITICAL-001 | EVET | Hayir (tek SELECT yeterli) | HAYIR -- set_config ayriyetten bloklanmali |
| SET search_path via SET komutu | CRITICAL-001 | EVET | EVET | EVET |
| DO $$ anonymous block | CRITICAL-002 | KISMI | EVET | EVET |
| NODE_ENV tek savunma | CRITICAL-003 | EVET | N/A | N/A |
| CRUD ortam kontrolu yok | HIGH-005 | EVET | N/A | N/A |
| pg_catalog/information_schema | HIGH-004 | EVET | Hayir | HAYIR |
| pg_sleep DoS | LOW-005 | EVET | Hayir | HAYIR |
| current_setting leak | LOW-005 | EVET | Hayir | HAYIR |
| COPY bypass | Yeni | EVET | EVET | EVET |
| Nested comment | HIGH-003 | DUSUK | Hayir | HAYIR |

---

## 9. Oncelikli Fix Plani

### Faz 1 -- Acil (1 saat)
1. **Semicolon yasagi ekle** (satir ~791, tum multi-statement vektorlerini kapatir)
2. **`set_config` ve `current_setting` fonksiyonlarini blokla** (dangerousFunctions listesine ekle)
3. **`pg_sleep` fonksiyonunu blokla** (dangerousFunctions listesine ekle)
4. **`SET` keyword'unu blokla** (dangerousStatements listesine ekle)

### Faz 2 -- Sprint icinde (yarim gun)
5. **`pg_catalog` ve `information_schema` schema'larini blokla** (blockedSchemas listesine ekle)
6. **CRUD endpoint'lerine ortam kontrolu ekle** (feature flag ile, varsayilan KAPALI)
7. **Raw SQL endpoint'ini feature flag ile kontrol et** (NODE_ENV'e ek olarak)
8. **`DO`, `PERFORM`, `PREPARE` keyword'lerini blokla** (defense-in-depth)
9. **`COPY` keyword'unu genislet** (`/\bCOPY\b/i` olarak)

### Faz 3 -- Sonraki sprint
10. **Read-only DB kullanicisi olustur** (en guclu izolasyon)
11. **Per-route throttle ekle** (raw SQL: 1/5s, CRUD: 10/min, export: 1/30s)
12. **`includeSensitive` parametresini kaldir veya ek yetkilendirme ekle**
13. **Nested comment parser** uygula veya `/*` `*/` tamamen yasakla
