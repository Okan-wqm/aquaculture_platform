# LoRaWAN Concentrator Entegrasyonu — Mimari Dokumantasyonu

> Su urunleri tesisleri icin LoRaWAN kablosuz sensor altyapisi.
> Rust Edge Agent + NestJS Backend + React Frontend tam yigin entegrasyonu.

---

## Genel Bakis (Overview)

LoRaWAN (Long Range Wide Area Network), dusuk guc tuketimli cihazlarin uzun menzilde kablosuz iletisim kurmasini saglayan bir LPWAN (Low Power Wide Area Network) protokoludur. Su urunleri tesisleri icin ideal olan LoRaWAN sunlari saglar:

- **Uzun menzil**: 2-15 km acik alan, 1-5 km bina icinde
- **Dusuk guc tuketimi**: Pil ile yillarca calisabilir (Class A)
- **Yuksek cihaz yogunlugu**: Tek bir gateway ile 2000+ cihaz destegi
- **ISM bant**: Lisanssiz frekans kullanimi (EU868 Turkiye icin)
- **Guvenlk**: AES-128 sifreleme, MIC dogrulama, frame counter korumalari

### Neden Su Urunleri Tesisleri Icin Ideal?

Akvakulturdeki tipik zorluklar — genis alanlara yayilmis havuzlar, sert cevre kosullari (nem, tuz), kablolama maliyeti — LoRaWAN ile giderilir. pH, cozunmus oksijen (DO), sicaklik gibi kritik parametreler kablosuz olarak, guvence altinda ve dusuk maliyetle izlenebilir.

### Concentrator Donanimi

Sistem, **RAK2287** modulu uzerindeki **Semtech SX1302** cipsetini kullanir:

| Ozellik | Deger |
|---------|-------|
| RF kanali | 8 kanal x 6 SF = 48 paralel demodulator |
| Frekans | EU868 (867-869 MHz) |
| Arayuz | SPI (Raspberry Pi GPIO header) |
| Alim akimi | ~500 mA (TX dahil) |
| Hassasiyet | -141 dBm (SF12/BW125) |

---

## Sistem Mimarisi (System Architecture)

```
                                  ┌─────────────────────────────────────────────┐
                                  │              Su Urunleri Tesisi             │
                                  │                                             │
┌──────────────┐    RF 868MHz     │  ┌─────────────────────────┐                │
│ LoRa Sensor  │ ─────────────→  │  │  SX1302 Concentrator    │                │
│ (pH, DO, T)  │                  │  │  (8ch x 6SF = 48 demod) │                │
│ Class A/C    │                  │  │  RAK2287 Module         │                │
└──────────────┘                  │  └───────┬─────────────────┘                │
                                  │          │ SPI Bus                          │
┌──────────────┐    RF 868MHz     │  ┌───────┴─────────────────────────────┐    │
│ LoRa Sensor  │ ─────────────→  │  │  Rust Edge Agent (Raspberry Pi)     │    │
│ (Nem, EC)    │                  │  │  ├── lora/types.rs    (veri yapilari) │    │
└──────────────┘                  │  │  ├── lora/sx1302.rs   (SPI HAL)    │    │
                                  │  │  ├── lora/mac.rs      (LoRaWAN MAC)│    │
┌──────────────┐    RF 868MHz     │  │  ├── lora/crypto.rs   (AES-128)    │    │
│ LoRa Sensor  │ ─────────────→  │  │  ├── lora/session.rs  (SQLite)     │    │
│ (Agirlk, ORP)│                  │  │  ├── lora/codec.rs    (CayenneLPP) │    │
└──────────────┘                  │  │  └── process_image.rs (tag merge)  │    │
                                  │  └───────┬─────────────────────────────┘    │
                                  │          │                                  │
                                  └──────────┼──────────────────────────────────┘
                                             │ MQTT (TLS 1.2+)
                                             │ Port 8883
                                  ┌──────────┴──────────────────────────────────┐
                                  │  NestJS Backend (Cloud)                     │
                                  │  ├── mqtt-client.service.ts  (MQTT dinleme) │
                                  │  ├── edge-device.service.ts  (cihaz yonetim)│
                                  │  ├── lora-device.entity.ts   (DB modeli)    │
                                  │  └── lorawan.adapter.ts      (protokol)     │
                                  └──────────┬──────────────────────────────────┘
                                             │ GraphQL + WebSocket
                                             │
                                  ┌──────────┴──────────────────────────────────┐
                                  │  React Frontend                             │
                                  │  ├── useLoRaDevices.ts      (React Query)   │
                                  │  ├── lora-device.queries.ts (GraphQL)       │
                                  │  ├── LoRaDevicesPanel.tsx   (cihaz listesi) │
                                  │  └── LoRaStatsCard.tsx      (istatistikler) │
                                  └─────────────────────────────────────────────┘
```

---

## Veri Akislari (Data Flows)

### 1. Uplink Akisi (Sensor -> Bulut)

Bir LoRa sensorunden buluta veri ulasma sureci adim adim:

1. **Sensor TX**: LoRa cihazi sensor verisini CayenneLPP formatinda sifreliyip gonderar
   - Payload: MHDR (1B) + DevAddr (4B) + FCtrl + FCnt + FPort + FRMPayload (encrypted) + MIC (4B)

2. **SX1302 RX**: Concentrator cip 8 kanalda paralel demodulasyon yapar
   - `lora/sx1302.rs` → `SX1302Handle::receive()` fonksiyonu SPI uzerinden paketleri okur
   - Dondurulen `RxPacket` yapisi: payload, freq_hz, datarate, rssi, snr, timestamp, crc_ok
   - Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:338-357`

3. **CRC Kontrolu**: CRC hatali paketler atilir, `LoRaStats.crc_errors` sayaci artar
   - Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:402`

4. **MAC Isleme**: `lora/mac.rs` → `LoRaMac::process_uplink()` fonksiyonu:
   - DevAddr'i parse eder, oturum tablosundan cihazi bulur
   - Frame counter dogrular (replay attack korunmasi)
   - MIC hesaplayip karsilastirir (NwkSKey ile AES-CMAC)
   - `LoRaStats.uplinks_processed` arttirilir

5. **Payload Decode**: `lora/codec.rs` → `decode_cayenne_lpp()` veya custom decoder:
   - CayenneLPP TLV (Type-Length-Value) parse edilir
   - Her kanal icin tag adi ve degeri uretilir
   - Ornek: Kanal 1, Tip 0x67 (Temperature) → `LORA_PH_01_TEMP = 23.5`

6. **Process Image Merge**: `process_image.rs` → `ProcessImage::update_tag()`
   - LoRa tag'leri GPIO, Modbus, I2C tag'leriyle ayni tabloya yazilir
   - TagQuality: `Good` (basarili decode), `Uncertain` (eski veri), `Bad` (CRC/MIC hatasi)
   - Kaynak: `/var/aqua-saas/sens-api-gateway/src/process_image.rs:8-16`

7. **MQTT Publish**: `mqtt.rs` → io_data topic'ine tum tag'ler JSON olarak yayinlanir
   - Topic: `tenants/{tenant_id}/devices/{device_id}/io_data`
   - Kaynak: `/var/aqua-saas/sens-api-gateway/src/config.rs:403` (io_data topic tanimi)

8. **Backend Ingestion**: `mqtt-client.service.ts` io_data mesajini alir
   - LoRa tag'leri diger sensor verileriyle birlikte islenir
   - TimescaleDB hypertable'a yazilir

9. **WebSocket Push**: Canli veriler WebSocket uzerinden frontend'e iletilir

### 2. OTAA Join Akisi (Cihaz Aktivasyonu)

```
LoRa Cihaz              Edge Agent                    Backend
    │                        │                            │
    │── Join Request ───────→│                            │
    │   (DevEUI+AppEUI+      │                            │
    │    DevNonce)            │                            │
    │                        │                            │
    │                   mac.rs:                            │
    │                   1. DevEUI whitelist kontrolu       │
    │                   2. AppKey ile MIC dogrulama        │
    │                   3. DevNonce tekrar kontrolu        │
    │                   4. DevAddr uretimi                 │
    │                   5. Session key turetimi            │
    │                      (NwkSKey, AppSKey)              │
    │                   6. session.rs → SQLite kayit       │
    │                        │                            │
    │←── Join Accept ────────│                            │
    │   (DevAddr+DLSettings+ │                            │
    │    RxDelay+CFList)      │                            │
    │                        │── lora_events MQTT ───────→│
    │                        │   type: "join_accept"       │
    │                        │   dev_eui, dev_addr         │
    │                        │                            │
    │                        │                       DB guncelle:
    │                        │                       isJoined=true
    │                        │                       devAddr=...
    │                        │                       joinedAt=now()
```

**Anahtar Turetimi (Key Derivation)**:
- `NwkSKey = AES128_encrypt(AppKey, 0x01 | AppNonce | NetID | DevNonce | pad)`
- `AppSKey = AES128_encrypt(AppKey, 0x02 | AppNonce | NetID | DevNonce | pad)`
- Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:187-209` (SessionKeys yapisi)

### 3. Downlink Akisi (Bulut -> Sensor)

```
Frontend                 Backend                  Edge Agent           LoRa Cihaz
    │                        │                        │                    │
    │── sendLoRaDownlink ──→│                        │                    │
    │   (payload, fPort)     │                        │                    │
    │                        │── MQTT command ───────→│                    │
    │                        │   "lora_downlink"  │                    │
    │                        │                        │                    │
    │                        │                   mac.rs:                    │
    │                        │                   1. Payload sifreleme       │
    │                        │                      (AppSKey ile AES-CTR)  │
    │                        │                   2. MIC hesaplama          │
    │                        │                      (NwkSKey ile AES-CMAC) │
    │                        │                   3. FCntDown artirma       │
    │                        │                        │                    │
    │                        │                   Class A: RX1/RX2          │
    │                        │                   penceresi beklenir         │
    │                        │                        │                    │
    │                        │                        │── TX Packet ──────→│
    │                        │                        │   (RX1: +1s, ayni  │
    │                        │                        │    frekansta)       │
    │                        │                        │                    │
    │                        │←── MQTT response ──────│                    │
    │←── GraphQL response ──│   success: true         │                    │
```

- GraphQL mutation: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:59-66`
- TxPacket yapisi: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:363-380`

---

## Bilesen Sorumluluklari (Component Responsibilities)

### Rust Edge Agent Modulleri

| Modul | Dosya | Sorumluluk |
|-------|-------|------------|
| **types** | `src/lora/types.rs` | Tum LoRaWAN veri yapilari: DevEui, AppEui, AppKey, DevAddr, SessionKeys, LoRaDeviceConfig, RxPacket, TxPacket, LoRaStats. Serde serialize/deserialize destegi. |
| **sx1302** | `src/lora/sx1302.rs` | SX1302 concentrator cip ile SPI uzerinden iletisim. HAL (Hardware Abstraction Layer): baslatma, paket alma (RX), paket gonderme (TX), sicaklik kompanzasyonu. Semtech `sx1302_hal` C kutuphanesi ustune Rust FFI wrapper. |
| **mac** | `src/lora/mac.rs` | LoRaWAN 1.0.x MAC state machine. Join request/accept isleme, uplink/downlink frame parse/build, MIC dogrulama, frame counter yonetimi, ADR (Adaptive Data Rate) hesaplama. |
| **crypto** | `src/lora/crypto.rs` | AES-128 sifreleme islemleri. Payload encrypt/decrypt (AES-CTR modu), MIC hesaplama (AES-CMAC / RFC 4493), session key turetimi (Join-accept'ten NwkSKey/AppSKey). |
| **session** | `src/lora/session.rs` | Cihaz oturum yonetimi. SQLite (SQLCipher ile sifrelenmis) veritabaninda session key, frame counter, DevAddr saklama. Guc kesintisine karsi dayanikli persistent storage. |
| **codec** | `src/lora/codec.rs` | Payload decode/encode. CayenneLPP standart decoder, ham binary decoder, ozel (custom) decoder destefi. Decode edilen degerler process image tag'lerine cevrillir. |
| **process_image** | `src/process_image.rs` | Birlesik I/O tablosu. GPIO, Modbus, I2C ve LoRa tag'leri ayni yapida. OPC UA kalite kodlari (Good/Uncertain/Bad). |
| **mqtt** | `src/mqtt.rs` | Bulut baglantisi. TLS 1.2+ sifreleme, failover destegi, io_data/lora_events/commands topic yonetimi. |
| **commands** | `src/commands.rs` | Uzak komut isleme. `update_lora_devices`, `lora_downlink` gibi LoRa komutlari dahil. |

### NestJS Backend Servisleri

| Bilesen | Dosya | Sorumluluk |
|---------|-------|------------|
| **LoRaDevice Entity** | `src/edge-device/entities/lora-device.entity.ts` | TypeORM entity: `lora_devices` tablosu. DevEUI (unique), AppKey, aktivasyon modu, cihaz sinifi, tag prefix, codec, radyo metrikleri (RSSI, SNR), join durumu. Tenant izolasyonu. |
| **EdgeDevice Entity** | `src/edge-device/entities/edge-device.entity.ts` | Gateway cihaz modeli. `RASPBERRY_PI_4_LORA` ve `RASPBERRY_PI_5_LORA` model tipleri LoRa destekli cihazlari temsil eder. |
| **LoRaWAN Adapter** | `src/protocol/adapters/wireless/lorawan.adapter.ts` | Protokol adaptoru. Konfigruasyon semasi (JSON Schema), OTAA/ABP validasyonu, EU868/US915 bolge destegi. |
| **MQTT Client** | `src/mqtt/mqtt-client.service.ts` | MQTT mesaj dinleme ve yonlendirme. io_data ve lora_events topic'lerini isle. |
| **Device Event** | `src/edge-device/device-event.service.ts` | Cihaz olay kayitlari. Join/leave olaylari loglama. |

### React Frontend Bilesenleri

| Bilesen | Dosya | Sorumluluk |
|---------|-------|------------|
| **useLoRaDevices** | `src/hooks/useLoRaDevices.ts` | React Query hook. LoRa cihaz listesi sorgulama (5s refetch), ekleme, silme, downlink gonderme. |
| **GraphQL Queries** | `src/graphql/lora-device.queries.ts` | 4 GraphQL operasyonu: `loraDevices` query, `addLoRaDevice`, `removeLoRaDevice`, `sendLoRaDownlink` mutation. |
| **LoRaDevicesPanel** | Cihaz yonetim paneli. Cihaz listesi, join durumu, RSSI/SNR gostergeleri, cihaz ekleme formu. |
| **LoRaStatsCard** | Istatistik karti. Aktif oturum, paket sayilari, CRC hatalari goruntusu. |

---

## Mevcut Pipeline ile Entegrasyon (Integration with Existing Pipeline)

### LoRa Verisinin Process Image'a Girisi

LoRa cihazlarindan gelen veriler, mevcut GPIO/Modbus/I2C pipeline'i ile **ayni** `ProcessImage` yapisina yazilir. Bu sayede:

1. **Tek tip veri modeli**: Tum I/O kaynaklari ayni tag yapisi (`TagValue`) kullanir
2. **Ayni MQTT topic**: LoRa tag'leri `io_data` topic'i uzerinden diger tag'lerle birlikte yayinlanir
3. **Ayni alarm motoru**: LoRa tag'lerine de GPIO/Modbus tag'leriyle ayni sekilde alarm tanimlanabilir
4. **Ayni scripting**: IEC 61131-3 ST programlari LoRa tag'lerini de okuyabilir

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│   GPIO   │     │  Modbus  │     │   I2C    │     │   LoRa   │
│  Driver  │     │  Driver  │     │  Driver  │     │  Codec   │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                │
     └────────────────┴────────────────┴────────────────┘
                              │
                    ┌─────────┴──────────┐
                    │   Process Image    │
                    │   (RwLock<HashMap>) │
                    │                    │
                    │ Tag: "LORA_PH_01_T"│
                    │ Value: 23.5        │
                    │ Quality: Good      │
                    │ Source: LoRa       │
                    └─────────┬──────────┘
                              │
                    ┌─────────┴──────────┐
                    │   io_data MQTT     │
                    │   Publish Loop     │
                    │   (1s interval)    │
                    └────────────────────┘
```

### io_data MQTT Yayini

`io_data` topic'i mevcut I/O streaming pipeline'inin parcasidir (v1.4.0+):

- Topic: `tenants/{tenant_id}/devices/{device_id}/io_data`
- Yayin araligi: `telemetry.io_data_interval_ms` (varsayilan 1000ms)
- Kaynak: `/var/aqua-saas/sens-api-gateway/src/config.rs:579` (io_data_interval_ms)

### WebSocket Bridge

Backend, io_data mesajlarini alip WebSocket uzerinden frontend'e iletir. LoRa tag'leri bu akista ozel bir isleme tabi tutulmaz — diger tag'lerle ayni WebSocket kanalini kullanir.

---

## Guvenlik Modeli (Security Model)

### Katmanli Sifreleme (Defense in Depth)

```
┌─────────────────────────────────────────────────────────┐
│ Katman 4: MQTT TLS 1.2+ (Agent ↔ Cloud)                │
│   - X.509 sertifika dogrulamasi                         │
│   - mTLS destegi (cift yonlu kimlik dogrulama)          │
│   - Kaynak: config.rs:219-257 (MqttTlsConfig)          │
├─────────────────────────────────────────────────────────┤
│ Katman 3: LoRaWAN Uygulama Sifrelemesi                  │
│   - AppSKey ile AES-128-CTR payload sifreleme           │
│   - Uctan uca (end-to-end) gizlilik                     │
│   - Sadece kaynak cihaz ve uygulama sunucusu cozebilir  │
├─────────────────────────────────────────────────────────┤
│ Katman 2: LoRaWAN Ag Sifrelemesi                        │
│   - NwkSKey ile MIC (Message Integrity Code)            │
│   - AES-CMAC (RFC 4493) tabanli 4-byte MIC              │
│   - Frame counter ile replay attack korunmasi           │
│   - Kaynak: types.rs:199-208 (SessionKeys)              │
├─────────────────────────────────────────────────────────┤
│ Katman 1: RF Fiziksel Katman                            │
│   - Chirp Spread Spectrum (CSS) modulasyonu             │
│   - Frekans cevikligi (frequency hopping)               │
│   - Dusuk gurultu hassasiyeti (-141 dBm)                │
└─────────────────────────────────────────────────────────┘
```

### MIC Dogrulama

Her uplink paketi icin 4 byte MIC hesaplanir ve dogrulanir:

```
MIC = AES-CMAC(NwkSKey, B0 | msg)
B0  = 0x49 | 0x00(x4) | Dir | DevAddr | FCntUp | 0x00 | len
```

Yanlis MIC = paket reddedilir, `LoRaStats.unknown_devices` arttirilir.

### Frame Counter Replay Korunmasi

- Her uplink'te `f_cnt_up` artar (monoton artan)
- Agent, son bilinen counter degerinden dusuk olan paketleri reddeder
- Counter degerleri `session.rs` → SQLite'a persistent olarak kaydedilir
- Guc kesintisi sonrasi counter sifirlanmasi icin cihaz yeniden join etmeli
- Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:205-208`

### SQLCipher Oturum Deposu

- Session key'ler SQLite veritabaninda saklanir
- SQLCipher ile AES-256 sifreleme (at-rest encryption)
- Varsayilan yol: `/var/lib/suderra/lora_sessions.db`
- Dosya izinleri: 0600 (sadece owner okuyabilir)

### DevEUI Beyaz Listesi (Whitelist)

- Sadece konfigurasyonda tanimli DevEUI'ler join yapabilir
- Bilinmeyen DevEUI'den gelen join-request sessizce reddedilir
- `LoRaStats.unknown_devices` sayaci izleme icin artar
- Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:404`

---

## Performans Hedefleri (Performance Targets)

| Metrik | Hedef | Aciklama |
|--------|-------|----------|
| Maksimum cihaz | 2048 | Tek gateway basina (EU868 duty cycle siniri dahilinde) |
| Paket isleme hizi | 50 pkt/sn | SX1302 48 demodulator ile surdurulebilir oran |
| Isleme gecikmesi | <10 ms | Paket alim → process image guncelleme |
| RAM kullanimi | ~2 MB | 2048 cihaz session cache (SessionKeys: ~80B x 2048) |
| Join suresi | <5 sn | OTAA join-request → join-accept → ilk uplink |
| Disk kullanimi | ~1 MB | SQLite session DB (2048 cihaz icin) |
| CRC hata orani | <%0.1 | Normal RF ortaminda beklenen oran |

### EU868 Duty Cycle Kisilamasi

EU868 bandinda %1 duty cycle kisilamasi vardir:
- 868.1-868.5 MHz: %1 (36 sn/saat TX)
- 869.4-869.65 MHz: %10 (360 sn/saat TX, downlink icin tercih edilen)

Bu kisitlama nedeniyle Class A cihazlar icin donwlink kapasitesi sinirlidir. Kritik aktuator kontrolu icin Class C tercih edilmelidir.

---

## Dosya Referanslari (Quick Reference)

### Rust Edge Agent
- `/var/aqua-saas/sens-api-gateway/src/lora/types.rs` — Veri yapilari
- `/var/aqua-saas/sens-api-gateway/src/lora/sx1302.rs` — SPI HAL wrapper
- `/var/aqua-saas/sens-api-gateway/src/lora/mac.rs` — MAC state machine
- `/var/aqua-saas/sens-api-gateway/src/lora/crypto.rs` — AES sifreleme
- `/var/aqua-saas/sens-api-gateway/src/lora/session.rs` — Oturum yonetimi
- `/var/aqua-saas/sens-api-gateway/src/lora/codec.rs` — Payload decode
- `/var/aqua-saas/sens-api-gateway/src/process_image.rs` — I/O tag tablosu
- `/var/aqua-saas/sens-api-gateway/src/config.rs` — Agent konfigurasyonu
- `/var/aqua-saas/sens-api-gateway/src/mqtt.rs` — MQTT istemci
- `/var/aqua-saas/sens-api-gateway/src/commands.rs` — Uzak komutlar

### NestJS Backend
- `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/lora-device.entity.ts` — DB entity
- `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/edge-device.entity.ts` — Gateway entity
- `/var/aqua-saas/apps/sensor-service/src/protocol/adapters/wireless/lorawan.adapter.ts` — Protokol adaptoru
- `/var/aqua-saas/apps/sensor-service/src/mqtt/mqtt-client.service.ts` — MQTT dinleyici

### React Frontend
- `/var/aqua-saas/web/modules/sensor-module/src/hooks/useLoRaDevices.ts` — React Query hooks
- `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts` — GraphQL operasyonlari
