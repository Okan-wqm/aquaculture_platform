# Enterprise Roadmap: Kalan 121 Audit Bulgusu

**Tarih:** 2026-04-05
**Kaynak:** 4 Nisan 2026 deep audit (366 bulgu) — 245 kapatıldı, 121 kaldı
**Durum:** Onaylandı (Ultraplan)

---

## Özet

| İş Paketi | Bulgu | Sprint | Öncelik |
|-----------|-------|--------|---------|
| İP-4: AI Redis + Impersonation | 5 MEDIUM | 1 hafta | P1 |
| İP-1: Internal TLS (NATS/Redis/PG) | 3 MEDIUM | 2 hafta | P2 |
| İP-2: MFA Step-Up + Subscription Scheduling | 2 HIGH + 1 MEDIUM | 2 hafta | P2 |
| İP-3: Batch Refactoring + Test Coverage | ~41 LOW | 4 hafta | P3 |

---

## İP-4: AI Service Redis + Impersonation State Migration

### Problem
3 servis in-memory `Map` kullanıyor — multi-instance'ta rate limit ve token budget N×configured olur.

### Dosyalar
- `apps/ai-service/src/app.module.ts` — RedisModule.forRootAsync() import
- `apps/ai-service/src/cost/rate-limit.service.ts` — Map → Redis INCR+EXPIRE
- `apps/ai-service/src/cost/token-budget.service.ts` — Map → Redis INCRBY+EXPIREAT
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts` — rateLimit Map → Redis
- `docker-compose.droplet.yml` + `docker-compose.prod.yml` — AI service REDIS_URL

### Redis Key Patterns
- Rate limit: `ai:ratelimit:{tenantId}:{YYYY-MM-DD-HH}` (TTL: 3600s)
- Token budget: `ai:tokens:{tenantId}:{YYYY-MM}` (TTL: ayın kalan saniyesi)
- Impersonation: `impersonate:ratelimit:{adminId}` (TTL: 300s)

### Doğrulama
- TypeScript compile clean
- CI green
- Unit test: Redis branch mock

---

## İP-1: Internal TLS — NATS/Redis/PostgreSQL Şifreli İletişim

### Problem
Tüm inter-service trafik plaintext. Container escape senaryosunda tüm event data (PII, finansal) okunabilir.

### Adımlar
1. Cert generation script: `infrastructure/docker/scripts/generate-internal-certs.sh`
2. NATS TLS: mount `nats-tls-enabled.conf`, `NATS_URL: tls://nats:4222`
3. Redis TLS: `--tls-port 6380`, `REDIS_URL: rediss://`
4. PG SSL: `-c ssl=on`, `?sslmode=require`

### Dosyalar
- `infrastructure/docker/scripts/generate-internal-certs.sh` (yeni)
- `docker-compose.droplet.yml` — tüm URL'ler TLS
- `docker-compose.prod.yml` — aynı
- `infrastructure/docker/nats/nats-tls-enabled.conf` (mevcut)

---

## İP-2: MFA Step-Up + Subscription Scheduling

### 2A: MFA Step-Up Endpoint
- `POST /auth/step-up` → MFA code verify → step-up token (5 min TTL)
- `POST /impersonation/start` → `X-Step-Up-Token` header required
- Dosyalar: auth-service step-up controller+service, admin-api step-up guard

### 2B: Subscription Downgrade Scheduling
- `scheduled_plan_changes` tablosu (PENDING → APPLIED at period end)
- `change-subscription-plan.handler.ts` downgrade branch → insert pending row
- `billing-scheduler.service.ts` → yeni cron: apply pending changes

---

## İP-3: Batch Refactoring + Test Coverage

### 3A: File Size
- `batch.entity.ts` (657 satır) → entity + BatchDomainService
- `batch.resolver.ts` (939 satır) → resolver + DTO dosyaları

### 3B: Test Coverage
- Öncelik: CQRS handlers > Guards > Billing > Resolvers > Cron
- Hedef: %40 line coverage (aşamalı artış)
- Mock factory'ler: `createMockDataSource()`, `createMockEventPublisher()`

---

## Sprint Takvimi

```
Hafta 1:    İP-4 (AI Redis + Impersonation)
Hafta 2-3:  İP-1 (Internal TLS)
Hafta 4-5:  İP-2 (MFA + Subscription)
Hafta 6-9:  İP-3 (Refactoring + Tests)
```
