# @aquaculture/node-components Usage Guide

## Installation

This library is part of the aquaculture platform monorepo. It's automatically available via npm workspaces.

## Usage in Vite/React Apps

```typescript
import {
  nodeTypes,
  edgeTypes,
  NodeRegistry,
  getPaletteGroups,
  getPaletteItems
} from '@aquaculture/node-components';

// Use directly in ReactFlow
<ReactFlow
  nodeTypes={nodeTypes}
  edgeTypes={edgeTypes}
  nodes={nodes}
  edges={edges}
/>

// Get palette items for toolbox
const paletteGroups = getPaletteGroups();
```

## Usage in HTML Canvas (UMD Bundle)

For HTML canvases that load React/ReactFlow from CDN, use the UMD bundle:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- React & ReactFlow from CDN -->
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/reactflow@11.11.4/dist/umd/index.js"></script>
  <link href="https://unpkg.com/reactflow@11.11.4/dist/style.css" rel="stylesheet" />

  <!-- Node Components UMD Bundle -->
  <script src="/libs/node-components/dist/aquaculture-nodes.umd.js"></script>
</head>
<body>
  <div id="root"></div>
  <script>
    const { createElement: h, useState } = React;
    const { ReactFlow, ReactFlowProvider, useNodesState, useEdgesState } = window.ReactFlow;

    // Access node components from UMD bundle
    const {
      nodeTypes,
      edgeTypes,
      NodeRegistry,
      getPaletteGroups,
      // Individual nodes
      BlowerNode,
      DrumFilterNode,
      SensorNode,
      PumpNode,
      // Config
      getEdgeStyle,
      CONNECTION_TYPES,
      EQUIPMENT_TYPES,
    } = window.AquacultureNodes;

    function App() {
      const [nodes, setNodes, onNodesChange] = useNodesState([]);
      const [edges, setEdges, onEdgesChange] = useEdgesState([]);

      return h(ReactFlowProvider, null,
        h(ReactFlow, {
          nodes,
          edges,
          onNodesChange,
          onEdgesChange,
          nodeTypes,  // Use pre-registered node types
          edgeTypes,  // Use pre-registered edge types
          fitView: true,
        })
      );
    }

    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
  </script>
</body>
</html>
```

## Available Exports

### Node Types (32 components)
| Node | Category | Description |
|------|----------|-------------|
| `blower` | aeration | Lobe/Root blower for aeration |
| `pump` | pump | Centrifugal water pump |
| `drumFilter` | filtration | Rotary drum filter |
| `uvUnit` | disinfection | UV sterilizer unit |
| `radialSettler` | filtration | Radial flow settler |
| `fishTank` | tank | Fish culture tank |
| `cleanWaterTank` | tank | Clean water storage tank |
| `dirtyWaterTank` | tank | Waste water tank |
| `dualDrainTank` | tank | Dual drain culture tank |
| `heater` | heating_cooling | Water heater |
| `chiller` | heating_cooling | Water chiller |
| `plateHeatExchanger` | heating_cooling | Plate heat exchanger |
| `shellTubeHeatExchanger` | heating_cooling | Shell & tube heat exchanger |
| `mbbr` | filtration | Moving Bed Biofilm Reactor |
| `ultrafiltration` | filtration | Ultrafiltration membrane |
| `hepaFilter` | filtration | HEPA air filter |
| `sensor` | monitoring | Generic sensor (pH, DO, temp, etc.) |
| `ozoneGenerator` | disinfection | Ozone generator |
| `oxygenGenerator` | aeration | LOX/PSA oxygen generator |
| `valve` | distribution | Flow control valve |
| `dosingPump` | pump | Chemical dosing pump |
| `automaticFeeder` | feeding | Automatic fish feeder |
| `demandFeeder` | feeding | Demand-activated feeder |
| `dieselGenerator` | power | Diesel backup generator |
| `gasGenerator` | power | Gas turbine generator |
| `waterSupply` | utility | Water supply source |
| `waterDischarge` | utility | Water discharge outlet |
| `algaeBag` | algae | Algae photobioreactor bag |
| `connectionPoint` | utility | P&ID connection point |
| `tankInlet` | utility | Tank inlet manifold |
| `equipment` | equipment | Generic equipment node |
| `base` | utility | Base node template |

### Edge Types (3 components)
| Edge | Description |
|------|-------------|
| `multiHandle` | Polyline with draggable waypoints |
| `orthogonal` | 90-degree angle routing |
| `draggable` | Bezier curve with control points |

### Utilities
- `NodeRegistry` - Node type registration system
- `getPaletteGroups()` - Get nodes grouped by category
- `getPaletteItems()` - Get flat list of palette items
- `getEdgeStyle(type)` - Get P&ID styling for connection type
- `CONNECTION_TYPES` - P&ID connection type definitions
- `EQUIPMENT_TYPES` - Equipment type configurations

## Node Registry

Nodes are auto-registered when imported. The registry provides:

```typescript
// Get all registered node types for ReactFlow
const nodeTypes = NodeRegistry.getNodeTypes();

// Get palette items for UI
const items = NodeRegistry.getPaletteItems();

// Get grouped by category
const groups = NodeRegistry.getPaletteGroups();

// Register a custom node
NodeRegistry.register({
  id: 'customNode',
  label: 'Custom Node',
  labelTr: 'Ozel Dugum',
  category: 'utility',
  component: CustomNodeComponent,
  defaultSize: { width: 100, height: 80 },
  equipmentTypeCodes: ['custom'],
});
```

## Build Outputs

| Format | File | Usage |
|--------|------|-------|
| ES Module | `dist/index.mjs` | Vite/Webpack apps |
| CommonJS | `dist/index.cjs` | Node.js/Jest |
| UMD | `dist/aquaculture-nodes.umd.js` | HTML canvas with CDN |
| Types | `dist/types/*.d.ts` | TypeScript definitions |
