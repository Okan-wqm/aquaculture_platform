# MSGFIX — FAZ 1 Backend Raporu (Ajan-B)

Tarih: 2026-09-16/17 · Worktree: `/var/aqua-messaging-fix` (dal `messaging-fix-1`, taban FAZ 0: `0bdeb199ff`) · **Commit ATILMADI** (koordinatör yapacak).

---

## 0. Özet

| Görev | Sonuç |
|---|---|
| 1 — Redis idempotency fast-path kapsamı | Anahtar `msg:{tenantId}:{senderId}:{channelId}:{key}`'e kapsamlandı + fast-path dönüşünde sender/kanal doğrulaması + anahtar loglandı (SHA-256 fingerprint). |
| 2 — markMessagesRead rate-limit | `markRead: { limit: 60, windowSeconds: 60, failMode: 'fail-open' }` kuralı + resolver'a `@MessagingRateLimit('markRead')`; 429 → `extensions.code=TOO_MANY_REQUESTS` (FAZ 0 filter sözleşmesi). |
| 3a — Canlı NATS teşhisi | **Karar ağacı sonucu: (i) consumer bağlı + pool normal → KOD YOLU HATASI.** Kök neden ispatlandı: NATS handler'ları `app.current_tenant` RLS GUC'u set etmiyor → tüm request-reply handler'lar sessizce 0 satır okuyor. |
| 3b — verifyMembership tenantId predicate | Predicate eklendi **+ kök neden düzeltmesi**: `withTenantQueryRunner`'a `bindTenantRlsContext` (backend-common kanonik deseni). Canlıda kanıtlanmış yanlış-redler ve hidrasyon null'ları bu tek satırla açılır. |

Test: **baseline 318 passed + 1 skipped → 330 passed + 1 skipped (+12 yeni, 0 regresyon)**. Build ✔, lint ✔, banned-construct ✔, prettier (değişen dosyalar) ✔.

---

## 1. Görev 1 — Redis idempotency fast-path kapsamı

`apps/messaging-service/src/message/commands/send-message.handler.ts`

### Değişiklikler

1. **Anahtar kapsamı** (eski satır 74): `msg:${tenantId}:idem:${idempotencyKey}` → **`msg:${tenantId}:${senderId}:${channelId}:${idempotencyKey}`**. TTL değişmedi (`IDEMPOTENCY_TTL_SECONDS` = 7 gün). Redis cache anahtarı artık DB ledger PK'sıyla (tenantId, channelId, senderId, idempotencyKey) birebir hizalı — düşman-ajan senaryosu (aynı tenant'ta iki kullanıcı aynı client anahtarını seçerse kurbanın mesajının yutulması) yapısal olarak kalktı.
2. **Fast-path dönüş doğrulaması** (eski satır 85-92): `findOne({ tenantId, id })` sonucu yalnızca `existing.senderId === senderId && existing.channelId === channelId` ise onurlanır; uyuşmazlık **cache miss** sayılır → transaction-içi ledger claim (authority) çalışır, 5. adımdaki SETEX yanlış girdiyi doğru mesaj id'siyle ezerek iyileştirir (self-healing).
3. **Log sızıntısı** (eski satır 78): `key=${idempotencyKey}` içeren debug satırı kaldırıldı; yerine yeni `fingerprint()` helper'ı — SHA-256'in 16 hexası (tek yönlü; ham client verisi loga girmez, iki log satırı hâlâ birleştirilebilir).

### Spec'ler (`__tests__/send-message.handler.spec.ts`)

- Güçlendirilen mevcut test: `setex` anahtarı artık tam kapsamlı formatta assert ediliyor.
- **YENİ** `keys the cache per (tenant, sender, channel) — a different sender with the same key does NOT collide`: iki sender, aynı idempotencyKey → iki FARKLI Redis anahtarı, iki SET NX claim'i, iki tam DB insert'i (`ledgerInsertBuilder.execute` ×2) — yutulan mesaj yok.
- **YENİ** `treats a fast-path hit resolving to a DIFFERENT sender/channel as a cache miss`: anahtar var ama değeri başka sender'ın mesajı → foreign mesaj DÖNDÜRÜLMÜYOR (`result.id ≠ foreign.id`), ledger claim 1 kez koşuyor, SETEX girdiyi bu gönderimin id'siyle eziyor.
- Mevcut `stays idempotent with Redis fully down` (Redis çökünce DB authority) testi değişmeden geçiyor — doğrulandı.
- `test/messaging-core.e2e-spec.ts:140` (real-DB e2e, unit run'ın dışında): Redis temizleme anahtarı yeni formata güncellendi (`msg:${TENANT_A}:${USER_A1}:${channelId}:${idemKey}`).
- Geçiş notu: eski formattaki (`msg:{tenant}:idem:{key}`) Redis girdileri TTL (≤7 gün) sonunda kendiliğinden söner; yeni format ayrı ad uzayı olduğu için okunmazlar — zorunlu temizlik/migration YOK.

---

## 2. Görev 2 — markMessagesRead rate-limit binding

- `apps/messaging-service/src/shared/interceptors/messaging-rate-limit.interceptor.ts` — `DEFAULT_RULES`'a eklendi:
  `markRead: { limit: 60, windowSeconds: 60, failMode: 'fail-open' }`.
  Gerekçe: FAZ 1.2 UI'ı görünürlük-tabanlı her mesaj için çağıracak (60/dk ≈ saniyede 1) — meşru trafiği absorbe eder, çağrı-başı-transactional-write olan tight self-DoS döngüsüne ket vurur. Oku-yakını UX yüzeyi → `fail-open` (sınıfın mevcut taxonomy'siyle uyumlu; billable yüzeyler fail-closed).
- `apps/messaging-service/src/message/resolvers/message.resolver.ts` — `markMessagesRead` mutasyonuna `@MessagingRateLimit('markRead')` eklendi (resolver sınıf düzeyinde `@UseInterceptors(MessagingRateLimitInterceptor)` zaten vardı; eksik olan handler-metadata'ydı).

### Spec'ler (`interceptors/__tests__/messaging-rate-limit.interceptor.spec.ts`, +5)

1. 59 istek pencerede → izin (görünürlük-tabanlı çağrı absorbe).
2. 60 dolu → **429** + `retryAfter=60`, handler'a uğramaz.
3. Redis outage → fail-OPEN (okundu bilgisi kesintide sohbeti kilitlemez).
4. `markMessagesRead` metodunda metadata gerçekten `markRead` (decorator bağlanması — kural ölü konfig olmasın).
5. **Filter sözleşmesi zinciri**: interceptor'ın 429'u FAZ 0 `GlobalExceptionFilter`'ından geçince `extensions.code === 'TOO_MANY_REQUESTS'` + `extensions.statusCode === 429` (FAZ 0 filter sözleşmesi otomatik eşliyor — kanıtlandı).

---

## 3. Görev 3a — CANLI NATS TEŞHİS RAPORU (salt-okunur)

Teşhis saati: 2026-09-16 ~22:15-22:20 UTC. FAZ 0 deploy'unun CANLIDA olduğu görüldü: `aqua-messaging` imajı `local-msg-fix-0`, `StartedAt=2026-09-16T22:12:15Z`, `RestartCount=0`.

### 3.1 Toplanan kanıtlar

**(a) Metrikler** — `docker exec aqua-messaging curl -s localhost:3000/metrics`:
```
messaging_nats_connection_status 2      # connected
messaging_nats_reconnects_total 0       # boot (22:12) sonrası sıfır kesinti
messaging_outbox_pending 0              # backlog yok
```

**(b) NATS bağlantı/subSCRIPTION'lar** — `http://nats:8222/connz?subs=true` (aqua-saas_aqua-internal ağından):
- Bağlantı `messaging-service` (cid 449): `request.messaging.verifyMembership`, `request.messaging.getMessageForBroadcast`, `request.messaging.getChannelMembers`, `request.messaging.resolveNotificationRef`, `request.messaging.getMessageBatch`, `request.messaging.admin.*` (×10), `events.*.UserDeleted`, `events.*.TenantProvisioned` → **microservices transport bağlı, tüm sub'lar yerinde.**
- Bağlantı `gateway-api-messaging-bridge` (cid 305, uptime 17h52m): `events.*.MessageSent/MessageRead/MessageUpdated/MessageDeleted/MessageForwarded/ChannelCreated/ChannelMemberAdded/ChannelMemberRemoved` → köprü bağlı; ancak `out_msgs=12` (~18 saatte!) ve `idle=1h48m53s`.

**(c) JetStream** — `http://nats:8222/jsz?...consumer_detail=true` (account_details altında):
- Tek stream `AQUACULTURE_EVENTS`, **son mesaj `2026-09-16T20:27:35Z`** (teşhis anından ~2 saat önce — o tarihten beri olay akışı yok).
- messaging'in durable pull consumer'ları (`...-events---MessageSent`, `...-TenantErasureRequested`, `...-TenantProvisioned`): `waiting=1` (aktif çekim bekliyor), `ack_pending=0`.

**(d) Gateway logları** — `docker logs aqua-gateway --since 6h`:
```
17:45:38  Client mMMuxpShJrqwCcCRAACa connected — user 8025339a-e6c7-46df-b65a-dcf4f010b861, tenant 7f6b08ab-90e2-46d3-a260-cb985f1fd897
17:45:38  denied join — not a member of channel ddf8e5ca-e0d8-4006-861d-f4e13aeb8cf7
21:32:17  (aynı user) denied join — aynı kanal
22:00:17  (aynı user) denied join — aynı kanal
20:15:55 / 20:16:15 / 20:18:50 / 20:18:55 / 20:20:50 / 20:24:25  Hydration returned no message for <messageId> in <channelId>; emitting sync hint
```

**(e) DB gerçekleri** (salt-okunur SELECT'ler, `docker exec aqua-postgres psql -U aquaculture -d aquaculture`):
```
tenant_7f6b08ab90e246d3.channel_members:
  channelId=ddf8e5ca-e0d8-4006-861d-f4e13aeb8cf7, userId=8025339a-e6c7-46df-b65a-dcf4f010b861,
  leftAt=NULL, role=owner          ← REDDEDİLEN KULLANICI KANALIN AKTİF SAHİBİ!
messaging.channel_members: 0 satır (tüm üyelik verisi tenant şemasında)
hidrasyon-fail 4 mesajı: YALNIZ tenant şemasında mevcut; hepsi isDeleted=t (şu an);
  d478f37c created=20:15:51.45 → hydration null @20:15:55 (yaratılışından 4 sn sonra, henüz silinmemişken)
```

**(f) RLS katmanı**:
```
tenant_7f6b08ab90e246d3.{channel_members,messages,channels}: rls=true, force=true (owner=messaging_schema_owner)
policy tenant_isolation_policy:
  current_setting('app.bypass_rls', true) = 'on'
  OR "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
rol messaging_service: rolsuper=f, rolbypassrls=f   ← RLS'e TABİ
```

**(g) KONTROLLÜ DENEY** (BEGIN; SET LOCAL ROLE messaging_service; … ROLLBACK — salt-okunur):
```
SET LOCAL search_path = tenant_7f6b08ab90e246d3, messaging, public;   ← withTenantQueryRunner'ın yaptığı TEK şey
  → üyelik sorgusu: 0 satır  (RLS satırı gizliyor)
SET LOCAL app.current_tenant = '7f6b08ab-...';
  → aynı sorgu: 1 satır       (HTTP/TenantGuard yolunun yaptığı)
yanlış tenantId predicate'i ile: 0 satır
```

### 3.2 Karar ağacı sonucu

| Dal | Kanıt | Sonuç |
|---|---|---|
| (i) consumer bağlı + pool normal → **kod yolu hatası** | sub'lar yerinde (b); reconnect=0, outbox=0 (a); loglarda pool timeout/exhaustion YOK; olaylar köprüye ULAŞIYOR (hidrasyon denemesi = teslim kanıtı) (d) | **SEÇİLEN DAL — doğrulandı** |
| (ii) DB pool yorgun → FAZ 3.5 | Pool metrikleri expose edilmiyor (grep boş); ama yükleme ilişkili hiçbir timeout/exhaustion belirtisi yok, outbox 0, sorgular anında dönüyor | REDDEDİLDİ |
| (iii) core-NATS kayıp → JetStream durable FAZ 3.4 | Bağlantı up, sub'lar bağlı, olaylar teslim edilmiş (hidrasyon tetiklenmiş) | REDDEDİLDİ (ama bkz. not) |

**Kök neden (ispatlı):** `withTenantQueryRunner` (messaging-nats.handler.ts) yalnızca `search_path` set ediyor; `app.current_tenant` RLS GUC'u HİÇ set edilmiyor. FORCE RLS + `tenant_isolation_policy` altında servis kullanıcısı (`messaging_service`, bypass YOK) tüm satırları göremez → **NATS request-reply handler'larının hepsi (verifyMembership, getChannelMembers, getMessageForBroadcast, resolveNotificationRef) sessizce 0 satır okuyor.** Bu: aktif kanal sahibinin WS join'lerinin "not a member" ile reddi (3 kez, kanıt e-d) + taze gönderilmiş mesajın hidrasyonunun null dönüp "sync hint" üretmesi (kanıt d-e; isDeleted filtresi ayrıca silinmiş mesajlarda da null üretir ama 20:15:55 örneği mesaj henüz silinmemişken RLS kaynaklıdır) + bridge'in 18 saatte yalnız 12 mesaj görmesi. **Bu, "panelden gönderilen mesaj canlı yayınlanmıyor" sendromunun backend ayağıdır.**

**FAZ 3.4'e not (iii) dalı ile ilgili):** köprünün `events.*.*` sub'ları core-NATS (durable değil) — köprü bağlı DEĞİLKEN yayımlanan olaylar kalıcı olarak kaybolur (son 1h48m idle'da akan her şey). JetStream durable bridge FAZ 3.4 için geçerli bir iyileştirme adayı olarak kalsın; bugünkü arıza bundan değil, kod yolundan.

### 3.3 Görev 3b düzeltmesi (teşhis + görev gereği)

`apps/messaging-service/src/event-handlers/messaging-nats.handler.ts`:

1. **Kök neden düzeltmesi** — `withTenantQueryRunner`'a, `setTenantSchema`'dan hemen sonra `await bindTenantRlsContext(queryRunner, tenantId, 'messaging')` eklendi (backend-common `database/tenant-transaction.ts:170` — auth-service'in kullandığı kanonik helper). GUC transaction-lokal set edilir + geri okunarak doğrulanır + pooled bağlantıdan kalabilecek stale `app.bypass_rls='on'` 'off'a zorlanır. GUC alamazsa `TenantContextError` (fail-closed) — sessiz 0-satır okuma bir daha mümkün değil. Bu tek ekleme dosyadaki TÜM handler'ları onarır (verifyMembership, getChannelMembers, getMessageForBroadcast, getMessageBatch, resolveNotificationRef, handleUserDeleted, handleTenantProvisioned).
2. **Explicit tenantId predicate** (görevin asıl istediği) — `verifyMembership` where'üne `tenantId: data.tenantId` eklendi (GraphQL tarafının deseni: message.resolver.ts `validateChannelMembership`). search_path `tenant,messaging,public` olduğu için niteliksiz tablo messaging şemasına düşebilir; predicate, aynı kanal id'si başka tenant'ta yaşarsa yanlış eşleşmeye karşı ikinci savunma katmanı.

**Kapsam açıklaması:** Görev metni 3b'yi "teşhirden bağımsız, her durumda doğru" olarak yalnızca predicate'e indirgemişti; ancak teşhis, predicate'in canlı yanlış-redleri TEK BAŞINA çözmediğini gösterdi (RLS satırı predicate'ten önce gizliyor). RLS GUC bağını da eklemek teşhisin zorunlu sonucudur ve aynı dosyanın 1 satırı + kanonik lib import'udur. **gateway-api'ye DOKUNULMADI** (gerekçe: gereksiz — arıza tamamen subgraph tarafında; FAZ 0'daki kararın devamı).

### 3.4 Spec'ler (YENİ dosya, +5)

`apps/messaging-service/src/event-handlers/messaging-nats.handler.verify-membership.spec.ts`:
1. Aktif üye → `true` + where `{tenantId, channelId, userId}` predicate'i çağrılıyor.
2. **Yanlış tenant aynı kanal id → üye DEĞİL** (`false`; where'de istenen tenant'ın id'si).
3. Satır yok → `false`.
4. **RLS GUC kök neden testi**: `app.current_tenant` set_config'i `search_path`'ten SONRA, GUC read-back'i ondan SONRA, commit en sonda; `app.bypass_rls` 'off'a zorlanıyor (backend-common'ın bypass GUC'ü SQL literal'iyle yazdığı doğrulandı).
5. **Fail-closed**: read-back eşleşmezse handler patlar (TenantContextError), üyelik sorgusu hiç koşmaz, rollback — canlıdaki sessiz 0-satır modu artık imkânsız.

---

## 4. Doğrulama çıktıları

### npx nx run messaging-service:test --skip-nx-cache
```
Test Suites: 1 skipped, 48 passed, 48 of 49 total
Tests:       1 skipped, 330 passed, 331 total
```
Baseline (aynı worktree'de `git stash -u` ile ölçüldü): `318 passed + 1 skipped / 319` → **+12 yeni test, 0 regresyon.**
(+12 = send-message.spec +2, rate-limit.interceptor.spec +5, verify-membership.spec +5 [yeni suite]. Not: FAZ 0 raporunda yazan 317 rakamı yerine worktree HEAD'in gerçek baseline'ı 318'dir.)

### npx nx run messaging-service:build --skip-nx-cache
```
NX   Successfully ran target build for project messaging-service and 1 task it depends on
```

### npx nx run messaging-service:lint --skip-nx-cache
```
NX   Successfully ran target lint for project messaging-service   ✔
```

### Kapılar
- `tools/gates/banned-construct.ts --mode=file <8 değişen dosya>` → **"No banned constructs detected."**
- `tools/quality/quality.mjs format check-changed` → değiştirdiğim 8 dosya prettier-temiz (repo `printWidth: 100`). İki uyarı notu:
  - Değiştirdiğim 4 üretim dosyasında (send-message.handler, message.resolver, messaging-nats.handler, interceptor) **tabanda var olan** prettier borcu vardı (ör. 108 karakterlik satırlar) — `--write` tüm dosyayı normelleştirdi, diff'te benim düzenlemem dışındaki yeniden girintilenmeler bu yüzdendir (stdin-filepath ile taban DRIFT doğrulandı).
  - Kapı hâlâ 4 dosyada "introduced Prettier drift" listeliyor: `e2e/messaging/README.md`, `e2e/messaging/measurements.ts`, `e2e/messaging/messaging-measure.spec.ts`, `web/modules/messaging-module/src/lib/__tests__/graphqlErrors.spec.ts` — bunlar **FAZ 0 commit'lerinin (0bdeb199ff) dosyaları, bana ait değil**, bilinçli olarak dokunulmadı. Koordinatör isterse `format write-changed` ile temizler.
- `tools/quality/format-scope.json` yeniden üretildi (+90 satır) — kapı "stale; regenerate it" dediği için (`format-scope generate`). İstenirse koordinatör geri alabilir.

---

## 5. FAZ 1 Deploy reçetesi

**Yalnızca messaging-service imajı yeniden build + deploy.** gateway-api'ye, compose env'ine veya altyapıya dokunulmadı; yeni env değişkeni YOK (RLS fix kod tarafında; Redis anahtar geçişi migration'sız).

### 5.1 İmaj build (worktree'den, host pre-build gerektirir — FAZ 0 reçetesiyle aynı)

```bash
cd /var/aqua-messaging-fix
npx nx run messaging-service:build

DOCKER_BUILDKIT=1 docker build \
  -f infrastructure/docker/Dockerfile.backend.simple \
  --build-arg SERVICE_NAME=messaging-service \
  -t ghcr.io/okan-wqm/aquaculture_platform/messaging-service:local-msg-fix-1 \
  /var/aqua-messaging-fix
```

### 5.2 Deploy (droplet checkout — DOKUNMA, sadece çalıştır)

```bash
cd /var/lib/aqua/deploy/checkout && \
TAG=local-msg-fix-1 docker compose -p aqua-saas -f docker-compose.droplet.yml \
  up -d --no-deps messaging-service
```
Rollback: aynı komutta `TAG=local-msg-fix-0`.

### 5.3 Post-deploy doğrulama

```bash
# 1) Boot + bağlantı (FAZ 0 metrikleri hâlâ akıyor olmalı):
docker exec aqua-messaging curl -s localhost:3000/metrics | grep -E \
  "messaging_nats_connection_status|messaging_outbox_pending"
# messaging_nats_connection_status 2  beklenir

# 2) RLS fix'in canlı etkisi — 8025339a kullanıcısı ddf8e5ca kanalına WS join denemesi:
docker logs aqua-gateway --since 5m 2>&1 | grep -E "denied join|join"
#    → "denied join — not a member" BİTMELİ (DB'de owner satırı var; artık RLS altında görünür)

# 3) Hidrasyon: panelden mesaj gönder → WS broadcast gövdesi gelmeli;
#    "Hydration returned no message" yalnızca gerçekten silinmiş mesajlar için kalır.

# 4) Rate-limit: aynı kullanıcıyla 60+ markMessagesRead → extensions.code=TOO_MANY_REQUESTS (429).
```

Beklenen davranış değişimleri (özet): (1) NATS yolundaki tüm üyelik/hidrasyon/notification-ref sorguları artık satır görür — canlı chat yayın akışı açılır; (2) RLS read-back'i tutmazsa ilgili NATS isteği LOUD patlar (TenantContextError — eskiden sessiz yanlış-cevap); (3) farklı kullanıcıların aynı idempotency anahtarı artık çakışmaz; (4) markMessagesRead 60/dk üstünde 429.

---

## 6. Değişiklik envanteri (dosya:satır)

**Yeni dosya (1):**
- `apps/messaging-service/src/event-handlers/messaging-nats.handler.verify-membership.spec.ts` (5 test)

**Değişen dosyalar (8 + 1 araç-durum dosyası):**
- `apps/messaging-service/src/message/commands/send-message.handler.ts` — kapsamlı idem anahtarı, fast-path sender/kanal doğrulaması, fingerprint() log helper'ı (+prettier norm.)
- `apps/messaging-service/src/message/commands/__tests__/send-message.handler.spec.ts` — +2 test, 1 test güçlendirildi
- `apps/messaging-service/src/message/resolvers/message.resolver.ts` — markMessagesRead'a @MessagingRateLimit('markRead') (+prettier norm.)
- `apps/messaging-service/src/shared/interceptors/messaging-rate-limit.interceptor.ts` — markRead kuralı
- `apps/messaging-service/src/shared/interceptors/__tests__/messaging-rate-limit.interceptor.spec.ts` — +5 test (429/filter sözleşmesi dahil)
- `apps/messaging-service/src/event-handlers/messaging-nats.handler.ts` — bindTenantRlsContext + verifyMembership tenantId predicate'i (+prettier norm.)
- `apps/messaging-service/test/messaging-core.e2e-spec.ts` — Redis temizleme anahtarı yeni formata
- `tools/quality/format-scope.json` — kapı talimatıyla yeniden üretildi (+90 satır)

**Dokunulmayanlar:** `apps/gateway-api`, `libs/backend-common` (yalnızca MEVCUT export `bindTenantRlsContext` import edildi — lib'e sıfır değişiklik), `platform/libs/*`, `/var/aqua-saas`, `/var/lib/aqua/deploy/checkout`, canlı hiçbir konteyner/veri (tüm canlı erişim salt-okunur: logs/exec/metrics/connz/jsz + ROLLBACK'li salt-okunur SELECT'ler).
