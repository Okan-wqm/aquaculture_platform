---
name: sensor-module
description: Knowledge base for the Sensor Module frontend
---

# Sensor Module Knowledge Base

## Overview

The Sensor Module is a Module Federation remote at `/sensor/*`. It provides industrial-grade sensor/device management: multi-step sensor registration wizard (supporting multiple protocols), VFD (Variable Frequency Drive) registration wizard, SCADA process editor (ReactFlow canvas with equipment icons), live widget dashboard, sensor readings, alert thresholds, and calibration. The SCADA process editor uses an iframe-based canvas architecture.

## Directory Structure

```
web/modules/sensor-module/src/
  main.tsx
  vite-env.d.ts
  config/
    api.ts                        # Sensor API config
    connectionTypes.ts            # Edge connection type definitions
  store/
    processStore.ts               # Zustand store for process editor state
    scadaStore.ts                 # Zustand store for SCADA viewer state
  types/
    scada-types.ts
    registration.types.ts
    vfd.types.ts
  pages/
    SensorDashboardPage.tsx       # /sensor (index)
    SensorScadaPage.tsx           # /sensor/scada — SCADA viewer
    WidgetDashboardPage.tsx       # /sensor/widgets — custom widget dashboard
    SensorAnalyticsPage.tsx       # /sensor/analytics
    ReadingsPage.tsx              # /sensor/readings — raw sensor readings
    AlertsPage.tsx                # /sensor/alerts
    ThresholdsPage.tsx            # /sensor/thresholds
    CalibrationPage.tsx           # /sensor/calibration
    DeviceDetailPage.tsx          # /sensor/devices/:id
    process/
      ProcessTemplatesPage.tsx    # /sensor/processes — process template list
  components/
    equipment-icons/
      EquipmentIcons.tsx          # Master equipment icon registry
      EquipmentIconLoader.tsx     # Dynamic icon loader by type
      equipmentTypes.ts           # Equipment type definitions + connection point types
      types.ts
      components/
        TankIcon.tsx, PumpIcon.tsx, ChillerIcon.tsx, HeaterIcon.tsx
        RootBlowerIcon.tsx, FanIcon.tsx, FeederIcon.tsx
        DrumFilterIcon.tsx, SandFilterIcon.tsx, ElectricGeneratorIcon.tsx
        OxygenGeneratorIcon.tsx, BeltFilterIcon.tsx
        index.ts
    registration/
      SensorRegistrationWizard.tsx    # Multi-step sensor registration wizard
      DynamicFormRenderer.tsx         # JSON-schema-driven form renderer
      ChannelEditorModal.tsx          # Data channel configuration modal
      ChildSensorFormModal.tsx        # Child sensor form
      steps/
        BasicInfoStep.tsx
        ProtocolSelectionStep.tsx
        ProtocolConfigurationStep.tsx
        DataChannelsStep.tsx
        ChildSensorsStep.tsx
        ParentDeviceInfoStep.tsx
        ReviewStep.tsx
    vfd/
      VfdRegistrationWizard.tsx       # VFD-specific registration wizard
      steps/
        VfdBrandSelectionStep.tsx
        VfdProtocolSelectionStep.tsx
        VfdBasicInfoStep.tsx
        VfdProtocolConfigStep.tsx
        VfdConnectionTestStep.tsx
        VfdReviewStep.tsx
        index.ts
      index.ts
    scada/
      ScadaViewer.tsx            # Main SCADA canvas viewer (renders iframe)
      SensorPanel.tsx            # Side panel for selected equipment sensors
      ProcessSelector.tsx        # Dropdown to select active process
      widgets/
        GaugeWidget.tsx          # Circular gauge SCADA widget
        NumericWidget.tsx        # Numeric value SCADA widget
        SparklineWidget.tsx      # Mini sparkline SCADA widget
        StatusWidget.tsx         # On/off status SCADA widget
        WidgetContainer.tsx      # SCADA widget wrapper
        index.ts
      index.ts
    dashboard/
      SensorPicker.tsx           # Sensor selection component
      WidgetRenderer.tsx         # Renders widget by type
      index.ts
      widgets/
        SparklineWidgetContent.tsx
        LineChartWidgetContent.tsx
        AreaChartWidgetContent.tsx
        BarChartWidgetContent.tsx
        RadialGaugeWidgetContent.tsx
        index.ts
    process-editor/
      components/
        ConnectionPointContextMenu.tsx
      dialogs/
        EquipmentLinkDialog.tsx    # Link canvas node to real equipment
        SensorConfigDialog.tsx     # Configure sensor display on node
      edges/
        index.ts
      nodes/
        UVUnitNode.tsx
        FishTankNode.tsx
      panels/
        PropertiesPanel.tsx        # Right-click properties for selected node
        AttachmentsPanel.tsx       # Equipment/sensor attachment management
      utils/
        rotatePoint.ts
  graphql/
    equipment.queries.ts
  hooks/
    useSensorRegistration.ts
    useSensorReadings.ts
    useSensorThresholds.ts
    useConnectionTest.ts
    useDataChannelList.ts
    useVfdRegistration.ts
    useVfdReadings.ts
    useVfdBrands.ts
    useVfdCommands.ts
    useProcess.ts                  # Process CRUD + active processes
    useWidgetData.ts               # Widget data fetching
    useAttachableEquipment.ts
    useLinkableSensors.ts
  services/
    sensorRegistrationApi.ts       # REST API for sensor registration
```

## Pages / Components

### SensorScadaPage (`/sensor` or `/sensor/scada`)
Full-screen SCADA viewer:
- `ProcessSelector` dropdown to choose a saved process
- Live mode toggle (Play/Pause) — controls real-time data refresh
- Stats header: device count, data channel count, online devices
- `ScadaViewer` renders the ReactFlow canvas (or via iframe)
- `SensorPanel` slides in when equipment node is selected (shows linked sensors and readings)
- Status bar shows node/sensor counts and live data status
- Text is in Turkish

### Process Editor (canvas-based)
Uses `processStore` (Zustand) for state. Canvas communicates with host via `postMessage` iframe protocol:
- `syncNodeToCanvas(nodeId, data)` — updates node data in canvas
- `syncEdgeToCanvas(edgeId, data)` — updates edge data in canvas
- `highlightNode(nodeId)` — highlights node in canvas

Equipment nodes: Tank, Pump, Chiller, Heater, RootBlower, Fan, Feeder, DrumFilter, SandFilter, ElectricGenerator, OxygenGenerator, BeltFilter, UVUnit, FishTank, ConnectionPoint

### SensorRegistrationWizard
7-step wizard: BasicInfo → ProtocolSelection → ProtocolConfig → DataChannels → ChildSensors → ParentDeviceInfo → Review. Supports multiple protocols (Modbus, MQTT, HTTP, etc.). `DynamicFormRenderer` renders protocol-specific config forms from JSON schema.

### VfdRegistrationWizard
6-step wizard for VFD (Variable Frequency Drive) registration: BrandSelection → ProtocolSelection → BasicInfo → ProtocolConfig → ConnectionTest → Review. Supports multiple VFD brands.

### WidgetDashboardPage (`/sensor/widgets`)
Customizable widget dashboard. Users can add/remove/arrange widget tiles showing:
- SparklineWidget, LineChartWidget, AreaChartWidget, BarChartWidget, RadialGaugeWidget
- Each widget links to a specific sensor channel

## State Management

### processStore (Zustand)
Central store for the Process Editor:
- `nodes: Node[]`, `edges: Edge[]` — ReactFlow graph state
- `selectedNode`, `selectedEdge` — selection state
- `isDirty` — unsaved changes flag
- `equipmentNodeMap: Record<equipmentId, nodeId>` — bidirectional link tracking
- `sensorNodeMap: Record<sensorId, nodeId>` — sensor-to-node links
- Key actions: `addNode`, `removeNode`, `updateNodeData`, `linkEquipmentToNode`, `unlinkEquipmentFromNode`, `linkSensorToNode`, `addSensorMapping`
- `postMessage` sync to canvas iframe: `syncNodeToCanvas`, `syncEdgeToCanvas`, `highlightNode`
- Selector hooks: `useProcessNodes`, `useProcessEdges`, `useSelectedNode`, `useSelectedEdge`, `useProcessMetadata`, `useIsDirty`

### scadaStore (Zustand)
State for SCADA viewer:
- `selectedProcessId`, `selectedProcess`
- `processes: []` — loaded from API
- `isLiveMode: boolean` — live vs paused
- `isPanelOpen: boolean` — sensor detail panel visibility
- `lastUpdate: string` — timestamp of last data refresh

## GraphQL Operations

```graphql
# equipment.queries.ts
query AttachableEquipment { attachableEquipment { id name code type category status } }

# useProcess.ts
query ActiveProcesses { activeProcesses { id name description status nodes edges } }
query Process($id) { process { id name description status version nodes edges createdAt updatedAt } }
mutation SaveProcess($input) { saveProcess { id version } }
mutation DeleteProcess($id) { deleteProcess { success } }

# useSensorReadings.ts
query SensorReadings($sensorId, $from, $to) { sensorReadings { timestamp value unit } }
query LatestReadings($sensorIds) { latestReadings { sensorId value unit timestamp } }

# useSensorThresholds.ts
query SensorThresholds($sensorId) { sensorThresholds { warnLow warnHigh critLow critHigh } }
mutation UpdateThresholds($sensorId, $input) { updateSensorThresholds { id } }
```

## Routing

```
/sensor              -> SensorDashboardPage
/sensor/scada        -> SensorScadaPage
/sensor/widgets      -> WidgetDashboardPage
/sensor/devices      -> Device list (sensor list)
/sensor/devices/:id  -> DeviceDetailPage
/sensor/readings     -> ReadingsPage
/sensor/alerts       -> AlertsPage
/sensor/thresholds   -> ThresholdsPage
/sensor/calibration  -> CalibrationPage
/sensor/processes    -> ProcessTemplatesPage
/sensor/analytics    -> SensorAnalyticsPage
/sensor/process/new  -> New process (from SensorScadaPage link)
```

## Key Dependencies

- `zustand` — processStore and scadaStore
- `reactflow` — process editor graph (nodes, edges, connection handling)
- `@aquaculture/shared-ui` — graphqlClient, shared components
- Vite + Module Federation
- Tailwind CSS + lucide-react icons

## Known Gotchas

- **SCADA canvas uses iframe + postMessage**: The canvas is rendered inside an iframe. `syncNodeToCanvas` and related methods do `document.querySelector('iframe[title="Process Editor Canvas"]').contentWindow.postMessage(...)`. If the iframe is not mounted, the postMessage is silently dropped.
- ReactFlow node data types are broad (`Node<any>`) — use type guards when accessing node-specific data fields.
- `processStore` `rebuildEquipmentNodeMap()` must be called after loading a saved process to rebuild the `equipmentNodeMap` from node data.
- VFD registration uses a different wizard from sensor registration — separate wizard component and API calls.
- Turkish locale text in SensorScadaPage ("Canlı", "Duraklatıldı", "Cihaz", "Veri Kanalı", "Çevrimiçi", etc.).
- `useProcess.ts` has two hooks: `useActiveProcesses` and `useProcess(id)` — make sure to use the right one.
- Connection types (water, air, electric, data) are defined in `config/connectionTypes.ts` and displayed as colored edges in the process editor.

## Related Backend Services

- **sensor-service** (port 3003 dev) — sensor data, readings, thresholds, calibration
- **farm-service** (port 3002 dev) — equipment data (for equipment linking in process editor)
- **gateway-api** (port 3000) — all GraphQL requests
- **sens-api-gateway** — edge device/sensor registration REST API
