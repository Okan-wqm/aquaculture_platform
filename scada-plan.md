# Unified SCADA/Process Editor -- Kapsamli Muhendislik Plani

**Versiyon:** 3.0
**Tarih:** 2026-03-06
**Durum:** Taslak
**Proje:** Aquaculture Platform -- SCADA Modulu Birlesik Editor

---

## Icerik

1. [Yonetici Ozeti](#1-yonetici-ozeti)
2. [Mevcut Durum](#2-mevcut-durum)
3. [Hedef Mimari](#3-hedef-mimari)
4. [Detayli Tasarim](#4-detayli-tasarim)
   - 4.1 [Component Hierarchy & Mode Sistemi](#41-component-hierarchy--mode-sistemi)
   - 4.2 [ReactFlow Entegrasyonu & Widget Node Pattern](#42-reactflow-entegrasyonu--widget-node-pattern)
   - 4.3 [Multi-Screen Mimarisi](#43-multi-screen-mimarisi)
   - 4.4 [Unified Tag Namespace](#44-unified-tag-namespace)
   - 4.5 [Real-time Data Flow](#45-real-time-data-flow)
   - 4.6 [CodeSys/SoftPLC Entegrasyonu](#46-codesyssoftplc-entegrasyonu)
   - 4.7 [Edge Deploy Pipeline](#47-edge-deploy-pipeline)
   - 4.8 [UX & Interaction Design](#48-ux--interaction-design)
5. [Data Model](#5-data-model)
6. [Migration Stratejisi](#6-migration-stratejisi)
7. [Uygulama Yol Haritasi](#7-uygulama-yol-haritasi)
8. [Risk Matrisi](#8-risk-matrisi)
9. [Kritik Dosya Referanslari](#9-kritik-dosya-referanslari)

---

## 1. Yonetici Ozeti

### Problem

Aquaculture Platform'da P&ID sureclerini tasarlayan **Process Editor**, HMI ekranlarini olusturan **SCADA Builder** ve PLC programlama araclari su anda ayri uygulamalar olarak calisir. Operatorler bir sureci tasarladiktan sonra, ayri bir aracta widget'lari yeniden konumlandirmak, tag'leri manuel baglamak ve deploy islemini tekrarlamak zorunda kalir. Bu kopuk is akisi zaman kaybi, tutarsizlik ve hata riski yaratir.

### Cozum

Mevcut **Process Editor** altyapisini genisletip **Unified Editor** haline getirmek. Yeni bir uygulama yazmak yerine, kanitmis ReactFlow tabanli editor'e SCADA widget katmani, PLC programlama paneli ve runtime izleme modu eklemek. Tek bir aracta P&ID tasarimi, HMI konfigurasyonu, PLC kodlama ve canli izleme yapilabilecek.

### Yaklasim

- **Genisletme, yeniden yazmama:** Process Editor'un 35+ node tipi, 3 edge tipi, iframe PostMessage protokolu korunur
- **Mode tabanli UI:** P&ID, HMI, PLC, Runtime, Debug -- 5 modlu editor
- **Overlay pattern:** SCADA widget'lari ReactFlow node'lari olarak P&ID ustunde z-index ayrimiyla
- **Unified Tag Namespace:** OPC-UA ilhamli hiyerarsik FQN, geriye uyumlu
- **Incremental deploy:** PLC -> Process -> SCADA siralamasinda, delta bazli edge push

### Beklenen Kazanimlar

| Metrik | Mevcut | Hedef |
|--------|--------|-------|
| Yeni proje kurulum suresi | ~4 saat (3 arac) | ~1 saat (tek arac) |
| Tag baglama hatasi | Manuel, hata egilimli | Otomatik discovery + binding |
| Deploy adim sayisi | 3 ayri deploy | Tek tusla unified deploy |
| Runtime izleme | Ayri SCADA ekrani | Editor icinde canli mod |
| Operator egitim suresi | 3 arac ogrenmeli | 1 arac, mod gecisli |

---

## 2. Mevcut Durum

### 2.1 Process Editor

**Konum:** `web/modules/sensor-module/src/components/process-editor/`
**Store:** `web/modules/sensor-module/src/store/processStore.ts`

- **Canvas:** ReactFlow, iframe icinde calisir (`ProcessEditorCanvas`)
- **Node tipleri:** 35+ (FishTank, DrumFilter, UV, Blower, Settler, Ultrafiltration, AlgaeBag, vb.)
- **Edge tipleri:** 3 (DraggableEdge, OrthogonalEdge, MultiHandleEdge)
- **Paneller:** EquipmentPanel (sol), PropertiesPanel (sag), SensorSelectionPanel, AttachmentsPanel
- **Iframe iletisimi:** PostMessage protokolu (addNode, updateNode, deleteNode, getState, setState, fitView, vb.)
- **Deploy:** DeployToEdgeDialog -- surecl paketini edge cihazina gonderir

**Gucluu yonler:**
- Olgun, test edilmis ReactFlow entegrasyonu
- Ekipman node'lari SVG tabanli, olceklenebilir
- SensorWidget overlay'i zaten mevcut (tag gosterimi ekipman uzerinde)
- PostMessage API genisletilebilir yapida

### 2.2 SCADA Builder

**Konum:** `web/modules/sensor-module/src/components/scada-builder/`
**Store:** `web/modules/sensor-module/src/store/scadaPackageStore.ts`
**Sayfa:** `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx`

- **Widget tipleri:** 16 (Gauge, NumericDisplay, StatusIndicator, TankLevel, ToggleSwitch, Slider, NumericInput, PushButton, TrendChart, EmergencyStop, AlarmBanner, AlarmList, CalibrationWizard, CalibrationStatus, CalibrationHistory, ProcessView)
- **Widget config'ler:** Her widget icin ayri konfigrasyon bileeni (`widget-configs/*.tsx`)
- **Bilesenler:** WidgetPalette, ScreenCanvas, PropertiesPanel, DeployScadaDialog, ScreenTabBar, TagBrowser
- **Backend:** Tam (entity, service, resolver, DTO) -- `apps/sensor-service/src/process/` altinda ScadaPackage entity'si

**Mevcut sorunlar:**
- `ScadaPackageBuilderPage.tsx` bileenleri tam kullanmiyor (son commit'te buyuk olcude duzeltildi)
- CSS Grid tabanli layout, ReactFlow ile entegre degil
- Process Editor'den bagimsiz calisiyor

### 2.3 Edge Runtime

**Konum:** `sens-api-gateway/src/scada_*.rs` + `sens-api-gateway/static/scada-edge.html`

- **Rust backend:** `scada_server.rs` (HTTP endpoint), `scada_db.rs` (SQLite), `scada_types.rs` (veri yapilari)
- **HTML runtime:** `scada-edge.html` -- widget render, MQTT canlil veri, alarm gosterimi
- **PLC altyapisi:** `plc_programming/` -- CodeSys, S7Comm, OPC-UA, EtherNet/IP, ADS protokolleri
- **Deploy:** `deploy_orchestrator.rs` -- PLC, Process, SCADA deploy siralama
- **SoftPLC:** Rust tabanli soft PLC engine (`scripting/`, `st_validator.rs`)

### 2.4 Mimari Sema (Mevcut)

```
+------------------+     +------------------+     +------------------+
|  Process Editor  |     |  SCADA Builder   |     |  PLC IDE         |
|  (ReactFlow)     |     |  (CSS Grid)      |     |  (Monaco)        |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
    iframe PostMsg          REST/GraphQL              REST/GraphQL
         |                        |                        |
+--------+---------+     +--------+---------+     +--------+---------+
|  sensor-service  |     |  sensor-service  |     |  sensor-service  |
|  ProcessEntity   |     |  ScadaPackage    |     |  PlcProgram      |
+--------+---------+     +--------+---------+     +--------+---------+
         |                        |                        |
         +------------+-----------+------------------------+
                      |
              MQTT / NATS / Redis
                      |
         +------------+-----------+
         |  Edge Gateway (Rust)   |
         |  - scada_server        |
         |  - plc_programming     |
         |  - deploy_orchestrator |
         +------------------------+
```

---

## 3. Hedef Mimari

### 3.1 Temel Karar: Genisletme vs Yeniden Yazma

| Kriter | Yeniden Yazma | Genisletme (Secilen) |
|--------|---------------|---------------------|
| Risk | Yuksek -- 35+ node yeniden implement | Dusuk -- mevcut calisan kod korunur |
| Sure | ~16 hafta | ~8 hafta |
| Geriye uyumluluk | Kirilir | Korunur |
| Takim bilgisi | Sifirdan ogrenme | Mevcut deneyim gecerli |
| Kanit | Yok | Process Editor uretimde calisiyor |

**Karar:** Process Editor genisletilir. SCADA widget'lari ReactFlow node'lari olarak eklenir. CSS Grid tabanli SCADA Builder devre disi birakilir.

### 3.2 Celiski Cozumleri

Agent raporlarinda bazi noktalar celistir. Asagida alinan kararlar ve gerekceler:

| Konu | Celiski | Karar | Gerekce |
|------|---------|-------|---------|
| Widget render | Agent 2: "overlay z-index", Agent 5: "store birlesimi" | **Overlay z-index + ayri store** | Widget'lar processStore'a eklenmemeli; ayri scadaPackageStore screen/widget yonetimini suruyor, sadece ReactFlow canvas'ta gorsel overlay |
| Multi-screen | Agent 4: "Instance-per-Screen", Agent 2: "Visibility-Based" | **Hybrid Instance + Visibility** | Overview/detail screen'ler icin instance, ayni tip screen'ler icin visibility toggle |
| PLC entegrasyonu | Agent 7: "Rust SoftPLC birincil", Agent 6: "CodeSys oncelikli" | **Rust SoftPLC birincil + CodeSys opsiyonel** | Lisans bagimliligi yok, mevcut Rust altyapisi guclu, MatIEC entegrasyonu yeterli |
| Tag format | Agent 3: "hierarchical FQN zorunlu", Agent 2: "flat tag korunsun" | **FQN opsiyonel, flat varsayilan** | Geriye uyumluluk; FQN Phase 2'de zorunlu yapilir |
| Deploy paketi | Agent 6: "unified paket", Agent 7: "3 ayri paket" | **Unified paket, ayri fazlar** | Tek manifest ama deploy sirasi PLC -> Process -> SCADA korunur |

### 3.3 Hedef Mimari Sema

```
+====================================================================+
|                    UNIFIED EDITOR (React)                          |
|                                                                    |
|  +----------+ +------------------------------------------+ +-----+|
|  |          | |                                          | |     ||
|  | Left     | |  Center Canvas                          | |Right||
|  | Panel    | |  +------------------------------------+ | |Panel||
|  | (mode    | |  | iframe: ReactFlow                  | | |(mode||
|  | -bazli)  | |  |  - P&ID nodes (z:0-100)           | | |bazli||
|  |          | |  |  - SCADA widgets (z:500+)          | | |props||
|  | P&ID:    | |  |  - Edge connections (z:-1)         | | |)    ||
|  |  Equip   | |  |  - Selection overlay (z:2000)      | | |     ||
|  |  Palette | |  +------------------------------------+ | |     ||
|  |          | |                                          | |     ||
|  | HMI:     | +------------------------------------------+ |     ||
|  |  Widget  | +------------------------------------------+ |     ||
|  |  Palette | | Bottom Panel: ST Editor (Monaco)         | |     ||
|  |          | +------------------------------------------+ |     ||
|  | PLC:     | +------------------------------------------+ |     ||
|  |  Func    | | Screen Tab Bar                           | |     ||
|  |  Blocks  | +------------------------------------------+ |     ||
|  +----------+                                        +-----+     |
|  +---------------------------------------------------------------+|
|  | Toolbar: [Mode Tabs] [Proje Adi] [Device] [Save] [Deploy]    ||
|  +---------------------------------------------------------------+|
|  +---------------------------------------------------------------+|
|  | Status Bar: [Baglanti] [Tag Sayisi] [Durum] [Zoom]           ||
|  +---------------------------------------------------------------+|
+====================================================================+
         |                    |                    |
    iframe PostMsg      GraphQL/WS            MQTT pub/sub
         |                    |                    |
+--------+--------------------+--------------------+---------+
|                    sensor-service                          |
|  - ProcessEntity (P&ID)                                    |
|  - ScadaPackage (HMI + screens + widgets)                  |
|  - PlcProgram (ST code + config)                           |
|  - UnifiedTag (tag registry + FQN)                         |
|  - ScadaDeployLog (deploy tracking)                        |
+--------+---------------------------------------------------+
         |
    NATS / MQTT / Redis
         |
+--------+---------------------------------------------------+
|              Edge Gateway (Rust)                           |
|  - scada_server (HTTP + WS runtime)                        |
|  - plc_programming (CodeSys/S7/OPC-UA/ADS)                |
|  - deploy_orchestrator (PLC->Process->SCADA)               |
|  - SoftPLC engine (Rust + MatIEC)                          |
|  - SQLite (paket versiyonlama + rollback)                  |
+------------------------------------------------------------+
```

---

## 4. Detayli Tasarim

### 4.1 Component Hierarchy & Mode Sistemi

#### 4.1.1 Mode Tanimlari

Editor 5 modda calisir. Her mod, sol panel, sag panel, toolbar ve canvas davranisini degistirir.

| Mode | Kisayol | Sol Panel | Sag Panel | Canvas | Alt Panel | Toolbar Ek |
|------|---------|-----------|-----------|--------|-----------|------------|
| **P&ID** | Ctrl+1 | EquipmentPanel | Equipment Properties | Node ekleme/duzenleme aktif | Gizli | Ekipman arama |
| **HMI** | Ctrl+2 | WidgetPalette | Widget Properties + Alarm + Trend | Widget ekleme/duzenleme aktif, P&ID read-only | Gizli | Tag browser, screen yonetimi |
| **PLC** | Ctrl+3 | Function Block Library | PLC Config + Variables | P&ID read-only, tag vurgulama | ST Editor (Monaco) | Compile, validate |
| **Runtime** | Ctrl+4 | Tag Listesi (canli deger) | Alarm Listesi | Canli degerler overlay | Trend Chart | Baglanti durumu |
| **Debug** | Ctrl+5 | Watch List | Variable Inspector | Breakpoint gosterimi | Console/Log | Step, force, reset |

#### 4.1.2 Component Hierarchy

```
UnifiedEditorPage
  +-- EditorToolbar
  |     +-- ModeTabBar (P&ID | HMI | PLC | Runtime | Debug)
  |     +-- ProjectTitle (editable)
  |     +-- DeviceSelector (dropdown)
  |     +-- ActionButtons (Save, Deploy, Undo, Redo)
  |     +-- ContextToolbar (mode-spesifik)
  +-- EditorLayout (resizable panels)
  |     +-- LeftPanel
  |     |     +-- PidEquipmentPanel (mode=P&ID)
  |     |     +-- ScadaWidgetPalette (mode=HMI)
  |     |     +-- PlcFunctionLibrary (mode=PLC)
  |     |     +-- RuntimeTagList (mode=Runtime)
  |     |     +-- DebugWatchList (mode=Debug)
  |     +-- CenterArea
  |     |     +-- ScreenTabBar
  |     |     +-- CanvasIframe (ReactFlow)
  |     |     +-- BottomPanel (collapsible)
  |     |           +-- StEditor (mode=PLC, Monaco)
  |     |           +-- TrendPanel (mode=Runtime)
  |     |           +-- ConsolePanel (mode=Debug)
  |     +-- RightPanel
  |           +-- PidPropertiesPanel (mode=P&ID)
  |           +-- ScadaPropertiesPanel (mode=HMI)
  |           |     +-- WidgetConfigTab
  |           |     +-- AlarmConfigTab
  |           |     +-- TrendConfigTab
  |           |     +-- SecurityTab
  |           +-- PlcConfigPanel (mode=PLC)
  |           +-- RuntimeAlarmPanel (mode=Runtime)
  |           +-- DebugInspector (mode=Debug)
  +-- StatusBar
        +-- ConnectionStatus
        +-- TagCount
        +-- ZoomLevel
        +-- BuildStatus
```

#### 4.1.3 Mode Gecis Mantigi

```typescript
// store/editorModeStore.ts
interface EditorModeState {
  mode: 'pid' | 'hmi' | 'plc' | 'runtime' | 'debug';
  setMode: (mode: EditorModeState['mode']) => void;
  previousMode: EditorModeState['mode'] | null;

  // Mode gecis kurallari
  canSwitchTo: (target: EditorModeState['mode']) => boolean;

  // Canvas kilitleme
  isCanvasEditable: boolean; // P&ID: mode=pid, HMI: mode=hmi
}

// Gecis kurallari:
// - P&ID -> HMI: Her zaman izin
// - HMI -> PLC: Tag binding'ler tamamlanmis olmali (uyari goster)
// - * -> Runtime: Kaydedilmemis degisiklik varsa kaydet/kaydetme sor
// - * -> Debug: Runtime modundan gecis, veya deploy edilmis paket olmali
// - Runtime/Debug -> P&ID/HMI/PLC: Canli baglanti kesilir, uyari
```

### 4.2 ReactFlow Entegrasyonu & Widget Node Pattern

#### 4.2.1 Mevcut ReactFlow Yapisi (Dokunulmaz)

```
components/process-editor/
  nodes/
    index.ts          -- 35+ node tipi export (nodeTypes objesi)
    BaseNode.tsx       -- Tum P&ID node'larinin temeli
    FishTankNode.tsx   -- Ornek: SVG + connection point'ler
    EquipmentNode.tsx  -- Generic ekipman
    SensorWidget.tsx   -- Tag deger gosterimi (mevcut overlay)
    ...
  edges/
    index.ts           -- edgeTypes objesi
    DraggableEdge.tsx
    OrthogonalEdge.tsx
    MultiHandleEdge.tsx
  panels/
    EquipmentPanel.tsx
    PropertiesPanel.tsx
    ...
```

Bu yapi **aynen korunur**. SCADA widget'lari ek node tipi olarak eklenir.

#### 4.2.2 ScadaWidgetNode (Yeni Node Tipi)

Tek bir generic node tipi ile tum SCADA widget'lari sarmalanir:

```typescript
// components/process-editor/nodes/ScadaWidgetNode.tsx

import { NodeProps, NodeResizer } from '@reactflow/core';

interface ScadaWidgetNodeData {
  widgetType: string;        // 'gauge' | 'numericDisplay' | ...
  config: Record<string, any>;
  screenId: string;
  liveValue?: number | string | boolean;
  zIndex: number;            // 500+ (P&ID node'lari 0-100)
}

export const ScadaWidgetNode: React.FC<NodeProps<ScadaWidgetNodeData>> = ({ data, selected }) => {
  return (
    <div style={{ zIndex: data.zIndex }}>
      <NodeResizer
        isVisible={selected}
        minWidth={data.minWidth || 80}
        minHeight={data.minHeight || 60}
        handleStyle={{ /* grid snap handle */ }}
      />
      <WidgetRenderer
        type={data.widgetType}
        config={data.config}
        value={data.liveValue}
        isEditing={true}
      />
    </div>
  );
};

// nodeTypes'a ekleme:
const nodeTypes = {
  ...existingNodeTypes,           // 35+ P&ID node
  scadaWidget: ScadaWidgetNode,   // Tek generic SCADA node
};
```

#### 4.2.3 WidgetRenderer (Dynamic Dispatch)

```typescript
// components/scada-builder/WidgetRenderer.tsx

const WIDGET_RENDERERS: Record<string, React.LazyExoticComponent<any>> = {
  gauge: React.lazy(() => import('./widgets/GaugeWidget')),
  numericDisplay: React.lazy(() => import('./widgets/NumericDisplayWidget')),
  statusIndicator: React.lazy(() => import('./widgets/StatusIndicatorWidget')),
  tankLevel: React.lazy(() => import('./widgets/TankLevelWidget')),
  toggleSwitch: React.lazy(() => import('./widgets/ToggleSwitchWidget')),
  slider: React.lazy(() => import('./widgets/SliderWidget')),
  numericInput: React.lazy(() => import('./widgets/NumericInputWidget')),
  pushButton: React.lazy(() => import('./widgets/PushButtonWidget')),
  trendChart: React.lazy(() => import('./widgets/TrendChartWidget')),
  emergencyStop: React.lazy(() => import('./widgets/EmergencyStopWidget')),
  alarmBanner: React.lazy(() => import('./widgets/AlarmBannerWidget')),
  alarmList: React.lazy(() => import('./widgets/AlarmListWidget')),
  // Calibration widget'lari...
};

export const WidgetRenderer: React.FC<{
  type: string;
  config: Record<string, any>;
  value?: any;
  isEditing: boolean;
}> = ({ type, config, value, isEditing }) => {
  const Component = WIDGET_RENDERERS[type];
  if (!Component) return <div>Unknown: {type}</div>;
  return (
    <Suspense fallback={<Skeleton />}>
      <Component config={config} value={value} isEditing={isEditing} />
    </Suspense>
  );
};
```

#### 4.2.4 Z-Index Katmanlama

| Katman | Z-Index Araligi | Icerik |
|--------|-----------------|--------|
| Edges (borular) | -1 | ReactFlow edge'ler |
| P&ID Equipment | 0 -- 100 | FishTank, DrumFilter, Pump, vb. |
| Sensor Overlays | 100 -- 499 | SensorWidget (mevcut tag gosterimi) |
| SCADA Widgets | 500 -- 999 | Gauge, NumericDisplay, TrendChart, vb. |
| Selection Overlay | 2000 | Secili node vurgulama |
| Context Menu | 3000 | Sag tik menusu |

#### 4.2.5 PostMessage Protokol Genisleme

Mevcut PostMessage API'sine yeni mesaj tipleri eklenir:

```typescript
// Yeni mesaj tipleri (iframe <-> parent)
interface ScadaPostMessages {
  // Parent -> iframe
  setEditorMode: { mode: 'pid' | 'hmi' | 'plc' | 'runtime' | 'debug' };
  addOverlayNode: { node: ScadaWidgetNodeData & { position: XYPosition } };
  removeOverlayNode: { nodeId: string };
  updateOverlayNode: { nodeId: string; data: Partial<ScadaWidgetNodeData> };
  updateLiveValues: { values: Record<string, any> }; // tagName -> value
  setScreen: { screenId: string };
  setNodeVisibility: { nodeIds: string[]; visible: boolean };
  saveViewport: { screenId: string };
  restoreViewport: { screenId: string };
  lockPidNodes: { locked: boolean }; // HMI modunda P&ID duzenlenemez

  // iframe -> Parent
  onOverlayNodeSelect: { nodeId: string; nodeData: ScadaWidgetNodeData };
  onOverlayNodeMove: { nodeId: string; position: XYPosition };
  onOverlayNodeResize: { nodeId: string; width: number; height: number };
  onOverlayNodeDrop: { widgetType: string; position: XYPosition };
  onViewportChange: { viewport: Viewport };
}
```

#### 4.2.6 CSS Grid -> ReactFlow Koordinat Donusumu

Mevcut SCADA Builder CSS Grid tabanlidir. Widget pozisyonlarini ReactFlow koordinatlarina donusturmek icin:

```typescript
const CELL_WIDTH = 120;   // px
const CELL_HEIGHT = 100;  // px

function gridToReactFlow(gridCol: number, gridRow: number): XYPosition {
  return {
    x: gridCol * CELL_WIDTH,
    y: gridRow * CELL_HEIGHT,
  };
}

function reactFlowToGrid(x: number, y: number): { col: number; row: number } {
  return {
    col: Math.round(x / CELL_WIDTH),
    row: Math.round(y / CELL_HEIGHT),
  };
}
```

#### 4.2.7 Widget Palette Drag & Drop

```typescript
// WidgetPalette'den ReactFlow canvas'a surukleme
const onDragStart = (event: DragEvent, widgetType: string) => {
  event.dataTransfer.setData('application/reactflow-widget', JSON.stringify({
    type: 'scadaWidget',
    widgetType,
    config: getDefaultConfig(widgetType),
  }));
  event.dataTransfer.effectAllowed = 'move';
};

// Canvas'ta birakma (iframe icinde)
const onDrop = (event: DragEvent) => {
  const data = JSON.parse(event.dataTransfer.getData('application/reactflow-widget'));
  const position = reactFlowInstance.screenToFlowPosition({
    x: event.clientX,
    y: event.clientY,
  });

  const newNode = {
    id: `scada-${nanoid()}`,
    type: 'scadaWidget',
    position,
    data: {
      ...data,
      zIndex: 500 + getNextWidgetIndex(),
      screenId: activeScreenId,
    },
  };

  addNode(newNode);
  // Parent'a bildir
  window.parent.postMessage({ type: 'onOverlayNodeDrop', ...newNode }, '*');
};
```

#### 4.2.8 Performans Optimizasyonlari

| Teknik | Aciklama | Uygulama |
|--------|----------|----------|
| `onlyRenderVisibleElements` | ReactFlow viewport disindaki node'lari render etme | ReactFlow prop |
| Batch value update | Canli deger guncellemelerini 100ms batch'le | `requestAnimationFrame` + debounce |
| `React.memo` | Widget renderer'lari memo'la | Her WidgetRenderer `memo` ile sarilir |
| Lazy widget loading | Widget tiplerini lazy import et | `React.lazy` + `Suspense` (yukarida) |
| Virtualized lists | Sol panel listelerini virtualize et | `react-window` veya `@tanstack/virtual` |
| Canvas layer separation | P&ID ve SCADA katmanlarini ayri ReactFlow layer'da tut | Performans icin P&ID degismeyince re-render yok |

### 4.3 Multi-Screen Mimarisi

#### 4.3.1 Yaklasim Karsilastirmasi

| Yaklasim | Avantaj | Dezavantaj | Secim |
|----------|---------|------------|-------|
| **Viewport-per-Screen** | Basit | Tum node'lar bellekte | Hayir |
| **Instance-per-Screen** | Temiz izolasyon, tip bazli renderer | Bellek kullanimi | Evet (birincil) |
| **Sub-flow** | ReactFlow native | Complexity, nested state | Hayir |
| **Visibility Toggle** | Hizli gecis | Buyuk projelerde yavas | Evet (ikincil) |

**Karar:** Hybrid Instance-per-Screen. Her screen'in kendi ReactFlow node/edge state'i var. Screen gecisi: mevcut state kaydet -> hedef state yukle. Ayni screen tipindeki hizli gecisler icin visibility toggle kullanilir.

#### 4.3.2 Screen Entity Modeli

```typescript
interface ScadaScreen {
  id: string;
  name: string;
  type: 'overview' | 'area' | 'detail' | 'alarm' | 'trend' | 'custom';
  order: number;
  parentScreenId: string | null;    // Hiyerarsi

  // ReactFlow state
  nodes: ReactFlowNode[];           // P&ID + SCADA widget node'lari
  edges: ReactFlowEdge[];
  viewport: Viewport;               // { x, y, zoom }

  // Layout
  backgroundColor: string;
  gridVisible: boolean;
  gridSize: number;

  // Navigasyon
  links: ScreenLink[];              // Diger screen'lere link
  breadcrumbPath: string[];         // Hiyerarsik yol

  // Runtime
  refreshInterval: number;          // ms
  autoNavigateRules: AutoNavRule[];  // Alarm/tag bazli otomatik gecis
}

interface ScreenLink {
  id: string;
  targetScreenId: string;
  triggerType: 'click' | 'doubleClick' | 'alarm' | 'tagValue';
  triggerConfig: Record<string, any>;
  label: string;
  position: XYPosition;  // Canvas uzerindeki konum (opsiyonel)
}

interface AutoNavRule {
  condition: 'alarm' | 'tagValue' | 'schedule';
  expression: string;       // "tag('pH') < 6.5" veya "alarm.active('critical')"
  targetScreenId: string;
  priority: number;
}
```

#### 4.3.3 Screen Hiyerarsisi

```
Overview Screen (Tesis Genel Gorunumu)
  +-- Area Screen: Balik Tanklari
  |     +-- Detail Screen: Tank A1
  |     +-- Detail Screen: Tank A2
  +-- Area Screen: Filtrasyon
  |     +-- Detail Screen: Drum Filter 1
  +-- Area Screen: UV Dezenfeksiyon
  +-- Alarm Screen (ozel tip)
  +-- Trend Screen (ozel tip)
```

**Navigasyon:**
- Breadcrumb: `Overview > Balik Tanklari > Tank A1`
- Drill-down: Equipment node'a cift tik -> ilgili detail screen'e git
- Alarm tetiklemeli: Kritik alarm -> otomatik ilgili screen'e gecis

#### 4.3.4 Screen Template Sistemi

Hizli baslangic icin yerlesik sablonlar:

| Template | Aciklama | Icerdigi Widget'lar |
|----------|----------|---------------------|
| Overview | Tesis genel gorunumu | ProcessView + KPI gauge'lar |
| Tank Detail | Tek tank detayi | Gauge, NumericDisplay, TrendChart, AlarmBanner |
| Filter Station | Filtrasyon istasyonu | StatusIndicator, NumericDisplay, ToggleSwitch |
| Alarm Dashboard | Alarm ozeti | AlarmList, AlarmBanner, TrendChart |
| Trend Analysis | Trend karsilastirma | TrendChart (coklul), DateRangePicker |
| Control Panel | Kontrol paneli | PushButton, Slider, NumericInput, EmergencyStop |
| Calibration | Kalibrasyon ekrani | CalibrationWizard, CalibrationStatus, CalibrationHistory |
| Blank | Bos canvas | (yok) |

#### 4.3.5 Edge Runtime Multi-Screen

Edge cihazinda multi-screen:

```
+-------------------------------------------------------+
| [Tab: Overview] [Tab: Tanklar] [Tab: Alarmlar]       |
+-------------------------------------------------------+
|                                                       |
|  Screen Container (tek seferde 1 screen render)       |
|                                                       |
|  +-----------------------------------------------+   |
|  |  Aktif Screen'in Widget'lari                   |   |
|  |  (MQTT canli veri baglamasi)                   |   |
|  +-----------------------------------------------+   |
|                                                       |
+-------------------------------------------------------+
| Status Bar: [Online] [Son Guncelleme: 14:32:05]      |
+-------------------------------------------------------+
```

- Screen gecisi: mevcut screen DOM'dan cikarilir, hedef screen render edilir
- Pre-rendered SVG: P&ID arka plani icin statik SVG (performans)
- Auto-navigate: alarm tetiklemeli screen gecisi edge'de de calisir

### 4.4 Unified Tag Namespace

#### 4.4.1 Tag Mimarisi

OPC-UA ilhamli hiyerarsik Fully Qualified Name (FQN) sistemi:

```
FQN Formati: {siteCode}/{zoneCode}/{equipmentCode}/{tagName}

Ornekler:
  AQ01/TANK/T-001/pH            -- Tank T-001'in pH sensoru
  AQ01/FILT/DF-001/speed        -- Drum Filter 1 motor hizi
  AQ01/UV/UV-001/intensity      -- UV Unite 1 yogunluk
  AQ01/TANK/T-001/level         -- Tank T-001 su seviyesi
  AQ01/SYS/alarm_count          -- Sistem geneli alarm sayisi
```

**Geriye uyumluluk:** Flat tag isimleri (`pH`, `speed`) korunur. FQN opsiyoneldir ve Phase 2'de zorunlu hale gelir.

#### 4.4.2 UnifiedTag Data Model

```typescript
interface UnifiedTag {
  // Kimlik
  id: string;                      // UUID
  fqn: string;                     // "AQ01/TANK/T-001/pH"
  flatName: string;                // "pH" (geriye uyumlu)
  displayName: string;             // "Tank A1 - pH"
  description: string;

  // Tip bilgisi
  dataType: 'float' | 'int' | 'bool' | 'string' | 'enum';
  engUnit: string;                 // "mg/L", "C", "%", "RPM"
  precision: number;               // Ondalik basamak

  // Muhendislik limitleri
  engLow: number;
  engHigh: number;
  rawLow: number;
  rawHigh: number;
  deadband: number;

  // Alarm limitleri
  alarmHiHi: number | null;
  alarmHi: number | null;
  alarmLo: number | null;
  alarmLoLo: number | null;
  alarmDelay: number;              // ms

  // Kaynak bilgisi
  sourceType: 'mqtt' | 'opcua' | 'modbus' | 'computed' | 'manual';
  sourcePath: string;              // MQTT topic veya OPC-UA nodeId

  // Hiyerarsi
  siteCode: string;
  zoneCode: string;
  equipmentCode: string;

  // OPC-UA uyumluluk
  opcuaNodeId: string | null;      // "ns=2;s=AQ01.TANK.T001.pH"
  opcuaAccessLevel: number;        // Read=1, Write=2, ReadWrite=3

  // Metadata
  isActive: boolean;
  lastValue: any;
  lastTimestamp: Date;
  quality: 'good' | 'bad' | 'uncertain';
}
```

#### 4.4.3 Tag Expression Engine

Hesaplanmis (computed) tag'ler icin ifade motoru:

```typescript
interface TagExpression {
  id: string;
  name: string;                    // "average_pH"
  fqn: string;                    // "AQ01/SYS/average_pH"
  expression: string;             // "AVG(AQ01/TANK/*/pH)"
  dependencies: string[];         // Bagimlil tag FQN'leri
  evaluationInterval: number;     // ms
}

// Desteklenen operatorler/fonksiyonlar:
// Aritmetik: +, -, *, /, %, ^
// Karsilastirma: >, <, >=, <=, ==, !=
// Mantiksal: AND, OR, NOT
// Agregasyon: AVG(), SUM(), MIN(), MAX(), COUNT()
// Zaman: RATE(), DELTA(), INTEGRAL(), DELAY(tag, ms)
// Durum: IF(condition, true_val, false_val)
// Wildcard: AQ01/TANK/*/pH -> tum tank pH'lari
```

#### 4.4.4 Tag Resolution Chain (4 Katman)

```
1. Editor (Tasarim Zamani)
   - Tag browser: cihaz tag listesi goruntuleme + secim
   - Widget binding: widget.config.tag = "AQ01/TANK/T-001/pH"
   - Validation: tag var mi, tipi uyumlu mu

2. Backend (Tag Registry)
   - UnifiedTag entity: tum tag'lerin merkezi kaydi
   - FQN -> sourceType + sourcePath cozumleme
   - Tag expression evaluation (computed tags)
   - Tag discovery: yeni cihaz baglantisinda otomatik tag kaydi

3. Edge Runtime
   - Tag -> MQTT topic eslestirme
   - Local tag cache (Redis)
   - Computed tag evaluation (basit ifadeler)
   - Tag value scaling (raw -> eng)

4. Fiziksel I/O
   - MQTT broker'dan ham deger okuma
   - Modbus/OPC-UA protokol cevirimi
   - Hardware abstraction
```

#### 4.4.5 Tag Discovery & Auto-Binding

```typescript
// Tag discovery akisi:
// 1. Edge cihaz baglanir
// 2. I/O konfigurasyonu okunur (ioConfig[])
// 3. Her I/O noktasi icin UnifiedTag olusturulur (yoksa)
// 4. Equipment tipi taninirsa, smart matching yapilir

interface TagDiscoveryResult {
  newTags: UnifiedTag[];           // Yeni kesfedilen tag'ler
  matchedBindings: TagBinding[];   // Otomatik eslestirmeler
  unmatchedTags: string[];         // Eslesmeyen tag'ler (manuel gerekli)
}

// Smart Tag Matching (Equipment tip bazli)
// Ornek: "FishTank" equipment tipi icin beklenen tag'ler:
const EQUIPMENT_TAG_TEMPLATES: Record<string, string[]> = {
  FishTank: ['pH', 'temperature', 'dissolvedOxygen', 'level', 'feedRate'],
  DrumFilter: ['speed', 'differentialPressure', 'backwashActive'],
  UVUnit: ['intensity', 'lampHours', 'lampStatus'],
  Pump: ['speed', 'flow', 'pressure', 'running', 'fault'],
  Blower: ['speed', 'airflow', 'temperature', 'running'],
};
```

### 4.5 Real-time Data Flow

#### 4.5.1 End-to-End Veri Akisi

```
Fiziksel Sensor
    |
    | (Modbus/4-20mA/Digital)
    v
Edge Gateway (Rust)
    |
    | 1. Ham deger okuma (polling veya interrupt)
    | 2. Scaling: raw -> eng (rawLow/rawHigh -> engLow/engHigh)
    | 3. Deadband kontrolu (deger degismediyse yayinlama)
    | 4. Local cache (Redis)
    |
    | MQTT publish: sensors/{deviceId}/{tagName}
    v
MQTT Broker (Mosquitto)
    |
    | subscribe: sensors/#
    v
sensor-service (NestJS)
    |
    | 1. MQTT mesaji al
    | 2. Tag registry'den meta bilgi cek
    | 3. Alarm evaluation (HiHi/Hi/Lo/LoLo)
    | 4. TimescaleDB'ye yaz (ham + aggregate)
    | 5. Redis last-value cache guncelle
    | 6. NATS'e yayinla: sensor.{tenantId}.{tagFqn}
    v
NATS (JetStream)
    |
    | subscribe: sensor.{tenantId}.>
    v
API Gateway (NestJS)
    |
    | 1. NATS subscription dinle
    | 2. Client subscription eslestir
    | 3. Socket.IO emit: 'scada:liveValues'
    v
Socket.IO (WebSocket)
    |
    | subscribe: scada:liveValues
    v
Browser (React)
    |
    | 1. ScadaDataProvider (context)
    | 2. useScadaLiveData hook
    | 3. Widget re-render (debounced)
    v
Widget (Gauge, NumericDisplay, ...)
```

#### 4.5.2 Latency Hedefleri

| Senaryo | Hedef | Olcum Noktasi |
|---------|-------|---------------|
| Edit-time (tag binding test) | < 2 saniye | Sensor -> Widget gosterim |
| Runtime (canli izleme) | < 100 ms | Sensor -> Widget gosterim |
| Alarm tetikleme | < 500 ms | Limit asimi -> alarm gosterim |
| Trend guncelleme | < 1 saniye | Yeni nokta -> grafik guncelleme |
| Reconnection recovery | < 5 saniye | Baglanti kopma -> yeniden baglanti |

#### 4.5.3 Frontend Real-time Bilesenleri

```typescript
// context/ScadaDataProvider.tsx
interface ScadaDataContextValue {
  values: Map<string, TagValue>;           // tagFqn -> son deger
  subscribe: (tags: string[]) => void;
  unsubscribe: (tags: string[]) => void;
  connectionStatus: 'connected' | 'reconnecting' | 'disconnected';
}

// hooks/useScadaLiveData.ts
function useScadaLiveData(tagFqns: string[]): {
  values: Record<string, TagValue>;
  isConnected: boolean;
  lastUpdate: Date;
} {
  const { values, subscribe, unsubscribe } = useContext(ScadaDataContext);

  useEffect(() => {
    subscribe(tagFqns);
    return () => unsubscribe(tagFqns);
  }, [tagFqns]);

  // Viewport-aware: sadece gorunen widget'larin tag'lerini subscribe et
  // IntersectionObserver ile widget gorunurlugu izle

  return useMemo(() => ({
    values: Object.fromEntries(
      tagFqns.map(fqn => [fqn, values.get(fqn)])
    ),
    isConnected: connectionStatus === 'connected',
    lastUpdate: new Date(),
  }), [tagFqns, values]);
}
```

#### 4.5.4 Subscription Yonetimi

```typescript
// Viewport-aware subscription
// Sadece gorunen widget'larin tag'lerini subscribe et

interface SubscriptionManager {
  // Widget gorunurluk izleme
  registerWidget: (widgetId: string, tagFqns: string[]) => void;
  unregisterWidget: (widgetId: string) => void;
  setWidgetVisible: (widgetId: string, visible: boolean) => void;

  // Aktif subscription'lar
  getActiveSubscriptions: () => string[];

  // Performans
  batchInterval: number;  // 100ms -- subscription degisikliklerini batch'le
}

// Socket.IO event'leri:
// Client -> Server: 'scada:subscribe' { tags: string[] }
// Client -> Server: 'scada:unsubscribe' { tags: string[] }
// Server -> Client: 'scada:liveValues' { [tagFqn]: { value, timestamp, quality } }
// Server -> Client: 'scada:alarm' { tagFqn, level, message, timestamp }
```

#### 4.5.5 Historical Data Query

```typescript
// GraphQL resolver: ScadaTrendResolver
type Query {
  scadaTrendData(
    tags: [String!]!
    from: DateTime!
    to: DateTime!
    resolution: TrendResolution!  # RAW, 1m, 5m, 15m, 1h, 1d
    aggregation: AggregationType  # AVG, MIN, MAX, SUM, LAST
  ): [TrendSeries!]!
}

type TrendSeries {
  tagFqn: String!
  points: [TrendPoint!]!
}

type TrendPoint {
  timestamp: DateTime!
  value: Float
  min: Float
  max: Float
  quality: String!
}

// TimescaleDB continuous aggregates kullanimi:
// - 1m aggregate: son 24 saat
// - 5m aggregate: son 7 gun
// - 1h aggregate: son 30 gun
// - 1d aggregate: son 1 yil
// Resolution otomatik secim: zaman araligina gore en uygun aggregate
```

#### 4.5.6 Reconnection Stratejisi

| Katman | Strateji | Detay |
|--------|----------|-------|
| MQTT (Edge -> Broker) | Circuit breaker | 3 basarisiz deneme -> 30s bekleme -> tekrar |
| NATS (Service -> Service) | Pending subscriptions | Baglanti gelince pending sub'lar otomatik aktif |
| Socket.IO (Browser -> Server) | Auto-reconnect | Exponential backoff (1s, 2s, 4s, 8s, max 30s) |
| Redis (Cache) | Fallback | Cache miss -> DB query + cache doldur |

Reconnection sonrasi: initial snapshot (tum aktif tag'lerin son degeri) gonderilir.

### 4.6 CodeSys/SoftPLC Entegrasyonu

#### 4.6.1 Mevcut PLC Altyapisi

```
sens-api-gateway/src/
  plc_programming/
    mod.rs              -- PLC programming module
    codesys.rs          -- CodeSys CmpApp protokolu
    s7comm.rs           -- Siemens S7 Communication
    opcua.rs            -- OPC-UA client/server
    ethernet_ip.rs      -- Allen-Bradley EtherNet/IP
    ads.rs              -- Beckhoff ADS/TwinCAT
    common.rs           -- Ortak tipler
  scripting/            -- Rust SoftPLC engine
  st_validator.rs       -- Structured Text syntax validator
  deploy_orchestrator.rs -- Deploy siralama
```

Bu altyapi **cok guclu** -- 5 PLC protokolu + Rust SoftPLC + ST validator zaten mevcut.

#### 4.6.2 PLC Entegrasyon Stratejisi: Hibrit Model

```
                    +-------------------+
                    |  Unified Editor   |
                    |  PLC Mode (Ctrl+3)|
                    |  Monaco ST Editor |
                    +--------+----------+
                             |
                    ST Code + Config
                             |
              +--------------+--------------+
              |              |              |
     +--------+-----+ +-----+------+ +-----+------+
     | Yol A:       | | Yol B:     | | Yol C:     |
     | Rust SoftPLC | | CodeSys    | | OpenPLC    |
     | (Birincil)   | | (Lisansli) | | (Opsiyonel)|
     +--------+-----+ +-----+------+ +-----+------+
              |              |              |
              | Rust native  | CmpApp API   | Modbus
              | execution    | (codesys.rs) | (modbus.rs)
              |              |              |
     +--------+--------------+--------------+--------+
     |              Edge Gateway (Rust)               |
     |         ProcessImage (shared memory)           |
     +-----------------------+------------------------+
                             |
                        I/O Binding
                             |
                   Fiziksel Sensor/Actuator
```

**Birincil yol:** Rust SoftPLC (lisans bagimliligi yok)
- Mevcut `scripting/` module'u + `st_validator.rs`
- MatIEC compiler entegrasyonu (ST -> IL -> native)
- Lightweight, her edge cihazda calisir

**Ikincil yol:** CodeSys (musteri lisansiyla)
- Mevcut `codesys.rs` CmpApp protokolu
- Enterprise musterieler icin

**Ucuncul yol:** OpenPLC (egitim/test amacli)
- Modbus TCP uzerinden baglanti
- Dusuk maliyetli kurulumlar icin

#### 4.6.3 ST Editor (Monaco Entegrasyonu)

```typescript
// PLC modunda alt panelde Monaco editor
interface StEditorConfig {
  language: 'structuredText';       // Custom language definition
  theme: 'st-dark' | 'st-light';

  // IntelliSense
  completionProvider: {
    tagAutocomplete: boolean;       // Tag FQN otomatik tamamlama
    functionBlocks: boolean;        // IEC 61131-3 func block'lar
    keywords: boolean;              // IF, THEN, WHILE, FOR, ...
    snippets: boolean;              // Common pattern snippet'lar
  };

  // Validation
  liveValidation: boolean;          // Yazarken st_validator.rs'e gonder
  validationDebounce: number;       // 500ms

  // Debug
  breakpoints: boolean;             // Satir bazli breakpoint
  variableWatch: boolean;           // Degisken izleme
  forceValues: boolean;             // Degisken deger zorlama (debug mode)
}

// Monaco custom language: Structured Text
// Keywords: PROGRAM, END_PROGRAM, VAR, END_VAR, IF, THEN, ELSE, END_IF,
//           WHILE, DO, END_WHILE, FOR, TO, BY, END_FOR, CASE, OF, END_CASE,
//           FUNCTION, FUNCTION_BLOCK, RETURN, EXIT, REPEAT, UNTIL
// Types: BOOL, INT, DINT, REAL, LREAL, STRING, TIME, DATE, TOD, DT
// Operators: AND, OR, NOT, XOR, MOD, TRUE, FALSE
```

#### 4.6.4 PLC <-> Tag Binding

```typescript
// PlcTagBinding: PLC degiskeni <-> Unified Tag eslestirmesi
interface PlcTagBinding {
  id: string;
  plcVariableName: string;         // "tank_pH"
  tagFqn: string;                  // "AQ01/TANK/T-001/pH"
  direction: 'input' | 'output';   // PLC'ye giren mi cikan mi
  dataType: string;                // "REAL"
  scalingEnabled: boolean;
  scalingFactor: number;
  scalingOffset: number;
}

// ProcessImage: PLC <-> I/O arasindaki shared memory
// Edge gateway'de her scan cycle'da guncellenir:
// 1. Input scan: fiziksel I/O -> ProcessImage input buffer
// 2. PLC execution: ProcessImage input -> ST program -> ProcessImage output
// 3. Output scan: ProcessImage output -> fiziksel I/O + MQTT publish
```

#### 4.6.5 Online Debug (Yol A+ -- SoftPLC)

| Ozellik | Aciklama | Implementasyon |
|---------|----------|----------------|
| Variable Watch | Canli degisken izleme | ProcessImage'dan okuma, 100ms polling |
| Force Values | Degisken deger zorlama | ProcessImage'a yazma, force flag |
| Breakpoints | Satir bazli durdurma | Interpreter hook, MQTT notify |
| Step Execution | Adim adim calistirma | Scan cycle kontrolu |
| Trend Recording | Degisken trend kaydi | Ring buffer, last N scan cycle |

### 4.7 Edge Deploy Pipeline

#### 4.7.1 Unified Deploy Paketi

```typescript
interface UnifiedDeployPackage {
  // Manifest
  manifest: {
    id: string;
    version: string;
    name: string;
    createdAt: string;
    createdBy: string;

    // Bilesen checksums (incremental deploy icin)
    components: {
      plc?: { checksum: string; version: string };
      process?: { checksum: string; version: string };
      scada?: { checksum: string; version: string };
    };

    // Bagimlilikar
    dependencies: {
      minEdgeVersion: string;
      requiredProtocols: string[];  // ['mqtt', 'modbus', ...]
    };
  };

  // PLC bilesen
  plc?: {
    stCode: string;                 // Structured Text kaynak kodu
    compiledIL: Uint8Array | null;  // MatIEC compiled (varsa)
    config: PlcConfig;
    tagBindings: PlcTagBinding[];
  };

  // Process bilesen
  process?: {
    nodes: ProcessNode[];
    edges: ProcessEdge[];
    equipmentConfig: Record<string, any>;
  };

  // SCADA bilesen
  scada?: {
    screens: ScadaScreen[];
    alarmRules: AlarmRule[];
    controlPermissions: ControlPermissions;
    trendConfig: TrendConfig;
    globalSettings: Record<string, any>;
  };
}
```

#### 4.7.2 Deploy Sirasi

```
1. PLC Deploy (Kontrol her zaman HMI'dan once)
   +-- ST code compile (MatIEC veya interpreter)
   +-- Tag binding verify
   +-- ProcessImage setup
   +-- PLC program load + start
   +-- Health check (scan cycle calisiyor mu?)

2. Process Deploy
   +-- P&ID node/edge data push
   +-- Equipment config update
   +-- SVG render (edge'de process arka plan icin)

3. SCADA Deploy
   +-- Screen data push
   +-- Widget config push
   +-- Alarm rule activation
   +-- Runtime baslat
   +-- Health check (widget render + MQTT subscribe)
```

#### 4.7.3 Incremental Deploy

```typescript
// Deploy akisi:
// 1. Client manifest'i edge'e gonder
// 2. Edge mevcut manifest ile karsilastir
// 3. Sadece degisen bilesenleri iste

async function deployToEdge(deviceId: string, package: UnifiedDeployPackage) {
  // 1. Manifest check
  const edgeManifest = await getEdgeManifest(deviceId);

  // 2. Delta hesapla
  const delta: DeployDelta = {
    plc: package.manifest.components.plc?.checksum !== edgeManifest?.components.plc?.checksum,
    process: package.manifest.components.process?.checksum !== edgeManifest?.components.process?.checksum,
    scada: package.manifest.components.scada?.checksum !== edgeManifest?.components.scada?.checksum,
  };

  // 3. Sadece degisenleri gonder
  if (delta.plc) await deployPlc(deviceId, package.plc);
  if (delta.process) await deployProcess(deviceId, package.process);
  if (delta.scada) await deployScada(deviceId, package.scada);

  // 4. Manifest guncelle
  await updateEdgeManifest(deviceId, package.manifest);
}

// Buyuk paketler icin chunked transfer (>1MB):
// 512KB chunks, her chunk icin checksum verify
```

#### 4.7.4 Rollback Mekanizmasi

```
Edge SQLite'da versiyon gecmisi tutulur:

scada_packages tablo:
  id, version, package_data, manifest, deployed_at, is_active

Rollback tetikleyicileri:
  1. Manuel: operator "rollback" komutu
  2. Health check fail: deploy sonrasi 30s icinde health check basarisiz
  3. Alarm: deploy sonrasi kritik alarm sayisi artisi

Rollback akisi:
  1. Mevcut aktif paketi deaktive et
  2. Onceki versiyonu aktive et
  3. PLC/Process/SCADA ters sirada reload
  4. Health check
  5. Backend'e bildir (MQTT: deploy/{deviceId}/rollback)
```

#### 4.7.5 Auto-Provisioning

```typescript
// Yeni edge cihaz aktive edildiginde otomatik deploy
interface DeployProfile {
  id: string;
  name: string;
  siteId: string;

  // Hangi paket deploy edilecek
  packageId: string;
  packageVersion: string;         // 'latest' veya spesifik versiyon

  // Auto-deploy kurallari
  autoDeployOnActivation: boolean;
  autoUpdateOnNewVersion: boolean;
  deploySchedule: string | null;  // Cron expression (opsiyonel)

  // Hedef cihaz filtresi
  deviceFilter: {
    tags: string[];               // Cihaz tag'leri
    siteCode: string;
    zoneCode: string;
  };
}

// Akis:
// 1. Cihaz aktive olur (MQTT: device/{deviceId}/status = 'online')
// 2. DeployProfile eslesmesi kontrol edilir
// 3. Eslesen profil varsa: DeployQueue'ya eklenir
// 4. DeployQueue worker: siradaki deploy'u isler
// 5. Deploy + health check + bildirim
```

#### 4.7.6 Health Monitoring

```typescript
// ScadaDeployLog entity (backend)
interface ScadaDeployLog {
  id: string;
  packageId: string;
  deviceId: string;
  version: string;
  status: 'pending' | 'transferring' | 'installing' | 'running' | 'failed' | 'rolledBack';
  progress: number;               // 0-100
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;

  // Bilesen durumlari
  plcStatus: ComponentDeployStatus;
  processStatus: ComponentDeployStatus;
  scadaStatus: ComponentDeployStatus;
}

// Edge progress publish (MQTT):
// deploy/{deviceId}/progress: { status, progress, component, message }
// deploy/{deviceId}/health: { plcRunning, scadaRunning, mqttConnected, uptime }

// Timeout/recovery matrisi:
// | Islem          | Timeout | Recovery               |
// |----------------|---------|------------------------|
// | Transfer       | 120s    | Retry (max 3)          |
// | PLC compile    | 60s     | Abort + rollback       |
// | PLC start      | 30s     | Retry (max 2)          |
// | SCADA activate | 30s     | Retry (max 2)          |
// | Health check   | 30s     | Rollback               |
```

#### 4.7.7 Kritik Eksiklik: Backend Deploy Handler

**Tespit:** `deploy_scada_package` MQTT response handler backend'de (sensor-service) **MEVCUT DEGIL**. Edge cihazi deploy sonucunu MQTT ile yayinliyor ama backend dinlemiyor.

**Cozum:**

```typescript
// apps/sensor-service/src/process/scada-deploy.listener.ts (YENi)
@Injectable()
export class ScadaDeployListener {
  @MqttSubscribe('deploy/+/progress')
  async handleDeployProgress(topic: string, payload: DeployProgress) {
    const deviceId = topic.split('/')[1];
    // ScadaDeployLog guncelle
    // WebSocket uzerinden client'a bildir
  }

  @MqttSubscribe('deploy/+/health')
  async handleHealthReport(topic: string, payload: HealthReport) {
    const deviceId = topic.split('/')[1];
    // Cihaz sagligi kaydet
    // Alarm tetikle (gerekirse)
  }
}
```

### 4.8 UX & Interaction Design

#### 4.8.1 Kullanici Journey

```
1. CREATE (Yeni Proje)
   - "Yeni Proje" -> ad ver, site/zone sec
   - Bos editor acilir, P&ID modunda

2. DESIGN (P&ID Tasarimi) -- Ctrl+1
   - Sol panelden ekipman surukle (FishTank, Pump, Filter, ...)
   - Boru baglantilari ciz (edge'ler)
   - Sensor ekle (SensorWidget overlay)
   - Equipment ozellikleri sag panelde duzenle

3. CONFIGURE (HMI Konfigurasyonu) -- Ctrl+2
   - Mode gecisi: P&ID arka plan read-only olur
   - Sol panelden SCADA widget surukle (Gauge, Display, ...)
   - Widget'i ilgili ekipmanin uzerine konumla
   - Sag panelde: tag binding, renk, limit, birim ayarla
   - Screen ekle/dzenle (ScreenTabBar)
   - Alarm kurallari tanimla

4. PROGRAM (PLC Kodlama) -- Ctrl+3
   - Alt panelde Monaco ST editor acilir
   - Tag autocomplete ile PLC degiskeni tanimla
   - Kontrol mantigi yaz (IF pH < 6.5 THEN ...)
   - Compile + validate (canli hata gosterimi)
   - Tag binding: PLC degisken <-> Unified Tag

5. DEPLOY (Tek Tusla)
   - "All-in-One Deploy" dialog acilir
   - Hedef cihaz sec (veya auto-detect)
   - Bilesen secimi: [x] PLC [x] Process [x] SCADA
   - Deploy basla -> progress bar
   - PLC -> Process -> SCADA siraliyla

6. MONITOR (Canli Izleme) -- Ctrl+4
   - Widget'lar canli deger gosterir
   - Alarm banner aktif alarmlari gosterir
   - Trend chart gecmis + canli veri
   - Screen navigasyonu aktif

7. DEBUG (Hata Ayiklama) -- Ctrl+5
   - PLC degisken izleme (watch list)
   - Deger zorlama (force)
   - Breakpoint + step execution
   - Alarm gecmisi + event log
```

#### 4.8.2 Toolbar Tasarimi

```
+===================================================================+
| [P&ID] [HMI] [PLC] [Runtime] [Debug] | Proje Adi | [Device v] |  |
|-------------------------------------------------------------------+
| [Save] [Undo] [Redo] | [Deploy] | Mode-spesifik aracllar...      |
+===================================================================+

Mode-spesifik toolbar icerikleri:
  P&ID:    [Snap Grid] [Align] [Distribute] [Zoom Fit]
  HMI:     [Screen+] [Widget Search] [Tag Browser] [Preview]
  PLC:     [Compile] [Validate] [Upload] [Download]
  Runtime: [Connect] [Disconnect] [Snapshot] [Record]
  Debug:   [Step] [Continue] [Stop] [Force] [Reset]
```

#### 4.8.3 Keyboard Shortcuts

| Kisayol | Islem | Kapsam |
|---------|-------|--------|
| Ctrl+1..5 | Mode gecisi | Global |
| Ctrl+S | Kaydet | Global |
| Ctrl+Z / Ctrl+Y | Undo / Redo | Global |
| Ctrl+Shift+D | Deploy dialog | Global |
| Delete / Backspace | Secili sil | Canvas |
| Ctrl+A | Tumu sec | Canvas |
| Ctrl+C / Ctrl+V | Kopyala / Yapistir | Canvas |
| Ctrl+D | Duplicate | Canvas |
| Ctrl+G | Grupla | Canvas |
| Ctrl+F | Ara (tag/node/widget) | Global |
| Space + drag | Pan | Canvas |
| Ctrl+Mouse wheel | Zoom | Canvas |
| Escape | Secim iptal / dialog kapat | Global |
| Tab | Sonraki widget (HMI modunda) | HMI |
| Ctrl+Enter | Compile (PLC modunda) | PLC |
| F5 | Run/Continue (Debug) | Debug |
| F9 | Breakpoint toggle | PLC/Debug |
| F10 | Step over | Debug |
| F11 | Step into | Debug |

#### 4.8.4 Context Menu

```
Canvas sag tik:
  - Yapistir
  - Tumu Sec
  - Zoom: [%50] [%100] [%150] [Sdir]
  - Grid: [Goster/Gizle] [Snap Ac/Kapa]
  - Ekipman Ekle -> (P&ID modunda)
  - Widget Ekle -> (HMI modunda)

Node sag tik (P&ID):
  - Ozellikler
  - Sensor Ekle
  - Baglantilar
  - Kopyala / Kes / Sil
  - Arka Plana / On Plana
  - Detay Screen'e Git (varsa)

Widget sag tik (HMI):
  - Ozellikler
  - Tag Degistir
  - Boyutlandir: [Kucuk] [Orta] [Buyuk] [Ozel]
  - Kopyala / Kes / Sil
  - Z-siralama: Uste / Alta / Bir Yukari / Bir Asagi
  - Widget Tipi Degistir

Tag sag tik:
  - Tag Detaylari
  - Trend Goster
  - Alarm Gecmisi
  - Tag Kopyala (FQN)
  - Deger Zorla (Debug modunda)
```

#### 4.8.5 All-in-One Deploy Dialog

```
+--------------------------------------------------+
|  Deploy -- [Proje Adi]                     [X]   |
+--------------------------------------------------+
|                                                  |
|  Hedef Cihaz:                                    |
|  +--------------------------------------------+ |
|  | [v] aqua-edge-01 (Online)             [>] | |
|  +--------------------------------------------+ |
|                                                  |
|  Bilesenler:                                     |
|  +--------------------------------------------+ |
|  | [x] PLC Program    v1.3 -> v1.4  (degisti) | |
|  | [x] Process (P&ID) v2.1        (ayni)      | |
|  | [x] SCADA Paket    v1.0 -> v1.1  (degisti) | |
|  +--------------------------------------------+ |
|                                                  |
|  Deploy Stratejisi:                              |
|  ( ) Tam deploy (tum bilesenler)                 |
|  (o) Incremental (sadece degisen)                |
|                                                  |
|  [ ] Rollback aktif (hata durumunda geri al)     |
|  [ ] Health check sonrasi onayla                 |
|                                                  |
|  [Iptal]                          [Deploy Basla] |
+--------------------------------------------------+

Deploy ilerleme:
+--------------------------------------------------+
|  Deploy Ilerleme                                 |
+--------------------------------------------------+
|                                                  |
|  1. PLC Compile     [################] %100 OK   |
|  2. PLC Upload      [################] %100 OK   |
|  3. Process Push    [########--------]  %50      |
|  4. SCADA Push      [----------------]   %0      |
|  5. Health Check    [                ]   --      |
|                                                  |
|  Genel Ilerleme:    [########--------]  %42      |
|                                                  |
|  Log:                                            |
|  14:32:01 PLC compile basarili (1.2s)            |
|  14:32:03 PLC upload tamamlandi                  |
|  14:32:04 Process push baslatildi...             |
|                                                  |
|  [Iptal]                                         |
+--------------------------------------------------+
```

#### 4.8.6 Mobile/Tablet Desteigi

| Breakpoint | Genislik | Davranis |
|------------|----------|----------|
| Desktop | > 1280px | Tam editor, tum paneller |
| Tablet Landscape | 1024-1280px | Sol veya sag panel gizlenebilir |
| Tablet Portrait | 768-1024px | Sadece canvas + alt panel, paneller overlay |
| Mobile | < 768px | Sadece runtime/monitor modu, editor yok |

**On-Site Mode (Tablet):**
- Buyuk dokunmatik butonlar
- Swipe ile screen gecisi
- Pinch-to-zoom
- Long-press context menu
- Landscape-only zorlama

---

## 5. Data Model

### 5.1 Yeni/Guncellenen Entity'ler

#### UnifiedTag Entity (YENi)

```typescript
// apps/sensor-service/src/process/entities/unified-tag.entity.ts

@Entity({ schema: 'sensor' })
export class UnifiedTag {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  fqn: string;                     // "AQ01/TANK/T-001/pH"

  @Column()
  flatName: string;                // "pH"

  @Column()
  displayName: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'enum', enum: ['float', 'int', 'bool', 'string', 'enum'] })
  dataType: string;

  @Column({ nullable: true })
  engUnit: string;

  @Column({ type: 'float', nullable: true })
  engLow: number;

  @Column({ type: 'float', nullable: true })
  engHigh: number;

  @Column({ type: 'float', nullable: true })
  alarmHiHi: number;

  @Column({ type: 'float', nullable: true })
  alarmHi: number;

  @Column({ type: 'float', nullable: true })
  alarmLo: number;

  @Column({ type: 'float', nullable: true })
  alarmLoLo: number;

  @Column({ type: 'enum', enum: ['mqtt', 'opcua', 'modbus', 'computed', 'manual'] })
  sourceType: string;

  @Column({ nullable: true })
  sourcePath: string;

  @Column()
  siteCode: string;

  @Column()
  zoneCode: string;

  @Column()
  equipmentCode: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @ManyToOne(() => EdgeDevice, { nullable: true })
  edgeDevice: EdgeDevice;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

#### ScadaDeployLog Entity (YENi)

```typescript
// apps/sensor-service/src/process/entities/scada-deploy-log.entity.ts

@Entity({ schema: 'sensor' })
export class ScadaDeployLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  packageId: string;

  @Column()
  deviceId: string;

  @Column()
  version: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'transferring', 'installing', 'running', 'failed', 'rolledBack'],
    default: 'pending'
  })
  status: string;

  @Column({ type: 'int', default: 0 })
  progress: number;

  @Column({ type: 'jsonb', nullable: true })
  componentStatus: {
    plc: { status: string; message: string };
    process: { status: string; message: string };
    scada: { status: string; message: string };
  };

  @Column({ nullable: true })
  errorMessage: string;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;
}
```

#### DeployProfile Entity (YENi)

```typescript
// apps/sensor-service/src/process/entities/deploy-profile.entity.ts

@Entity({ schema: 'sensor' })
export class DeployProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  siteId: string;

  @Column()
  packageId: string;

  @Column({ default: 'latest' })
  packageVersion: string;

  @Column({ default: false })
  autoDeployOnActivation: boolean;

  @Column({ default: false })
  autoUpdateOnNewVersion: boolean;

  @Column({ nullable: true })
  deploySchedule: string;           // Cron

  @Column({ type: 'jsonb', nullable: true })
  deviceFilter: Record<string, any>;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

### 5.2 Mevcut Entity Guncellemeleri

#### ScadaPackage Entity (Guncelleme)

```typescript
// Mevcut entity'ye eklenmesi gereken field'lar:

@Column({ nullable: true })
processId: string;                  // Bagli P&ID process ID

@Column({ nullable: true })
plcProgramId: string;               // Bagli PLC program ID

@Column({ type: 'jsonb', nullable: true })
deployManifest: {
  version: string;
  components: {
    plc?: { checksum: string; version: string };
    process?: { checksum: string; version: string };
    scada?: { checksum: string; version: string };
  };
};

@Column({ nullable: true })
lastDeployedAt: Date;

@Column({ nullable: true })
lastDeployedDeviceId: string;
```

### 5.3 JSONB Yapilari

#### packageData (ScadaPackage)

```json
{
  "meta": {
    "version": 2,
    "packageName": "Balik Tanki SCADA",
    "processId": "uuid-process",
    "plcProgramId": "uuid-plc",
    "edgeDeviceId": "uuid-device",
    "createdAt": "2026-03-06T12:00:00Z"
  },
  "screens": [
    {
      "id": "screen-1",
      "name": "Genel Bakis",
      "type": "overview",
      "order": 0,
      "parentScreenId": null,
      "viewport": { "x": 0, "y": 0, "zoom": 1 },
      "backgroundColor": "#1a1a2e",
      "gridVisible": true,
      "gridSize": 20,
      "widgets": [
        {
          "id": "widget-1",
          "widgetType": "gauge",
          "position": { "col": 2, "row": 1 },
          "size": { "width": 2, "height": 2 },
          "config": {
            "tag": "AQ01/TANK/T-001/pH",
            "label": "pH",
            "min": 0,
            "max": 14,
            "unit": "pH",
            "thresholds": [
              { "value": 6.5, "color": "#ef4444" },
              { "value": 7.0, "color": "#f59e0b" },
              { "value": 8.5, "color": "#10b981" }
            ]
          }
        }
      ],
      "links": [
        {
          "id": "link-1",
          "targetScreenId": "screen-2",
          "triggerType": "click",
          "label": "Tank Detay"
        }
      ]
    }
  ],
  "alarmRules": [
    {
      "id": "alarm-1",
      "name": "Dusuk pH",
      "tag": "AQ01/TANK/T-001/pH",
      "condition": "lessThan",
      "threshold": 6.5,
      "severity": "critical",
      "message": "Tank T-001 pH degeri kritik seviyede dusuk!",
      "delay": 5000,
      "autoAcknowledge": false
    }
  ],
  "controlPermissions": {
    "securityLevels": {
      "operator": ["read", "acknowledge"],
      "engineer": ["read", "write", "acknowledge", "force"],
      "admin": ["read", "write", "acknowledge", "force", "config"]
    },
    "emergencyStop": {
      "holdDuration": 3000,
      "affectedTags": ["AQ01/TANK/*/feedRate", "AQ01/PUMP/*/speed"],
      "resetRequiresPin": true
    }
  },
  "trendConfig": {
    "defaultTimeRange": "1h",
    "refreshInterval": 5000,
    "maxPointsPerSeries": 1000,
    "defaultResolution": "auto"
  }
}
```

### 5.4 Yeni GraphQL API'ler

```graphql
# Tag Yonetimi
type Query {
  unifiedTags(filter: TagFilter, pagination: PaginationInput): TagConnection!
  unifiedTag(id: ID!): UnifiedTag
  tagsByEquipment(equipmentId: ID!): [UnifiedTag!]!
  tagsByDevice(deviceId: ID!): [UnifiedTag!]!
  tagSearch(query: String!, limit: Int): [UnifiedTag!]!
}

type Mutation {
  createUnifiedTag(input: CreateTagInput!): UnifiedTag!
  updateUnifiedTag(id: ID!, input: UpdateTagInput!): UnifiedTag!
  deleteUnifiedTag(id: ID!): Boolean!
  discoverTags(deviceId: ID!): TagDiscoveryResult!
  autoBindTags(processId: ID!, deviceId: ID!): [TagBinding!]!
}

# Deploy Yonetimi
type Query {
  deployLogs(deviceId: ID, packageId: ID, pagination: PaginationInput): DeployLogConnection!
  deployLog(id: ID!): ScadaDeployLog
  deployProfiles(siteId: ID): [DeployProfile!]!
}

type Mutation {
  deployUnifiedPackage(input: DeployInput!): ScadaDeployLog!
  rollbackDeploy(deviceId: ID!, targetVersion: String): ScadaDeployLog!
  createDeployProfile(input: DeployProfileInput!): DeployProfile!
  updateDeployProfile(id: ID!, input: DeployProfileInput!): DeployProfile!
}

type Subscription {
  deployProgress(deviceId: ID!): DeployProgress!
  liveTagValues(tagFqns: [String!]!): LiveTagUpdate!
  alarmEvents(tenantId: ID!): AlarmEvent!
}

# PLC Yonetimi
type Mutation {
  compileST(code: String!, target: PlcTarget!): CompileResult!
  validateST(code: String!): ValidationResult!
}

type CompileResult {
  success: Boolean!
  errors: [CompileError!]!
  warnings: [CompileWarning!]!
  compiledSize: Int
}
```

---

## 6. Migration Stratejisi

### 6.1 Faz Ozeti

| Faz | Icerik | Sure | Risk |
|-----|--------|------|------|
| **Phase 1** | Frontend Unification -- SCADA widget'lari ReactFlow'a tasima | 3 hafta | Orta |
| **Phase 2** | Tag Namespace + Real-time | 2 hafta | Dusuk |
| **Phase 3** | PLC Entegrasyonu + Deploy Pipeline | 2 hafta | Yuksek |
| **Phase 4** | Legacy Temizlik + Polish | 1 hafta | Dusuk |

### 6.2 Phase 1: Frontend Unification (Hafta 1-3)

**Hedef:** SCADA widget'lari ReactFlow node'lari olarak Process Editor icinde calisir.

**Adimlar:**

1. **Hafta 1.1:** ScadaWidgetNode + WidgetRenderer olustur
   - `ScadaWidgetNode.tsx` (generic wrapper)
   - `WidgetRenderer.tsx` (dynamic dispatch)
   - nodeTypes'a `scadaWidget` ekle
   - PostMessage genisleme (addOverlayNode, updateOverlayNode, ...)

2. **Hafta 1.2:** Mode sistemi
   - `editorModeStore.ts` olustur
   - `ModeTabBar` bilesen
   - Sol/sag panel mode-bazli render
   - Canvas kilitleme (HMI modunda P&ID read-only)

3. **Hafta 2.1:** Widget palette -> ReactFlow drag & drop
   - WidgetPalette'den ReactFlow onDrop'a baglanti
   - Grid snap + NodeResizer entegrasyonu
   - Z-index katmanlama

4. **Hafta 2.2:** Properties panel entegrasyonu
   - Mevcut SCADA PropertiesPanel'i mode-bazli sag panele tas
   - Widget config -> ReactFlow node data sync
   - TagBrowser entegrasyonu (mevcut bilesen)

5. **Hafta 3:** ScreenTabBar + multi-screen
   - Screen gecis mantigi (save/restore viewport + node visibility)
   - Mevcut ScreenTabBar'i entegre et
   - Screen template sistemi (basit versiyon)

**Geriye uyumluluk:**
- Mevcut CSS Grid SCADA Builder rotalari KORUNUR (deprecated flag ile)
- Mevcut ScadaPackage verisi donusturulur (grid pozisyon -> ReactFlow koordinat)
- processStore ve scadaPackageStore ayri kalir

### 6.3 Phase 2: Tag Namespace + Real-time (Hafta 4-5)

**Hedef:** Unified Tag Registry ve canli veri akisi.

**Adimlar:**

1. **Hafta 4.1:** UnifiedTag entity + CRUD
   - Entity olustur
   - Service + Resolver
   - Tag discovery (DeviceIoConfig'den otomatik)

2. **Hafta 4.2:** Tag Browser genisleme
   - FQN destegi
   - Hiyerarsik gorunum (site/zone/equipment tree)
   - Smart tag matching

3. **Hafta 5.1:** Real-time data pipeline
   - ScadaDataProvider context
   - useScadaLiveData hook
   - Socket.IO subscription yonetimi
   - Viewport-aware subscribe/unsubscribe

4. **Hafta 5.2:** Historical data
   - ScadaTrendResolver
   - TimescaleDB continuous aggregate sorgusu
   - TrendChart canli + gecmis veri entegrasyonu

### 6.4 Phase 3: PLC + Deploy (Hafta 6-7)

**Hedef:** PLC modu ve unified deploy pipeline.

**Adimlar:**

1. **Hafta 6.1:** PLC Mode UI
   - Monaco ST editor alt panele entegrasyon
   - ST language definition (syntax highlighting, keywords)
   - IntelliSense: tag autocomplete

2. **Hafta 6.2:** PLC backend entegrasyon
   - compileST / validateST mutation'lari
   - PlcTagBinding entity
   - ProcessImage sync

3. **Hafta 7.1:** Unified deploy
   - Deploy paket builder (PLC + Process + SCADA manifest)
   - All-in-One Deploy dialog
   - Incremental deploy logic

4. **Hafta 7.2:** Deploy monitoring
   - ScadaDeployLog entity + CRUD
   - MQTT deploy progress listener (backend)
   - Deploy progress UI (WebSocket)
   - Rollback mekanizmasi

### 6.5 Phase 4: Legacy Temizlik + Polish (Hafta 8)

**Hedef:** Eski yollari temizle, performans optimize et, edge case'leri duzelt.

**Adimlar:**

1. Eski SCADA Builder rotalarina redirect ekle
2. CSS Grid -> ReactFlow veri migration script'i
3. Performans optimizasyonu (lazy loading, memo, batch update)
4. E2E test
5. Dokumantasyon guncelleme

### 6.6 Geriye Uyumluluk Garantileri

| Bilesen | Garanti |
|---------|---------|
| Mevcut P&ID projeleri | %100 -- processStore dokunulmuyor |
| Mevcut SCADA paketleri | %100 -- packageData formatil korunuyor, yeni field'lar opsiyonel |
| Mevcut edge deploy | %100 -- mevcut deploy_scada_package calismaya devam eder |
| Tag isimleri | %100 -- flat tag korunur, FQN opsiyonel |
| REST/GraphQL API'ler | %100 -- yeni endpoint'ler eklenir, mevcutlar dokunulmaz |
| Edge runtime HTML | %100 -- scada-edge.html mevcut widget render korunur |

---

## 7. Uygulama Yol Haritasi

### 7.1 Sprint Plani

```
Hafta 1 (Sprint 1)
  +---------------------------------------------------------------------------+
  | ScadaWidgetNode + WidgetRenderer + PostMessage genisleme                  |
  | editorModeStore + ModeTabBar                                              |
  | Canvas kilitleme (mode-bazli)                                             |
  +---------------------------------------------------------------------------+

Hafta 2 (Sprint 2)
  +---------------------------------------------------------------------------+
  | Widget Palette -> ReactFlow drag & drop                                   |
  | Grid snap + NodeResizer                                                   |
  | Properties panel mode-bazli entegrasyon                                   |
  +---------------------------------------------------------------------------+

Hafta 3 (Sprint 3)
  +---------------------------------------------------------------------------+
  | ScreenTabBar + multi-screen (visibility toggle)                           |
  | Screen template sistemi (basit)                                           |
  | Phase 1 entegrasyon testi + bug fix                                       |
  +---------------------------------------------------------------------------+

Hafta 4 (Sprint 4)
  +---------------------------------------------------------------------------+
  | UnifiedTag entity + service + resolver                                    |
  | Tag discovery + browser genisleme (FQN)                                   |
  +---------------------------------------------------------------------------+

Hafta 5 (Sprint 5)
  +---------------------------------------------------------------------------+
  | ScadaDataProvider + useScadaLiveData                                      |
  | Socket.IO subscription yonetimi                                           |
  | ScadaTrendResolver + TrendChart entegrasyonu                              |
  +---------------------------------------------------------------------------+

Hafta 6 (Sprint 6)
  +---------------------------------------------------------------------------+
  | PLC Mode: Monaco ST editor                                                |
  | compileST / validateST backend                                            |
  | PlcTagBinding + ProcessImage                                              |
  +---------------------------------------------------------------------------+

Hafta 7 (Sprint 7)
  +---------------------------------------------------------------------------+
  | Unified deploy paket builder                                              |
  | All-in-One Deploy dialog                                                  |
  | ScadaDeployLog + MQTT listener + rollback                                 |
  +---------------------------------------------------------------------------+

Hafta 8 (Sprint 8)
  +---------------------------------------------------------------------------+
  | Legacy cleanup + redirect                                                 |
  | Performans optimizasyonu                                                  |
  | E2E test + dokumantasyon                                                  |
  +---------------------------------------------------------------------------+
```

### 7.2 Kritik Bagimliliklar

```
Phase 1 (Frontend) --+
                     |
Phase 2 (Tag+RT) ----+--> Phase 3 (PLC+Deploy) --> Phase 4 (Cleanup)
                     |
Phase 1 bagimsiz olarak baslar.
Phase 2, Phase 1'in ScadaWidgetNode'una ihtiyac duyar (canli deger gosterimi icin).
Phase 3, Phase 2'nin tag registry'sine ihtiyac duyar (PLC tag binding icin).
Phase 4 hepsi tamamlandiktan sonra.
```

### 7.3 Paralel Calisma Imkanlari

| Calismla 1 | Calisma 2 | Notlar |
|------------|-----------|--------|
| ScadaWidgetNode (frontend) | UnifiedTag entity (backend) | Bagimsiz, paralel olabilir |
| WidgetPalette D&D | Monaco ST editor | Bagimsiz |
| Screen template | Tag discovery | Bagimsiz |
| Deploy dialog UI | Deploy MQTT listener | Frontend/backend paralel |

---

## 8. Risk Matrisi

| # | Risk | Etki | Olasilik | Azaltma |
|---|------|------|----------|---------|
| R1 | ReactFlow performans degradasyonu (cok fazla overlay node) | Yuksek | Orta | `onlyRenderVisibleElements`, lazy loading, katman ayirimi |
| R2 | PostMessage API uyumsuzluk (iframe) | Orta | Dusuk | Mevcut API dokunulmaz, sadece yeni mesaj tipleri eklenir |
| R3 | Screen gecisinde state kaybi | Yuksek | Orta | Screen state'i ayri objelerde tutulur, gecis oncesi save |
| R4 | Tag FQN migration karmasikligi | Orta | Orta | Flat tag korunur, FQN opsiyonel, migration script |
| R5 | MatIEC compiler entegrasyon zorlugu | Yuksek | Yuksek | Ilk fazda interpreter modu, MatIEC Phase 3+ |
| R6 | Edge deploy rollback kaybii | Yuksek | Dusuk | SQLite versiyon gecmisi, checksum verify |
| R7 | Multi-screen bellek kullanimi | Orta | Orta | Lazy screen load, sadece aktif screen render |
| R8 | Real-time latency hedefi tutmama | Orta | Dusuk | Redis cache, batch update, viewport-aware subscribe |
| R9 | Mevcut SCADA paketleri uyumsuzluk | Yuksek | Dusuk | packageData format %100 geriye uyumlu, yeni field'lar opsiyonel |
| R10 | Takim paralel calisma conflict | Orta | Orta | Modular dosya yapisi, store ayirimi korunur |

---

## 9. Kritik Dosya Referanslari

### 9.1 Degisecek Dosyalar

| Dosya | Degisiklik | Faz |
|-------|-----------|------|
| `web/modules/sensor-module/src/components/process-editor/nodes/index.ts` | `scadaWidget` node tipi ekleme | Phase 1 |
| `web/modules/sensor-module/src/store/processStore.ts` | Mode state, overlay node yonetimi | Phase 1 |
| `web/modules/sensor-module/src/store/scadaPackageStore.ts` | ReactFlow koordinat destegi, mode entegrasyonu | Phase 1 |
| `web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx` | Unified editor'e donusum (veya yeni sayfa) | Phase 1 |
| `web/modules/sensor-module/src/components/scada-builder/PropertiesPanel.tsx` | Mode-bazli panel, tag FQN destegi | Phase 1-2 |
| `web/modules/sensor-module/src/components/scada-builder/WidgetPalette.tsx` | ReactFlow drag data format | Phase 1 |
| `web/modules/sensor-module/src/components/scada-builder/ScreenTabBar.tsx` | Multi-screen yonetimi genisleme | Phase 1 |
| `web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx` | FQN + hiyerarsik gorunum | Phase 2 |
| `web/modules/sensor-module/src/components/scada-builder/DeployScadaDialog.tsx` | All-in-One deploy, PLC + Process destegi | Phase 3 |
| `web/modules/sensor-module/src/hooks/useScadaPackage.ts` | Deploy log, unified paket | Phase 3 |
| `apps/sensor-service/src/process/` | UnifiedTag, ScadaDeployLog, DeployProfile entity'leri | Phase 2-3 |
| `sens-api-gateway/src/scada_server.rs` | Unified paket alimi, versiyon yonetimi | Phase 3 |
| `sens-api-gateway/src/scada_types.rs` | Unified deploy paket tipi | Phase 3 |
| `sens-api-gateway/src/deploy_orchestrator.rs` | PLC->Process->SCADA deploy sirasi | Phase 3 |

### 9.2 Olusturulacak Yeni Dosyalar

| Dosya | Aciklama | Faz |
|-------|----------|------|
| `web/.../process-editor/nodes/ScadaWidgetNode.tsx` | Generic SCADA widget ReactFlow node | Phase 1 |
| `web/.../scada-builder/WidgetRenderer.tsx` | Widget tipi -> bilesen eslestirme (lazy) | Phase 1 |
| `web/.../store/editorModeStore.ts` | 5 modlu editor state yonetimi | Phase 1 |
| `web/.../context/ScadaDataProvider.tsx` | Real-time data context | Phase 2 |
| `web/.../hooks/useScadaLiveData.ts` | Canli tag degeri hook | Phase 2 |
| `web/.../hooks/useScadaTrend.ts` | Trend data query hook | Phase 2 |
| `apps/sensor-service/.../unified-tag.entity.ts` | UnifiedTag TypeORM entity | Phase 2 |
| `apps/sensor-service/.../unified-tag.service.ts` | Tag CRUD + discovery | Phase 2 |
| `apps/sensor-service/.../unified-tag.resolver.ts` | GraphQL resolver | Phase 2 |
| `apps/sensor-service/.../scada-deploy-log.entity.ts` | Deploy log entity | Phase 3 |
| `apps/sensor-service/.../scada-deploy.listener.ts` | MQTT deploy progress listener | Phase 3 |
| `apps/sensor-service/.../deploy-profile.entity.ts` | Auto-deploy profil entity | Phase 3 |
| `web/.../components/plc/StEditor.tsx` | Monaco ST editor bilesen | Phase 3 |

### 9.3 Dokunulmayacak Dosyalar (Korunan)

| Dosya/Dizin | Neden |
|-------------|-------|
| `process-editor/nodes/*.tsx` (mevcut 35+ node) | P&ID node'lari aynen korunur |
| `process-editor/edges/*.tsx` | Edge tipleri aynen korunur |
| `process-editor/panels/EquipmentPanel.tsx` | P&ID modunda kullanilmaya devam |
| `process-editor/dialogs/*.tsx` | Mevcut dialog'lar korunur |
| `sens-api-gateway/src/plc_programming/*.rs` | PLC protokolleri korunur |
| `sens-api-gateway/static/scada-edge.html` | Edge runtime korunur (ek widget render eklenebilir) |
| `store/processStore.ts` (core) | P&ID state yonetimi korunur (sadece mode hook eklenir) |
| `store/scadaPackageStore.ts` (core) | SCADA state yonetimi korunur |

---

## Ek A: Mevcut SCADA Builder Tamamlama (Kisa Vadeli)

> Not: Bu bolum, Unified Editor'e gecis **oncesinde** mevcut SCADA Builder'in tam calisir hale getirilmesi icin gerekli islemleri tanimlar. Unified Editor calismasi bu islemlerin uzerine insa edilir.

Mevcut SCADA Builder bilesenlerinin entegrasyon durumu (son commit 4b49203 itibariyle):

| Bilesen | Durum |
|---------|-------|
| Save/Load (GraphQL mutation wiring) | Tamamlandi |
| ScreenTabBar entegrasyonu | Tamamlandi |
| PropertiesPanel entegrasyonu | Tamamlandi |
| DeployScadaDialog wiring | Tamamlandi |
| TagBrowser bilesen | Tamamlandi |
| Target Device selector | Tamamlandi |
| Widget config'lere TagBrowser ekleme | Tamamlandi (12 config) |

**Kalan isler:**
1. Deploy MQTT response handler (backend) -- Phase 3'te ele alinacak
2. Edge widget render uyumluluk kontrolu -- devam eden
3. performans testi + edge case'ler

---

*Bu belge 9 uzman agent'in (Architecture Lead, ReactFlow Specialist, Tag Architect, Screen Manager, Widget Specialist, Deploy Pipeline, CodeSys Specialist, Real-time Specialist, UX Designer) raporlarinin konsolidasyonudur.*
