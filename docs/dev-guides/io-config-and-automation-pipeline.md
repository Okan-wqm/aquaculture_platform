# I/O Configuration & Automation (Soft PLC) Pipeline

**Tarih:** 2026-02-26
**Durum:** Implementasyon tamamlandı

---

## 1. Genel Bakış

Edge device'lar (endüstriyel Linux PC'ler) üzerinden fiziksel I/O kontrolü ve
IEC 61131-3 uyumlu otomasyon programlarının deploy edilmesi sürecini kapsar.

**Tam akış:**
```
Web UI (I/O Config Form)
  → Backend (Transform + MQTT Push)
    → Edge Agent (Modbus/GPIO Actor Reconfigure)
      → Fiziksel I/O Okuma/Yazma

Web UI (Automation Editor)
  → Backend (SFC → Edge Script Translator)
    → MQTT Deploy Command
      → Edge Agent (Scan Cycle Engine + Function Blocks)
        → PID, Timer, Counter kontrolü + I/O Binding
```

---

## 2. I/O Konfigürasyon Pipeline

### 2.1 Frontend (EdgeDeviceDetailPage.tsx)

**I/O Config Tab** tam CRUD arayüzü sunar:

| Özellik | Açıklama |
|---------|----------|
| **Add I/O Channel** | Modal form: tag adı, I/O tipi (DI/DO/AI/AO), veri tipi, protokol seçimi (Modbus/GPIO), scaling, alarm limitleri |
| **Edit** | Satır üzerinde edit ikonu → pre-filled modal |
| **Delete** | Trash ikonu + onay dialogu |
| **Push to Device** | "Cihaza Gönder" butonu → tüm aktif I/O config'leri agent'a MQTT ile gönderir |

**Protokol alanları koşullu gösterilir:**
- Modbus seçildiğinde: Slave ID, Register adresi, Function Code (FC1-FC4)
- GPIO seçildiğinde: Pin numarası, Mode (input/output), Invert

**Hook'lar:** `useEdgeDevices.ts` içinde:
- `useAddDeviceIoConfig()` — ADD_DEVICE_IO_CONFIG_MUTATION
- `useUpdateDeviceIoConfig()` — UPDATE_DEVICE_IO_CONFIG_MUTATION
- `useRemoveDeviceIoConfig()` — REMOVE_DEVICE_IO_CONFIG_MUTATION
- `usePushIoConfig()` — PUSH_IO_CONFIG_MUTATION

### 2.2 Backend (sensor-service)

**`edge-device.service.ts`:**

1. **`addIoConfig()`** — DB'ye kaydeder
2. **`transformIoConfigsToAgentFormat()`** — DeviceIoConfig[] → Agent-uyumlu JSON dönüşümü:
   - Modbus I/O'lar slave ID'ye göre gruplandırılır
   - `modbusFunction` → `register_type` mapping: FC1→coil, FC2→discrete_input, FC3→holding, FC4→input
   - Scaling hesaplanır: `(engMax - engMin) / (rawMax - rawMin)`
   - GPIO I/O'lar pin/direction/invert formatına çevrilir
3. **`pushIoConfigToDevice()`** — GraphQL mutation:
   - Cihazın online olduğunu doğrular
   - Tüm aktif I/O config'leri yükler
   - `transformIoConfigsToAgentFormat()` ile dönüştürür
   - MQTT publish: `tenants/{tid}/devices/{code}/commands` → `{ command: "update_io_config", params: {...} }`

**`mqtt-listener.service.ts`:**
- `update_io_config` command response'u handle eder (config_ack)
- Başarı/hata loglanır

### 2.3 Edge Agent (Rust)

**Config format (agent'ın beklediği):**
```yaml
modbus:
  - name: "slave_1"
    connection_type: "tcp"
    address: "192.168.1.100:502"
    slave_id: 1
    registers:
      - name: "water_temp"
        address: 100
        register_type: "holding"    # FC3
        data_type: "f32"
        scale: 0.1
        unit: "°C"
gpio:
  - name: "pump_relay"
    pin: 17
    direction: "output"
    invert: false
```

Agent bu config'i aldığında:
1. `ModbusManager::reconfigure()` — Mevcut Modbus actor'leri kapatıp yeniden oluşturur
2. `GpioHandle::reconfigure()` — GPIO pin'leri yeniden konfigüre eder
3. ACK response gönderir

---

## 3. Otomasyon (Soft PLC) Deploy Pipeline

### 3.1 Program Oluşturma (Frontend)

**AutomationProgramEditorPage.tsx** içinde:
- **SFC Editor:** Adımlar (steps), geçişler (transitions), değişkenler (variables)
- **Variable Form:** Scope INPUT/OUTPUT/IN_OUT seçildiğinde I/O tag picker açılır
  - Edge device seçici dropdown
  - Seçilen cihazın I/O tag'leri dropdown
  - Otomatik dataType dolduruluyor
- **ST Editor:** Structured Text kodu yazılabilir
- **Deploy Tab:** Hedef cihaz seçimi + deploy butonu

### 3.2 SFC → Edge Script Translator (Backend)

**`automation.service.ts` → `translateProgramToEdgeScript()`**

Translator şu adımları izler:

1. **Program verilerini yükle:** Steps, transitions, variables, step actions
2. **I/O Mapping oluştur:** Her INPUT/OUTPUT/IN_OUT variable için:
   - `ioConfigId` varsa → DeviceIoConfig'ten tag bilgisi çek
   - Modbus tag → `"sensor:{tagName}"`
   - GPIO tag → `"gpio:{gpioPin}"`
   - Local variable → `"var:{varName}"`
3. **Function Block'ları çıkar:**
   - Step action'lardan FB referansları parse et
   - ST kodundan regex ile FB pattern'leri (TON, PID, CTU vb.) çıkar
   - Her FB için inputs/outputs mapping oluştur
4. **Trigger/Condition/Action üret:**
   - Her SFC transition → threshold condition
   - Condition expression parse: `water_temp > 25.0` → `{ source: "sensor:water_temp", operator: "gt", value: 25.0 }`
   - Step action'lar → real actions: set_output, fb_call, set_variable
5. **Deploy payload:**
```json
{
  "id": "program-uuid",
  "name": "FeedController",
  "version": 3,
  "executionMode": "scan_cycle",
  "scanCycleMs": 100,
  "ioMappings": {
    "water_temp": "sensor:water_temp",
    "heater_relay": "gpio:17"
  },
  "functionBlocks": [
    { "fbType": "PID", "instanceId": "pid1", "inputs": { "SP": 25.0, "KP": 1.0 } }
  ],
  "script": {
    "triggers": [...],
    "conditions": [...],
    "actions": [...]
  }
}
```

### 3.3 MQTT Deploy (Backend → Agent)

**Topic:** `tenants/{tenantId}/devices/{deviceCode}/commands`
**Command types:**
- `deploy_program` — Rust engine (JSON program definition)
- `deploy_to_codesys` — External Codesys PLC (raw ST source)
- `deploy_auto` — PLC setpoint write

### 3.4 Edge Agent Execution

Agent deploy payload'u aldığında:
1. Deploy lock alır (concurrent deploy engellenir)
2. FB sayısı ve scan cycle limitlerini validate eder
3. Önceki versiyonu rollback için saklar
4. Script'i shared storage'a deploy eder
5. Program state'i `/var/lib/suderra/program.json`'a persist eder
6. Engine reload → scan cycle başlar

**Scan Cycle (her N ms):**
1. I/O oku (Modbus registers, GPIO pins) → context'e yaz
2. FB input'larını context'ten wire et
3. Tüm function block'ları execute et
4. FB output'larını context'e yaz
5. Script trigger/condition/action evaluate et
6. Sonraki cycle'ı bekle

### 3.5 Deploy Confirmation (Agent → Backend)

**Topic:** `tenants/{tid}/devices/{code}/responses`
```json
{
  "commandId": "uuid",
  "command": "deploy_program",
  "success": true,
  "message": "Program deployed successfully"
}
```

Backend:
- `DeploymentLog` status → DEPLOYED
- `AutomationProgram` status → DEPLOYED
- 5 dakika timeout watchdog: DEPLOYING durumunda kalmış programları APPROVED'a geri alır

---

## 4. Mevcut Function Block'lar (Edge Agent)

| FB Tipi | Açıklama | IEC 61131-3 |
|---------|----------|-------------|
| **TON** | On-delay timer | Evet |
| **TOF** | Off-delay timer | Evet |
| **TP** | Pulse timer | Evet |
| **CTU** | Up counter | Evet |
| **CTD** | Down counter | Evet |
| **CTUD** | Up/down counter | Evet |
| **PID** | PID controller (anti-windup, derivative-on-PV) | Evet |
| **MAVG** | Moving average filter | Özel |
| **HYSTERESIS** | Schmitt trigger / setpoint oscillation prevention | Özel |
| **R_TRIG** | Rising edge trigger | Evet |
| **F_TRIG** | Falling edge trigger | Evet |
| **RS** | Reset-dominant flipflop | Evet |
| **SR** | Set-dominant flipflop | Evet |

---

## 5. Güvenlik

| Katman | Mekanizma |
|--------|-----------|
| MQTT | TLS/mTLS, per-tenant topic isolation |
| Config | 0600 file permissions, secrecy crate for secrets |
| Modbus | Function code whitelist (IEC 62443 SL2 FR3), rate limiting |
| Deploy | Concurrency lock, version validation, automatic rollback |
| FB State | SQLite + sqlcipher encryption for RETAIN variables |
| Agent | systemd sandboxing (ProtectSystem=strict, NoNewPrivileges) |

---

## 6. Dosya Referansları

### Backend (sensor-service)
| Dosya | İçerik |
|-------|--------|
| `edge-device/edge-device.service.ts` | I/O CRUD, transform, push |
| `edge-device/edge-device.resolver.ts` | pushIoConfigToDevice mutation |
| `automation/automation.service.ts` | translateProgramToEdgeScript, deploy pipeline |
| `ingestion/mqtt-listener.service.ts` | Deploy ACK, config ACK, telemetry |

### Frontend (sensor-module)
| Dosya | İçerik |
|-------|--------|
| `pages/EdgeDeviceDetailPage.tsx` | I/O Config CRUD UI |
| `pages/automation/AutomationProgramEditorPage.tsx` | SFC editor, variable I/O binding, deploy |
| `graphql/edge-device.queries.ts` | I/O mutations |
| `graphql/automation.queries.ts` | Automation mutations |
| `hooks/useEdgeDevices.ts` | I/O CRUD + push hooks |

### Edge Agent (sens-api-gateway)
| Dosya | İçerik |
|-------|--------|
| `src/config.rs` | AgentConfig, ModbusDeviceConfig, GpioConfig |
| `src/modbus.rs` | Modbus TCP/RTU client, all register types |
| `src/gpio.rs` | GPIO input/output via rppal |
| `src/scripting/engine.rs` | Scan cycle engine |
| `src/scripting/function_blocks/` | TON, PID, CTU, etc. |
| `src/commands.rs` | deploy_program, config update handlers |
