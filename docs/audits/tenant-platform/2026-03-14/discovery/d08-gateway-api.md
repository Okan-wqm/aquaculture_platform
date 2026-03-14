# D8 - Gateway API Audit Raporu

**Tarih:** 2026-03-14
**Auditor:** D8 - API Gateway Uzmani
**Kapsam:** Apollo Federation Gateway, Authentication, Rate Limiting, CORS, GraphQL Security, Caching, Health Check, OPA Policy Enforcement
**Duzey:** Enterprise API Yonetimi Perspektifi

---

## Yonetici Ozeti

Gateway API, Apollo Federation v2 tabanli tek giris noktasi (single entry point) olarak tasarlanmis, 8 subgraph servisi (auth, farm, sensor, alert, hr, billing, hydroponics, config) birlestirmektedir. JWT authentication, Redis-backed rate limiting, OPA policy enforcement, query depth/complexity limiting, alias brute-force protection, ve circuit breaker pattern gibi enterprise-grade guvenlik ve dayaniklilik mekanizmalari implement edilmistir.

Genel degerlendirme: **OLGUN** - Kritik guvenlik kontrolleri buyuk olcude yerinde. Birinci oncelikli bulgu bulunmamaktadir. Ikinci ve ucuncu oncelikli iyilestirme alanlari asagida detaylandirilmistir.

---

## 1. Apollo Federation Yapisi

### 1.1 Subgraph Listesi ve Composition

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 251-289)

| Subgraph | Port | URL Env Var | Varsayilan URL |
|-----------|------|-------------|----------------|
| auth | 3001 | AUTH_SERVICE_URL | http://localhost:3001/graphql |
| farm | 3002 | FARM_SERVICE_URL | http://localhost:3002/graphql |
| sensor | 3003 | SENSOR_SERVICE_URL | http://localhost:3003/graphql |
| alert | 3004 | ALERT_SERVICE_URL | http://localhost:3004/graphql |
| hr | 3005 | HR_SERVICE_URL | http://localhost:3005/graphql |
| billing | 3006 | BILLING_SERVICE_URL | http://localhost:3006/graphql |
| hydroponics | 4007 | HYDROPONICS_SERVICE_URL | http://localhost:4007/graphql |
| config | 3007 | CONFIG_SERVICE_URL | http://localhost:3007/graphql |

**Onemli Notlar:**
- notification-service kasitli olarak haric tutulmustur (event-driven, GraphQL yok)
- Schema polling: 5 dakikada bir (300000ms) -- `pollIntervalInMs: 300000`
- `RetryableIntrospectAndCompose` ile startup sirasinda subgraph'ler hazir degilse 30 denemeye kadar retry (jitter ile)

### 1.2 RetryableIntrospectAndCompose

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/config/retryable-introspect.ts`

```typescript
maxRetries: 30       // 30 deneme
retryDelayMs: 5000   // 5 saniye + %30 jitter
// Toplam bekleme: ~195 saniye (en kotu durum)
```

**Degerlendirme:** IYI - Thundering herd problemi jitter ile engellenmis. Toplam bekleme suresi makul.

### 1.3 AuthenticatedDataSource

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 90-167)

Subgraph'lere forward edilen header'lar:
- `authorization` - Ham JWT token
- `cookie` - httpOnly refresh token icin
- `x-tenant-id` - JWT tenantId oncelikli, header fallback
- `x-correlation-id` - Distributed tracing
- `traceparent` - W3C Trace Context
- `x-trace-id`, `x-span-id`, `x-parent-span-id` - Trace/span ID'ler
- `x-user-id` - Kullanici ID
- `x-user-roles` - JSON array olarak roller
- `x-user-payload` - Tam kullanici payload'u (JSON)

**[BULGU-D8-01] ORTA - x-user-payload header boyut siniri yok**
Tam JWT payload JSON olarak `x-user-payload` header'inda forward ediliyor. Buyuk JWT claim'ler (custom attributes, uzun permission listesi) HTTP header boyut limitlerini (8KB varsayilan) asabilir. Subgraph'ler bu header'i parse ederken hata alabilir.

**Oneri:** Payload boyutunu sinirlandirin veya sadece gerekli alanlari forward edin.

---

## 2. Authentication Middleware

### 2.1 JWT Validation Akisi

```
Istek --> CorrelationIdMiddleware --> JwtMiddleware --> UserContextMiddleware
      --> TenantContextMiddleware --> RequestLoggingMiddleware --> AuthGuard
```

**Onemli Tasarim Karari:** JwtMiddleware, AuthGuard'dan ONCE calisir. Bu kasitlidir -- `req.user`'in `willSendRequest` tarafindan subgraph'lere forward edilebilmesi icin middleware'de set edilmesi gerekir.

### 2.2 JwtMiddleware

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/middleware/jwt.middleware.ts`

- `JwtService.verifyAsync()` ile dogrulama (signature verification)
- Explicit `algorithms: ['HS256']` -- algorithm confusion attack'lara karsi koruma
- Production'da `jti` olmayan tokenlar reddedilir
- Blacklist kontrolu `req.user` set edilmeden ONCE yapilir (kritik guvenlik noktasi)
- Token gecersizse `req.user` set edilmez, hata firlatilmaz (AuthGuard'a birakilir)

**Degerlendirme:** IYI - Defense-in-depth yaklasimi dogru uygulanmis.

### 2.3 AuthGuard

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/guards/auth.guard.ts`

Desteklenen authentication metotlari:
1. **JWT** (varsayilan) - `Bearer` scheme, HS256, blacklist check
2. **API Key** - `x-api-key` header, SHA-256 hash ile saklama
3. **Basic Auth** - bcrypt hash karsilastirmasi (async)

Guvenlik kontrolleri:
- Token type kontrolu (`access` olmalidir)
- Issuer validation
- Audience validation
- Production'da `jti` zorunlu (revoke edilemeyen tokenlar reddedilir)
- Token blacklist kontrolu (Redis veya in-memory)
- API key sadece header'dan kabul edilir (query parameter reddedilir)
- Pre-hashed bcrypt degerler desteklenir (startup'ta senkron hash engellenir)

### 2.4 Token Blacklist

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/guards/redis-token-blacklist.store.ts`

| Ozellik | RedisTokenBlacklistStore | InMemoryTokenBlacklistStore |
|---------|------------------------|-----------------------------|
| Dagitik destek | EVET | HAYIR |
| TTL yonetimi | Redis TTL (otomatik) | 60sn interval cleanup |
| Redis ariza durumu | FAIL CLOSED (guvenli) | N/A |
| Coklu instance | Calisir | Kirilik (her instance'da ayri) |

**Degerlendirme:** IYI
- `TOKEN_BLACKLIST_USE_REDIS=true` varsayilan -- production icin uygun
- Redis fail durumunda `return true` (blacklisted kabul et) -- guvenli yaklas

---

## 3. Rate Limiting

### 3.1 Global ve Endpoint-Bazli Limitler

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/guards/rate-limit.guard.ts`
**Konfiguration:** `/var/aqua-saas/apps/gateway-api/src/config/rate-limit.config.ts`

| Endpoint | Limit | Pencere | Aciklama |
|----------|-------|---------|----------|
| Global (authenticated) | 100/min | 60sn | Varsayilan |
| Tenant (JWT verified) | 1000/min | 60sn | Dogrulanmis tenant kullanicilari |
| Anonymous | 20/min | 60sn | Kimlik dogrulanmamis istekler |
| Login | 5 deneme | 15 dk | Brute-force koruması |
| Register | 3 deneme | 15 dk | Toplu hesap olusturma engeli |
| Password Reset | 3 deneme | 1 saat | Abuse koruması |
| Mutations | 30/min | 60sn | GraphQL mutation limiti |
| Upload | 10/min | 60sn | Dosya yukleme limiti |

### 3.2 Rate Limiting Guvenlik Ozellikleri

- **Atomic operations:** Redis INCR ile atomik sayac (race condition onlenir)
- **Fail closed (production):** Redis arizasinda 503 dondurur (bypass engellenir)
- **IP validation:** IPv4/IPv6 format kontrolu, gecersiz IP'ler tek bucket'ta toplanir
- **Tenant rate tier koruması:** Sadece JWT'den dogrulanmis tenantId ile yuksek limit verilir (header spoofing ile bypass engellenmis)
- **Endpoint-bazli bucket'lar:** Login, register, upload ayri bucket'larda -- dashboard polling login limitini tuketmez
- **Batched request koruması:** `allowBatchedHttpRequests: false` -- tek HTTP isteginde birden fazla GraphQL operasyonu engellenmis

**Degerlendirme:** IYI - Per-tenant rate limiting guvenli implement edilmis. Unauthenticated header'dan tenant tier yukseltme saldirisi engellenms.

### 3.3 Alias Brute-Force Protection

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts`

- Hassas mutation'lar (loginWithCredentials, register, refreshToken, resetPassword, changePassword) istek basina 1 kez ile sinirli
- Toplam mutation field sayisi 10 ile sinirli
- GraphQL alias ile rate limit bypass saldirisi engellenmis

**Degerlendirme:** IYI - Bu, sik gozden kacirilan bir saldiri vektorune karsi etkili bir onlem.

---

## 4. CORS Configuration

### 4.1 HTTP CORS

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/main.ts` (satir 134-159)

- `CORS_ORIGINS` env var ile yapilandirilir
- Production'da wildcard (`*`) YASAK -- uygulama baslatilmaz (hard fail)
- Wildcard kullanildiginda `credentials: false` (CORS spec uyumlu)
- Belirli origin'lerde `credentials: true`
- Izin verilen header'lar: Content-Type, Authorization, X-Tenant-Id, X-Correlation-Id, X-Request-Id

**Degerlendirme:** IYI - Production wildcard engeli kritik bir guvenlik onlemidir.

### 4.2 WebSocket CORS

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/websocket/sensor-readings.gateway.ts`

- `WS_CORS_ORIGINS` env var ile yapilandirilir
- Production'da origin yoksa tum baglantilari reddeder
- Development'ta wildcard izni verilir ancak `credentials: false` (CSWSH koruması)
- Query parameter token'lar production'da reddedilir (URL loglanma riski)

**Degerlendirme:** IYI - CSWSH (Cross-Site WebSocket Hijacking) onlemi yerinde.

---

## 5. Request/Response Transformation

### 5.1 Security Headers (Helmet)

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/main.ts` (satir 48-110)

| Header | Deger | Not |
|--------|-------|-----|
| Content-Security-Policy | Production'da strict, dev'de kapal | default-src: self |
| Strict-Transport-Security | 1 yil, includeSubDomains, preload | Sadece production |
| X-Frame-Options | DENY | Clickjacking koruması |
| X-Content-Type-Options | nosniff | MIME sniffing koruması |
| X-Powered-By | Gizli | Teknoloji ifsa engeli |
| Referrer-Policy | strict-origin-when-cross-origin | Referrer bilgi sizintisi |
| Cross-Origin-Embedder-Policy | require-corp (production) | |
| Cross-Origin-Opener-Policy | same-origin | |
| Cross-Origin-Resource-Policy | same-origin | |

### 5.2 Request Validation

- `ValidationPipe` global olarak uygulanir
- `whitelist: true` -- bilinmeyen alanlar sessizce silinir
- `forbidNonWhitelisted: true` -- bilinmeyen alanlar hata dondurur
- `enableImplicitConversion: false` -- tip karistirma saldirisi engellenir
- Production'da validation hata mesajlari kapatilir
- Error response'larda target ve value ifsa edilmez

### 5.3 Correlation ID Middleware

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/middleware/correlation-id.middleware.ts`

- Her istege benzersiz correlation ID atanir (UUID v4)
- W3C Trace Context, Jaeger, Zipkin header desteği
- **Log injection koruması:** ID format validation (alfanumerik, max 128 karakter)
- Response header'larda X-Correlation-ID ve X-Request-ID dondurulur

---

## 6. Error Handling ve Propagation

### 6.1 GlobalExceptionFilter

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/filters/global-exception.filter.ts`

- HTTP ve GraphQL exception'larini ayri isler
- Production'da:
  - Stack trace gizlenir
  - Hassas kelimeler iceren hata mesajlari sanitize edilir (password, secret, token, key, credential, sql, query, database)
  - Detaylar (details) gizlenir
  - Genel Error instance'lari "An internal error occurred" mesaji ile dondurulur
- GraphQL error code mapping (400->BAD_REQUEST, 401->UNAUTHENTICATED, vb.)
- Correlation ID ve tenant ID hata yanindlarinda dahil edilir

### 6.2 Apollo Server Error Formatting

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 309-316)

- Production'da `formatError` ozel fonksiyon: sadece message ve code dondurulur
- `includeStacktraceInErrorResponses: false` (production)

**Degerlendirme:** IYI - Information leakage koruması kapsamli.

---

## 7. Health Check Endpoints

### 7.1 Endpoint Yapisi

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/health/health.controller.ts`

| Endpoint | Auth | Amac | HTTP Code |
|----------|------|------|-----------|
| GET /health/live | Public | K8s liveness probe | 200 |
| GET /health/ready | Public | K8s readiness probe | 200/503 |
| GET /health/ping | Public | Baglanti testi | 200 |
| GET /health | Public | Genel durum (sanitize) | 200 |
| GET /health/detail | Auth Required | Detayli istatistik | 200 |

### 7.2 Health Service

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/health/health.service.ts`

- Tum subgraph'lerin saglik durumunu kontrol eder
- Sonuclar 5 saniye cache'lenir (HEALTH_CHECK_CACHE_TTL_MS)
- Yavas yanit (>2sn) "degraded" olarak isaretlenir
- Public endpoint YALNIZCA genel durum dondurur -- servis URL'leri, memory, uptime GIZLI

**[BULGU-D8-02] DUSUK - Health check'te hydroponics ve config servisleri eksik**
Health service'in `serviceUrls` Map'inde hydroponics (4007) ve config (3007) servisleri bulunmuyor, ancak subgraph listesinde mevcut. Bu, bu servislerin saglik durumunun izlenmedigini gosterir.

**Oneri:** Health service'e hydroponics ve config servislerini ekleyin.

---

## 8. Caching Strategy

### 8.1 Katmanli Cache Mimarisi

| Katman | Mekanizma | TTL | Boyut Limiti | Amac |
|--------|-----------|-----|--------------|------|
| Health check | In-memory | 5sn | N/A | Probe yuku azaltma |
| Tenant metadata | In-memory (dev) / TenantLookupService (prod) | 5dk | 1000 | Tenant bilgisi |
| OPA decision | In-memory | 60sn | 5000 | Policy kararlari |
| OPA policy guard | In-memory | 30sn | 10000 | Guard-seviye karar cache |
| Schema poll | Apollo Gateway | 5dk | N/A | Subgraph schema |

### 8.2 Cache Guvenlik Onlemleri

- **Boyut limitleri:** Tum cache'ler bounded (maxCacheSize ile) -- OOM saldirisi engellenmis
- **Periyodik cleanup:** Expired entry'ler duzenli olarak temizlenir
- **SHA-256 cache key:** OPA decision cache'de SHA-256 hash kullanilir (djb2 collision riski elimine edilmis)
- **Cache invalidation:** Tenant, user, policy bazinda invalidation metotlari mevcut

### 8.3 Eksik Katmanlar

**[BULGU-D8-03] DUSUK - CDN/Edge cache stratejisi yok**
Gateway'de CDN entegrasyonu veya Cache-Control header yonetimi bulunmamaktadir. Statik GraphQL query'ler (schema introspection dev'de, okunan veriler) icin edge caching faydali olabilir.

**[BULGU-D8-04] DUSUK - Persisted Queries kullanilmiyor**
Apollo Server'da Automatic Persisted Queries (APQ) veya registered operations aktif degil. Persisted queries hem bant genisligi tasarrufu saglar hem de query whitelist olarak guvenlik avantaji sunar.

**Oneri:** Production'da registered operations/persisted queries kullanarak bilinmeyen query'lerin reddedilmesini saglayin. Bu, GraphQL firewall islevi gorur.

---

## 9. GraphQL Depth/Complexity Limiting

### 9.1 Query Depth Limiting

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 319)

```typescript
validationRules: [depthLimit(10)]
```

- Maksimum query derinligi: 10
- `graphql-depth-limit` kutuphanesi ile
- Asildiginda istek reddedilir

**Degerlendirme:** IYI - 10 seviye derinlik, cogu legitimate kullanim senaryosu icin yeterli.

### 9.2 Query Complexity Limiting

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 326-364)

- Varsayilan maksimum complexity: 1000 (`GRAPHQL_MAX_COMPLEXITY` ile konfigurasyonlanabilir)
- `fieldExtensionsEstimator` + `simpleEstimator` (default: 1 per field)
- Asildiginda hata mesaji complexity degerini icerir
- Development'ta her istegin complexity'si loglanir

**Degerlendirme:** IYI - Ancak `simpleEstimator` tum field'lara esit agirlik verir. Pagination field'lari (first, last) ve list field'lari icin ozel complexity tanimi yapilmasi onerilir.

### 9.3 Alias Limiting

- Hassas mutation'lar istek basina 1 ile sinirli
- Toplam mutation field sayisi 10 ile sinirli
- Batched HTTP request'ler kapali (`allowBatchedHttpRequests: false`)

---

## 10. Introspection Kontrolu

### 10.1 Production Durumu

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/app.module.ts` (satir 301-306)

```typescript
playground: configService.get('NODE_ENV') !== 'production',
introspection: configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true' ||
  configService.get('NODE_ENV') !== 'production',
```

**Degerlendirme:** IYI
- Production'da introspection KAPALI (varsayilan)
- `GRAPHQL_INTROSPECTION=true` ile override edilebilir (bagimsiz kontrol)
- Playground production'da kapali

**[BULGU-D8-05] BILGI - Introspection override riski**
`GRAPHQL_INTROSPECTION=true` env var'i production'da introspection'i acabilir. Bu, schema kesfine olanak tanir.

**Oneri:** Production'da `GRAPHQL_INTROSPECTION` env var'inin set edilmediginden emin olun. CI/CD pipeline'da bu kontrolu ekleyin.

---

## 11. Guvenlik Odak Bulgulari

### 11.1 GraphQL Introspection: KORUMALI
- Production'da varsayilan olarak kapali
- Override mekanizmasi mevcut ama env var kontrolu gerektirir

### 11.2 Query Depth Limiting: MEVCUT
- 10 seviye sinir
- DoS koruması saglar

### 11.3 Persisted Queries: YOK
- **[BULGU-D8-04]** olarak raporlanmistir
- GraphQL firewall fonksiyonu icin onerilir

### 11.4 Authorization Header Forwarding: GUVENLI
- JWT middleware imza dogrulamasindan sonra `req.user` set eder
- AuthGuard blacklist kontrolu yapar
- `willSendRequest` sadece dogrulanmis kullanici bilgilerini forward eder
- Cookie forwarding mevcut (httpOnly refresh token icin gerekli)

### 11.5 SSRF Riski: DUSUK
- Subgraph URL'leri environment variable'lardan okunur (hardcoded)
- `buildService` sadece compose sirasinda belirlenen URL'leri kullanir
- Runtime'da URL manipulasyonu mumkun degil
- `TenantLookupService` UUID format validation yapar (SSRF/path injection engeli)

---

## 12. OPA Policy Enforcement

### 12.1 Mimari

**Dosyalar:**
- `/var/aqua-saas/apps/gateway-api/src/opa/opa-client.service.ts`
- `/var/aqua-saas/apps/gateway-api/src/opa/policy-enforcer.service.ts`
- `/var/aqua-saas/apps/gateway-api/src/guards/opa-policy.guard.ts`

**Ozellikler:**
- OPA sunucusu ile HTTP iletisim
- Circuit breaker ile OPA ariza koruması
- Retry logic (exponential backoff, 4xx retry edilmez)
- Decision cache (SHA-256 key, bounded)
- Fallback policies (OPA unavailable durumunda)
- Production'da fail-closed (OPA_FAIL_OPEN production'da ignore edilir)
- Policy bazinda, tenant bazinda, user bazinda cache invalidation

### 12.2 Rego Policy'ler

Mevcut policy dosyalari:
- `tenant-access.rego` -- Cross-tenant erisim kontrolu
- `data-residency.rego` -- Veri lokasyon uyumlulugu
- `module-authorization.rego` -- Modul erisim yetkilendirme

### 12.3 OPA Guard Davranisi

| Ortam | OPA Yapilandirilmamis | OPA Unavailable | OPA Deny |
|-------|----------------------|-----------------|----------|
| Production | Deny (hard fail) | Deny (fail-closed) | Deny |
| Development | Allow (backwards compat) | Allow (fail-open) | Deny |

**Degerlendirme:** IYI - Production'da guvenli varsayilanlar.

---

## 13. WebSocket Guvenligi

### 13.1 Sensor Readings Gateway

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/websocket/sensor-readings.gateway.ts`

- JWT authentication zorunlu (baglanti sirasinda)
- Token extraction onceligi: auth object > Authorization header > query param
- Query param token'lar production'da reddedilir
- Sensor subscription'lar tenant sahipligi ile yetkilendirilir
- Subscription sayisi 100 ile sinirli (kaynak tukenmesi engeli)
- Sensor ID'ler UUID format validation'dan gecer
- Socket.IO room-based routing (O(1) performans)
- Cross-tenant data izolasyonu: subscription sirasinda enforce edilir

### 13.2 NATS Bridge

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/websocket/nats-bridge.service.ts`

- TLS desteği (NATS_TLS_ENABLED)
- Authentication desteği (token veya user/pass)
- Production'da TLS kapaliysa uyari verir
- Event schema validation (runtime type checking)
- Tenant ID mismatch kontrolu (metadata vs payload)
- Tenant ID UUID format validation
- Reconnect sonrasi otomatik re-subscribe

---

## 14. Ek Guvenlik Onlemleri

### 14.1 Request Body Limitleri
- JSON: 1MB varsayilan (REQUEST_JSON_LIMIT)
- URL-encoded: 1MB varsayilan (REQUEST_URLENCODED_LIMIT)
- File upload: Chemical 10MB, Batch 15MB

### 14.2 File Upload Guvenligi
- Magic bytes validation (MIME type spoofing engeli)
- Filename sanitization (null byte, path injection engeli)
- Path traversal koruması (presigned URL endpoint'inde)
- URL decode edildikten SONRA traversal check
- Tenant izolasyonu (path tenantId prefix kontrolu)

### 14.3 Trust Proxy
- `TRUST_PROXY` env var ile yapilandirilir
- Dogru yapilandirilmazsa uyari loglanir
- X-Forwarded-For header'i dogrulanmamis kullanildiginda production uyarisi

### 14.4 JWT Secret Yonetimi
- Production'da JWT_SECRET zorunlu (yoksa uygulama baslamaz)
- Minimum 32 karakter uzunluk kontrolu
- Development'ta DEV_JWT_SECRET icin explicit onay gerekir (ALLOW_DEV_JWT_SECRET=true)

### 14.5 MinIO Credentials
- Production'da MINIO_ACCESS_KEY ve MINIO_SECRET_KEY zorunlu
- Varsayilan credential'lar sadece development'ta kullanilir

---

## 15. Circuit Breaker

**Dosya:** `/var/aqua-saas/apps/gateway-api/src/proxy/circuit-breaker.service.ts`

| Parametre | Varsayilan | Aciklama |
|-----------|-----------|----------|
| failureThreshold | 5 | Circuit acilmadan onceki hata sayisi |
| successThreshold | 3 | Half-open'dan kapatmak icin basari sayisi |
| timeout | 30000ms | Open -> Half-open gecis suresi |
| volumeThreshold | 10 | Hata orani hesaplanmadan onceki minimum istek |
| failureRateThreshold | %50 | Circuit acma hata orani |
| slowCallThreshold | 5000ms | Yavas cagri esigi |
| slowCallRateThreshold | %80 | Circuit acma yavas cagri orani |

- Sliding window ile metrik toplama
- Service bazinda bagimsiz circuit'ler
- Fallback fonksiyon desteği
- @WithCircuitBreaker decorator desteği

---

## 16. Bulgu Ozet Tablosu

| ID | Oncelik | Kategori | Bulgu | Durum |
|----|---------|----------|-------|-------|
| D8-01 | ORTA | Header Security | x-user-payload header boyut siniri yok | ACIK |
| D8-02 | DUSUK | Monitoring | Health check'te hydroponics ve config servisleri eksik | ACIK |
| D8-03 | DUSUK | Performance | CDN/Edge cache stratejisi yok | ACIK |
| D8-04 | DUSUK | Security | Persisted Queries kullanilmiyor | ACIK |
| D8-05 | BILGI | Configuration | Introspection override env var riski | ACIK |
| D8-06 | DUSUK | Observability | GraphQL operation-level metrikleri (Prometheus/Grafana) eksik | ACIK |

---

## 17. Pozitif Bulgular (Best Practice Uyumu)

| # | Ozellik | Aciklama |
|---|---------|----------|
| 1 | Algorithm pinning | JWT verify'da explicit `algorithms: ['HS256']` -- algorithm confusion attack engeli |
| 2 | Fail-closed defaults | Rate limit, token blacklist, OPA hepsi production'da fail-closed |
| 3 | Atomic rate limiting | Redis INCR ile race condition engeli |
| 4 | Alias brute-force | Hassas mutation'lar icin alias limit plugin |
| 5 | Batched request disable | `allowBatchedHttpRequests: false` -- rate limit bypass engeli |
| 6 | Magic bytes validation | Dosya yukleme MIME spoofing engeli |
| 7 | Cache bounding | Tum in-memory cache'ler boyut sinirli (OOM engeli) |
| 8 | Tenant ID priority | JWT claim header'dan oncelikli -- tenant spoofing engeli |
| 9 | Production hard fails | JWT secret, CORS wildcard, MinIO creds -- production'da eksikse uygulama baslamaz |
| 10 | Error sanitization | Hassas kelime filtreleme, stack trace gizleme |
| 11 | Log injection prevention | Correlation ID format ve uzunluk kontrolu |
| 12 | Path traversal prevention | URL decode sonrasi kontrol, null byte engeli |
| 13 | CSWSH protection | WS'de wildcard origin + credentials:false |
| 14 | Query param token reject | Production WS'de query param token reddedilir |
| 15 | Graceful shutdown | `app.enableShutdownHooks()` aktif |

---

## 18. Oneri Onceliklendirmesi

### Yuksek Oncelik (Sprint icinde)
1. **D8-01:** `x-user-payload` header boyutunu sinirlayin veya gerekli alanlara daraltın
2. **D8-02:** Health service'e hydroponics ve config servislerini ekleyin

### Orta Oncelik (Sonraki 2 sprint)
3. **D8-04:** Persisted/registered queries implement edin
4. **D8-06:** Prometheus/Grafana entegrasyonu icin operation-level metrikler ekleyin

### Dusuk Oncelik (Roadmap)
5. **D8-03:** CDN stratejisi gelistirin (CloudFlare/CloudFront)
6. **D8-05:** CI/CD pipeline'a GRAPHQL_INTROSPECTION env var kontrolu ekleyin
7. Query complexity'de field-bazli estimator kullanin (pagination, list field'lar icin)

---

## 19. Dosya Referanslari

| Dosya | Satir | Icerik |
|-------|-------|--------|
| `apps/gateway-api/src/app.module.ts` | 1-518 | Root module, federation, guards, middleware |
| `apps/gateway-api/src/main.ts` | 1-172 | Bootstrap, CORS, Helmet, validation |
| `apps/gateway-api/src/guards/auth.guard.ts` | 1-512 | JWT/API Key/Basic auth |
| `apps/gateway-api/src/guards/rate-limit.guard.ts` | 1-523 | Rate limiting |
| `apps/gateway-api/src/middleware/jwt.middleware.ts` | 1-73 | JWT decode/verify |
| `apps/gateway-api/src/middleware/tenant-context.middleware.ts` | 1-569 | Tenant resolution |
| `apps/gateway-api/src/middleware/correlation-id.middleware.ts` | 1-258 | Tracing |
| `apps/gateway-api/src/filters/global-exception.filter.ts` | 1-287 | Error handling |
| `apps/gateway-api/src/health/health.controller.ts` | 1-106 | Health endpoints |
| `apps/gateway-api/src/health/health.service.ts` | 1-295 | Health checks |
| `apps/gateway-api/src/plugins/graphql-alias-limit.plugin.ts` | 1-93 | Alias protection |
| `apps/gateway-api/src/websocket/sensor-readings.gateway.ts` | 1-483 | WebSocket |
| `apps/gateway-api/src/websocket/nats-bridge.service.ts` | 1-318 | NATS bridge |
| `apps/gateway-api/src/upload/upload.controller.ts` | 1-685 | File upload |
| `apps/gateway-api/src/opa/opa-client.service.ts` | 1-677 | OPA client |
| `apps/gateway-api/src/opa/policy-enforcer.service.ts` | 1-646 | Policy enforcer |
| `apps/gateway-api/src/guards/opa-policy.guard.ts` | 1-573 | OPA guard |
| `apps/gateway-api/src/proxy/circuit-breaker.service.ts` | 1-582 | Circuit breaker |
| `apps/gateway-api/src/config/rate-limit.config.ts` | 1-70 | Rate limit config |
| `apps/gateway-api/src/config/retryable-introspect.ts` | 1-57 | Schema retry |
| `apps/gateway-api/src/config/opa.config.ts` | 1-42 | OPA config |
| `apps/gateway-api/src/services/tenant-lookup.service.ts` | 1-345 | Tenant lookup |
| `apps/gateway-api/src/guards/redis-token-blacklist.store.ts` | 1-145 | Token blacklist |
| `apps/gateway-api/src/guards/redis-rate-limit.store.ts` | 1-125 | Redis rate limit |
