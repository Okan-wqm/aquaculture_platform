# Çiftlik-AI Program — Nihai Plan (v3)
**Tarih:** 2026-09-18 | **Sürüm:** v3 (2 dalga düşman-ajan + son okuma düzeltmeleri işlenmiş)
**Tek doğruluk kaynağı:** Bu belge. PR'ler buna göre yazılır.

---

## Bağlam

**Canlıda çalışan:** Z.ai glm-5.3 + reasoning_effort=low; gerçek araç çağrıları (su kimyası hesaplayıcıları + farm verisi); konuşma hafızası; insan-onaylı aksiyon makinesi; kota (50/kanal/gün + 60/saat + token bütçesi).

**Hedef:** Reaktif sohbet → proaktif çiftlik asistanı: rutin orkestratör (cron → anomali → uzmana devir), action_watch (kural-hüküm + LLM-anlatı), farm_journal (deneyim hafızası), öğrenme döngüsü (benzer geçmiş + tahmin-sonuç).

**Planın geçmişi:** Claude planı (PR-0..7) + 3 tur tasarım tartışması + 2 dalga düşman-ajan kod doğrulaması (9 ajan, 36 bulgu) + son okuma (2 kritik + 3 orta + hijyen).

**Temel ilkeler:**
1. AI yalnızca ÖNERİR; karar KULLANICININ (kural hüküm verir, LLM anlatı yazar)
2. Kanıt olmadan inşa ETME (tetikleyici tablosu: ertelenmiş yamalar gözlemlenebilir aktivasyon koşulu bekler)
3. Payload'dan yetki ALINMAZ (sunucu-tarafı sahiplik haritası)
4. Her migration: niteliksiz DDL + MODULE_SCHEMAS + manifest aynı commit; pinSearchPath tenantAware modüllerde YASAK
5. Her NATS subject: services.yaml → regen → nats.conf + helm aynı commit; Nest yığını (ClientProxy.send + @MessagePattern)
6. Uygulanmış migration dosyası EDİTLENMEZ — yeni iyileştirme migration'ı yazılır

---

## v3 Son Okuma Düzeltmeleri

1. **PR-P0:** 1800700000000 EDİTLENMEZ; yeni `EnsureEmbeddingColumnTenantParity` migration'ı (IF NOT EXISTS)
2. **withBypass emsali:** sensor/daq-storage.service.ts:546, alarm-storage.service.ts:471, messaging/ai-privacy.service.ts:256 (retry-scheduler DEĞİL — o FORCE'suz tabloda çalışıyor)
3. **PR-P0 ölçütü:** "kolon tüm tenant şemalarında mevcut" (similarMessages'in dirilişi Faz 6/PR-L'ye işaretli)
4. **SENSOR_AUTOMATIC spoof:** create-water-quality GraphQL input MANUAL'e sabitlenir
5. **Geç-veri politikası:** "Backdate penceresi içinde geç gelen veri verilmiş hükmü geri ALMAZ; journal'a düzeltme notu düşer"

**Hijyen:** 4.4.4→4.1.5; "proactiveMonitoringEnabled artık OKUNUR" silindi (routineAiEnabled okunur); pinSearchPath yasağı tenantAware kapsamlı; APP_TO_SERVICE + servis-olmayan allowlist; broker dump → varz/authorization (connz değil); migration timestamp sıra notu; retention+scan-interval tetikleyici tabloya.

---

## FAZ 0 — ACİL DÜZELTMELER (1 sprint)

### Sprint 0.1 — Provider timeout + audit uuid

| # | İş | Dosya | Detay |
|---|---|---|---|
| 0.1.1 | OpenAI timeout | `apps/ai-service/src/agent/providers/openai.provider.ts:55` | `new OpenAI({apiKey, timeout:30_000, maxRetries:1})` |
| 0.1.2 | Anthropic ikizi | `anthropic.provider.ts:47` | Aynı |
| 0.1.3 | validateCredential | Her iki provider | Aynı sınırlar |
| 0.1.4 | LlmProvider signal | `llm-provider.interface.ts` | `signal?: AbortSignal` (breaker ölçer, iptal ETMEZ; emsal: farm mcp-client.service.ts:210) |
| 0.1.5 | Audit uuid | `tool-executor.service.ts` | ServicePrincipal `'service:sensor-service'` GEÇERSİZ uuid → INSERT düşüyor. UUIDv5 deterministik |
| 0.1.6 | Audit-failure metriği | `audit.service.ts` | Sayaç + log |

**Test:** sahte provider 30sn'de kesilir; uuid format; failure sayacı.
**Deploy:** ai-service → canlı smoke.

### Sprint 0.2 — ACL drift + contractFiles

| # | İş | Detay |
|---|---|---|
| 0.2.1 | Canlı broker dump | `nats:8222` **varz/authorization** (connz değil) → services.yaml uzlaştır; resolveCallerCapabilities grant repoya taşınır |
| 0.2.2 | contractFiles | Bayat `auth-admin-commands.ts` çıkar; `farm-site-access-queries.ts` + `auth-credential-queries.ts` + `nats-patterns.ts` ekle |
| 0.2.3 | Sessiz atlama YASAK | `expect(unresolved).toEqual([])` PATLAT; `DOSYA.ÜYE` anahtarlama; APP_TO_SERVICE + servis-olmayan allowlist (`db-migrate: null` emsali) |
| 0.2.4 | Gece ACL probu | Canlı ↔ repo diff → alarm |

**Deploy:** nats restart → gece prob doğrula.

### Sprint 0.3 — PR-P0: Embedding fan-out iyileştirmesi

| # | İş | Detay |
|---|---|---|
| 0.3.1 | **YENİ migration** `EnsureEmbeddingColumnTenantParity` | Niteliksiz DDL + `IF NOT EXISTS`; 1800700000000'a DOKUNULMAZ (yalnız docblock + immutability waiver) |
| 0.3.2 | postCondition | information_schema: tüm tenant şemalarında kolon varlığı |
| 0.3.3 | Ölçüt | Kolon tüm şemalarda MEVCUT (similarMessages dirilişi Faz 6'da) |

---

## FAZ 1 — TEMEL: PERSONA KONTRAT + YETENEK (2 sprint)

### Sprint 1.1 — PR-0: shared-contracts
- `persona-id.ts` (AI_PERSONA_ID_RE, isAiPersonaId, parseAiPersonaId, formatAiPersonaId)
- `persona-catalogue.ts` (AI_SPECIALTY_CATALOGUE 4 specialty, AI_PERSONA_CATALOGUE 13 giriş)
- shared-contracts narrow-design (zero-dep, `as const`, no enum) + barrel allowlist
- Messaging persona id göçü

### Sprint 1.2 — PR-0: ai-service katı doğrulama + sunucu-tarafı sahiplik
- resolveProfile fallback KALDIR → UnknownPersonaError; bilinmeyen önek→supervisor bug'ı kapanır
- **Sunucu-tarafı sahiplik haritası:** `serviceId → grantedPersonaIds` (payload'dan yetki ALINMAZ)
- **persona-tool-ceiling:** `allowAdditionalTools` bayrağı + `toolless` narrator
- narrator-v1: defaultToolNames=[], prompt "yalnızca verilen kanıtla anlat, web yok, araç yok"
- **Ephemeral:** ChatRequest.ephemeral → conversation AÇMA; conversationId nullable migration; correlationId/servicePrincipal kaydı; iç rate-limit namespace
- `routineAiEnabled` kolonu (default false)

### Sprint 1.3 — PR-1: ai_specialties:farm
- permission-catalogue all-of; seed; backfill; katalog↔yetenek SSoT çapraz kontrol

---

## FAZ 2 — FARM UZMANLARI (4 sprint)

### Sprint 2.1 — PR-2 Commit A: byte-identical
- tiers/{operator,manager,expert,supervisor}.tier.ts; specialties/{general,farm-*}.specialty.ts; compose.ts
- persona-parity.spec: donmuş fixture + snapshot byte-identical

### Sprint 2.2 — PR-2 Commit B: promptlar
- PROMPT_PREAMBLE (uydurma yok, tool sonucu şart, karar kullanıcının)
- Tier + specialty fragment'ları; middleware preProcess tek-çıkışlı prompt; personaId persist

### Sprint 2.3 — PR-3: Su & Sağlık (13 araç + ACL)
- Kontrat `farm-ai-queries/` (zarf `{ok,data}|{ok,error}`)
- ACL: her subject açık satır → regen → aynı commit; contractFiles'a ekle
- Responder'lar: tenant-pin ZORUNLU (6 mevcut pin'siz handler'ın hatası tekrarlanmaz)
- FarmAiQueryTool tabanı + 13 somut araç; PII yasağı
- **SENSOR_AUTOMATIC kısıtı** (v3): create-water-quality GraphQL input MANUAL'e sabit

### Sprint 2.4 — PR-4+5: Üretim (17) + Operasyon (10)
- Desen birebir Sprint 2.3; finans araçları manager+; ListFeederCalibrations argüman sırası

---

## FAZ 3 — FARM JOURNAL (2 sprint)

### Sprint 3.1 — Tablo + append-only + RLS
- Migration `CreateFarmJournal`: niteliksiz DDL (pinSearchPath tenantAware'da YASAK); CHECK'ler migration gövdesinde (TypeORM @Check UYGULAMAZ); RLS (tenantId uuid camelCase 1. günden); MODULE_SCHEMAS + manifest aynı commit (yetim = boot CRASH)
- Append-only: BEFORE UPDATE/DELETE trigger + REVOKE (1804800000000 katman); supersedesEntryId; idempotencyKey upsert; zarf {ok, entryId?, error?}

### Sprint 3.2 — Service + UI + NATS
- journal.service (yalnız save+find; UPDATE/DELETE metodu HİÇ yazılmaz)
- `request.farm.appendAiJournalEntry` responder (AI provenans zorunlu; human bu subject'ten RED)
- ACL: ai publish + farm subscribe → regen → aynı commit
- JournalPage (farm-module; zaman tüneli + form + etiket filtresi + provenans); shared-contracts alias (farm-module)

---

## FAZ 4 — ACTION_WATCH v0 (3 sprint)

### Sprint 4.1 — Tablo + kural-hüküm motoru
- `farm_action_watches`: hypothesis jsonb {metric,direction,threshold,cadenceHours,windowHours}; status CHECK (watching|resolved|inconclusive); asOf + **watermark**; checks_done/limit; confounder; last_rule_outcome; narrative/model; closure_reason
- Kural motoru: saf SQL; asOf üst sınır (determinizm: iki çağrı arasına yeni veri → aynı kesit)
- watch-ruling-no-llm invariant (provider import yasak)
- Zehirli-watch karantinası (izolasyon + sayaç + otomatik devre dışı)
- **Geç-veri politikası** (v3): "geç gelen veri hükmü geri almaz, journal'a not düşer" + spec

### Sprint 4.2 — Tarayıcı + gece + anlatı
- **Tarayıcı FARM-SERVICE'TE** (ai'de list_active EXECUTE yetkisi yok + ScheduleModule yok)
- forEachVerifiedTenantSchema (concurrency 4, rotateBy)
- RLS FORCE → withBypass: **DOĞRU emsaller** sensor/daq-storage.service.ts:546, alarm-storage.service.ts:471, messaging/ai-privacy.service.ts:256
- runExclusive advisory-lock (replicas:2 çift-koşu gerçek)
- Olay-tetikli: mevcut SensorReading wildcard (sensor-service'e SIFIR yeni bağ)
- Gece 02:00: deadline geçen → inconclusive + caveat + journal; anlatı asla senkron değil; narrative NULL → sonraki kontrol
- Narrative responder `request.ai.composeNarrative`: narrator-v1 + sunucu-tarafı sahiplik; model SABİT (kiracı chatModel override YÖNLENDİREMEZ); ai_outbox
- ACL: 4 satır (farm pub+ai sub; ai pub+farm sub) → regen → aynı commit

### Sprint 4.3 — UI + güvenlik
- ActionWatchPage + Card (durum çipi; hipotez; konfounder; "Şimdi kontrol et" — kadans sıfırlamaz; 30sn polling)
- Safety carve-out (agent-runner uygulama noktasında)
- Metrics: ai_watch_state_total, ai_watch_narrative_failures_total

---

## FAZ 5 — RUTİN ORKESTRATÖR (3 sprint)

### Sprint 5.1 — PR-R0: 4 eksik kaynak aracı
- list_critical_water_quality, list_critical_health_events, list_overdue_work_orders, get_task_stats

### Sprint 5.2 — PR-R: orkestratör + DELEGATE
- agent_routines + runs (koşu gözetim: consecutive_failures, last_error_at, next_retry_at); ScheduleModule.forRoot()
- Orkestratör: @Cron(EVERY_MINUTE); Redis SET NX kilit; **ephemeral modda** AgentRunner; `routineAiEnabled` OKUYAN İLK KOD; scope'lu bütçe `ai:ratelimit:routine:{tenant}:{hour}`
- **DELEGATE native tool:** delegate_to_specialist (şema {specialty, reason}); parse başarısız → no_delegate SONUÇ SATIRI (sessiz no-op YASAK)
- Dry-run; routineDeliveryHour (kullanıcı seçimi); notification şablon dalı; channel-router

### Sprint 5.3 — UI + gözetim + PR-B
- AiRoutinesPage (tenant-admin)
- Dead-man + Prometheus ai_routine_run_failures_total
- call_budget.service: consumeInfoCall(scope) + recordSafetyCall; ADD COLUMN call_kind DEFAULT'lu; entity kolon; save() PK'sız create()

---

## FAZ 6 — ÖĞRENME YÜZEYİ (2 sprint)

### Sprint 6.1 — Embedding + benzer durumlar
- `request.ai.generateEmbeddings` responder (ÖLÜ boru canlanır; platform modeli — BYOK değil)
- Journal embedding doldurma cron + HNSW (PR-P0 sonrası güvenli)
- similarWatches: ön-filtre SONRA kosin
- Watch kartında "bu tankta N benzer durum"

### Sprint 6.2 — Tahmin UX
- Tahmin sonuçtan ÖNCE görünür + çiftçi veto (adjustedWindowHours + gerekçe)
- farmerDisagreement ayrı kolon (hüküm değişmez, not düşer)

---

## FAZ 7 — UI UÇTAN UCA (2 sprint)

### Sprint 7.1 — Gateway + messaging
- gateway PERSONA_RE → isAiPersonaId; createChannel @IsKnownAiPersonaId
- Consent UI: web messaging-module'de ayar YÜZEYİ yaratılır (ChatRoom popover / kanal ayarları)

### Sprint 7.2 — Shell + aquamobil + deploy
- Shell `ai:chat` emit'e persona + gateway + ai-service sözleşmesi (socket protokol genişletmesi)
- shared-contracts alias: shell + messaging + **farm-module + tenant-admin** (4 modül)
- AiChatPage PERSONA_METADATA → server verisinden zenginleştir (fallback tuzağı kapanır)
- Deploy: 5 MFE + 3 backend (messaging-module bake'te YOK — service-catalog + droplet compose)

---

## TETİKLEYİCİ TABLOSU (7 yama + 2 ölçüm kuralı)

| # | Yama | Aktivasyon koşulu |
|---|---|---|
| 1 | Histeresis | resolved >%10 24s içinde yeniden açılırsa |
| 2 | Gün/gece baz | Gece inconclusive > gündüz ×1.5 |
| 3 | Otomatik konfounder önerisi | İnsan konfounder <%20 + haftalık inconclusive ≥10 |
| 4 | Adaptif kadans | 3 kontrol bilgi kazancı 0 |
| 5 | Hash-zincir | Denetim talebi + journal >10k/ay |
| 6 | Gözcü-nabzı | İlk kaçırılan gece işi |
| 7 | Çok-metrik | inconclusive(no_data|pencere_kısa) >%40 |
| 8 | Retention penceresi | Journal/watch ilk 1k satır gözlemi |
| 9 | Tarama aralığı | scan_interval ≥ ceil(N/4) × p95 ihlal |

---

## GÜVENLİK ÖZETİ

| Tehdit | Kontrol | Desen |
|---|---|---|
| Rutin prompt injection | InstructionHierarchy TENANT katmanı + input filter | ai-safety.middleware |
| internalCaller spoof | Sunucu-tarafı sahiplik (payload'dan yetki ALINMAZ) | sensor responder |
| Persona-tool-ceiling | allowAdditionalTools + toolless | YENİ |
| Bütçe sömürüsü | scope'lu sayaç + safety muaf | rate-limit.service |
| Kiracı sızması | runInTenantRead + UUID + RLS FORCE | mevcut |
| Journal bütünlüğü | Trigger+REVOKE+provenans zorunlu | tool_execution_audit |
| Sensör→AI enjeksiyon | Sayısal şema + UNTRUSTED katman | instruction hierarchy |
| Fail-closed | AI yok / veri bozuk / bütçe → DURUR | egress gate |

---

## TEST STRATEJİSİ

| Seviye | Neyi kanıtlar | Kritik spec'ler |
|---|---|---|
| Birim | Determinizm, cron, journal şekil | rule-verdict golden; watch-state-machine; journal-writer |
| Entegrasyon | Gerçek NATS+DB+tenant-pin | farm-ai-nats-roundtrip; **DB'den SELECT doğrulama** |
| Invariant | SSoT üçgenler | nats-invariants (patlatmalı); journal-append-only; watch-ruling-no-llm; persona-tool-ceiling |
| Canlı E2E | Kullanıcı gözünden | persona→araç→sayısal; rutin→devir; watch→resolved |

**Bugünkü 5 ders:** tenant-pin (entegrasyon gerçek şema); kelime dağarcığı (invariant+import'lu spec); validator (glm gerçek çıktı fixture); ACL (üçgen+canlı prob); consent (E2E yönlendirme).

**Meta-kural:** `spec-has-a-runner` — her spec'in koşucusu var.

---

## DEPLOY PROSEDÜRÜ

```
1. TOKEN — max 1 login (<50dk etme; rate 5/15dk)
2. SMOKE — AI kanalına soru; ≤60sn; araç çağrısı
3. AUDIT — tool_execution_audit ≥1 success
4. LOG — 0 violation; 0 tenant-pin; 0 unhandled
5. ARŞİV — results/<faz>/observations.json
6. Rollback: 3/2 >60sn; audit 0; tenant-pin; injection
```

## SÜRE TAHMİNİ
Faz 0: 1 · Faz 1: 2 · Faz 2: 4 · Faz 3: 2 · Faz 4: 3 · Faz 5: 3 · Faz 6: 2 · Faz 7: 2 = **19 sprint** (paralel ~14)

---

## İlerleme Günlüğü

| Tarih | Faz/Sprint | Durum | Not |
|---|---|---|---|
| 2026-09-18 | Plan v3 kaydedildi | ✅ | Onaylandı, Sprint 0.1 başlıyor |
