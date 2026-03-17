# HMI Dönüşüm Planı: Simulation → Operatör HMI

## FUXA Analizi + Aquaculture Platform Mevcut Durum → Hedef Mimari

**Tarih:** 2026-03-17
**Kapsam:** FUXA'daki tüm HMI/SCADA yeteneklerini React/NestJS tabanlı aquaculture platform'a entegre etmek

---

## 1. MEVCUT DURUM ANALİZİ

### 1.1 Aquaculture Platform (Bugün)

**SCADA Builder (Editör Modu):**
- ReactFlow tabanlı canvas, 27 widget türü
- Grid-based layout, drag-and-drop, snap
- Widget renderers: gauge, numericDisplay, statusIndicator, tankLevel, trendChart, toggleSwitch, slider, numericInput, pushButton, emergencyStop, alarmBanner, alarmList, equipment, feeder, radialFilter, cleanWaterTank, dirtyWaterTank, mbbr, hepaFilter, calibrationWizard/History/Status, screenLink, staticText, processView
- 36+ equipment symbols (pumps, valves, tanks, heat exchangers)
- 3 edge type: orthogonal, multiHandle, draggable
- 9 connection type (ISA-5.1 P&ID: process-pipe, electrical, pneumatic, hydraulic, instrument, data-link, capillary, steam, drain-vent)
- Multi-screen support (6 screen type)
- Alarm rules with deadband/delay
- ST language parser + interpreter (simulation)
- Tag binding via useDeviceTags hook
- Undo/redo, copy-paste

**SCADA Viewer (Runtime Modu):**
- ScadaViewer.tsx — iframe-based read-only display
- PostMessage communication
- 5 runtime widget (NumericWidget, GaugeWidget, SparklineWidget, StatusWidget, WidgetContainer)
- Node selection + panel integration

**Simulation Modu:**
- SimulationPanel, SimulationSidebar
- Tag value injection, scenarios, alarm evaluation
- ST program closed-loop execution

**Eksikler:**
- Gerçek cihaz verisi bağlantısı yok (sadece simülasyon)
- Operatör etkileşimi eksik (yazma, onay, PIN)
- Trend charting demo-only
- Alarm ACK UI yok
- Script/automation motoru yok
- Touch/kiosk modu yok
- Bildirim sistemi yok
- Kullanıcı rol/yetki yönetimi HMI düzeyinde yok

### 1.2 FUXA (Referans)

**Widget Sistemi (18+ gauge türü):**
- Value — SVG text ile tag değer gösterimi
- HtmlButton — event-driven buton (navigate, setValue, runScript)
- HtmlInput — text/number/date/time/password input
- HtmlSelect — dropdown (range → text mapping)
- HtmlChart — uPlot-based trend chart (realtime + history)
- HtmlGraph — Chart.js bar/pie grafik
- HtmlBag — dial/donut/zone gauge
- HtmlSwitch — toggle switch (bitmask destekli)
- Slider — noUiSlider-based range slider
- GaugeProgress — SVG bar-fill progress
- GaugeSemaphore — color indicator (LED)
- Pipe — animated flow pipe (strokeDashoffset + image animation)
- Panel — embedded view container
- HtmlTable — data/history/alarms/reports tablo
- HtmlIframe — embedded iframe
- HtmlImage — raster/SVG image + widget script bridge
- HtmlVideo — video player with play/pause/stop/reset
- HtmlScheduler — calendar/time-schedule widget

**Shape Kütüphanesi:**
- 38 temel geometri (rect, circle, diamond, star, arrow, vb.)
- 112+ proses mühendisliği sembolü (pompalar, vanalar, motorlar, tanklar, ısı değiştiriciler, enstrümantasyon)
- 2 animasyonlu şekil (gear/spinner, piston)

**Runtime/View Modu:**
- Editor vs. Runtime tam ayrımı (isview flag)
- SVG innerHTML injection + gauge binding pipeline
- Socket.IO real-time data push (DEVICE_VALUES event)
- ViewSignalGaugeMap — signal → gauge index
- Kiosk modu (hidenavigation)
- Panzoom / autoresize zoom
- Touch keyboard (CDK overlay-based)
- Floating card overlay, modal dialog, iframe overlay
- Cards view (Gridster2 grid)
- View lifecycle events (onopen, onclose → script trigger)

**Alarm Sistemi:**
- 4 severity: HIGHHIGH (red), HIGH (yellow), LOW (grey), INFO (blue)
- State machine: VOID → ON → OFF → ACK (4 state)
- 3 ACK mode: float (auto-clear), ackactive, ackpassive
- SQLite storage: alarms (current) + chronicle (history)
- Server-side evaluation (1-sec interval)
- Alarm actions: setValue, runScript, popup, setView, toastMessage
- Notification: email (SMTP) + webhook (HTTP GET)
- Retention: 7d/30d/90d/1y/3y/5y

**Charts/Trends:**
- uPlot (Canvas-based) — line/step/spline/scatter, multi-Y-axis, zone coloring
- Chart.js — bar/pie
- 3 view type: realtime, history, custom (script-driven)
- Time range: last 8h/1d/3d/1w + custom date range
- Storage backends: SQLite, InfluxDB v1.8/v2, TDengine, QuestDB
- Data aggregation: min/max/avg/sum over 5min/10min/30min/hour/day intervals
- CSV export, PDF reports (server-side pdfmake + chartjs-node-canvas)

**Script/Automation:**
- JavaScript engine (Node.js Module._compile)
- 20+ system functions ($setTag, $getTag, $setView, $getHistoricalTags, $sendMessage, $getAlarms, vb.)
- Client-side scripts (eval-based) + Server-side scripts
- Triggers: schedule (interval/cron), alarm action, widget click, view lifecycle
- Scheduler widget (SQLite-persisted, weekly/monthly, master control tag)
- Plugin architecture (live-plugin-manager, Node-RED integration)

**Device/Tag Sistemi:**
- 14 protokol: FuxaServer, OPC-UA, Modbus RTU/TCP, MQTT, S7, BACnet, EthernetIP, WebAPI, ADS, GPIO, WebCam, MELSEC, REDIS, ODBC
- Tag model: id, name, address, memaddress, type, format, daq, scale, deadband, init
- Socket.IO subscription-based real-time push
- Tag browsing dialog (per-protocol property editors)
- Device status monitoring (5-sec health check)
- DAQ: per-tag persistence (enabled, changed, interval, restored)

**Security:**
- JWT auth (60-min access + 7-day refresh cookie)
- Bitmask groups (Viewer/Operator/Engineer/Supervisor/Manager/Admin)
- Role-based mode (custom roles with GUID)
- Per-widget permission: show (visibility) + enabled (interactivity)
- Server-side SVG filtering (remove events for disabled widgets)
- API key management (admin-level access)

---

## 2. HEDEF MİMARİ

### 2.1 Mimari Prensipler

1. **Separation of Concerns:** Builder (editör) ve Operator (runtime) tamamen ayrı modüller
2. **Provider Pattern:** Veri kaynağı soyutlanacak — SimulationDataProvider vs LiveDeviceDataProvider
3. **React + Zustand:** Mevcut store mimarisi korunacak, yeni slice'lar eklenecek
4. **NestJS Backend:** Alarm engine, script runner, DAQ storage, notification service
5. **WebSocket-first:** Socket.IO ile real-time data push (FUXA pattern)
6. **Progressive Enhancement:** Mevcut widget'lar korunacak, FUXA yetenekleri ekleme şeklinde

### 2.2 Modül Haritası

```
aquaculture_platform/
├── web/modules/sensor-module/src/
│   ├── components/
│   │   ├── scada-builder/          # [MEVCUT] Editör modu (değişmez)
│   │   ├── scada-operator/         # [YENİ] Operatör HMI modu
│   │   │   ├── OperatorShell.tsx           # Ana layout (header, sidenav, view area)
│   │   │   ├── OperatorView.tsx            # Runtime view renderer
│   │   │   ├── OperatorHeader.tsx          # Alarm badge, nav, user info
│   │   │   ├── OperatorSidenav.tsx         # View navigation menu
│   │   │   ├── AlarmPanel.tsx              # Alarm list/ack panel
│   │   │   ├── CardsDashboard.tsx          # Gridster-like card layout
│   │   │   ├── ViewOverlayManager.tsx      # Dialog/card/iframe overlays
│   │   │   ├── TouchKeyboard.tsx           # On-screen keyboard
│   │   │   ├── KioskMode.tsx              # Full-screen kiosk wrapper
│   │   │   └── widgets/                    # Runtime-optimized widget renderers
│   │   │       ├── RuntimeWidgetRenderer.tsx
│   │   │       ├── RuntimeGauge.tsx
│   │   │       ├── RuntimeChart.tsx        # uPlot integration
│   │   │       ├── RuntimeTable.tsx
│   │   │       ├── RuntimeInput.tsx
│   │   │       ├── RuntimeVideo.tsx
│   │   │       ├── RuntimeScheduler.tsx
│   │   │       └── RuntimePipe.tsx         # Animated pipe
│   │   ├── scada/                  # [MEVCUT] Mevcut viewer (deprecate edilecek)
│   │   └── charts/                 # [YENİ] Trend chart components
│   │       ├── TrendChart.tsx              # uPlot wrapper
│   │       ├── BarChart.tsx                # Chart.js bar
│   │       ├── PieChart.tsx                # Chart.js pie
│   │       ├── ChartToolbar.tsx            # Time range selector
│   │       └── ChartExport.tsx             # CSV/PDF export
│   ├── providers/                  # [YENİ] Veri kaynağı soyutlaması
│   │   ├── DataProviderContext.tsx
│   │   ├── SimulationDataProvider.tsx      # Mevcut simulation mantığı
│   │   ├── LiveDeviceDataProvider.tsx      # WebSocket-based real device data
│   │   └── HybridDataProvider.tsx          # Sim + live karışık
│   ├── store/scada/               # [MEVCUT + GENİŞLETME]
│   │   ├── ... (mevcut slice'lar)
│   │   ├── operatorSlice.ts       # [YENİ] Operator mode state
│   │   ├── alarmRuntimeSlice.ts   # [YENİ] Runtime alarm state (ACK, history)
│   │   ├── scriptSlice.ts         # [YENİ] Client-side script state
│   │   └── notificationSlice.ts   # [YENİ] Notification state
│   ├── hooks/                     # [MEVCUT + GENİŞLETME]
│   │   ├── useDeviceTags.ts       # [MEVCUT]
│   │   ├── useRealtimeData.ts     # [YENİ] WebSocket subscription hook
│   │   ├── useAlarmRuntime.ts     # [YENİ] Runtime alarm evaluation + ACK
│   │   ├── useTagWrite.ts         # [YENİ] Write tag value to device
│   │   ├── useOperatorPermission.ts # [YENİ] Widget permission check
│   │   ├── useTrendData.ts        # [YENİ] Historical data query hook
│   │   └── useClientScript.ts     # [YENİ] Client-side script execution
│   ├── simulation/                # [MEVCUT] ST parser, interpreter
│   └── services/                  # [YENİ]
│       ├── ScadaSocketService.ts          # Socket.IO client singleton
│       ├── TagSubscriptionManager.ts      # Tag subscription tracking
│       └── ScriptEngine.ts                # Client-side JS script runner
│
├── apps/sensor-service/src/       # [BACKEND GENİŞLETME]
│   ├── modules/
│   │   ├── scada-runtime/         # [YENİ] Server-side SCADA runtime
│   │   │   ├── scada-runtime.module.ts
│   │   │   ├── scada-runtime.gateway.ts    # WebSocket gateway
│   │   │   ├── alarm-engine.service.ts     # Server-side alarm evaluation
│   │   │   ├── alarm-storage.service.ts    # Alarm persistence (Prisma)
│   │   │   ├── script-engine.service.ts    # Server-side script execution
│   │   │   ├── scheduler.service.ts        # Cron/interval task scheduler
│   │   │   ├── daq-storage.service.ts      # Historical data storage
│   │   │   ├── notification.service.ts     # Email/webhook notifications
│   │   │   └── tag-manager.service.ts      # Tag subscription & value routing
│   │   └── ... (mevcut modüller)
```

---

## 3. UYGULAMA PLANI — FAZLAR

### FAZ 1: Data Provider Altyapısı (Temel)
**Süre tahmini: Haftalar değil, yapılacak iş birimi olarak**
**Öncelik: KRITIK — Diğer her şey buna bağlı**

#### 1.1 DataProvider Pattern
```typescript
// providers/DataProviderContext.tsx
interface IDataProvider {
  // Tag operations
  subscribeToTags(tagIds: string[]): void;
  unsubscribeFromTags(tagIds: string[]): void;
  onTagValueChanged: Observable<TagValueChange>;

  // Write operations
  writeTagValue(tagId: string, value: unknown): Promise<void>;

  // Historical data
  queryHistory(tagIds: string[], from: Date, to: Date): Promise<HistoryData>;

  // Device status
  getDeviceStatus(deviceId: string): DeviceStatus;
  onDeviceStatusChanged: Observable<DeviceStatusChange>;

  // Connection state
  connectionState: 'connected' | 'connecting' | 'disconnected';
}
```

#### 1.2 LiveDeviceDataProvider (WebSocket)
- Socket.IO client → NestJS gateway bağlantısı
- Tag subscription yönetimi (FUXA pattern: view açıldığında subscribe, kapandığında unsubscribe)
- Reconnection + exponential backoff
- Value buffering (burst protection)

#### 1.3 SimulationDataProvider (Mevcut mantığı wrap etme)
- Mevcut useSimulation hook'unu IDataProvider interface'ine sarmalama
- ST interpreter output → TagValueChange event

#### 1.4 HybridDataProvider
- Bazı tag'ler simülasyondan, bazıları gerçek cihazdan
- Override mekanizması (operatör manual değer girebilir)

**Dosyalar:**
- `providers/DataProviderContext.tsx`
- `providers/SimulationDataProvider.tsx`
- `providers/LiveDeviceDataProvider.tsx`
- `providers/HybridDataProvider.tsx`
- `services/ScadaSocketService.ts`
- `services/TagSubscriptionManager.ts`

---

### FAZ 2: Operatör Shell & Runtime View
**Öncelik: YÜKSEK**

#### 2.1 OperatorShell — Ana HMI Layout
FUXA'daki `HomeComponent` pattern'ını React'a uyarlama:

```
┌─────────────────────────────────────────────────┐
│ [≡] Logo  [View1] [View2]  🔔12  👤Operator  🕐│  ← OperatorHeader
├────────┬────────────────────────────────────────┤
│ View1  │                                        │
│ View2  │        RUNTIME VIEW AREA               │  ← OperatorView
│ View3  │    (widget renderers + data binding)    │
│ Alarms │                                        │
│        │                                        │
│        │                                        │
├────────┴────────────────────────────────────────┤
│ [Alarm Banner - active alarms ticker]           │  ← GlobalAlarmBanner
└─────────────────────────────────────────────────┘
```

**Özellikler:**
- Sidenav modu: void / overlay / push / fixed (FUXA NaviModeType)
- Header: configurable items (button, label, image), alarm badge, user info
- Alarm panel: slide-up full alarm list
- Kiosk mode: header + sidenav gizle
- Zoom: disabled / panzoom / autoresize (FUXA ZoomModeType)

#### 2.2 OperatorView — Runtime Widget Rendering
Mevcut ScadaViewer'ı yeniden yazma:

**FUXA'dan alınacak pattern:**
1. Screen'deki widget listesini al
2. Her widget için DataProvider'dan ilgili tag'lere subscribe ol
3. Tag değeri değiştiğinde widget'a prop olarak ilet
4. Widget etkileşimlerini (click, toggle, setValue) DataProvider.writeTagValue() üzerinden gönder
5. View değiştiğinde eski subscription'ları temizle

**Farklar (FUXA SVG → Bizim ReactFlow):**
- FUXA SVG innerHTML injection kullanıyor, biz ReactFlow node rendering kullanıyoruz
- FUXA'da element positioning SVG koordinatları, bizde ReactFlow node position
- Bizim mevcut WidgetRenderer.tsx + widget-renderers/ yapımız çalışıyor, sadece veri kaynağını değiştirmemiz lazım

#### 2.3 Widget Permission System
FUXA pattern'ından ilham:

```typescript
interface WidgetPermission {
  show: string[];    // Hangi roller görebilir
  enabled: string[]; // Hangi roller etkileşebilir
}

// Per-widget kontrol:
// show=false → widget gizle
// enabled=false → events kaldır, input disable et
```

**Dosyalar:**
- `components/scada-operator/OperatorShell.tsx`
- `components/scada-operator/OperatorView.tsx`
- `components/scada-operator/OperatorHeader.tsx`
- `components/scada-operator/OperatorSidenav.tsx`
- `components/scada-operator/KioskMode.tsx`
- `hooks/useOperatorPermission.ts`
- `store/scada/operatorSlice.ts`

---

### FAZ 3: Runtime Widget Renderers
**Öncelik: YÜKSEK**

Mevcut widget-renderers/'daki bileşenleri runtime-optimized versiyonlarına dönüştürme. Anahtar fark: editor modda config UI gösterir, runtime modda sadece veri gösterir + etkileşim sağlar.

#### 3.1 Mevcut Widget'ları Runtime-Ready Yapma

Her widget renderer'a şu prop'ları ekle:
```typescript
interface RuntimeWidgetProps {
  // Data binding
  value: unknown;                    // Tag'den gelen güncel değer
  timestamp: number;                 // Son güncelleme zamanı
  quality: 'good' | 'bad' | 'uncertain';

  // Interactivity
  onCommand: (cmd: string, val?: unknown) => void;  // [MEVCUT]
  isOperatorMode: boolean;           // [YENİ] true = runtime
  isEnabled: boolean;                // [YENİ] permission-based
  isReadOnly: boolean;               // [YENİ] viewer role

  // Actions (FUXA GaugeAction pattern)
  actions?: WidgetAction[];          // Tag-value-driven behaviors
}
```

#### 3.2 Yeni Widget Türleri (FUXA'dan)

| Widget | Kaynak | Açıklama | Öncelik |
|--------|--------|----------|---------|
| `animatedPipe` | FUXA Pipe | strokeDashoffset animasyonlu boru | YÜKSEK |
| `trendChartLive` | FUXA HtmlChart | uPlot realtime trend | YÜKSEK |
| `trendChartHistory` | FUXA HtmlChart | uPlot history + time range | YÜKSEK |
| `barChart` | FUXA HtmlGraph | Chart.js bar chart | ORTA |
| `pieChart` | FUXA HtmlGraph | Chart.js pie chart | ORTA |
| `dataTable` | FUXA HtmlTable | Realtime/history/alarm data table | YÜKSEK |
| `htmlInput` | FUXA HtmlInput | Operatör değer girişi | YÜKSEK |
| `htmlSelect` | FUXA HtmlSelect | Dropdown seçici | YÜKSEK |
| `dialGauge` | FUXA HtmlBag | dial/donut/zone gauge | ORTA |
| `videoPlayer` | FUXA HtmlVideo | Video + play/pause kontrol | DÜŞÜK |
| `scheduleWidget` | FUXA HtmlScheduler | Calendar scheduler | DÜŞÜK |
| `panelWidget` | FUXA Panel | Embedded view container | ORTA |
| `iframeWidget` | FUXA HtmlIframe | Embedded external content | DÜŞÜK |

#### 3.3 Widget Actions (FUXA GaugeAction Pattern)

FUXA'nın tag-value-driven action sistemi:

```typescript
interface WidgetAction {
  tagId: string;          // İzlenecek tag
  bitmask?: number;       // Değer maskeleme
  type: WidgetActionType;
  range: { min: number; max: number };
  params: Record<string, unknown>;
}

type WidgetActionType =
  | 'hide'          // Widget'ı gizle
  | 'show'          // Widget'ı göster
  | 'blink'         // Renk yanıp sönme (fillA/B, strokeA/B, interval)
  | 'color'         // Değere göre renk değiştirme
  | 'rotate'        // Değere göre döndürme (min/maxAngle)
  | 'move'          // Pozisyon animasyonu (toX, toY, duration)
  | 'animate'       // Flow animasyonu (clockwise, anticlockwise, stop)
  | 'refreshImage'; // Webcam image refresh
```

**Dosyalar:**
- `components/scada-operator/widgets/RuntimeWidgetRenderer.tsx`
- `components/scada-operator/widgets/RuntimeChart.tsx`
- `components/scada-operator/widgets/RuntimeTable.tsx`
- `components/scada-operator/widgets/RuntimeInput.tsx`
- `components/scada-operator/widgets/RuntimePipe.tsx`
- `components/scada-operator/widgets/RuntimeVideo.tsx`
- `components/scada-builder/widget-renderers/` (mevcut — isOperatorMode prop ekleme)
- `hooks/useWidgetActions.ts`

---

### FAZ 4: Alarm Runtime Engine
**Öncelik: YÜKSEK**

#### 4.1 Server-Side Alarm Engine (NestJS)

FUXA'nın 1-saniyelik alarm evaluation loop'unu NestJS service olarak implemente etme:

```typescript
// alarm-engine.service.ts
@Injectable()
class AlarmEngineService {
  // FUXA pattern: 1-sec evaluation interval
  private evaluationInterval: NodeJS.Timer;

  // State machine: VOID → ON → OFF → ACK
  evaluateAlarm(rule: AlarmRule, currentValue: number): AlarmState;

  // ACK modes: float, ackactive, ackpassive
  acknowledgeAlarm(alarmId: string, userId: string): void;

  // Actions: setValue, runScript, popup, setView, toastMessage
  executeAlarmActions(alarm: AlarmState, actions: AlarmAction[]): void;
}
```

**FUXA'dan alınacak:**
- 4-state machine (VOID, ON, OFF, ACK)
- 3 ACK mode (float, ackactive, ackpassive)
- checkdelay + timedelay
- Bitmask support
- Action execution on state change

#### 4.2 Alarm Storage (Prisma/PostgreSQL)

```sql
-- Aktif alarmlar
CREATE TABLE scada_alarms (
  id UUID PRIMARY KEY,
  rule_id UUID REFERENCES scada_alarm_rules(id),
  severity TEXT NOT NULL,  -- highhigh, high, low, info
  status TEXT NOT NULL,    -- active, cleared, acknowledged
  on_time TIMESTAMPTZ NOT NULL,
  off_time TIMESTAMPTZ,
  ack_time TIMESTAMPTZ,
  ack_user_id UUID,
  current_value DOUBLE PRECISION,
  message TEXT
);

-- Alarm geçmişi (append-only)
CREATE TABLE scada_alarm_chronicle (
  id BIGSERIAL PRIMARY KEY,
  rule_id UUID,
  severity TEXT,
  status TEXT,
  message TEXT,
  group_name TEXT,
  on_time TIMESTAMPTZ,
  off_time TIMESTAMPTZ,
  ack_time TIMESTAMPTZ,
  ack_user_id UUID
);
```

#### 4.3 Client-Side Alarm UI

```
┌─────────────────────────────────────────────┐
│ 🔴 HIGHHIGH: 3  🟡 HIGH: 5  ⚪ LOW: 2  ℹ️ 1 │  ← AlarmSummaryBar
├─────────────────────────────────────────────┤
│ Time      │ Severity │ Message  │ Status │ ACK │
│ 14:23:01  │ 🔴 HH   │ pH>8.5   │ Active │ [✓] │
│ 14:20:15  │ 🟡 H    │ Temp>28  │ Cleared│ [✓] │
│ 14:18:00  │ ⚪ L    │ Flow<10  │ ACK'd  │  ✓  │
├─────────────────────────────────────────────┤
│ [ACK All] [Filter ▼] [History] [Export CSV] │
└─────────────────────────────────────────────┘
```

#### 4.4 Notification Service

```typescript
// notification.service.ts
@Injectable()
class NotificationService {
  // FUXA pattern: email + webhook
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendWebhook(url: string, payload: object): Promise<void>;

  // Alarm → notification routing
  checkNotifications(alarmChanges: AlarmState[]): void;

  // Configuration
  subscriptions: NotificationSubscription[]; // severity filter + delay + interval
}
```

**Dosyalar:**
- `apps/sensor-service/src/modules/scada-runtime/alarm-engine.service.ts`
- `apps/sensor-service/src/modules/scada-runtime/alarm-storage.service.ts`
- `apps/sensor-service/src/modules/scada-runtime/notification.service.ts`
- `components/scada-operator/AlarmPanel.tsx`
- `components/scada-operator/AlarmSummaryBar.tsx`
- `hooks/useAlarmRuntime.ts`
- `store/scada/alarmRuntimeSlice.ts`

---

### FAZ 5: Trend Charts & Historical Data
**Öncelik: YÜKSEK**

#### 5.1 uPlot Integration (FUXA Pattern)

```typescript
// components/charts/TrendChart.tsx
interface TrendChartProps {
  mode: 'realtime' | 'history' | 'custom';
  lines: ChartLine[];          // tag bindings + styling
  options: ChartOptions;       // FUXA ChartOptions subset
  realtimeWindowMinutes?: number;
  historyRange?: { from: Date; to: Date };
}

// FUXA'dan alınacak özellikler:
// - Multi-Y-axis (up to 4)
// - Zone coloring (value-range-based gradient)
// - Line interpolation: linear, step-after, step-before, spline, scatter
// - Mouse wheel scroll + zoom
// - Touch pinch zoom
// - Chunked data loading (12-hour chunks)
// - Proximity tooltip
```

#### 5.2 DAQ Storage Backend

Mevcut PostgreSQL + TimescaleDB veya InfluxDB:

```typescript
// daq-storage.service.ts
@Injectable()
class DaqStorageService {
  // Write: per-tag persistence with change detection
  addValues(values: TagValue[]): Promise<void>;

  // Read: time-range query with chunking
  queryValues(tagIds: string[], from: Date, to: Date): Promise<DaqData>;

  // Aggregation (FUXA calculator pattern)
  queryAggregated(tagIds: string[], from: Date, to: Date,
    interval: '5min'|'10min'|'30min'|'1h'|'1d',
    func: 'min'|'max'|'avg'|'sum'): Promise<AggregatedData>;

  // Retention cleanup
  cleanupOldData(retentionDays: number): Promise<void>;
}
```

#### 5.3 Chart Toolbar

```
[◄] [Last 8h ▼] [►]  [📅 Custom Range]  [↻ Auto-refresh: 1min ▼]  [📥 Export]
```

FUXA time ranges: last8h, last1d, last3d, last1w + custom date range dialog

**Dosyalar:**
- `components/charts/TrendChart.tsx` (uPlot wrapper)
- `components/charts/BarChart.tsx` (Chart.js)
- `components/charts/PieChart.tsx` (Chart.js)
- `components/charts/ChartToolbar.tsx`
- `components/charts/ChartExport.tsx`
- `hooks/useTrendData.ts`
- `apps/sensor-service/src/modules/scada-runtime/daq-storage.service.ts`

---

### FAZ 6: Script & Automation Engine
**Öncelik: ORTA**

#### 6.1 Server-Side Script Engine

FUXA'dan ilham alan JavaScript script çalıştırıcı:

```typescript
// script-engine.service.ts
@Injectable()
class ScriptEngineService {
  // System functions (FUXA $xxx pattern)
  private systemFunctions = {
    $getTag: (id: string) => this.tagManager.getTagValue(id),
    $setTag: (id: string, value: unknown) => this.tagManager.setTagValue(id, value),
    $setView: (viewName: string) => this.gateway.broadcastCommand('SETVIEW', viewName),
    $getHistoricalTags: (ids: string[], from: Date, to: Date) => this.daq.query(ids, from, to),
    $sendMessage: (to: string, subject: string, body: string) => this.notification.send(to, subject, body),
    $getAlarms: () => this.alarmEngine.getActiveAlarms(),
    $ackAlarm: (name: string) => this.alarmEngine.acknowledge(name),
  };

  // Script execution (Node.js vm module for sandboxing)
  runScript(script: ScadaScript, params?: Record<string, unknown>): Promise<unknown>;
}
```

**FUXA vs Bizim yaklaşım farkları:**
- FUXA: `Module._compile` (no sandbox) → Biz: `vm.runInContext` (sandboxed)
- FUXA: global scope injection → Biz: explicit context passing
- FUXA: client-side eval() → Biz: server-side only (güvenlik)

#### 6.2 Scheduler Service

```typescript
// scheduler.service.ts
@Injectable()
class SchedulerService {
  // FUXA pattern: interval + cron + one-shot
  scheduleScript(script: ScadaScript, scheduling: ScriptScheduling): void;

  // Scheduler widget support
  createSchedulerJob(config: SchedulerConfig): void;

  // Master control tag override
  setMasterControl(tagId: string, value: boolean): void;
}
```

#### 6.3 Widget Event Actions

FUXA'nın event action listesini React widget'larına ekleme:

```typescript
type WidgetEventAction =
  | { type: 'navigate'; viewId: string }              // onpage
  | { type: 'openDialog'; viewId: string }             // ondialog
  | { type: 'openCard'; viewId: string; position?: XY } // onwindow
  | { type: 'openTab'; url: string }                   // onOpenTab
  | { type: 'setValue'; tagId: string; value: unknown } // onSetValue
  | { type: 'toggleValue'; tagId: string }             // onToggleValue
  | { type: 'runScript'; scriptId: string; params?: Record<string, unknown> } // onRunScript
  | { type: 'close' };                                 // onclose

type WidgetEventTrigger = 'click' | 'dblclick' | 'mousedown' | 'mouseup'
  | 'mouseover' | 'mouseout' | 'onLoad';
```

**Dosyalar:**
- `apps/sensor-service/src/modules/scada-runtime/script-engine.service.ts`
- `apps/sensor-service/src/modules/scada-runtime/scheduler.service.ts`
- `services/ScriptEngine.ts` (client-side, limited)
- `hooks/useClientScript.ts`
- `store/scada/scriptSlice.ts`

---

### FAZ 7: Yeni Shape/Symbol Kütüphanesi
**Öncelik: ORTA**

#### 7.1 FUXA Shape Library Portlama

FUXA'daki 112+ proses mühendisliği sembolünü SVG React bileşenlerine dönüştürme:

```
Mevcut (36 sembol):           Hedef (150+ sembol):
├── Pumps (6)                 ├── Pumps (23+): + diaphragm, jet, gear-ext,
│                             │   turbine, blower, screw, peristaltic, vane
├── Valves (9)                ├── Valves (15+): + 3-way, butterfly-ext,
│                             │   relief-ext, proportional
├── Tanks (6)                 ├── Tanks (10+): + agitated, jacketed,
│                             │   clarifier, separator
├── Heat Exchangers (4)       ├── Heat Exchangers (8+): + plate, finned tube,
│                             │   reboiler, cooler
│                             ├── Motors (5+): AC, DC, VFD, stepper, servo
│                             ├── Compressors (10+): piston, screw, centrifugal,
│                             │   diaphragm, rotary, ejector
│                             ├── Filters (6+): bag, cartridge, drum, press,
│                             │   sand, membrane
│                             ├── Instruments (15+): transmitters, controllers,
│                             │   actuators, indicators (ISA-5.1)
│                             └── Animated (5+): gear, piston, conveyor,
│                                 agitator, flow arrows
```

#### 7.2 Animated Shapes

FUXA'daki animasyon pattern'larını React'a taşıma:

```typescript
// Pipe flow animation (FUXA: strokeDashoffset)
const AnimatedPipe: React.FC<PipeProps> = ({ direction, speed, color }) => {
  // requestAnimationFrame-based dash animation
  // direction: 'clockwise' | 'anticlockwise' | 'stop'
};

// Rotating element (FUXA: SVG rotate transform)
const RotatingEquipment: React.FC<RotateProps> = ({ angle, minAngle, maxAngle }) => {
  // CSS transform: rotate() with transition
};

// Piston animation (FUXA: translateY oscillation)
const PistonAnimation: React.FC<PistonProps> = ({ amplitude, speed }) => {
  // requestAnimationFrame-based Y oscillation
};
```

**Dosyalar:**
- `components/scada-builder/equipment-symbols/` (mevcut — genişletme)
- `components/scada-builder/widget-renderers/AnimatedPipeRenderer.tsx`
- `components/scada-builder/widget-renderers/RotatingEquipmentRenderer.tsx`

---

### FAZ 8: Touch/Kiosk & Advanced UI
**Öncelik: DÜŞÜK**

#### 8.1 Touch Keyboard
FUXA'nın CDK overlay-based touch keyboard'unu React'a uyarlama:

```typescript
// TouchKeyboard.tsx
interface TouchKeyboardProps {
  mode: 'disabled' | 'normal' | 'fullscreen';
  layout: 'text' | 'numeric' | 'decimal';
  anchorElement: HTMLElement;
  onInput: (value: string) => void;
  onEnter: () => void;
}
```

#### 8.2 View Overlay Manager
FUXA'nın 3 overlay türünü React'a ekleme:

```typescript
// ViewOverlayManager.tsx
type Overlay =
  | { type: 'dialog'; viewId: string; position: 'center' }
  | { type: 'card'; viewId: string; position: XY; draggable: true }
  | { type: 'iframe'; url: string; position: XY; resizable: true };
```

#### 8.3 Cards Dashboard (Gridster Alternative)
FUXA'nın CardView pattern'ını react-grid-layout ile:

```typescript
// CardsDashboard.tsx
interface CardItem {
  type: 'view' | 'alarms' | 'iframe';
  viewId?: string;
  url?: string;
  zoom?: number; // 0.1-2.0 scale
  layout: { x: number; y: number; w: number; h: number };
}
```

**Dosyalar:**
- `components/scada-operator/TouchKeyboard.tsx`
- `components/scada-operator/ViewOverlayManager.tsx`
- `components/scada-operator/CardsDashboard.tsx`

---

### FAZ 9: Security & Permissions (HMI Level)
**Öncelik: ORTA**

#### 9.1 HMI Permission Model

FUXA'nın ikili permission modelini uyarlama:

```typescript
interface HmiPermission {
  // Per-widget
  show: string[];     // Hangi roller widget'ı görebilir
  enabled: string[];  // Hangi roller etkileşebilir
}

// Role hierarchy (FUXA-inspired)
type HmiRole = 'viewer' | 'operator' | 'engineer' | 'supervisor' | 'admin';

// Permission enforcement:
// 1. Server-side: Package data filtreleme (show=false → widget kaldır)
// 2. Client-side: enabled=false → events disable, inputs readonly
```

#### 9.2 Operatör Güvenlik Kontrolleri

Mevcut ControlPermissions yapısını genişletme:
```typescript
interface ControlPermissions {
  securityLevels: {
    none: string[];     // Onay gerekmez
    confirm: string[];  // Onay dialogu
    pin: string[];      // PIN koruması
  };
  pinHash: string | null;
  emergencyStop?: {
    holdDuration: number;
    affectedTags: string[];
    resetRequiresPin: boolean;
  };
  // [YENİ] FUXA-inspired
  writeAuthorization: 'authenticated' | 'operator+' | 'engineer+' | 'admin';
}
```

---

### FAZ 10: WebSocket Gateway (Backend)
**Öncelik: KRITIK — Faz 1 ile paralel**

#### 10.1 NestJS WebSocket Gateway

FUXA'nın Socket.IO event pattern'ını NestJS'e uyarlama:

```typescript
// scada-runtime.gateway.ts
@WebSocketGateway({ namespace: '/scada' })
class ScadaRuntimeGateway {
  // FUXA IoEventTypes pattern:

  @SubscribeMessage('device-tags-subscribe')
  handleTagSubscribe(client: Socket, tagIds: string[]): void;

  @SubscribeMessage('device-tags-unsubscribe')
  handleTagUnsubscribe(client: Socket, tagIds: string[]): void;

  @SubscribeMessage('device-values')
  handleDeviceValues(client: Socket, data: { cmd: 'set'|'get', var?: TagValue }): void;

  @SubscribeMessage('daq-query')
  handleDaqQuery(client: Socket, query: DaqQuery): void;

  @SubscribeMessage('alarm-ack')
  handleAlarmAck(client: Socket, data: { alarmId: string }): void;

  // Server → Client pushes:
  pushTagValues(tagValues: TagValue[]): void;        // device-values
  pushAlarmStatus(status: AlarmStatus): void;         // alarms-status
  pushScriptCommand(cmd: ScriptCommand): void;        // script-command
}
```

#### 10.2 Tag Subscription Management

```typescript
// tag-manager.service.ts
@Injectable()
class TagManagerService {
  // Per-socket subscription tracking (FUXA pattern)
  private socketSubscriptions: Map<string, Set<string>>; // socketId → tagIds

  // Value routing: only send subscribed tags to each socket
  routeTagValues(deviceId: string, values: TagValue[]): void;

  // Broadcast mode toggle (FUXA broadcastAll pattern)
  broadcastAll: boolean;
}
```

**Dosyalar:**
- `apps/sensor-service/src/modules/scada-runtime/scada-runtime.module.ts`
- `apps/sensor-service/src/modules/scada-runtime/scada-runtime.gateway.ts`
- `apps/sensor-service/src/modules/scada-runtime/tag-manager.service.ts`

---

## 4. UYGULAMA SIRASI (Dependency Graph)

```
Faz 10 (Gateway) ──┐
                    ├──→ Faz 1 (DataProvider) ──→ Faz 2 (Operator Shell)
                    │                                     │
                    │                                     ├──→ Faz 3 (Runtime Widgets)
                    │                                     │         │
                    │                                     │         ├──→ Faz 7 (Shapes)
                    │                                     │         └──→ Faz 8 (Touch/Kiosk)
                    │                                     │
                    │                                     └──→ Faz 4 (Alarms) ──→ Faz 6 (Scripts)
                    │
                    └──→ Faz 5 (Trends/DAQ)

                    Faz 9 (Security) — her fazda incremental olarak
```

**Kritik yol:** Faz 10 → Faz 1 → Faz 2 → Faz 3

**Paralel çalışılabilecek:**
- Faz 5 (Trends) Faz 1 bitince paralel başlayabilir
- Faz 4 (Alarms) Faz 2 ile paralel
- Faz 7 (Shapes) Faz 3 ile paralel
- Faz 8 (Touch) en son

---

## 5. FUXA → AQUACULTURE PLATFORM MAPPING

| FUXA Konsepti | Bizim Karşılığı | Durum |
|---------------|-----------------|-------|
| SVG Canvas (SVG-Edit) | ReactFlow Canvas | ✅ MEVCUT |
| Gauge types (18) | Widget types (27+) | ✅ MEVCUT (çoğu) |
| Shape library (150+) | Equipment symbols (36) | ⚠️ GENİŞLETME |
| View management | Screen management | ✅ MEVCUT |
| FuxaView (runtime) | OperatorView | 🆕 YAPILACAK |
| Socket.IO real-time | WebSocket gateway | 🆕 YAPILACAK |
| HmiService | DataProviderContext | 🆕 YAPILACAK |
| GaugesManager | RuntimeWidgetRenderer | 🆕 YAPILACAK |
| AlarmManager (server) | AlarmEngineService | 🆕 YAPILACAK |
| AlarmView (client) | AlarmPanel | ⚠️ GENİŞLETME |
| HtmlChart (uPlot) | TrendChart | 🆕 YAPILACAK |
| DaqStorage (SQLite/InfluxDB) | DaqStorageService | 🆕 YAPILACAK |
| Script engine (JS) | ScriptEngineService | 🆕 YAPILACAK |
| Scheduler | SchedulerService | 🆕 YAPILACAK |
| Notificator (email/webhook) | NotificationService | 🆕 YAPILACAK |
| User groups/roles | HMI permissions | 🆕 YAPILACAK |
| Touch keyboard | TouchKeyboard | 🆕 YAPILACAK |
| Cards view (Gridster) | CardsDashboard | 🆕 YAPILACAK |
| Kiosk mode | KioskMode | 🆕 YAPILACAK |
| GaugeAction (blink/hide/rotate) | WidgetAction | 🆕 YAPILACAK |
| Pipe animation | AnimatedPipe | 🆕 YAPILACAK |
| Process Eng shapes (112+) | Equipment symbols expand | ⚠️ GENİŞLETME |
| Node-RED integration | — | ❌ KAPSAM DIŞI |
| SVG-Edit editor | ReactFlow editor | ✅ MEVCUT (farklı yaklaşım) |

---

## 6. TEKNOLOJİ KARARLARI

| Karar | Seçim | Gerekçe |
|-------|-------|---------|
| Trend chart library | **uPlot** | FUXA'da kanıtlanmış, Canvas-based, yüksek performans, küçük bundle |
| Bar/Pie chart library | **Chart.js** | FUXA'da kanıtlanmış, geniş ekosistem |
| Grid dashboard | **react-grid-layout** | React native, FUXA Gridster2 eşdeğeri |
| WebSocket | **Socket.IO** (NestJS @nestjs/websockets) | FUXA ile aynı, reconnection built-in |
| Historical DB | **TimescaleDB** (PostgreSQL extension) | Mevcut Postgres altyapısına uyumlu |
| Script sandbox | **Node.js vm module** | FUXA'dan daha güvenli (Module._compile yerine) |
| Touch keyboard | **Custom React component** | FUXA CDK overlay pattern'ını React'a uyarla |
| PDF reports | **pdfmake** | FUXA'da kanıtlanmış, server-side generation |

---

## 7. RİSKLER VE ÇÖZÜMLER

| Risk | Etki | Çözüm |
|------|------|-------|
| uPlot React wrapper maturity | Orta | Kendi thin wrapper yazacağız (FUXA pattern) |
| Real-time performans (çok tag) | Yüksek | Subscription filtering (FUXA pattern), value batching |
| Script engine güvenlik | Yüksek | vm module sandbox, timeout, memory limit |
| ReactFlow vs SVG positioning farkı | Orta | Runtime'da ReactFlow kullanmaya devam, positioning zaten çalışıyor |
| Mevcut SimulationPanel ile uyumluluk | Düşük | DataProvider pattern sayesinde soyutlanıyor |
| Bundle size artışı (uPlot + Chart.js) | Düşük | Lazy loading, code splitting |

---

## 8. BAŞARI KRİTERLERİ

1. **Operatör bir SCADA ekranını açıp gerçek zamanlı verileri görebilmeli**
2. **Operatör widget'a tıklayıp tag değeri yazabilmeli (permission dahilinde)**
3. **Alarmlar otomatik değerlenmeli, ACK yapılabilmeli**
4. **Trend grafikleri real-time + historik modda çalışmalı**
5. **Kiosk modunda dokunmatik ekranda çalışabilmeli**
6. **Mevcut SCADA builder ile oluşturulan paketler operatör modunda açılabilmeli**
7. **Simülasyon modu hala çalışıyor olmalı (geriye uyumluluk)**
