# MQTT Client - Profesyonel Yapı Konfigürasyonu

## Mevcut Alanlar (✅)
- Broker
- Port
- Topic
- QoS Level
- Client ID
- Username
- Password
- Use TLS (checkbox)

---

## Eksik Alanlar ve Açıklamaları

### 1. TEMEL BAĞLANTI AYARLARI

#### Keep Alive (Zorunlu)
- **Tip:** Number (saniye)
- **Default:** 60
- **Açıklama:** Broker ile bağlantı kontrolü için ping interval. Client ve broker arasında ne kadar süre mesaj gönderilmezse PING/PONG mesajı gönderilir.
- **Önerilen:** 30-120 saniye arası

#### Clean Session (Önemli)
- **Tip:** Checkbox/Boolean
- **Default:** true
- **Açıklama:** 
  - `true`: Her bağlantıda yeni session başlar, önceki session silinir
  - `false`: Session saklanır, offline mesajlar ve subscription'lar korunur
- **Kullanım:** IoT sensörlerde `false` kullan (offline mesajları kaybetmemek için)

#### Connection Timeout
- **Tip:** Number (saniye)
- **Default:** 30
- **Açıklama:** Bağlantı kurma işlemi için maksimum bekleme süresi

#### Protocol Version
- **Tip:** Dropdown/Select
- **Seçenekler:**
  - MQTT 3.1 (Eski/Legacy)
  - MQTT 3.1.1 (En yaygın - Default)
  - MQTT 5.0 (Yeni özellikler)
- **Önerilen:** 3.1.1 (en iyi uyumluluk)

---

### 2. TLS/SSL DETAYLARI (Use TLS = true ise)

#### CA Certificate File
- **Tip:** File Upload (optional)
- **Format:** .pem, .crt, .cer
- **Açıklama:** Broker'ın sertifikasını doğrulamak için root CA certificate
- **Kullanım:** Self-signed certificate kullanıyorsan gerekli

#### Client Certificate
- **Tip:** File Upload (optional)
- **Format:** .pem, .crt
- **Açıklama:** İki yönlü TLS authentication için client certificate
- **Kullanım:** Mutual TLS (mTLS) gerektiren broker'lar için

#### Client Private Key
- **Tip:** File Upload (optional)
- **Format:** .pem, .key
- **Açıklama:** Client certificate'in private key dosyası
- **Kullanım:** Client certificate ile birlikte kullanılır

#### TLS Version
- **Tip:** Dropdown/Select
- **Seçenekler:**
  - TLSv1.0 (Güvensiz - kullanma)
  - TLSv1.1 (Deprecated)
  - TLSv1.2 (Önerilen)
  - TLSv1.3 (En güvenli)
- **Default:** TLSv1.2

#### Verify Certificate (Reject Unauthorized)
- **Tip:** Checkbox/Boolean
- **Default:** true
- **Açıklama:** 
  - `true`: Certificate doğrulaması yap (production için)
  - `false`: Self-signed cert'leri kabul et (test için)

---

### 3. LAST WILL AND TESTAMENT (LWT)

**Önem:** IoT uygulamaları için kritik! Cihaz beklenmedik şekilde disconnect olduğunda broker otomatik olarak belirlenen mesajı gönderir.

#### Will Topic
- **Tip:** String (optional)
- **Örnek:** `sensors/temperature_01/status`
- **Açıklama:** Client disconnect olursa bu topic'e mesaj gönderilir

#### Will Message (Will Payload)
- **Tip:** String/JSON (optional)
- **Örnek:** `{"status": "offline", "timestamp": 1234567890}`
- **Açıklama:** Gönderilecek mesaj içeriği

#### Will QoS
- **Tip:** Dropdown (0/1/2)
- **Default:** 1
- **Açıklama:** Will mesajının QoS seviyesi

#### Will Retain
- **Tip:** Checkbox/Boolean
- **Default:** true
- **Açıklama:** Will mesajı broker'da saklansın mı?
- **Önerilen:** `true` (status mesajları için)

**Örnek LWT Kullanımı:**
```json
{
  "will": {
    "topic": "sensors/tank01/status",
    "message": "{\"status\":\"offline\",\"reason\":\"connection_lost\"}",
    "qos": 1,
    "retain": true
  }
}
```

---

### 4. PUBLISH AYARLARI

#### Retain Flag
- **Tip:** Checkbox/Boolean (her publish için)
- **Default:** false
- **Açıklama:** 
  - `true`: Mesaj broker'da saklanır, yeni subscriber'lar son mesajı alır
  - `false`: Sadece o anda bağlı subscriber'lara gönderilir
- **Kullanım:** Son sensör değerini saklamak için `true` kullan

#### Message Format
- **Tip:** Dropdown/Select
- **Seçenekler:**
  - Plain Text
  - JSON
  - Hex
  - Base64
  - Binary
- **Default:** JSON (IoT için önerilen)

#### Topic Validation
- **Açıklama:** Topic format kontrolü (wildcard karakterleri publish'de kullanılmamalı)
- **Geçersiz:** `sensors/+/temperature`, `sensors/#`
- **Geçerli:** `sensors/tank01/temperature`

---

### 5. SUBSCRIBE AYARLARI

#### Subscribe Topics List
- **Tip:** Array/List of Objects
- **Yapı:**
```json
[
  { "topic": "sensors/+/temperature", "qos": 1 },
  { "topic": "sensors/tank01/#", "qos": 0 },
  { "topic": "alerts/#", "qos": 2 }
]
```

#### Wildcard Support
- **Single-level wildcard (+):** `sensors/+/temperature` → `sensors/tank01/temperature`, `sensors/tank02/temperature`
- **Multi-level wildcard (#):** `sensors/#` → tüm sensors altındaki tüm topic'ler

#### Per-Topic QoS
- Her subscription için ayrı QoS seviyesi belirlenebilmeli

---

### 6. AUTO RECONNECT (Kritik)

#### Auto Reconnect Enable
- **Tip:** Checkbox/Boolean
- **Default:** true
- **Açıklama:** Bağlantı koptuğunda otomatik olarak yeniden bağlan

#### Reconnect Interval (Reconnect Period)
- **Tip:** Number (saniye veya milisaniye)
- **Default:** 5000 ms (5 saniye)
- **Açıklama:** Bağlantı kopunca kaç saniye sonra tekrar bağlanmayı dene

#### Max Reconnect Attempts
- **Tip:** Number
- **Default:** 10
- **Özel:** 0 = sonsuz deneme
- **Açıklama:** Maksimum yeniden bağlanma denemesi sayısı

#### Exponential Backoff
- **Tip:** Checkbox/Boolean (advanced)
- **Default:** false
- **Açıklama:** Her başarısız denemede bekleme süresini artır (5s, 10s, 20s, 40s...)

---

### 7. MQTT 5.0 ÖZELLİKLERİ (Opsiyonel - Sadece MQTT 5.0 seçiliyse göster)

#### Session Expiry Interval
- **Tip:** Number (saniye)
- **Açıklama:** Session'ın ne kadar süre saklanacağı (0 = bağlantı kesilince sil)

#### Request Response Information
- **Tip:** Checkbox/Boolean
- **Açıklama:** Broker'dan response topic bilgisi iste

#### Request Problem Information
- **Tip:** Checkbox/Boolean
- **Açıklama:** Hata durumunda detaylı bilgi iste

#### User Properties
- **Tip:** Key-Value Pairs (JSON Object)
- **Örnek:**
```json
{
  "device_type": "temperature_sensor",
  "firmware_version": "1.2.3",
  "location": "Tank-01"
}
```

#### Maximum Packet Size
- **Tip:** Number (bytes)
- **Açıklama:** İzin verilen maksimum paket boyutu

#### Topic Alias Maximum
- **Tip:** Number
- **Açıklama:** Kullanılabilecek maksimum topic alias sayısı

---

### 8. UI/UX GELİŞTİRMELERİ

#### Connection Status Indicator
- **Gösterim:**
  - 🔴 Disconnected
  - 🟡 Connecting...
  - 🟢 Connected
  - 🟠 Reconnecting...
  - ⚫ Error

#### Connection Profiles/Presets
- **Açıklama:** Farklı broker ayarlarını kaydet ve hızlıca yükle
- **Örnekler:**
  - "Production Tank Monitor"
  - "Test Environment"
  - "Local Development"

#### Test Connection Button
- **İşlev:** Ayarları kaydetmeden önce bağlantıyı test et
- **Sonuç:** Başarılı/Başarısız + hata mesajı

#### Save/Load Configuration
- **Format:** JSON veya YAML
- **İşlevler:**
  - Export: Ayarları dosyaya kaydet
  - Import: Dosyadan ayarları yükle
  - Share: Ayarları başka client'a aktar

#### Message History/Log
- **İçerik:**
  - Timestamp
  - Direction (Sent/Received)
  - Topic
  - Payload
  - QoS
  - Retain flag
- **Özellikler:**
  - Filtreleme (topic, direction)
  - Export to CSV/JSON
  - Clear log
  - Max log size

#### Statistics/Metrics
- **Gösterimler:**
  - Total messages sent
  - Total messages received
  - Connection uptime
  - Last message timestamp
  - Average message rate

---

## ÖRNK KONFİGÜRASYON ŞABLONLARı

### 1. Aquaculture Sensör Monitoring (Production)

```json
{
  "name": "Tank Temperature Monitoring",
  "broker": "mqtt.oceanfarm.com",
  "port": 8883,
  "clientId": "tank_sensor_001",
  "username": "sensor_user",
  "password": "***",
  
  "useTLS": true,
  "caCert": "/path/to/ca.pem",
  "rejectUnauthorized": true,
  "tlsVersion": "TLSv1.2",
  
  "keepAlive": 60,
  "cleanSession": false,
  "connectTimeout": 30,
  "protocolVersion": 4,
  
  "will": {
    "topic": "sensors/tank01/status",
    "payload": "{\"status\":\"offline\",\"tank\":\"Tank-01\"}",
    "qos": 1,
    "retain": true
  },
  
  "autoReconnect": true,
  "reconnectPeriod": 5000,
  "maxReconnectAttempts": 0,
  
  "defaultQoS": 1,
  "defaultRetain": true,
  
  "subscriptions": [
    { "topic": "sensors/tank01/temperature", "qos": 1 },
    { "topic": "sensors/tank01/ph", "qos": 1 },
    { "topic": "sensors/tank01/oxygen", "qos": 1 },
    { "topic": "alerts/tank01/#", "qos": 2 }
  ]
}
```

### 2. Test/Development Environment

```json
{
  "name": "Local Testing",
  "broker": "localhost",
  "port": 1883,
  "clientId": "test_client_001",
  "username": "",
  "password": "",
  
  "useTLS": false,
  
  "keepAlive": 60,
  "cleanSession": true,
  "connectTimeout": 10,
  "protocolVersion": 4,
  
  "will": null,
  
  "autoReconnect": true,
  "reconnectPeriod": 3000,
  "maxReconnectAttempts": 5,
  
  "defaultQoS": 0,
  "defaultRetain": false
}
```

### 3. Public Broker (EMQX)

```json
{
  "name": "EMQX Public Test",
  "broker": "broker.emqx.io",
  "port": 1883,
  "clientId": "test_" + Math.random().toString(16).substr(2, 8),
  "username": "",
  "password": "",
  
  "useTLS": false,
  
  "keepAlive": 60,
  "cleanSession": true,
  "connectTimeout": 30,
  "protocolVersion": 4,
  
  "autoReconnect": true,
  "reconnectPeriod": 5000,
  "maxReconnectAttempts": 3
}
```

---

## MİNİMUM PROFESYONEl YAPI

### Mutlaka Olması Gerekenler (Priority 1)
1. ✅ Broker
2. ✅ Port
3. ✅ Client ID
4. ✅ Username / Password
5. ✅ TLS Toggle
6. ❌ **Keep Alive**
7. ❌ **Clean Session**
8. ❌ **Auto Reconnect**
9. ❌ **QoS Level**
10. ❌ **Retain Flag**

### Önerilen Eklemeler (Priority 2)
11. ❌ **Last Will (LWT)** - IoT için kritik!
12. ❌ Connection Timeout
13. ❌ Protocol Version
14. ❌ Test Connection Button
15. ❌ Connection Status

### Advanced Features (Priority 3)
16. ❌ TLS Certificates (CA, Client Cert, Key)
17. ❌ Connection Profiles
18. ❌ Message History/Log
19. ❌ Save/Load Config
20. ❌ Subscribe Topics List
21. ❌ Statistics

---

## AQUACULTURE SENSOR MONITORING İÇİN ÖZEL ÖNERİLER

### Kritik Ayarlar
1. **Last Will & Testament (LWT)**
   - Sensör offline olduğunda alarm sistemi tetiklensin
   - `will.topic`: `sensors/{tank_id}/status`
   - `will.payload`: `{"status":"offline","alarm":true}`

2. **Retain Flag = true**
   - Son sensör değeri her zaman okunabilsin
   - Dashboard'a yeni bağlanınca son değerleri hemen görebilsin

3. **Clean Session = false**
   - Network kesintilerinde offline gelen mesajları kaybetme
   - Critical alarm'ları mutlaka al

4. **Auto Reconnect = true**
   - Network kesintilerinde otomatik tekrar bağlan
   - Deniz ortamında network stabilitesi düşük olabilir

5. **QoS = 1 (en az)**
   - Sensör verisi kaybolmasın
   - Temperature, pH, O2 gibi kritik değerler için QoS 1 veya 2

### Topic Yapısı Önerisi
```
sensors/{location}/{tank_id}/{measurement_type}
sensors/oceanfarm/tank01/temperature
sensors/oceanfarm/tank01/ph
sensors/oceanfarm/tank01/oxygen
sensors/oceanfarm/tank01/salinity
sensors/oceanfarm/tank01/status

alerts/{location}/{tank_id}/{alert_type}
alerts/oceanfarm/tank01/temperature_high
alerts/oceanfarm/tank01/oxygen_low
```

---

## FORM TASARIM ÖNERİLERİ

### Gruplandırma (Tabs/Accordions)

#### Tab 1: Connection
- Broker, Port, Client ID
- Username, Password
- Protocol Version
- Test Connection Button

#### Tab 2: TLS/Security
- Use TLS checkbox
- TLS Version
- CA Certificate
- Client Certificate & Key
- Verify Certificate

#### Tab 3: Options
- Keep Alive
- Clean Session
- Connection Timeout
- Auto Reconnect Settings

#### Tab 4: Last Will (LWT)
- Enable LWT checkbox
- Will Topic
- Will Message
- Will QoS
- Will Retain

#### Tab 5: Publish/Subscribe
- Default QoS
- Default Retain
- Subscribe Topics List

#### Tab 6: Advanced (MQTT 5.0)
- Session Expiry
- User Properties
- Maximum Packet Size

---

## VALİDASYON KURALLARI

### Client ID
- Boş olamaz
- Max 23 karakter (MQTT 3.1.1)
- Özel karakterler: a-z, A-Z, 0-9, -, _

### Broker
- Valid hostname veya IP address
- Regex: `^[a-zA-Z0-9.-]+$`

### Port
- 1-65535 arası
- Yaygın portlar: 1883 (TCP), 8883 (TLS), 8083 (WS), 8084 (WSS)

### Topic
- Boş olamaz
- "/" ile hiyerarşi
- Publish: wildcard (+, #) kullanılamaz
- Subscribe: wildcard kullanılabilir
- Max 65535 byte

### Keep Alive
- 0-65535 saniye
- 0 = devre dışı
- Önerilen: 30-120 saniye

### QoS
- 0: At most once (fire and forget)
- 1: At least once (acknowledged delivery)
- 2: Exactly once (assured delivery)

---

## HATA MESAJLARI

### Connection Errors
- `ECONNREFUSED`: Broker'a ulaşılamıyor (port/broker kontrol)
- `ETIMEDOUT`: Connection timeout (network/firewall kontrol)
- `ENOTFOUND`: Broker hostname çözülemedi (DNS kontrol)

### Authentication Errors
- `Not authorized`: Username/password yanlış
- `Bad username or password`: Credentials geçersiz
- `Connection refused, identifier rejected`: Client ID sorunu

### TLS Errors
- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`: CA certificate eksik/yanlış
- `SELF_SIGNED_CERT_IN_CHAIN`: Self-signed cert, verify=false yap
- `CERT_HAS_EXPIRED`: Certificate süresi dolmuş

---

## KAYNAKLAR

### Public Test Brokers
- **EMQX:** broker.emqx.io:1883
- **HiveMQ:** broker.hivemq.com:1883
- **Mosquitto:** test.mosquitto.org:1883

### MQTT Tools
- **MQTT Explorer:** GUI client (mqtt-explorer.com)
- **MQTTX:** Modern client (mqttx.app)
- **Mosquitto CLI:** Command-line tools

### Documentation
- **MQTT 3.1.1 Spec:** https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/
- **MQTT 5.0 Spec:** https://docs.oasis-open.org/mqtt/mqtt/v5.0/
- **Paho Clients:** https://www.eclipse.org/paho/

---



**Öncelik sırası ile ekleyin:**
1. Keep Alive, Clean Session, Auto Reconnect
2. Last Will & Testament (LWT)
3. Retain Flag
4. TLS Certificate options
5. Connection Profiles
6. Message History/Log

---

## Edge → Cloud Telemetri Zarfı — İdempotenlik Anahtarı (EDGE-CRITICAL-004)

Edge agent, telemetri sınıfı her yayını (`io_data`, `telemetry`, `alarms`,
`status`) tek yayın noktasından geçirir ve her zarfa iki üst-seviye alan
ekler:

| Alan | Tip | Anlam |
|---|---|---|
| `device_id` | string (UUID) | Cihaz kimliği. Zarfı topic ayrıştırmasına bağlı olmaktan çıkarır; kendi kendine yeterli kılar. |
| `edge_seq` | u64 | Cihaz başına **kesin monoton, yeniden-kullanılmayan** dizi. Kalıcı (SQLite yüksek-su-işareti) olduğundan yeniden başlatmaya dayanır. |

`(device_id, edge_seq)` çifti **global olarak benzersiz idempotenlik
anahtarıdır**. Store-and-forward kuyruğu bağlantı koptuğunda mesajı
diske alır ve yeniden bağlanınca **aynı baytları** tekrar yayınlar —
bu yüzden bir tekrar (replay) ilk teslimatla **aynı `edge_seq`'i** taşır.

### Tüketici (backend) sözleşmesi

Backend tüketici, `io_data` ve `alarms` mesajlarını kalıcılaştırmadan
**önce** `(device_id, edge_seq)` ile deduplike ETMELİDİR: daha önce
görülmüş bir çift atlanmalıdır. Aksi halde bir drain-replay yeni bir
satır olarak ingest edilir (çift-sayım / tekrar-tetiklenen alarm).

> **Uyum notu:** Alanlar tamamen eklemeli (additive) üst-seviye JSON
> anahtarlarıdır; mevcut tüketiciler bilinmeyen anahtarları yok sayar,
> dolayısıyla edge tarafı geriye dönük uyumlu şekilde bağımsız
> yayınlanabilir. Duplicate akışı yalnızca backend dedup'ı eklendiğinde
> kapanır (sensor-service — ayrı, izlenen iş).

İyi çalışmalar! 🚀