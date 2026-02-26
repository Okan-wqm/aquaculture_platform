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

## 2b. Process Editor — Equipment ↔ Edge Device I/O Binding (Kemik Yapı)

Process editor'da equipment node'ları fiziksel edge device'lara bağlanır ve
I/O tag'leri node üzerinde canlı olarak gösterilir.

### 2b.1 Veri Modeli

```
EquipmentNode (ReactFlow node.data)
  ├── edgeDeviceId: string    → EdgeDevice.id (backend UUID)
  ├── edgeDeviceCode: string  → EdgeDevice.deviceCode (MQTT topic'te kullanılır)
  └── ioBindings: IoBinding[] → Node'a bağlı I/O tag listesi
        ├── ioConfigId: string      → DeviceIoConfig.id
        ├── tagName: string         → İnsan-okunur tag adı
        ├── ioType: IoBindingType   → 'DI' | 'DO' | 'AI' | 'AO' (union type)
        └── dataType: IoBindingDataType → 'BOOL' | 'FLOAT32' | ... (union type)
```

**IoBindingType / IoBindingDataType:** `processStore.ts`'de tanımlı union type'lar.
Backend'deki `IoType` ve `IoDataType` enum'ları ile senkronize olmalı.

### 2b.2 Frontend Akışı

**Dosya:** `components/process-editor/panels/PropertiesPanel.tsx`

| Adım | Eylem | State Değişikliği |
|------|-------|-------------------|
| 1 | Kullanıcı Equipment node seçer | `selectedNode` güncellenir |
| 2 | Edge Device Binding bölümü açılır | `selectedEdgeDeviceId` → `useEffect` ile sync |
| 3 | Dropdown'dan edge device seçilir | `handleEdgeDeviceSelect()` → node.data'ya `edgeDeviceId/Code` yazar |
| 4 | Seçilen device'ın I/O tag listesi yüklenir | `useEdgeDevice(id)` → `selectedDeviceDetail.ioConfig` |
| 5 | Checkbox ile tag'ler node'a bağlanır | `handleIoTagToggle()` → `node.data.ioBindings[]` güncellenir |
| 6 | Node overlay'de bağlı tag'ler görünür | `EquipmentNodeOverlay` → `IoBadge` render |

**Önemli detaylar:**

- **Stale state koruması:** `selectedEdgeDeviceId`, `useEffect` ile `selectedNode.id` değişiminde
  senkronize edilir. `useState` initializer sadece ilk mount'ta çalışır — farklı node seçildiğinde
  eski ID kalmaması için bu senkronizasyon zorunlu.
- **Decommissioned filtreleme:** Edge device dropdown'unda `DECOMMISSIONED` durumundaki cihazlar
  gösterilmez (`DeviceLifecycleState.DECOMMISSIONED` filtresi).
- **Loading/error states:** Device listesi yüklenirken "Loading..." ve hata durumunda "Failed to load"
  mesajları gösterilir.
- **Unlink temizliği:** Equipment unlink edildiğinde `edgeDeviceId`, `edgeDeviceCode`, `ioBindings`
  alanları da temizlenir (`processStore.unlinkEquipmentFromNode`).

### 2b.3 Digital Output (DO) Kontrolü

**Akış:**
```
PropertiesPanel: Output Controls bölümü
  → Kullanıcı ON/OFF butonuna tıklar
    → Onay dialogu açılır (güvenlik — yanlışlıkla aktüatör çalıştırmayı önler)
      → "Confirm" → useSetDigitalOutput().mutateAsync()
        → GraphQL: setDigitalOutput mutation
          → Backend: @Roles(TENANT_ADMIN, MODULE_MANAGER) + @CurrentUser() audit trail
            → edge-device.service.ts: setDigitalOutput()
              → Decommissioned/offline/non-DO kontrolleri
              → MQTT publish: tenants/{tid}/devices/{code}/commands
                → { command: "set_output", params: { tag_name, value, invert_value, gpio_pin, ... } }
```

**Hook:** `useEdgeDevices.ts` → `useSetDigitalOutput()`
- TanStack Query `useMutation` hook'u — raw `graphqlRequest` yerine
- Otomatik loading state (`isPending`), error handling
- Hata mesajları kullanıcıya inline banner ile gösterilir (console.error yerine)

**Backend güvenlik katmanları:**
1. `@Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)` — yetki kontrolü
2. `@IsUUID('4')` / `@IsBoolean()` — input validasyonu (class-validator)
3. `@CurrentUser()` → `triggeredBy` MQTT payload'a eklenir (audit trail)
4. `ensureMqttAvailable()` → try-catch ile soft-fail (tutarlı hata pattern'i)
5. `ioConfig.ioType !== IoType.DO` → sadece DO tag'lere izin
6. `device.lifecycleState === DECOMMISSIONED` → decommissioned cihaz koruması
7. `ioConfig.invertValue` → MQTT payload'a `invert_value` olarak eklenir

### 2b.4 I/O Data Bridge (Canlı Değerler)

**Akış:**
```
Edge Agent (scan cycle)
  → MQTT publish: tenants/{tid}/devices/{code}/io_data
    → mqtt-listener.service.ts: handleEdgeIoData()
      → Payload doğrulaması (boyut, yapı, tag sayısı)
      → Per-device throttle (1 saniye minimum aralık)
      → EventBus.publish('EdgeDeviceIoData')
        → WebSocket → Frontend
          → EquipmentNodeOverlay: IoBadge'ler güncellenir
```

**Payload doğrulaması (`mqtt-listener.service.ts`):**

| Kontrol | Limit | Neden |
|---------|-------|-------|
| Payload boyutu | 64 KB | DDoS / memory abuse önlemi |
| `tags` objesi yapısı | Object (non-array) gerekli | Beklenen format doğrulaması |
| Tag sayısı | Maks 256 | Anormal büyüklükteki veri paketlerini engelle |
| Per-device throttle | 1000 ms | WebSocket flooding önlemi |

**Throttle mekanizması:** `ioDataThrottleMap` — `Map<string, number>` (key: `tenantId:deviceCode`,
value: son publish timestamp). Agent tipik olarak 100-500ms aralıklarla I/O verisi gönderir,
ancak frontend 1s'de bir güncellenmeye ihtiyaç duyar.

### 2b.5 Overlay Render (EquipmentNodeOverlay)

**Dosya:** `components/process-editor/nodes/EquipmentNodeOverlay.tsx`

- **DI/DO tag'leri:** Yeşil/kırmızı LED ikonu (Tailwind class'ları: `bg-green-500`/`bg-red-500`)
  - Aktif DO output'larda `animate-pulse` animasyonu
- **AI/AO tag'leri:** Numerik değer badge'i (`bg-blue-50`)
- Maksimum 4 badge gösterilir — fazlası "+N" olarak belirtilir
- `React.memo` ile EquipmentNode'dan izole — overlay re-render node'u etkilemez

### 2b.6 Deploy Automation Modal

**Dosya:** `pages/process/ProcessEditorPage.tsx`

- `boundDevices` → `useMemo` ile memoize edilir (canvasNodes bağımlılığı)
  - Process'teki tüm node'lardan `edgeDeviceId` olan benzersiz device'ları çıkarır
  - Map ile deduplication yapılır
- Modal conditional render: `{isDeployModalOpen && <DeployAutomationModal />}`
  - Kapalıyken DOM'da mount edilmez — gereksiz render önlenir

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
| DO Control | @Roles(TENANT_ADMIN, MODULE_MANAGER), onay dialogu, @CurrentUser audit trail |
| Input Validation | @IsUUID('4'), @IsBoolean() class-validator — SetDigitalOutputInput DTO |
| I/O Data | Payload boyut limiti (64KB), tag sayısı limiti (256), yapı doğrulaması |
| I/O Throttle | Per-device 1s rate limit — WebSocket flooding önlemi |
| Device Lifecycle | Decommissioned cihazlara komut gönderilmez, dropdown'dan filtrelenir |

---

## 6. Dosya Referansları

### Backend (sensor-service)
| Dosya | İçerik |
|-------|--------|
| `edge-device/dto/edge-device.dto.ts` | SetDigitalOutputInput (@IsUUID, @IsBoolean), SetDigitalOutputResult |
| `edge-device/edge-device.service.ts` | I/O CRUD, transform, push, setDigitalOutput (DO control) |
| `edge-device/edge-device.resolver.ts` | pushIoConfigToDevice, setDigitalOutput (@Roles, @CurrentUser) |
| `automation/automation.service.ts` | translateProgramToEdgeScript, deploy pipeline |
| `ingestion/mqtt-listener.service.ts` | Deploy ACK, config ACK, I/O data bridge (throttle + validation) |

### Frontend (sensor-module)
| Dosya | İçerik |
|-------|--------|
| `pages/EdgeDeviceDetailPage.tsx` | I/O Config CRUD UI |
| `pages/automation/AutomationProgramEditorPage.tsx` | SFC editor, variable I/O binding, deploy |
| `pages/process/ProcessEditorPage.tsx` | Deploy modal (conditional render, memoized boundDevices) |
| `components/process-editor/panels/PropertiesPanel.tsx` | Equipment ↔ Edge Device binding, DO toggle, I/O tag checkbox |
| `components/process-editor/nodes/EquipmentNodeOverlay.tsx` | Canlı I/O badge render (DI/DO LED, AI/AO numerik) |
| `store/processStore.ts` | IoBinding interface (union types), unlinkEquipmentFromNode, ProcessNodeData union |
| `graphql/edge-device.queries.ts` | I/O mutations, SET_DIGITAL_OUTPUT_MUTATION, PUSH_IO_CONFIG_MUTATION |
| `graphql/automation.queries.ts` | Automation mutations |
| `hooks/useEdgeDevices.ts` | I/O CRUD + push hooks, useSetDigitalOutput, PushIoConfigResult |

### Edge Agent (sens-api-gateway)
| Dosya | İçerik |
|-------|--------|
| `src/config.rs` | AgentConfig, ModbusDeviceConfig, GpioConfig |
| `src/modbus.rs` | Modbus TCP/RTU client, all register types |
| `src/gpio.rs` | GPIO input/output via rppal |
| `src/scripting/engine.rs` | Scan cycle engine |
| `src/scripting/function_blocks/` | TON, PID, CTU, etc. |
| `src/commands.rs` | deploy_program, config update handlers |
