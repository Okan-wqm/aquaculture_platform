# SCADA Process Diagram - Edge Device Deployment (v1.5.2)

## Overview

SCADA proses diyagramlarini (ReactFlow) edge device'lara deploy edip, canli sensor verileriyle kiosk modunda goruntuleme sistemi.

```
CLOUD (app.suderra.com)                    EDGE DEVICE (RPi + Ekran)
+---------------------------+              +--------------------------------------------+
| Process Editor            |              | suderra-agent (Rust)                       |
|  "Edge'e Deploy" butonu   |   MQTT cmd   |  - deploy_process komutu alir              |
| sensor-service            |  ---------> |  - JSON'u /var/lib/suderra/scada/ kaydeder  |
|  deployProcessToEdge()    |              |  - axum: GET /scada (HTML serve)            |
|  MQTT publish             |              |  - axum: WS /ws/scada (canli veri)          |
+---------------------------+              |                                            |
                                           | suderra-display.service                    |
                                           |  - cage + chromium --kiosk                  |
                                           |  - http://localhost:8080/scada              |
                                           +--------------------------------------------+
```

---

## Edge Agent - SCADA Display Feature

### Derleme

```bash
# SCADA display ozelligi ile derle
cargo build --release --features scada-display

# Tum ozelliklerle derle
cargo build --release --features "gpio,health,scada-display,telemetry,lorawan"
```

### Cargo Feature: `scada-display`

`Cargo.toml`'de `scada-display = ["axum"]` feature'i ile aktif olur. Axum'un `ws` feature'i WebSocket destegi saglar.

### HTTP Endpoints

| Endpoint | Method | Aciklama |
|----------|--------|----------|
| `/scada` | GET | SCADA viewer HTML sayfasi (kiosk modu) |
| `/scada/process` | GET | Deploy edilmis proses JSON |
| `/ws/scada` | WebSocket | Canli sensor verisi broadcast |

### MQTT Komutlari

| Komut | Aciklama |
|-------|----------|
| `deploy_process` | Proses diyagramini edge'e deploy eder |
| `display_on` | Ekran servisini baslatir |
| `display_off` | Ekran servisini durdurur |
| `get_display_status` | Ekran durumu, proses adi, bagli istemci sayisi |

### deploy_process Payload

```json
{
  "commandId": "uuid",
  "command": "deploy_process",
  "params": {
    "processId": "uuid",
    "name": "RAS Sistemi A",
    "nodes": [...],
    "edges": [...],
    "tagMappings": {
      "equip-uuid-1": {
        "equipmentId": "equip-uuid-1",
        "equipmentName": "Drum Filter 1",
        "tags": [
          {
            "tagName": "df1_pressure",
            "sensorType": "pressure",
            "unit": "bar",
            "displayName": "Basinc"
          }
        ]
      }
    },
    "version": 1
  },
  "timestamp": "2026-03-04T12:00:00Z"
}
```

### Canli Veri Akisi

```
io_poll_loop (her cycle)
  -> GPIO/Modbus/I2C/LoRa okuma
  -> ProcessImage guncelle
  -> MQTT io_data publish (cloud icin)
  -> [scada-display] build_scada_sensor_data()
      tagMappings'ten equipmentId -> tag_name eslemesi
      ProcessImage'dan tag degerlerini oku
      { equipmentId: [{ value, unit, status }] } formatina donustur
  -> broadcast::Sender ile WebSocket'e gonder
  -> scada-edge.html alir, ReactFlow re-render
```

### Persistent Storage

Deploy edilen proses `/var/lib/suderra/scada/process.json` dosyasina kaydedilir. Agent yeniden basladiginda otomatik yuklenir.

---

## Cloud Backend - Deploy Mutation

### GraphQL API

```graphql
mutation DeployProcessToEdge($processId: ID!, $deviceId: ID!) {
  deployProcessToEdge(processId: $processId, deviceId: $deviceId) {
    success
    message
    processId
    deviceId
  }
}
```

**Yetkiler:** `TENANT_ADMIN`, `MODULE_MANAGER`

### Islem Akisi

1. Process'i DB'den yukle (`getProcessOrFail`)
2. Edge device'i dogrula (aktif ve online mi)
3. Node'lardaki `sensorMappings` -> `tagMappings` donusumu
4. MQTT `deploy_process` komutu publish
5. Basari/hata sonucu don

### Tag Mapping Donusumu

```
ProcessNode.data.sensorMappings (DB)    ->    tagMappings (MQTT)
  sensorName                            ->    displayName
  channelName / dataPath                ->    tagName
  dataType                              ->    sensorType
  unit                                  ->    unit
```

---

## Frontend - Deploy Dialog

### Erisim

Process editor sayfasinda (`/sensor/process/:processId`) toolbar'da **"Edge'e Deploy"** butonu.

### Kullanim

1. Process editor'da prosesi kaydet
2. Toolbar'daki "Edge'e Deploy" (Monitor ikonu) butonuna tikla
3. Acilan dialog'da online edge device'lardan birini sec
4. "Deploy Et" butonuna tikla
5. Basari mesaji goruntulenir

### Hook

```typescript
import { useDeployProcessToEdge } from '../hooks/useDeployProcess';

const { mutateAsync, isPending } = useDeployProcessToEdge();
await mutateAsync({ processId, deviceId });
```

---

## Edge Display Setup

### Gereksinimler

- Raspberry Pi 4/5 (HDMI ekran bagli)
- GPU destegi (`/dev/dri/card0`)
- `suderra` kullanicisi

### Kurulum

```bash
# Tam kurulum (cage + chromium + service)
sudo ./scripts/setup-display.sh install

# Ekrani baslat
sudo ./scripts/setup-display.sh enable

# Ekrani durdur
sudo ./scripts/setup-display.sh disable

# Durum kontrol
sudo ./scripts/setup-display.sh status

# Kaldirma
sudo ./scripts/setup-display.sh uninstall
```

### systemd Service

`suderra-display.service` cage Wayland compositor ile chromium'u kiosk modunda calistirir:

```
http://localhost:8080/scada
```

**Ozellikler:**
- Agent health check bekler (30s timeout)
- Otomatik yeniden baslatma (on-failure)
- Security hardening (NoNewPrivileges, ProtectSystem=strict)
- Resource limits (MemoryMax=512M, CPUQuota=80%)

### MQTT ile Uzaktan Kontrol

```bash
# Cloud'dan ekrani ac
MQTT publish -> deploy_process (once proses deploy et)
MQTT publish -> display_on

# Cloud'dan ekrani kapat
MQTT publish -> display_off

# Durum sorgula
MQTT publish -> get_display_status
```

---

## Dosya Yapisi

```
sens-api-gateway/
  Cargo.toml                    # scada-display feature
  src/
    main.rs                     # ScadaState init + server spawn
    scada_server.rs             # HTTP + WebSocket server modulu
    io_poll.rs                  # Tag broadcast entegrasyonu
    commands.rs                 # deploy_process, display_on/off komutlari
  static/
    scada-edge.html             # Kiosk SCADA viewer (WebSocket + ReactFlow)
  systemd/
    suderra-display.service     # Kiosk systemd unit
  scripts/
    setup-display.sh            # Display kurulum scripti

apps/sensor-service/src/process/
  process.module.ts             # EdgeDeviceModule import
  services/process.service.ts   # deployProcessToEdge metodu
  resolvers/process.resolver.ts # deployProcessToEdge mutation
  dto/process.dto.ts            # DeployProcessResultType

web/modules/sensor-module/src/
  pages/process/ProcessEditorPage.tsx                    # Edge deploy butonu
  components/process-editor/dialogs/DeployToEdgeDialog.tsx  # Deploy dialog
  hooks/useDeployProcess.ts                              # GraphQL mutation hook
```

---

## Troubleshooting

### Edge device'da SCADA sayfasi acilmiyor
```bash
# Agent calistigini kontrol et
systemctl status suderra-agent.service

# SCADA endpoint'i test et
curl http://localhost:8080/scada

# Display service loglarini kontrol et
journalctl -u suderra-display.service -f
```

### Sensor verileri guncellenmiyor
```bash
# WebSocket baglantisini kontrol et
# Browser console'da: ws connection status

# Agent loglarinda io_poll cycle'ini kontrol et
journalctl -u suderra-agent.service | grep "scada\|broadcast"
```

### Deploy komutu basarisiz
```bash
# MQTT baglantisini kontrol et
# Cloud sensor-service loglarinda MQTT publish hatasini ara

# Edge device'in online oldugundan emin ol
# Process editor'daki device listesinde yesil dot olmali
```
