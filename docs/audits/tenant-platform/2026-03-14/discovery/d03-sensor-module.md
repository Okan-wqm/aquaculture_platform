# D03 - Sensor Module Frontend Audit (Veri Akisi Perspektifi)

**Auditor:** D3 - Sensor Veri Akisi Uzmani
**Tarih:** 2026-03-14
**Modul:** `@aquaculture/sensor-module` (MFE remote, port 3005)
**Kapsam:** Veri akisi, real-time data, chart performansi, SCADA, kalibrasyon, alert/alarm, edge device yonetimi

---

## 1. Dosya Yapisi ve Genel Bakis

### 1.1 Modul Federasyonu Yapilandirmasi

| Ozellik | Deger |
|---------|-------|
| MFE Adi | `sensorModule` |
| Entry | `remoteEntry.js` |
| Base Path | `/remotes/sensor-module/` |
| Dev Port | 3005 |
| Build Target | esnext |
| Shared | react, react-dom, react-router-dom, @tanstack/react-query, zustand, reactflow |

Expose edilen modüller: `./Module`, `./Dashboard`, `./Devices`, `./Readings`, `./Alerts`

### 1.2 Temel Bagimliklar

| Paket | Versiyon | Amac |
|-------|---------|------|
| `recharts` | ^2.10.0 | Chart/grafik render |
| `reactflow` | ^11.10.0 | Process editor ve SCADA canvas |
| `socket.io-client` | ^4.7.0 | WebSocket real-time veri |
| `zustand` | ^4.4.0 | State management (3 ayri store) |
| `gridstack` | ^12.4.1 | Widget dashboard grid layout |
| `@tanstack/react-query` | ^5.17.0 | Server state yonetimi (edge device hook'lari) |
| `@monaco-editor/react` | ^4.6.0 | ST (Structured Text) programlama editoru |
| `date-fns` | ^3.0.0 | Tarih islemleri |

### 1.3 Sayfa ve Route Listesi

```
/sensor                  -> SensorScadaPage (index, SCADA gorunumu)
/sensor/scada            -> SensorScadaPage
/sensor/setup            -> IndustrySetupPage
/sensor/dashboard        -> SensorDashboardPage (legacy)
/sensor/widgets          -> WidgetDashboardPage (GridStack dashboard)
/sensor/devices          -> DevicesPage
/sensor/devices/:id      -> DeviceDetailPage
/sensor/devices/edge/:id -> EdgeDeviceDetailPage
/sensor/readings         -> ReadingsPage
/sensor/alerts           -> AlertsPage
/sensor/thresholds       -> ThresholdsPage
/sensor/calibration      -> CalibrationPage
/sensor/analytics        -> SensorAnalyticsPage
/sensor/processes        -> ProcessListPage (lazy)
/sensor/process/new      -> ProcessEditorPage (lazy)
/sensor/process/:id      -> ProcessEditorPage (lazy)
/sensor/scada-packages   -> ScadaPackageListPage (lazy)
/sensor/scada-builder/*  -> ScadaPackageBuilderPage (lazy)
/sensor/unified-editor/* -> UnifiedEditorPage (lazy)
/sensor/automation       -> AutomationProgramsPage (lazy)
/sensor/automation/*     -> AutomationProgramEditorPage (lazy)
```

**Lazy loading notu:** ReactFlow-agir sayfalar (`ProcessEditorPage`, `ScadaPackageBuilderPage`, `UnifiedEditorPage`, `AutomationProgramsPage`) lazy() ile yukleniyor. Bu, ana chunk'in ReactFlow ile sisman olmasini engelliyor -- **dogru bir karar**.

### 1.4 Zustand Store'lari

| Store | Dosya | Amac |
|-------|-------|------|
| `useProcessStore` | `store/processStore.ts` | Process editor state (node, edge, selection, equipment linking) |
| `useScadaStore` | `store/scadaStore.ts` | SCADA viewer state (process, sensor readings, live mode) |
| `useScadaPackageStore` | `store/scadaPackageStore.ts` | SCADA package builder state |
| `useSensorStore` | `hooks/useSensorSocket.ts` | Global WebSocket sensor readings |
| `useEdgeIoStore` | `hooks/useEdgeIoSocket.ts` | Edge device I/O tag data ve alarmlar |

---

## 2. Veri Akisi: Sensorden Frontend'e

### 2.1 End-to-End Veri Akisi

```
Fiziksel Sensor
    |
    v
Edge Device (RevPi/RPi) -- MQTT --> Mosquitto Broker
    |                                      |
    v                                      v
Edge Agent (aqua-agent)          sensor-service (mqtt-listener.service.ts)
    |                                      |
    |  MQTT: device/{code}/io/data         v
    |                              data-processor.service.ts
    v                                      |
NATS (aqua-nats)                          v
    |                              batch-processor.service.ts
    v                                      |
Gateway WebSocket                         v
    |                              TimescaleDB (sensor schema hypertable)
    v                                      |
Socket.IO (browser)                       v
    |                              GraphQL API (gateway-api)
    v                                      |
useSensorSocket.ts                        v
useEdgeIoSocket.ts               Frontend hooks (GraphQL fetch)
```

### 2.2 Cift Kanalli Veri Teslimi

Frontend iki ayri kanaldan veri aliyor:

**Kanal 1 - WebSocket (Canli/Real-time)**
- `useSensorSocket.ts`: Socket.IO ile `/sensors` namespace'ine baglanir
- `useEdgeIoSocket.ts`: Ayni Socket.IO, `edgeIoData` ve `edgeAlarm` event'leri
- Singleton socket instance, Zustand store ile paylasim
- `sensorReading` event -> `useSensorStore.updateReading()` -> subscriber callback
- `edgeIoData` event -> `useEdgeIoStore.updateTags()` -> tag deger guncelleme
- Auth: JWT token ile `io(WS_URL, { auth: { token } })`
- Max reconnect: 10 deneme, 1-5 saniye backoff

**Kanal 2 - GraphQL Polling (Tarihsel/Initial)**
- `useSensorReadings.ts`: `setInterval` ile `fetchLatestReadingsBatch()` cagirma
- `useWidgetData.ts`: Initial load GraphQL, sonra WebSocket ile canli guncelleme
- `useProcess.ts`: Process CRUD islemleri
- Endpoint: `/graphql` (gateway-api uzerinden)

### 2.3 Widget Data Hook Mimarisi (useWidgetData.ts)

```
useWidgetData(config)
    |
    +-- Initial load: GraphQL latestReadingsBatch
    +-- History: GraphQL aggregatedReadings (TimescaleDB time_bucket)
    +-- Live: useSensorSocket -> WebSocket sensorReading events
    +-- Fallback: Raw readings query (aggregation basarisiz olursa)
    |
    +-- Race condition korumasi:
    |   - pendingReadingsRef: WebSocket verileri initial load bitmeden gelirse kuyruge alinir
    |   - isInitialLoadRef: Ilk yukleme sirasinda loading spinner gosterilir
    |
    +-- Performans optimizasyonlari:
        - PERF-001: Singleton socket, Zustand store ile paylasim
        - PERF-005: Batch latest readings query (N+1 problemi cozumu)
        - PERF-011: Module-scope sensorInfoCache (per-instance yerine global)
```

**BULGU [PERF-POZITIF]:** `useWidgetData` iyi tasarlanmis. WebSocket + GraphQL hybrid yaklasimiyla canli veri WebSocket'ten, tarihsel veri aggregated query'den geliyor.

---

## 3. Real-time Data Mekanizmasi

### 3.1 WebSocket (Socket.IO) Kullanimi

**useSensorSocket.ts:**
- Singleton pattern: `socketInstance` modül seviyesinde tanimlaniyor
- Zustand store: `useSensorStore` ile global state yonetimi
- Subscribe/unsubscribe: `socket.emit('subscribe', { sensorIds })` / `socket.emit('unsubscribe', { sensorIds })`
- Event: `sensorReading` -> `{ sensorId, sensorName, tenantId, readings: Record<string, number>, timestamp }`

**useEdgeIoSocket.ts:**
- Ayni WS_URL ve benzer singleton pattern
- Subscribe: `socket.emit('subscribeEdgeIo', { deviceCode })`
- Events: `edgeIoData` (tag degerleri), `edgeAlarm` (alarm bildirim)
- Alarm ring buffer: Device basina max 100 alarm tutulur

### 3.2 Polling Mekanizmasi

| Hook | Interval | Amac |
|------|----------|------|
| `useSensorReadings` | 10000ms (default) | SCADA sayfa sensor okuma yenileme |
| `useWidgetData` | config.refreshInterval (default 60000ms) | Widget tarihsel veri yenileme |
| `useEdgeDevices` | 30000ms (refetchInterval) | Edge device online durumu |
| `useEdgeDeviceStats` | 60000ms (refetchInterval) | Dashboard istatistikleri |

### 3.3 WS_URL Yapilandirmasi

```typescript
const WS_URL =
  import.meta.env?.VITE_WS_URL ||
  window.__RUNTIME_CONFIG__?.WS_URL ||
  '/sensors';
```

**BULGU [SEC-001]:** WS_URL fallback olarak `/sensors` relative path kullaniliyor. Bu production'da nginx reverse proxy arkasinda dogru calisir, ancak runtime config mekanizmasi (`window.__RUNTIME_CONFIG__`) kontrol edilmeli.

### 3.4 BULGU [PERF-RISK-001]: Cift Socket Riski

`useSensorSocket.ts` ve `useEdgeIoSocket.ts` ayri singleton socket instance'lari olusturuyor ama ayni `/sensors` URL'ine baglaniyorlar. Bu iki ayri Socket.IO baglantisi olusturabilir. Ancak kod incelemesinde her ikisi de ayri `socketInstance` degiskeni kullaniyor, yani gercekten iki ayri TCP baglantisi aciyor. Ayni namespace'e iki baglanti, sunucu tarafinda gereksiz kaynak tuketimi olusturabilir.

**Oneri:** Tek bir Socket.IO baglanti havuzu olusturulup her iki hook'un bu ortak socket'i kullanmasi dusunulebilir.

---

## 4. Grafik/Chart Sistemi

### 4.1 Kullanilan Kutuphane: Recharts 2.10.0

Tum grafik widget'lari `recharts` uzerine insa edilmistir:

| Widget | Dosya | Recharts Component |
|--------|-------|--------------------|
| LineChartWidgetContent | `dashboard/widgets/LineChartWidgetContent.tsx` | `LineChart`, `Line`, `XAxis`, `YAxis` |
| AreaChartWidgetContent | `dashboard/widgets/AreaChartWidgetContent.tsx` | `AreaChart`, `Area` |
| BarChartWidgetContent | `dashboard/widgets/BarChartWidgetContent.tsx` | `BarChart`, `Bar` |
| SparklineWidgetContent | `dashboard/widgets/SparklineWidgetContent.tsx` | Minimal line |
| GaugeWidgetContent | `dashboard/widgets/GaugeWidgetContent.tsx` | SVG-based custom |
| RadialGaugeWidgetContent | `dashboard/widgets/RadialGaugeWidgetContent.tsx` | `RadialBarChart` |

### 4.2 Recharts Performans Optimizasyonlari

**PERF-004: Izole Timer Pattern**
```typescript
// LineChartWidgetContent.tsx
const TimeSinceUpdate: React.FC<{ timestamp: Date | null }> = ({ timestamp }) => {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // ...
};
```
"Son guncelleme" gosterimini ayri bir komponente cikararak, her saniye sadece bu kucuk leaf node re-render oluyor. Chart ana komponenti etkilenmiyor. **Iyi bir optimizasyon.**

**PERF-010: Minute Bucket Gruplama**
```typescript
const BUCKET_MS = 60 * 1000;
const bucketTs = new Date(Math.round(ts.getTime() / BUCKET_MS) * BUCKET_MS);
```
Farkli sensorlerden gelen okumalar milisaniye farklarla geldiginde, 1-dakikalik bucket'lara gruplandiriliyor. Bu, multi-sensor line chart'ta bosluklu veri problemini cozuyor.

### 4.3 BULGU [PERF-RISK-002]: Buyuk Veri Seti Render Performansi

**Sorun:** `useWidgetData` history fetch'inde `limit: 100` kullaniliyor (raw readings fallback'te), ancak aggregated readings icin limit yok. 30 gunluk tarih araligi secildiginde:
- Eger aggregation 1-dakikalik ise: ~43.200 veri noktasi
- Her widget basina bu kadar nokta Recharts SVG DOM'a cevrilir
- 5-6 ayni anda gorunen chart widget varsa: 200K+ SVG elementi

**Kanit (LineChartWidgetContent.tsx satir 207-214):**
```typescript
{sensorNames.map((name, index) => (
  <Line key={name} type="monotone" dataKey={name}
    stroke={COLORS[index % COLORS.length]} strokeWidth={2}
    dot={false} activeDot={{ r: 4 }} />
))}
```
`dot={false}` iyi bir karar (binlerce circle elementi engelliyor), ancak SVG `<path>` elementinin `d` attribute'u yine de binlerce noktayi icerir.

**Oneri:**
1. Aggregated readings icin frontend'de max data point limiti (ornegin 500) eklenmeli
2. 7d/30d araliklari icin otomatik olarak daha kaba aggregation interval'i kullanilmali
3. Canvas-based chart kutuphanesi (uPlot, ECharts canvas mode) degerlendirilmeli

### 4.4 BULGU [PERF-RISK-003]: Widget Dashboard Memory Leak Riski

`useWidgetData` hook'u her widget instance'i icin:
- 1 `setInterval` (history refresh)
- WebSocket subscription (useSensorSocket)
- Pending readings buffer (Map)

Widget silindiginde veya dashboard'dan cikildiginda cleanup yapiliyor (`return () => clearInterval(...)`) ancak:

**Risk:** `useEffect` dependency array'inde `[fetchData, fetchHistory, config.refreshInterval, config.id, isConnected]` var. Her `fetchData` referans degisikliginde interval yeniden olusturuluyor. `fetchData` ise `useCallback` ile sarili ama bagimliklik zinciri uzun (`fetchLatestReadings` -> `fetchSensorInfo` -> `config.selectedChannels`...). Bu, gereksiz interval sifirlama dongusune yol acabilir.

**Oneri:** `fetchData` referansini stabilize etmek icin `useCallback` dependency'leri gozden gecirilmeli veya interval yonetimi `useRef` ile yapilmali.

---

## 5. SCADA Paketleri

### 5.1 SCADA Mimari Yapisi

SCADA sistemi uc katmanli:

**Katman 1 - Process Editor (Tasarim):**
- ReactFlow canvas (iframe icinde)
- Equipment node'lari (Tank, Pump, Chiller, Heater, vb. - 14+ tip)
- Edge bağlantilari (water, air, electric, data tipleri)
- Equipment -> Edge Device -> I/O Tag binding
- `processStore` Zustand state management

**Katman 2 - SCADA Viewer (Izleme):**
- Read-only ReactFlow canvas (iframe: `scada-viewer-canvas.html`)
- `postMessage` ile host <-> iframe iletisimi
- Sensor overlay widget'lari (Gauge, Numeric, Sparkline, Status)
- `scadaStore` Zustand state management

**Katman 3 - SCADA Package Builder (Gelismis):**
- 3-panel layout: WidgetPalette | ScreenCanvas | PropertiesPanel
- `scadaPackageStore` Zustand state
- Deploy to edge device
- Simulation mode, undo/redo
- Scene tree, screen tab yonetimi
- `ScadaDataProvider` context ile canli veri

### 5.2 iframe postMessage Protokolu

**Process Editor Host -> Canvas:**
```
{ type: 'updateNodeData', data: { nodeId, data }, source: 'process-editor-host' }
{ type: 'updateEdgeData', data: { edgeId, data }, source: 'process-editor-host' }
{ type: 'highlightNode', data: nodeId, source: 'process-editor-host' }
```

**SCADA Viewer Host -> Canvas:**
```
{ type: 'setProcess', data: { nodes, edges }, source: 'scada-viewer-host' }
{ type: 'updateAllSensorData', data: sensorReadings, source: 'scada-viewer-host' }
{ type: 'zoomIn' | 'zoomOut' | 'fitView', data: null, source: 'scada-viewer-host' }
```

**Canvas -> Host:**
```
{ type: 'ready', source: 'scada-viewer-canvas' }
{ type: 'nodeSelected', data: nodeData, source: 'scada-viewer-canvas' }
{ type: 'selectionCleared', source: 'scada-viewer-canvas' }
```

### 5.3 BULGU [SEC-002]: XSS Korumasi

`ScadaViewer.tsx` icinde `sanitizeNodes()` fonksiyonu HTML tag'lari strip ediyor:
```typescript
function stripHtml(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/<[^>]*>/g, '');
}
```
Ayrica `postMessage` origin dogrulamasi yapiliyor:
```typescript
if (event.origin !== window.location.origin) return;
```
**Pozitif bulgu.** Stored XSS ve cross-origin message injection korunmasi mevcut.

### 5.4 BULGU [SEC-003]: iframe Sandbox Kisitlamasi

```html
<iframe sandbox="allow-scripts allow-same-origin" />
```
`allow-scripts allow-same-origin` kombinasyonu sandbox'i etkisiz kilar (iframe script'i sandbox attribute'unu kaldirabilir). Ancak bu durumda iframe ayni origin'den yukleniyor ve uygulama icinde ReactFlow canvas'i calistirmak icin gerekli. Risk kabul edilebilir duzeyde.

### 5.5 ScadaDataProvider (Context API)

SCADA Package Builder icin canli veri saglayan context:
- `useScadaLiveData` hook'unu sarar
- `subscribeTag(deviceCode, tagName)` / `unsubscribeTag(deviceCode, tagName)` pattern
- Widget render edildikce device subscription otomatik eklenir
- `useMemo` ile context value stabilizasyonu

---

## 6. Kalibrasyon

### 6.1 Durum: HENUZ UYGULANMAMIS

`CalibrationPage.tsx` sadece bir bilgi banner'i gosteriyor:

```typescript
<p className="font-semibold text-yellow-800">
  Kalibrasyon modulu henuz kullanima hazir degil
</p>
```

Backend tarafinda `apps/sensor-service/src/calibration/` dizini mevcut ama frontend entegrasyonu yapilmamis.

### 6.2 BULGU [FUNC-001]: Kalibrasyon Eksikligi

**Seviye: ORTA**

Kalibrasyon islevi su anda tamamen stub. Bu, su kalite olcumleri yapan sensorler (pH, cozunmus oksijen, iletkenlik) icin kritik bir eksiklik cunku bu sensorler duzenli kalibrasyon gerektirir. Kalibrasyon olmadan olcum drift'i tespit edilemez ve yanlis alarm durumlarma yol acabilir.

**Backend hazir mi:** `calibration/` dizini mevcut, ancak frontend'e entegre edilmemis.

---

## 7. Alarm ve Alert Sistemi

### 7.1 Esik Degeri Yonetimi (ThresholdsPage)

`useSensorThresholds.ts` hook'u:
- `useSensorList()` ile sensor listesini ceker
- Her sensor icin `alertThresholds` bilgisini parse eder
- Default esik degerleri sensor tipine gore tanimli (9 tip):
  - temperature: warning 18-28, critical 15-32
  - ph: warning 6.5-8.5, critical 6.0-9.0
  - dissolved_oxygen: warning 5-12, critical 3-15
  - salinity, ammonia, nitrite, nitrate, turbidity, water_level

**Update mekanizmasi:**
- `updateThreshold()`: Tek sensor icin `UpdateDataChannel` mutation
- `updateThresholdsBulk()`: Toplu guncelleme (`Promise.all` ile paralel mutation)

**BULGU [PERF-RISK-004]:** `updateThresholdsBulk` icinde `Promise.all` ile N adet ayri GraphQL mutation gonderiliyor. Bulk update API'si (tek mutation ile toplu guncelleme) kullanilmamis. 50+ sensorlu bir sistemde bu N HTTP request demek.

### 7.2 Alert Sayfasi (AlertsPage)

**BULGU [FUNC-002]: Mock Data Kullanimi - KRITIK**

`AlertsPage.tsx` tamamen hardcoded mock veri kullaniyor:

```typescript
const mockAlerts: Alert[] = [
  { id: '1', sensorName: 'Havuz C - Sicaklik', severity: 'critical', ... },
  { id: '2', sensorName: 'Havuz B - pH', severity: 'high', ... },
  // ...
];
```

Backend'den gercek alert verisi cekilmiyor. Butonlar (Onayla, Cozuldu Isaretle, Yoksay) fonksiyonel degil -- sadece UI render ediliyor.

**Seviye: YUKSEK** - Alarm sistemi operasyonel degil. Esik degerlerinin ayarlanabilmesi yararli ama gercek zamali alarm bildirimi ve gecmis alarm kaydi eksik.

### 7.3 SCADA Store'daki Alarm Evaluasyonu

`scadaStore.ts` icindeki `getStatusFromValue()` fonksiyonu sensor reading geldiginde status degerlendirmesi yapiyor:
```typescript
function getStatusFromValue(value: number, reading: SensorReading): SensorStatus {
  if (reading.criticalLow !== undefined && value < reading.criticalLow) return 'critical';
  if (reading.criticalHigh !== undefined && value > reading.criticalHigh) return 'critical';
  if (reading.warningLow !== undefined && value < reading.warningLow) return 'warning';
  if (reading.warningHigh !== undefined && value > reading.warningHigh) return 'warning';
  return 'normal';
}
```

Bu degerlendirme frontend-side yapiliyor. Backend'de de paralel alarm mekanizmasi olmali, ancak frontend'deki bu evaluasyon SCADA gorunumunde anlık gorsellestirme icin kullaniliyor. **Backend alarm evalusyonu dogrulanmali.**

### 7.4 Edge Device Alarmlari

`useEdgeIoSocket.ts` ile edge cihaz alarmlari WebSocket uzerinden aliyor:
```typescript
interface IoAlarmEvent {
  tag: string;
  type: string;
  priority: string;
  state: string;
  value: number;
  setpoint: number;
  message: string;
}
```
Device basina son 100 alarm ring buffer'da tutuluyor. **Iyi bir sinir.**

---

## 8. Edge Device Yonetimi

### 8.1 Cihaz Yasam Dongüsü (IEC 62443 Uyumlu)

`useEdgeDevices.ts` icinde tanimli lifecycle state'ler:

```
REGISTERED -> PROVISIONING -> PENDING_APPROVAL -> ACTIVE -> OFFLINE/MAINTENANCE/ERROR
                                                        -> REVOKED -> DECOMMISSIONED
```

### 8.2 Desteklenen Cihaz Modelleri

| Model | Enum |
|-------|------|
| RevPi Connect 4 | `REVOLUTION_PI_CONNECT_4` |
| RevPi Compact | `REVOLUTION_PI_COMPACT` |
| Raspberry Pi 4 | `RASPBERRY_PI_4` |
| Raspberry Pi 5 | `RASPBERRY_PI_5` |
| Industrial PC | `INDUSTRIAL_PC` |
| Custom | `CUSTOM` |

### 8.3 I/O Konfigurasyonu

Her edge device icin I/O tag tanimlama:
- Tag tipleri: DI (Digital Input), DO (Digital Output), AI (Analog Input), AO (Analog Output)
- Data tipleri: BOOL, INT16, INT32, UINT16, UINT32, FLOAT32, FLOAT64
- Modbus, GPIO, I2C, SPI, UART bus destegi
- 4-seviye alarm: HH, H, L, LL + deadband

### 8.4 Hardware Auto-Detection (v2.3)

`useScanHardware()` mutation:
- Edge agent'a MQTT uzerinden `scan_hardware` komutu gonderir (15s timeout)
- Kesfedilen I/O kanallari: GPIO, I2C bus scan, SPI, UART
- `useBulkAddIoConfig()` ile toplu import

### 8.5 Provisioning Flow

1. `useCreateProvisionedDevice()` -> device kodu ve installer URL/command olusturur
2. Cihaza fiziksel kurulum: `installerCommand` calistirilir
3. Agent MQTT ile baslanir, PENDING_APPROVAL durumuna gecer
4. `useApproveEdgeDevice()` -> ACTIVE durumuna gecer
5. `useRegenerateDeviceToken()` -> token suresi doldugunda yenileme

### 8.6 Firmware Yonetimi

- `useAvailableFirmwareVersions()`: GitHub releases'den firmware listesi
- `useUpdateEdgeDeviceFirmware()`: Tek cihaz OTA guncelleme
- `useBulkUpdateEdgeDeviceFirmware()`: Toplu firmware guncelleme

### 8.7 BULGU [PERF-POZITIF-002]: React Query Kullanimi

Edge device hook'lari `@tanstack/react-query` kullaniyor:
- `staleTime: 10000` (10s) - sik degisen durum verisi icin uygun
- `refetchInterval: 30000` (30s) - online durum kontrolu
- `queryClient.invalidateQueries()` ile mutation sonrasi otomatik cache temizleme

Bu pattern sensor reading hook'larindan (ham `useState` + `useEffect`) daha temiz ve olgun.

---

## 9. Sensor Kayit (Registration) Sistemi

### 9.1 Kayit Wizard'i (6 Adim)

1. **Protocol Selection**: Desteklenen protokol listesinden secim
2. **Protocol Configuration**: JSON schema driven form (DynamicFormRenderer)
3. **Connection Test**: Baglanti testi ve ornek veri kesfetme
4. **Device Information**: Parent cihaz bilgileri (ad, model, konum)
5. **Configure Sensors**: Child sensor (veri kanali) tanimlama
6. **Review & Register**: Onay ve kayit

### 9.2 Desteklenen Protokoller (Backend)

Backend'de 30+ protokol adapter'i mevcut:
- IoT: MQTT, AMQP, DDS
- Endustriyel: Modbus TCP/RTU/ASCII, OPC-UA, Siemens S7, Profinet, EtherCAT
- BACnet IP/MS-TP, KNX IP, CANopen, DeviceNet
- Allen-Bradley (Ethernet/DF1), Omron FINS, Mitsubishi MC
- Schneider Modicon, CC-Link, PROFIBUS-DP

### 9.3 Parent-Child Sensör Modeli

Sensörler hiyerarsik yapida:
- **Parent Device**: Fiziksel cihaz (ornegin multi-parametre prob)
- **Child Sensor (Data Channel)**: Tek bir olcum kanali (pH, sicaklik, vb.)
- `isParentDevice` flag ile ayirt edilir
- `dataPath` ile hangi verinin cekilecegi belirlenir

---

## 10. Test Durumu

### 10.1 Mevcut Testler

| Test Dosyasi | Kapsam |
|-------------|--------|
| `simulation/__tests__/dosing-pump-e2e.test.ts` | Dozaj pompasi simulasyon E2E |
| `simulation/__tests__/st-interpreter.test.ts` | ST (Structured Text) interpreter |
| `simulation/__tests__/st-parser-lite.test.ts` | ST parser |
| `store/scada/__tests__/alignmentUtils.test.ts` | SCADA hizalama utility'leri |
| `store/scada/__tests__/groupAndLock.test.ts` | Gruplama ve kilitleme |
| `store/scada/__tests__/scadaStore.test.ts` | SCADA package store |
| `store/scada/__tests__/sceneUtils.test.ts` | Scene utility'leri |
| `store/scada/__tests__/screenIO.test.ts` | Screen I/O islemleri |
| `store/scada/__tests__/templateAndSelection.test.ts` | Template ve secim |
| `utils/__tests__/st-tag-extractor.test.ts` | ST tag extractor |
| `utils/__tests__/st-variable-parser.test.ts` | ST variable parser |

**Toplam: 11 test dosyasi**

### 10.2 BULGU [TEST-001]: Test Kapsaminda Kritik Bosluklar

**Yok olan testler:**
- `useSensorSocket.ts` - WebSocket baglanti yonetimi (singleton, reconnect, subscribe/unsubscribe)
- `useWidgetData.ts` - Widget veri akisi (WebSocket + GraphQL hybrid, race condition)
- `useSensorReadings.ts` - SCADA sensor okuma polling
- `useSensorThresholds.ts` - Esik degeri CRUD
- `useEdgeDevices.ts` - Edge device yonetimi (tum mutation hook'lari)
- `useEdgeIoSocket.ts` - Edge I/O WebSocket
- `processStore.ts` - Process editor state management
- `scadaStore.ts` - SCADA viewer state (okuma guncellemesi, status evaluasyonu)
- `SensorRegistrationWizard.tsx` - Kayit wizard'i (validation, step transitions)
- `ScadaViewer.tsx` - iframe postMessage protokolu

**Seviye: YUKSEK** - Veri akisi katmaninin hicbir testi yok. Ozellikle `useSensorSocket` ve `useWidgetData` gibi race condition iceren kod birim test olmadan risk tasiyor.

### 10.3 Test Altyapisi

```json
{
  "test": "vitest",
  "environment": "jsdom",
  "setupFiles": ["./src/test-setup.ts"]
}
```
Vitest yapilandirmasi mevcut, test altyapisi hazir. Sadece testler yazilmamis.

---

## 11. Performans Analizi ve Riskler

### 11.1 Buyuk Veri Seti Render Performansi

| Senaryo | Veri Noktasi | Recharts SVG | Risk |
|---------|-------------|--------------|------|
| 1h, 1 sensor, 1s interval | ~3.600 | Tek path, kabul edilebilir | DUSUK |
| 24h, 1 sensor, 1m agg | ~1.440 | Tek path, iyi | DUSUK |
| 7d, 3 sensor, 1m agg | ~30.240 | 3 path, potansiyel jank | ORTA |
| 30d, 5 sensor, 1m agg | ~216.000 | 5 path, ciddi performans | YUKSEK |

**Cozum onerisi:** Backend aggregation interval'ini zaman araligina gore otomatik secmesi (1m -> 5m -> 1h -> 1d) mevcut ve dogru. Ancak frontend'de ek max-point limiti (500-1000) eklenmeli.

### 11.2 Real-time Update Frekansi

| Bileşen | Guncelleme Sikliği | Yontem |
|---------|-------------------|--------|
| SCADA sensor overlay | Her WebSocket event | useSensorSocket |
| SCADA viewer canvas | Her sensorReadings degisikliginde | postMessage |
| Widget dashboard (canli deger) | Her WebSocket event | useWidgetData |
| Widget dashboard (tarihsel) | 60s (default) | setInterval + GraphQL |
| Edge device I/O | Her edgeIoData event | useEdgeIoSocket |
| Edge device listesi | 30s | react-query refetchInterval |

### 11.3 Memory Leak Risk Analizi

| Risk | Kaynak | Seviye | Mevcut Koruma |
|------|--------|--------|---------------|
| WebSocket listener birikmesi | useSensorSocket subscriber pattern | DUSUK | Unsubscribe cleanup mevcut |
| Interval birikmesi | useWidgetData setInterval | ORTA | Cleanup mevcut ama dep array karistirabilir |
| History buffer buyumesi | scadaStore reading.history | DUSUK | `.slice(-59)` ile 60 noktayla sinirli |
| Edge alarm birikmesi | useEdgeIoStore alarms | DUSUK | `.slice(0, 100)` ile 100 ile sinirli |
| Sensor info cache | useWidgetData sharedSensorInfoCache | DUSUK | Module-scope Map, TTL yok ama sensorler az degisir |
| postMessage listener | ScadaViewer useEffect | DUSUK | Cleanup mevcut (`removeEventListener`) |

### 11.4 Chart Re-render Optimizasyonu

| Optimizasyon | Dosya | Aciklama |
|-------------|-------|----------|
| PERF-003 | useSensorReadings.ts | Batch query (N adet fetch yerine 1) |
| PERF-004 | LineChartWidgetContent.tsx | TimeSinceUpdate izole timer |
| PERF-006 | SensorScadaPage.tsx | Tek gecis stat hesaplama |
| PERF-008 | scadaStore.ts | Map -> Record donusumu, fine-grained selector |
| PERF-010 | LineChartWidgetContent.tsx | 1-dakika bucket gruplama |
| PERF-011 | useWidgetData.ts | Module-scope sensorInfoCache |

---

## 12. Backend Sensor Service Ozeti

Backend'de 303 TypeScript dosyasi, asagidaki moduller:

| Modul | Amac |
|-------|------|
| `ingestion/` | MQTT listener, data processor, batch processor, validation |
| `aggregation/` | TimescaleDB time_bucket, rollup, statistical aggregation |
| `timescale/` | Hypertable, continuous aggregate, retention policy |
| `protocol/` | 30+ protokol adapter (IoT + Industrial) |
| `edge-device/` | Edge cihaz yonetimi, I/O config, lifecycle |
| `automation/` | ST compiler (lexer, parser, analyzer, formatter), program yonetimi |
| `mqtt/` | MQTT client, subscriber, publisher |
| `cleaning/` | Outlier detection, data cleaning, interpolation |
| `stream-processing/` | Anomaly detection, real-time analysis |
| `calibration/` | Kalibrasyon (frontend'e entegre edilmemis) |
| `plc-control/` | PLC kontrol komutlari |

---

## 13. Bulgu Ozet Tablosu

| ID | Kategori | Seviye | Baslik |
|----|----------|--------|--------|
| PERF-RISK-001 | Performans | DUSUK | Cift Socket.IO baglantisi (sensor + edge-io) |
| PERF-RISK-002 | Performans | YUKSEK | Buyuk veri setinde Recharts SVG DOM patlamasi |
| PERF-RISK-003 | Performans | ORTA | useWidgetData interval ref instabilitesi |
| PERF-RISK-004 | Performans | ORTA | Bulk threshold update N ayri mutation |
| PERF-POZITIF | Performans | - | WebSocket+GraphQL hybrid iyi tasarlanmis |
| PERF-POZITIF-002 | Performans | - | Edge device hooks React Query kullanimi |
| FUNC-001 | Fonksiyonel | ORTA | Kalibrasyon modulu stub (backend hazir, frontend eksik) |
| FUNC-002 | Fonksiyonel | YUKSEK | AlertsPage mock data (gercek alarm API yok) |
| SEC-001 | Guvenlik | DUSUK | WS_URL runtime config dogrulamasi |
| SEC-002 | Guvenlik | POZITIF | XSS korumasi ve origin dogrulama mevcut |
| SEC-003 | Guvenlik | BILGI | iframe sandbox sinirlamasi (allow-scripts+allow-same-origin) |
| TEST-001 | Test | YUKSEK | Veri akisi katmani test kapsaminda yok |

---

## 14. Oneriler (Oncelik Sirasina Gore)

### Kritik (Hemen)
1. **AlertsPage gercek API entegrasyonu:** Mock veriden cikip backend alert-service'e baglanmali
2. **Buyuk veri seti icin max data point limiti:** Frontend'de aggregated veri icin 500-1000 nokta siniri

### Yuksek (Sprint ici)
3. **Veri akisi katmani birim testleri:** useSensorSocket, useWidgetData, scadaStore icin test yazilmali
4. **Kalibrasyon entegrasyonu:** Backend calibration modulu frontend'e baglanmali

### Orta (Sonraki sprint)
5. **Socket.IO baglanti havuzu birlestirme:** useSensorSocket ve useEdgeIoSocket tek socket paylasmali
6. **Bulk threshold mutation:** N ayri mutation yerine tek bulk mutation API'si kullanilmali
7. **useWidgetData interval stabilizasyonu:** fetchData referans stabilitesi gozden gecirilmeli

### Dusuk (Backlog)
8. **Canvas-based chart kutuphanesi degerlendirmesi:** 30d+ araliklar icin uPlot veya ECharts canvas
9. **WS_URL runtime config dogrulamasi:** VITE_WS_URL ve __RUNTIME_CONFIG__ tutarliligi
10. **Turkce -> Ingilizce ceviri:** SensorScadaPage, ThresholdsPage gibi sayfalarda hala Turkce metin var
