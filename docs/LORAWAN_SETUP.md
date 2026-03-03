# LoRaWAN Kurulum Kilavuzu (Setup Guide)

> **Versiyon:** v1.5.0+ | RAK2287 SX1302 concentrator ile Raspberry Pi uzerinde LoRaWAN gateway kurulumu.

---

## Donanim Gereksinimleri (Hardware Requirements)

### Ana Bilesen: RAK2287 SPI Concentrator

| Ozellik | Deger |
|---------|-------|
| Cipset | Semtech SX1302 + SX1250 |
| Arayuz | SPI (40-pin GPIO header) |
| Frekans | EU868 (veya bolgeye gore) |
| Kanal | 8 LoRa + 1 FSK |
| TX gucu | Maks. 27 dBm |
| Alim | 5V, ~500 mA |

### Desteklenen Platform

| Platform | Model | Notlar |
|----------|-------|--------|
| Raspberry Pi 4 | `raspberry_pi_4_lora` | 2GB+ RAM onerisi |
| Raspberry Pi 5 | `raspberry_pi_5_lora` | SPI hizi avantaji |

> Not: Cihaz modeli `DeviceModel` enum'unda `RASPBERRY_PI_4_LORA` veya `RASPBERRY_PI_5_LORA` olarak tanimlidir.
> Kaynak: `/var/aqua-saas/apps/sensor-service/src/edge-device/entities/edge-device.entity.ts:48-50`

### SPI Baglanti Semasi

RAK2287 modulu Raspberry Pi GPIO header'ina SPI0 uzerinden baglanir:

```
Raspberry Pi GPIO Header          RAK2287 Module
─────────────────────────          ──────────────
Pin 19 (GPIO10 / SPI0_MOSI) ────→ MOSI
Pin 21 (GPIO09 / SPI0_MISO) ←──── MISO
Pin 23 (GPIO11 / SPI0_SCLK) ────→ CLK
Pin 24 (GPIO08 / SPI0_CE0)  ────→ CS (Chip Select)
Pin 11 (GPIO17)              ────→ RESET
Pin 1  (3.3V)                ────→ VCC (veya 5V header'dan)
Pin 6  (GND)                 ────→ GND
```

> **ONEMLI**: GPIO17 varsayilan reset pinidir. Farkli bir pin kullaniliyorsa
> `config.yaml` dosyasinda `reset_gpio_pin` degeri guncellenmelidir.

### Anten

- EU868 icin 868 MHz anten gereklidir
- Anten olmadan TX yapmak modulu hasar verebilir
- Onerilen: 3 dBi fiberglas omni anten
- Kablo kaybi: RG58 kabloda ~0.3 dB/m (kisa tutun)

---

## Yazilim Bagimliliklari (Software Dependencies)

### Semtech SX1302 HAL

SX1302 concentrator ile iletisim icin Semtech'in C kutuphanesi gereklidir:

```bash
# HAL kaynak kodu vendor dizininde bulunur
ls /var/aqua-saas/sens-api-gateway/vendor/sx1302_hal/

# Icerik:
# libloragw/     - Concentrator gateway kutuphanesi
# libtools/      - Yardimci araclar
# packet_forwarder/ - Referans paket yonlendirici
```

### Rust Derleme (Cross-Compilation)

Edge agent, hedef platform icin cross-compile edilir:

```bash
# Hedef: Raspberry Pi (aarch64)
rustup target add aarch64-unknown-linux-gnu

# Cross-compiler toolchain
sudo apt-get install gcc-aarch64-linux-gnu

# LoRaWAN ozelligi ile derleme
cargo build --release \
  --target aarch64-unknown-linux-gnu \
  --features lorawan

# Ozellik bayraklari:
#   lorawan     - LoRaWAN concentrator destegi (SX1302 HAL dahil)
#   telemetry   - OpenTelemetry OTLP export (opsiyonel)
```

### Feature Flag Yapisi

`lorawan` feature flag'i aktif edildiginde:
- `src/lora/` altindaki tum moduller derlenir
- SX1302 HAL C kutuphanesi linklenir
- `AgentConfig`'e `lorawan` bolumu eklenir
- Process image'a `TagSource::LoRa` eklenir

---

## Konfigurasyon (Configuration)

### Tam config.yaml Ornegi

```yaml
# /etc/suderra/config.yaml
# LoRaWAN destekli edge agent konfigurasyonu

device_id: "fd23af6b-167f-4afd-a62a-ceace2a4046b"
device_code: "PI-32F7A01B"
api_url: "https://app.suderra.com"

mqtt:
  broker: "mqtt.suderra.com"
  port: 8883
  keepalive_secs: 60
  clean_session: false
  tls:
    enabled: true
    ca_cert_path: "/etc/suderra/certs/ca.pem"

telemetry:
  interval_seconds: 30
  io_data_interval_ms: 1000
  include_cpu: true
  include_memory: true

# LoRaWAN Concentrator Konfigurasyonu
lorawan:
  enabled: true
  region: "EU868"
  net_id: "000000"
  spi_device: "/dev/spidev0.0"
  reset_gpio_pin: 0               # 0 = reset kullanilmaz, GPIO17 icin 17 yazin
  max_devices: 100                 # varsayilan: 100
  session_db_path: "/var/lib/suderra/lora_sessions.db"

  # Kayitli LoRa cihazlari
  devices:
    # pH Sensoru - OTAA aktivasyon
    - dev_eui: "0011223344556677"
      app_eui: "0000000000000000"
      app_key: "00112233445566778899AABBCCDDEEFF"
      activation: "otaa"
      device_class: "A"
      tag_prefix: "LORA_PH_01"
      codec: "cayenne_lpp"
      adr_enabled: true

    # Sicaklik + Nem Sensoru
    - dev_eui: "AABBCCDDEEFF0011"
      app_eui: "0000000000000000"
      app_key: "FFEEDDCCBBAA99887766554433221100"
      activation: "otaa"
      device_class: "A"
      tag_prefix: "LORA_TH_01"
      codec: "cayenne_lpp"
      adr_enabled: true

    # Vana Kontrolor - Class C (surekli dinleme)
    - dev_eui: "1122334455667788"
      app_eui: "0000000000000000"
      app_key: "AABBCCDDEEFF00112233445566778899"
      activation: "otaa"
      device_class: "C"
      tag_prefix: "LORA_VALVE_01"
      codec: "raw_binary"
      adr_enabled: false
      rx1_delay_secs: 1
      rx2_datarate: 0
      rx2_freq_hz: 869525000

# Mevcut Modbus/GPIO/I2C konfigurasyonu da ayni dosyada
modbus: []
gpio: []
i2c: []
```

### Konfigurasyon Parametreleri Detayi

| Parametre | Tip | Varsayilan | Aciklama |
|-----------|-----|-----------|----------|
| `enabled` | bool | `false` | LoRaWAN modulunu etkinlestir |
| `region` | string | `"EU868"` | Frekans bolge plani (EU868, US915, AU915, AS923, KR920, IN865) |
| `net_id` | string | `"000000"` | 3-byte ag kimligi (ozel aglar icin) |
| `spi_device` | string | `"/dev/spidev0.0"` | SPI bus cihaz yolu |
| `reset_gpio_pin` | u8 | `0` | SX1302 reset GPIO pin numarasi (0 = reset kullanilmaz) |
| `max_devices` | usize | `100` | Maksimum kayitli cihaz sayisi |
| `session_db_path` | string | `"/var/lib/suderra/lora_sessions.db"` | SQLCipher oturum DB dosya yolu |

### Cihaz Konfigurasyon Parametreleri

| Parametre | Tip | Zorunlu | Aciklama |
|-----------|-----|---------|----------|
| `dev_eui` | string(16) | Evet | 64-bit cihaz kimligi (hex) |
| `app_eui` | string(16) | Evet | 64-bit uygulama kimligi (hex) |
| `app_key` | string(32) | Evet (OTAA) | 128-bit root sifreleme anahtari (hex) |
| `activation` | enum | Evet | `"otaa"` veya `"abp"` |
| `device_class` | enum | Evet | `"A"`, `"B"`, veya `"C"` |
| `tag_prefix` | string | Evet | I/O tag isimlendirme on eki |
| `codec` | enum | Evet | `"cayenne_lpp"`, `"raw_binary"`, veya `"custom"` |
| `adr_enabled` | bool | Hayir | Adaptive Data Rate (varsayilan: true) |
| `rx1_delay_secs` | u32 | Hayir | RX1 pencere gecikmesi (varsayilan: 1) |
| `rx2_datarate` | u8 | Hayir | RX2 veri hizi (varsayilan: bolgeye gore) |
| `rx2_freq_hz` | u32 | Hayir | RX2 frekans Hz cinsinden |

> Kaynak: `/var/aqua-saas/sens-api-gateway/src/lora/types.rs:302-327` (LoRaDeviceConfig)

---

## Cihaz Ekleme Akisi (Device Provisioning Flow)

### Adim 1: Frontend — Cihaz Ekleme Formu

Kullanici, sensor modulundeki Edge Device detay sayfasinda "LoRa" sekmesine gider ve "Cihaz Ekle" butonuna tiklar.

Gerekli bilgiler:
- **DevEUI**: Cihaz uzerindeki etiketten okunur (16 hex karakter)
- **AppKey**: Uretici tarafindan verilen root key (32 hex karakter)
- **Isim**: Kullanici dostu ad (orn: "Havuz-3 pH Sensoru")
- **Tag Prefix**: I/O tag on eki (orn: "LORA_PH_03")
- **Aktivasyon**: OTAA (onerilen) veya ABP
- **Sinif**: A (pil tasarruflu) veya C (surekli dinleme)
- **Codec**: cayenne_lpp (standart) veya raw

Hook: `/var/aqua-saas/web/modules/sensor-module/src/hooks/useLoRaDevices.ts:113-136`

### Adim 2: Backend — DB Kayit ve MQTT Komut

```
Frontend                          Backend
    │                                │
    │── addLoRaDevice mutation ────→│
    │   {edgeDeviceId, input}        │
    │                                │
    │                          1. Input validasyonu
    │                          2. DevEUI benzersizlik kontrolu
    │                          3. lora_devices tablosuna INSERT
    │                          4. MQTT command publish:
    │                             topic: tenants/{tid}/devices/{did}/commands
    │                             payload: {
    │                               command: "update_lora_devices",
    │                               devices: [yeni cihaz konfig...]
    │                             }
    │                                │
    │←── LoRaDevice response ────────│
```

GraphQL mutation: `/var/aqua-saas/web/modules/sensor-module/src/graphql/lora-device.queries.ts:34-51`

### Adim 3: Agent — Cihaz Kaydini Guncelle

```
Agent commands.rs:
    │
    │← MQTT "update_lora_devices" komutu
    │
    ├── Yeni cihaz konfigurasyonunu parse et
    ├── LoRaDeviceConfig olustur
    ├── LoRaHandle.add_device() cagir
    ├── Whitelist'e DevEUI ekle
    └── MQTT response gonder: {success: true}
```

### Adim 4: Cihaz — OTAA Join

```
LoRa Cihaz                     Edge Agent
    │                               │
    │  Guc ac / Reset               │
    │                               │
    │── Join Request ──────────────→│
    │   PHYPayload:                  │
    │     MHDR (JoinReq=0x00)       │
    │     AppEUI (8B)                │
    │     DevEUI (8B)                │
    │     DevNonce (2B, rastgele)   │
    │     MIC (4B, AppKey ile)       │
    │                               │
    │                          mac.rs:
    │                          1. DevEUI whitelist kontrolu ✓
    │                          2. AppKey ile MIC dogrula ✓
    │                          3. DevNonce tekrar kontrolu ✓
    │                          4. DevAddr ata (NetID + rastgele)
    │                          5. AppNonce uret (rastgele 3B)
    │                          6. NwkSKey & AppSKey turet
    │                          7. session.rs → SQLite kaydet
    │                               │
    │←── Join Accept ────────────────│
    │   PHYPayload:                  │
    │     MHDR (JoinAccept=0x20)    │
    │     AppNonce (3B)              │
    │     NetID (3B)                 │
    │     DevAddr (4B)               │
    │     DLSettings (1B)            │
    │     RxDelay (1B)               │
    │     CFList (opsiyonel, 16B)    │
    │     MIC (4B)                   │
    │   (Tumu AppKey ile sifrelenmis)│
    │                               │
    │  RX1 veya RX2 penceresinde    │
    │  alinir                       │
    │                               │
    │── Ilk Uplink ────────────────→│  ← Veri akisi baslar
```

### Adim 5: Veri Akisi Baslar

Join tamamlandiginda:
1. Agent, MQTT uzerinden `lora_events` topic'ine `join_accept` olayini yayinlar
2. Backend, `lora_devices` tablosunda `isJoined=true`, `devAddr`, `joinedAt` gunceller
3. Cihaz periyodik uplink gondermaya baslar
4. Decoded degerler process image'a yazilir
5. io_data topic'i uzerinden backend'e iletilir
6. WebSocket ile frontend'de canli goruntulenir

---

## Sorun Giderme (Troubleshooting)

### SX1302 Baslatilamiyor (SPI Init Failure)

**Belirti**: Agent baslatildiginda "SX1302 init failed" veya "SPI open failed" hatasi.

**Cozum**:
```bash
# 1. SPI arayuzunun etkin olup olmadigini kontrol et
ls /dev/spidev0.*
# Beklenen: /dev/spidev0.0

# 2. SPI etkin degilse raspi-config ile etkinlestir
sudo raspi-config nonint do_spi 0

# 3. SPI modul yuklu mu?
lsmod | grep spi
# Beklenen: spi_bcm2835

# 4. GPIO reset pini kontrolu
# GPIO17'nin baska bir islem tarafindan kullanilmadiginden emin ol
cat /sys/class/gpio/gpio17/direction 2>/dev/null || echo "Pin serbest"
```

### Paket Alinmiyor (No Packets Received)

**Belirti**: Agent calisiyor ama `LoRaStats.packets_received` sifir.

**Cozum**:
1. **Anten kontrolu**: 868 MHz anten baglanmis mi? Dogru frekans bandi mi?
2. **Frekans uyusmazligi**: Cihaz ve gateway ayni bolgede mi? (EU868 vs US915)
3. **Mesafe**: Cihaz cok uzakta mi? Ilk testleri yakin mesafede yapin
4. **SX1302 durumu**: Agent logundan "SX1302 started" mesajini dogrulayin
5. **RF parazit**: Diger 868 MHz cihazlardan parazit olabilir

### Join Zaman Asimi (Join Timeout)

**Belirti**: Cihaz join-request gonderiyor ama join-accept alamiyor.

**Cozum**:
1. **AppKey uyusmazligi**: Cihaz ve agent konfigurasyonundaki AppKey ayni mi?
2. **AppEUI uyusmazligi**: OTAA icin AppEUI de eslesmelidir
3. **DevEUI whitelist**: Cihazin DevEUI'si konfigurasyonda tanimli mi?
4. **RX penceresi**: Downlink gonderilebilmesi icin cihaz join-request sonrasi RX1 (1s) veya RX2 (2s) penceresinde dinlemelidir
5. **Duty cycle**: EU868'de gateway duty cycle sinirini asmis olabilir

### CRC Hatalari (CRC Errors)

**Belirti**: `LoRaStats.crc_errors` yuksek.

**Cozum**:
1. **RF parazit**: 868 MHz bandinda baska verici var mi?
2. **Anten sorunu**: Anten baglantisi gevsk mi? Kablo hasarli mi?
3. **Mesafe**: Cihaz kapsama alaninin sinirinda mi? RSSI < -120 dBm ise sorunlu
4. **Obstruksiyon**: Metal yapilar, su kutleleri RF sinyali zayiflatir

### Frame Counter Sifirlama

**Belirti**: Daha once calisan cihaz artik veri gonderemiyor.

**Cozum**:
Cihaz guc kesintisi yasadiysa frame counter sifirlanmis olabilir. Agent eski (daha yuksek) counter degerini beklediginden paketleri reddeder.

```bash
# Cozum: Cihazin oturumunu sifirla (yeniden join gerekir)
# Bu islem agent komut arayuzunden yapilabilir veya
# session DB'den ilgili cihaz silinir
```

Alternatif olarak cihazi silip yeniden eklemek de join'i tetikler.

### Agent Log Analizi

```bash
# Agent loglarini incele
tail -f /var/log/suderra-agent.log

# LoRa ile ilgili loglari filtrele
grep -i "lora\|sx1302\|join\|uplink" /var/log/suderra-agent.log

# Beklenen basarili baslangic loglari:
# [INFO] SX1302 concentrator started on spi0
# [INFO] LoRa module initialized: EU868, 8 channels
# [INFO] Loaded 3 LoRa device configurations

# Beklenen join loglari:
# [INFO] Join request from DevEUI 0011223344556677
# [INFO] Join accept sent to DevEUI 0011223344556677, DevAddr 26XXXXXX
```

---

## Hizli Baslangic Kontrol Listesi

- [ ] RAK2287 modulu Raspberry Pi GPIO header'ina takildi
- [ ] 868 MHz anten baglandi
- [ ] SPI arayuzu etkinlestirildi (`/dev/spidev0.0` mevcut)
- [ ] Agent `--features lorawan` ile derlendi
- [ ] `config.yaml` dosyasinda `lorawan.enabled: true` ayarlandi
- [ ] En az bir cihaz `lorawan.devices[]` altinda tanimlandi
- [ ] `session_db_path` dizini mevcut ve yazilabilir
- [ ] Backend'de edge device modeli `raspberry_pi_4_lora` veya `raspberry_pi_5_lora` olarak ayarlandi
- [ ] Agent baslatildi ve "SX1302 started" logu goruldu
- [ ] LoRa cihaz guc verildi ve join-accept alindi
