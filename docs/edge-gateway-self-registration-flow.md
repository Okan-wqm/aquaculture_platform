# Edge Gateway - Tenant-First Self-Registration Flow

## Historical Flow Warning

Bu dokümandaki GitHub `latest`, plaintext activation token ve `update_firmware` anlatımları eski akışı temsil eder. Yeni üretim mimarisi `docs/architecture/edge-release-provisioning-ota.md` dosyasındaki explicit `agent-v<exact Cargo semver>` release, hashed provisioning credential ve signed `apply_signed_manifest` akışıdır.

## Overview

Bu sistem, endüstriyel edge cihazlarının otomatik kayıt ve yönetimini sağlar. Geleneksel "device-first" yaklaşım yerine **"tenant-first"** model kullanılır: Tenant admin tek bir installer link oluşturur, bu link herhangi bir endüstriyel PC'ye kurulduğunda cihaz kendini otomatik kayıt eder.

---

## Akış Diyagramı

```
                    TENANT ADMIN                          CLOUD (Sensor Service)                    EDGE DEVICE
                    ─────────────                         ──────────────────────                    ───────────
                         │                                        │                                      │
                    ┌────┴────┐                                   │                                      │
                    │ Installer│                                   │                                      │
                    │ Link     │  1. createTenantProvisioningKey   │                                      │
                    │ Oluştur  │──────────────────────────────────>│                                      │
                    └────┬────┘                                   │                                      │
                         │                                   ┌────┴────┐                                 │
                         │                                   │ Token   │                                 │
                         │                                   │ Generate│                                 │
                         │<──────────────────────────────────│ (64-hex)│                                 │
                         │   TenantKeyResponse               └────┬────┘                                 │
                         │   { installerUrl,                      │                                      │
                         │     installerCommand }                 │                                      │
                         │                                        │                                      │
                    ┌────┴────┐                                   │                                      │
                    │ Link'i  │                                   │                                      │
                    │ Kopyala │                                   │                                      │
                    └────┬────┘                                   │                                      │
                         │                                        │                                      │
                         │   curl -sSL .../install/t/{token}      │                                      │
                         │   | sudo bash                          │                                      │
                         │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─>│                                      │
                         │        (komutu cihaza yapıştırır)      │                                 ┌────┴────┐
                         │                                        │  2. GET /install/t/{token}      │ Installer│
                         │                                        │<────────────────────────────────│ Script   │
                         │                                        │                                │ İndir    │
                         │                                   ┌────┴────┐                           └────┬────┘
                         │                                   │ Script  │                                │
                         │                                   │ Generate│                                │
                         │                                   └────┬────┘                                │
                         │                                        │  Shell Script                       │
                         │                                        │────────────────────────────────>│    │
                         │                                        │                                ┌────┴────┐
                         │                                        │                                │ Agent   │
                         │                                        │                                │ Binary  │
                         │                                        │                                │ İndir + │
                         │                                        │                                │ Config  │
                         │                                        │                                │ Yaz     │
                         │                                        │                                └────┬────┘
                         │                                        │                                     │
                         │                                        │  3. POST /api/devices/self-register  │
                         │                                        │  { tenant_token, fingerprint,        │
                         │                                        │    agent_version }                   │
                         │                                        │<────────────────────────────────────│
                         │                                   ┌────┴────┐                                │
                         │                                   │ Validate│                                │
                         │                                   │ Token + │                                │
                         │                                   │ Create  │                                │
                         │                                   │ Device  │                                │
                         │                                   └────┬────┘                                │
                         │                                        │  SelfRegisterResponse               │
                         │                                        │  { device_id, device_code,          │
                         │                                        │    mqtt_broker, mqtt_username,       │
                         │                                        │    mqtt_password, tenant_id }        │
                         │                                        │────────────────────────────────────>│
                         │                                        │                                ┌────┴────┐
                         │                                        │                                │ Config  │
                         │                                        │                                │ Güncelle│
                         │                                        │                                │ MQTT    │
                         │                                        │                                │ Bağlan  │
                         │                                        │                                └────┬────┘
                         │                                        │                                     │
                         │                                        │  4. MQTT: telemetry, status          │
                         │                                        │<════════════════════════════════════│
                         │                                        │        (periyodik heartbeat)         │
                    ┌────┴────┐                                   │                                      │
                    │ Cihaz   │  5. edgeDevices query              │                                      │
                    │ Panelde │<──────────────────────────────────│                                      │
                    │ Görünür │   (otomatik listelenir)           │                                      │
                    └─────────┘                                   │                                      │
```

---

## Detaylı Adımlar

### 1. Installer Link Oluşturma (Tenant Admin Panel)

**UI:** `EdgeDevicesPage.tsx` → "Installer Link Oluştur" butonu → `InstallerKeyModal.tsx`

**GraphQL Mutation:**
```graphql
mutation CreateTenantProvisioningKey($input: CreateTenantKeyInput!) {
  createTenantProvisioningKey(input: $input) {
    id
    keyToken
    installerUrl
    installerCommand
    expiresAt
    maxDevices
    autoApprove
  }
}
```

**Backend Flow:**
1. `EdgeDeviceResolver.createTenantProvisioningKey()` → `ProvisioningService.createTenantKey()`
2. `crypto.randomBytes(32).toString('hex')` ile 64 karakter token üretilir
3. `TenantProvisioningKey` kaydı DB'ye yazılır
4. Response: `installerUrl` + `installerCommand` döner

**Entity:** `tenant_provisioning_keys` tablosu
- `keyToken`: 64-char hex, unique
- `maxDevices`: null = sınırsız
- `autoApprove`: true ise cihaz direkt ACTIVE olur
- `defaultSiteId`: kayıt olan cihaz bu site'a atanır

---

### 2. Installer Script İndirme (Cihaz Üzerinde)

**Endpoint:** `GET /install/t/{tenantToken}` (Public, rate-limited: 5/min)

**Controller:** `ProvisioningController.getTenantInstallerScript()`

**Flow:**
1. `tenantToken` ile `TenantProvisioningKey` lookup
2. Validate: `isActive`, `expiresAt`, `maxDevices` vs `usedCount`
3. Shell script render (`renderTenantInstallerScript()`)

**Script İçeriği:**
```bash
#!/bin/bash
# 1. Agent binary indir
# 2. /opt/suderra-agent/ dizini oluştur
# 3. Config dosyası yaz (tenant_token embedded)
# 4. systemd service oluştur
# 5. Agent'ı başlat
```

**Config (agent.yaml):**
```yaml
device_id: ""          # self-register sonrası doldurulacak
api_url: "https://api.example.com"
tenant_token: "{token}"
mqtt:
  port: 1883
```

---

### 3. Self-Registration (Agent → Cloud)

**Endpoint:** `POST /api/devices/self-register` (Public, rate-limited: 3/min)

**Request:**
```json
{
  "tenant_token": "abc123...",
  "fingerprint": {
    "machine_id": "...",
    "cpu_serial": "...",
    "mac_addresses": ["aa:bb:cc:dd:ee:ff"],
    "hostname": "edge-pc-01",
    "os_info": "Ubuntu 22.04",
    "total_memory_mb": 8192,
    "cpu_cores": 4
  },
  "agent_version": "2.0.0"
}
```

**Backend Flow (`ProvisioningService.selfRegisterDevice()`):**
1. `TenantProvisioningKey` lookup by `tenant_token`
2. Validate: isActive, expiresAt, maxDevices vs usedCount
3. Fingerprint duplicate check (aynı machineId+MAC → reject)
4. `generateDeviceCode()` → unique 8-char kod
5. `generateMqttCredentials()` → clientId, username, password
6. `EdgeDevice` record CREATE:
   - `lifecycleState`: autoApprove ? `ACTIVE` : `PENDING_APPROVAL`
   - `siteId`: key.defaultSiteId (varsa)
7. `usedCount++` on TenantProvisioningKey
8. `DeviceEvent` log: `SELF_REGISTERED`

**Response:**
```json
{
  "success": true,
  "device_id": "uuid-...",
  "device_code": "EDGE-A1B2",
  "mqtt_broker": "mqtt.example.com",
  "mqtt_port": 1883,
  "mqtt_username": "device_uuid",
  "mqtt_password": "generated_password",
  "tenant_id": "tenant-uuid"
}
```

---

### 4. Agent MQTT Bağlantısı

**Rust Agent Flow (`sens-api-gateway/src/main.rs`):**
```
1. Config oku → tenant_token var mı?
2. Evet → self_register() çağır
3. Response'tan device_id, mqtt credentials al
4. Config dosyasını güncelle (device_id yaz, tenant_token sil)
5. MQTT'ye bağlan
6. Periyodik telemetry gönder
```

**MQTT Topics (Edge Agent → Cloud):**
```
tenants/{tenantId}/devices/{deviceCode}/telemetry   → CPU, RAM, Disk, Temp
tenants/{tenantId}/devices/{deviceCode}/status       → online/offline
tenants/{tenantId}/devices/{deviceCode}/response     → command responses
```

**MQTT Topics (Cloud → Edge Agent):**
```
tenants/{tenantId}/devices/{deviceId}/commands       → deploy_program, ping, reboot, update_firmware
```

---

### 5. Cihaz Yönetimi (Tenant Admin Panel)

**Sayfalar:**

| Sayfa | Dosya | Açıklama |
|-------|-------|----------|
| Cihaz Listesi | `EdgeDevicesPage.tsx` | Stats kartları, filtreler, cihaz grid |
| Cihaz Detay | `EdgeDeviceDetailPage.tsx` | 4 tab: Overview, I/O Config, Automation, Events |
| Installer Modal | `InstallerKeyModal.tsx` | Key oluştur, URL kopyala, mevcut key'ler |

**Cihaz Lifecycle State'leri:**
```
PROVISIONED → PENDING_APPROVAL → ACTIVE → MAINTENANCE → DECOMMISSIONED
                                    ↑          ↓
                                    └──────────┘
```

**GraphQL Queries:**
```graphql
edgeDevices(lifecycleState, isOnline, search, page, limit)
edgeDevice(id)
edgeDeviceStats
tenantProvisioningKeys
deviceEvents(deviceId, eventType, page, limit)
```

**GraphQL Mutations:**
```graphql
registerEdgeDevice(input)
approveEdgeDevice(id)
setDeviceMaintenanceMode(id, enabled)
decommissionEdgeDevice(id, reason)
pingEdgeDevice(id)
rebootEdgeDevice(id, reason)
createTenantProvisioningKey(input)
revokeTenantProvisioningKey(keyId)
```

---

## Otomasyon Program Deployment

### Deploy Flow

```
Tenant Admin                    Cloud                         Edge Device
     │                            │                               │
     │  deployProgram mutation     │                               │
     │───────────────────────────>│                               │
     │                       ┌────┴────┐                          │
     │                       │ Validate│                          │
     │                       │ Program │                          │
     │                       │ + Device│                          │
     │                       └────┬────┘                          │
     │                            │                               │
     │                       ┌────┴────┐                          │
     │                       │ Create  │                          │
     │                       │ Deploy  │                          │
     │                       │ Log     │                          │
     │                       └────┬────┘                          │
     │                            │                               │
     │                            │  MQTT: deploy_program         │
     │                            │  { commandId, params: {       │
     │                            │    edgeScript } }             │
     │                            │──────────────────────────────>│
     │                            │                          ┌────┴────┐
     │                            │                          │ Execute │
     │                            │                          │ Script  │
     │                            │                          └────┬────┘
     │                            │  MQTT: response               │
     │                            │  { commandId, success }       │
     │                            │<──────────────────────────────│
     │                       ┌────┴────┐                          │
     │                       │ Update  │                          │
     │                       │ Deploy  │                          │
     │                       │ Log     │                          │
     │                       │ Status  │                          │
     │                       └────┬────┘                          │
     │  DeploymentResult          │                               │
     │<───────────────────────────│                               │
```

### Deployment Log State'leri
```
PENDING → DEPLOYING → SUCCESS
                    → FAILED
                    → ROLLED_BACK
```

---

## OTA Firmware Yönetimi

Web panelden firmware sürümü seçilerek edge cihazlara uzaktan güncelleme gönderilebilir. `update_firmware` MQTT komutu ile GitHub Releases'den otomatik indirme, doğrulama ve kurulum gerçekleştirilir.

**Özellikler:**
- Upgrade ve downgrade desteklenir
- Toplu güncelleme (bulk update) desteği: Birden fazla cihaza aynı anda firmware güncellemesi gönderilebilir

**MQTT Komutu:**
```
tenants/{tenantId}/devices/{deviceId}/commands → update_firmware
```

**Flow:**
1. Tenant admin panelden hedef firmware sürümü seçilir
2. Cloud, `update_firmware` komutunu MQTT üzerinden cihaza gönderir
3. Edge agent, GitHub Releases'den ilgili binary'yi indirir
4. İndirilen dosya doğrulanır (checksum)
5. Mevcut agent binary'si güncellenir ve servis yeniden başlatılır

---

## Veritabanı Tabloları

### Yeni Tablolar (sensor module)

| Tablo | Açıklama |
|-------|----------|
| `tenant_provisioning_keys` | Tenant-level installer key'leri |
| `device_events` | Cihaz lifecycle event log'ları |
| `deployment_logs` | Program deployment geçmişi |

Bu tablolar `MODULE_SCHEMAS.sensor` array'ine eklenmiştir ve tenant provisioning sırasında otomatik oluşturulur.

---

## Event Tipleri

```typescript
enum DeviceEventType {
  SELF_REGISTERED     // Cihaz self-register ile kayıt oldu
  APPROVED            // Admin tarafından onaylandı
  CONNECTED           // MQTT bağlantısı kuruldu
  DISCONNECTED        // MQTT bağlantısı koptu
  CONFIG_PUSHED       // Config gönderildi
  CONFIG_ACK          // Config onaylandı
  DEPLOYMENT          // Program deploy edildi
  REBOOT              // Cihaz reboot edildi
  ERROR               // Hata oluştu
  ALARM               // Alarm tetiklendi
  HEARTBEAT_LOST      // Heartbeat kaybedildi
  DECOMMISSIONED      // Cihaz devre dışı bırakıldı
}
```

---

## Güvenlik

- **Installer script endpoint'leri** public ama rate-limited (5 req/min IP başına)
- **Self-register endpoint** rate-limited (3 req/min IP başına)
- **Tenant provisioning key'leri** 64-char hex token ile korunur
- **Fingerprint duplicate check** aynı cihazın tekrar kayıt olmasını engeller
- **MQTT credentials** her cihaz için unique üretilir
- **GraphQL mutations** `@Roles(TENANT_ADMIN, MODULE_MANAGER)` ile korunur

---

## Dosya Haritası

```
apps/sensor-service/src/
├── edge-device/
│   ├── entities/
│   │   ├── edge-device.entity.ts          # Mevcut cihaz entity
│   │   ├── device-io-config.entity.ts     # I/O konfigürasyon
│   │   ├── tenant-provisioning-key.entity.ts  # YENİ: Tenant installer key
│   │   └── device-event.entity.ts         # YENİ: Event log
│   ├── dto/
│   │   ├── edge-device.dto.ts             # Mevcut DTO'lar
│   │   └── provisioning.dto.ts            # Güncellenmiş: Yeni DTO'lar eklendi
│   ├── edge-device.module.ts              # Güncellenmiş: Yeni entity'ler eklendi
│   ├── edge-device.resolver.ts            # Güncellenmiş: Yeni mutation/query'ler
│   ├── edge-device.service.ts             # Mevcut
│   ├── provisioning.service.ts            # Güncellenmiş: Tenant key + self-register
│   └── provisioning.controller.ts         # Güncellenmiş: Yeni endpoint'ler
├── automation/
│   ├── entities/
│   │   └── deployment-log.entity.ts       # YENİ: Deployment log
│   ├── services/
│   │   └── deployment-log.service.ts      # YENİ: Deployment tracking
│   ├── automation.module.ts               # Güncellenmiş: DeploymentLog eklendi
│   └── automation.service.ts              # Güncellenmiş: Deploy log entegrasyonu
├── ingestion/
│   └── mqtt-listener.service.ts           # Güncellenmiş: Deployment response routing

sens-api-gateway/src/
├── config.rs                              # Güncellenmiş: tenant_token field
├── provisioning.rs                        # Güncellenmiş: self_register() metod
└── main.rs                                # Güncellenmiş: Tenant-first startup flow

web/modules/tenant-admin/src/
├── pages/
│   ├── EdgeDevicesPage.tsx                # YENİ: Cihaz listesi
│   └── EdgeDeviceDetailPage.tsx           # YENİ: Cihaz detay (4 tab)
├── components/
│   └── devices/
│       └── InstallerKeyModal.tsx           # YENİ: Key oluşturma modal
├── hooks/
│   └── useDevicePolling.ts                # YENİ: 5s polling hook
├── components/
│   └── TenantAdminSidebar.tsx             # Güncellenmiş: Edge Devices nav item
└── Module.tsx                             # Güncellenmiş: Yeni route'lar

libs/backend-common/src/database/
└── schema-manager.service.ts              # Güncellenmiş: 3 yeni tablo MODULE_SCHEMAS'a eklendi
```
