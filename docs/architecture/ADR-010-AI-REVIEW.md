# ADR-010: AI Self-Learning Pipeline Architecture Review

**Tarih:** 2026-03-24
**Durum:** REVIEW
**Reviewer:** Enterprise AI Architecture Validator
**Scope:** Planlanan AI Self-Learning sistemi fizibilite analizi

---

## Yonetici Ozeti

Mevcut MCP Farm Intelligence altyapisi (13 tool, 7 analytics motoru, 4 knowledge modulu) solid bir temel olusturuyor. Ancak planlanan self-learning pipeline'i bu altyapi uzerine eklemek icin kritik bosluklar ve overengineering riskleri tespit edildi. Bu rapor 27 bulgu iceriyor: 3 CRITICAL, 7 HIGH, 11 MEDIUM, 6 LOW.

---

## 1. Mevcut MCP Tool Yetenekleri Analizi

### 1.1 Tool Envanteri ve Veri Kaynaklari

| Tool | Kategori | Veri Kaynagi | GraphQL? | Tenant-Aware? |
|------|----------|-------------|----------|---------------|
| `predict_feeding_impact` | Math | Parametre input | Hayir | N/A (saf hesaplama) |
| `calculate_oxygen_budget` | Math | Parametre input | Hayir | N/A |
| `calculate_growth_metrics` | Math | Parametre input | Hayir | N/A |
| `calculate_carrying_capacity` | Math | Parametre input | Hayir | N/A |
| `calculate_water_chemistry` | Math | Parametre input | Hayir | N/A |
| `plan_water_treatment` | Math | Parametre input | Hayir | N/A |
| `simulate_water_cycle` | Math | Parametre input | Hayir | N/A |
| `get_farm_snapshot` | Context | GraphQL (8 paralel sorgu) | Evet | Evet (JWT) |
| `get_entity_timeline` | Context | GraphQL | Evet | Evet (JWT) |
| `detect_anomalies` | Intelligence | GraphQL (6 paralel sorgu) | Evet | Evet (JWT) |
| `correlate_domains` | Intelligence | GraphQL (6 domain) | Evet | Evet (JWT) |
| `analyze_root_cause` | Intelligence | GraphQL + cascade-predictor | Evet | Evet (JWT) |
| `assess_risk` | Intelligence | GraphQL (7 paralel sorgu) | Evet | Evet (JWT) |

### 1.2 Tenant Isolation Mekanizmasi

**Dosya:** `/var/aqua-saas/mcp/farm-management/src/graphql/client.ts`
**Dosya:** `/var/aqua-saas/mcp/farm-management/src/auth/session-context.ts`

| Seviye | Bulgu | Severity |
|--------|-------|----------|
| F-01 | GraphQL client `Authorization: Bearer <JWT>` ve `x-tenant-id` header'larini gonderiyor. JWT payload'dan tenantId, userId, roles cikartiliyor. Tenant isolation gateway tarafinda enforce ediliyor. | **OLUMLU** |
| F-02 | `AiInsightsService` Redis cache key'leri `ai-insights:{type}:{tenantId}:{entityId}` formatinda -- cross-tenant data leak onleniyor. | **OLUMLU** |
| F-03 | MCP server `McpConfig` + `SessionContext` ile instance basina tek tenant destekliyor. Ayni anda birden fazla tenant icin MCP server calistirmak icin ayri process/pod gerekiyor. | **MEDIUM** |

### 1.3 Analytics Motor Yapisi

**Dizin:** `/var/aqua-saas/mcp/farm-management/src/analytics/`

| Motor | Dosya | Islev |
|-------|-------|-------|
| Anomaly Detector | `anomaly-detector.ts` | 9 anomali turu, Z-score + esik analizi |
| Cycle Detector | `cycle-detector.ts` | Kotu dongu (vicious cycle) tespiti |
| Risk Scorer | `risk-scorer.ts` | 7 faktorlu agirlikli risk skoru (0-100) |
| Correlator | `correlator.ts` | Pearson korelasyon + time lag analizi |
| Cascade Predictor | `cascade-predictor.ts` | Bilinen kaskad zincirleri ile tahmin |
| Optimizer | `optimizer.ts` | Optimizasyon firsati tespiti |
| Reliability | `reliability.ts` | Veri guvenilirlik raporu |

### 1.4 Knowledge Base

**Dizin:** `/var/aqua-saas/mcp/farm-management/src/knowledge/`

| Modul | Dosya | Icerik |
|-------|-------|--------|
| Thresholds | `thresholds.ts` | Tur bazli optimal araliklar (sicaklik, pH, DO, NH3, NO2, NO3, yogunluk, FCR, SGR) |
| Cascade Chains | `cascade-chains.ts` | Bilinen domino etkisi zincirleri (NH3 kaskadi vb.) |
| Correlation Map | `correlation-map.ts` | Domain metrik ciftleri ve bilinen iliskiler |
| Vicious Cycles | `vicious-cycles.ts` | Kotu dongu kaliplari |

---

## 2. Planlanan 6 Yeni Tool Fizibilitesi

### Tool 1: `optimize_feeding_schedule`
> Adaptive yemleme zamanlama ve miktar optimizasyonu

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `fetchFeedingRecords`, `fetchWaterQuality`, `fetchGrowthMeasurements` -- MEVCUT |
| Compose Edilebilir mi? | `predict_feeding_impact` (Math) + `get_farm_snapshot` (Context) + yeni scheduling logic |
| Eksik | Gunluk sicaklik tahmini (weather forecast API), circadian rhythm modeli |
| Complexity | **MEDIUM** |

**Bulgu F-04 (MEDIUM):** Mevcut `predict_feeding_impact` tool'u statik parametrelerle calisiyor (`feedKg`, `biomassKg` gibi). `AiInsightsService.getFeedingAdvice()` (`/var/aqua-saas/apps/farm-service/src/ai-insights/services/ai-insights.service.ts`, satir 256-314) hardcoded varsayilan degerler kullaniyor (`feedKg: 5.0, biomassKg: 500, temperature: 22`). Self-learning icin bu degerlerin batch/tank entity'lerinden dinamik olarak cekilmesi sart.

**Oneri:** `getFeedingAdvice()` method'unda once tank ve batch verilerini GraphQL ile cekip, gercek degerleri MCP tool'a gonderin. Bu zaten yapilmali olan bir bug fix.

### Tool 2: `predict_mortality_risk`
> ML tabanli mortalite tahmin modeli

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `fetchHealthEvents`, `fetchWaterQuality`, mortalite kayitlari -- MEVCUT (anomaly-detector icinden) |
| Compose Edilebilir mi? | `detect_anomalies` (mortality_spike) + `assess_risk` (mortalityTrend factor) + yeni tahmin motoru |
| Eksik | Historik mortalite trajectory verisi, species-specific survival curve |
| Complexity | **HIGH** |

**Bulgu F-05 (HIGH):** `assess_risk` tool'u mortalite trendini zaten 0.25 agirlikla skorluyor (`/var/aqua-saas/mcp/farm-management/src/analytics/risk-scorer.ts`). Ayri bir `predict_mortality_risk` tool'u buyuk olcude bu logic'i tekrarlayacak. Risk: code duplication + maintenance burden.

**Oneri:** `assess_risk` tool'una `includeDetailedMortalityPrediction: boolean` parametresi ekleyerek mevcut yapiyi genisletin. Ayri tool yerine mode ekleme yaklasimi -- `calculate_growth_metrics` tool'undaki 5 modlu yaklasim gibi.

### Tool 3: `generate_treatment_plan`
> Hastalik/tedavi plani onerisi

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `fetchHealthEvents`, `fetchBatch` (species), `fetchWaterQuality` -- MEVCUT |
| Compose Edilebilir mi? | `analyze_root_cause` + yeni treatment knowledge base |
| Eksik | Ilac/kimyasal veritabani, doz hesaplama formulleri, kontraendikasyon kontrolu |
| Complexity | **HIGH** |

**Bulgu F-06 (CRITICAL):** Tedavi plani onerisi VETERINER SORUMLULUĞU gerektirir. AI'in ilac dozaji onermesi yasadisi olabilir (TR Veteriner Mevzuati). Bu tool "bilgilendirme" modunda calisabilir ama "receleme" modunda calisamaz.

**Oneri:** Tool'u `suggest_diagnostic_steps` olarak yeniden adlandirin. Sadece "su sorunlari kontrol edin", "bakteriyel kultur alin" gibi genel oneriler versin. Ilac dozaji kesinlikle kapsam disinda tutulun.

### Tool 4: `forecast_harvest_window`
> Hasat zamanlama tahmini

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `calculate_growth_metrics` (projection mode), `fetchActiveBatches`, pazar fiyat verisi |
| Compose Edilebilir mi? | EVET -- `calculate_growth_metrics` projection mode zaten bunu yapiyor |
| Eksik | Pazar fiyat API entegrasyonu, mevsimsel talep modeli |
| Complexity | **LOW** |

**Bulgu F-07 (LOW):** `calculate_growth_metrics` projection mode (`/var/aqua-saas/mcp/farm-management/src/tools/math/calculate-growth-metrics.ts`, satir 480-622) zaten hasat gunu tahmini yapiyor (`estimatedHarvestDays`, `targetReachedDay`). Yeni tool buyuk olcude bu logic'in ustune ince bir katman.

**Oneri:** `calculate_growth_metrics` tool'una `mode: 'harvest_forecast'` ekleyerek pazar faktoru parametreleri (hedef fiyat, minimum agirlik, batch ekonomisi) dahil edin. Ayri tool gereksiz.

### Tool 5: `analyze_production_efficiency`
> Batch/site bazli uretim verimlilik analizi

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `fetchActiveBatches`, `fetchFeedingRecords`, `fetchGrowthMeasurements` -- MEVCUT |
| Compose Edilebilir mi? | `get_farm_snapshot` + `calculate_growth_metrics` (FCR mode) + `assess_risk` (optimizer output) |
| Eksik | Maliyet verisi (yem fiyati, enerji maliyeti, iscilik) |
| Complexity | **MEDIUM** |

**Bulgu F-08 (MEDIUM):** `assess_risk` icindeki `detectOpportunities()` (optimizer.ts) zaten verimlilik firsatlarini tespit ediyor. Bu yeni tool'un farki net degil. Scope tanimlanmali.

### Tool 6: `recommend_stocking_plan`
> Yeni batch stoklama plani onerisi

| Kriter | Degerlendirme |
|--------|--------------|
| Veri Kaynaklari | `fetchTanks` (kapasite), `calculate_carrying_capacity`, mevcut batch durumu |
| Compose Edilebilir mi? | `calculate_carrying_capacity` + `get_farm_snapshot` (tankSummary) |
| Eksik | Tedarikci/hatchery entegrasyonu, mevsimsel uygunluk modeli |
| Complexity | **MEDIUM** |

**Bulgu F-09 (MEDIUM):** `calculate_carrying_capacity` Math tool'u zaten mevcut. Stocking plan icin gereken ek logic: bos tank tespiti (snapshot'tan mevcut), turlerin kombinasyon uyumlulugu (mevcut degil), tedarikci leadtime.

---

## 3. Self-Learning Pipeline Fizibilitesi

### 3.1 PostgreSQL JSONB + pgvector

**Bulgu F-10 (CRITICAL):**
Projede pgvector extension'i KULLANILMIYOR. Codebase taramasi sonucu:
- `pgvector` veya `vector extension` referansi: **SIFIR dosya**
- Mevcut PostgreSQL setup: `aquaculture` DB, TypeORM ile yonetiliyor
- Extension'lar: TimescaleDB (sensor-service'te aktif), pgvector (kurulu degil)

pgvector eklemek icin:
1. PostgreSQL Docker image'ina `pgvector` extension eklenmeli
2. `CREATE EXTENSION vector;` migration'i yazilmali
3. TypeORM custom column type tanimlanmali
4. Tenant schema'lara da extension erisilebilir olmali (`ALTER EXTENSION vector SET SCHEMA public;`)

**Risk:** pgvector ile TypeORM arasinda native destek yok. Raw SQL veya custom repository gerekiyor. `typeorm-pgvector` gibi community paketi var ama production-ready degil.

**Bulgu F-11 (HIGH):** Tenant schema izolasyonu (`tenant_*` pattern) ile JSONB storage uyumlu. Her tenant'in kendi schema'sinda `ai_feedback`, `ai_predictions`, `learning_events` gibi tablolar olusturulabilir. ANCAK:
- Mevcut `AuthSchemaBootstrapService` pattern'i (`/var/aqua-saas/apps/auth-service/src/database/schema-bootstrap.service.ts`) idempotent DDL icin kullanilabilir
- Her service kendi bootstrap service'ini kullaniyor -- farm-service icin yeni bir `AiSchemaBootstrapService` yazilmali
- `SourceSchemaBootstrapService` pattern'i sensor-service'te mevcut (memory'de referans var) ama arama sonucu DOSYA BULUNAMADI -- muhtemelen kaldirilmis veya yeniden yapilandirilmis

### 3.2 TimescaleDB Trajectory Storage

**Bulgu F-12 (MEDIUM):**
Sensor-service'te TimescaleDB altyapisi aktif:
- `/var/aqua-saas/apps/sensor-service/src/timescale/timescale.module.ts` -- HypertableService, ContinuousAggregateService, RetentionPolicyService
- `/var/aqua-saas/apps/sensor-service/src/database/migrations/1735900000000-CreateSensorMetrics.ts` -- `sensor_metrics` hypertable, 1 gun chunk interval, 7 gun compression, 90 gun retention
- `time_bucket` aggregation mevcut

Trajectory storage icin TimescaleDB UYGUN:
- AI prediction trajectory'leri zaman serisi verisi -- TimescaleDB'nin guclu yani
- `ai_prediction_trajectory(time, batch_id, predicted_weight, actual_weight, confidence, model_version)` seklinde hypertable olusturulabilir
- Compression ve retention policy'ler otomatik

ANCAK sorun: **Sensor-service ve farm-service AYRI veritabanlari kullaniyorsa**, trajectory verisi sensor-service DB'sinde mi yoksa farm-service DB'sinde mi tutulacak? Cross-service DB erisimi anti-pattern.

**Oneri:** Trajectory storage'i farm-service icinde tutun. TimescaleDB extension'i farm-service DB'sine de ekleyin, VEYA daha basit yaklasim olarak partitioned table kullanin.

### 3.3 Mevcut Bootstrap Pattern Uygunlugu

**Bulgu F-13 (MEDIUM):**
`AuthSchemaBootstrapService` pattern'i yeni tablolar icin YETERLI:
- `OnModuleInit` lifecycle hook ile startup'ta calisir
- `DO $$ ... IF NOT EXISTS ... END $$` ile idempotent DDL
- Non-fatal: basarisiz olursa service calisir ama feature devre disi

Bu pattern'i `AiSchemaBootstrapService` olarak farm-service'e kopyalamak:
- `ai_feedback` tablosu (JSONB): kullanici geri bildirimi
- `ai_prediction_log` tablosu: tahmin gecmisi
- `ai_threshold_override` tablosu: ture ozel esik ayarlamalari
- `ai_model_metadata` tablosu: model versiyonlari ve performans metrikleri

---

## 4. Eksik veya Mantik Disi Noktalar

### 4.1 CRITICAL Bulgular

**Bulgu F-14 (CRITICAL): McpClientService Hardcoded Defaults**
**Dosya:** `/var/aqua-saas/apps/farm-service/src/ai-insights/services/ai-insights.service.ts`

`getBatchGrowthPrediction()` (satir 156-163) hardcoded degerler kullaniyor:
```
currentWeightG: 100,
currentQuantity: 10000,
sgr: 2.0,
projectionDays: 30,
mortalityRatePercent: 0.1,
```
Bu degerler batch entity'sinden cekilmiyor. Self-learning pipeline bu temelin uzerine kurulursa, YANLIS TAHMINLER'den ogrenecek -- garbage in, garbage out.

**Etki:** Tum AI prediction'lari gercek veriye degil, varsayilan degerlere dayanir.
**Oneri:** ONCELIK 1 olarak bu degerleri batch/tank entity'lerinden cekin. Self-learning'den ONCE bu duzeltilmeli.

### 4.2 HIGH Bulgular

**Bulgu F-15 (HIGH): MCP Server Tek-Tenant Limiti**
MCP server process basina tek tenant JWT ile calisiyor. Multi-tenant ortamda her tenant icin ayri MCP process gerekir. Self-learning pipeline tenant sayisi arttikca N process sorunu yaratir.

**Oneri:** MCP server'i tenant-agnostic yapin. JWT'yi tool call parametresi olarak gonderin, process basina degil. Veya farm-service'in kendi icinde analytics motorlarini dogrudan cagirmasini saglayin (MCP bypass).

**Bulgu F-16 (HIGH): Feedback Loop Veri Formati Tanimlanmamis**
Self-learning pipeline'in en kritik bilesenlerinden biri kullanici feedback'i. Ancak:
- Hangi arayuzden feedback alinacak? (mobil, web panel, API)
- Feedback formati ne? (thumbs up/down, numeric score, free text)
- Feedback tenant-scoped mi? (olmali)
- Feedback'in hangi prediction'a baglanacagi? (prediction_id gerekli)
- Feedback'in anonimlestirme gereksinimleri? (KVKK)

**Bulgu F-17 (HIGH): Model Versiyonlama Stratejisi Yok**
Self-learning = model guncelleme demek. Ancak:
- Model rollback mekanizmasi yok
- A/B test altyapisi yok
- Model performans karsilastirma metrigi tanimlanmamis
- Canary deployment pattern'i (yeni model %10 traffic, eski %90) yok

**Bulgu F-18 (HIGH): Knowledge Base Statik**
**Dosya:** `/var/aqua-saas/mcp/farm-management/src/knowledge/thresholds.ts`

Tur bazli threshold'lar statik TypeScript objeleri. Self-learning'in ogrenmesi gereken ilk sey, bu threshold'larin GERCEK operasyonel verilere gore ayarlanmasi. Ancak:
- Threshold'lar compile-time sabitler -- runtime'da degistirilemez
- Tenant bazli threshold override mekanizmasi yok
- Threshold degisiklik gecmisi (audit trail) yok

**Oneri:** Threshold'lari DB'ye tasiyin. `ai_threshold_override` tablosu: `(tenant_id, species_code, parameter, min, max, optimal, updated_at, updated_by)`. Statik degerler fallback olarak kalsin.

**Bulgu F-19 (HIGH): MCP Tool Chain Orchestration Eksik**
Self-learning pipeline su akisi gerektirir:
1. Veri toplama (snapshot) -> 2. Tahmin yapma -> 3. Gercek deger karsilastirmasi -> 4. Model guncelleme

Mevcut MCP altyapisi tool'lari BAGIMSIZ cagiriyor. Tool chain orchestration (tool A'nin ciktisini tool B'ye girdi olarak verme) MCP server tarafinda yok -- LLM tarafinda yapiliyor. Self-learning icin bu orchestration PROGRAMMATIC olmali, LLM-dependent degil.

**Oneri:** Farm-service icinde `AiLearningOrchestrator` service olusturun. Bu service MCP tool'larini sirali cagirsin, sonuclari birlestirsin, DB'ye yazsin. LLM'den bagimsiz calismali.

### 4.3 MEDIUM Bulgular

**Bulgu F-20 (MEDIUM): Cache Invalidation Self-Learning ile Celisiyor**
**Dosya:** `/var/aqua-saas/apps/farm-service/src/ai-insights/services/ai-insights.service.ts`

Redis cache TTL'leri (5-15 dk) self-learning guncellemetiyle celisir. Model guncellendiginde ilgili cache key'leri invalidate edilmeli.

**Oneri:** Model guncelleme event'i yayinlandiginda (NATS) ilgili cache prefix'ini invalidate edin.

**Bulgu F-21 (MEDIUM): Circuit Breaker Self-Learning Icin Yetersiz**
**Dosya:** `/var/aqua-saas/apps/farm-service/src/ai-insights/services/mcp-client.service.ts`

3 basarisiz cagri sonrasi 30 saniyelik cooldown. Self-learning batch job'lari icin bu cok agresif. Learning pipeline daha fazla hata toleransi gerektirir.

**Oneri:** Ayri circuit breaker profili: interactive queries icin mevcut (3/30s), batch learning icin farkli (10/300s).

**Bulgu F-22 (MEDIUM): Aquaculture-Engines Kutuphane Kapsaminin Darligı**
**Dosya:** `/var/aqua-saas/libs/aquaculture-engines/src/index.ts`

Sadece `water-chemistry` modulu export ediliyor. Growth, feeding, mortality hesaplamalari MCP server icinde -- paylasilmis kutuphane olarak degil. Self-learning pipeline farm-service icinde bu hesaplamalara ihtiyac duyacak.

**Oneri:** MCP analytics motorlarini (anomaly-detector, risk-scorer, correlator) `@aquaculture/analytics-engines` olarak ayri bir lib'e cikarin. Hem MCP server hem farm-service kullanabilsin.

**Bulgu F-23 (MEDIUM): GraphQL Client In-Memory Cache Tenant Leak Riski**
**Dosya:** `/var/aqua-saas/mcp/farm-management/src/graphql/client.ts`

GraphQL client'in instance-basina `Map<string, CacheEntry>` cache'i var. Instance SessionContext'e bagli oldugu icin tenant-safe. ANCAK MCP server process recycling'de cache sifirlanir -- cold start etkisi.

**Bulgu F-24 (MEDIUM): Sensor Data Cross-Service Erisim**
Self-learning pipeline icin sensor_metrics verisine (TimescaleDB hypertable) dogrudan erisim gerekebilir. Sensor-service ayri bir microservice. GraphQL uzerinden erismek gerekir ama mevcut MCP GraphQL sorguları sadece farm-service GraphQL'ini hedefliyor.

**Oneri:** Gateway'den sensor-service GraphQL'ine de MCP tool'larinin erisebilmesini saglayin. Veya federation ile birlestirin.

**Bulgu F-25 (MEDIUM): Reliability Report Self-Learning Icin Kullanimi**
Mevcut `buildReliabilityReport()` veri tamamliligini olcer. Bu metrik self-learning icin cok degerli: dusuk reliability'li prediction'lara dusuk confidence atanabilir, learning weight'i azaltilabilir.

**Oneri:** Reliability score'u prediction metadata'sina ekleyin. Learning pipeline dusuk reliability prediction'lari ignore etsin.

### 4.4 LOW Bulgular

**Bulgu F-26 (LOW): Tool Naming Consistency**
Mevcut tool'lar snake_case (`detect_anomalies`, `assess_risk`). Yeni tool'lar da ayni konvansiyonu takip etmeli. Belgelensin.

**Bulgu F-27 (LOW): Missing Health Check**
MCP server'in health endpoint'i yok. Self-learning pipeline MCP server'in ayakta olup olmadigini bilmeli.

---

## 5. Alternatif Yaklasimlar

### 5.1 Daha Basit Self-Learning Yontemi

**ONERILEN: Bayesian Threshold Adaptation (en hafif)**

pgvector ve ML model yerine:
1. Her anomali detection sonucu + operatorun tepkisi (false positive mi?) kaydedilsin
2. Bayesian guncelleme ile threshold'lar adapte edilsin:
   - Operator "bu alarm yanlis" derse -> threshold biraz gevsesin
   - Operator "dogru alarm, mudahale ettim" derse -> threshold kalsin
   - Operator hic tepki vermezse -> alarm onemsiz mi? 30 gunden sonra otomatik gevseme
3. Tenant bazli `threshold_multiplier` tablosu: `(tenant_id, anomaly_type, multiplier, last_updated)`
4. multiplier 0.8 = %20 daha hassas, 1.2 = %20 daha toleransli

**Avantajlar:**
- pgvector gereksiz
- ML model gereksiz
- Mevcut anomaly-detector'a tek bir `multiplier` parametresi eklenir
- Anlasilmasi ve debug edilmesi kolay
- Her tenant icin farkli sensitivity -- gercek self-learning

**Complexity:** LOW
**Etki:** HIGH (false positive oranini %30-50 dusurur)

### 5.2 pgvector Alternatifleri

| Alternatif | Avantaj | Dezavantaj | Oneri |
|-----------|---------|------------|-------|
| **pgvector** | PostgreSQL native, single DB | TypeORM native destek yok, ek extension | Self-learning Phase 3+ icin |
| **Redis Vector (RediSearch)** | Zaten Redis var (cache icin), hizli | Persistent degil, kayip riski | Similarity search icin gecici kullanim |
| **JSONB Array + Cosine SQL** | Extension gereksiz, pure PG | Yavas (O(n) scan), olceklenmez | Kucuk veri setleri (<10K vektoru) icin yeterli |
| **Pinecone/Weaviate SaaS** | Managed, performansli | Ek maliyet, ek dependency | Overengineered -- bu olcekte gereksiz |
| **SQLite + vector ext** | Hafif, embedded | Multi-tenant'a uygun degil | Prototype icin |

**Oneri:** Phase 1'de JSONB Array + Cosine SQL kullanin. Veri boyutu 100K vector'u astinda pgvector'e migrate edin. Pinecone gibi external servisler bu olcekte overengineered.

### 5.3 Daha Hafif Feedback Loop

**ONERILEN: Implicit + Explicit Hybrid Feedback**

#### Implicit Feedback (sifir UI degisikligi):
- Operator anomali alarm'i gordu mu? (viewed = implicit positive)
- Operator alarm sonrasi aksiyon aldi mi? (action_taken = strong positive)
- Operator alarm'i 24 saat icerisinde gormedi -> muhtemelen onemli degil (implicit negative)
- Prediction dogru cikti mi? (gercek deger vs tahmin, otomatik karsilastirma)

#### Explicit Feedback (minimal UI):
- Anomali karti uzerine tek buton: "Bu alarm faydali mi?" (Evet/Hayir)
- Risk assessment sayfasinda: "Risk degerlendirmesi ne kadar dogru?" (1-5 yildiz)

#### Depolama:
```sql
CREATE TABLE farm.ai_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  prediction_type VARCHAR(50) NOT NULL, -- 'anomaly', 'risk', 'feeding', 'growth'
  prediction_id UUID, -- hangi prediction'a ait
  feedback_type VARCHAR(20) NOT NULL, -- 'implicit_view', 'implicit_action', 'explicit_rating'
  value JSONB NOT NULL, -- {"useful": true} veya {"rating": 4}
  context JSONB, -- prediction esnasindaki parametreler (snapshot)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID
);
```

Bu tablo farm-service DB'sinde, `AiSchemaBootstrapService` ile olusturulur.

---

## 6. Onerilen Uygulama Fazlari

### Phase 1: Foundation (2-3 hafta)
1. **F-14 FIX (CRITICAL):** `AiInsightsService` hardcoded degerleri gercek batch/tank verisiyle degistir
2. **F-18 FIX (HIGH):** Threshold'lari DB'ye tasi, tenant-override destekle
3. **F-19 FIX (HIGH):** `AiLearningOrchestrator` service olustur
4. `AiSchemaBootstrapService` yaz (ai_feedback, ai_prediction_log tablolari)
5. Implicit feedback toplamayi baslat (viewed/action_taken event'leri)

### Phase 2: Adaptive Thresholds (2-3 hafta)
1. Bayesian threshold adaptation implement et
2. Explicit feedback UI ekle (tek buton: Evet/Hayir)
3. `threshold_multiplier` tablosu + API
4. Anomaly detector'a multiplier entegrasyonu
5. Dashboard'a "AI ogrenme durumu" widget'i

### Phase 3: Prediction Tracking (3-4 hafta)
1. Prediction log'lama (her AI prediction DB'ye yazilsin)
2. Actual vs predicted karsilastirma (otomatik batch job)
3. Model performans metrikleri dashboard'u
4. `calculate_growth_metrics` projection sonuclarini loglama
5. Forecast accuracy tracking

### Phase 4: Advanced (4-6 hafta, opsiyonel)
1. pgvector ekleme (eger Phase 3'te veri boyutu yeterli ise)
2. Similar case retrieval (benzer anomalilerin gecmis cozumleri)
3. Production efficiency composite score
4. Cross-tenant anonymized benchmarking (opsiyonel, KVKK uyumlu)

---

## 7. Overengineering Uyarilari

| Alan | Risk | Oneri |
|------|------|-------|
| pgvector Phase 1'de | Henuz vektoru olusturacak yeterli veri yok | Phase 3+'e erteleyin |
| Ayri ML model servisi | Ops karmasikligi, ayri deployment | Analytics motorlarini farm-service icinde tutun |
| Real-time learning | Her sensor okumada model guncelleme | Gunluk batch job yeterli |
| 6 yeni tool birden | Buyuk delivery riski | Ayni anda en fazla 2 tool gelistirin |
| Kafka Streams learning | Sensor-service'te Kafka zaten var ama learning icin overengineered | PostgreSQL LISTEN/NOTIFY veya NATS event yeterli |
| Custom vector DB | Pinecone/Weaviate SaaS entegrasyonu | Bu olcekte gereksiz |

---

## 8. Bulgu Ozet Tablosu

| ID | Severity | Baslik | Dosya/Konum |
|----|----------|--------|-------------|
| F-01 | OLUMLU | Tenant isolation JWT + x-tenant-id | `graphql/client.ts`, `session-context.ts` |
| F-02 | OLUMLU | Cache key tenant-scoped | `ai-insights.service.ts` |
| F-03 | MEDIUM | MCP server tek-tenant process limiti | `mcp-client.service.ts` |
| F-04 | MEDIUM | Feeding advice hardcoded parametreler | `ai-insights.service.ts:256-314` |
| F-05 | HIGH | predict_mortality_risk code duplication | Risk scorer ile overlap |
| F-06 | CRITICAL | Treatment plan veteriner mevzuat riski | Yeni tool plani |
| F-07 | LOW | harvest_forecast mevcut logic tekrari | `calculate-growth-metrics.ts:480-622` |
| F-08 | MEDIUM | production_efficiency scope belirsiz | optimizer.ts ile overlap |
| F-09 | MEDIUM | stocking_plan eksik bilesen | Tedarikci/hatchery entegrasyonu |
| F-10 | CRITICAL | pgvector kurulu degil, TypeORM uyumsuz | Tum codebase |
| F-11 | HIGH | Tenant schema AI tablolari yok | farm-service DB |
| F-12 | MEDIUM | TimescaleDB cross-service erisim | sensor-service vs farm-service |
| F-13 | MEDIUM | Bootstrap pattern uygun ama yazilmali | AuthSchemaBootstrapService ornegi |
| F-14 | CRITICAL | Hardcoded prediction parametreleri | `ai-insights.service.ts:156-163` |
| F-15 | HIGH | MCP multi-tenant process sorunu | `mcp-client.service.ts` |
| F-16 | HIGH | Feedback loop veri formati tanimlanmamis | Yeni tasarim gereken |
| F-17 | HIGH | Model versiyonlama stratejisi yok | Yeni tasarim gereken |
| F-18 | HIGH | Knowledge base statik, runtime degismiyor | `knowledge/thresholds.ts` |
| F-19 | HIGH | Tool chain orchestration LLM-dependent | MCP tool cagri yapisi |
| F-20 | MEDIUM | Cache invalidation self-learning celiskisi | `ai-insights.service.ts` cache TTL'leri |
| F-21 | MEDIUM | Circuit breaker batch learning icin agresif | `mcp-client.service.ts` |
| F-22 | MEDIUM | Analytics motorlari paylasilmis lib degil | `aquaculture-engines/` sadece water-chemistry |
| F-23 | MEDIUM | GraphQL cache cold start etkisi | `graphql/client.ts` |
| F-24 | MEDIUM | Sensor data cross-service erisim | sensor-service microservice siniri |
| F-25 | MEDIUM | Reliability report learning entegrasyonu | `analytics/reliability.ts` |
| F-26 | LOW | Tool naming convention belgelenmeli | Tum tool dosyalari |
| F-27 | LOW | MCP health check yok | MCP server |

---

## 9. Sonuc

Mevcut MCP Farm Intelligence altyapisi **olgun ve iyi tasarlanmis**. 13 tool, 7 analytics motoru, 4 knowledge modulu ve tenant-aware GraphQL istemcisi solid bir temel olusturuyor.

Self-learning pipeline icin **oncelikli aksiyon**:
1. **F-14'u duzelt** -- hardcoded degerler yerine gercek veri kullan (CRITICAL)
2. **F-06'yi ele al** -- treatment plan tool'unu yasal uyumlu hale getir (CRITICAL)
3. **Bayesian threshold adaptation** ile basla (en yuksek ROI, en dusuk risk)
4. pgvector ve ML model'i Phase 3+'e ertele (veri biriktirme suresi gerekli)
5. 6 yeni tool'u 4'e dusur (harvest_forecast ve production_efficiency mevcut tool'lara eklenebilir)

**Tahmini toplam efor:** Phase 1-3 icin 7-10 hafta, Phase 4 opsiyonel +4-6 hafta.
