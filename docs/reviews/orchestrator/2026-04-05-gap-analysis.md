# Gap Analysis: Deep Audit (366 Findings) vs Implemented Fixes

**Date:** 2026-04-05
**Scope:** 4 Nisan 2026 deep audit bulgulari (47 CRITICAL, 103 HIGH, 138 MEDIUM, 78 LOW = 366 total) vs son 15 commit
**Method:** Kaynak kod dogrudan okunarak dogrulama yapildi. "Fix" yorumlarina degil, gercek koda bakildi.

---

## Executive Summary

| Kategori | Sayi |
|----------|------|
| Tamamlandi + Mimari kalite | 22 |
| Tamamlandi ama YAMA (patch) | 4 |
| Kismen yapildi | 6 |
| Yapilmadi (CRITICAL/HIGH) | 15+ |
| Toplam dogrulanan bulgu | 47 |

**Deployment statusu: HALA BLOCK.** CRITICAL bulguların bir kismi fix edilmis olsa da, en az 5 CRITICAL ve 10+ HIGH bulgu hala acik.

---

## ADIM 3: Kritik Dosya Dogrulamasi (12 dosya)

### 1. `apps/farm-service/src/batch/handlers/close-batch.handler.ts`
**Audit Bulgulari:** HIGH-001 — Transaction yok, NATS event yok, Logger yok

**Dogrulama Sonucu:** TAMAMLANDI

- QueryRunner transaction: VAR (satir 98-111)
- BatchClosed domain event: VAR, transaction commit SONRASINDA publish (satir 116-133)
- DomainEventPublisher service injected (satir 31)
- Logger: VAR (satir 24)
- tenantId WHERE clause: VAR (satir 39)

**Mimari Kalite:** ENTERPRISE-GRADE. Transaction pattern dogru (queryRunner.connect -> startTransaction -> try/catch/finally -> release). Event publishing post-commit, logger structured, crypto.randomUUID() event correlation.

### 2. `apps/gateway-api/src/guards/utils/token-validation.util.ts`
**Audit Bulgulari:** LOW-004 — SEC-COMPAT backward compat `payload.type &&` guard (conditional check)

**Dogrulama Sonucu:** TAMAMLANDI

- `payload.type !== 'access'` strict check: VAR (satir 38)
- Backward compat kaldirild: EVET, `if (payload.type && ...)` yok
- jti production zorunlulugu: VAR (satir 47-57)
- Sunset tarihi documented: EVET (2026-04-12)

**Mimari Kalite:** ENTERPRISE-GRADE. Unconditional reject, no fallback, clear error codes (`INVALID_TOKEN_TYPE`, `MISSING_TOKEN_ID`). Tek karar noktasi, conditional bypass yok.

### 3. `apps/billing-service/src/billing/billing.resolver.ts`
**Audit Bulgulari:** CRITICAL — 'system' userId fallback, JWT olmadan mutasyon kabul

**Dogrulama Sonucu:** TAMAMLANDI

- `'system'` fallback: KALDIRILDI. `extractUserId()` fonksiyonu (satir 129-136) `context.req.user?.sub` kontrol ediyor, yoksa `UnauthorizedException` firlatiyor.
- JWT zorunlu: `extractTenantId()` (satir 108-127) JWT'den `user?.tenantId` aliyor, header'dan degil.
- UUID validation: VAR (satir 105)
- Role-based access: VAR (satir 142-156), her mutation icin role check

**Mimari Kalite:** ENTERPRISE-GRADE. Comprehensive RBAC (6 role tier), UUID validation, fail-closed tasarim. Eski "trust X-User-Id header" pattern'i tamamen kaldirilmis. Financial mutation'lar icin traceable identity zorunlu.

### 4. `apps/notification-service/src/notification/services/notification-dispatcher.service.ts`
**Audit Bulgulari:** CRITICAL — WEBHOOK_ENCRYPTION_KEY hardcoded fallback, production guard yok

**Dogrulama Sonucu:** TAMAMLANDI

- `onModuleInit()` validation: VAR (satir 209-229)
- Production'da key yoksa crash: VAR, `throw new Error(...)` (satir 216-220)
- Dev fallback yalnizca non-production'da: VAR (satir 222-228)
- SSRF prevention: VAR (satir 17-72), private IP blocking, hostname blocklist, HTTPS enforcement

**Mimari Kalite:** ENTERPRISE-GRADE. AES-256-GCM encryption with proper IV/authTag, fail-fast startup validation, comprehensive SSRF blocklist (AWS metadata, GCP metadata, RFC 1918, CGNAT), PII masking in logs, exponential backoff for retries, Redis-backed distributed rate limiting with in-memory fallback.

### 5. `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
**Audit Bulgulari:** HIGH-002 — EVENT_BUS inject edilmis ama event publish edilmiyor

**Dogrulama Sonucu:** TAMAMLANDI

- BatchTransferred event: VAR, publish satir 327-343
- Post-transaction commit publish: VAR
- DomainEventPublisher injected: VAR (satir 57)
- Transaction with pessimistic locks: VAR (mevcut)

**Mimari Kalite:** ENTERPRISE-GRADE. Event body complete (eventId, eventType, timestamp, tenantId, batchId, sourceTankId, destinationTankId, quantity, biomassKg, transferReason, userId, version).

### 6. `apps/farm-service/src/batch/dataloaders/batch-document.dataloader.ts`
**Audit Bulgulari:** HIGH-006 — N+1 query pattern (3N individual queries per batch list)

**Dogrulama Sonucu:** TAMAMLANDI

- DataLoader: VAR (satir 28-77)
- Scope.REQUEST: VAR (satir 28) — cross-request leakage yok
- Batch loading with `In([...batchIds])`: VAR (satir 38-44)
- `loadByType()` for filtered queries: VAR (satir 73-76), tek query'den filter

**Mimari Kalite:** ENTERPRISE-GRADE. N+1 pattern dogru sekilde cozulmus. DataLoader batchScheduleFn ile same-tick batching. Scope.REQUEST multi-tenancy icin guvenli. Type-filtered loading in-memory post-filter (single DB round-trip).

### 7. `libs/backend-common/src/database/migration-logger.ts`
**Audit Bulgulari:** LOW-001 — Migration'larda console.log kullanimi

**Dogrulama Sonucu:** TAMAMLANDI

- MigrationLogger class: VAR (satir 30-54)
- NestJS Logger wrapper: VAR, `Migration:` prefix ile
- log/warn/error methods: VAR
- Stack trace support: VAR (satir 48-53)

**Mimari Kalite:** ADEQUATE. Logger utility dogru ama migration'larin kendisi guncellenip guncellenmedigini (console.log -> MigrationLogger) dogrulamak gerekiyor. Utility mevcut ama adoption kontrolu yapilmadi.

### 8. `libs/backend-common/src/auth/jwt-verification.utils.ts`
**Audit Bulgulari:** HIGH-001/002 — GqlAuthGuard'larda algorithm restriction yok

**Dogrulama Sonucu:** TAMAMLANDI

- `enforceAccessTokenType()`: VAR (satir 61-84)
- `getJwtVerifyOptions()`: VAR (satir 99-122)
- `algorithms: ['HS256']`: VAR (satir 109)
- `issuer` enforcement: VAR (satir 116) — library-level, conditional degil
- `audience` enforcement: VAR (satir 120) — library-level, conditional degil
- `configService.getOrThrow('JWT_SECRET')`: VAR (satir 104) — crash on missing

**Mimari Kalite:** ENTERPRISE-GRADE. Single source of truth for JWT verification. Library-level enforcement (jsonwebtoken rejects), not application-level conditional checks. BEFORE/AFTER documentation excellent.

### 9. `apps/farm-service/src/common/guards/gql-auth.guard.ts`
**Audit Bulgulari:** HIGH-001 — JWT algorithm restriction yok, token type check yok

**Dogrulama Sonucu:** TAMAMLANDI

- `getJwtVerifyOptions(this.configService)` kullaniliyor: VAR (satir 130-132)
- `enforceAccessTokenType()` cagiriliyor: VAR (satir 138)
- Import from `@aquaculture/backend-common`: VAR (satir 22)

**Mimari Kalite:** ENTERPRISE-GRADE. Centralized utility kullanimi, duplicate code yok. Defense-in-depth comments clear.

### 10. `web/apps/aquamobil/src/hooks/useAuth.tsx`
**Audit Bulgulari:** CRITICAL — PWA messaging cache logout'ta temizlenmiyor

**Dogrulama Sonucu:** TAMAMLANDI

- `navigator.serviceWorker.ready.then(reg => reg.active?.postMessage({ type: 'LOGOUT' }))`: VAR (satir 287-290)
- Service worker'da `LOGOUT` message handler: VAR (messaging-sw.ts satir 249-252)
- `clearMessagingCaches()`: VAR (messaging-sw.ts satir 255-262) — `messaging-*` prefix'li tum cache'ler temizleniyor
- `clearAllUserData()`: VAR (satir 100-110) — IndexedDB, offline queue, permission cache
- `caches.delete('api-cache')`: VAR (satir 108)

**Mimari Kalite:** ENTERPRISE-GRADE. Coordinated teardown: IndexedDB + Cache Storage + SW message. Fire-and-forget pattern dogru (logout UI hemen reset, cleanup async). Shared device senaryosu icin tum veri katmanlari temizleniyor.

### 11. `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
**Audit Bulgulari:** Admin — H-08 JWT PII removal impersonation'i bozuyor

**Dogrulama Sonucu:** TAMAMLANDI

- `superAdminEmail?: string` (optional): VAR (satir 33)
- Interface'de optional: VAR, JSDoc ile aciklama (satir 30-31)
- Audit log'da email yok iken ID-only trail: calisiyor (satir 340, email || ID)

**Mimari Kalite:** ADEQUATE. Optional email graceful degradation. Ancak YAMA niteligi var — ideal cozum identity service uzerinden email resolve etmek, JWT'ye geri koymak degil.

### 12. `sens-api-gateway/src/provisioning.rs`
**Audit Bulgulari:** CRITICAL — ActivationResponse `#[derive(Debug)]` MQTT credentials leak

**Dogrulama Sonucu:** TAMAMLANDI (ActivationResponse icin)

- ActivationResponse: Custom Debug impl VAR (satir 127-140), `mqtt_password: "[REDACTED]"`
- `#[derive(Debug)]` kaldirilmis: EVET
- ActivationRequest: Custom Debug impl VAR (satir 94-103), `mask_token(&self.token)`

**ANCAK:** SelfRegisterResponse hala `#[derive(Debug)]` kullaniyyor (satir 171) ve `mqtt_password` alanini plaintext olarak log'a yazdiriyor! Bu AYNI vulnerability'nin farkli struct'taki kopyasi.

**Mimari Kalite:** KISMEN TAMAMLANDI. ActivationResponse fix edilmis ama SelfRegisterResponse ayni vulnerability'ye sahip. Sistematik duzeltme yerine noktasal yama yapilmis.

---

## ADIM 4: Eksik Bulgular — Hala Fix Edilmemis CRITICAL ve HIGH Onceligindekiler

### HALA ACIK CRITICAL BULGULAR

| # | Bulgu | Dosya | Durum |
|---|-------|-------|-------|
| C-1 | **SelfRegisterResponse Debug derive MQTT credential leak** | `sens-api-gateway/src/provisioning.rs:171` | YAPILMADI |
| C-2 | **VFD Automation requiresApproval=false Maker-Checker bypass** | `vfd-automation-rule.service.ts:316-328` | DOGRULANMADI — maker-checker enforce var ama auto-approve path audit edilmeli |
| C-3 | **NATS subject format tenant segment yok** | `platform/libs/event-bus/src/nats/nats-event-bus.ts` | YAPILMADI — hala `events.{eventType}` |
| C-4 | **RecordCullHandler TOCTOU race condition** | `record-cull.handler.ts:37-68` | DOGRULANMADI |
| C-5 | **Tank capacity check HICBIR YERDE enforce edilmiyor** | `AllocateToTankHandler` | TransferModal fix edildi (skipCapacityCheck: false) ama AllocateToTankHandler dogrulanmadi |
| C-6 | **FeedingSchedulerService updateFeedingStatus() tenantId yok** | `feeding-scheduler.service.ts:546-547` | YAPILMADI — `where: { id }` tenant filter yok |
| C-7 | **FeedingSchedulerService calculateFeedAmount() tenantId yok** | `feeding-scheduler.service.ts:615-616` | YAPILMADI — `where: { id: batchId }` tenant filter yok |

### HALA ACIK HIGH BULGULAR

| # | Bulgu | Dosya | Durum |
|---|-------|-------|-------|
| H-1 | **HR Payroll earnings/deductions GraphQL'da exposed** | hr-service entities | DOGRULANMADI |
| H-2 | **HR EmergencyInfo (medical PII) orphaned GraphQL type** | hr-service entities | DOGRULANMADI |
| H-3 | **Admin SQL injection WQ parameter seeding** | admin-api-service | DOGRULANMADI |
| H-4 | **Admin Database explorer pg_temp bypass** | admin-api-service | DOGRULANMADI |
| H-5 | **HR Authorization over-permissiveness (MODULE_USER -> MODULE_MANAGER ops)** | hr-service resolvers | DOGRULANMADI |
| H-6 | **In-memory state (TokenRevocation, WebAuthn, TokenBudget, RateLimit)** | multiple services | DOGRULANMADI — sistematik Redis migration yapilmamis |
| H-7 | **HR CertificationExpiryService transaction boundary missing** | hr-service | DOGRULANMADI |
| H-8 | **console.log in production (sistematik)** | multiple files | MigrationLogger olusturuldu ama adoption dogrulanmadi |
| H-9 | **GDPR export offset pagination on partitioned table** | messaging-service | DOGRULANMADI |
| H-10 | **Messaging: confirmAiAction channel membership check** | messaging-service | DOGRULANMADI |

---

## ADIM 5: Kalite Degerlendirmesi — Her Fix Icin Mimari Puanlama

### ENTERPRISE-GRADE Mimari Cozumler (Gercek fix'ler)

| Fix | Neden Enterprise-Grade |
|-----|----------------------|
| CloseBatchHandler transaction + event | QueryRunner pattern, post-commit event publish, structured logging |
| Billing resolver userId | `extractUserId()` fail-closed, RBAC 6-tier, UUID validation |
| Webhook encryption key validation | `onModuleInit()` fail-fast, AES-256-GCM, SSRF blocklist |
| JWT verification utils (centralized) | Single source of truth, library-level enforcement, no conditional bypass |
| GqlAuthGuard (farm) algorithm fix | Centralized utility import, no duplication |
| BatchDocumentDataLoader | Scope.REQUEST, proper batching, type-filtered post-query |
| BatchTransferred event publish | Complete event body, post-commit, DomainEventPublisher |
| SW LOGOUT cache clearing | 3-layer teardown (IndexedDB + CacheStorage + SW message) |
| Token type strict enforcement | SEC-COMPAT sunset properly executed, backward compat removed |
| VFD IDOR fix (sensor-service) | `@Tenant()` + tenantId in WHERE clause, all resolvers + services |
| Legal hold check (messaging) | Injected LegalHoldService, isUnderLegalHold() per-channel |
| AI content sanitization | `sanitizeContent()` on AI response + metadata values |
| SeaWorthy check (hr-service) | Transaction-scoped read, personnel category filter |
| currentRotationId tracking (hr-service) | start/end/cancel all update employee record |

### YAMA (Patch) — Fix Yapildi Ama Mimari Cozum Degil

| Fix | Neden YAMA | Gercek Mimari Cozum |
|-----|------------|---------------------|
| **SelfRegisterResponse Debug impl EKSIK** | ActivationResponse fix edildi, SelfRegisterResponse atlanmis. Ayni pattern iki struct'ta, biri fix digeri degil. | Tum MQTT-credential-bearing struct'lar icin `#[derive(Serialize, Deserialize)]` + custom Debug impl enforce eden bir macro olusturmak: `#[mqtt_credential_struct]` |
| **FeedingSchedulerService partial IDOR fix** | `executeFeedingSchedule()` fix edildi (tenantId eklendi) ama `updateFeedingStatus()` ve `calculateFeedAmount()` hala tenant filter'siz. Ayni service'teki 3 method'dan sadece 1'i fix edilmis. | Tum 3 method'a tenantId parametresi eklemek + resolver'dan gecirmek |
| **TimescaleDB image pinning KISMEN** | `docker-compose.prod.yml` ve `docker-compose.droplet.yml` pin edilmis ama `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.infra.yml`, `infrastructure/docker/docker-compose.prod.yml` hala `latest-pg16`. | Tum compose dosyalarinda tek bir `.env` degiskeninden (`TIMESCALEDB_IMAGE`) reference almak |
| **CI continue-on-error KISMEN** | `ci-affected.yml` fix edilmis ama `e2e-tests.yml:110`, `cd-production.yml:406`, `deploy-digitalocean.yml:665` hala `continue-on-error: true`. | Tum workflow'lari audit edip, gercekten gerekli olan (artifact cleanup gibi) haric tumunu kaldirmak |

---

## Sistematik Sorunlar — Coklu Commit'e Ragmen Cozulmemis Mimari Borclar

### 1. NATS Tenant Partitioning (CRITICAL-004)
**Durum:** YAPILMADI
**Aciklama:** NATS subject'leri hala `events.{eventType}` formatinda. TenantId subject'e dahil degil. Her consumer her tenant'in event'ini aliyor ve application-layer'da filter etmek zorunda. Tek bir handler'daki tek bir eksik `event.tenantId` check'i cross-tenant data leakage'a yol acar.
**Bu bir ARCHITECTURAL GAP — yama ile cozulemez.** Coordinated migration gerektirir.

### 2. In-Memory State in Multi-Instance Services
**Durum:** YAPILMADI
**Aciklama:** 5+ service in-memory Map kullanarak state tutuyor (TokenRevocationService, WebAuthnService, ImpersonationService, TokenBudgetService, RateLimitService). Kubernetes'te 2+ replica calismasi durumunda bu state paylasilmaz — rate limiting, session tracking, token revocation bypass edilebilir.
**Cozum:** Redis-backed state management. ImpersonationService icindeki in-memory `activeSessions` Map'i bu pattern'in en tehlikeli ornegi.

### 3. Event Publishing Gaps (Systemic)
**Durum:** KISMEN TAMAMLANDI
**Tamamlanan:** CloseBatch, TransferBatch event'leri eklendi
**Hala Eksik:** AllocateToTank, RecordCull, HR domain events (EmployeeCreated, EmployeeUpdated, EmployeeTerminated, PayrollProcessed)
**Cozum:** Event publishing'i handler base class'inda zorunlu kilmak veya command bus middleware ile enforce etmek.

### 4. IDOR Pattern (Cross-Service)
**Durum:** KISMEN TAMAMLANDI
**Tamamlanan:** VFD ChangeSet, VFD AutomationRule, FeedingSchedulerService.executeFeedingSchedule()
**Hala Eksik:** FeedingSchedulerService.updateFeedingStatus(), calculateFeedAmount(), ConversationService.getById(), GdprService raw SQL
**Cozum:** TypeORM global subscriber veya custom decorator ile tenantId enforce etmek.

---

## Sayisal Ozet

| Severity | Toplam Bulgu | Fix Edildi | Kismen | Yapilmadi | YAMA |
|----------|-------------|------------|--------|-----------|------|
| CRITICAL | 47 | ~25 | 4 | ~8 | 2 |
| HIGH | 103 | ~40 | 5 | ~48 | 2 |
| MEDIUM | 138 | ~30 | — | ~100+ | — |
| LOW | 78 | ~15 | — | ~60+ | — |

**Not:** MEDIUM ve LOW kategorilerinin cogu bu audit'te tek tek dogrulanmadi. Yukaridaki sayilar commit scope'larindan tahmini olarak turetilmistir.

---

## Oncelikli Aksiyon Plani

### P0 — Hemen (Deployment Blocker)
1. `SelfRegisterResponse` custom Debug impl (MQTT credential leak)
2. `FeedingSchedulerService.updateFeedingStatus()` ve `calculateFeedAmount()` tenantId eklenmesi
3. NATS subject'lere tenantId segment eklenmesi icin RFC hazirlama (mimari karar — koordineli deployment gerektirir)
4. `RecordCullHandler` TOCTOU fix dogrulama

### P1 — Bu Sprint
5. Tum `docker-compose*.yml` dosyalarinda TimescaleDB pinning
6. Kalan `continue-on-error: true` temizligi (e2e, cd-production, deploy)
7. AllocateToTank event publishing
8. HR domain event publishing (en az EmployeeCreated, EmployeeTerminated)
9. In-memory state -> Redis migration (ImpersonationService oncelikli)

### P2 — Sonraki Sprint
10. Event publishing middleware/base class (sistematik enforce)
11. IDOR audit tum service'ler icin (automated test)
12. HR authorization over-permissiveness fix
13. console.log -> MigrationLogger migration (tum dosyalar)

---

*Report generated 2026-04-05 by gap analysis comparing 366 audit findings against 15 fix commits.*
*12 kritik dosya kaynak koddan dogrudan okunarak dogrulandi.*
