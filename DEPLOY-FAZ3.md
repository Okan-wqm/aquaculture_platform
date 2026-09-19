# MSGFIX FAZ 3 — Dayanıklılık & Performans Backend Ayağı (DEPLOY RAPORU)

Dal: `messaging-fix-1` @ `1192a53ee9` (worktree `/var/aqua-messaging-fix`). Commit/deploy yapılmadı — bu belge deploy talimatıdır.

---

## ⚠️ GATEWAY-API DEPLOY GEREKSİNİMİ (BÜYÜK YAZ — ÖNCE OKU)

**Bu faz, `gateway-api` yeniden build + deploy edilmedan TAMAMLANMAZ.** İki gateway-api dosyası değişti:

| Dosya                                                             | Değişiklik                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/gateway-api/src/websocket/messaging.gateway.ts`             | Çok cihazlı ghost-presence düzeltmesi (Redis INCR/DECR kullanıcı-bazlı bağlantı sayacı, TTL 5dk) + **`tenant:{id}` odasına N×N `presence` broadcast'inin tamamen kaldırılması** |
| `apps/gateway-api/src/websocket/messaging-nats-bridge.service.ts` | NATS → Socket.IO köprüsünde head-of-line engelleme düzeltmesi (bounded-concurrency 20 dispatch)                                                                                 |

**Deploy sırası: 1) db-migrate imajı (yeni 1802300000000 migration'ı içerir) → 2) messaging-service → 3) gateway-api.** Üç imaj aynı ağaçtan, aynı tag ile build edilmeli (db-migrate migration'ları doğrudan bu ağaçtan glob'lar — `apps/db-migrate/src/schema-registry.ts`; DEPLOY-FAZ2 §8 deseni aynen geçerli).

**Geri alma notu:** gateway-api eski imaja dönerse ghost-presence ve N×N broadcast geri gelir (davranışsal gerileme, veri kaybı yok). messaging-service eski imaja dönerse: push fan-out seri hale döner, mark-read ölü Redis yazısı geri gelir, migration ledger'ı ileri kalır (geri uyumlu — yeni kod eski şemada da çalışur; GIN index'in varlığı eski sorguya zarar vermez).

---

## 1. Yapılanlar + Kanıt

### Görev 1 — GIN expression index (3.4, tenant fan-out + partition-aware)

**Dosya (YENİ):** `apps/messaging-service/src/migrations/1802300000000-AddMessagesContentSearchGinIndex.ts` (+ `app.module.ts` migrations[] kaydı).

- **İfade birebir eşleşme:** `search-messages.handler.ts:78-83` sorgusu `to_tsvector('english', m."content") @@ plainto_tsquery('english', :q)` kullanıyor. Index ifadesi `to_tsvector('english'::regconfig, "content")` — parse tree birebir aynı (bağımsız literal → regconfig coercion). `to_tsvector(regconfig, text)`'in **IMMUTABLE** olduğu canlı katalogdan doğrulandı (`pg_proc.provolatile = 'i'`; 1-argümanlı form STABLE'dır, index'lenemez — 2-argüman formu kullanıldı).
- **Partition deseni:** `messages` RANGE(createdAt) partition'lı → parent'ta CONCURRENTLY yasak. Uygulanan desen:
  1. Her partition'da `CREATE INDEX CONCURRENTLY IF NOT EXISTS "<partition>_content_fts_idx" ... USING gin(...)` (her ifade ayrı autocommit sorgusu) + crash artığı INVALID index'leri self-heal drop'u;
  2. Parent'ta `CREATE INDEX IF NOT EXISTS "idx_messages_content_fts" ON ONLY ... USING gin(...)` (catalog-only stub);
  3. Her partition index'i `ALTER INDEX ... ATTACH PARTITION` (pg_inherits'ten kontrol, idempotent). Tüm partition'lar attach olunca parent otomatik VALID olur; **sonradan açılan aylık partition'lar partitioned parent index'ten otomatik index alır** (kod gerektirmez). Partition index adlandırması mevcut şemayla uyumlu (`messages_2026_09_tenantId_idx` deseni gibi — index isimleri şema-kapsamlı olduğundan parent adı kullanılamaz).
- **Tenant fan-out:** migration gövdesi `current_schema()` üzerinde çalışır; runner (db-migrate / legacy) kaynak `messaging` + her `tenant_<16hex>` şemasına search_path pinned olarak aynı sınıfı çalıştırır (`assertSafeSchemaName` savunması gövde içinde). Aynı fan-out sözleşmesi arşivlenmiş `1782800000000` migration'ında belgeli.
- **transaction=false (kontrol edildi):** Üretim migration otoritesi **aqua-db-migrate** orchestrator'ı `transaction = false` opt-out'ını onurlandırır (`apps/db-migrate/src/migration-orchestrator.ts:513-531`, ORPHAN-CRITICAL-058). **Legacy in-process runner** (`libs/backend-common/.../migration-runner.service.ts:583-585`) her migration'ı koşulsuz tx'e sarar — bu migration oralarda net hata mesajıyla fail-fast yapar (gövde guard'ı: partition VAR + aktif tx → db-migrate ile çalıştır talimatı). **E2E/CI güvenli:** boş veritabanında partition yoktur → yalnızca `ON ONLY` stub çalışır (tx içinde yasal). Risk: dev'de legacy runner + dolu partition'lar = desteklenmez (db-migrate kullan).
- **down():** partition'lı parent üzerinde plain `DROP INDEX IF EXISTS` (cascade partition index'lere) + attach edilmemiş yetimler için partition-başı DROP IF EXISTS — CONCURRENTLY'siz, **bakım penceresi kabulü** (kod yorumunda gerekçeli; index kümesi küçük).
- **Build süresi notu:** canlıda kaynak `messaging` + tek tenant şeması, 7'şer aylık partition, partition başına ~64-112 kB / tek haneli satır → her CONCURRENTLY build sub-second. Ölçek uyarısı: partition başına büyüklükle lineer; ileride büyük tenant'larda build süresi gözlemlenmeli.
- **Kanıt:** `npx ts-node tools/gates/migration-sql-lint.ts --mode=file ...1802300000000...ts` → "Migration SQL lint passed". Build ✔. migration-registration/glob/no-savepoint/tenant-aware-migration-ddl-guard invariantları ✔ (invariant paketi 233/235 — 2 başarısızlık ön-koşul, bkz. §3).

### Görev 2 — Push fan-out: batch + kanal-bazlı COUNT + cap

**Dosyalar:** `notification/messaging-push.service.ts`, `message/services/message.service.ts`, `message/unread-message.predicate.ts` (+ spec'ler).

- **Kanal-bazlı COUNT / badge semantiği:** notification-service `templateVariables.badge` → `dispatchCommandNotification(...badge)` → push sağlayıcısının **global app-icon badge sayısı**. Eski kod her üye için GLOBAL `getUnreadCount` (messages⋈channel_members COUNT) çalıştırıyordu. Yeni `MessageService.getUnreadCountsForUsers(tenantId, userIds)` **chunk başına TEK sorguda** aynı global değeri üretir: kanal listesi (cm join) + kanalik SKIP — düz `getUnreadCountFromDb`'nin join-count'unun `:userId` → `cm."userId"` kolon referansına çevrilmiş hali. **SSoT korunarak:** `unreadMessagePredicateSql` helper'ı `userIdSql` (kolon ifadesi) şekliyle genişletildi (exactly-one-of userIdParam/userIdSql doğrulaması) — ORPHAN-100 invariant'ı yeni şekli pinlemek için güncellendi (`tests/invariants/messaging-unread-count-ssot.spec.ts`).
- **Sınırlı paralellik:** üye döngüsü kalktı → `PUSH_CONCURRENCY = 10` chunk'lı `Promise.allSettled` (parça başına 1 batch badge sorgusu; alıcı hatası yalnız o alıcıya izole, dedup/ref rollback davranışı korundu; dispatchedCount yalnız gerçek dispatch sayar).
- **notification-service batch API EKLENMEDİ (bilinçli, kapsam dışı):** `NOTIFICATION_COMMAND_SUBJECTS.SEND_PUSH` tekil recipient sözleşmesi; batch subject yok. Yapılabilecek tek şey çağrıları paralelleştirmek — yapıldı. Batch API cross-service kontrat değişikliği → ayrı sprint (kod + migration-sql-lint + spec'lerde not düşüldü).
- **Kanıt:** `messaging-push.service.spec.ts` +2 test (batch badge tek çağrı; 14 alıcı → 2 chunk × 10/4, badge=5 hepsinde) — 351 passed.

### Görev 3 — Ghost presence + tenant broadcast (gateway-api; deploy gereksinimi yukarıda)

**Dosya:** `gateway-api/src/websocket/messaging.gateway.ts`.

- **Kullanıcı-bazlı bağlantı sayacı:** `msg:{tenant}:presence:conns:{userId}` — connect'te `INCR` (+`EXPIRE 300`); yalnız **0→1 geçişi** presence'i online yapar. Disconnect'te `DECR`; yalnız **≤0'a düşüş** `DEL` + `clearPresence` (negatif drift'e karşı DEL). Heartbeat (30sn) presence TTL'ini VE sayaç TTL guard'ını tazeler. Sayaç Redis'te → çok pod'lu gateway'de doğru; pod crash'inde en fazla 5dk sayaç sızıntısı.
- **N×N broadcast kaldırıldı (kod + odası):** `server.to('tenant:{id}').emit('presence', ...)` hem connect hem disconnect'ten silindi; `tenant:{tenantId}` oda join'i de kaldırıldı (tek tüketicisi o broadcast'ti). **Gerekçe (kodda da yorumlu):** `presence` socket event'ini dinleyen istemci YOK (web panel abone değil; repo genelinde `.on('presence')` yok) — presence zaten GraphQL hattından okunuyor (messaging-service `userPresence` sorgusu / PresenceService). Her connect/disconnect'te tenant'taki her socket'e N×N fan-out, sıfır okuyucuya gidiyordu. Yerine gerekiyense opt-in oda bazlı abonelik tasarlanmalı (asla tenant-geneli).
- **Canlı bulgu (FAZ 4 için — kod değiştirilmedi, düşük riskli tek başına anlamsız):** presence hattı bugün **uçtan uca ölü**: (a) `REDIS_SERVICE` token'ı hiçbir modül sağlamıyor (`@Optional()` → üretimde `undefined` → sayaç/presence yazıları inert — sayaç kodu doğru ama client bağlanana kadar pasif); (b) gateway RedisService'i `gateway:` key prefix'li; (c) gateway `REDIS_DB 0`, messaging `REDIS_DB 3` → prefix'siz client bile olsa keyspaceler ayrı; (d) messaging tarafında `PresenceService.setOnline` çağıran hiçbir yazıcı yok → db3'te presence key'i üreten yok. Bunların hepsi DEPLOY-FAZ3'e teşhis notu olarak yazıldı; çözüm (providers + prefix/db kararı) altyapı kararı gerektiriyor.
- **Kanıt:** gateway-api:test **1019 passed** (hydration spec'i dahil), build ✔, lint ✔.

### Görev 4 — B-3 head-of-line + JetStream değerlendirmesi

**Dosya:** `gateway-api/src/websocket/messaging-nats-bridge.service.ts`.

- **Bounded-concurrency dispatch:** `for await` döngüsü içinde `await handleEvent` (seri — tek yavaş `broadcastHydratedMessage` NATS hydration'ı 5sn timeout'a kadar tüm subject kuyruğunu tıkıyordu) → semafor (slot FIFO waiter kuyruğu, `MAX_EVENT_CONCURRENCY = 20`) + `void processEventBounded(...)`; slot her durumda `finally` ile serbest. Geçersiz event düşürme ve loop try/catch koruması korundu.
- **JetStream durable'a geçiş — SADECE DEĞERLENDİRME (ayrı sprint, riskli):**
  - **Durum:** köprü core NATS queue-group (`gateway-messaging`) ile tüketiyor → mesaj kaybı köprü yeniden başlatında mümkün (MSG-HIGH-063 sync-hint bu yüzden var). JetStream durable consumer (stream `AQUACULTURE_EVENTS` mevcut, NatsEventBus altyapısı hazır) teslim+ack garantisi verirdi.
  - **Ancak canlıda (Görev 7 bulgusu): JetStream consumer'ların ACK'leri sunucu ACL'i tarafından REDDEDİLİYOR** (`$JS.ACK.>` publish izni yok; auth 11.560+ violation/24s). Durable'a geçiş ACL düzelmeden yapılamaz — ack'lenemeyen durable = sonsuz redelivery = bugünden kötü.
  - **Ek riskler:** exactly-once değil (en az bir kez) → köprü tarafında idempotent broadcast gerekliliği; queue-group semantiğinin durable consumer karşılığı (her gateway pod'u ayrı durable + filter subject) tasarım ister; rollout sırasında core-sub + consumer çift teslim penceresi.
  - **Öneri:** 1) ACL düzelt (bkz. Görev 7 raporu), 2) ack-redelivery davranışını gözlemle, 3) ayrı sprint'te durable geçişini (deliver policy `last` per pod, explicit-ack, nak ölçümü) tasarlayıp taşı.

### Görev 5 — 3.5: okuma yolları + ölü yazma + userPresence

- **Ölü Redis yazısı silindi:** `mark-read.handler.ts` içindeki `safeRedisRecalculateUnread` + `unread:{tenantId}:{userId}:{channelId}` SET'i kaldırıldı (okuyucu yok — okuma-yolları unread DB-otoriter, MSG-HIGH-066; yazı her okuma fişinden sonra 1 fazladan SELECT + 1 SET'ti ve gerçek sayıdan sapardı). Handler'ın Redis/REDIS_CLIENT enjeksiyonu da kaldırıldı. Testi olan dosya yoktu (çağıran yok doğrulandı).
- **userPresence validasyon:** `message.resolver.ts` — `userIds` ≤50 (@ArrayMaxSize karşılığı) + her eleman UUID (GraphQL `ID` scalar sadece string'e coerce eder; bare @Args'a class-validator pipe'ı ulaşamaz → açık kontrol + BadRequestException). Boş dizi → `[]`.
- **Mention taraması tx dışına:** `send-message.handler.ts` — üye userId listesi artık yazma tx'i İÇİNDE değil; `runInTenantRead` (READ-ONLY tenant sınırı) ile **tx öncesinde** çekiliyor, 30sn TTL'li in-process cache (`memberUserIdsCache`, 1000 entry üstünde basit reset). Tx artık sıfır üyelik taraması içeriyor; `parseMentions` saf CPU. **Invalidation bilinçli olarak yok — TTL yeterli:** 30sn pencerede yeni üye mention'lanamaz / ayrılan üye metadata'da anılabilir; teslimata etkisi yok (push filtresi canlı üyeliği yeniden okur). Yorumlarda gerekçeli.
- **runInTenantRead yaygınlaştırma (sıcak 3 handler, desen korunarak):** `get-messages.handler.ts`, `get-channels.handler.ts`, `search-messages.handler.ts` → `runInTenantRead` (aynı fail-closed search_path pin + RLS GUC assert; READ ONLY → yazma tx'leriyle çekişme yok, yanlışlıkla yazı yapısal olarak fail). Diğer `runInTenantTransaction` kullanan okuma call-site'larına dokunulmadı (desen kırılmasın diye — küçük/sıcak olmayanlar).
- **Kanıt:** tenant-isolation.spec ✔ (mock QueryRunner READ ONLY path'i destekliyor), 351 passed.

### Görev 6 — RLS batch-job'ları

- `embedding.service.ts`: **dosya zaten silinmiş** (FAZ 2.1'de) → atlandı (talimat gereği sadece varlık kontrolü yapıldı).
- `knowledge-extraction.service.ts` (cron kapalı, kod doğru olsun): şema listelemesi `listActiveTenantSchemaIdentities` (db-migrate commit ledger'ı → kanonik tenant UUID) ile değiştirildi; her tenant tx'inde `pinTenantSchemaTransactionSearchPath` sonrası **`bindTenantRlsContext(queryRunner, tenantId, 'messaging')`** (app.current_tenant set + read-back assert, app.bypass_rls off) eklendi. Tank registry NATS çağrısı artık satırdan değil ledger kimliğinden alınıyor (ORPHAN-MEDIUM-336payload assertion'ı değişmedi). Spec mock'u ledger satır şekline güncellendi → ✔.

### Görev 7 — NATS alt-bağlantı teşhisi (canlı, salt-okunur) — KÖK NEDEN BULUNDU

**Semptom:** "NATS connection error" 30sn döngüsü (messaging) / 10sn döngüsü (farm, alert); auth 194, notification 27 adet/24s.

**Teşhis (docker logs + nats connz/jsz + sunucu logları):**

1. **Timeline eşleşmesi (birebir, ms hassasiyetinde):** messaging-service client log `10:41:45.029Z "NATS connection error" (NatsEventBus)` ↔ NATS sunucu log `10:41:45.029125 [ERR] Publish Violation - User "CN=messaging_service", Subject "$JS.ACK.AQUACULTURE_EVENTS.aquaculture-messaging-service-events---MessageSent.1.449.25..."`. Aynısı 10:37:15 için de doğrulandı.
2. **Hangi bağlantı:** **JetStream durable consumer** — hata veren bağlantı `clientId: aquaculture-messaging-service` (connz'da `172.20.0.21` / sunucu cid:462), `AQUACULTURE_EVENTS` stream'i üzerinde `aquaculture-messaging-service-events---MessageSent` durable consumer'ı. **Core sub değil** (gateway köprüsü `gateway-api-messaging-bridge` sağlıklı, 8 core sub, hata yok), **req-reply değil** (`_INBOX` mux bağlantısı aktif ve sessiz).
3. **Kök neden:** `infrastructure/docker/nats/nats.conf` yetkilendirmesinde `CN=messaging_service` (ve diğerleri) publish allow-list'i `$JS.API.>` içeriyor ama **`$JS.ACK.>` YOK**. Pull consumer'ın her `ack()`'ı `$JS.ACK.<stream>.<consumer deliver-subject>`'ine PUBLISH'tir → sunucu reddediyor → istemci tarafı permission error status event'i → "NATS connection error" log satırı.
4. **Kapsam (24slik sayılar, sunucu logu):** `auth_service` 13.695 (3 consumer: AccessTokenInvalidationRequested ×2, UserAccessTokenInvalidationRequested), `farm_service` 1.164 (SensorReading), `alert_engine` 1.164 (SensorReading), `notification_service` 27 (MessageSent), `messaging_service` 27 (MessageSent). İhlal devam ediyor (sürekli).
5. **Sonuç (operasyonel etki):** ACK'ler hiç geçmiyor → durable consumer'lar offset ilerletemiyor → **mesajlar ack-timeout'ta sonsuz redelivery** (en-az-bir-kesin değil, "her timeout'ta bir kez daha"); EVENT_BUS sağlık göstergesi degrader (status=2 sınıfı). messaging push tarafındaki 30sn dedup penceresi redelivery çakışmalarının çoğunu yutuyor ama pencere aşan redelivery'de çift push riski gerçek.
6. **KOORDİNATÖR GÜNCELLEMESİ (2026-09-17, V1 A7):** Kod düzeltmesi worktree'ye İŞLENDİ
   (infrastructure/docker/nats/nats.conf — 29 publish listesine `$JS.ACK.>`; canlı bind
   local-runtime kopyasına da uygulandı + nats-server reload + tüketici servis restart).
   CANLI KANIT: Publish Violation 0/2dk (önce ~13.7k/24sn auth), "NATS connection error" 0,
   consumer ack_floor ilerliyor (delivered=32=ack_floor, pending=0). Checkout-survival:
   apply-messaging-monitoring-overlay.sh 2b adımı (mount'u bulur, yamar, reload, restart).

**Kod düzeltmesi yapılmadı — gerekçe:** kök neden %100 net fakat düzeltme **altyapı konfigürasyonu** (`nats.conf` ACL'ine `$JS.ACK.>` publish izni eklenmesi + NATS reload/restart) — tüm servisleri etkileyen, bu worktree'den deploy edilemeyen, koordinasyon ister bir değişiklik. Düşük riskli kod düzeltmesi kapsamı değil. 7. **Önerilen iyileştirme (ayrı altyapı değişikliği):** JetStream consumer çalıştıran her servis kullanıcısına (auth_service, messaging_service, notification_service, farm_service, alert_engine — ya da tekdüze olarak tüm servis kullanıcılarına) publish allow-list'e `"$JS.ACK.>"` ekleyin; NATS'ı reload edin; doğrulama: `docker logs aqua-nats --since 5m | grep -c "Publish Violation"` → 0 ve servis loglarında "NATS connection error" durur. (Live bind: `/var/lib/aqua/local-runtime/.../infrastructure/docker/nats/nats.conf` — repo kopyasıyla birebir aynı doğrulandı.)

**Ek canlı gözlem:** örneklem penceresinde stream'e YENİ MessageSent publish'i görünmüyor (köprünün in/out byte sayaçları sabit; JS sequence'ları eski redelivery'ler) — outbox akışının canlıda hareketi ayrıca gözlemlenmeli (Görev 7 kapsamını aşar, not düşüldü).

---

## 2. Doğrulama (hepsi bu worktree'de koşuldu)

| Kapı                                                              | Sonuç                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run messaging-service:test --skip-nx-cache`               | **351 passed, 1 skipped** (skip ön-koşul) / 352                                                                                                                                                                                                               |
| `npx nx run gateway-api:test --skip-nx-cache`                     | **1019 passed** / 1019                                                                                                                                                                                                                                        |
| `npx nx run messaging-service:build --skip-nx-cache`              | BUILD OK                                                                                                                                                                                                                                                      |
| `npx nx run gateway-api:build --skip-nx-cache`                    | BUILD OK                                                                                                                                                                                                                                                      |
| `npx nx run {messaging-service,gateway-api}:lint --skip-nx-cache` | ✔ / ✔                                                                                                                                                                                                                                                       |
| `prettier --check` (dokunulan 18 dosya)                           | ✔ (write sonrası re-check)                                                                                                                                                                                                                                   |
| `tools/gates/banned-construct.ts`                                 | "No banned constructs detected."                                                                                                                                                                                                                              |
| `tools/gates/banned-phrase.ts` (working tree staged modu)         | "No banned phrases detected."                                                                                                                                                                                                                                 |
| `tools/gates/migration-sql-lint.ts --mode=file 1802300000000-...` | "Migration SQL lint passed"                                                                                                                                                                                                                                   |
| `tests/invariants` (jest, 235 paket)                              | **233 passed; 2 failed — ikisi de ÖN-KOŞUL** (`backup-ssh-broker-contract`: ortamda rustc yok; `enterprise-grade-debt-plan-contract`: aria-debts registry hash uyuşmazlığı — ikisi de temiz HEAD'de `git stash` ile aynen reproduke edildi, bu fazla ilgisiz) |

**Test delta:** messaging 346→351 (+5 net yeni: push batch ×2, predicate userIdSql/reddetme ×2... spec'lerdeki yeniler; knowledge-extraction spec'i ledger mock'una taşındı). ORPHAN-100 unread-SSoT invariant'ı yeni dual-shape helper'ı pinliyor.

## 3. Deploy adımları (özet)

```bash
# 1) Üç imajı aynı ağaç + aynı tag ile build et (db-migrate migration'ları bu ağaçtan okur)
for SVC in db-migrate messaging-service gateway-api; do
  docker build -t aqua-$SVC:msgfix-faz3 <repo-root> -f <mevcut Dockerfile deseni>
done
# 2) Sırayla:
docker compose up -d --no-deps aqua-db-migrate aqua-messaging aqua-gateway
```

- **db-migrate log'unda** `AddMessagesContentSearchGinIndex1802300000000` "Migration applied" (kaynak `messaging` + her `tenant_*` şeması için) görünmeli.
- **Doğrulama SQL (salt-okunur):**
  ```sql
  SELECT n.nspname, idx.relname, i.indisvalid
  FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=idx.relnamespace
  WHERE idx.relname='idx_messages_content_fts';
  -- her şema için 1 satır, indisvalid = true
  ```
- **EXPLAIN kontrol (index kullanımı):** tenant şemasında `EXPLAIN SELECT ... FROM messages m WHERE to_tsvector('english', m."content") @@ plainto_tsquery('english','...')` → Bitmap Index Scan `..._content_fts_idx`.
- **Gateway sonrası:** iki tarayıcı sekmesi (aynı kullanıcı) aç/kapat — `userPresence` sorgusu kullanıcıyı hâlâ online göstermeli (sayaç client sağlanana kadar mevcut inert-durum devam eder; broadcast fırtınası kesin kesilir).

## 4. Bilinçli olarak yapılmayanlar / ertelenenler

1. **notification-service batch push API** — kapsam dışı (kontrat değişikliği), kodda + bu raporda notlandı.
2. **JetStream durable geçişi (köprü)** — değerlendirme notu (Görev 4); ACL düzeltmesi öncelikli ön koşul.
3. **NATS ACL düzeltmesi** — altyapı değişikliği; tam talimat Görev 7/§6-7'de.
4. **Presence hattının canlandırılması** (REDIS_SERVICE provider + prefix/REDIS_DB kararı + messaging'e setOnline yazıcı) — üçlü kopukluk teşhisi Görev 3'te; FAZ 4 altyapı kararı.
5. **retention-policy.service.ts** — talimat gereği dokunulmadı (FAZ 4'te yeniden yazılacak).
6. **Legacy in-process migration runner'ın transaction=false onurlandırması** — backend-common geneli etkiler; migration gövdesi net hata mesajıyla fail-fast yapıyor, üretim db-migrate'te. Gerekirse ayrı backend-common PR'ı (db-migrate'teki ORPHAN-CRITICAL-058 deseninin aynısı).
