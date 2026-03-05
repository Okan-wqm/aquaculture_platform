# SCADA Modulu Dokumantasyonu

> Son guncelleme: 2026-03-05

## Icerik

1. [Genel Mimari](#genel-mimari)
2. [SCADA Package Yapisi](#scada-package-yapisi)
3. [Edge Agent HMI Runtime](#edge-agent-hmi-runtime)
4. [Security Model](#security-model)
5. [API (GraphQL)](#api-graphql)
6. [Widget Turleri](#widget-turleri)
7. [Deploy Akisi](#deploy-akisi)
8. [Edge SQLite Veritabani](#edge-sqlite-veritabani)
9. [PWA ve Offline Destek](#pwa-ve-offline-destek)
10. [Son Audit Iyilestirmeleri](#son-audit-iyilestirmeleri)
11. [Dosya Yapisi](#dosya-yapisi)

---

## Genel Mimari

SCADA sistemi, bulut tarafindaki builder/yonetim arayuzunden edge device'lara kadar uctan uca bir HMI (Human-Machine Interface) cozumu sunar.

```
Frontend (React)             Backend (NestJS)             Edge Device (Rust)
+---------------------+      +---------------------+      +-------------------------------+
| ScadaPackageBuilder  |      | sensor-service       |      | suderra-agent                 |
|  - Widget Palette    | GQL  |  - ScadaPackageService| MQTT |  - scada_server (axum)        |
|  - Screen Canvas     |----->|  - ProcessResolver   |----->|  - scada_types (deserialize)  |
|  - Properties Panel  |      |  - ScadaPackage entity|      |  - scada_db (SQLite)          |
| ScadaPackageList     |      |  - MQTT publish      |      |  - alarm_engine               |
+---------------------+      +---------------------+      |  - trend_engine               |
                                                           |  - calibration_engine         |
                                                           +-------------------------------+
                                                                      |
                                                               WebSocket /ws/scada
                                                                      |
                                                           +-------------------------------+
                                                           | Kiosk Ekran (Chromium)        |
                                                           |  - scada-edge.html            |
                                                           |  - ReactFlow + Recharts       |
                                                           |  - Canli sensor verisi        |
                                                           +-------------------------------+
```

**Veri akisi:**

1. Kullanici, frontend SCADA Package Builder ile ekranlar, widgetlar, alarm kurallari, kontrol izinleri ve trend ayarlarini yapilandirir.
2. Paket GraphQL mutation ile backend'e kaydedilir (`createScadaPackage` / `updateScadaPackage`).
3. "Edge'e Deploy" komutu ile paket MQTT uzerinden edge device'a gonderilir (`deploy_scada_package`).
4. Edge agent paketi SQLite'a kaydeder, alarm/trend motorlarini baslatir.
5. Edge agent, axum HTTP sunucusu ile SCADA viewer HTML sayfasini sunar (kiosk modu).
6. Canli sensor verileri WebSocket (`/ws/scada`) uzerinden tarayiciya broadcast edilir.
7. Operatorler WebSocket uzerinden komut gonderebilir (toggle, setpoint, emergency stop).

---

## SCADA Package Yapisi

Bir SCADA paketi, edge device'da tam bir HMI deneyimi olusturmak icin gereken tum bilesenleri icerir.

### Ust Duzey Yapi

```json
{
  "meta": {
    "version": 1,
    "packageVersion": "1.0.0",
    "deployedBy": "user@example.com",
    "deployedAt": "2026-03-05T12:00:00Z",
    "edgeDeviceId": "uuid"
  },
  "screens": [ ... ],
  "alarmRules": [ ... ],
  "controlPermissions": { ... },
  "trendConfig": { ... }
}
```

### Screens (Ekranlar)

Her ekran bir `screenType` ve icindeki widgetlardan olusur.

| Alan | Tip | Aciklama |
|------|-----|----------|
| `id` | string | Benzersiz ekran ID |
| `name` | string | Ekran adi (orn: "Dashboard", "Proses Gorunumu") |
| `screenType` | enum | `dashboard`, `process`, `calibration`, `trends`, `alarms`, `control` |
| `isDefault` | bool | Varsayilan ekran mi |
| `icon` | string | Lucide ikon adi |
| `layout` | object | Grid layout (`type`, `cols`, `rows`) |
| `widgets` | array | Ekrandaki widgetlar |

### Alarm Rules (Alarm Kurallari)

```json
{
  "id": "alarm-1",
  "tag": "water_temp_1",
  "condition": ">",
  "value": 30.0,
  "severity": "critical",
  "message": "Su sicakligi cok yuksek!",
  "deadband": 0.5,
  "delay": 10
}
```

| Severity | Aciklama |
|----------|----------|
| `critical` | Kritik - acil mudahale gerekli |
| `high` | Yuksek oncelik |
| `warning` | Uyari |
| `info` | Bilgi |

Deadband ve delay ayarlari ile calkanti (flapping) onlenir.

### Control Permissions (Kontrol Izinleri)

Kontrol widgetlari icin uc katmanli guvenlik seviyesi:

```json
{
  "securityLevels": {
    "none": ["pump_1_speed"],
    "confirm": ["valve_2_open"],
    "pin": ["emergency_stop", "dosing_pump"]
  },
  "pinHash": "sha256-hash",
  "pinTimeout": 300,
  "emergencyStop": {
    "holdDuration": 3,
    "affectedTags": ["pump_1", "pump_2", "valve_1"],
    "resetRequiresPin": true
  }
}
```

### Trend Config (Trend Ayarlari)

```json
{
  "retentionDays": 7,
  "sampleIntervalSec": 10,
  "tags": ["water_temp_1", "ph_1", "do_1"]
}
```

---

## Edge Agent HMI Runtime

Edge agent Rust ile yazilmistir ve `scada-display` cargo feature'i ile derlenir.

### HTTP Endpoints

| Endpoint | Method | Aciklama |
|----------|--------|----------|
| `/` | GET | `/scada`'ya redirect |
| `/health` | GET | Health check JSON |
| `/scada` | GET | SCADA viewer HTML (kiosk modu) |
| `/scada/process` | GET | Deploy edilmis proses JSON |
| `/scada/tags` | GET | Tum ProcessImage taglari |
| `/scada/trends?tag=X&from=T1&to=T2` | GET | Trend verisi sorgusu |
| `/scada/alarms` | GET | Aktif alarmlar |
| `/scada/alarms/history?limit=N` | GET | Alarm gecmisi |
| `/libs/aquaculture-nodes.umd.js` | GET | Node/edge bilesenleri (SVG) |
| `/manifest.webmanifest` | GET | PWA manifest |
| `/icons/scada-{192,512}.svg` | GET | PWA ikonlari |
| `/sw.js` | GET | Service worker |
| `/ws/scada` | WebSocket | Canli veri + bidirectional komutlar |

### WebSocket Protokolu

**Server -> Client mesajlari:**
- Periyodik sensor verisi (equipment_data formatinda)
- Alarm bildirimleri
- Komut onay istemleri (confirm/PIN dialog)
- Trend verisi yanitlari

**Client -> Server mesajlari:**

| Mesaj Tipi | Aciklama |
|------------|----------|
| `command` | Tag'a deger yazma (orn: pompa ac/kapa) |
| `setpoint` | Setpoint degistirme (orn: hedef sicaklik) |
| `confirmResponse` | Onay dialog yaniti |
| `pinResponse` | PIN dogrulama yaniti |
| `alarmAck` | Alarm onaylama (acknowledge) |
| `calibrate` | Kalibrasyon islemi baslat/nokta ekle |
| `requestTrend` | Gecmis trend verisi iste |
| `emergencyStop` | Acil durdurma |
| `emergencyReset` | Acil durdurma sifirlama (PIN gerekli) |

### Canli Veri Akisi

```
io_poll_loop (her cycle)
  -> GPIO/Modbus/I2C/LoRa okuma
  -> ProcessImage guncelle
  -> MQTT io_data publish (cloud icin)
  -> build_scada_sensor_data()
      tagMappings'ten equipmentId -> tag_name eslemesi
      ProcessImage'dan tag degerlerini oku
      { equipmentId: [{ value, unit, status }] } formatina donustur
  -> broadcast::Sender ile WebSocket'e gonder
  -> scada-edge.html alir, ReactFlow re-render
```

### Persistent Storage

- Deploy edilen paket: `/var/lib/suderra/scada/process.json`
- SQLite veritabani: `/var/lib/suderra/scada/scada.db` (sifrelenmis)
- Agent yeniden basladiginda otomatik yuklenir

---

## Security Model

SCADA sistemi birden fazla guvenlik katmani icerir:

### 1. Kontrol Izin Seviyeleri

| Seviye | Aciklama | Kullanim |
|--------|----------|----------|
| `none` | Dogrudan erisim | Dusuk riskli okuma/yazma |
| `confirm` | "Emin misiniz?" onay dialog | Orta riskli islemler |
| `pin` | PIN kodu dogrulama | Yuksek riskli islemler |

### 2. PIN Oturum Yonetimi

- PIN dogrulandiktan sonra oturum suresi: **300 saniye** (5 dakika)
- Maksimum basarisiz deneme: **3 deneme**
- Kilitlenme suresi: **60 saniye** (3 basarisiz denemeden sonra)
- PIN hash'i SHA-256 ile saklanir

### 3. Acil Durdurma (Emergency Stop)

- Basili tutma suresi yapilandirilabilir (`holdDuration`)
- Etkilenen tag'lar tanimlanabilir (`affectedTags`)
- Sifirlama icin PIN gerekebilir (`resetRequiresPin: true`)

### 4. WebSocket Baglanti Korumasi

- Maksimum es zamanli WebSocket baglantisi: **16** (DoS korumasi)
- Broadcast kanal kapasitesi: **64**

### 5. MQTT Guvenlik

- Deploy komutu sunucu tarafinda olusturulur, istemci `commandId`, `command`, `timestamp` degerlerini override edemez
- Server-side meta alanlari (`version`, `deployedBy`, `deployedAt`) istemci verilerini gecer
- MQTT topic yapisi: `tenants/{tenantId}/devices/{deviceId}/commands`

### 6. Audit Log

Her kontrol islemi loglanir:
- IP adresi, aksiyon, tag adi, eski/yeni deger
- PIN kullanildi mi, basarili mi
- Hata mesaji (basarisizsa)
- Cloud'a sync durumu

---

## API (GraphQL)

### Queries

```graphql
# Tek paket getir
query ScadaPackage($id: ID!) {
  scadaPackage(id: $id) {
    id, name, description, version, processId, processName,
    packageData, status, createdBy, updatedBy, createdAt, updatedAt
  }
}

# Paket listesi (filtre + sayfalama)
query ScadaPackages(
  $filter: ScadaPackageFilterInput
  $pagination: ProcessPaginationInput
) {
  scadaPackages(filter: $filter, pagination: $pagination) {
    items { id, name, description, version, status, ... }
    total, offset, limit, hasMore
  }
}
```

**Filtre secenekleri:** `status` (DRAFT/PUBLISHED/ARCHIVED), `processId`, `searchTerm`

### Mutations

```graphql
# Yeni paket olustur
mutation CreateScadaPackage($input: CreateScadaPackageInput!) {
  createScadaPackage(input: $input) { id, name, version, status, ... }
}

# Paket guncelle (version otomatik artar)
mutation UpdateScadaPackage($id: ID!, $input: UpdateScadaPackageInput!) {
  updateScadaPackage(id: $id, input: $input) { id, name, version, ... }
}

# Paket sil (arsivle)
mutation DeleteScadaPackage($id: ID!) {
  deleteScadaPackage(id: $id) { success, message, deletedId }
}

# Edge device'a deploy et
mutation DeployScadaPackageToEdge($packageId: ID!, $deviceId: ID!) {
  deployScadaPackageToEdge(packageId: $packageId, deviceId: $deviceId) {
    success, message, packageId, deviceId
  }
}
```

**Yetki:** `TENANT_ADMIN`, `MODULE_MANAGER`

### Veritabani Entity

`scada_packages` tablosu (PostgreSQL):

| Kolon | Tip | Aciklama |
|-------|-----|----------|
| `id` | UUID (PK) | Birincil anahtar |
| `tenant_id` | UUID | Tenant ID |
| `name` | varchar | Paket adi |
| `description` | text | Aciklama |
| `version` | int | Otomatik artan surum |
| `process_id` | UUID | Bagli proses (opsiyonel) |
| `package_data` | jsonb | Tam SCADA paketi (screens, alarms, controls, trends) |
| `status` | enum | `draft`, `published`, `archived` |
| `created_by` | varchar | Olusturan kullanici |
| `updated_by` | varchar | Guncelleyen kullanici |
| `created_at` | timestamp | Olusturma tarihi |
| `updated_at` | timestamp | Guncelleme tarihi |

Index: `(tenant_id, status)` composite index + `tenant_id` tek basina index.

---

## Widget Turleri

### Gosterim Widgetlari

| Widget | Aciklama |
|--------|----------|
| `gauge` | Gostergeli deger (sure, sicaklik vb.) |
| `numericDisplay` | Sayi gosterimi |
| `statusIndicator` | Durum gostergesi (acik/kapali, hata) |
| `tankLevel` | Tank seviye gosterimi |
| `trendChart` | Trend grafigi (zaman serisi) |
| `alarmBanner` | Alarm banner (ust kisim) |
| `alarmList` | Alarm listesi (tablo) |

### Kontrol Widgetlari

| Widget | Aciklama |
|--------|----------|
| `toggleSwitch` | Acma/kapama anahtari |
| `slider` | Kayar deger ayarlama |
| `numericInput` | Sayi girisi |
| `pushButton` | Bas-birak butonu |
| `emergencyStop` | Acil durdurma butonu |

### Kalibrasyon Widgetlari

| Widget | Aciklama |
|--------|----------|
| `calibrationWizard` | Adim adim kalibrasyon sihirbazi |
| `calibrationHistory` | Kalibrasyon gecmisi |
| `calibrationStatus` | Kalibrasyon durumu |

### Bilesik Widgetlar

| Widget | Aciklama |
|--------|----------|
| `processView` | ReactFlow proses diyagrami (tam ekran) |

### Widget Pozisyonlama

Widgetlar grid layout uzerinde konumlandirilir:

```json
{
  "id": "widget-1",
  "widgetType": "gauge",
  "position": { "col": 0, "row": 0, "w": 3, "h": 2 },
  "config": {
    "tag": "water_temp_1",
    "label": "Su Sicakligi",
    "unit": "C",
    "min": 0,
    "max": 50,
    "warningThreshold": 28,
    "criticalThreshold": 32
  }
}
```

---

## Deploy Akisi

### 1. Paket Olusturma (Frontend)

```
ScadaPackageBuilderPage
  -> WidgetPalette'den widget surukle-birak
  -> ScreenCanvas uzerinde pozisyonla
  -> Alarm kurallari, kontrol izinleri, trend ayarlari yapilandir
  -> Zustand store (scadaPackageStore) ile state yonetimi
  -> toScadaPackageJSON() ile edge-uyumlu JSON olustur
  -> GraphQL mutation ile kaydet
```

### 2. Cloud Backend Deploy

```
deployScadaPackageToEdge mutation
  1. Paketi DB'den yukle
  2. Edge device'in online oldugunu dogrula
  3. packageData + server-side meta alanlarini birlestir
  4. MQTT publish: tenants/{tenantId}/devices/{deviceId}/commands
     {
       commandId: UUID,
       command: "deploy_scada_package",
       params: { ...packagePayload },
       timestamp: ISO-8601
     }
  5. Paket durumunu PUBLISHED olarak guncelle
```

### 3. Edge Device Alimi

```
Edge Agent (Rust)
  1. MQTT'den deploy_scada_package komutunu al
  2. ScadaPackage struct'ina deserialize et
  3. /var/lib/suderra/scada/process.json'a kaydet
  4. SQLite'a versiyon bilgisiyle kaydet
  5. Alarm engine'i yeni kurallarla guncelle
  6. Trend engine'i yeni tag listesiyle guncelle
  7. WebSocket istemcilerine "packageUpdated" bildirimi gonder
  8. Kiosk tarayici otomatik yenilenir
```

### 4. Package Boyut Limiti

- Maksimum `packageData` boyutu: **1 MB**
- Backend tarafinda `validatePackageDataSize()` ile kontrol edilir

---

## Edge SQLite Veritabani

Edge agent, trend verisi, alarm gecmisi, kalibrasyon kayitlari ve audit loglari icin sifrelenmis SQLite veritabani kullanir.

### Sifreleme

- Makine kimliginden (`machine_uid`) SHA-256 ile turetilen anahtar
- SQLCipher `PRAGMA key` ile veritabani sifreleme
- WAL modu, NORMAL sync, 5s busy timeout

### Tablolar

| Tablo | Aciklama |
|-------|----------|
| `trend_data` | Trend verisi (tag, timestamp, value, quality) - ROWID'siz, birlesik PK |
| `alarm_history` | Alarm kayitlari (trigger, ack, clear zamanlari) |
| `calibration_log` | Kalibrasyon gecmisi (slope, offset, R-kare) |
| `audit_log` | Kontrol islemleri audit logu |
| `scada_package` | Deploy edilen paket versiyonlari |

### Cloud Sync

- Her tabloda `synced` kolonu var
- `get_unsynced(table, limit)` ile sync edilmemis kayitlar cekilir
- `mark_synced(table, id)` ile sync edildikten sonra isaretlenir
- SQL injection korunmasi: tablo adi whitelist ile dogrulanir

---

## PWA ve Offline Destek

Edge SCADA viewer bir PWA (Progressive Web App) olarak calisir:

- **Manifest:** `/manifest.webmanifest` - standalone, landscape, SCADA temali
- **Service Worker:** Cache-first strateji ile offline destek
- **Oncache:** SCADA sayfasi, JS kutuphaneleri (React, ReactFlow, Recharts), stil dosyalari
- **Ikonlar:** SVG formatinda 192x192 ve 512x512

---

## Son Audit Iyilestirmeleri

Son commit'lerde (`f3ae3f3`, `f03dd18`, `118807b`, `9d0b68b`) yapilan iyilestirmeler:

### SCADA Package Builder UI (f03dd18)
- Yeni ScadaPackageBuilderPage: 3-panel layout (WidgetPalette | ScreenCanvas | PropertiesPanel)
- ScadaPackageListPage: Paket listesi, arama, durum filtresi, CRUD islemleri
- Zustand store (scadaPackageStore): Ekran, widget, alarm, kontrol, trend state yonetimi
- GraphQL queries/mutations: Tam CRUD + deploy operasyonlari

### ProcessEditor -> SCADA Builder Entegrasyonu (f3ae3f3)
- Process editor'dan SCADA builder'a gecis (processId ile)
- Proses diyagramini `processView` widget olarak import etme
- `importProcessAsWidget()` fonksiyonu

### Backend Entity & Service (9d0b68b)
- `ScadaPackage` TypeORM entity (PostgreSQL jsonb)
- `ScadaPackageService`: CRUD + deploy + boyut dogrulama (1 MB limit)
- GraphQL resolver'a entegrasyon
- MQTT deploy komutu: sunucu tarafinda kontrol edilen envelope yapisi

### Edge Agent Duzeltmeleri (118807b)
- Serde default degerler eklenmesi (eksik alan hatalari onlendi)
- Eksik widget renderlarinin eklenmesi
- Komut fallback mekanizmasi

### Guvenlik Iyilestirmeleri
- Deploy payload'unda sunucu-kontrollü meta alanlar (client override engeli)
- MQTT envelope'u: `commandId`, `command`, `timestamp` sunucu tarafindan uretilir
- packageData boyut limiti (1 MB)
- WebSocket DoS korumasi (maks 16 baglanti)
- PIN brute-force korumasi (3 deneme + 60s kilitlenme)
- Audit log: her kontrol islemi kayit altinda

---

## Dosya Yapisi

```
sens-api-gateway/                          # Edge Agent (Rust)
  Cargo.toml                               # scada-display feature flag
  src/
    scada_server.rs                        # HTTP + WebSocket sunucusu (axum)
    scada_types.rs                         # Paket, ekran, widget, alarm, kontrol tipleri
    scada_db.rs                            # SQLite veritabani (sifrelenmis)
    alarm_engine.rs                        # Alarm degerlendirme motoru
    trend_engine.rs                        # Trend veri toplama motoru
    calibration_engine.rs                  # Kalibrasyon motoru
    io_poll.rs                             # Tag broadcast entegrasyonu
    commands.rs                            # MQTT komut isleyicileri
  static/
    scada-edge.html                        # Kiosk SCADA viewer (React + ReactFlow)
    aquaculture-nodes.umd.js               # SVG node/edge bilesenler
  systemd/
    suderra-display.service                # Kiosk systemd unit
  scripts/
    setup-display.sh                       # Display kurulum scripti

apps/sensor-service/src/process/           # Backend (NestJS)
  entities/scada-package.entity.ts         # ScadaPackage TypeORM entity
  dto/scada-package.dto.ts                 # Input/Output DTO'lar
  services/scada-package.service.ts        # CRUD + deploy + dogrulama
  resolvers/process.resolver.ts            # GraphQL resolver (SCADA mutations dahil)

web/modules/sensor-module/src/             # Frontend (React)
  pages/scada/
    ScadaPackageBuilderPage.tsx            # 3-panel SCADA package builder
    ScadaPackageListPage.tsx               # Paket listesi sayfasi
  store/
    scadaPackageStore.ts                   # Zustand state yonetimi
    scadaStore.ts                          # Eski SCADA store (viewer)
  types/
    scada-package.types.ts                 # TypeScript tip tanimlari
    scada-types.ts                         # ReactFlow node/edge tipleri
  graphql/
    scada-package.queries.ts               # GraphQL query/mutation tanimlari
  components/scada-builder/
    WidgetPalette.tsx                       # Widget secim paneli
    ScreenCanvas.tsx                        # Ekran canvas
  hooks/
    useScadaPackage.ts                     # React Query hook'lari
```
