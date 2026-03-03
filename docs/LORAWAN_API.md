# LoRaWAN API Referansi (API Reference)

> **Versiyon:** v1.5.0+ | GraphQL API, MQTT topic formatlari, codec referansi ve agent konfigurasyon yapisi.

---

## GraphQL API

Tum LoRa islemleri GraphQL uzerinden yapilir. Endpoint: `/graphql`

### Queries

#### loraDevices — Cihaz Listesi Sorgulama

Bir edge device'a bagli tum LoRa cihazlarini listeler.

```graphql
query LoRaDevices($edgeDeviceId: ID!) {
  loraDevices(edgeDeviceId: $edgeDeviceId) {
    id
    devEui
    appEui
    name
    tagPrefix
    activationMode
    deviceClass
    codec
    adrEnabled
    fPort
    isJoined
    joinedAt
    lastSeenAt
    lastRssi
    lastSnr
    frameCountUp
    createdAt
  }
}
```

**Degiskenler**:
| Alan | Tip | Aciklama |
|------|-----|----------|
| `edgeDeviceId` | `ID!` | Gateway gorevindeki edge device UUID'si |

**Yanit Alanlari**:
| Alan | Tip | Aciklama |
|------|-----|----------|
| `id` | `ID` | LoRa cihaz UUID'si |
| `devEui` | `String` | 16 hex karakter cihaz kimligi |
| `appEui` | `String` | 16 hex karakter uygulama kimligi |
| `name` | `String` | Kullanici dostu cihaz adi |
| `tagPrefix` | `String` | I/O tag on eki (orn: "LORA_PH_01") |
| `activationMode` | `LoRaActivationMode` | `OTAA` veya `ABP` |
| `deviceClass` | `LoRaDeviceClass` | `A`, `B`, veya `C` |
| `codec` | `String` | Payload decode formati |
| `adrEnabled` | `Boolean` | Adaptive Data Rate aktif mi |
| `fPort` | `Int` | LoRaWAN uygulama port numarasi (1-223) |
| `isJoined` | `Boolean` | OTAA join basarili mi |
| `joinedAt` | `DateTime` | Join zamani (nullable) |
| `lastSeenAt` | `DateTime` | Son uplink zamani (nullable) |
| `lastRssi` | `Float` | Son RSSI degeri dBm (nullable) |
| `lastSnr` | `Float` | Son SNR degeri dB (nullable) |
| `frameCountUp` | `Int` | Uplink frame sayaci (nullable) |
| `createdAt` | `DateTime` | Kayit zamani |

**Ornek Kullanim (cURL)**:
```bash
curl -X POST https://app.suderra.com/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "query { loraDevices(edgeDeviceId: \"fd23af6b-...\") { id devEui name isJoined lastRssi lastSnr } }"
  }'
```

**Ornek Yanit**:
```json
{
  "data": {
    "loraDevices": [
      {
        "id": "a1b2c3d4-e5f6-...",
        "devEui": "0011223344556677",
        "name": "Havuz-3 pH",
        "isJoined": true,
        "lastRssi": -87.0,
        "lastSnr": 8.5
      }
    ]
  }
}
```

Kaynak: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:8-30`

---

### Mutations

#### addLoRaDevice — Yeni Cihaz Ekleme

Edge device'a yeni bir LoRa end-device kaydeder. Backend, MQTT uzerinden agent'a `update_lora_devices` komutu gonderir.

```graphql
mutation AddLoRaDevice($edgeDeviceId: ID!, $input: AddLoRaDeviceInput!) {
  addLoRaDevice(edgeDeviceId: $edgeDeviceId, input: $input) {
    id
    devEui
    appEui
    name
    tagPrefix
    activationMode
    deviceClass
    codec
    adrEnabled
    fPort
    isJoined
    createdAt
  }
}
```

**Input Tipleri**:

```graphql
input AddLoRaDeviceInput {
  devEui: String!        # 16 hex karakter (orn: "0011223344556677")
  appKey: String!         # 32 hex karakter (orn: "00112233...CCDDEEFF")
  name: String!           # Kullanici dostu ad (maks 50 karakter)
  tagPrefix: String!      # I/O tag on eki (maks 30 karakter)
  activationMode: LoRaActivationMode  # OTAA veya ABP (opsiyonel, varsayilan: OTAA)
  deviceClass: LoRaDeviceClass        # A veya C (opsiyonel, varsayilan: A)
  codec: String           # "cayenne_lpp", "raw", "json" (opsiyonel, varsayilan: cayenne_lpp)
  appEui: String          # 16 hex karakter uygulama kimligi (opsiyonel)
  adrEnabled: Boolean     # Adaptive Data Rate (opsiyonel, varsayilan: true)
}
```

**Ornek**:
```json
{
  "edgeDeviceId": "fd23af6b-167f-4afd-a62a-ceace2a4046b",
  "input": {
    "devEui": "0011223344556677",
    "appKey": "00112233445566778899AABBCCDDEEFF",
    "name": "Havuz-3 pH Sensoru",
    "tagPrefix": "LORA_PH_03",
    "activationMode": "OTAA",
    "deviceClass": "A",
    "codec": "cayenne_lpp"
  }
}
```

Kaynak: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:34-51`

---

#### removeLoRaDevice — Cihaz Silme

Kayitli bir LoRa cihazini siler. Agent'a da `update_lora_devices` komutu ile guncelleme gonderir.

```graphql
mutation RemoveLoRaDevice($edgeDeviceId: ID!, $loraDeviceId: ID!) {
  removeLoRaDevice(edgeDeviceId: $edgeDeviceId, loraDeviceId: $loraDeviceId)
}
```

**Degiskenler**:
| Alan | Tip | Aciklama |
|------|-----|----------|
| `edgeDeviceId` | `ID!` | Gateway edge device UUID'si |
| `loraDeviceId` | `ID!` | Silinecek LoRa cihaz UUID'si |

**Yanit**: `Boolean` — `true` ise silme basarili.

Kaynak: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:53-56`

---

#### sendLoRaDownlink — Downlink Mesaj Gonderme

Belirli bir LoRa cihazina downlink (buluttan cihaza) mesaj gonderir. Class A cihazlar icin mesaj bir sonraki uplink'ten sonra RX pencerelerinde iletilir. Class C cihazlar icin hemen gonderilir.

```graphql
mutation SendLoRaDownlink($edgeDeviceId: ID!, $loraDeviceId: ID!, $input: SendLoRaDownlinkInput!) {
  sendLoRaDownlink(edgeDeviceId: $edgeDeviceId, loraDeviceId: $loraDeviceId, input: $input) {
    success
    error
  }
}
```

**Input Tipleri**:

```graphql
input LoRaDownlinkInput {
  payload: String!   # Hex-encoded payload (orn: "FF01A0")
  fPort: Int!        # LoRaWAN uygulama portu (1-223)
}
```

**Yanit**:
```graphql
type LoRaDownlinkResult {
  success: Boolean!
  error: String       # Hata durumunda aciklama
}
```

**Ornek — Vana Ac Komutu**:
```json
{
  "edgeDeviceId": "fd23af6b-...",
  "loraDeviceId": "a1b2c3d4-...",
  "input": {
    "payload": "01FF",
    "fPort": 10
  }
}
```

Kaynak: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:58-66`

---

## MQTT Topic Formatlari (MQTT Topic Formats)

Tum MQTT topic'leri tenant ve device bazli izole edilmistir. Patern:
`tenants/{tenant_id}/devices/{device_id}/{topic_name}`

### io_data — I/O Tag Verileri (Mevcut Pipeline)

LoRa tag'leri, GPIO/Modbus/I2C tag'leriyle **ayni** io_data topic'inde yayinlanir.

**Topic**: `tenants/{tid}/devices/{did}/io_data`
**QoS**: 1 (At least once)
**Yayin Araligi**: Her `io_data_interval_ms` (varsayilan 1000ms)

```json
{
  "timestamp": "2026-03-03T10:00:00.000Z",
  "tags": {
    "LORA_PH_01_PH": {
      "value": 7.23,
      "quality": "good",
      "source": "lora",
      "io_type": "AI"
    },
    "LORA_PH_01_TEMP": {
      "value": 23.5,
      "quality": "good",
      "source": "lora",
      "io_type": "AI"
    },
    "LORA_TH_01_HUMIDITY": {
      "value": 68.2,
      "quality": "good",
      "source": "lora",
      "io_type": "AI"
    },
    "MODBUS_PUMP_01_PRESSURE": {
      "value": 2.35,
      "quality": "good",
      "source": "modbus",
      "io_type": "AI"
    },
    "GPIO_VALVE_01": {
      "value": 1.0,
      "quality": "good",
      "source": "gpio",
      "io_type": "DO"
    }
  }
}
```

**Tag Isimlendirme Kurali**:
`{tag_prefix}_{decoded_field_name}` seklinde otomatik olusturulur.

| Codec Cikisi | tag_prefix | Sonuc Tag Adi |
|-------------|-----------|---------------|
| temperature | LORA_PH_01 | LORA_PH_01_TEMP |
| humidity | LORA_TH_01 | LORA_TH_01_HUMIDITY |
| analogInput (kanal 3) | LORA_EC_02 | LORA_EC_02_AI_3 |

**Kalite Kodlari** (`quality` alani):

| Deger | Anlamn | OPC UA Kodu |
|-------|--------|-------------|
| `good` | Basarili okuma | 192 |
| `uncertain` | Eski veri (cihaz uzun suredir veri gondermedi) | 64 |
| `bad` | Decode hatasi veya MIC dogrulama basarisiz | 0 |
| `comm_failure` | Cihazla iletisim kaybedildi | 24 |
| `not_initialized` | Henuz veri alinmadi | 32 |

Kaynak: `/var/aqua-saas/sens-api-gateway/src/process_image.rs:8-16` (TagQuality enum)

---

### lora_events — LoRa Olay Bildirimleri (Yeni)

LoRa'ya ozgu olaylar icin ayri bir topic. Join, leave, hata gibi olaylari bildirir.

**Topic**: `tenants/{tid}/devices/{did}/lora_events`
**QoS**: 1

#### join_accept — Cihaz Aga Katildi

```json
{
  "event_type": "join_accept",
  "dev_eui": "0011223344556677",
  "dev_addr": "26011234",
  "timestamp": "2026-03-03T10:00:00.000Z"
}
```

#### join_failed — Join Basarisiz

```json
{
  "event_type": "join_failed",
  "dev_eui": "0011223344556677",
  "reason": "mic_mismatch",
  "timestamp": "2026-03-03T10:00:05.000Z"
}
```

#### device_timeout — Cihaz Zaman Asimi

```json
{
  "event_type": "device_timeout",
  "dev_eui": "0011223344556677",
  "last_seen": "2026-03-03T09:30:00.000Z",
  "timeout_minutes": 30,
  "timestamp": "2026-03-03T10:00:00.000Z"
}
```

#### stats — Periyodik Istatistikler

```json
{
  "event_type": "stats",
  "timestamp": "2026-03-03T10:00:00.000Z",
  "active_sessions": 12,
  "packets_received": 4521,
  "packets_sent": 87,
  "join_requests": 15,
  "uplinks_processed": 4498,
  "crc_errors": 3,
  "unknown_devices": 20
}
```

Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:390-406` (LoRaStats)

---

### Agent Komut Formati (commands topic)

Backend'den agent'a gonderilen LoRa ile ilgili komutlar.

**Topic**: `tenants/{tid}/devices/{did}/commands`
**QoS**: 1

#### update_lora_devices — Cihaz Listesi Guncelle

Bir cihaz eklendiginde veya silindiginde tum cihaz listesi gonderilir:

```json
{
  "commandId": "cmd-uuid-here",
  "command": "update_lora_devices",
  "timestamp": "2026-03-03T10:00:00.000Z",
  "params": {
    "devices": [
      {
        "dev_eui": "0011223344556677",
        "app_eui": "0000000000000000",
        "app_key": "00112233445566778899AABBCCDDEEFF",
        "activation": "otaa",
        "device_class": "A",
        "tag_prefix": "LORA_PH_01",
        "codec": "cayenne_lpp",
        "adr_enabled": true,
        "rx1_delay_secs": 1,
        "rx2_datarate": null,
        "rx2_freq_hz": null
      },
      {
        "dev_eui": "AABBCCDDEEFF0011",
        "app_eui": "0000000000000000",
        "app_key": "FFEEDDCCBBAA99887766554433221100",
        "activation": "otaa",
        "device_class": "A",
        "tag_prefix": "LORA_TH_01",
        "codec": "cayenne_lpp",
        "adr_enabled": true
      }
    ]
  }
}
```

Agent bu komutu aldifinda:
1. Mevcut cihaz listesi ile karsilastirir
2. Yeni cihazlari whitelist'e ekler
3. Silinen cihazlarin oturumlarini temizler
4. Responses topic'ine basarili/basarisiz bildirir

#### lora_downlink — Downlink Gonder

```json
{
  "commandId": "cmd-uuid-here",
  "command": "lora_downlink",
  "timestamp": "2026-03-03T10:00:00.000Z",
  "params": {
    "dev_addr": "26011234",
    "payload": "FF01A0",
    "f_port": 10,
    "confirmed": false
  }
}
```

**Agent Yaniti** (responses topic):
```json
{
  "commandId": "cmd-uuid-here",
  "status": "success",
  "timestamp": "2026-03-03T10:00:01.000Z"
}
```

---

## CayenneLPP Codec Referansi

CayenneLPP (Cayenne Low Power Payload), IPSO Smart Objects tabanlı standart bir sensor veri formatidir. TLV (Type-Length-Value) yapisi kullanir.

### Paket Yapisi

```
[ Kanal (1B) | Tip (1B) | Deger (NB) ] [ Kanal | Tip | Deger ] ...
```

Her kayit:
- **Kanal**: 0x00-0xFF arasi kanal numarasi
- **Tip**: Sensor tipi kodu (asagidaki tablo)
- **Deger**: Tipi bagli byte sayisi ve olcek faktoru

### Tip Tablosu

| Tip Kodu | Sensor | Boyut | Olcek | Birim | Ornek Deger |
|----------|--------|-------|-------|-------|-------------|
| `0x01` | Digital Input | 1B | 1 | - | 0 veya 1 |
| `0x02` | Analog Input | 2B | 0.01 | V | 3.27 |
| `0x03` | Analog Output | 2B | 0.01 | V | 1.50 — *henuz desteklenmiyor* |
| `0x65` | Illuminance | 2B | 1 | Lux | 1200 |
| `0x66` | Presence | 1B | 1 | - | 0 veya 1 — *henuz desteklenmiyor* |
| `0x67` | Temperature | 2B | 0.1 | C | 23.5 |
| `0x68` | Humidity | 1B | 0.5 | %RH | 68.5 |
| `0x71` | Accelerometer | 6B | 0.001 | G | x,y,z — *henuz desteklenmiyor* |
| `0x73` | Barometer | 2B | 0.1 | hPa | 1013.5 |
| `0x86` | Gyrometer | 6B | 0.01 | deg/s | x,y,z — *henuz desteklenmiyor* |
| `0x88` | GPS Location | 9B | * | deg,m | lat,lon,alt — *henuz desteklenmiyor* |

### Decode Ornegi

**Ham payload (hex)**: `01 67 01 10 02 68 8C`

**Decode adimi**:

```
Kayit 1:
  Kanal: 0x01 (Kanal 1)
  Tip:   0x67 (Temperature)
  Deger: 0x0110 = 272 → 272 * 0.1 = 27.2 C

Kayit 2:
  Kanal: 0x02 (Kanal 2)
  Tip:   0x68 (Humidity)
  Deger: 0x8C = 140 → 140 * 0.5 = 70.0 %RH
```

**Sonuc tag'leri** (tag_prefix = "LORA_SENSOR_01"):
```json
{
  "LORA_SENSOR_01_TEMP": 27.2,
  "LORA_SENSOR_01_HUMIDITY": 70.0
}
```

### Akvakulturdeki Tipik CayenneLPP Kullanim

| Parametre | Kanal | Tip | Birim | Tipik Aralik |
|-----------|-------|-----|-------|-------------|
| Su Sicakligi | 1 | 0x67 (Temperature) | C | 15-30 |
| pH | 2 | 0x02 (Analog Input) | - | 6.5-8.5 |
| Cozunmus O2 | 3 | 0x02 (Analog Input) | mg/L | 5-15 |
| Iletkenlik (EC) | 4 | 0x02 (Analog Input) | mS/cm | 0-50 |
| Turkuaz (NTU) | 5 | 0x02 (Analog Input) | NTU | 0-100 |
| Su Seviyesi | 6 | 0x02 (Analog Input) | cm | 0-500 |
| Hava Sicakligi | 7 | 0x67 (Temperature) | C | -10-50 |
| Nem | 8 | 0x68 (Humidity) | %RH | 20-100 |

---

## Rust Agent Konfigurasyon Formati

### Tam LoRaWAN Bolumu

```yaml
lorawan:
  # Ana ayarlar
  enabled: true                              # LoRa modulunu etkinlestir
  region: "EU868"                            # Frekans bolge plani
  net_id: "000000"                           # 3-byte ag kimligi (hex)

  # Donanim ayarlari
  spi_device: "spi0"                         # SPI bus (/dev/spidev0.0)
  reset_gpio_pin: 17                         # SX1302 reset GPIO pini

  # Performans sinilari
  max_devices: 2048                          # Maks kayitli cihaz sayisi

  # Depolama
  session_db_path: "/var/lib/suderra/lora_sessions.db"  # SQLCipher DB yolu

  # Cihaz tanimlari
  devices:
    - dev_eui: "0011223344556677"            # DevEUI (16 hex, zorunlu)
      app_eui: "0000000000000000"            # AppEUI (16 hex, zorunlu)
      app_key: "00112233445566778899AABBCCDDEEFF"  # AppKey (32 hex, OTAA icin zorunlu)
      activation: "otaa"                     # "otaa" veya "abp"
      device_class: "A"                      # "A", "B", veya "C"
      tag_prefix: "LORA_PH_01"              # I/O tag on eki
      codec: "cayenne_lpp"                   # "cayenne_lpp" | "raw_binary" | "custom"
      adr_enabled: true                      # Adaptive Data Rate
      # Opsiyonel RF ayarlari:
      # rx1_delay_secs: 1                    # RX1 gecikme (sn)
      # rx2_datarate: 0                      # RX2 veri hizi indeksi
      # rx2_freq_hz: 869525000               # RX2 frekans (Hz)
```

### Desteklenen Bolgeler

| Bolge | Frekans | Turkiye | Aciklama |
|-------|---------|---------|----------|
| `EU868` | 863-870 MHz | Evet | Avrupa, Turkiye, Rusya |
| `US915` | 902-928 MHz | Hayir | ABD, Kanada |
| `AU915` | 915-928 MHz | Hayir | Avustralya |
| `AS923` | 920-923 MHz | Hayir | Guneydogu Asya, Japonya |
| `KR920` | 920-923 MHz | Hayir | Guney Kore |
| `IN865` | 865-867 MHz | Hayir | Hindistan |
| `CN470` | 470-510 MHz | Hayir | Cin |

Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:249-266` (LoRaRegion enum)

### Desteklenen Codec Tipleri

| Codec | Serde Adi | Aciklama |
|-------|-----------|----------|
| CayenneLPP | `cayenne_lpp` | Standart TLV formati, cogu sensor icin |
| Raw Binary | `raw_binary` | Her 4B = f32, byte_order belirtilmeli |
| Custom | `custom` | Ozel decoder adi ile eslesir |

Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:272-288` (CodecType enum)

---

## Enum Referansi

### LoRaActivationMode (Backend)

```typescript
enum LoRaActivationMode {
  OTAA = 'OTAA'   // Over-The-Air Activation (onerilen)
  ABP  = 'ABP'    // Activation By Personalization
}
```
Kaynak: `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/lora-device.entity.ts:33-36`

### LoRaDeviceClass (Backend)

```typescript
enum LoRaDeviceClass {
  A = 'A'   // Dusuk guc, sadece uplink sonrasi RX
  B = 'B'   // Beacon senkronizasyonlu zamanli RX
  C = 'C'   // Surekli RX, en yuksek guc tuketimi
}
```
Kaynak: `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/lora-device.entity.ts:56-60`

### ActivationMode (Rust Agent)

```rust
enum ActivationMode {
    Otaa,   // serde: "otaa"
    Abp,    // serde: "abp"
}
```
Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:221-228`

### DeviceClass (Rust Agent)

```rust
enum DeviceClass {
    A,
    B,
    C,
}
```
Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:238-243`

---

## Veritabani Semasi

### lora_devices Tablosu

```sql
CREATE TABLE lora_devices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  edge_device_id  UUID NOT NULL REFERENCES edge_devices(id) ON DELETE CASCADE,
  dev_eui         VARCHAR(16) NOT NULL UNIQUE,
  app_eui         VARCHAR(16),
  app_key         VARCHAR(32) NOT NULL,
  dev_addr        VARCHAR(8),
  activation_mode VARCHAR DEFAULT 'OTAA',
  device_class    VARCHAR DEFAULT 'A',
  name            VARCHAR(50) NOT NULL,
  tag_prefix      VARCHAR(30) NOT NULL,
  codec           VARCHAR(20) DEFAULT 'cayenne_lpp',
  adr_enabled     BOOLEAN DEFAULT true,
  f_port          SMALLINT DEFAULT 1,
  last_seen_at    TIMESTAMPTZ,
  last_rssi       REAL,
  last_snr        REAL,
  frame_count_up  INT,
  is_joined       BOOLEAN DEFAULT false,
  joined_at       TIMESTAMPTZ,
  tenant_id       UUID NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indeksler
CREATE INDEX idx_lora_devices_tenant_edge ON lora_devices(tenant_id, edge_device_id);
CREATE UNIQUE INDEX idx_lora_devices_dev_eui ON lora_devices(dev_eui);
```

Kaynak: `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/lora-device.entity.ts:83-209`
