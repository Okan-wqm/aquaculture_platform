# D12 - Backend-Common Shared Infrastructure Audit

**Auditor:** D12 - Shared Infrastructure Expert
**Tarih:** 2026-03-14
**Kapsam:** `libs/backend-common/src/` -- tum backend servislerin bagimli oldugu paylasimli kutuphane
**Durum:** TAMAMLANDI

---

## 1. Yonetici Ozeti

`backend-common` kutuphanesi, platformun multi-tenant altyapisinin temel tasiyicisidir. SchemaManagerService ile tenant schema isolation, TenantGuard/RolesGuard ile erisim kontrolu, RedisService ile cache yonetimi, ve kapsamli guvenlik modulu (rate limiting, token blacklist, session manager, IDOR, input sanitization) saglayarak 10+ backend servisin ortak ihtiyaclarini karsilar.

**Genel Degerlendirme:** Olgunluk seviyesi YUKSEK. SQL injection onleme, advisory lock ile race condition korumalari, parametrize sorgular, ve kapsamli test coverage mevcut. Ancak bazi kritik servisler TenantGuard'i global olarak kaydetmemistir ve birkac mimari zayiflik tespit edilmistir.

### Kritik Bulgular Tablosu

| # | Bulgu | Ciddiyet | Kategori |
|---|-------|----------|----------|
| F-01 | 5 servis TenantGuard'i global APP_GUARD olarak kaydetmemis | YUKSEK | Guard Bypass |
| F-02 | SlidingWindowStrategy uretimde in-memory, dagitik rate limiting yok | ORTA | Rate Limiting |
| F-03 | setTenantSearchPath connection-pool race condition riski (transaction disinda) | ORTA | Schema Isolation |
| F-04 | TenantGuard kimlik dogrulanmamis istekleri tenant ID ile geciriyor | ORTA | Guard Logic |
| F-05 | Exception filter fragmentasyonu - 3 farkli hata formati | DUSUK | Standardizasyon |
| F-06 | @Cacheable cache key'lerinde tenant prefix zorunlulugu yok | ORTA | Redis Key Collision |
| F-07 | SchemaManagerService 1670 satir - tek dosyada cok fazla sorumluluk | DUSUK | Mimari Borc |
| F-08 | IdorGuard opt-in davranisi - @IdorCheck olmayan route'lar korumasiz | DUSUK | IDOR |

---

## 2. SchemaManagerService - Detayli Analiz

### 2.1 Dosya Konumu ve Boyut
- **Dosya:** `libs/backend-common/src/database/schema-manager.service.ts`
- **Satir Sayisi:** ~1670 satir (tek dosya icinde cok fazla sorumluluk)
- **TODO yorumu:** Dosyanin basinda 5 alt servise bolunmesi onerilmis ama uygulanmamis

### 2.2 MODULE_SCHEMAS Kaydi

4 modul tanimli, toplam tablo sayilari:

| Modul | Tablo Sayisi | Reference Data Tablosu | Source Schema |
|-------|-------------|----------------------|---------------|
| sensor | 27 | 3 (sensor_protocols, sensor_type_definitions, industry_templates) | sensor |
| farm | 56 | 5 (equipment_types, sub_equipment_types, supplier_types, chemical_types, feed_types) | farm |
| hr | 20 | 3 (leave_types, certification_types, shifts) | hr |
| hydroponics | 1 | 0 | hydroponics |

**Toplam:** 104 tablo 4 modul arasinda dagitilmis.

**BAKIM SOZLESMESI:** Her yeni TypeORM entity eklediginde, tablo adinin MODULE_SCHEMAS'a eklenmesi ZORUNLU. Aksi halde tenant provisioning sirasinda tablo olusturulmaz ve runtime'da "table does not exist" hatasi alinir. Bu el ile senkronizasyon onemli bir hata kaynagidir.

### 2.3 Tenant Schema Adlandirma

```typescript
getTenantSchemaName(tenantId: string): string {
  // UUID formati dogrulama (SQL injection onleme)
  const uuidRegex = /^[0-9a-f]{8}-...$/i;
  // tenant_ + UUID'nin ilk 16 hex karakteri
  const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
  return `tenant_${cleanId}`;
}
```

**Analiz:**
- UUID dogrulama SQL injection'i onler -- OLUMLU
- 16 hex karakter = 2^64 kombinasyon, carpisma riski ihmal edilebilir
- Case-insensitive (lowercase donusum) -- OLUMLU
- `validateSqlIdentifier()` ile ek koruma katmani -- OLUMLU

### 2.4 Schema Olusturma Akisi (createTenantSchema)

```
1. UUID dogrulama ve schema adi uretimi
2. isValidSchemaName() ile ek dogrulama
3. pg_advisory_lock ile mutex kilidi
4. Schema varligini kontrol (idempotent)
5. CREATE SCHEMA "tenant_xxx"
6. Her modul icin: CREATE TABLE ... (LIKE source.table INCLUDING ALL)
7. TimescaleDB hypertable donusumu (sensor_readings, sensor_metrics)
8. Reference data kopyalama
9. GRANT USAGE/ALL PRIVILEGES
10. pg_advisory_unlock (finally blogu icinde)
```

**Olumlu Noktalar:**
- Advisory lock ile race condition onleme
- Idempotent tasarim (tekrar cagrilabilir)
- Hata durumunda DROP SCHEMA CASCADE ile temizlik
- `finally` blogunda lock serbest birakma garantisi
- validateSqlIdentifier() ile tum identifier'lar dogrulanmis
- ProvisioningStatus enum'u ile COMPLETE/PARTIAL/FAILED ayrimi

**[F-03] Connection-Pool Race Condition:**
`setTenantSearchPath()` metodu connection-level search_path ayarlar. TypeORM connection pool ortaminda, ayni connection'un bir sonraki sorguyu baska bir tenant icin kullanmasi mumkundur.

```typescript
// RISKLI (pool'da connection paylasimi)
async setTenantSearchPath(tenantId: string): Promise<void> {
  await this.dataSource.query(
    `SELECT pg_catalog.set_config('search_path', $1 || ', public', false)`,
    [schemaName],
  );
}
```

**Duzeltme:** `setTenantSearchPathInTransaction()` transaction-scoped (`is_local=true`) versiyon mevcut ve `TenantAwareRepository.executeRaw()` bunu kullanmaktadir. Ancak tek basina `setTenantSearchPath()` metodunun varliginin tehlikeli oldugu belgelenmis olmasina ragmen, bu metod servisler tarafindan hala cagirilabilir durumda.

### 2.5 Schema Cache (LRU)

```typescript
class SchemaLRUCache {
  maxSize = 1000;   // Maks 1000 giris
  ttlMs = 5 * 60 * 1000; // 5 dakika TTL
}
```

- In-process cache, multi-instance'da pod'lar arasi senkronizasyon yok
- Dokumasyon bunu kabul edilebilir olarak isaretlemis (schema olusturma seyrek)
- False-negative: sadece ek bir DB round-trip
- False-positive: DB seviyesinde "schema not found" hatasi -- guvenli

### 2.6 syncTenantSchema

Mevcut tenant schema'lara eksik tabloları ekleyen idempotent metod. Yeni entity'ler eklendikten sonra mevcut tenant'larin guncellenmesi icin kullanilir. Her tabloyu `tableExists()` ile kontrol eder, yalnizca eksik olanlari olusturur.

### 2.7 Test Coverage

`schema-manager.spec.ts` dosyasi 921 satir, kapsamli test senaryolari:
- Schema adi uretimi (UUID dogrulama, case handling, SQL injection)
- Schema varlik kontrolleri (cache, cache bypass)
- Schema olusturma (advisory lock, idempotent, rollback)
- Reference data kopyalama
- TimescaleDB hypertable
- Schema silme
- Migration

---

## 3. Redis Analizi

### 3.1 RedisService

**Dosya:** `libs/backend-common/src/redis/redis.service.ts`

| Metod | Analiz |
|-------|--------|
| `prefixKey()` | Tum key'lere `aqua:` prefix ekler -- OLUMLU |
| `keys()` | SCAN tabanli implementasyon (blocking KEYS degil) -- OLUMLU |
| `deletePattern()` | SCAN + batched DEL -- OLUMLU |
| `scan()` | Raw ioredis SCAN sarmalayici, PREFIX EKLEMIYOR -- DIKKAT |

**[F-06] Cache Key'lerinde Tenant Prefix Zorunlulugu Yok:**

`@Cacheable` decorator'u ile kullanilan cache key pattern'leri tenant ID'sini icerir, ANCAK bu convention-based ve zorunlu degildir:

```typescript
// Dogru kullanim (tenant-aware):
@Cacheable('tenant:{0}:stats', 1800)
async getTenantStats(tenantId: string): Promise<Stats>

// RISKLI kullanim (tenant bilgisi yok):
@Cacheable('user:{0}', 3600)
async getUser(userId: string): Promise<User>
```

Eger `userId` birden fazla tenant'ta tekrarlanirsa (farkli sistemlerde), cache collision olusabilir. RedisService `aqua:` prefix'i ekler ama bu tenant izolasyonu saglamaz.

**Oneri:** Cache key pattern'lerinde `tenant:` prefix'ini zorunlu kilan bir lint rule veya decorator-level dogrulama eklenmeli.

### 3.2 RedisModule

- `@Global()` decorator ile tum modullerde erisilebilir
- `forRoot()` ve `forRootAsync()` factory method'lari
- Tek Redis instance paylasimi (tenant-aware degil)

### 3.3 `scan()` Metodu Prefix Sorunu

```typescript
async scan(pattern: string, count?: number): Promise<string[]> {
  // BU METOD PREFIX EKLEMIYOR - diger metodlarla tutarsiz
  const result = await this.client.scan('0', 'MATCH', pattern, 'COUNT', count ?? 100);
  return result[1];
}
```

`keys()`, `deletePattern()` ve diger metodlar prefix eklerken, `scan()` metodu ham pattern'i kullanir. Bu tutarsizlik hataya davetiye cikarir.

---

## 4. Guards Analizi

### 4.1 TenantGuard

**Dosya:** `libs/backend-common/src/guards/tenant.guard.ts` (100 satir)

**Tenant ID Cikarma Onceligi:**
1. `request.user.tenantId` (JWT - en yuksek)
2. `x-tenant-id` header
3. `tenantId` query parameter
4. `tenantId` body field

**Guvenlik Kontrolleri:**
- UUID format dogrulama (regex) -- OLUMLU
- JWT tenant ile request tenant karsilastirmasi -- OLUMLU
- `@SkipTenantGuard()` ve `@Public()` destegi -- OLUMLU

**[F-04] Kimlik Dogrulanmamis Istekler:**

```typescript
// Satir 76-80:
if (user) {
  if (user.tenantId !== tenantId) {
    throw new ForbiddenException('User does not belong to this tenant');
  }
}
// user yoksa, tenantId header'dan geliyorsa sorgu gecerli sayiliyor
```

Eger `user` objesi yoksa (JWT dogrulanmamis), guard yalnizca `tenantId`'nin varligini ve UUID formatini kontrol eder. Bu, kimlik dogrulamasi yapilmadan herhangi bir tenant ID ile istek gonderilmesine izin verir. Gateway tarafindan zaten JWT dogrulamasi yapildigindan fiili risk dusuktur, ancak defense-in-depth perspektifinden bu bir zayifliktir.

### 4.2 RolesGuard

**Dosya:** `libs/backend-common/src/guards/roles.guard.ts` (184 satir)

**Olumlu Noktalar:**
- Rol hiyerarsisi destegi (SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER)
- Case-insensitive role matching (uyari ile)
- `@Public()` endpoint bypass
- Generic hata mesajlari (user enumeration onleme)
- `@Roles()` olmayan endpoint'lerde bile authenticated user zorunlulugu

### 4.3 [F-01] Guard Kaydi Eksiklikleri

Servis bazinda TenantGuard ve RolesGuard kayit durumu:

| Servis | TenantGuard | RolesGuard | Not |
|--------|------------|------------|-----|
| sensor-service | APP_GUARD | APP_GUARD | Tam |
| farm-service | APP_GUARD | -- | RolesGuard yok |
| hr-service | -- | APP_GUARD | TenantGuard YOK |
| billing-service | APP_GUARD | -- | RolesGuard yok |
| alert-engine | APP_GUARD | -- | RolesGuard yok |
| ai-service | APP_GUARD | APP_GUARD | Tam |
| hydroponics-service | APP_GUARD | APP_GUARD | Tam |
| gateway-api | -- | -- | AuthGuard + RateLimitGuard (kendi guard'lari) |
| admin-api-service | -- | -- | PlatformAdminGuard (kendi guard'i) |
| auth-service | -- | -- | Bulunamadi |
| config-service | -- | -- | Bulunamadi |
| observability-service | -- | -- | InternalApiGuard (kendi guard'i) |
| event-store-service | -- | -- | InternalApiKeyGuard (main.ts) |

**KRITIK:** `hr-service` TenantGuard'i global olarak kaydetmemis. Bu, HR modulu endpoint'lerinin tenant izolasyonu olmadan erisilebilecegi anlamina gelir. `auth-service` ve `config-service` icin APP_GUARD kaydi bulunamadi (bunlar farkli guard mekanizmalari kullaniyor olabilir).

---

## 5. Decorators Analizi

### 5.1 @Tenant / @OptionalTenant

**Dosya:** `libs/backend-common/src/decorators/tenant.decorator.ts`

- Express ve GraphQL context desteyi
- 4 katmanli tenant ID cikarma (JWT > header > query > body)
- `@OptionalTenant` -- exception firlatmaz, undefined doner
- `@CurrentTenant` deprecated alias korunmus (backward compat)

### 5.2 @CurrentUser / @OptionalCurrentUser

**Dosya:** `libs/backend-common/src/decorators/current-user.decorator.ts`

- `CurrentUserPayload` interface -- JWT yapisi
- Property-level erisim: `@CurrentUser('email')` seklinde alt alan cikarma
- `tenantId: string | null` -- SUPER_ADMIN icin null olabilir
- `role` field deprecated, `roles` array aktif

### 5.3 @Cacheable / @CacheInvalidate / @CacheInvalidatePattern

**Dosya:** `libs/backend-common/src/decorators/cacheable.decorator.ts`

- Key pattern interpolation: `{0}`, `{0.tenantId}` seklinde argument erisimi
- Objeler icin otomatik key uretimi (id > tenantId > JSON hash)
- `skipCache` callback -- null/empty sonuclari cache'lememe
- RedisService bulunamazsa sessizce original method'u calistirir (warn logu)
- `warnedClasses` Set ile tekrarlanan uyarilari onler

**Olumlu:** Redis hatalarinda fallback (grace degradation), original method calistirilir.

### 5.4 @Roles ve Yardimci Decorator'lar

- `@Roles(Role.ADMIN, Role.MANAGER)` -- birden fazla rol destegi
- `@SuperAdminOnly()` -- kisa yol
- `@TenantAdminOrHigher()` -- hiyerarsik kisa yol
- `@ModuleManagerOrHigher()` -- hiyerarsik kisa yol
- `@SkipTenantGuard()` -- tenant dogrulamasini atlama
- `@Public()` -- hem RolesGuard hem TenantGuard'i atlama (iki metadata birden set eder)

---

## 6. Filters Analizi

### 6.1 [F-05] Exception Filter Fragmentasyonu

**Dosya:** `libs/backend-common/src/filters/http-exception.filter.ts`

Dosyada 3 farkli exception filter tanimli:

| Filter | @Catch | Kapsam | Response Format |
|--------|--------|--------|----------------|
| `HttpExceptionFilter` | `HttpException` | REST only | `{ statusCode, timestamp, path, method, message, error, details, correlationId, tenantId }` |
| `AllExceptionsFilter` | `()` catch-all | REST + GraphQL | `{ statusCode, timestamp, path, method, message, correlationId, tenantId }` |
| `GraphQLExceptionFilter` | `()` catch-all | GraphQL only | `GraphQLError { extensions: { code, statusCode, timestamp, correlationId, tenantId, details } }` |

**Sorunlar:**
- `libs/shared` icinde ayrica `GlobalExceptionFilter` var, farkli response envelope: `{ success, error: { code, message, details } }`
- 6 servis hala bu dosyadaki eski filter'lari kullaniyor (auth, config, gateway, billing, hr, admin-api)
- Frontend client'lar 2 farkli hata formati handle etmek zorunda

**Olumlu:** Dosyanin basinda migration plani ve etkilenen servisler listesi dokumante edilmis.

---

## 7. Telemetry Analizi

### 7.1 OpenTelemetry Initialization

**Dosya:** `libs/backend-common/src/telemetry/tracing.ts` (49 satir)

```typescript
export const initTelemetry = (serviceName: string) => {
  if (process.env.ENABLE_TRACING !== 'true') return;
  // OTLP exporter, auto-instrumentations, graceful shutdown
};
```

- `ENABLE_TRACING=true` ile etkinlestirilir (varsayilan: devre disi)
- `@opentelemetry/auto-instrumentations-node` ile HTTP, DB, vb. otomatik izleme
- `@opentelemetry/instrumentation-fs` devre disi (cok gurultulu)
- SIGTERM handler ile graceful shutdown
- **KRITIK:** `main.ts`'de `NestFactory.create()`'den ONCE cagrilmali

### 7.2 Correlation ID Middleware

**Dosya:** `libs/backend-common/src/middleware/tenant-context.middleware.ts`

`CorrelationIdMiddleware`:
- W3C Trace Context standardini destekler (traceparent header)
- OpenTelemetry SDK aktifse, SDK'nin trace context'ini kullanir (cift trace ID onleme)
- Response header'larina x-correlation-id, x-trace-id, traceparent ekler
- `crypto.randomUUID()` ile guvenli ID uretimi

---

## 8. Middleware Analizi

### 8.1 UserContextMiddleware

- `x-user-payload` header'indan JWT payload'ini cikarir
- Gateway tarafindan set edilir
- JSON.parse hatalarini yakalar ve uyari loglar

**Guvenlik Notu:** Bu middleware `x-user-payload` header'ina guvenlik duvarinin disinda erisilebilen sunucularda kullanilirsa, spoofing riski vardir. Gateway arkasindan cagirildiginda guvenlidir.

### 8.2 TenantContextMiddleware

4 katmanli tenant cikarma:
1. `x-tenant-id` header
2. JWT user payload
3. Query parameter
4. Subdomain (UUID formati dogrulanir)

**Fark:** TenantGuard'dan farkli olarak, middleware ONCE header'i kontrol eder, TenantGuard ONCE JWT'yi kontrol eder. Bu tutarsizlik, middleware ve guard farkli tenant ID'leri cozumleyebilir (ancak guard en sonda kazanir).

### 8.3 RequestLoggingMiddleware

- Her istek icin duration, statusCode, method, URL, tenantId, correlationId, traceId loglar
- 5xx hatalar `error`, 4xx hatalar `warn`, digerleri `log` seviyesinde

---

## 9. TenantAwareRepository Analizi

**Dosya:** `libs/backend-common/src/database/tenant-aware.repository.ts`

- REQUEST scope -- her HTTP istegi icin yeni instance
- Tum CRUD operasyonlarinda otomatik tenant filter
- `update()` metodunda `tenantId` degisikligi engellenmis (`delete updateData.tenantId`)
- `executeRaw()` metodunda transaction-scoped search_path (`SET LOCAL`)

**Guvenlik Kontrolleri:**
```typescript
// Schema name format dogrulama
if (this.schemaName && !/^tenant_[a-f0-9]{16}$/.test(this.schemaName)) {
  throw new Error(`SECURITY: Invalid schema name format: ${this.schemaName}`);
}

// Transaction icinde SET LOCAL
await this.schemaManager.setTenantSearchPathInTransaction(manager, tenantId);
```

**Olumlu:** `getRepository()` metodu "Use with caution" uyarisi ile belgelenmis.

---

## 10. Security Module Analizi

### 10.1 Modul Yapisi

`SecurityModule` (@Global) asagidakileri icerir:
- ThrottlerModule (rate limiting)
- TokenBlacklistModule (JWT iptali)
- SessionManagerModule (es zamanli oturum kontrolu)
- TimingSafeService (zamanlama saldirisi koruması)
- IpValidatorService (IP cikarma/dogrulama)
- InputSanitizerService (XSS, SQL injection onleme)
- IdorGuard (IDOR koruması)

### 10.2 [F-02] Rate Limiting -- In-Memory Sorunu

`SlidingWindowStrategy` uretimde in-memory storage kullaniyor:

```typescript
// sliding-window.strategy.ts satir 46-52:
if (nodeEnv === 'production') {
  this.logger.warn(
    'SlidingWindowStrategy is using in-memory storage. ' +
    'Rate limits will NOT be enforced across multiple instances.'
  );
}
```

- Hata FIRLATMIYOR, sadece uyari logluyor
- `SessionManagerService` ve `TokenBlacklistService` ise uretimde Redis olmadan HATA FIRLATIYOR (`throw new Error(...)`)
- Bu tutarsizlik, rate limiting'in uretimde sessizce etkisiz kalmasina neden olabilir

**Karsilastirma:**

| Servis | Uretimde Redis Yoksa |
|--------|---------------------|
| SessionManagerService | `throw new Error(...)` -- servis baslamaz |
| TokenBlacklistService | `throw new Error(...)` -- servis baslamaz |
| SlidingWindowStrategy | `logger.warn(...)` -- sessizce devam eder |
| IpRateLimiterService | Dogrudan in-memory (uyari bile yok) |

### 10.3 Token Blacklist

- Bireysel token (jti) ve kullanici-seviyesi (userId) blacklist destegi
- `isValidToken()` composite check -- tek method ile her iki kontrolu yapar
- Redis TTL ile otomatik temizlik
- Uretimde Redis zorunlu

### 10.4 Session Manager

- Kullanici basina maks oturum siniri (varsayilan: 5)
- En eski oturumu kapatma stratejisi
- Redis veya in-memory storage
- 5 dakikada bir expired session temizligi
- Uretimde Redis zorunlu

### 10.5 [F-08] IdorGuard -- Opt-in Davranisi

```typescript
// idor-guard.ts satir 162:
if (!config) {
  this.logger.debug(
    `No @IdorCheck() configured for ${context.getClass().name}.${context.getHandler().name}. `
  );
  return true; // IDOR kontrolu UYGULANMIYOR
}
```

IdorGuard global olarak kayitli olsa bile, `@IdorCheck()` decorator'u olmayan route'lar IDOR korumasindan yoksundur. Dokumantasyonda bu davranis belirtilmis ancak varsayilan olarak koruma saglamayan bir guard tehlikeli olabilir.

### 10.6 IP Validator

- Cloudflare, Akamai, nginx proxy header destegi
- X-Forwarded-For zincir dogrulama (sag-dan-sol tarama)
- Ozel IP range tespiti
- Guvenilir proxy konfigurasyonu (TRUSTED_PROXIES env)
- Header uzunluk siniri (1000 karakter) ve IP sayisi siniri (20) -- DoS onleme

### 10.7 Input Sanitizer

- HTML escape, strip, SQL identifier dogrulama
- Path traversal onleme, null byte temizleme
- Deep sanitize -- recursive obje temizleme
- Schema adi dogrulama (pg_ reserved prefix kontrolu)
- UUID format dogrulama

---

## 11. Pagination

**Dosya:** `libs/backend-common/src/pagination/pagination.dto.ts`

- Standart offset/limit pattern
- `sortBy` alani regex ile dogrulanmis (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`) -- SQL injection onleme
- Limit siniri: max 100
- `PaginatedResponse()` generic factory -- TypeScript + GraphQL tip guvenligi
- `calculateHasMore()` yardimci fonksiyon

**Uyari:** `sortBy` alaninin regex dogrulamasindan SONRA, tuketicilerin bir allowlist'e karsi kontrol etmesi ZORUNLU. Regex yalnizca format kontrolu yapar, gecerli sutun adini garanti etmez.

---

## 12. SourceSchemaBootstrapService

**Dosya:** `libs/backend-common/src/database/source-schema-bootstrap.service.ts`

- Servis baslatildiginda source schema'nin (sensor, farm, hr, vb.) bos olup olmadigini kontrol eder
- Bossa `synchronize()` calistirir
- Orphaned index temizligi (onceki basarisiz sync denemelerinden kalan)
- Non-fatal: hata loglanir, servis cokertilmez
- Idempotent: zaten tablo varsa atlar

---

## 13. Platform Butunlugu Analizi

### 13.1 Schema Isolation Degerlendirmesi

| Kontrol | Durum | Detay |
|---------|-------|-------|
| UUID dogrulama | GECTI | `getTenantSchemaName()` UUID regex kontrolu |
| SQL identifier dogrulama | GECTI | `validateSqlIdentifier()` ek koruma |
| Parametrize sorgular | GECTI | `set_config($1)`, `WHERE tenant_id = $1` |
| Advisory lock | GECTI | Race condition onleme |
| Transaction-scoped search_path | GECTI | `setTenantSearchPathInTransaction()` |
| Connection-level search_path | UYARI | `setTenantSearchPath()` pool'da riskli (F-03) |
| Schema name format | GECTI | `/^tenant_[a-f0-9]{16}$/` strict regex |

### 13.2 Guard Zinciri Degerlendirmesi

Beklenen guard zinciri: `AuthGuard -> TenantGuard -> RolesGuard`

| Kontrol | Durum | Detay |
|---------|-------|-------|
| TenantGuard global kayit | BASARISIZ | 5+ servis kaydetmemis (F-01) |
| RolesGuard global kayit | UYARI | farm, billing, alert-engine kaydetmemis |
| @Public() decorator | GECTI | Hem TenantGuard hem RolesGuard bypass |
| @SkipTenantGuard() | GECTI | Sadece TenantGuard bypass |
| UUID format dogrulama | GECTI | TenantGuard icinde regex |
| JWT tenant eslestirme | GECTI | user.tenantId !== requestTenantId kontrolu |
| Unauthenticated request | UYARI | JWT olmadan tenant ID ile gecis mumkun (F-04) |

### 13.3 Redis Key Collision Degerlendirmesi

| Kontrol | Durum | Detay |
|---------|-------|-------|
| Global prefix | GECTI | `aqua:` prefix tum key'lerde |
| Tenant prefix | UYARI | Convention-based, zorunlu degil (F-06) |
| scan() prefix | BASARISIZ | `scan()` metodu prefix eklemiyor |
| Session keys | GECTI | `session:{sessionId}`, `session:user:{userId}` |
| Token blacklist keys | GECTI | `token:blacklist:{jti}` |
| Throttler keys | GECTI | `throttle:{type}:{identifier}` |

### 13.4 Error Standardization Degerlendirmesi

| Kontrol | Durum | Detay |
|---------|-------|-------|
| REST hata formati | BASARISIZ | 2 farkli envelope (backend-common vs shared) |
| GraphQL hata formati | UYARI | GraphQLExceptionFilter vs AllExceptionsFilter cakismasi |
| Correlation ID | GECTI | Tum filter'larda `x-correlation-id` dahil |
| Tenant ID in errors | GECTI | Tum filter'larda `x-tenant-id` dahil |
| Stack trace gizleme | GECTI | Client response'a stack trace dahil edilmiyor |
| Migration plani | GECTI | Dosya basinda migration dokumantasyonu mevcut |

---

## 14. Oneriler

### 14.1 Kritik (Hemen Yapilmali)

1. **hr-service'e TenantGuard eklenmeli** -- Tenant izolasyonu olmadan calisan bir HR servisi ciddi veri sizintisi riski tasir.

2. **auth-service ve config-service guard durumu dogrulanmali** -- Bu servislerin tenant-aware olmasi gerekmeyebilir (platform-level), ancak bu karar acikca belgelenmeli.

3. **SlidingWindowStrategy uretimde Redis gerektirmeli** -- SessionManager ve TokenBlacklist gibi `throw new Error()` ile baslama engeli olmali.

### 14.2 Yuksek Oncelik

4. **@Cacheable decorator'una tenant prefix zorunlulugu** -- Key pattern'inde `tenant:` veya `{tenantId}` yoksa derleme uyarisi/hata vermeli.

5. **`scan()` metoduna prefix eklenmeli** -- Diger metodlarla tutarsizlik giderilmeli.

6. **TenantGuard'da unauthenticated request loglama** -- `user` objesi yoksa ve tenant ID header'dan geliyorsa, warn seviyesinde loglanmali.

### 14.3 Orta Oncelik

7. **SchemaManagerService decomposition** -- Dosya basindaki TODO'ya uygun olarak 5 alt servise bolunmeli.

8. **Exception filter migration** -- `ARCH-MED-005` planina uygun olarak tum servisler `GlobalExceptionFilter`'a gecirilmeli.

9. **MODULE_SCHEMAS CI dogrulama** -- Entity dosyalari ile MODULE_SCHEMAS arasindaki tutarliligi kontrol eden CI pipeline step'i eklenmeli (mevcut `validateModuleSchemas()` metodu test'lerde kullanilabilir).

### 14.4 Dusuk Oncelik

10. **TenantContextMiddleware tenant cikarma onceligi** -- TenantGuard ile ayni oncelik sirasina getirilmeli (JWT ilk, header ikinci).

11. **`setTenantSearchPath()` metodunun deprecated isaretlenmesi** -- Transaction-scoped versiyona yonlendirme ile.

12. **REFERENCE_DATA_TABLES'in MODULE_SCHEMAS'tan turetilmesi** -- Zaten uygulanmis (`Object.fromEntries(MODULE_SCHEMAS.map(...))`), ancak bazi servislerin eski referanslari temizlenmeli.

---

## 15. Dosya Referanslari

| Dosya | Satir | Aciklama |
|-------|-------|----------|
| `libs/backend-common/src/database/schema-manager.service.ts` | 1670 | Ana schema yonetim servisi |
| `libs/backend-common/src/guards/tenant.guard.ts` | 100 | Tenant guard |
| `libs/backend-common/src/guards/roles.guard.ts` | 184 | Rol guard |
| `libs/backend-common/src/redis/redis.service.ts` | 266 | Redis sarmalayici |
| `libs/backend-common/src/decorators/cacheable.decorator.ts` | 283 | Cache decorator |
| `libs/backend-common/src/decorators/roles.decorator.ts` | 136 | Rol decorator + hiyerarsi |
| `libs/backend-common/src/decorators/tenant.decorator.ts` | 96 | Tenant decorator |
| `libs/backend-common/src/decorators/current-user.decorator.ts` | 122 | User decorator |
| `libs/backend-common/src/filters/http-exception.filter.ts` | 297 | 3 exception filter |
| `libs/backend-common/src/middleware/tenant-context.middleware.ts` | 321 | 4 middleware |
| `libs/backend-common/src/telemetry/tracing.ts` | 49 | OTel init |
| `libs/backend-common/src/database/tenant-aware.repository.ts` | 316 | Tenant-aware repo |
| `libs/backend-common/src/database/source-schema-bootstrap.service.ts` | 127 | Schema bootstrap |
| `libs/backend-common/src/security/security.module.ts` | 68 | Guvenlik modulu |
| `libs/backend-common/src/security/throttler/throttler.guard.ts` | 283 | Rate limit guard |
| `libs/backend-common/src/security/throttler/sliding-window.strategy.ts` | 248 | Rate limit stratejisi |
| `libs/backend-common/src/security/validators/idor-guard.ts` | 330 | IDOR guard |
| `libs/backend-common/src/security/session-manager/session-manager.service.ts` | 380 | Oturum yonetimi |
| `libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts` | 271 | Token blacklist |
| `libs/backend-common/src/security/ip-validation/ip-validator.service.ts` | 298 | IP dogrulama |
| `libs/backend-common/src/security/validators/input-sanitizer.service.ts` | 271 | Input temizleme |
| `libs/backend-common/src/pagination/pagination.dto.ts` | 145 | Pagination DTO |
| `libs/backend-common/src/types/tenant-request.interface.ts` | 33 | Canonical request type |
| `libs/backend-common/src/database/__tests__/schema-manager.spec.ts` | 921 | Testler |

---

**Rapor Sonu** -- D12 Shared Infrastructure Audit
