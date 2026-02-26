# Edge Device Zero-Touch Provisioning System

**Tarih:** 2026-02-13
**Durum:** Tasarım onaylandı, implementasyon bekliyor

---

## 1. Amaç

Frontend'den edge device eklendiğinde tek satırlık bir `curl | bash` komutu üretilir.
Bu komut endüstriyel PC'de çalıştırıldığında:
- GitHub Releases'dan Suderra Edge Agent binary'si indirilir
- Systemd servisi olarak kurulur
- Otomatik olarak ilgili tenant'a register olur
- MQTT bağlantısı kurulup cihaz "Aktif" duruma geçer

---

## 2. Genel Mimari

```
Frontend (Device Wizard)
    │
    ▼
Sensor Service ── createProvisionedDevice mutation
    │                 │
    │                 ├── Device kaydı oluşturur (REGISTERED)
    │                 ├── Tek kullanımlık token üretir (24h TTL)
    │                 └── Installer komutu döner
    │
    ▼
Gateway API ── GET /provisioning/install/:deviceId/:token (public, auth bypass)
    │
    │  Token doğrular → geçersizse 401 döner
    │  DB'den provisioning_settings okur
    │  Dinamik shell script üretir
    │
    ▼
Endüstriyel PC
    │
    ├── 1. Script çalışır
    │     ├── Root kontrolü
    │     ├── OS/mimari tespit (x86_64 / aarch64 / armv7)
    │     ├── GitHub Releases'dan binary indir
    │     ├── SHA256 checksum doğrula
    │     ├── /opt/suderra-agent/ altına kur
    │     ├── config.yaml oluştur (token, API URL, MQTT bilgileri gömülü)
    │     └── systemd servisi kur + başlat
    │
    ├── 2. Agent başlar
    │     ├── Token ile activation API'ye istek (POST /provisioning/activate)
    │     ├── Device fingerprint gönderir (CPU serial, MAC, machine ID)
    │     ├── MQTT credential'ları alır
    │     ├── Token "kullanıldı" olarak işaretlenir
    │     └── Device durumu: REGISTERED → PROVISIONING → ACTIVE
    │
    └── 3. Agent çalışır
          ├── MQTT broker'a bağlanır
          ├── Heartbeat gönderir
          └── Komut almaya hazır
```

---

## 3. Güvenlik

| Katman | Açıklama |
|--------|----------|
| **Token** | Tek kullanımlık, 24 saat TTL, cryptographic random (32 byte hex) |
| **HTTPS** | Installer script ve activation API sadece TLS üzerinden |
| **Checksum** | Binary SHA256 doğrulaması (release asset'ten) |
| **Fingerprint** | Activation sırasında CPU serial, MAC adresleri, machine ID kaydedilir |
| **Rate limit** | Per-IP sadece **hatalı token denemeleri** için (10/saat). Başarılı kayıtlar sınırlanmaz - aynı IP'den farklı token'larla birden fazla cihaz eklenebilir |
| **Token doğrulama** | Geçersiz/expired token'da script dönmez, 401 HTTP response |

**NOT:** Aynı IP'de birden fazla endüstriyel PC olabilir (NAT arkası). Her cihaz kendi unique link/token'ı ile kaydolur, IP bazlı cihaz limiti yoktur.

---

## 4. Admin Panel - Provisioning Ayarları

`system_settings` tablosunda key-value olarak saklanır (mevcut `GlobalSettingsService` kullanılır):

| Key | Örnek Değer | Açıklama |
|-----|-------------|----------|
| `provisioning_api_url` | `https://api.platform.com` | Activation API base URL |
| `mqtt_broker_host` | `mqtt.platform.com` | MQTT broker adresi |
| `mqtt_broker_port` | `8883` | MQTT port (TLS) |
| `github_release_url` | `https://github.com/org/aquaculture-platform/releases` | Binary indirme URL |
| `agent_default_version` | `latest` veya `v1.4.0` | Hangi versiyon indirilecek |
| `installer_script_version` | `v1` | Script format versiyonu |

- Admin panelden değiştirilebilir
- Sonraki üretilen linkler yeni değerleri kullanır
- Ortam geçişlerinde (staging → production) kod değişikliği gerekmez

---

## 5. CI/CD Pipeline (GitHub Actions)

**Trigger:** `v*` tag push (örn: `v1.4.0`)

**Jobs (paralel):**

| Target | Mimari | Kullanım |
|--------|--------|----------|
| `x86_64-unknown-linux-gnu` | x86_64 | Intel/AMD endüstriyel PC |
| `aarch64-unknown-linux-gnu` | aarch64 | RPi 4/5, Revolution Pi |
| `armv7-unknown-linux-gnueabihf` | armv7 | RPi 3, eski ARM cihazlar |

**Pipeline adımları:**
1. `cross` tool ile cross-compile
2. Binary strip (boyut küçültme, zaten `opt-level="z"` + LTO mevcut)
3. `tar.gz` olarak paketle
4. SHA256 checksum dosyası üret
5. GitHub Release oluştur, asset'leri upload et

**Release asset'ler:**
```
suderra-agent-v1.4.0-x86_64-linux.tar.gz
suderra-agent-v1.4.0-x86_64-linux.tar.gz.sha256
suderra-agent-v1.4.0-aarch64-linux.tar.gz
suderra-agent-v1.4.0-aarch64-linux.tar.gz.sha256
suderra-agent-v1.4.0-armv7-linux.tar.gz
suderra-agent-v1.4.0-armv7-linux.tar.gz.sha256
```

---

## 6. Installer Script (Dinamik)

`GET /provisioning/install/:deviceId/:token` endpoint'i şu script'i döner:

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Gömülü değişkenler (backend tarafından dinamik üretilir) ──
DEVICE_ID="__DEVICE_ID__"
TOKEN="__TOKEN__"
API_URL="__API_URL__"
MQTT_BROKER="__MQTT_BROKER__"
MQTT_PORT="__MQTT_PORT__"
GITHUB_RELEASE_URL="__GITHUB_RELEASE_URL__"
AGENT_VERSION="__AGENT_VERSION__"

INSTALL_DIR="/opt/suderra-agent"
BIN_PATH="${INSTALL_DIR}/bin/suderra-agent"
CONFIG_PATH="${INSTALL_DIR}/config.yaml"
SERVICE_NAME="suderra-agent"

# ── 1. Root kontrolü ──
if [ "$(id -u)" -ne 0 ]; then
  echo "HATA: Bu script root yetkisi gerektirir. 'sudo bash' ile çalıştırın."
  exit 1
fi

# ── 2. Mimari tespit ──
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  TARGET="x86_64-linux" ;;
  aarch64) TARGET="aarch64-linux" ;;
  armv7l)  TARGET="armv7-linux" ;;
  *)
    echo "HATA: Desteklenmeyen mimari: $ARCH"
    exit 1
    ;;
esac

echo ">> Suderra Edge Agent Installer"
echo ">> Mimari: $ARCH ($TARGET)"
echo ">> Versiyon: $AGENT_VERSION"

# ── 3. Binary indir ──
TARBALL="suderra-agent-${AGENT_VERSION}-${TARGET}.tar.gz"
CHECKSUM_FILE="${TARBALL}.sha256"
DOWNLOAD_URL="${GITHUB_RELEASE_URL}/download/${AGENT_VERSION}/${TARBALL}"
CHECKSUM_URL="${GITHUB_RELEASE_URL}/download/${AGENT_VERSION}/${CHECKSUM_FILE}"

echo ">> Binary indiriliyor: $DOWNLOAD_URL"
curl -fsSL -o "/tmp/${TARBALL}" "$DOWNLOAD_URL"
curl -fsSL -o "/tmp/${CHECKSUM_FILE}" "$CHECKSUM_URL"

# ── 4. Checksum doğrula ──
echo ">> SHA256 checksum doğrulanıyor..."
cd /tmp
sha256sum -c "$CHECKSUM_FILE"
if [ $? -ne 0 ]; then
  echo "HATA: Checksum doğrulama başarısız! İndirme bozulmuş olabilir."
  rm -f "/tmp/${TARBALL}" "/tmp/${CHECKSUM_FILE}"
  exit 1
fi

# ── 5. Kur ──
echo ">> Kuruluyor: $INSTALL_DIR"
mkdir -p "${INSTALL_DIR}/bin" "${INSTALL_DIR}/data"
tar -xzf "/tmp/${TARBALL}" -C "${INSTALL_DIR}/bin/"
chmod +x "$BIN_PATH"
rm -f "/tmp/${TARBALL}" "/tmp/${CHECKSUM_FILE}"

# ── 6. Config oluştur ──
cat > "$CONFIG_PATH" <<YAML
device_id: "${DEVICE_ID}"
provisioning_token: "${TOKEN}"
api_url: "${API_URL}"
mqtt:
  broker: "${MQTT_BROKER}"
  port: ${MQTT_PORT}
  use_tls: true
data_dir: "${INSTALL_DIR}/data"
log_level: "info"
YAML
chmod 600 "$CONFIG_PATH"

# ── 7. Systemd servisi ──
cat > /etc/systemd/system/${SERVICE_NAME}.service <<UNIT
[Unit]
Description=Suderra Edge Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=${BIN_PATH} --config ${CONFIG_PATH}
Restart=always
RestartSec=10
WatchdogSec=60
Environment=RUST_LOG=info

# Güvenlik
ProtectSystem=strict
ReadWritePaths=${INSTALL_DIR}/data
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# ── 8. Başlat ──
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

echo ""
echo ">> Suderra Edge Agent başarıyla kuruldu!"
echo ">> Device ID: $DEVICE_ID"
echo ">> Durum: systemctl status ${SERVICE_NAME}"
echo ">> Loglar: journalctl -u ${SERVICE_NAME} -f"
echo ""
echo ">> Agent otomatik olarak platforma kaydoluyor..."
```

---

## 7. Backend Değişiklikleri

### 7a. Sensor Service - Installer Endpoint

**Dosya:** `apps/sensor-service/src/edge-device/provisioning.controller.ts` (yeni)

```
GET /provisioning/install/:deviceId/:token
```

- Auth gerektirmez (gateway auth bypass)
- Token + deviceId doğrulaması yapar
- Geçersiz/expired token → 401
- Geçerli → DB'den provisioning settings okur → dinamik script döner
- Response header: `Content-Type: text/x-shellscript`

### 7b. createProvisionedDevice Mutation Güncelleme

Mevcut mutation gerçek installer komutu dönecek:

```typescript
{
  deviceId: "uuid",
  deviceCode: "IPC-A1B2C3D4",
  installerCommand: "curl -sSL https://api.platform.com/provisioning/install/DEVICE_ID/TOKEN | sudo bash",
  tokenExpiresAt: "2026-02-14T15:30:00Z",
  status: "REGISTERED"
}
```

### 7c. Gateway Auth Bypass

`/provisioning/install/*` route'u auth middleware'den muaf tutulur.

---

## 8. Frontend Değişiklikleri

### 8a. EdgeDeviceWizard - Installer Komutu Gösterimi

Device oluşturulduktan sonra:

```
┌─────────────────────────────────────────────────┐
│  ✓ Edge Device Oluşturuldu                      │
│                                                 │
│  Device Code: IPC-A1B2C3D4                      │
│  Durum: Kayıt bekliyor                          │
│                                                 │
│  Endüstriyel PC'de bu komutu çalıştırın:        │
│  ┌─────────────────────────────────────────────┐ │
│  │ curl -sSL https://api.platform.com/provisi │ │
│  │ oning/install/abc123/token456 | sudo bash   │ │
│  │                                    [Kopyala]│ │
│  └─────────────────────────────────────────────┘ │
│                                                 │
│  ⚠ Bu link 24 saat geçerlidir                   │
│  ⚠ Link tek kullanımlıktır                      │
│                                                 │
│  Token süresi: 14 Şubat 2026, 15:30            │
│                                                 │
│  [Cihaz Listesine Dön]    [Yeni Cihaz Ekle]    │
└─────────────────────────────────────────────────┘
```

### 8b. Admin Panel - Provisioning Settings Sayfası

System Settings altında yeni bir sekme/bölüm:
- Provisioning API URL
- MQTT Broker Host / Port
- GitHub Release URL
- Agent Default Version
- Kaydet butonu

---

## 9. Dosya Değişiklik Listesi

### Yeni dosyalar:
| Dosya | Açıklama |
|-------|----------|
| `.github/workflows/edge-agent-release.yml` | CI/CD pipeline |
| `apps/sensor-service/src/edge-device/provisioning.controller.ts` | Installer script endpoint |
| `apps/sensor-service/src/edge-device/installer-script.template.ts` | Script template |

### Değiştirilecek dosyalar:
| Dosya | Değişiklik |
|-------|-----------|
| `apps/sensor-service/src/edge-device/edge-device.module.ts` | ProvisioningController register |
| `apps/sensor-service/src/edge-device/edge-device.service.ts` | createProvisionedDevice gerçek URL döner |
| `apps/sensor-service/src/edge-device/provisioning.service.ts` | Settings'den config okuma |
| `apps/gateway-api/src/app.module.ts` | Auth bypass route ekleme |
| `apps/admin-api-service/src/settings/` | Provisioning settings CRUD |
| `web/modules/sensor-module/src/` | Wizard'da installer komutu gösterimi |
| `web/modules/admin-panel/src/` | Provisioning settings sayfası |

---

## 10. Implementasyon Sırası

1. **CI/CD** - GitHub Actions workflow (bağımsız, hemen başlanabilir)
2. **Admin Settings** - Provisioning ayarları backend + frontend
3. **Installer Endpoint** - Script üreten REST endpoint
4. **createProvisionedDevice** - Gerçek URL dönecek şekilde güncelle
5. **Gateway** - Auth bypass
6. **Frontend** - Wizard'da komutu göster
7. **Test** - Uçtan uca test (device ekle → komut kopyala → PC'de çalıştır → register)

---

## Notlar

- Mevcut provisioning.rs (Rust tarafı) zaten token-based activation destekliyor, değişiklik gerekmez
- Mevcut DeviceActivationRequest/Response DTO'ları yeterli
- Bulk provisioning (TenantProvisioningKey) aynı pattern'i kullanabilir, sadece URL formatı farklı olur
- Agent güncelleme mekanizması (OTA) bu tasarımın dışında, sonraki iterasyonda ele alınabilir

---

## Changelog (2026-02-26)

### Bug Fix: Install endpoint 400 "Tenant ID is required"

**Sorun:** `curl -sSL https://app.suderra.com/install/EDGE-XXX | sudo bash` komutu
`{"statusCode":400,"message":"Tenant ID is required"}` hatası veriyordu.

**Kök neden:** `ProvisioningController` üzerinde `@SkipTenantGuard()` dekoratörü eksikti.
Global `TenantGuard` (APP_GUARD) anonim curl isteğini tenant context'i olmadığı için reddediyordu.

**Düzeltme:** `provisioning.controller.ts`'ye `@SkipTenantGuard()` eklendi.
Import: `import { SkipTenantGuard } from '@platform/backend-common';`

**Güvenlik:** Controller kendi güvenlik katmanlarına sahip (rate limit, token validasyonu,
device code format regex), TenantGuard bypass'ı güvenlik açığı oluşturmaz.

### Bug Fix: Installer URL'de token eksik

**Sorun:** `buildInstallerUrl()` ve `buildInstallerCommand()` provisioning token'ı
URL'ye eklemiyordu ama controller `?token=` zorunlu tutuyordu.

**Düzeltme:** Her iki metoda `token?` parametresi eklendi, URL'ye `?token=` ekleniyor.
Frontend `InstallerCommandModal` mask fonksiyonu da `?token=` formatını maskeleliyor.

### Bug Fix: Cihaz Modeli seçilince "Bad Request"

**Sorun:** Yeni edge device eklerken Cihaz Modeli seçilirse "Bad Request" hatası,
seçilmezse başarılı.

**Kök neden:** `CreateProvisionedDeviceInput` DTO'sunun alanlarında class-validator
dekoratörleri (`@IsOptional()`, `@IsEnum()`, `@IsString()` vb.) eksikti.
`ValidationPipe` `forbidNonWhitelisted: true` ayarı dekoratörü olmayan property'leri
reddediyor.

**Düzeltme:** Tüm alanlara class-validator dekoratörleri eklendi:
- `deviceModel`: `@IsOptional() @IsEnum(DeviceModel)`
- `deviceName`: `@IsOptional() @IsString() @MaxLength(200)`
- `description`: `@IsOptional() @IsString() @MaxLength(500)`
- `siteId`: `@IsOptional() @IsUUID()`
- `serialNumber`: `@IsOptional() @IsString() @MaxLength(100)`
