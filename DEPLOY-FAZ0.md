# MSGFIX — FAZ 0 Backend Raporu (Ajan-B)

Tarih: 2026-09-16 · Worktree: `/var/aqua-messaging-fix` (dal `messaging-fix-1`, taban `9b44390f`) · Commit ATILMADI (koordinatör yapacak).

---

## 0. Ortam hazırlığı

- Worktree'de node_modules yoktu. `/var/aqua-saas-auth-fence/node_modules` symlink'lendi (`ln -s /var/aqua-saas-auth-fence/node_modules /var/aqua-messaging-fix/node_modules`).
  - Gerekçe: auth-fence worktree bizim tabanımızın tam 1 commit ilerisinde (`git rev-list --count 9b44390f..873d267bf1` → 1) ve `package-lock.json` birebir aynı (`diff -q` → LOCKS IDENTICAL). Ana ağacın (`/var/aqua-saas`) node_modules'u 19:18'de hâlâ aktif frontend kurulumu tarafından değişiyordu — canlı ağaca symlink riskliydi.
- **Baseline test (değişiklik ÖNCESİ):** `npx nx run messaging-service:test` →
  `Test Suites: 1 skipped, 43 passed, 43 of 44 total` / `Tests: 1 skipped, 287 passed, 288 total` — YEŞİL.

---

## 1. Görev 1 — Gözlemlenebilirlik metrikleri

### Keşif (tasarımı belirledi)

- Outbox tablosu **source-only**: `migrations/1800200000000-CreateMessagingOutboxTable.ts:28` tabloyu `messaging.messaging_outbox` olarak yaratır; `postCondition` (aynı dosya :130-141) herhangi bir `tenant_*` şemasında kopya varsa MİGRASYON BAŞARISIZ olur; `1800400000000-EnforceSourceOnlyMessagingOutboxContract.ts` sözleşmeyi zorlar. Worker (`platform/libs/outbox/src/outbox-worker.service.ts:129`) da tek repository (şema `messaging`) üzerinde çalışır → **tek kaynak şema = platformun tamamının backlog'u; tenant şeması gezinmesine gerek yok, sorgu zaten ucuz** (parçalı indeks `idx_outbox_poll`, migration :94-97).
- Pending işareti: `"publishedAt" IS NULL` (yayımlanmamış) + `"isDeadLettered" = false` (terminal satır hariç).
- **Kritik bulgu:** `messaging_outbox_pending` gauge'ı `MessagingMetricsService`'te kayıtlıydı ama **hiçbir kod `setOutboxPending()` çağırmıyordu** (repo-geneli grep: yalnızca tanım). Worker'ın kendi `outbox_pending{service}` gauge'ı ise GLOBAL `client.register`'da yaşıyor; `ServiceMetricsService.getMetrics()` (backend-common `metrics/metrics.service.ts:147-164`) yalnızca kendi registry'si + contributor'ları servis eder → o gauge scrape'te YOK. Yani outbox backlog'u Prometheus'a hiç akmıyordu.

### Yapılanlar

| Dosya                                                                                   | Değişiklik                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/messaging-service/src/metrics/messaging-metrics.service.ts:39-40,130-141,236-244` | YENİ (additive) metrikler: `messaging_nats_reconnects_total` (counter) + `messaging_nats_connection_status` (enum gauge: 2=connected, 1=reconnecting, 0=disconnected) ve public setter metotları.                                                                                                                                                                                                                                                                   |
| `apps/messaging-service/src/metrics/outbox-pending-collector.service.ts` (YENİ)         | 30 saniyede bir (`@Cron(CronExpression.EVERY_30_SECONDS)`) `messaging.messaging_outbox` pending sayısını sayıp `messaging_outbox_pending` gauge'ına yazar. Sayım, worker'ın ORPHAN-HIGH-321 deseniyle transaction-içi `set_config('app.bypass_rls','on',true)` ile sistem bağlamında (RLS altında 0 okuma yalanına karşı). `onModuleInit`'te ilk ölçümü hemen yapar (fire-and-forget, DB yoksa boot'u bloklamaz). Hata yutulur (tek WARN), scheduler asla patlamaz. |
| `apps/messaging-service/src/metrics/nats-connection-metrics.service.ts` (YENİ)          | Event-bus'ın KENDİ lifecycle API'sine abone olur: `NatsEventBus.onCoreConnectionLifecycle()` (`platform/libs/event-bus/src/nats/nats-event-bus.ts:695-701` — kütüphaneye DOKUNULMADI; hook zaten public/export). Snapshot'ları yukarıdaki metriklere çevirir. `connected` snapshot'ı ilk kez gelmişse sayaç ARTMAZ (initial connect ≠ reconnect); ondan sonra gelen her `connected` bir toparlanma = +1. Bus hook'u yoksa tek WARN ile sessiz degradesyon.          |
| `apps/messaging-service/src/metrics/metrics.module.ts`                                  | İki collector providers listesine eklendi. Metrikler `MessagingMetricsService`'in domain registry'sine yazıldığından **/metrics'te otomatik expose** olur — endpoint zaten `@Public()` platform `MetricsController`'ı (backend-common `metrics/metrics.controller.ts:29-31`), messaging registry'si `messaging-domain` contributor olarak bağlı (ORPHAN-089). Yeni endpoint/surface YOK.                                                                            |
| Testler                                                                                 | `metrics/__tests__/outbox-pending-collector.spec.ts` (4 test) ve `metrics/__tests__/nats-connection-metrics.spec.ts` (5 test) — ikisi de gerçek `MessagingMetricsService` registry'sinin **prom-client exposition çıktısını** assert eder (`^messaging_outbox_pending 42$` vb.); mock çağrı sayımı değil.                                                                                                                                                           |

Bilinçli kapsam kararı: `messaging_outbox_oldest_pending_age_seconds` gauge'ı da hâlâ ölü (yazan yok) — Faz 0 kapsamı "pending gauge" idi; platform worker'ın kendi `outbox_oldest_pending_age_seconds{service}` yaş alarm'ı ayrıca mevcut. Temizliği Faz 1/2'ye not.

### 1b'nin teknik gerekçesi (özet)

16 saatlik NATS kesintisi görünmezdi çünkü transport'a dair TEK metric yoktu. Reconnect sayacı "connected → (disconnect|reconnecting) → connected" geçişini sayar; `reconnecting` başlangıç connect'inde de görüldüğünden ayrı bir `hasConnectedOnce` bayrağı ilk bağlantıyı sayınç dışı bırakır (test bunu pinler: boot dizisi 0'da kalır, kesinti+toparlanma +1).

---

## 2. Görev 2 — GraphQL hata kodu sözleşmesi (additive)

### Keşif (worktree gerçekleri görev varsayımından farklı)

- `libs/backend-common` içinde `global-exception.filter.ts` YOK; `filters/http-exception.filter.ts` içindeki 3 filter deprecated (dosya başı TODO) ve messaging bunları KULLANMIYOR.
- Görevde belirtilen `:185-193` satırları **`apps/gateway-api/src/filters/global-exception.filter.ts:185-193`** ile eşleşti: gateway'in `parseException` GraphQLError dalı `extensions.statusCode ?? 500` okur. Zincir: messaging resolver `NotFoundException` atar → messaging'de HİCBİR exception filter kayıtlı değildi → Apollo extensions'suz sarar → gateway 500/INTERNAL_SERVER_ERROR üretir. **Kök neden subgraph tarafı.**
- "Tenant ID is required" kaynağı: `libs/backend-common/src/guards/tenant.guard.ts:182-186` (eski hali) — `user` yokluğu ile `user` var ama `tenantId` yokluğu aynı `BadRequestException`'a harmanlanmıştı.

### Yapılanlar

| Dosya                                                                  | Değişiklik                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/messaging-service/src/filters/global-exception.filter.ts` (YENİ) | messaging'e ilk global exception filter. Farm-service/canlı gateway deseni birebir: HttpException status → GraphQL kodu — **404→NOT_FOUND, 401→UNAUTHENTICATED, 403→FORBIDDEN**, 400→BAD_REQUEST, 409→CONFLICT, 422→UNPROCESSABLE_ENTITY, 429→TOO_MANY_REQUESTS, default→INTERNAL_SERVER_ERROR. `extensions.code` **ve** `extensions.statusCode` birlikte set edilir (gateway kodu statusCode'dan türetir — federation extensions'ı taşır, zincir kapanır). **Kendi kodu olan GraphQLError'a dokunmaz** (pass-through, aynı instance döner). REST branch'i platform zarfını korur; prod 5xx mesaj sanitizasyonu farm ile aynı (REST + GraphQL — M-1 düzeltmesiyle). |
| `apps/messaging-service/src/app.module.ts:19,126,365-372`              | `{ provide: APP_FILTER, useClass: GlobalExceptionFilter }` kaydı (tek APP_FILTER).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `libs/backend-common/src/guards/tenant.guard.ts:8,182-199`             | **ADDITIVE**: `!tenantId` ikiye ayrıldı — **auth bağlamı hiç yoksa (`!user`) `UnauthorizedException` (401 → UNAUTHENTICATED)**; user VAR ama tenantId yoksa mevcut `BadRequestException` AYNEN KALDI ("The JWT must contain a valid tenantId claim." mesajı değişmedi).                                                                                                                                                                                                                                                                                                                                                                                             |
| Testler                                                                | `apps/messaging-service/src/filters/__tests__/global-exception.filter.spec.ts` (7 test): NotFound→NOT_FOUND(404), Unauthorized→UNAUTHENTICATED, Forbidden→FORBIDDEN, 400/409 tablo, mevcut kodlu GraphQLError passthrough, prod 5xx sızıntı sanitizasyonu, REST zarfı. `libs/backend-common/src/guards/__tests__/tenant.guard.spec.ts`: +2 additive test (user'sız→Unauthorized; user'lı tenantId'siz→BadRequest kalır). Mevcut 37 test değiştirilmeden duruyor ve geçiyor.                                                                                                                                                                                         |

backend-common'e dokunuş **minimum ve additive**: yalnızca import satırı + `if (!user)` dalı; başka hiçbir davranış, mesaj veya kod değişmedi. Diğer tüm servislerde kullanıcı bağlamı OLAN yollar birebir aynı.

**GATEWAY-API'YE DOKUNULMADI.** Düzeltmenin iki ayağı da (subgraph filter + TenantGuard) messaging zincirinin kendi parçaları; gateway'in mevcut filter'ı zaten doğru eşliyor. → FAZ 0 deploy listesine gateway-api EKLENMEZ; yalnızca messaging-service imajı (aşağıda).

---

## 3. Görev 3 — AI kill-switch + cron ateşkesi

| Dosya                                                                                             | Değişiklik                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/messaging-service/src/ai/ai-trigger.config.ts` (YENİ)                                       | `AiTriggerConfig` servisi: `triggerEnabled` = `MESSAGING_AI_TRIGGER_ENABLED` (default **false**). STRICT parser (`parseMessagingAiEnabledFlag`): yalnızca trim+lowercase 'true' açar; unset/boş/diğer her değer ('1','yes','ture'...) KAPALI kalır (typo fail-closed). Kapalıyken startup'ta TEK satır log (nedeni + nasıl açılır). Cron sabitleri (`MESSAGING_AI_EMBEDDING_CRON_ENABLED_ENV`, `MESSAGING_AI_KNOWLEDGE_CRON_ENABLED_ENV`) ve `messagingAiFlagEnabled()` helper'ı da burada — tek SSoT. **ai-egress-gate.service.ts'e DOKUNULMADI** (Faz 2 bağlayacak). |
| `apps/messaging-service/src/ai/ai.module.ts:42-44,120-123,126`                                    | `AiTriggerConfig` provider+export (Faz 2 tetikleyicisi inject edecek).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `apps/messaging-service/src/ai/services/embedding.service.ts:13-23,52,63,70-80,95`                | `MESSAGING_AI_EMBEDDING_CRON_ENABLED` default false. Cron gövdesinin İLK satırı `if (!this.cronEnabled) return;` (kapalı tick DB'ye/NATS'a dokunmaz). Startup'ta tek INFO: "Embedding cron disabled by config (...)". Kod SİLİNMEDİ (temizlik Faz 2.1) — sadece kapı.                                                                                                                                                                                                                                                                                                  |
| `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:22-41,97,108,120-130,142` | Aynı desen, `MESSAGING_AI_KNOWLEDGE_CRON_ENABLED`, `@Cron('0 * * * *')` ateşkes altında. Canlıda rızasız veri işleyen cron artık default kapalı.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Testler                                                                                           | `ai/__tests__/ai-trigger.config.spec.ts` (7 test: env yok→false, 'true'→true, 'TRUE '→true, typo değerleri→false, startup tek-satır log × silent-when-enabled, parser helper'ları). Mevcut `embedding.service.spec.ts` ve `knowledge-extraction.tank-registry.spec.ts` beforeEach'lerine flag='true' eklendi (pipeline testleri kapı AÇIKken davranışı pinler; env afterEach'te restore) + her birine "ceasefire (default OFF)" describe'ı: flag yok/'yes' → tick DB'ye ve NATS'a hiç dokunmaz; startup INFO satırı tam 1 kez.                                         |

Sonuç: **deploy sonrası üç log satırı beklenir** (trigger disabled / embedding cron disabled / knowledge cron disabled) ve AI boru hattı hiçbir veri işlemez.

---

## 4. Doğrulama çıktıları (komutlar çalıştırıldı)

### npx nx run messaging-service:test

```
Test Suites: 1 skipped, 47 passed, 47 of 48 total
Tests:       1 skipped, 317 passed, 318 total
Snapshots:   0 total
Time:        31.962 s
NX   Successfully ran target test for project messaging-service
```

Baseline 287 passed/1 skipped → **317 passed/1 skipped (+30 yeni test, 0 regression)**. Yeni 4 suite: metrics×2, filters×1, ai-trigger×1.

### npx nx run backend-common:test (paylaşılan lib — mevcut specler korunmalı)

```
Test Suites: 124 passed, 124 total
Tests:       1374 passed, 1374 total
Time:        49.237 s
NX   Successfully ran target test for project backend-common
```

### npx nx run messaging-service:build (tsc — Dockerfile.backend.simple host artifact'ı bunu kullanır)

```
> npx tsc -p platform/libs/service-catalog/tsconfig.lib.json --noEmit
BUILD OK: messaging-service
NX   Successfully ran target build for project messaging-service and 1 task it depends on
```

### Lint

- `npx nx run messaging-service:lint` → **"✔ All files pass linting"** (tüm yeni dosyalar dahil).
- `npx nx run backend-common:lint` → HEDEF TABAN COMMIT'TE DE KIRMIZI (onlarca dokunulmamış dosya: ai-safety, audit spec'leri, health spec'leri...). Değiştirdiğim iki dosya (`tenant.guard.ts` + spec) için stash ile karşılaştırma yapıldı: **hata listesi birebir aynı 5 önceden-var hata** (4×import/order + 1×no-unsafe-member-access, satırları benim +1 satırlık import kaymasıyla ötelenmiş). **Benim değişikliğimden SIFIR yeni lint hatası.** (Kaynak: `git stash push -- <iki dosya>` → lint → `git stash pop`; iki çıktı `/tmp/lint-mine.txt`–`/tmp/lint-base.txt` karşılaştırması.)

---

## 5. FAZ 0 Deploy reçetesi

**GATEWAY-API DOKUNULMADI → deploy yalnızca messaging-service.**

### 5.1 İmaj build (worktree'den, host pre-build gerektirir)

```bash
# 1) Host build — Dockerfile.backend.simple pre-built dist kopyalar (dosya:46,66)
cd /var/aqua-messaging-fix
npx nx run messaging-service:build

# 2) İmaj (tam ad görevdeki gibi)
DOCKER_BUILDKIT=1 docker build \
  -f infrastructure/docker/Dockerfile.backend.simple \
  --build-arg SERVICE_NAME=messaging-service \
  -t ghcr.io/okan-wqm/aquaculture_platform/messaging-service:local-msg-fix-0 \
  /var/aqua-messaging-fix
```

Not: `docker-bake.hcl`'de messaging için `*-simple` hedefi tanımlı değil (group `backend-simple` :244-256 sadece 9 servis) → düz `docker build` (yukarıdaki).

### 5.2 Deploy (droplet checkout — DOKUNMA, sadece çalıştır)

```bash
cd /var/lib/aqua/deploy/checkout && \
TAG=local-msg-fix-0 docker compose -p aqua-saas -f docker-compose.droplet.yml \
  up -d --no-deps messaging-service
```

DİKKAT — görev taslağındaki `messaging` adı düzeltildi: compose servis anahtarı **`messaging-service`** (worktree `docker-compose.droplet.yml:1615`, checkout kopyası `:1753`; konteyner adı `aqua-messaging`, imaj satırı `ghcr.io/okan-wqm/aquaculture_platform/messaging-service:${TAG}`).

Rollback: aynı komutla önceki TAG (ör. `TAG=<önceki-tag> ... up -d --no-deps messaging-service`).

### 5.3 Checkout compose'a eklenecek env bloğu (messaging-service.environment altına)

```yaml
# MSGFIX-FAZ0 (2026-09-16): AI kill-switch + cron ateşkesi.
# Hepsinin kod default'u 'false' — compose'a YAZILMASA DA KAPALI kalırlar;
# buraya yazılıyorlar ki niyet (ateşkes) konfigürasyondan okunabilsin.
MESSAGING_AI_TRIGGER_ENABLED: 'false' # Faz 2 trigger master switch (ai/ai-trigger.config.ts)
MESSAGING_AI_EMBEDDING_CRON_ENABLED: 'false' # 5dk'lık embedding cron'u (embedding.service.ts)
MESSAGING_AI_KNOWLEDGE_CRON_ENABLED: 'false' # saatlik knowledge-extraction cron'u (knowledge-extraction.service.ts)
```

Açıklama değeri: opsiyonel ama önerilir — kimse "cron neden çalışmıyor" diye aramadan hangi env'in neyi kapattığını compose'dan okur. (Çalışma dizinindeki `docker-compose.droplet.yml`'ye ben dokunmadım; zaten mevcut olan `nats-exporter` değişikliği başkasına ait — koordinatör diff'i yorumlarken bilsin.)

### 5.4 Post-deploy doğrulama

```bash
# 1) Ateşkes logları (3 satır beklenir):
docker logs aqua-messaging 2>&1 | grep -E \
  "Messaging AI trigger DISABLED|Embedding cron disabled|Knowledge extraction cron disabled"

# 2) Yeni metrikler /metrics'te (endpoint @Public, container içinden):
docker exec aqua-messaging curl -s localhost:3000/metrics | grep -E \
  "messaging_nats_connection_status|messaging_nats_reconnects_total|messaging_outbox_pending"
# messaging_nats_connection_status 2  (connected) beklenir

# 3) GraphQL sözleşme (gateway üzerinden, mevcut token'sız istek):
#    artık extensions.code=UNAUTHENTICATED (önce BAD_REQUEST/INTERNAL karışımıydı);
#    var-olmayan kayıt sorgusu → extensions.code=NOT_FOUND (önce INTERNAL_SERVER_ERROR).
```

---

## 6. Değişiklik envanteri (dosya:satır)

**Yeni dosyalar (7):**

- `apps/messaging-service/src/metrics/outbox-pending-collector.service.ts`
- `apps/messaging-service/src/metrics/nats-connection-metrics.service.ts`
- `apps/messaging-service/src/metrics/__tests__/outbox-pending-collector.spec.ts` (4 test)
- `apps/messaging-service/src/metrics/__tests__/nats-connection-metrics.spec.ts` (5 test)
- `apps/messaging-service/src/filters/global-exception.filter.ts` + `__tests__/global-exception.filter.spec.ts` (7 test)
- `apps/messaging-service/src/ai/ai-trigger.config.ts` + `ai/__tests__/ai-trigger.config.spec.ts` (7 test)

**Değişen dosyalar (9):**

- `apps/messaging-service/src/metrics/messaging-metrics.service.ts` (+2 metrik additive)
- `apps/messaging-service/src/metrics/metrics.module.ts` (+2 provider)
- `apps/messaging-service/src/app.module.ts` (+APP_FILTER)
- `apps/messaging-service/src/ai/ai.module.ts` (+AiTriggerConfig)
- `apps/messaging-service/src/ai/services/embedding.service.ts` (cron kapısı)
- `apps/messaging-service/src/ai/services/knowledge-extraction.service.ts` (cron kapısı)
- `apps/messaging-service/src/ai/services/__tests__/embedding.service.spec.ts` (env=true + 3 ceasefire testi)
- `apps/messaging-service/src/ai/services/__tests__/knowledge-extraction.tank-registry.spec.ts` (env=true + 3 ceasefire testi)
- `libs/backend-common/src/guards/tenant.guard.ts` (+UnauthorizedException dalı) + `__tests__/tenant.guard.spec.ts` (+2 test)

**Dokunulmayanlar:** `platform/libs/event-bus` (lifecycle hook zaten vardı), `platform/libs/outbox`, `ai-egress-gate.service.ts`, `apps/gateway-api`, `/var/aqua-saas`, `/var/lib/aqua/deploy/checkout`.
