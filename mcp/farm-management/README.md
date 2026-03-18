# MCP Farm Intelligence Server

Akvakultür çiftlik yönetimi için **Model Context Protocol (MCP)** sunucusu. Claude Desktop, Claude Code ve MCP uyumlu diğer AI istemcileriyle entegre çalışarak çiftlik operasyonlarına akıllı analiz desteği sağlar.

---

## 1. Genel Bakış

Farm Intelligence Server, su ürünleri yetiştiriciliğinde **dört temel zeka fonksiyonu** sunar:

| Fonksiyon | Açıklama |
|-----------|----------|
| **Anomali Tespiti** | 9 farklı anomali türünü otomatik tarar: mortalite sivrilemesi, su kalitesi sapması, büyüme yavaşlaması, FCR bozulması, yemleme varyansı, yoğunluk aşımı, iştah kaybı, biyofiltre stresi, geciken bakım |
| **Cross-Domain Korelasyon** | Farklı domain'lerdeki metriklerin istatistiksel ilişkisini Pearson korelasyon katsayısı, zaman gecikmesi (lag) ve p-value ile analiz eder |
| **Kök Neden Analizi** | Bir anomali olayının potansiyel nedenlerini skorlayarak sıralar; zaman yakınlığı, istatistiksel sapma ve bilinen nedensellik ilişkilerini ağırlıklı olarak değerlendirir |
| **Risk Değerlendirmesi** | 7 risk faktörünü ağırlıklı ortalama ile birleştirerek 0-100 arası bileşke risk skoru hesaplar; opsiyonel olarak 24 saat/7 gün projeksiyonu sunar |

Bunlara ek olarak **5 matematik aracı** (yemleme etkisi, oksijen bütçesi, büyüme metrikleri, taşıma kapasitesi, su kimyası) ve **2 context aracı** (çiftlik anlık görüntüsü, varlık zaman çizelgesi) ile toplam **11 tool** barındırır.

---

## 2. Mimari

### 2.1 Hibrit Zeka Modeli

Server, **algoritmik hesaplama** ile **LLM reasoning** yeteneğini birleştirir:

```
┌──────────────────────────────────────────────────────────┐
│                    Claude (LLM)                          │
│  Doğal dil anlama, bağlam yorumlama, karar verme        │
│  Sonuçları sentezleme, Türkçe rapor oluşturma           │
└───────────────────┬──────────────────────────────────────┘
                    │ MCP Protokolü (JSON-RPC / stdio)
                    ▼
┌──────────────────────────────────────────────────────────┐
│              Farm Intelligence MCP Server                │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Zeka (4)    │  │ Matematik (5)│  │ Context (2)    │  │
│  │             │  │              │  │                │  │
│  │ Anomali     │  │ Yemleme      │  │ Snapshot       │  │
│  │ Korelasyon  │  │ Oksijen      │  │ Timeline       │  │
│  │ Kök Neden   │  │ Büyüme       │  │                │  │
│  │ Risk        │  │ Kapasite     │  │                │  │
│  │             │  │ Su Kimyası   │  │                │  │
│  └──────┬──────┘  └──────────────┘  └──────┬─────────┘  │
│         │                                   │            │
│  ┌──────▼───────────────────────────────────▼─────────┐  │
│  │              Analytics Engine                       │  │
│  │  anomaly-detector · correlator · cascade-predictor  │  │
│  │  risk-scorer · optimizer · cycle-detector           │  │
│  │  reliability (güvenilirlik çerçevesi)               │  │
│  └──────────────────────┬────────────────────────────┘  │
│                         │                                │
│  ┌──────────────────────▼────────────────────────────┐  │
│  │           Knowledge Base (Bilgi Tabanı)            │  │
│  │  thresholds · correlation-map · cascade-chains     │  │
│  │  vicious-cycles                                    │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                    │
                    ▼ GraphQL (HTTP POST)
┌──────────────────────────────────────────────────────────┐
│              GraphQL Gateway (aqua-gateway)               │
│  JWT doğrulama, tenant izolasyonu, rate limiting         │
└──────────────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────────┐
│                    PostgreSQL                             │
│  farm, sensor, health, feeding, growth, maintenance ...  │
└──────────────────────────────────────────────────────────┘
```

### 2.2 Zeka Zinciri

Tool'lar tipik olarak şu sırayla zincirlenerek kullanılır:

```
detect_anomalies → correlate_domains → analyze_root_cause → assess_risk
```

1. **detect_anomalies**: Çiftlik genelinde anomali taraması yapar
2. **correlate_domains**: Tespit edilen anomalilerin domain'ler arası ilişkisini analiz eder
3. **analyze_root_cause**: En olası kök nedenleri skorlayarak sıralar
4. **assess_risk**: Bileşke risk skorunu hesaplar, optimizasyon fırsatlarını belirler

### 2.3 Veri Erişim Katmanı

Server, veritabanına **doğrudan erişmez**. Tüm veri, GraphQL Gateway (`aqua-gateway`) üzerinden çekilir:

- JWT token ile kimlik doğrulama
- `x-tenant-id` header ile tenant izolasyonu
- `Promise.allSettled` ile paralel sorgular (bir sorgu başarısız olsa bile diğerleri devam eder)

### 2.4 Graceful Degradation (Zarif Düşüş)

JWT token yoksa veya geçersizse server çökmez, kısıtlı modda çalışır:

| Durum | Kullanılabilir Tool'lar |
|-------|------------------------|
| JWT geçerli | 11 tool (tam işlevsel) |
| JWT yok/geçersiz | 5 matematik tool'u (offline hesaplama) |

### 2.5 @platform/aquaculture-engines Entegrasyonu

Su kimyası hesaplamaları, workspace kütüphanesi olan `@platform/aquaculture-engines` üzerinden yapılır:

- **fractionNH3** / **calcNH3** / **calcNH4**: Amonyak dengesi (Millero 1995)
- **criticalPHforNH3** / **criticalPHforH2S** / **criticalPHforCO2**: Kritik pH hesaplamaları (bisection)
- **co2Level** / **calcDicOfAlk**: Karbonat sistemi (Millero 2010)
- **REAGENTS** / **alkMgToMeq**: Kimyasal dozlama

---

## 3. Kurulum ve Çalıştırma

### 3.1 Bağımlılıklar

```bash
cd mcp/farm-management
npm install
```

### 3.2 Ortam Değişkenleri

`.env.example` dosyasını `.env` olarak kopyalayıp düzenleyin:

```bash
cp .env.example .env
```

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `GATEWAY_URL` | `http://localhost:3000/graphql` | GraphQL Gateway adresi |
| `MCP_JWT_TOKEN` | _(boş)_ | JWT Bearer token — stdio modunda zorunlu |
| `MCP_TRANSPORT` | `stdio` | Transport modu: `stdio` veya `sse` |
| `MCP_PORT` | `3009` | SSE modu port (sadece `sse` modunda) |
| `MCP_LOG_LEVEL` | `info` | Log seviyesi: `debug`, `info`, `warn`, `error` |
| `MCP_REQUEST_TIMEOUT` | `30000` | GraphQL istek timeout (ms) |

### 3.3 Development

```bash
npm run dev
```

`tsx` ile TypeScript doğrudan çalıştırılır — derleme gerekmez.

### 3.4 Production

```bash
npm run build     # TypeScript → JavaScript (dist/ klasörüne)
npm start         # node dist/index.js
```

### 3.5 Claude Desktop Entegrasyonu

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) veya `%APPDATA%\Claude\claude_desktop_config.json` (Windows) dosyasına ekleyin:

```json
{
  "mcpServers": {
    "farm-intelligence": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/farm-management/dist/index.js"],
      "env": {
        "GATEWAY_URL": "http://localhost:3000/graphql",
        "MCP_JWT_TOKEN": "eyJhbGciOiJIUzI1NiIs..."
      }
    }
  }
}
```

### 3.6 Claude Code MCP Ayarı

Proje kök dizinindeki `.claude/settings.json` dosyasına ekleyin:

```json
{
  "mcpServers": {
    "farm-intelligence": {
      "command": "node",
      "args": ["mcp/farm-management/dist/index.js"],
      "env": {
        "GATEWAY_URL": "http://localhost:3000/graphql",
        "MCP_JWT_TOKEN": "eyJhbGciOiJIUzI1NiIs..."
      }
    }
  }
}
```

Veya `tsx` ile doğrudan:

```json
{
  "mcpServers": {
    "farm-intelligence": {
      "command": "npx",
      "args": ["tsx", "mcp/farm-management/src/index.ts"],
      "env": {
        "GATEWAY_URL": "http://localhost:3000/graphql",
        "MCP_JWT_TOKEN": "eyJhbGciOiJIUzI1NiIs..."
      }
    }
  }
}
```

---

## 4. Tool Katalogu

### 4.1 Zeka Tool'ları (4 adet)

#### `detect_anomalies`

Çiftlik verilerinde 9 anomali türünü tarar. Opsiyonel olarak kötü döngü (vicious cycle) analizi yapar.

| Parametre | Tip | Zorunlu | Varsayılan | Açıklama |
|-----------|-----|---------|------------|----------|
| `scope` | `'tank' \| 'batch' \| 'site' \| 'farm'` | Evet | — | Analiz kapsamı |
| `entityId` | `string` | scope=farm hariç | — | Varlık UUID |
| `timeWindowDays` | `integer` | Hayır | `7` | Veri penceresi (gün) |
| `severityThreshold` | `'low' \| 'medium' \| 'high'` | Hayır | `'low'` | Minimum raporlama seviyesi |
| `includeViciousCycles` | `boolean` | Hayır | `true` | Kötü döngü analizi dahil mi? |

**Çıktı**: Anomali listesi (severity, domain, açıklama), kötü döngüler, özet istatistikler, güvenilirlik raporu.

---

#### `correlate_domains`

Farklı domain'lerdeki metriklerin istatistiksel ilişkisini analiz eder. 8 bilinen korelasyon çifti otomatik test edilir.

| Parametre | Tip | Zorunlu | Varsayılan | Açıklama |
|-----------|-----|---------|------------|----------|
| `entityId` | `string` | Evet | — | Tank, Batch veya Site UUID |
| `entityType` | `'tank' \| 'batch' \| 'site'` | Evet | — | Varlık tipi |
| `timeWindowDays` | `integer` | Hayır | `7` | Veri penceresi (gün) |
| `domains` | `string[]` | Hayır | tümü | Analiz edilecek domain filtresi |
| `includePositive` | `boolean` | Hayır | `true` | Pozitif korelasyonlar dahil mi? |

**Çıktı**: Korelasyon listesi (Pearson r, p-value, zaman gecikmesi, güven aralığı, bilinen ilişki açıklaması), özet, güvenilirlik raporu.

---

#### `analyze_root_cause`

Bir anomali olayının kök nedenini analiz eder. Lookback penceresi içindeki tüm domain'leri tarar, her potansiyel nedeni skorlar ve sıralar.

| Parametre | Tip | Zorunlu | Varsayılan | Açıklama |
|-----------|-----|---------|------------|----------|
| `eventType` | `'mortality_spike' \| 'growth_slowdown' \| 'fcr_degradation' \| 'water_quality_alert' \| 'health_event' \| 'appetite_loss' \| 'custom'` | Evet | — | Olay tipi |
| `entityId` | `string` | Evet | — | Tank veya Batch UUID |
| `entityType` | `'tank' \| 'batch'` | Evet | — | Varlık tipi |
| `eventDate` | `string` (ISO 8601) | Hayır | şimdi | Olay tarihi |
| `lookbackHours` | `number` | Hayır | `72` | Geriye bakış penceresi (saat) |
| `includeCascadePrediction` | `boolean` | Hayır | `true` | Kaskad tahmini dahil mi? |

**Skor formülü**:
```
totalScore = timeProximityScore × 0.40
           + deviationScore     × 0.35
           + knownCausalityBonus × 0.25
```

**Çıktı**: Skorlanmış potansiyel nedenler listesi (en olası ilk), kaskad tahmini, veri boşlukları, güvenilirlik raporu.

---

#### `assess_risk`

7 risk faktörünü ağırlıklı ortalama ile birleştirerek 0-100 arası bileşke risk skoru hesaplar.

| Parametre | Tip | Zorunlu | Varsayılan | Açıklama |
|-----------|-----|---------|------------|----------|
| `scope` | `'tank' \| 'batch' \| 'site' \| 'farm'` | Evet | — | Değerlendirme kapsamı |
| `entityId` | `string` | scope=farm hariç | — | Varlık UUID |
| `includeProjection` | `boolean` | Hayır | `false` | 24h/7d risk projeksiyonu |
| `includeOpportunities` | `boolean` | Hayır | `true` | Optimizasyon fırsatları |

**Risk ağırlıkları**:

| Faktör | Ağırlık | Açıklama |
|--------|---------|----------|
| mortalityTrend | 0.25 | Direkt ekonomik kayıp |
| waterQualityDeviation | 0.20 | Tüm sorunların kökeni |
| tankDensity | 0.15 | WQ ve stres etkiler |
| activeHealthEvents | 0.15 | Mevcut hastalık/tedavi |
| fcrDeviation | 0.10 | Ekonomik verimlilik |
| overdueMaintenance | 0.10 | Gelecek risk potansiyeli |
| weatherRisk | 0.05 | Çevresel, kontrol dışı |

**Risk seviyeleri**: 0-25 normal, 26-50 dikkat, 51-75 uyarı, 76-100 kritik.

**Çıktı**: Genel risk skoru, faktör detayları, uyarılar, optimizasyon fırsatları, projeksiyon (opsiyonel), güvenilirlik raporu.

---

### 4.2 Matematik Tool'ları (5 adet)

Bu tool'lar **saf hesaplama** yapar — GraphQL bağlantısı gerektirmez, offline çalışır.

#### `predict_feeding_impact`

Belirli bir yem miktarının su kalitesi üzerindeki etkisini tahmin eder.

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `feedKg` | `number` | Evet | Verilecek yem miktarı (kg) |
| `biomassKg` | `number` | Evet | Mevcut biyokütle (kg) |
| `tankVolumeM3` | `number` | Evet | Tank hacmi (m³) |
| `temperature` | `number` | Evet | Su sıcaklığı (°C) |
| `currentPH` | `number` | Evet | Mevcut pH |
| `salinity` | `number` | Hayır | Tuzluluk (ppt), varsayılan: 0 |
| `currentTANmgL` | `number` | Hayır | Mevcut TAN (mg/L) |
| `hasBiofilter` | `boolean` | Hayır | Biyofiltre var mı? |
| `speciesCode` | `string` | Hayır | Tür kodu: salmon, tilapia, trout, seabass, seabream |

**Çıktı**: TAN üretimi, NH3 toksisite riski (kritik pH, güvenlik marjı), oksijen talebi (balık + biyofiltre + organik), yemleme oranı değerlendirmesi.

---

#### `calculate_oxygen_budget`

Oksijen bütçesi hesaplar: DO doygunluk, tüketim hızı, kritik süre tahmini.

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `temperature` | `number` | Evet | Su sıcaklığı (°C) |
| `biomassKg` | `number` | Evet | Tank biyokütlesi (kg) |
| `dailyFeedKg` | `number` | Evet | Günlük yem (kg) |
| `tankVolumeM3` | `number` | Evet | Tank hacmi (m³) |
| `currentDO` | `number` | Evet | Mevcut DO (mg/L) |
| `salinity` | `number` | Hayır | Tuzluluk (ppt) |
| `hasBiofilter` | `boolean` | Hayır | Biyofiltre var mı? |
| `waterFlowM3h` | `number` | Hayır | Su değişim debisi (m³/saat) |

**Çıktı**: DO doygunluk (Weiss 1970), doygunluk yüzdesi, O2 tüketim analizi, havalandırma durduğunda kritik süre (saat), sıcaklık etkisi, su değişim analizi, denge durumu.

---

#### `calculate_growth_metrics`

5 modlu büyüme hesaplayıcısı.

| Mod | Açıklama | Zorunlu Parametreler |
|-----|----------|---------------------|
| `sgr` | Spesifik Büyüme Oranı | `initialWeightG`, `finalWeightG`, `days` |
| `fcr` | Yem Dönüşüm Oranı | `feedConsumedKg`, `biomassGainKg` |
| `biomass` | Biyokütle ve yoğunluk | `quantity`, `avgWeightG` |
| `projection` | Büyüme projeksiyonu (günlük simülasyon) | `currentWeightG`, `currentQuantity`, `sgr` + (`targetWeightG` veya `projectionDays`) |
| `transfer_density` | Tank transfer yoğunluk analizi | `sourceTank`, `destTank`, `transferBiomassKg` |

**Çıktı**: Moda göre — SGR (%/gün) ve performans değerlendirmesi, FCR ve endüstri karşılaştırması, biyokütle/yoğunluk hesabı, haftalık projeksiyon verileri ve hasat tarihi tahmini, transfer fizibilite analizi.

---

#### `calculate_carrying_capacity`

Tank taşıma kapasitesini yoğunluk ve oksijen kısıtlarına göre hesaplar.

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `tankVolumeM3` | `number` | Evet | Tank hacmi (m³) |
| `temperature` | `number` | Evet | Su sıcaklığı (°C) |
| `avgFishWeightG` | `number` | Evet | Ortalama balık ağırlığı (gram) |
| `salinity` | `number` | Hayır | Tuzluluk (ppt) |
| `minDOMgL` | `number` | Hayır | Min. güvenli DO (mg/L), varsayılan: 5 |
| `maxDensityKgM3` | `number` | Hayır | Maks. yoğunluk (kg/m³), varsayılan: 20 |
| `dailyFeedingRatePercent` | `number` | Hayır | Yemleme oranı (%BW), varsayılan: 2 |
| `hasBiofilter` | `boolean` | Hayır | Biyofiltre var mı? |

**Çıktı**: Maksimum güvenli biyokütle (kg), maksimum balık sayısı, sınırlayıcı faktör (yoğunluk veya oksijen), her iki kısıt detayı, öneriler.

---

#### `calculate_water_chemistry`

`@platform/aquaculture-engines` kütüphanesini sarmalayan 6 modlu su kimyası hesaplayıcısı.

| Mod | Açıklama | Parametreler (`params` objesi) |
|-----|----------|-------------------------------|
| `ammonia_toxicity` | NH3/NH4 dengesi, toksik eşikler | `tan`, `ph`, `temperature`, `salinity?`, `nh3Limit?` |
| `carbonate_chemistry` | DIC, karbonat fraksiyonları, tampon kapasitesi | `alkalinity`, `ph`, `temperature`, `salinity?` |
| `co2_level` | CO2 konsantrasyonu, kritik pH | `alkalinity`, `ph`, `temperature`, `salinity?`, `co2CriticalMgL?` |
| `h2s_toxicity` | H2S toksisitesi, kritik pH | `totalSulfide`, `ph`, `temperature`, `salinity?`, `h2sLimitUgL?` |
| `reagent_dosing` | Kimyasal dozlama hesabı | `currentAlk`, `currentPH`, `targetAlk`, `targetPH`, `volumeM3` |
| `dosing_simulation` | Kimyasal ekleme simülasyonu | `currentAlk`, `currentPH`, `volumeM3`, `reagentName`, `doseKg`, `temperature?`, `salinity?` |

**Çıktı**: Moda göre — NH3 fraksiyonu ve güvenlik durumu, DIC/CO2/tampon kapasitesi, H2S toksisitesi, dozlama seçenekleri, simülasyon öncesi/sonrası karşılaştırma.

---

### 4.3 Context Tool'ları (2 adet)

#### `get_farm_snapshot`

Tüm çiftliğin anlık fotoğrafını tek sorguda birleştirir.

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `siteId` | `string` | Hayır | Belirli bir site filtresi |
| `includeTasks` | `boolean` | Hayır | Bugünün görevlerini dahil et |
| `includeWeather` | `boolean` | Hayır | Hava durumunu dahil et |

**Çıktı**: Site'lar, tanklar, aktif batch'ler, yemleme planı, sağlık olayları, geciken bakımlar, hava durumu, bugünün görevleri.

---

#### `get_entity_timeline`

Bir tank veya batch için tüm domain'lerden gelen olayları birleşik zaman çizelgesinde sunar.

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `entityId` | `string` | Evet | Tank veya Batch UUID |
| `entityType` | `'tank' \| 'batch'` | Evet | Varlık tipi |
| `days` | `integer` | Hayır | Zaman penceresi (gün), varsayılan: 14 |
| `domains` | `string[]` | Hayır | Domain filtresi |

**Desteklenen domain'ler**: mortality, feeding, growth, water_quality, health, maintenance, weather.

**Çıktı**: Kronolojik sıralı birleşik olay listesi (her olayda: timestamp, domain, event type, detaylar).

---

## 5. Prompt'lar

MCP prompt'ları, AI'ya belirli görevleri yapması için hazır talimatlar sunar. Kullanıcı bir prompt seçtiğinde, AI otomatik olarak gerekli tool'ları sırayla çağırır.

### 5.1 `daily_operations` — Günlük Operasyon Brifing

**Amaç**: "Bugün çiftlikte ne yapmalıyım?" sorusuna kapsamlı cevap üretir.

**Argümanlar**:
| Argüman | Zorunlu | Açıklama |
|---------|---------|----------|
| `siteId` | Hayır | Belirli bir site için brifing (boşsa tüm çiftlik) |

**Tool zinciri**:
1. `get_farm_snapshot` → genel durum
2. `detect_anomalies(scope: 'farm')` → anomali taraması
3. `assess_risk(scope: 'farm', includeOpportunities: true)` → risk değerlendirmesi

**Çıktı formatı**:
- GENEL DURUM: Site/tank/batch sayıları
- BUGUNKU GOREVLER: Planlanan ve geciken görevler
- ANOMALİLER: Tespit edilen sorunlar (kritik önce)
- RİSK DEĞERLENDİRMESİ: Skor ve faktörler
- OPTİMİZASYON FIRSATLARI: İyileştirme önerileri
- ÖNCELİKLİ AKSİYONLAR: En önemli 3-5 aksiyon

### 5.2 `batch_review` — Batch Detaylı İnceleme

**Amaç**: Belirli bir batch'in 360 derece analizi.

**Argümanlar**:
| Argüman | Zorunlu | Açıklama |
|---------|---------|----------|
| `batchId` | Evet | İncelenecek batch UUID |
| `days` | Hayır | İnceleme penceresi (gün), varsayılan: 14 |

**Tool zinciri**:
1. `get_entity_timeline(batch)` → olay geçmişi
2. `detect_anomalies(scope: 'batch')` → anomali tespiti
3. `correlate_domains(batch)` → cross-domain korelasyon
4. `assess_risk(scope: 'batch')` → risk değerlendirmesi

**Çıktı formatı**:
- BATCH BİLGİLERİ: Tür, stocking tarihi, ağırlık/miktar/biyokütle
- OLAY GEÇMİŞİ: Kronolojik özet
- ANOMALİLER: Tespit edilen sorunlar
- KORELASYONLAR: Domain'ler arası ilişkiler
- RİSK DEĞERLENDİRMESİ: Skor ve faktörler
- BÜYÜME ANALİZİ: SGR trend, FCR, mortalite oranı
- ÖNERİLER: Kısa ve uzun vadeli aksiyon önerileri

---

## 6. Bilgi Tabanı (Knowledge Base)

`src/knowledge/` altındaki dosyalar, akvakültür bilimsel literatürüne dayalı kurallar ve eşikler içerir. Analytics motoru bu bilgileri anomali tespiti, korelasyon analizi ve kaskad tahmininde kullanır.

### 6.1 `thresholds.ts` — Tür Bazlı Optimal Aralıklar

**7 tür** için su kalitesi, yoğunluk ve performans eşikleri:

| Tür | Sıcaklık (°C) | DO min (mg/L) | NH3 max (mg/L) | Max Yoğunluk (kg/m³) | Hedef FCR |
|-----|---------------|---------------|-----------------|----------------------|-----------|
| Atlantic Salmon | 8-14 (opt: 12) | 6 | 0.02 | 25 | 1.2 |
| Rainbow Trout | 10-18 (opt: 14) | 6 | 0.02 | 30 | 1.1 |
| Sea Bass | 18-26 (opt: 22) | 5 | 0.05 | 20 | 1.8 |
| Sea Bream | 18-26 (opt: 23) | 5 | 0.05 | 18 | 2.0 |
| Tilapia | 25-30 (opt: 28) | 3 | 0.10 | 20 | 1.6 |
| Catfish | 24-30 (opt: 27) | 3 | 0.05 | 15 | 1.5 |
| Shrimp | 26-32 (opt: 29) | 4 | 0.10 | 5 | 1.8 |

Her tür icin pH, nitrit, nitrat, tuzluluk, CO2, SGR degerleri de tanimlidir. Tur bilgisi bulunamazsa guvenli "default" esikler kullanilir.

### 6.2 `correlation-map.ts` — 12 Bilinen Korelasyon

**7 risk korelasyonu** (olumsuz sonuclar):

| ID | İlişki | Yön | Lag (saat) | Güç |
|----|--------|-----|------------|-----|
| COR-001 | Aşırı besleme → NH3 artışı | + | 4 | Güçlü |
| COR-002 | Düşük DO → Mortalite | - | 4 | Güçlü |
| COR-003 | NH3 artışı → SGR düşüşü | - | 24 | Güçlü |
| COR-004 | Yüksek yoğunluk → WQ bozulması | - | 168 | Orta |
| COR-005 | pH artışı → NH3 toksisitesi | + | 0 | Güçlü |
| COR-006 | Fırtına → DO düşüşü | - | 3 | Orta |
| COR-007 | Ekipman arızası → WQ bozulması | - | 2 | Güçlü |

**5 optimizasyon korelasyonu** (iyileştirme fırsatları):

| ID | İlişki | Yön | Lag (saat) | Güç |
|----|--------|-----|------------|-----|
| COR-008 | Optimal DO → SGR artışı | + | 48 | Güçlü |
| COR-009 | Optimal fotoperiod → SGR artışı | + | 336 | Orta |
| COR-010 | Besleme frekansı → FCR iyileşmesi | - | 72 | Orta |
| COR-011 | Temizleyici balık → Stres azalması | - | 336 | Zayıf |
| COR-012 | Optimal sıcaklık → Metabolizma artışı | + | 36 | Güçlü |

### 6.3 `cascade-chains.ts` — 5 Kaskad Zinciri

Her zincir bir tetikleyici olay ile başlar ve zamanla gerçekleşecek domino etkilerini tanımlar:

| ID | Tetikleyici | Adım Sayısı | Kritik Süre |
|----|-------------|-------------|-------------|
| CASCADE-001 | Biyofiltre stresi | 5 adım | 6h → 7d |
| CASCADE-002 | Aeratör arızası | 3 adım | 1h → 6h |
| CASCADE-003 | Sıcaklık spike | 5 adım | 0h → 3d |
| CASCADE-004 | Aşırı besleme | 4 adım | 2h → 24h |
| CASCADE-005 | Yüksek yoğunluk | 4 adım | 7d → 30d |

Her adımda: gecikme süresi, etki açıklaması, şiddet seviyesi (low → critical) ve gerçekleşme olasılığı (0-1) belirtilir. Her zincir için kırma stratejileri ve aciliyet seviyeleri tanımlıdır.

### 6.4 `vicious-cycles.ts` — 3 Kötü Döngü Kalıbı

Kaskad zincirlerinden farklı olarak, kötü döngüler **dairesel** geri bildirim döngüleridir — her tur sorunu katlar:

| ID | Döngü | Aşamalar | Etkilenen Domain'ler |
|----|-------|----------|---------------------|
| `feed-wq-spiral` | Besleme ↔ Su Kalitesi Spirali | early (24h) → active (6h) → critical (ACİL) | feeding, water_quality, growth |
| `density-stress-spiral` | Yoğunluk ↔ Stres Spirali | early (1 hafta) → active (3 gün) → critical (24h) | stocking, growth, health, feeding |
| `temperature-oxygen-crisis` | Sıcaklık ↔ Oksijen Krizi | early (12-24h) → active (4-6h) → critical (dakikalar) | water_quality, health, mortality, feeding |

Her döngü için: tetikleme koşulları, 3 aşamalı şiddet modeli, müdahale penceresi ve döngüyü kırma stratejileri tanımlıdır.

---

## 7. Güvenilirlik Çerçevesi

Tüm zeka tool çıktılarına `reliability` nesnesi eklenir. Bu, sonuçların ne kadar güvenilir olduğunu şeffaf olarak raporlar.

### 7.1 Güven Skoru Bileşenleri

| Bileşen | Ağırlık | Açıklama |
|---------|---------|----------|
| `dataCompleteness` | 0.35 | Beklenen veri noktalarının ne kadarı mevcut? |
| `dataFreshness` | 0.25 | En son veri ne zaman geldi? (bayatlık kontrolü) |
| `sampleSize` | 0.25 | İstatistiksel anlamlılık için yeterli örneklem var mı? |
| `sourceCount` | 0.15 | Kaç farklı domain'den veri geldi? |

### 7.2 Güven Seviyeleri

| Skor | Seviye | Anlam |
|------|--------|-------|
| 0.8 - 1.0 | Yüksek | Sonuçlar güvenilir, veriler tam ve taze |
| 0.5 - 0.8 | Orta | Sonuçlar kullanılabilir ama bazı boşluklar var |
| 0.0 - 0.5 | Düşük | Dikkatli yorumlanmalı, veri eksikliği belirgin |

### 7.3 Otomatik Uyarılar (Caveats)

Düşük güven durumunda otomatik uyarı mesajları üretilir:

- Veri tamamlılığı <%50 ise → "Eksik veri: [domain] verisi yetersiz"
- Veri 6+ saat eski ise → "Bayat veri: [domain] verisi güncel değil"
- Örneklem < 10 ise → "Küçük örneklem: istatistiksel sonuçlar güvensiz"
- Tek domain verisi ise → "Sınırlı perspektif: sadece [domain] verisi mevcut"

---

## 8. Proje Yapısı

```
mcp/farm-management/
├── package.json                 # Bağımlılıklar ve script'ler
├── tsconfig.json                # TypeScript yapılandırması
├── .env.example                 # Ortam değişkenleri şablonu
├── README.md                    # Bu dosya
│
└── src/
    ├── index.ts                 # Giriş noktası — transport kurulumu
    ├── server.ts                # MCP server oluşturma, tool/prompt kayıt
    ├── config.ts                # Ortam değişkenleri yapılandırması
    │
    ├── auth/
    │   └── session-context.ts   # JWT decode → session bilgileri
    │
    ├── graphql/
    │   ├── client.ts            # GraphQL HTTP client (fetch + JWT header)
    │   └── queries/
    │       ├── batches.ts       # Batch sorguları
    │       ├── feeding.ts       # Yemleme sorguları
    │       ├── growth.ts        # Büyüme ölçüm sorguları
    │       ├── health.ts        # Sağlık olayı sorguları
    │       ├── maintenance.ts   # Bakım/iş emri sorguları
    │       ├── sites.ts         # Site sorguları
    │       ├── tanks.ts         # Tank sorguları
    │       ├── tasks.ts         # Görev sorguları
    │       ├── water-quality.ts # Su kalitesi sorguları
    │       └── weather.ts       # Hava durumu sorguları
    │
    ├── tools/
    │   ├── index.ts             # Tool kayıt orkestratörü (11 tool)
    │   ├── intelligence/
    │   │   ├── detect-anomalies.ts     # Anomali tespiti
    │   │   ├── correlate-domains.ts    # Cross-domain korelasyon
    │   │   ├── analyze-root-cause.ts   # Kök neden analizi
    │   │   └── assess-risk.ts          # Risk değerlendirmesi
    │   ├── math/
    │   │   ├── predict-feeding-impact.ts      # Yem etkisi tahmin
    │   │   ├── calculate-oxygen-budget.ts     # Oksijen bütçesi
    │   │   ├── calculate-growth-metrics.ts    # Büyüme metrikleri (5 mod)
    │   │   ├── calculate-carrying-capacity.ts # Taşıma kapasitesi
    │   │   └── calculate-water-chemistry.ts   # Su kimyası (6 mod)
    │   └── context/
    │       ├── get-farm-snapshot.ts    # Çiftlik anlık görüntüsü
    │       └── get-entity-timeline.ts  # Varlık zaman çizelgesi
    │
    ├── prompts/
    │   ├── index.ts             # Prompt re-export
    │   ├── daily-operations.ts  # Günlük operasyon brifing
    │   └── batch-review.ts      # Batch detaylı inceleme
    │
    ├── analytics/
    │   ├── anomaly-detector.ts  # 9 anomali türü tespit motoru
    │   ├── correlator.ts        # Pearson korelasyon + optimal lag
    │   ├── cascade-predictor.ts # Kaskad etki tahmin motoru
    │   ├── cycle-detector.ts    # Kötü döngü tespit motoru
    │   ├── risk-scorer.ts       # 7 faktörlü risk hesaplama
    │   ├── optimizer.ts         # Optimizasyon fırsatı tespiti
    │   └── reliability.ts       # Güvenilirlik çerçevesi
    │
    ├── knowledge/
    │   ├── thresholds.ts        # 7 tür için optimal aralıklar
    │   ├── correlation-map.ts   # 12 bilinen korelasyon
    │   ├── cascade-chains.ts    # 5 kaskad zinciri
    │   └── vicious-cycles.ts    # 3 kötü döngü kalıbı
    │
    └── utils/
        ├── error-handler.ts     # MCP uyumlu hata işleme
        ├── formatters.ts        # Çıktı formatlama yardımcıları
        ├── logger.ts            # stderr tabanlı logger (stdout MCP için ayrılmış)
        └── stats.ts             # İstatistik yardımcıları (z-score, ortalama vb.)
```

---

## 9. Geliştirme Rehberi

### 9.1 Yeni Tool Ekleme

1. **Tool dosyası oluşturun** — ilgili kategori klasörüne (`tools/math/`, `tools/context/` veya `tools/intelligence/`):

```typescript
// src/tools/math/calculate-new-metric.ts
import { z } from 'zod';

export const inputSchema = z.object({
  param1: z.number().positive().describe('Parametre açıklaması'),
});

export const definition = {
  name: 'calculate_new_metric',
  description: 'Tool açıklaması — Claude bu metni okuyarak tool\'u seçer',
  inputSchema: {
    type: 'object' as const,
    properties: {
      param1: { type: 'number', description: 'Parametre açıklaması' },
    },
    required: ['param1'],
  },
};

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

export async function handler(params: z.infer<typeof inputSchema>): Promise<ToolResult> {
  const input = inputSchema.parse(params);
  const result = { /* hesaplama */ };
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}
```

2. **`tools/index.ts`'e import ekleyin**:

```typescript
import { definition as newMetricDef, handler as newMetricHandler } from './math/calculate-new-metric.js';
```

3. **`allTools` dizisine ekleyin**:

```typescript
{ def: newMetricDef, handler: newMetricHandler, needsClient: false },
```

> `needsClient: false` → Math tool (offline). `needsClient: true` → GraphQL gerektirir.

### 9.2 Yeni Korelasyon Ekleme

`src/knowledge/correlation-map.ts` dosyasındaki `KNOWN_CORRELATIONS` dizisine yeni eleman ekleyin:

```typescript
{
  id: 'COR-013',
  domainA: 'water_quality',
  metricA: 'turbidity',
  domainB: 'growth',
  metricB: 'sgr',
  expectedDirection: 'negative',
  category: 'risk',
  mechanism: 'Yüksek bulanıklık → solungaç tıkanması → oksijen alımı düşer → büyüme yavaşlar.',
  typicalLagHours: 48,
  strength: 'moderate',
  referenceNote: 'Boyd (2015) Ch. 6: "Turbidity effects on fish gill function."',
},
```

### 9.3 Yeni Kaskad Zinciri Ekleme

`src/knowledge/cascade-chains.ts` dosyasındaki `KNOWN_CASCADES` dizisine ekleyin:

```typescript
{
  id: 'CASCADE-006',
  trigger: 'new_trigger',
  triggerDescription: 'Tetikleyici olayın Türkçe açıklaması',
  domain: 'affected_domain',
  chain: [
    {
      delay: '4h', delayHours: 4,
      effect: 'first_effect',
      impact: 'medium',
      description: 'İlk etkinin açıklaması',
      probability: 0.85,
    },
    // ... daha fazla adım (delayHours artan sırada)
  ],
  recommendedActions: [
    {
      action: 'Müdahale açıklaması',
      urgency: 'immediate', // 'immediate' | 'within_6h' | 'within_24h' | 'within_week'
      expectedOutcome: 'Beklenen sonuç',
    },
  ],
},
```

### 9.4 Yeni Tür Threshold'u Ekleme

`src/knowledge/thresholds.ts` dosyasındaki `DEFAULT_THRESHOLDS` map'ine ekleyin:

```typescript
'european_eel': {
  temperature: { min: 20, max: 28, optimal: 24, criticalMin: 8, criticalMax: 32 },
  ph: { min: 6.5, max: 8.5, optimal: 7.5 },
  dissolvedOxygen: { min: 4, optimal: 6, critical: 2 },
  ammonia: { max: 0.05, warning: 0.025 },
  nitrite: { max: 1.0, warning: 0.5 },
  nitrate: { max: 200, warning: 100 },
  maxDensity: 40,       // kg/m³ — yılan balığı yüksek yoğunluğa toleranslı
  optimalDensity: 30,
  targetFCR: 1.4,
  targetSGR: 1.0,
},
```

> Anahtar formatı: lowercase, boşluk yerine underscore. `getThresholds('European Eel')` otomatik olarak normalize eder.

---

## 10. Kullanım Senaryoları

### "Bugün çiftlikte ne yapmalıyım?"

`daily_operations` prompt'unu kullanın:

```
Günlük brifingimi hazırla.
```

AI otomatik olarak `get_farm_snapshot → detect_anomalies → assess_risk` zincirini çalıştırır ve Türkçe brifing hazırlar.

---

### "Tank-3'te amonyak neden yükseldi?"

`analyze_root_cause` tool'unu kullanın:

```
Tank-3'te amonyak neden yükseldi? Son 48 saatte ne oldu?
```

AI, `analyze_root_cause(eventType: 'water_quality_alert', entityId: 'tank-3-uuid', entityType: 'tank', lookbackHours: 48)` çağrısı yapar. Sonuç: skorlanmış potansiyel nedenler (aşırı yemleme, biyofiltre stresi, pH kayması vb.) ve kaskad tahminleri.

---

### "Bu batch'in durumu ne?"

`batch_review` prompt'unu kullanın:

```
Batch B-2024-042 için detaylı inceleme yap.
```

AI, 4 aşamalı analiz zincirini çalıştırır (timeline → anomaliler → korelasyonlar → risk) ve kapsamlı batch raporu hazırlar.

---

### "Hasat zamanlaması ne olmalı?"

`calculate_growth_metrics` tool'unu `projection` modunda kullanın:

```
Mevcut ağırlık 350g, 10.000 adet, SGR %1.2, hedef 500g. Hasat ne zaman?
```

AI, `calculate_growth_metrics(mode: 'projection', currentWeightG: 350, currentQuantity: 10000, sgr: 1.2, targetWeightG: 500)` çağrısı yapar. Sonuç: tahmini hasat günü, haftalık projeksiyon verileri, toplam yem tüketimi, hayatta kalma oranı.

---

### "Bu yemi versem su kalitesi ne olur?"

`predict_feeding_impact` tool'unu kullanın:

```
50 kg yem vermek istiyorum. Tank 100 m³, 2000 kg balık, su 22°C, pH 7.8.
```

AI, TAN üretimi, NH3 toksisite riski, oksijen talebi ve yemleme oranı değerlendirmesi hesaplar. Yemleme kararından ONCE riskleri gösterir.

---

### "Tank kapasitesini hesapla"

`calculate_carrying_capacity` tool'unu kullanın:

```
50 m³ tank, 20°C su, ortalama 200g alabalık. Kaç balık koyabilirim?
```

AI, yoğunluk ve oksijen kısıtlarına göre maksimum güvenli biyokütle ve balık sayısını hesaplar, sınırlayıcı faktörü belirtir.

---

## 11. Enterprise Review Geçmişi

### 11.1 Tur 1 — 10 Uzman Review (Tamamlandı)

10 bağımsız uzman (MCP Protocol, TypeScript, Akuakültür, İstatistik, GraphQL, Güvenlik, Performans, Güvenilirlik, Mimari, Entegrasyon) eşzamanlı olarak kodu inceledi ve birbirleriyle tartıştı. Toplam **60+ bulgu** tespit edildi.

#### Uygulanan Kritik Düzeltmeler (6)

| # | Sorun | Dosya(lar) | Düzeltme |
|---|-------|-----------|----------|
| 1 | **Logger stdout kirlenmesi** — `console.info`/`console.debug` stdout'a yazarak MCP JSON-RPC akışını bozuyordu | `utils/logger.ts` | Tüm log seviyeleri `console.error` (stderr) kullanacak şekilde değiştirildi |
| 2 | **Weiss DO formülü birim hatası** — mL(STP)/L çıktısı mg/L olarak kullanılıyordu (%30 eksik hesaplama) | `calculate-oxygen-budget.ts`, `calculate-carrying-capacity.ts` | `× 1.42903` dönüşüm çarpanı eklendi |
| 3 | **TAN üretim katsayıları 3x düşük** — 0.009-0.011 yerine 0.025-0.032 olmalı (Timmons & Ebeling 2013) | `predict-feeding-impact.ts` | Katsayılar güncellendi: salmon 0.028, tilapia 0.032, default 0.030 |
| 4 | **WQ filter field uyumsuzluğu** — `startDate/endDate` gönderiliyordu ama resolver `fromDate/toDate` bekliyordu | `graphql/queries/water-quality.ts` | Field adları düzeltildi + limit parametresi (500) eklendi |
| 5 | **Sınırsız WQ sorguları** — limit olmadan 100K+ kayıt dönebiliyordu | `graphql/queries/water-quality.ts` | `limit: 500` default eklendi |
| 6 | **O(n²) quadratic complexity** — `detectAppetiteLoss` nested loop ile tüm WQ kayıtlarını tarıyordu | `analytics/anomaly-detector.ts` | `Map<tankId, WQ[]>` ile O(n+m) pre-indexing yapıldı |

#### Uygulanan Yüksek Öncelikli Düzeltmeler (7)

| # | Sorun | Dosya(lar) | Düzeltme |
|---|-------|-----------|----------|
| 7 | Dynamic import in catch block | `tools/index.ts` | Statik import'a çevrildi |
| 8 | tsconfig typeRoots + rootDir | `tsconfig.json` | `typeRoots` eklendi, `rootDir` kaldırılıp `types: ["node"]` eklendi |
| 9 | `errorResult()` missing `isError: true` | `calculate-growth-metrics.ts` | `isError: true` eklendi |
| 10 | Token expiry kontrolü eksik | `server.ts` | `isTokenExpired()` kontrolü eklendi |
| 11 | ZodError özel handling eksik | `utils/error-handler.ts` | ZodError duck-type tespiti ve detaylı mesaj eklendi |
| 12 | Prompt type literals | `prompts/*.ts` | `role: 'user' \| 'assistant'`, `type: 'text'` literal type'lar |
| 13 | `noUncheckedIndexedAccess` | `knowledge/thresholds.ts` | Non-null assertion (`!`) eklendi |

#### Uygulanan Orta Öncelikli Düzeltmeler (7)

| # | Sorun | Dosya(lar) | Düzeltme |
|---|-------|-----------|----------|
| 14 | Bilinmeyen prompt → generic Error | `server.ts` | `McpError(ErrorCode.InvalidRequest)` kullanıldı |
| 15 | scoreWaterQuality yanıltıcı yorum | `analytics/risk-scorer.ts` | "×50" → "×100" düzeltildi |
| 16 | batch_review days string→number | `prompts/batch-review.ts` | `parseInt(args.days)` eklendi |
| 17 | fetchTodaysTasks tek status | `graphql/queries/tasks.ts` | Multi-status: `['IN_PROGRESS', 'APPROVED', 'SCHEDULED']` |
| 18 | `round()` shared utility | `utils/formatters.ts` | `round()` fonksiyonu eklendi |
| 19 | erfc() tekrarı | `analytics/reliability.ts` | `erfcApprox` kaldırıldı → `erfc` from `utils/stats.js` |
| 20 | tank.status undefined koruması | `get-farm-snapshot.ts` | `(tank.status ?? '').toLowerCase()` |

#### Bilinen Sorunlar (Çözülmedi, İkinci Turda Ele Alınacak)

| Sorun | Öncelik | Açıklama |
|-------|---------|----------|
| Knowledge DRY ihlali | YÜKSEK | analytics/ ve knowledge/ katmanları arasında cascade, vicious cycle, correlation ve threshold verileri duplicate |
| calculate_water_chemistry params schema | YÜKSEK | `params: z.record(z.unknown())` — LLM hangi parametreleri göndereceğini bilemiyor |
| Tool çıktı boyutları | YÜKSEK | Pretty-print JSON + sınırsız diziler = büyük çiftliklerde 50K+ token |
| TANK_FIELDS over-fetching | ORTA | 40+ alan çekiliyor, tool'lar 5-6 alan kullanıyor |
| GraphQL query duplicate | ORTA | Tool zincirinde aynı sorgular 3 kez tekrarlanıyor |
| Test altyapısı yok | ORTA | Hiç test dosyası yok |
| Structured logging yok | DÜŞÜK | Logger plain text, JSON format değil |
| SSE transport | DÜŞÜK | Henüz implemente edilmemiş |

### 11.2 Tur 2 — Token Performansı Review (Devam Ediyor)

10 yeni uzman (Tool Strategist, Output Optimizer, Context Architect, LLM UX Expert, Knowledge Consolidator, API Designer, GraphQL Optimizer, Error Hardener, Caching Expert, Production Expert) MCP token performansına odaklı inceleme yapıyor.

#### Öne Çıkan Bulgular (şu ana kadar)

**Tool Tanımı Token Bütçesi (Mevcut):**
- 11 tool × ~200-450 token/tool = **~2,540 token** sadece tool tanımları için
- `calculate_growth_metrics` en büyük: ~450 token (18 flat property)

**Tool Çıktı Token Bütçesi (Mevcut):**
- Orta senaryo: ~13,500 token / büyük senaryo: ~48,500 token
- `get_entity_timeline`: Sınırsız — 30 gün + tüm domain = 100,000+ token mümkün!

**Önerilen Optimizasyonlar:**

| Strateji | Tahmini Tasarruf | Uygulama Zorluğu |
|----------|-----------------|------------------|
| Compact JSON (`JSON.stringify` without pretty-print) | %30-40 çıktı | Çok kolay |
| `detail: 'summary' \| 'full'` parametresi | %86-97 çıktı (summary modunda) | Orta |
| Dizi limitleri (timeline max 50, anomali max 20) | Değişken | Kolay |
| Tool konsolidasyonu (11 → 9 tool) | ~780 token tanım | Orta |
| Description İngilizce + kısaltma | ~400 token tanım | Kolay |
| Her çıktıya `insight` string alanı | LLM reasoning yükü azalır | Orta |
| Reliability raporu kompaktlaştırma | ~%10 çıktı | Kolay |
| Light GraphQL query variant'ları | %65 veri transferi | Orta |
| Request-scoped query memoization | Tool zincirinde duplicate query yok | Orta |

**Bileşik Etki Tahmini:**
- Mevcut (orta senaryo): ~2,540 (tanım) + ~13,500 (çıktı) = ~16,040 token
- Optimize (summary modu): ~1,760 (tanım) + ~1,900 (çıktı) = **~3,660 token (%77 azalma)**

#### Uygulanan P0 Optimizasyonlar (Tur 2)

Token optimizasyonu **kullanıcı faydasını etkilemeden** uygulandı — veri kaybı yok, sadece verimlilik artışı:

| # | Optimizasyon | Dosya Sayısı | Etki | Kullanıcı Etkisi |
|---|-------------|-------------|------|-----------------|
| 1 | Compact JSON (pretty-print kaldırma) | 11 dosya | %30-40 çıktı token tasarrufu | Sıfır — LLM JSON'u aynı şekilde işler |
| 2 | Tool annotations (readOnlyHint, idempotentHint) | 11 dosya | LLM daha hızlı tool seçimi | Pozitif — daha akıllı tool kullanımı |
| 3 | Dizi limitleri (timeline 50, anomali 20, batch 15) | 3 dosya | Sınırsız büyüme koruması | Korunuyor — `truncated` ve `totalEvents` alanları eklendi |
| 4 | 401/403 özel hata mesajları | 1 dosya | Daha açıklayıcı hata UX | Pozitif — actionable mesajlar |
| 5 | Partial GraphQL error handling | 1 dosya | Kısmi başarı döndürme | Pozitif — veri kaybı yerine kısmi sonuç |
| 6 | round() dedup (7 dosyadan kaldırıldı) | 7 dosya | Kod kalitesi | Sıfır — aynı fonksiyon |

#### Planlanan P1 Optimizasyonlar (Henüz Uygulanmadı)

| # | Optimizasyon | Tahmini Etki | Durum |
|---|-------------|-------------|-------|
| 1 | Dynamic Toolset (`listChanged: true`) | %57-85 tanım token | SDK desteği doğrulandı, uygulama bekliyor |
| 2 | `detail: 'summary' \| 'full'` parametresi | %86-97 çıktı (summary modunda) | Tasarlandı, varsayılan `full` kalacak |
| 3 | Insight string alanı (sunucu tarafı ön-analiz) | LLM reasoning yükü %40-60 azalma | Tasarlandı |
| 4 | Knowledge DRY konsolidasyonu | ~700 satır duplicate eliminasyonu | Detaylı plan hazır |
| 5 | Light GraphQL query variant'ları | %65 veri transferi | Tasarlandı |
| 6 | Request-scoped query caching | %60 query duplicate eliminasyonu | Detaylı strateji hazır |
| 7 | Description kısaltma + İngilizce | ~320 token tanım | Tasarlandı |
| 8 | ~~Math tool unit test'leri~~ | ~~Bilimsel doğruluk güvencesi~~ | **TAMAMLANDI** — 103 test, 5 dosya |

### 11.3 Tur 3 — P1 Implementasyon (10 Uzman Takımı, Tamamlandı)

10 implementasyon uzmanı paralel çalışarak aşağıdaki enterprise-grade iyileştirmeleri uyguladı:

#### Knowledge DRY Konsolidasyonu (4 task)

| Task | Dosya(lar) | Yapılan |
|------|-----------|---------|
| cascade-predictor DRY | analytics/cascade-predictor.ts + knowledge/cascade-chains.ts | ~350 satır inline veri silindi, 5 yeni cascade knowledge'a eklendi (toplam 10), tek kaynak |
| cycle-detector DRY | analytics/cycle-detector.ts + knowledge/vicious-cycles.ts | Inline cycles silindi, 2 eksik cycle (biofilter_collapse, maintenance_neglect) eklendi (toplam 5) |
| correlate-domains DRY | tools/intelligence/correlate-domains.ts + knowledge/correlation-map.ts | 8 inline pair silindi, COR-013..020 olarak knowledge'a eklendi (toplam 20 korelasyon) |
| threshold defaults DRY | anomaly-detector.ts, risk-scorer.ts, optimizer.ts, analyze-root-cause.ts | 4 dosyadaki inline threshold → `getThresholds()` import |

#### Shared Formül Modülü

- `utils/formulas.ts` oluşturuldu: `calcDOSaturation()` (Weiss 1970, ×1.42903 dahil) + `calcO2Consumption()`
- `calculate-oxygen-budget.ts` ve `calculate-carrying-capacity.ts`'den duplicate fonksiyonlar kaldırıldı

#### Token Performansı Optimizasyonları

| İyileştirme | Dosya(lar) | Etki |
|-------------|-----------|------|
| Light GraphQL query variant'ları | tanks.ts, sites.ts, maintenance.ts | `fetchTanksLight` (10 alan vs 40+), `fetchActiveSitesLight`, `fetchOverdueWorkOrdersLight` |
| Request-scoped query caching | graphql/client.ts | TTL bazlı cache (sites 15dk, tanks 5dk, WQ 60sn), max 100 entry, `clearCache()`, `getCacheStats()` |
| Insight strings — Intelligence | detect-anomalies, correlate-domains, analyze-root-cause, assess-risk | Her tool'a Türkçe `insight` string + reliability'ye `insight` özet |
| Insight strings — Context | get-farm-snapshot, get-entity-timeline | `briefingSummary` ve `periodSummary` alanları |
| TimelineResult interface fix | get-entity-timeline.ts | `totalEvents`, `truncated`, `showing` alanları eklendi |

#### Test Altyapısı

- **103 unit test**, 5 dosya, vitest ile:
  - `formulas.test.ts` (18 test) — Weiss DO referans değerleri (USGS)
  - `growth-metrics.test.ts` (14 test) — SGR, FCR, biomass
  - `feeding-impact.test.ts` (11 test) — TAN katsayıları, yemleme oranı
  - `carrying-capacity.test.ts` (6 test) — yoğunluk vs oksijen kısıt
  - `stats.test.ts` (54 test) — tüm istatistik fonksiyonlar
- `vitest.config.ts` oluşturuldu
- `npm test` komutu çalışır durumda
