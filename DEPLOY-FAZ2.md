# MSGFIX — FAZ 2 Backend Raporu (Ajan-A — AI sohbetinin canlandırılması)

Tarih: 2026-09-16/17 · Worktree: `/var/aqua-messaging-fix` (dal `messaging-fix-1`, taban FAZ 1: `5127ceefce`) · **Commit ATILMADI** (koordinatör yapacak) · **Deploy YAPILMADI, env SET EDİLMEDİ — kill-switch (`MESSAGING_AI_TRIGGER_ENABLED`) KAPALI.**

---

## 0. Özet

| Faz | Görev | Sonuç |
|---|---|---|
| 2.0 | `MessageSentEvent.isAiResponse?` kontratı | Interface + JSON Schema (additionalProperties:false korundu) + 7 spec testi. Additive — eski yayıncılar/tüketiciler etkilenmez. |
| 2.1 | Ölü AI kod temizliği | sentiment yazarı + embedding cron + ExtractKnowledge komutu + EmbeddingsMetadata entity + 3 ölü egress purpose + köprüdeki ölü prompt-hardening ferry + kullanımsız 2 safety servisi SİLİNDİ. |
| 2.1b | `messages.embedding` tenant fan-out migration'ı | `1802200000000` — tüm `tenant_<16hex>` şemalarına nullable kolon + HNSW index (idempotent, `down()` yazıldı). |
| 2.2 | AI tetikleyici consumer | `AiTriggerNatsHandler`: kill-switch'e bağlı durable `MessageSent` aboneliği; çift savunma self-trigger guard, messageId SETNX idempotency (24h), kanal in-flight kilidi (60s), kanal başına günlük tavan (default 50, günde 1 uyarı). |
| 2.3 | Köprü sertleştirme | TÜM DB erişimleri tenant-pin'li (`runInTenantRead/Transaction`); **rol çözümleyici auth-service'ten NATS ile** (`request.auth.user.resolveCallerCapabilities`, 60s Redis cache, fail-closed) + `ai_assistant:use` köprüde; consent-filtreli + karakter bütçeli context (tetik mesajı hariç); hata yolu artık AI yanıtı yazmıyor (tek throttle'lı SYSTEM notice); AI yanıtı send-idempotency ledger'ında **tam-bir-kez** claim ediliyor. |
| 2.3b | Push filtresi + SYSTEM guard | AI mesajları offline push atmıyor (isAiResponse ∨ AI_USER_ID); kullanıcı `contentType=SYSTEM` gönderemez (BAD_REQUEST). |
| 2.3c | ai-service context | `request.ai.chat` responder'ı `contextMessages`'ı `priorMessages`'a çeviriyor (rızalı kullanıcı → user, AI turları → assistant; 30 mesaj / 8k char cap); agent-runner alternasyon-güvenli ekliyor. |

**ROL ÇÖZÜCÜ MEKANİZMASI (özet — detay §3): auth-service'e YENİ minimal responder eklendi: `request.auth.user.resolveCallerCapabilities`. DEPLOY SIRASI ZORUNLU: auth-service → ai-service → messaging-service.**

Test: messaging **330 → 346 passed** (+16, 0 regresyon), ai-service **147 → 152** (+5), auth-service **675 → 679** (+4), event-contracts **+7 (357→364)**, backend-common 1374 ✔ (dokunulmadı), event-bus 55 ✔ (dokunulmadı). Build ✔ (messaging, ai-service, auth-service, gateway-api, notification-service), eslint ✔, prettier ✔, banned-construct ✔, migration-sql-lint ✔.

---

## 1. FAZ 2.0 — Kontrat (ÖN ŞART)

**`libs/event-contracts/src/messaging-events.ts`** — `MessageSentEvent`'e opsiyonel `isAiResponse?: boolean` (docblock: yalnız pozitif sinyal, varlık-kapısı değil).
**`libs/event-contracts/src/schemas/messaging-events.schema.ts:73-88`** — `MessageSent` JSON Schema'ya `isAiResponse: { type: 'boolean', nullable: true }`; **required setine EKLENMEDİ** → eski yayıncılar (insan mesajları) geçerli kalır; `additionalProperties:false` aynen duruyor → köprünün AI `MessageSent`'i artık gateway `validateMessagingEvent`'te DÜŞÜRÜLMÜYOR (eski kök neden: alan sözselleşmemişti → gateway WS broadcast'i hiç gelmiyordu).
**`libs/event-contracts/src/schemas/__tests__/messaging-events.schema.spec.ts`** (YENİ, 7 test) — bayrak yok/true/false geçerli; `'yes'` tip hatası reddi; bilinmeyen ek alan + eksik zorunlu alan reddi (gevşetme açılmadı).

---

## 2. FAZ 2.1 — Temizlik (2.2'den ÖNCE)

`analyze-message.handler.ts` sentiment'i ÖNCE çağırıyordu; responder olmadığından her mesaja +30sn NATS timeout'u bindiriyordu. Silinenler:

| Dosya | Gerekçe / kanıt |
|---|---|
| `ai/services/sentiment-analysis.service.ts` (+spec) | Yazıcı öldü; `request.ai.analyzeSentiment` çağrısı yok (FAZ 0 doğrulaması). `SentimentAlert` outbox yayını da bu dosyadaydı. `sentimentTrends` GraphQL okuma sorgusu (NATS çağrısız, tarihsel `message_analysis` agregasyonu) KALDI — frontend sözleşmesi kırılmasın. |
| `ai/services/embedding.service.ts` (+spec) | 5 dk'lık cron'un tamamı; `MESSAGING_AI_EMBEDDING_CRON_ENABLED_ENV` artık inaktif (docblock notu). Kolon KALDI (bkz. 2.1b) — GDPR `embedding=NULL` süpürmeleri + `similarMessages` araması kolonu okuyor. |
| `ai/entities/embeddings-metadata.entity.ts` | Hiçbir şey yazmıyordu (model registry). Entity kaydı `ai.module.ts` + `app.module.ts`'ten kaldırıldı; **tablo DB'de duruyor** (DDL db-migrate'in — düşürme migration'ı bilinçli olarak yazılmadı). |
| `ai/commands/extract-knowledge.{command,handler}.ts` | Dispatch eden yok (grep: yalnız kendi dosyaları). `KnowledgeExtractionService` + cron KAPALI KALDI (bilinçli karar — docblock'a not: `gdpr.service.ts` §6 `knowledge_entries`'i `sourceMessageId` ile siliyor; tablo+yazıcı eş kalmalı; yeniden açmak saf env flip). |
| `ai/services/ai-egress-gate.service.ts` | `AiEgressPurpose`'tan `'sentiment' | 'custom-ai-chat' | 'ai-action'` silindi (grep: kullanım yok). Kalanlar: `semantic-search | ai-chat | knowledge-extraction | embedding`. |
| `ai/safety/instruction-hierarchy.service.ts`, `ai/safety/tool-schema-validator.service.ts` | Tek tüketicisi köprünün ölü prompt-ferry bloğuydu (aşağıda). ai-service'in kendi `AiSafetyMiddleware` zinciri CANLI ve dokunulmadı. |

`MessageSentPayload` duplicate'i: sentiment dosyasındaki kopya silindi; `messaging-push.service.ts`'teki tek tanım kaldı ( Kontrol: başka ithalatçı yok).

---

## 3. FAZ 2.3 — ROL ÇÖZÜCÜ (MEKANİZMA — DİKKAT)

**Mevcut uygun subject YOKTU.** Auth-service NATS yüzeyi tarandı: `request.auth.verifyPassword`, `request.auth.admin.*`, `request.auth.user.validateTenantMembership`, `request.auth.user.listTenantUserIds` — hiçbiri rol/resourcePermissions döndürmüyor (hepsi no-PII üyelik yüzeyi). **Bu yüzden auth-service'e minimal YENİ responder eklendi** (profil/PII taşımaz — yalnız rol kodları + `resource:action` yetki kodları; sonuç AJV şemasıyla `additionalProperties:false`'a kilitli):

- **Subject:** `request.auth.user.resolveCallerCapabilities`
- **Kontrat:** `libs/event-contracts/src/auth-user-queries.ts` (Query/Result interface'leri) + `schemas/auth-user-queries.schema.ts` (her iki taraf için derlenmiş AJV şemaları).
- **auth-service tarafı:** `apps/auth-service/src/modules/authentication/controllers/auth-caller-capabilities-nats.handler.ts` (YENİ; `AuthenticationModule` controllers'a kayıtlı) + `TokenService.resolveCallerCapabilities(tenantId, userId)` (YENİ public metot — **aynı özel okuma yolunu yeniden kullanır**: `auth.user_role_assignments → tenant_role_permissions → per-user overrides ∩ lisanslı yetenekler`; SUPER_ADMIN/TENANT_ADMIN → `[]` — JWT ile birebir eş). Tenant-scoped: başka tenant'ın kullanıcısı `found:false` (varolmayandan ayırt edilemez — cross-tenant probe yok). Salt-okunur; auth-service'in kalanına sıfır davranış değişikliği.
- **messaging tarafı:** `apps/messaging-service/src/ai/services/ai-caller-capabilities.service.ts` (YENİ) — NATS request-reply (5sn timeout) + **60s Redis cache** (`ai:caller-caps:{tenantId}:{userId}`; ret ve fault da cache'lenir → bozuk responder mesaj-başı NATS fırtınası olamaz). **Fail-closed:** çözülemezse `null` → köprü AI turunu başlatmaz (asla `MODULE_USER` tahmin edilmiyor — eski `(channel as {senderRoles?}).senderRoles ?? ['MODULE_USER']` kırığının tam tersi).
- **Köprüdeki yetki kontrolü:** `hasResourcePermission(caps, 'ai_assistant:use')` (backend-common SSoT — SUPER/TENANT_ADMIN bypass'ı dahil); roller + `resourcePermissions` `request.ai.chat`'e iletiliyor → ai-service `AgentProfileService` persona tier'ı (`ai_personas:<tier>`) DOĞRU yetki setiyle denetliyor → `PersonaNotPermittedError`/"AI is temporarily unavailable" döngüsü kapanıyor.

> **DEPLOY SIRASI (ZORUNLU): 1) auth-service → 2) ai-service → 3) messaging-service (+ db-migrate imajı — §8).** Ters sırada (messaging önce) köprünün rol çözümü fail-closed davranır: AI turları tek throttle'lı "currently unavailable" notice'i ile reddedilir, mesaj kaybolmaz.

---

## 4. FAZ 2.2 — Tetikleyici (`apps/messaging-service/src/ai/ai-trigger-nats.handler.ts`, YENİ)

`subscribeWildcard('MessageSent')` durable consumer (MessagingPushNatsHandler deseni; kendi service-isimli durable/queue grubu — gateway'inki değil). Kapı sırası (en ucuzdan):

0. **Kill-switch:** `AiTriggerConfig.triggerEnabled` KAPALIyken **abonelik hiç kurulmaz** (durable consumer oluşmaz, mesaj tüketilmez; tek DEBUG satırı). AÇIKken `DeliverPolicy.New` — geçmiş mesajlar tetiklenmez.
1. **Self-trigger guard (çift savunma):** `event.isAiResponse === true` **VEYA** `senderId === AI_USER_ID` → çık (AI kendi yanıtını tetikleyemez; 2.0 bayrağı + kimlik).
2. **Güven sınırı:** tenantId/channelId/messageId UUID regex (SEC-M17 deseni) — reddedilen payload Redis/SQL'e ulaşmaz.
3. **Idempotency:** Redis `SETNX msg:ai-trigger:{tenantId}:{messageId}` TTL 24h. JetStream at-least-once + 30sn ack_wait altında 60sn'lik AI turları redelivery üretebilir — SETNX yeniden girişi yapısal olarak keser. **Kalıcı DB işaretine gerek yok** (gerekçe kodda): claim yalnız redelivery penceresini atlatmalı; trigger best-effort'tır (kayıp = 1 AI yanıtı, asla kullanıcı mesajı değil). Redis hatası → atla (AI için fail-closed; retry fırtınası yok).
4. **Tenant-pin'li okuma** (`runInTenantRead` + explicit `tenantId` predicate — FAZ 1 dersi): kanal `type !== AI → çık`; mesaj içeriği çekilir (boş/silinmiş → çık).
5. **Günlük tavan:** `INCR msg:ai-daily:{tenantId}:{channelId}:{yyyyMMdd}` TTL 25h; `MESSAGING_AI_CHANNEL_DAILY_LIMIT` (default 50, clamp [1,10000]) aşılırsa **tek** sistem mesajı (`AI_DAILY_LIMIT`, günde 1 — ledger anahtarı gün-bazlı) ve dispatch yok. Sayaç HATASI ≠ limit aşımı: dispatch yok + sahte "limit doldu" notice'i de yok.
6. **Kanal in-flight kilidi:** `SETNX msg:ai-inflight:{channelId}` TTL 60s (AI NATS timeout'uyla hizalı; crash filesi). Kilit alınamazsa mesaj atlanır (kanal zaten AI turu üretiyor — paralel çift yanıt/çift token harcaması yok). Tur bitince `DEL`.
7. `AnalyzeMessageCommand` dispatch (içerik + sender ile) → köprü.

## 5. FAZ 2.3 — Köprü sertleştirme (`ai-chat-bridge.service.ts`)

1. **Tenant-pin:** kanal okuma, context okuma, `confirmAiAction` okuma/yazma ve `persistAiResponse` — hepsi `runInTenantRead`/`runInTenantTransaction` + `tenantId` predicate (JetStream bağlamında middleware yok — FAZ 1 RLS kök nedeninin sınıfı).
2. **Rol/yetki:** §3. Çözülemez → `AI_AUTH_UNRESOLVED`; `ai_assistant:use` yok → `AI_NOT_PERMITTED` — ikisi de **throttle'lı SYSTEM notice** (1/saat/kanal, Redis SETNX + DB ledger), normal AI yanıtı DEĞİL (`metadata.error=true`).
3. **Hafıza:** `fetchContextMessages` son 30 mesaj, tetik mesajı **hariç** (`content` zaten turun user mesajı — çift sayım/alternasyon bozulumu yok), **per-sender consent filtresi** (`AiPrivacyService.hasUserConsented`; AI'nın kendi turları dahil — kullanıcı PII'si değil), karakter bütçesi `MESSAGING_AI_CONTEXT_CHAR_BUDGET` (default 24000; en yeniden eskiye korunur). `conversationId` **gönderilmiyor** (çok kullanıcılı kanalda ConversationService userId sahipliği + GDPR eraseForUser çatışması — bağlam köprüden gidiyor).
4. **Ölü hardening ferry silindi:** `hardenedSystemPrompt` hesabı, persona prompt lookup'u, `ToolSchemaValidatorService` (zaten enjeksiyondu-kullanılmıyordu). ai-service'in `AiSafetyMiddleware` zinciri dokunulmadan tek yetkili. `InputFilterService.scanInput` (jailbreak ön-egress taraması) ve `OutputPiiScannerService.redact` KALDI — bunlar prompt ferry değil, sınır taramaları.
5. **Hata sözleşmesi:** responder `error`/`metadata.errorCode` döndürürse (AI_KEY_MISSING, rate limit, budget, persona-denied, INTERNAL…) hata METNİ kanala AI yanıtı olarak YAZILMAZ → `persistSystemNotice` (errorCode metadata'da). NATS transport hatası → `null` → `AI_UNAVAILABLE` notice. "AI is temporarily unavailable" spam'i bitti. (`forwardViaNats` senkron throw'a da dayanıklı — testin yakaladığı gerçek boşluk.)
6. **persistAiResponse — tam-bir-kez:** send-message.handler deseniyle `message_send_idempotency` ledger'ında `INSERT … ON CONFLICT DO NOTHING` + raw RETURNING kontrolü, **aynı transaction'da** mesaj INSERT'i + outbox ile. Ledger anahtarı deterministik **UUIDv5** (`shared/ai-ledger-keys.ts` — kolon uuid-typed olduğu için; `ai-reply:{triggerId}` / `ai-action-result:{id}` / `ai-notice:…` → sabit UUID). Redelivery/restart/Redis-çöküşü altında çift AI yanıtı yapısal olarak imkânsız. Outbox olayı `isAiResponse:true` (2.0) + mesaj `isAiGenerated:true` + `metadata.isAi`.
7. **confirmAiAction:** okumalar tek tenant-pin'li tx'te birleşir; üyelik kontrolü korundu; sonuç mesajı `ai-action-result:{actionMessageId}` ledger anahtarıyla tam-bir-kez.

## 6. FAZ 2.3b/2.3c

- **`messaging-push.service.ts`** — `handleMessageSent` girişinde `payload.isAiResponse === true || senderId === AI_USER_ID` → push yok (offline üyeler AI yanıtı için bildirim almaz; kanal açınca görür). `AI_USER_ID` tek SSoT sabiti: `shared/ai-user.ts` (YENİ).
- **SYSTEM guard** — `send-message.handler.ts`: `contentType === SYSTEM → BadRequestException` (SendMessageCommand yalnız kullanıcı yoludur; AI doğrudan yazar → guard tam kapsayıcı; GraphQL + mobil offline-replay dahil tek yazı-tarafı uygulama noktası).
- **ai-service** — `ai-chat.responder.ts`: `contextMessages → priorMessages` (isAi→assistant, değilse user; 30 mesaj / 8000 char savunma cap'i; bozuk girişler atılır; `conversationId` varsa yok sayılır — asistan yüzeyi değişmedi). `agent-runner.service.ts`: `ChatRequest.priorMessages` (YENİ, opsiyonel; yalnız stored conversation yokken kullanılır) + `pushAlternating` helper'ı (üst üste aynı rolü boşluklu-birleştirir — çok kullanıcı/ardışık AI turları alternasyonu bozmaz; Anthropic rol-alternasyon sözleşmesi korunur). **Hardened prompt zincirine, kotaya, BYOK'a, actuation politikasına DOKUNULMADI** — köprü yolu `request.ai.chat`'ten geçtiği için 60 istek/saat/tenant + token bütçesi otomatik uygulanmaya devam eder.

## 7. FAZ 2.1b — Migration

`apps/messaging-service/src/migrations/1802200000000-EnsureMessagesEmbeddingColumnTenantFanout.ts` (YENİ; `app.module.ts` migrations[]'a kayıtlı):
- `up()`: önce `pinSearchPath('messaging')` + kaynak şema; sonra `information_schema` (`^tenant_[a-f0-9]{16}$` — `listTenantSchemas` deseni) üzerinden her tenant şeması için `assertSafeSchemaName` sonrası nitelikli DDL: `ADD COLUMN IF NOT EXISTS embedding vector(384)` (NULLABLE) + `CREATE INDEX IF NOT EXISTS idx_messages_embedding … USING hnsw`. Kolon varsa index yine garanti edilir. İdempotent.
- `down()`: her şemada `DROP INDEX IF EXISTS` + `DROP COLUMN IF EXISTS`.
- **NOT `@SourceOnlyMigration`** (fan-out amacın kendisi). Etki: `similarMessages` live tenantlarda 500 vermez (kolon artık tenant şemalarında); GDPR `embedding=NULL` UPDATE'leri eski tenantlarda da çalışır.

## 8. Doğrulama çıktıları

| Kapı | Sonuç |
|---|---|
| `npx nx run messaging-service:test --skip-nx-cache` | `48 passed +1 skipped / 49; 346 passed +1 skipped / 347` (baseline FAZ 1: 330 → **+16**) |
| `npx nx run ai-service:test` | `29 / 152` (+5: responder context spec — YENİ) |
| `npx nx run auth-service:test` | `61 / 679` (+4: responder spec — YENİ) |
| `npx nx run event-contracts:test` | `19 / 364` (+7: MessageSent isAiResponse şema spec'i — YENİ) |
| `npx nx run backend-common:test` | `124 / 1374` (dokunulmadı, regresyon kontrolü) |
| `npx nx run event-bus:test` | `6 / 55` (dokunulmadı) |
| build: messaging / ai-service / auth-service / gateway-api / notification-service | hepsi `BUILD OK` |
| eslint (tüm değişen dosyalar) | temiz |
| prettier (tüm değişen dosyalar) | temiz |
| `banned-construct.ts --mode=file` | "No banned constructs detected." |
| `migration-sql-lint.ts --mode=file 18022…` | "Migration SQL lint passed" |
| `quality.mjs format check-changed` | `format-scope.json` yeniden üretildi (kapı talimatı, +84 satır — FAZ 1'dekiyle aynı durum). Listede kalan drift dosyaları (`DEPLOY-FAZ1.md`, `web/modules/messaging-module/…`) **FAZ 0/1 commit'lerinin/benim olmayan** dosyaları — bilinçli olarak dokunulmadı. |

Yeni spec'ler: `ai-trigger-nats.handler.spec.ts` (14), `ai-caller-capabilities.service.spec.ts` (10), `ai-chat-bridge.service.spec.ts` (yeniden yazıldı, 14), `messaging-events.schema.spec.ts` (7), `auth-caller-capabilities-nats.handler.spec.ts` (4), `ai-chat.responder.context.spec.ts` (5), `messaging-push.service.spec.ts` (+2), `send-message.handler.spec.ts` (+1), `ai-egress-gate.service.spec.ts` (purpose'lar güncellendi).

---

## 9. DEPLOY REÇETESİ (koordinatör için — kill-switch KAPALI deploy)

**SIRASI KRİTİK: auth-service → ai-service → messaging-service. ÜÇ imaj + db-migrate imajı AYNI TAG ile build edilmeli.** (db-migrate, `apps/messaging-service/src/migrations/[0-9]*` glob'u ile yeni 1802200000000 migration'ını doğrudan bu ağaçtan okur — `apps/db-migrate/src/schema-registry.ts:235` — dolayısıyla db-migrate imajı da yeniden build + aynı tag.)

### 9.1 İmaj build (worktree'den; FAZ 1 reçetesiyle aynı desen)

```bash
cd /var/aqua-messaging-fix
npx nx run auth-service:build
npx nx run ai-service:build
npx nx run messaging-service:build

for SVC in auth-service ai-service messaging-service db-migrate; do
  DOCKER_BUILDKIT=1 docker build \
    -f infrastructure/docker/Dockerfile.backend.simple \
    --build-arg SERVICE_NAME=$SVC \
    -t ghcr.io/okan-wqm/aquaculture_platform/$SVC:local-msg-fix-2 \
    /var/aqua-messaging-fix
done
```
(db-migrate'in Dockerfile'ı farklıysa mevcut imaj build sürecini kullanın — kritik olan **aynı ağaç + aynı tag**.)

### 9.2 Deploy (droplet checkout — DOKUNMA, sadece çalıştır; kill-switch HÂLÂ KAPALI)

```bash
cd /var/lib/aqua/deploy/checkout && \
TAG=local-msg-fix-2 docker compose -p aqua-saas -f docker-compose.droplet.yml \
  up -d --no-deps aqua-db-migrate auth-service ai-service messaging-service
```
(Servis adları compose dosyasındaki gerçek adlarla eşleştirin; rollback: `TAG=local-msg-fix-1`.)
Migration kontrolü: `docker logs aqua-db-migrate` içinde `EnsureMessagesEmbeddingColumnTenantFanout1802200000000` tamamlanmış + `messaging.migrations` ledger'ında görünüyor olmalı; `SELECT column_name FROM information_schema.columns WHERE table_name='messages' AND column_name='embedding' AND table_schema LIKE 'tenant_%';` her tenant şemasında satır döndürmeli.

### 9.3 Post-deploy doğrulama (kill-switch hâlâ KAPALIyken)

```bash
docker logs aqua-messaging 2>&1 | grep "Messaging AI trigger DISABLED"   # tek satır, anlaşılır gerekçe
docker logs aqua-auth 2>&1 | grep -i error | head                        # temiz boot
# Responder'a elçilik kontrolü (messaging'den değil, yalnız bağlantı):
curl -s "http://nats:8222/connz?subs=true" | grep -o "request.auth.user.resolveCallerCapabilities" | head -1
```
Not: kill-switch KAPALIyken AI kanal testi ANLAMSIZDIR (tetikleyici abone olmaz).

### 9.4 KILL-SWITCH AÇMA TALİMATI (koordinatör — canlı E2E sonrası)

```bash
# 1) Checkout compose env'ine ekle (messaging-service tanımına):
#    MESSAGING_AI_TRIGGER_ENABLED=true
#    (opsiyonel: MESSAGING_AI_CHANNEL_DAILY_LIMIT=50, MESSAGING_AI_CONTEXT_CHAR_BUDGET=24000)
cd /var/lib/aqua/deploy/checkout && \
TAG=local-msg-fix-2 docker compose -p aqua-saas -f docker-compose.droplet.yml \
  up -d --no-deps messaging-service        # env değişimi → recreate
# 2) Doğrulama:
docker logs aqua-messaging --since 2m 2>&1 | grep "Subscribed to durable MessageSent fan-out for AI triggering"
docker exec aqua-messaging curl -s localhost:3000/metrics | grep messaging_nats_connection_status   # 2
curl -s "http://nats:8222/jsz?consumer_detail=true" | grep -o 'events.\*.MessageSent' | sort -u     # yeni durable
# 3) Kapatma (acil): env'i kaldır/kapalı değere çevir + recreate. Durur durable consumer geride kalır (zararsız).
```
Strict parser: yalnız tam `true` açar; `1`/`yes`/typo → KAPALI (fail-closed).

### 9.5 Kabul kriterleri için test planı (kill-switch AÇIK, V3 ajanı/koordinatör)

1. **Temel akış:** AI kanalında (type=ai) yetkili + consent'li kullanıcı (`ai_assistant:use` grant'lı rol / admin) mesaj yazar → (a) ai-service yanıt döner, (b) mesaj DB'de `senderId=00000000-0000-0000-0000-000000000001`, `isAiGenerated=true`, `contentType=system`, `metadata.isAi=true`, (c) **WS üzerinden AI yanıtı panele DÜŞER** (2.0 kontratı — gateway düşürmüyor), (d) offline kullanıcıya push GİTMEZ (senderId===AI_USER_ID).
2. **Self-trigger yok:** AI yanıtı yeni AI turu tetiklemez (isAiResponse + AI_USER_ID çift savunma; kanal loglarında ikinci dispatch yok).
3. **Hafıza/consent:** consent'li iki kullanıcı + consent'siz bir kullanıcı kanalda konuşur → yanıt context'te yalnız consent'lilerin metinlerini referans alır (ai-service conversation kaydında/yanıtta consent'siz kullanıcının kelimeleri geçmemeli — davranışsal kontrol).
4. **Yetki:** `ai_assistant:use`'sız kullanıcı AI kanalında yazar → normal AI yanıtı YOK; tek SYSTEM notice (`metadata.errorCode=AI_NOT_PERMITTED`); 1 saat içinde tekrar deneme → ikinci notice yok (throttle).
5. **Hata yolu:** tenant AI anahtarı yokken (`AI_KEY_MISSING`) → kanala "No AI API key…" metni AI yanıtı olarak DEĞİL, SYSTEM notice olarak gelir (errorCode taşınır); "temporarily unavailable" spam'i yok.
6. **Günlük tavan:** kanalda 51. AI tetiği → `AI_DAILY_LIMIT` notice (günde 1) + 51. için dispatch yok (NATS loglarında `request.ai.chat` çağrılmadığı görülmeli).
7. **In-flight:** hızlı ardışık iki mesaj → ikincisi `msg:ai-inflight` kilidi nedeniyle atlanır (tek sıra yanıt; kilit 60s).
8. **Idempotency:** aynı `messageId` redelivery (JetStream ack penceresi) → tek AI yanıtı (ledger claim çakışması sessiz skip).
9. **SYSTEM sahteciliği:** kullanıcı `sendMessage(contentType: SYSTEM)` → `BAD_REQUEST` (mesaj yazılmaz).
10. **similarMessages:** live tenant'ta sorgu 500 vermez (kolon fan-out migration'ı sonrası; embeddings cron kapalı olduğundan sonuç boş olabilir — hata OLMAMALI).
11. **Kill-switch geri kapatma:** env kaldırılıp recreate → tetikleyici aboneliği kalkar, insan mesajlaşması etkilenmez (mesaj akışı/push FAZ 1 davranışında kalır).

### 9.6 Frontend sözleşmesi (FAZ 2.4 — frontend ana ağaçta OLMAZ, sadece sözleşme)

**AI mesajı tanımı:** `senderId === '00000000-0000-0000-0000-000000000001'` **VE** `isAiGenerated === true` **VE** `metadata.isAi === true` (in-band damga). `MessageSent` WS olayında `isAiResponse: true` (opsiyonel alan — yoksa insan mesajı). **Hata/durum bildirimi:** `contentType === 'system'` + `metadata.error === true` + `metadata.errorCode` (`AI_AUTH_UNRESOLVED | AI_NOT_PERMITTED | AI_UNAVAILABLE | AI_KEY_MISSING | AI_DAILY_LIMIT | AI_ERROR` …) — bunlar asistan yanıtı DEĞİL, sistem bildirimi olarak render edilmeli (ör. gri sistem satırı). AI mesajları push almaz (istemci tarafı ek işlem gerektirmez).

---

## 10. Bilinen sınırlar / bilinçli kararlar

1. **conversation birikimi:** köprü conversationId göndermediğinden ai-service her AI-kanal turu için yeni conversation satırı yaratır (yalnız tetikleyen kullanıcının mesajı + yanıt depolanır — GDPR eraseForUser güvenli; ama satır büyür). Bilinçli: koordinatör talimatı "contextMessages yolu" — conversation-id'siz kalıcı hafıza FAZ sonrası değerlendirme adayı (öneri: bridge'e `persist:false` bayrağı veya per-channel conversation önerisi ai-service tarafında ayrı çalışma).
2. **`sentimentTrends` sorgusu** tarihsel veriyi okumaya devam eder (yazıcı yok → zamanla boş döner). Frontend kırılmasın diye kaldırılmadı.
3. **`embeddings_metadata` tablosu** DB'de duruyor (entity silindi). Düşürme db-migrate tarafında ayrı migration ister.
4. **`SentimentAlert` olay sözleşmesi** registry'de kaldı (yayıncı yok — hâlihazırda zaten öldü).
5. **Redis throttle'ları fail-open** (notice çift yazımı yalnız Redis çöküşü + redelivery üst üste gelirse olabilir; DB ledger claim'i mesaj çiftini yine engeller — throttle anahtarı notice-bazlı).

## 11. Değişiklik envanteri

**Yeni (12):** `apps/messaging-service/src/ai/ai-trigger-nats.handler.ts` · `…/ai/__tests__/ai-trigger-nats.handler.spec.ts` · `…/ai/services/ai-caller-capabilities.service.ts` (+spec) · `…/migrations/1802200000000-EnsureMessagesEmbeddingColumnTenantFanout.ts` · `…/shared/ai-user.ts` · `…/shared/ai-ledger-keys.ts` · `apps/auth-service/…/controllers/auth-caller-capabilities-nats.handler.ts` (+spec) · `apps/ai-service/src/chat/__tests__/ai-chat.responder.context.spec.ts` · `libs/event-contracts/src/schemas/__tests__/messaging-events.schema.spec.ts`

**Değişen (17):** event-contracts (`messaging-events.ts`, `schemas/messaging-events.schema.ts`, `auth-user-queries.ts`, `schemas/auth-user-queries.schema.ts`) · messaging (`ai-chat-bridge.service.ts` +spec, `ai-trigger.config.ts`, `ai.module.ts`, `ai-egress-gate.service.ts` +spec, `analyze-message.handler.ts`, `knowledge-extraction.service.ts` (not), `app.module.ts`, `send-message.handler.ts` +spec, `messaging-push.service.ts` +spec) · ai-service (`ai-chat.responder.ts`, `agent-runner.service.ts`) · auth-service (`token.service.ts`, `authentication.module.ts`) · `tools/quality/format-scope.json` (kapı yeniden üretimi)

**Silinen (9):** sentiment-analysis.service (+spec) · embedding.service (+spec) · extract-knowledge.command/handler · embeddings-metadata.entity · safety/instruction-hierarchy.service · safety/tool-schema-validator.service

**Dokunulmayanlar:** `apps/gateway-api` (yalnız build doğrulandı), `libs/backend-common` (mevcut export'lar import edildi), `platform/libs/*`, `web/`, `e2e/`, `/var/aqua-saas`, `/var/lib/aqua/deploy/checkout`, canlı ortam (tüm erişim yok — bu fazda canlı teşhis de gerekmedi), env değişkenleri (kill-switch KAPALI bırakıldı).

## V2 DOĞRULAYICI DÜZELTMESİ (2026-09-17) — DEPLOY SIRASINA GATEWAY-API ZORUNLU

**Ampirik kanıt**: eski gateway imajındaki derlenmiş event şeması (runtime JS
objesi, imaja gömülü) `additionalProperties:false` ile `isAiResponse:true`'lu
TÜM AI MessageSent olaylarını DÜŞÜRÜR (AJV denemesi: keyword
"additionalProperties"). §0'daki "eski tüketiciler etkilenmez" ifadesi deploy'lu
gateway validator için YANLIŞ — yeni yayıncı + eski validator = düşürme. Kill-
switch açıldığı anda §9.5-1(c) ("WS'ye AI yanıtı düşer") eski gateway ile ÇÖKER
(yanıtlar DB'de kalır, yalnız sayfa yenilemeyle görünür).

**DÜZELTİLMİŞ SIRALAR (aynı tag = local-msg-fix-2, hepsi /var/aqua-messaging-fix bağlamından):**
1. db-migrate (yeni migration 1802200000000 imajda olmalı — runtime glob)
2. auth-service (yeni resolveCallerCapabilities responder)
3. ai-service (contextMessages/priorMessages)
4. **gateway-api (ŞART — yeni şemayı içeren köprü)**
5. messaging-service (tetikleyici + köprü; kill-switch hâlâ KAPALI)
Sonra: MFE (panel, Message.metadata expose'u bu imajla canlıda) + aquamobil.
Rollback sırası tersi; gateway geri alınacaksa isAiResponse yayıncısı da kapatılmalı.

## V1/V2 BULGU DÜZELTMELERİ (koordinatör, aynı gün)
- V1 MAJOR-1: forward kopyası contentType=TEXT sabitlendi (SYSTEM spoof zinciri kapandı)
- V1 MAJOR-2: kontrata isAiErrorNotice (additive) + push filtresi hata notice'lerini muaf tutuyor
- V2: 4 yasaklı çift-cast yasal desenlere çevrildi; Message.metadata @Field expose (panel
  2.4 sorgusu bunsuz GRAPHQL_VALIDATION_FAILED verirdi — mock'lu testler maskelemişti)
