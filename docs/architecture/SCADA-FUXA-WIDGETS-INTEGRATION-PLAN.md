# SCADA FUXA SVG Widgets Integration Plan

**Date**: 2026-03-26
**Status**: Draft
**Reference**: [SCADA-ENTERPRISE-IMPLEMENTATION-PLAN.md](./SCADA-ENTERPRISE-IMPLEMENTATION-PLAN.md), [SCADA-FUXA-GAP-ANALYSIS.md](./SCADA-FUXA-GAP-ANALYSIS.md)
**Target**: Integrate 1,450+ FUXA SVG Widgets into Suderra SCADA Builder with full interactivity
**License**: FUXA SVG Widgets are MIT-licensed (https://github.com/nicedash/FUXA-SVG-Widgets)

---

## Table of Contents

0. [Executive Summary](#executive-summary)
1. [Architectural Principles](#architectural-principles)
2. [FUXA Widget Anatomy](#fuxa-widget-anatomy)
3. [Phase 10A: Sandboxed Widget Runtime Engine](#phase-10a-sandboxed-widget-runtime-engine)
4. [Phase 10B: Export Variable Parser & Auto-Config Panel](#phase-10b-export-variable-parser--auto-config-panel)
5. [Phase 10C: Widget Catalog & Browser UI](#phase-10c-widget-catalog--browser-ui)
6. [Phase 10D: PostMessage Bridge & Tag Integration](#phase-10d-postmessage-bridge--tag-integration)
7. [Phase 10E: SVG Asset Bundling & Catalog Generation](#phase-10e-svg-asset-bundling--catalog-generation)
8. [File Structure](#file-structure)
9. [Integration Points with Existing Architecture](#integration-points-with-existing-architecture)
10. [Security Plan](#security-plan)
11. [Performance Plan](#performance-plan)
12. [Testing Plan](#testing-plan)
13. [Dependency Graph](#dependency-graph)
14. [Risk Register](#risk-register)
15. [Total Estimates](#total-estimates)
16. [Agent Prompts](#agent-prompts)

---

## Executive Summary

This plan integrates the entire FUXA SVG Widgets library (1,450+ industrial SVG widgets) into the Suderra SCADA Builder. FUXA widgets are not static images -- they contain embedded JavaScript with a 6-state engine, `putValue`/`postValue` APIs for bidirectional data binding, color transitions, blinking animations, and configurable export variables. Every widget must retain full interactivity after integration.

The core architectural decision is an **iframe-sandboxed runtime** that executes FUXA widget JavaScript in strict isolation, communicating with our TagValueBus via postMessage. This avoids polluting our React application with arbitrary third-party JS while preserving all FUXA widget behaviors.

**What the user gains**: 1,450+ professional industrial symbols (electrical, process engineering, fluid power, dynamic SVGs, instrumentation, conveyors, HVAC, piping, valves, motors, reactors) -- all interactive, all data-bindable, all working out-of-the-box with the existing Suderra tag system and animation engine.

**Scale targets:**
- 1,450+ FUXA widgets browseable via catalog
- 50 FUXA widgets on a single canvas at 60fps
- Sub-200ms widget instantiation from catalog click to visible on canvas
- <16ms postMessage round-trip for tag value updates
- Zero main-thread JavaScript execution from FUXA widget code

---

## Architectural Principles

All sub-phases follow the same non-negotiable rules established in the enterprise plan, plus these FUXA-specific additions:

1. **Iframe Sandbox Isolation** -- FUXA widget JavaScript executes exclusively inside `<iframe sandbox="allow-scripts">` elements. No FUXA JS ever runs in the parent window context. No `allow-same-origin` is permitted.
2. **postMessage-Only Communication** -- All data flow between the Suderra application and FUXA widgets passes through `window.postMessage`. No shared memory, no global variable access, no DOM traversal across the boundary.
3. **Auto-Generated Config Panels** -- No hardcoded per-widget config panels for FUXA widgets. The `//!export-start` to `//!export-end` blocks in each SVG are parsed at build time, and the config UI is generated dynamically from the parsed variable declarations.
4. **Existing Pattern Compliance** -- FUXA widgets integrate through the established Config/Renderer/Config-Panel Triple: a `fuxaWidget` entry in `scada-widget-sizes.ts`, a lazy `FuxaWidgetRenderer` in `WidgetRenderer.tsx`, and a dynamic `FuxaWidgetConfig` in `widget-configs/index.ts`.
5. **No SVG Modification** -- FUXA SVG files are used verbatim. We do not edit, strip, or transform the SVG content. The integrity of the original widget JavaScript is preserved.
6. **MIT Attribution** -- FUXA SVG Widgets license attribution is recorded in `THIRD_PARTY_LICENSES` at the project root.

---

## FUXA Widget Anatomy

Understanding the internal structure of a FUXA SVG widget is essential for this integration. Every widget follows the same pattern:

### 2.1 File Structure of a FUXA Widget

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H">
  <defs>
    <style>/* CSS animations, fill rules */</style>
  </defs>

  <!-- Visual elements: paths, rects, circles, groups -->
  <g id="Layer_1">
    <!-- state0 through state5 visual groups -->
    <g class="state state0"> ... </g>
    <g class="state state1" style="display:none"> ... </g>
    <!-- ... up to state5 ... -->
  </g>

  <script>
    //!export-start
    var _pc_state0 = '#00FF00';    // color - Off/Normal
    var _pc_state1 = '#33CC33';    // color - Running
    var _pc_state2 = '#FFCC00';    // color - Warning
    var _pc_state3 = '#FF0000';    // color - Fault
    var _pc_state4 = '#808080';    // color - Invalid
    var _pc_state5 = '#0000FF';    // color - Spare
    var _pn_shade = 15;            // number - shade percentage
    var _pn_padding = 0;           // number - padding
    var _pb_keepAspect = true;     // boolean - lock aspect ratio
    var _pn_rotate = 0;            // number - rotation degrees
    var _pb_flipX = false;         // boolean - horizontal flip
    var _pb_flipY = false;         // boolean - vertical flip
    //!export-end

    // State management engine
    function putValue(id, value) {
      // Receives data from host: switches states, applies colors, etc.
      if (id === '_pn_setState') {
        setActiveState(Math.floor(value));
      }
    }

    function postValue(id, value) {
      // Sends data to host: user interactions, knob values, etc.
      parent.postMessage({ type: 'postValue', id: id, value: value }, '*');
    }

    // Internal state management
    var currentState = 0;
    function setActiveState(state) {
      // Hides all state groups, shows the requested one
      // Applies state colors with shade calculations
    }

    // MutationObserver for self-cleanup
    var observer = new MutationObserver(function(mutations) { ... });
  </script>
</svg>
```

### 2.2 Export Variable Naming Convention

FUXA uses a strict prefix convention to declare the type of each export variable:

| Prefix | Type | UI Control | Example |
|--------|------|-----------|---------|
| `_pn_` | Number | Slider or numeric input with min/max/step | `_pn_shade = 15` |
| `_ps_` | String | Text input | `_ps_label = 'Motor 1'` |
| `_pb_` | Boolean | Toggle/checkbox | `_pb_flipX = false` |
| `_pc_` | Color | Color picker (hex with alpha) | `_pc_state0 = '#00FF00'` |

### 2.3 The 6-State Model

Every FUXA widget supports up to 6 visual states:

| State | Typical Meaning | Default Color |
|-------|----------------|---------------|
| 0 | Off / Normal / De-energized | Green (#00FF00) |
| 1 | Running / On / Energized | Bright Green (#33CC33) |
| 2 | Warning / Caution | Yellow (#FFCC00) |
| 3 | Fault / Error / Alarm | Red (#FF0000) |
| 4 | Invalid / Communication Lost | Gray (#808080) |
| 5 | Spare / Maintenance | Blue (#0000FF) |

States are activated by calling `putValue('_pn_setState', stateNumber)` on the widget. The widget hides all state groups and shows the matching one, applying the configured state color with shade calculations.

### 2.4 Widget Categories in FUXA Repository

The FUXA-SVG-Widgets repository contains these top-level categories:

| Category | Approximate Count | Examples |
|----------|------------------|---------|
| Electrical / Power | ~180 | Motors, transformers, breakers, switches, generators |
| Process Engineering | ~200 | Reactors, distillation columns, heat exchangers, filters |
| Fluid Power / Hydraulic | ~120 | Pumps, cylinders, accumulators, flow dividers |
| Dynamic SVG | ~150 | Animated conveyor belts, rotating fans, pulsing indicators |
| Instrumentation | ~100 | Transmitters, gauges, analyzers, flow meters |
| Piping & Valves | ~180 | Gate valves, globe valves, check valves, reducers, flanges |
| HVAC | ~80 | Dampers, fans, coils, compressors, cooling towers |
| Conveyors & Material | ~60 | Belt conveyors, screw conveyors, hoppers, feeders |
| Tanks & Vessels | ~100 | Vertical tanks, horizontal tanks, silos, columns |
| Electrical Panels | ~80 | PLCs, I/O modules, HMI panels, VFDs |
| Safety & Fire | ~50 | Fire detectors, sprinklers, safety showers, alarms |
| Misc / General | ~150 | Arrows, labels, indicators, custom shapes |

---

## Phase 10A: Sandboxed Widget Runtime Engine

**Duration**: 2 weeks | **Priority**: CRITICAL | **Files**: 4 new, 4 modified

### 10A.1 Architecture

```
+-------------------------------------------------------------+
|  ScadaWidgetNode (React)                                     |
|  +-------------------------------------------------------+  |
|  | FuxaWidgetRenderer                                     |  |
|  |  +--------------------------------------------------+  |  |
|  |  | <iframe sandbox="allow-scripts" srcdoc="...">    |  |  |
|  |  |  +--------------------------------------------+  |  |  |
|  |  |  | FUXA SVG + embedded JavaScript              |  |  |
|  |  |  | - 6-state engine (setActiveState)           |  |  |
|  |  |  | - putValue() receives data from host        |  |  |
|  |  |  | - postValue() sends data to host            |  |  |
|  |  |  | - MutationObserver self-cleanup              |  |  |
|  |  |  +--------------------------------------------+  |  |  |
|  |  +--------------------------------------------------+  |  |
|  |         ^ postMessage bridge v                         |  |
|  |  FuxaMessageBridge <--> TagValueBus                    |  |
|  +-------------------------------------------------------+  |
+-------------------------------------------------------------+
```

### 10A.2 FuxaWidgetRenderer Component

**File**: `web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx`

The renderer is a React component that:
1. Takes a FUXA SVG string from `config.svgContent` (loaded from the catalog).
2. Wraps it in a minimal HTML document shell with CSP meta tags.
3. Renders it inside an `<iframe>` with `sandbox="allow-scripts"` and `srcdoc`.
4. Manages a `FuxaMessageBridge` instance for postMessage communication.

```typescript
interface FuxaWidgetRendererProps {
  config: Record<string, unknown>;
  value?: number | string | boolean;
  width: number;
  height: number;
  isEditing: boolean;
  onCommand?: (command: string, value?: unknown) => void;
  tagName?: string;
  animationState?: AnimationState;
}
```

Key implementation details:

```typescript
// srcdoc template injected into the iframe
function buildSrcdoc(svgContent: string, exportOverrides: Record<string, unknown>): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;">
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }
    svg { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  ${svgContent}
  <script>
    // Override export variables from host config
    ${Object.entries(exportOverrides)
      .map(([k, v]) => `if (typeof ${k} !== 'undefined') ${k} = ${JSON.stringify(v)};`)
      .join('\n    ')}

    // Bridge: receive putValue from parent
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'putValue' && typeof putValue === 'function') {
        putValue(e.data.id, e.data.value);
      }
      if (e.data && e.data.type === 'putExportOverrides' && typeof putValue === 'function') {
        var overrides = e.data.overrides;
        for (var key in overrides) {
          putValue(key, overrides[key]);
        }
      }
    });

    // Override postValue to send to parent
    var _originalPostValue = typeof postValue === 'function' ? postValue : null;
    postValue = function(id, value) {
      parent.postMessage({ type: 'postValue', id: id, value: value }, '*');
    };
  </script>
</body>
</html>`;
}
```

### 10A.3 Iframe Sandbox Configuration

The iframe uses the most restrictive sandbox possible while still allowing FUXA widget JavaScript to execute:

```html
<iframe
  sandbox="allow-scripts"
  srcdoc={srcdocContent}
  style={{ width: '100%', height: '100%', border: 'none' }}
  title={`FUXA Widget: ${config.fuxaWidgetId}`}
/>
```

**Sandbox permissions analysis:**

| Permission | Granted | Reason |
|-----------|---------|--------|
| `allow-scripts` | YES | FUXA widgets require JavaScript for state switching and animations |
| `allow-same-origin` | NO | Prevents iframe from accessing parent cookies, localStorage, IndexedDB |
| `allow-forms` | NO | FUXA widgets do not submit forms |
| `allow-popups` | NO | FUXA widgets must not open new windows |
| `allow-top-navigation` | NO | FUXA widgets must not navigate the parent page |
| `allow-modals` | NO | FUXA widgets must not show alert/confirm/prompt |

Without `allow-same-origin`, the iframe is treated as a unique origin. It cannot:
- Read `document.cookie` from the parent
- Access `localStorage` or `sessionStorage` of the parent
- Make `fetch` or `XMLHttpRequest` calls (blocked by CSP `default-src 'none'`)
- Access the parent DOM via `parent.document`

### 10A.4 Lifecycle Management

```typescript
// Ref-based lifecycle for the iframe
const iframeRef = useRef<HTMLIFrameElement | null>(null);
const bridgeRef = useRef<FuxaMessageBridge | null>(null);

// Create bridge when iframe loads
const handleIframeLoad = useCallback(() => {
  if (iframeRef.current?.contentWindow) {
    bridgeRef.current = new FuxaMessageBridge(
      iframeRef.current.contentWindow,
      config.fuxaWidgetId as string,
      onCommand,
    );
  }
}, [config.fuxaWidgetId, onCommand]);

// Cleanup bridge on unmount
useEffect(() => {
  return () => {
    bridgeRef.current?.destroy();
    bridgeRef.current = null;
  };
}, []);

// Push tag value changes to FUXA widget via putValue
useEffect(() => {
  if (bridgeRef.current && value !== undefined) {
    const stateMapping = config.stateMapping as FuxaStateMapping | undefined;
    if (stateMapping) {
      const computedState = computeStateFromTag(value, stateMapping);
      bridgeRef.current.putValue('_pn_setState', computedState);
    }
  }
}, [value, config.stateMapping]);

// Push export variable overrides when config changes
useEffect(() => {
  if (bridgeRef.current) {
    const overrides = extractExportOverrides(config);
    bridgeRef.current.putExportOverrides(overrides);
  }
}, [config]);
```

### 10A.5 Srcdoc Regeneration Strategy

The `srcdoc` attribute is only recomputed when the SVG content or export variable overrides change. Tag value updates (which happen at high frequency) flow through `postMessage` and never trigger srcdoc regeneration.

```typescript
const srcdoc = useMemo(
  () => buildSrcdoc(
    config.svgContent as string,
    extractExportOverrides(config),
  ),
  [config.svgContent, /* stable hash of export overrides */],
);
```

### 10A.6 Integration with WidgetRenderer

**Modification to `WidgetRenderer.tsx`:**

```typescript
// Add to lazyMap
fuxaWidget: React.lazy(() => import('./widget-renderers/FuxaWidgetRenderer')),
```

**Modification to `scada-widget.types.ts`:**

```typescript
// Add to ScadaWidgetType union
| 'fuxaWidget'
```

**Modification to `scada-widget-sizes.ts`:**

```typescript
// FUXA widgets use a default 2x2 grid size but can scale freely
fuxaWidget: { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 12, maxH: 12 },
```

---

## Phase 10B: Export Variable Parser & Auto-Config Panel

**Duration**: 1.5 weeks | **Priority**: HIGH | **Files**: 3 new, 1 modified

### 10B.1 FuxaExportParser

**File**: `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaExportParser.ts`

Parses the `//!export-start` to `//!export-end` block from any FUXA widget SVG and produces a typed array of export variable descriptors.

```typescript
export type FuxaExportVarType = 'number' | 'string' | 'boolean' | 'color';

export interface FuxaExportVariable {
  /** Raw variable name, e.g. '_pc_state0' */
  name: string;
  /** Derived type from prefix: _pn_=number, _ps_=string, _pb_=boolean, _pc_=color */
  type: FuxaExportVarType;
  /** Default value parsed from the declaration */
  defaultValue: number | string | boolean;
  /** Human-readable label derived from name: '_pc_state0' -> 'state0' */
  label: string;
  /** Semantic group for UI organization: 'stateColor' | 'appearance' | 'transform' | 'custom' */
  group: FuxaExportGroup;
}

export type FuxaExportGroup = 'stateColor' | 'appearance' | 'transform' | 'custom';

const PREFIX_TYPE_MAP: Record<string, FuxaExportVarType> = {
  '_pn_': 'number',
  '_ps_': 'string',
  '_pb_': 'boolean',
  '_pc_': 'color',
};

/** Well-known variable name patterns for automatic grouping */
const GROUP_RULES: Array<{ pattern: RegExp; group: FuxaExportGroup }> = [
  { pattern: /^_pc_state\d$/, group: 'stateColor' },
  { pattern: /^_pn_shade$/, group: 'appearance' },
  { pattern: /^_pn_padding$/, group: 'appearance' },
  { pattern: /^_pb_keepAspect$/, group: 'appearance' },
  { pattern: /^_pn_rotate$/, group: 'transform' },
  { pattern: /^_pn_offsetX$/, group: 'transform' },
  { pattern: /^_pn_offsetY$/, group: 'transform' },
  { pattern: /^_pb_flipX$/, group: 'transform' },
  { pattern: /^_pb_flipY$/, group: 'transform' },
];
```

**Parsing algorithm:**

```typescript
export function parseFuxaExports(svgContent: string): FuxaExportVariable[] {
  const exportBlockRegex = /\/\/!export-start([\s\S]*?)\/\/!export-end/;
  const match = svgContent.match(exportBlockRegex);
  if (!match) return [];

  const block = match[1];
  const variables: FuxaExportVariable[] = [];

  // Match: var _prefix_name = value;
  const varRegex = /var\s+(_p[nsbce]_\w+)\s*=\s*(.+?)\s*;/g;
  let varMatch: RegExpExecArray | null;

  while ((varMatch = varRegex.exec(block)) !== null) {
    const name = varMatch[1];
    const rawValue = varMatch[2].trim();

    // Determine type from prefix
    const prefix = name.substring(0, 4);
    const type = PREFIX_TYPE_MAP[prefix];
    if (!type) continue;

    // Parse default value
    const defaultValue = parseDefaultValue(type, rawValue);

    // Derive label: strip prefix and convert camelCase/snake_case to human-readable
    const label = name.substring(4).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();

    // Determine group
    const group = GROUP_RULES.find(r => r.pattern.test(name))?.group ?? 'custom';

    variables.push({ name, type, defaultValue, label, group });
  }

  return variables;
}

function parseDefaultValue(type: FuxaExportVarType, raw: string): number | string | boolean {
  switch (type) {
    case 'number': return parseFloat(raw) || 0;
    case 'boolean': return raw === 'true';
    case 'string':
    case 'color':
      // Strip quotes
      return raw.replace(/^['"]|['"]$/g, '');
  }
}
```

### 10B.2 FuxaAutoConfigPanel (FuxaWidgetConfig)

**File**: `web/modules/sensor-module/src/components/scada-builder/widget-configs/FuxaWidgetConfig.tsx`

A single config panel component that renders dynamically based on the parsed export variables of the active FUXA widget. No per-widget config panels needed.

**UI Sections (in order):**

1. **Widget Info** -- Widget name, category, description (read-only from catalog)
2. **Data Binding** -- Tag selector dropdown for the primary tag that drives the state machine. Threshold configuration for mapping tag values to states 0-5.
3. **State Colors** -- 6 color pickers for `_pc_state0` through `_pc_state5`, rendered only when the widget exports them.
4. **Appearance** -- Shade percentage slider, padding input, aspect ratio toggle -- rendered only for variables in the `appearance` group.
5. **Transform** -- Rotation angle (0-360), offset X/Y inputs, flip horizontal/vertical checkboxes -- rendered only for variables in the `transform` group.
6. **Custom Properties** -- Any remaining export variables that do not match known groups. Renders controls based on type: number=slider, string=text input, boolean=checkbox, color=color picker.

```typescript
interface FuxaWidgetConfigProps {
  config: Record<string, unknown>;
  onChange: (updates: Record<string, unknown>) => void;
  deviceId?: string | null;
}

export const FuxaWidgetConfig: React.FC<FuxaWidgetConfigProps> = ({ config, onChange, deviceId }) => {
  const exportVars = useMemo(
    () => parseFuxaExports(config.svgContent as string),
    [config.svgContent],
  );

  const grouped = useMemo(() => {
    const groups: Record<FuxaExportGroup, FuxaExportVariable[]> = {
      stateColor: [],
      appearance: [],
      transform: [],
      custom: [],
    };
    for (const v of exportVars) {
      groups[v.group].push(v);
    }
    return groups;
  }, [exportVars]);

  // ... renders sections per group
};
```

**State Mapping Configuration UI:**

```typescript
interface StateMappingRow {
  condition: 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | 'between';
  value: number | [number, number];
  state: 0 | 1 | 2 | 3 | 4 | 5;
}
```

The user configures rules like:
- Tag value < 10 -> State 0 (Off)
- Tag value >= 10 AND < 50 -> State 1 (Running)
- Tag value >= 50 AND < 80 -> State 2 (Warning)
- Tag value >= 80 -> State 3 (Fault)

Each row renders a condition dropdown, value input(s), and a state dropdown with color preview.

### 10B.3 Variable Control Rendering

Each export variable renders as the appropriate input control:

```typescript
function renderVariableControl(
  variable: FuxaExportVariable,
  currentValue: unknown,
  onValueChange: (name: string, value: unknown) => void,
): React.ReactNode {
  switch (variable.type) {
    case 'number':
      return (
        <div key={variable.name} className="flex items-center justify-between gap-2 py-1">
          <label className="text-xs text-gray-600 truncate">{variable.label}</label>
          <input
            type="number"
            className="w-20 px-2 py-1 text-xs border rounded"
            value={(currentValue as number) ?? variable.defaultValue}
            onChange={(e) => onValueChange(variable.name, parseFloat(e.target.value))}
          />
        </div>
      );
    case 'boolean':
      return (
        <div key={variable.name} className="flex items-center justify-between gap-2 py-1">
          <label className="text-xs text-gray-600 truncate">{variable.label}</label>
          <input
            type="checkbox"
            checked={(currentValue as boolean) ?? variable.defaultValue}
            onChange={(e) => onValueChange(variable.name, e.target.checked)}
          />
        </div>
      );
    case 'color':
      return (
        <div key={variable.name} className="flex items-center justify-between gap-2 py-1">
          <label className="text-xs text-gray-600 truncate">{variable.label}</label>
          <input
            type="color"
            className="w-8 h-6 border rounded cursor-pointer"
            value={(currentValue as string) ?? variable.defaultValue}
            onChange={(e) => onValueChange(variable.name, e.target.value)}
          />
        </div>
      );
    case 'string':
      return (
        <div key={variable.name} className="flex items-center justify-between gap-2 py-1">
          <label className="text-xs text-gray-600 truncate">{variable.label}</label>
          <input
            type="text"
            className="w-32 px-2 py-1 text-xs border rounded"
            value={(currentValue as string) ?? variable.defaultValue}
            onChange={(e) => onValueChange(variable.name, e.target.value)}
          />
        </div>
      );
  }
}
```

### 10B.4 Config Panel Registration

**Modification to `widget-configs/index.ts`:**

```typescript
import { FuxaWidgetConfig } from './FuxaWidgetConfig';

// Add to widgetConfigMap
fuxaWidget: FuxaWidgetConfig,
```

---

## Phase 10C: Widget Catalog & Browser UI

**Duration**: 2 weeks | **Priority**: HIGH | **Files**: 3 new, 2 modified

### 10C.1 Catalog Data Structure

**File**: `web/modules/sensor-module/src/assets/fuxa-widgets/catalog.json`

A static JSON manifest generated at build time by the catalog generation script (Phase 10E). Contains metadata for every FUXA widget.

```typescript
interface FuxaWidgetCatalogEntry {
  /** Unique widget identifier, e.g. 'electrical.motor.three-phase' */
  id: string;
  /** Human-readable name, e.g. 'Three Phase Motor' */
  name: string;
  /** Top-level category, e.g. 'Electrical' */
  category: string;
  /** Optional subcategory, e.g. 'Motors' */
  subcategory?: string;
  /** Base64 data URI of the thumbnail preview (128x128 PNG) */
  thumbnail: string;
  /** Relative path to the SVG file within the bundled assets directory */
  svgPath: string;
  /** Size of the SVG file in bytes (for size limit enforcement) */
  fileSize: number;
  /** Tier classification: 1 = standard (static + state switching), 2 = advanced (animations + custom JS) */
  tier: 1 | 2;
  /** Pre-parsed export variables from the //!export-start block */
  exportVariables: FuxaExportVariable[];
  /** Searchable keyword tags */
  tags: string[];
  /** Number of visual states (0-6) */
  stateCount: number;
  /** Whether the widget has postValue (output) capability */
  hasOutput: boolean;
}

interface FuxaWidgetCatalog {
  version: string;
  generatedAt: string;
  totalWidgets: number;
  categories: FuxaCategoryNode[];
  widgets: FuxaWidgetCatalogEntry[];
}

interface FuxaCategoryNode {
  name: string;
  count: number;
  subcategories: Array<{
    name: string;
    count: number;
  }>;
}
```

### 10C.2 FuxaWidgetBrowser Component

**File**: `web/modules/sensor-module/src/components/scada-builder/FuxaWidgetBrowser.tsx`

A full-screen modal or slide-out panel that lets the user browse, search, preview, and add FUXA widgets to the canvas.

**Layout:**

```
+------------------------------------------------------------------+
| FUXA Widget Library                                    [X Close]  |
+------------------------------------------------------------------+
| [Search: ___________________] [Filter: All Tiers v]              |
+------------------------------------------------------------------+
|                    |                                              |
| Category Tree      |  Widget Grid                                |
|                    |                                              |
| > Electrical [180] |  [thumb] [thumb] [thumb] [thumb]            |
|   > Motors         |  3-Phase  VFD     Servo   Stepper           |
|   > Transformers   |                                              |
|   > Breakers       |  [thumb] [thumb] [thumb] [thumb]            |
| > Process Eng [200]|  Motor2   Motor3  Motor4  Motor5            |
|   > Reactors       |                                              |
|   > Columns        |  ... (virtualized grid continues) ...        |
| > Fluid Power [120]|                                              |
|   > Pumps          |                                              |
|   > Cylinders      |                                              |
| > Dynamic SVG [150]|                                              |
| ...                |                                              |
|                    |                                              |
| Recently Used (5)  |  Preview Panel (click to expand)             |
| [thumb] [thumb]... |  +---------------------------------------+  |
|                    |  | [Large Preview]                       |  |
| Favorites (star)   |  | Name: Three Phase Motor               |  |
| [thumb] [thumb]... |  | Category: Electrical > Motors          |  |
|                    |  | States: 6  |  Has Output: No           |  |
|                    |  | Export Variables: 12                    |  |
|                    |  | [Add to Canvas] [Add to Favorites]     |  |
|                    |  +---------------------------------------+  |
+------------------------------------------------------------------+
```

**Key features:**

1. **Category tree sidebar** -- Collapsible tree view of all categories and subcategories. Each node shows the widget count. Clicking a category filters the grid.

2. **Search bar with fuzzy matching** -- Uses a simple fuzzy search algorithm (Levenshtein or substring match against name + tags). Results update as the user types with a 200ms debounce.

3. **Virtualized widget grid** -- Uses `react-window` or manual virtualization for smooth scrolling through 1,450+ thumbnails. Only visible thumbnails are rendered in the DOM. Each cell shows a 96x96 thumbnail and the widget name below it.

4. **Preview panel** -- Clicking a widget thumbnail opens a larger preview (256x256) with widget metadata: name, category, state count, export variable count, whether it has output capability, file size.

5. **Drag-to-canvas** -- Each widget thumbnail is draggable. The drag data includes the widget catalog ID, default dimensions, and the `fuxaWidget` type. Dropping on the canvas creates a new FUXA widget node.

6. **"Add to Canvas" button** -- Alternative to drag: click to place the widget at the center of the viewport.

7. **Recently Used section** -- Stored in `localStorage` (tenant-scoped). Shows the last 10 used FUXA widgets for quick re-access.

8. **Favorites** -- Star toggle on each widget. Stored in `localStorage` (tenant-scoped). Favorites section appears at the top of the sidebar.

### 10C.3 Widget Loading on Drop

When a FUXA widget is dropped onto the canvas:

```typescript
async function handleFuxaWidgetDrop(catalogId: string): Promise<Record<string, unknown>> {
  // 1. Look up catalog entry
  const entry = fuxaCatalog.widgets.find(w => w.id === catalogId);
  if (!entry) throw new Error(`FUXA widget not found: ${catalogId}`);

  // 2. Load SVG content from bundled assets
  const svgContent = await loadFuxaSvg(entry.svgPath);

  // 3. Validate file size (500KB limit)
  if (new Blob([svgContent]).size > 500 * 1024) {
    throw new Error(`FUXA widget exceeds 500KB size limit: ${catalogId}`);
  }

  // 4. Build initial config with default export values
  const defaultConfig: Record<string, unknown> = {
    fuxaWidgetId: catalogId,
    fuxaWidgetName: entry.name,
    fuxaCategory: entry.category,
    svgContent: svgContent,
    stateMapping: null, // User configures this in the config panel
  };

  // Set default values for all export variables
  for (const v of entry.exportVariables) {
    defaultConfig[v.name] = v.defaultValue;
  }

  return defaultConfig;
}
```

### 10C.4 Integration with WidgetPalette

**Modification to `WidgetPalette.tsx`:**

Add a "FUXA Library" category at the bottom of the palette with a single button that opens the FuxaWidgetBrowser:

```typescript
// New category in WIDGET_CATEGORIES
{
  name: 'FUXA Library',
  widgets: [
    {
      type: 'fuxaWidget' as ScadaWidgetType,
      label: 'Browse 1,450+ Widgets...',
      icon: <Library className="w-4 h-4" />,
      defaultConfig: { _openBrowser: true }, // Signal to open browser instead of direct drop
    },
  ],
},
```

### 10C.5 SVG Content Caching

To avoid loading the same SVG file multiple times when the same widget type is used on a canvas:

```typescript
class FuxaSvgCache {
  private cache = new Map<string, string>();
  private loading = new Map<string, Promise<string>>();

  async load(svgPath: string): Promise<string> {
    // Return cached content immediately
    const cached = this.cache.get(svgPath);
    if (cached) return cached;

    // Deduplicate concurrent loads for the same path
    const inflight = this.loading.get(svgPath);
    if (inflight) return inflight;

    const promise = fetch(svgPath)
      .then(r => r.text())
      .then(content => {
        this.cache.set(svgPath, content);
        this.loading.delete(svgPath);
        return content;
      });

    this.loading.set(svgPath, promise);
    return promise;
  }

  /** Evict least-recently-used entries when cache exceeds 50 entries */
  evictIfNeeded(): void {
    if (this.cache.size > 50) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }
}

export const fuxaSvgCache = new FuxaSvgCache();
```

---

## Phase 10D: PostMessage Bridge & Tag Integration

**Duration**: 1.5 weeks | **Priority**: CRITICAL | **Files**: 4 new, 1 modified

### 10D.1 FuxaMessageBridge

**File**: `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaMessageBridge.ts`

Handles all bidirectional postMessage communication between the parent window and FUXA widget iframes.

```typescript
export interface FuxaMessage {
  type: 'putValue' | 'postValue' | 'putExportOverrides' | 'ready' | 'error';
  id?: string;
  value?: unknown;
  overrides?: Record<string, unknown>;
  error?: string;
}

export class FuxaMessageBridge {
  private iframeWindow: Window;
  private widgetId: string;
  private onCommand?: (command: string, value?: unknown) => void;
  private messageHandler: (e: MessageEvent) => void;
  private destroyed = false;

  /** Rate limiter: max messages per second from iframe */
  private inboundCount = 0;
  private inboundResetTimer: ReturnType<typeof setInterval>;
  private static readonly MAX_INBOUND_PER_SEC = 100;

  /** Outbound batching: aggregate putValue calls within a single animation frame */
  private pendingPuts = new Map<string, unknown>();
  private batchFrameId: number | null = null;

  constructor(
    iframeWindow: Window,
    widgetId: string,
    onCommand?: (command: string, value?: unknown) => void,
  ) {
    this.iframeWindow = iframeWindow;
    this.widgetId = widgetId;
    this.onCommand = onCommand;

    // Inbound message handler
    this.messageHandler = (e: MessageEvent) => {
      // Origin validation: sandboxed iframes have null origin
      // We only accept messages from our own iframes
      if (this.destroyed) return;

      const data = e.data as FuxaMessage;
      if (!data || typeof data.type !== 'string') return;

      if (data.type === 'postValue') {
        // Rate limiting
        this.inboundCount++;
        if (this.inboundCount > FuxaMessageBridge.MAX_INBOUND_PER_SEC) {
          console.warn(`[FuxaBridge] Rate limit exceeded for widget ${this.widgetId}`);
          return;
        }

        // Forward to Suderra command system
        if (this.onCommand && data.id && data.value !== undefined) {
          this.onCommand('writeTag', data.value);
        }
      }

      if (data.type === 'ready') {
        // Widget has finished loading and is ready to receive putValue calls
        this.flushPendingPuts();
      }
    };

    window.addEventListener('message', this.messageHandler);

    // Reset rate limiter every second
    this.inboundResetTimer = setInterval(() => {
      this.inboundCount = 0;
    }, 1000);
  }

  /**
   * Send a putValue to the FUXA widget.
   * Calls are batched within a single animation frame to avoid flooding
   * the iframe with messages (e.g., when multiple tags update simultaneously).
   */
  putValue(id: string, value: unknown): void {
    if (this.destroyed) return;
    this.pendingPuts.set(id, value);

    if (this.batchFrameId === null) {
      this.batchFrameId = requestAnimationFrame(() => {
        this.flushPendingPuts();
        this.batchFrameId = null;
      });
    }
  }

  private flushPendingPuts(): void {
    if (this.destroyed || this.pendingPuts.size === 0) return;

    this.pendingPuts.forEach((value, id) => {
      try {
        this.iframeWindow.postMessage(
          { type: 'putValue', id, value } as FuxaMessage,
          '*',
        );
      } catch {
        // iframe may have been destroyed
      }
    });
    this.pendingPuts.clear();
  }

  /**
   * Send export variable overrides to the FUXA widget.
   * Used when the user changes colors, shade, padding, etc. in the config panel.
   */
  putExportOverrides(overrides: Record<string, unknown>): void {
    if (this.destroyed) return;
    try {
      this.iframeWindow.postMessage(
        { type: 'putExportOverrides', overrides } as FuxaMessage,
        '*',
      );
    } catch {
      // iframe may have been destroyed
    }
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener('message', this.messageHandler);
    clearInterval(this.inboundResetTimer);
    if (this.batchFrameId !== null) {
      cancelAnimationFrame(this.batchFrameId);
    }
    this.pendingPuts.clear();
  }
}
```

### 10D.2 FuxaStateMapper

**File**: `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaStateMapper.ts`

Maps Suderra tag values to FUXA's 6-state model using user-configured rules.

```typescript
export interface FuxaStateMapping {
  /** The tag FQN that drives this widget's state */
  tag: string;
  /** Ordered rules evaluated top-to-bottom; first match wins */
  rules: FuxaStateMappingRule[];
  /** Default state when no rule matches (default: 0) */
  fallbackState: 0 | 1 | 2 | 3 | 4 | 5;
}

export interface FuxaStateMappingRule {
  condition: 'lt' | 'lte' | 'eq' | 'gte' | 'gt' | 'between' | 'notEqual';
  /** Single value for lt/lte/eq/gte/gt/notEqual, or [min, max] for between */
  value: number | [number, number];
  /** Target FUXA state */
  state: 0 | 1 | 2 | 3 | 4 | 5;
}

/**
 * Evaluates state mapping rules against a tag value.
 * Rules are evaluated in order; first match wins.
 * Returns the fallback state if no rule matches.
 */
export function computeStateFromTag(
  tagValue: unknown,
  mapping: FuxaStateMapping,
): number {
  const numValue = typeof tagValue === 'number'
    ? tagValue
    : typeof tagValue === 'boolean'
      ? (tagValue ? 1 : 0)
      : typeof tagValue === 'string'
        ? parseFloat(tagValue)
        : NaN;

  if (isNaN(numValue)) return mapping.fallbackState;

  for (const rule of mapping.rules) {
    if (evaluateCondition(numValue, rule)) {
      return rule.state;
    }
  }

  return mapping.fallbackState;
}

function evaluateCondition(value: number, rule: FuxaStateMappingRule): boolean {
  switch (rule.condition) {
    case 'lt':
      return value < (rule.value as number);
    case 'lte':
      return value <= (rule.value as number);
    case 'eq':
      return value === (rule.value as number);
    case 'gte':
      return value >= (rule.value as number);
    case 'gt':
      return value > (rule.value as number);
    case 'notEqual':
      return value !== (rule.value as number);
    case 'between': {
      const [min, max] = rule.value as [number, number];
      return value >= min && value < max;
    }
    default:
      return false;
  }
}
```

### 10D.3 TagValueBus Integration

The FuxaWidgetRenderer subscribes to the TagValueBus to receive live tag value updates and forwards them to the FUXA widget through the bridge.

**Integration in FuxaWidgetRenderer.tsx:**

```typescript
// Subscribe to tag changes via the runtime context
const runtimeCtx = useContext(ScadaRuntimeContext);

useEffect(() => {
  if (!runtimeCtx || !config.stateMapping) return;

  const mapping = config.stateMapping as FuxaStateMapping;
  if (!mapping.tag) return;

  const unsub = runtimeCtx.tagBus.subscribe(mapping.tag, (value) => {
    if (bridgeRef.current) {
      const computedState = computeStateFromTag(value, mapping);
      bridgeRef.current.putValue('_pn_setState', computedState);
    }
  });

  return unsub;
}, [runtimeCtx, config.stateMapping]);
```

### 10D.4 Bidirectional Data Flow (Output Widgets)

Some FUXA widgets emit values back to the host (e.g., knob rotation, slider position, button presses). These are captured by the bridge's `postValue` handler and forwarded to the Suderra tag system:

```typescript
// In FuxaMessageBridge constructor, within the postValue handler:
if (data.type === 'postValue' && this.onCommand) {
  // The onCommand callback is the same one used by all Suderra widgets
  // to write values back to the tag system via simulation mode or runtime
  this.onCommand('writeTag', data.value);
}
```

This integrates seamlessly with the existing `handleCommand` callback in `ScadaWidgetNode.tsx`, which handles `writeTag` commands by calling `store.setSimTagValue(tagName, value)` in simulation mode.

### 10D.5 Type Definitions

**File**: `web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/types.ts`

```typescript
/**
 * All FUXA bridge type definitions.
 * Canonical source -- imported by FuxaWidgetRenderer, FuxaWidgetConfig,
 * FuxaMessageBridge, FuxaExportParser, and FuxaStateMapper.
 */

export type { FuxaExportVariable, FuxaExportVarType, FuxaExportGroup } from './FuxaExportParser';
export type { FuxaStateMapping, FuxaStateMappingRule } from './FuxaStateMapper';
export type { FuxaMessage } from './FuxaMessageBridge';

/** Configuration shape stored in ScadaWidgetNodeData.config for fuxaWidget type */
export interface FuxaWidgetConfig {
  /** Catalog entry ID, e.g. 'electrical.motor.three-phase' */
  fuxaWidgetId: string;
  /** Human-readable widget name */
  fuxaWidgetName: string;
  /** Top-level category */
  fuxaCategory: string;
  /** Raw SVG content (loaded from catalog asset) */
  svgContent: string;
  /** Tag-to-state mapping rules (null until user configures) */
  stateMapping: FuxaStateMapping | null;
  /** Export variable overrides (keys are _px_ prefixed variable names) */
  [exportVar: string]: unknown;
}

/** Widget catalog entry -- matches the structure in catalog.json */
export interface FuxaWidgetCatalogEntry {
  id: string;
  name: string;
  category: string;
  subcategory?: string;
  thumbnail: string;
  svgPath: string;
  fileSize: number;
  tier: 1 | 2;
  exportVariables: FuxaExportVariable[];
  tags: string[];
  stateCount: number;
  hasOutput: boolean;
}

export interface FuxaWidgetCatalog {
  version: string;
  generatedAt: string;
  totalWidgets: number;
  categories: FuxaCategoryNode[];
  widgets: FuxaWidgetCatalogEntry[];
}

export interface FuxaCategoryNode {
  name: string;
  count: number;
  subcategories: Array<{ name: string; count: number }>;
}
```

---

## Phase 10E: SVG Asset Bundling & Catalog Generation

**Duration**: 1 week | **Priority**: HIGH | **Files**: 2 new

### 10E.1 Catalog Generation Script

**File**: `web/modules/sensor-module/scripts/generate-fuxa-catalog.ts`

A Node.js build-time script that:

1. **Clones** the FUXA-SVG-Widgets repository (or reads from a local checkout).
2. **Walks** the directory tree to discover all SVG files.
3. **Parses** each SVG to extract:
   - Export variables (`//!export-start` block)
   - State count (count of `<g class="state stateN">` groups)
   - Whether the widget has `postValue` capability
   - File size in bytes
4. **Generates thumbnail previews**: Renders each SVG into a 128x128 PNG using a headless canvas (via `sharp` or `resvg-js` for server-side SVG rendering), then converts to a base64 data URI.
5. **Categorizes** widgets based on directory structure (top-level directory = category, subdirectory = subcategory).
6. **Generates search tags** from the file name, directory path, and export variable names.
7. **Outputs** `catalog.json` and copies SVG files to the asset directory.
8. **Generates** a THIRD_PARTY_LICENSES entry.

```typescript
// Pseudocode for the script
async function generateFuxaCatalog(): Promise<void> {
  const repoPath = process.argv[2] || './fuxa-svg-widgets';
  const outputDir = path.resolve(__dirname, '../src/assets/fuxa-widgets');
  const svgOutputDir = path.join(outputDir, 'svgs');
  const catalogPath = path.join(outputDir, 'catalog.json');

  // Ensure output directories exist
  await fs.mkdir(svgOutputDir, { recursive: true });

  // Discover all SVG files
  const svgFiles = await glob('**/*.svg', { cwd: repoPath });
  console.log(`Found ${svgFiles.length} SVG files`);

  const catalog: FuxaWidgetCatalog = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    totalWidgets: 0,
    categories: [],
    widgets: [],
  };

  const categoryMap = new Map<string, Map<string, number>>();

  for (const svgFile of svgFiles) {
    const content = await fs.readFile(path.join(repoPath, svgFile), 'utf-8');

    // Skip files larger than 500KB
    const fileSize = Buffer.byteLength(content);
    if (fileSize > 500 * 1024) {
      console.warn(`Skipping oversized file: ${svgFile} (${fileSize} bytes)`);
      continue;
    }

    // Parse export variables
    const exportVars = parseFuxaExports(content);

    // Count states
    const stateCount = countStates(content);

    // Detect postValue capability
    const hasOutput = content.includes('postValue');

    // Derive category/subcategory from path
    const parts = svgFile.split('/');
    const category = parts.length > 1 ? formatCategoryName(parts[0]) : 'General';
    const subcategory = parts.length > 2 ? formatCategoryName(parts[1]) : undefined;

    // Generate widget ID
    const baseName = path.basename(svgFile, '.svg');
    const id = [category, subcategory, baseName]
      .filter(Boolean)
      .map(s => slugify(s!))
      .join('.');

    // Generate thumbnail
    const thumbnail = await generateThumbnail(content);

    // Copy SVG to output directory
    const destPath = path.join(svgOutputDir, svgFile);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(path.join(repoPath, svgFile), destPath);

    // Generate search tags
    const tags = generateSearchTags(baseName, category, subcategory, exportVars);

    // Determine tier
    const tier: 1 | 2 = hasOutput || content.includes('setInterval') || content.includes('requestAnimationFrame') ? 2 : 1;

    catalog.widgets.push({
      id,
      name: formatWidgetName(baseName),
      category,
      subcategory,
      thumbnail,
      svgPath: `fuxa-widgets/svgs/${svgFile}`,
      fileSize,
      tier,
      exportVariables: exportVars,
      tags,
      stateCount,
      hasOutput,
    });

    // Track categories
    if (!categoryMap.has(category)) categoryMap.set(category, new Map());
    const subMap = categoryMap.get(category)!;
    subMap.set(subcategory || '__root__', (subMap.get(subcategory || '__root__') || 0) + 1);
  }

  // Build category tree
  catalog.categories = Array.from(categoryMap.entries()).map(([name, subMap]) => ({
    name,
    count: Array.from(subMap.values()).reduce((a, b) => a + b, 0),
    subcategories: Array.from(subMap.entries())
      .filter(([k]) => k !== '__root__')
      .map(([subName, count]) => ({ name: subName, count })),
  }));

  catalog.totalWidgets = catalog.widgets.length;

  // Write catalog
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  console.log(`Catalog generated: ${catalog.totalWidgets} widgets in ${catalog.categories.length} categories`);
}

function countStates(svgContent: string): number {
  const stateRegex = /class=["'][^"']*state(\d)["']/g;
  const states = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = stateRegex.exec(svgContent)) !== null) {
    states.add(parseInt(match[1], 10));
  }
  return states.size;
}

function generateSearchTags(
  baseName: string,
  category: string,
  subcategory: string | undefined,
  exportVars: FuxaExportVariable[],
): string[] {
  const tags = new Set<string>();
  // Split name on hyphens, underscores, camelCase
  const nameWords = baseName.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/\s+/);
  nameWords.forEach(w => tags.add(w));
  tags.add(category.toLowerCase());
  if (subcategory) tags.add(subcategory.toLowerCase());
  // Add variable-derived tags (e.g., 'motor' from '_ps_motorType')
  for (const v of exportVars) {
    if (v.type === 'string' && typeof v.defaultValue === 'string' && v.defaultValue.length < 20) {
      tags.add(v.defaultValue.toLowerCase());
    }
  }
  return Array.from(tags);
}
```

### 10E.2 NPM Script Integration

**Addition to `package.json`:**

```json
{
  "scripts": {
    "generate:fuxa-catalog": "ts-node scripts/generate-fuxa-catalog.ts ./fuxa-svg-widgets"
  }
}
```

### 10E.3 License Attribution

**Addition to `THIRD_PARTY_LICENSES` at project root:**

```
FUXA SVG Widgets
================
Repository: https://github.com/nicedash/FUXA-SVG-Widgets
License: MIT
Copyright: (c) FUXA Contributors

Used for: 1,450+ industrial SVG widget symbols integrated into the Suderra SCADA Builder.
Widgets are rendered inside sandboxed iframes and are not modified from their original form.

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 10E.4 Build Pipeline Integration

The catalog generation runs as a pre-build step. SVG assets are included in the Vite build as static assets:

```typescript
// vite.config.ts addition
{
  assetsInclude: ['**/*.svg'],
  build: {
    assetsInlineLimit: 0, // Never inline SVGs -- they are loaded on demand
  },
}
```

---

## File Structure

### New Files

```
web/modules/sensor-module/src/
  components/scada-builder/
    widget-renderers/
      FuxaWidgetRenderer.tsx              # Sandboxed iframe renderer (Phase 10A)
    widget-configs/
      FuxaWidgetConfig.tsx                # Auto-generated config panel (Phase 10B)
    FuxaWidgetBrowser.tsx                 # Catalog browser UI (Phase 10C)
    fuxa-bridge/
      FuxaMessageBridge.ts               # postMessage handler (Phase 10D)
      FuxaExportParser.ts                # //!export-start parser (Phase 10B)
      FuxaStateMapper.ts                 # Tag -> 6-state mapping (Phase 10D)
      types.ts                           # All FUXA integration types (Phase 10D)
  assets/fuxa-widgets/
    catalog.json                          # Generated widget manifest (Phase 10E)
    svgs/                                 # 1,450+ SVG files by category (Phase 10E)
      electrical/
        motors/
        transformers/
        ...
      process-engineering/
        ...
      fluid-power/
        ...
      ...

web/modules/sensor-module/scripts/
  generate-fuxa-catalog.ts               # Build-time catalog generator (Phase 10E)
```

### Modified Files

| File | Changes |
|------|---------|
| `types/scada-widget.types.ts` | Add `'fuxaWidget'` to `ScadaWidgetType` union |
| `constants/scada-widget-sizes.ts` | Add `fuxaWidget` size definition |
| `components/scada-builder/WidgetRenderer.tsx` | Add `fuxaWidget` to `lazyMap` |
| `components/scada-builder/widget-configs/index.ts` | Register `FuxaWidgetConfig` |
| `components/scada-builder/WidgetPalette.tsx` | Add "FUXA Library" category with browser button |
| `THIRD_PARTY_LICENSES` (project root) | Add FUXA SVG Widgets MIT attribution |

---

## Integration Points with Existing Architecture

### 9.1 ScadaWidgetNode Integration

No changes needed to `ScadaWidgetNode.tsx`. The existing node wrapper handles `fuxaWidget` like any other widget type through the `WidgetRenderer` dispatch. The container div provides resize handles, z-index layering, SVG transforms, animation state, and tooltip -- all of which work out of the box.

### 9.2 Animation Engine Integration

FUXA widgets have their own internal animation system (state switching, color transitions, blinking via CSS). The Suderra animation engine (`AnimationEngine.ts`) does NOT need to be extended for FUXA widgets -- the FUXA widget's own JavaScript handles all visual state changes.

However, the animation engine's **`colorRange`**, **`blink`**, and **`hide`/`show`** rules can still be applied to the FUXA widget's container div (via `animatedContainerStyle` in `ScadaWidgetNode.tsx`). This means:
- Container-level blinking still works (CSS animation on the container)
- Container-level hide/show still works (opacity: 0 / pointerEvents: none)
- Container-level rotation still works (CSS transform on the container)

The FUXA widget's internal animations are additive to container-level animations.

### 9.3 Event System Integration

FUXA widgets that emit `postValue` messages integrate with the existing event system through the `onCommand` callback:

```
FUXA widget postValue -> FuxaMessageBridge -> onCommand('writeTag', value)
  -> ScadaWidgetNode.handleCommand -> store.setSimTagValue(tagName, value)
```

For advanced event handling (e.g., FUXA widget click -> navigate to screen), the user can configure widget events in the existing event panel. The event system in `ScadaWidgetNode` already captures `onClick` and `onDoubleClick` at the container level, which triggers independently of FUXA widget internal events.

### 9.4 Theme System Integration

FUXA widgets use their own colors (state0-state5) and do not automatically respond to the Suderra theme system (`ThemeProvider`, `useTheme`). This is intentional -- FUXA widgets are self-contained visual units with their own color scheme.

However, a future enhancement could inject CSS custom properties into the iframe srcdoc that map to theme tokens:

```html
<style>
  :root {
    --theme-bg: ${themeTokens.background};
    --theme-text: ${themeTokens.text};
  }
</style>
```

This is NOT in scope for Phase 10 but is noted as a potential Phase 11 enhancement.

### 9.5 SCADA Package JSON Compatibility

FUXA widget data is stored in the existing `ScreenWidget` structure:

```typescript
{
  id: 'widget-uuid',
  type: 'fuxaWidget',
  position: { col: 2, row: 3, w: 2, h: 2 },
  config: {
    fuxaWidgetId: 'electrical.motor.three-phase',
    fuxaWidgetName: 'Three Phase Motor',
    fuxaCategory: 'Electrical',
    svgContent: '<svg ...>...</svg>', // Full SVG content
    stateMapping: {
      tag: 'sensor.motor1.status',
      rules: [
        { condition: 'eq', value: 0, state: 0 },
        { condition: 'eq', value: 1, state: 1 },
        { condition: 'gte', value: 2, state: 3 },
      ],
      fallbackState: 4,
    },
    _pc_state0: '#00FF00',
    _pc_state1: '#33CC33',
    _pc_state2: '#FFCC00',
    _pc_state3: '#FF0000',
    _pc_state4: '#808080',
    _pc_state5: '#0000FF',
    _pn_shade: 15,
    _pb_keepAspect: true,
    _pn_rotate: 0,
  },
  animations: [], // Container-level animations (optional)
  events: [],     // Container-level events (optional)
  locked: false,
  zIndex: 10,
}
```

Backward compatibility: Existing SCADA packages without FUXA widgets load normally. The `fuxaWidget` type is simply not present in their widget arrays. No migration is needed.

### 9.6 Tenant Isolation

FUXA widget SVG content is stored in the SCADA package JSON, which is tenant-scoped by the existing storage layer. The `localStorage` keys for "recently used" and "favorites" in the FuxaWidgetBrowser are tenant-scoped following the pattern established in Phase 0:

```typescript
const STORAGE_KEY_RECENT = `scada-fuxa-recent-${getTenantId()}`;
const STORAGE_KEY_FAVORITES = `scada-fuxa-favorites-${getTenantId()}`;
```

---

## Security Plan

### 11.1 Iframe Sandbox Enforcement

| Threat | Mitigation |
|--------|-----------|
| XSS from FUXA widget JS | `sandbox="allow-scripts"` without `allow-same-origin` prevents access to parent DOM, cookies, storage |
| Network exfiltration from widget JS | CSP `default-src 'none'` in srcdoc blocks all fetch/XHR/WebSocket calls |
| DOM manipulation of parent page | No `allow-same-origin` means `parent.document` access throws SecurityError |
| Cookie theft | No `allow-same-origin` means `document.cookie` returns empty string |
| localStorage access | No `allow-same-origin` means each sandboxed iframe gets a unique opaque origin with no persistent storage |
| Form submission to external URL | No `allow-forms` prevents any form submission |
| New window/tab opening | No `allow-popups` prevents `window.open()` |
| Navigation of parent page | No `allow-top-navigation` prevents `parent.location = ...` |

### 11.2 PostMessage Validation

```typescript
// In FuxaMessageBridge message handler:
if (data.type === 'postValue') {
  // Validate message shape
  if (typeof data.id !== 'string' || data.id.length > 100) return;
  if (data.value === undefined) return;

  // Validate value type (only primitives allowed)
  const vt = typeof data.value;
  if (vt !== 'number' && vt !== 'string' && vt !== 'boolean') return;

  // String values capped at 1000 chars
  if (vt === 'string' && (data.value as string).length > 1000) return;

  // Number values must be finite
  if (vt === 'number' && !isFinite(data.value as number)) return;
}
```

### 11.3 SVG Content Validation

Before any SVG content is used in a srcdoc:

1. **File size limit**: 500KB maximum per widget SVG.
2. **SVG root element check**: Content must start with `<svg` (after whitespace stripping).
3. **No external references check**: Reject SVGs containing `<foreignObject>`, `<use href="http`, `<image href="http`. Only `data:` URIs and internal `#id` references are allowed.
4. **Script tag allowance**: FUXA widget `<script>` tags are intentionally allowed because they execute inside the sandbox. This is safe because:
   - The iframe sandbox prevents any interaction with the parent page.
   - The CSP blocks all network access.
   - The script cannot access any credentials or storage.

### 11.4 Rate Limiting

The FuxaMessageBridge enforces a rate limit of 100 inbound messages per second per widget. This prevents a malicious or buggy widget from flooding the parent with postMessage calls that could cause main-thread jank.

### 11.5 Content Security Policy

The CSP injected into each srcdoc:

```
default-src 'none';
script-src 'unsafe-inline';
style-src 'unsafe-inline';
img-src data:;
```

This allows:
- Inline `<script>` tags (required for FUXA widget JS)
- Inline `<style>` tags (required for FUXA widget CSS)
- `data:` URIs for embedded images within SVGs
- Nothing else: no external resources, no eval beyond inline scripts, no network calls

---

## Performance Plan

### 12.1 Lazy Iframe Creation (Viewport Culling)

FUXA widget iframes are only created when the widget is visible in the ReactFlow viewport. When the user pans/zooms and a widget leaves the viewport, the iframe is replaced with a static thumbnail preview.

```typescript
// In FuxaWidgetRenderer.tsx
const [isInViewport, setIsInViewport] = useState(false);
const containerRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!containerRef.current) return;

  const observer = new IntersectionObserver(
    ([entry]) => setIsInViewport(entry.isIntersecting),
    { rootMargin: '200px' }, // 200px buffer for smooth scrolling
  );

  observer.observe(containerRef.current);
  return () => observer.disconnect();
}, []);

return (
  <div ref={containerRef} style={{ width, height }}>
    {isInViewport ? (
      <iframe sandbox="allow-scripts" srcdoc={srcdoc} ... />
    ) : (
      <img src={config.thumbnail as string} alt={config.fuxaWidgetName as string} />
    )}
  </div>
);
```

### 12.2 Iframe Pooling

For canvases with many instances of the same FUXA widget type, an iframe pool reuses DOM elements:

```typescript
class FuxaIframePool {
  private pool = new Map<string, HTMLIFrameElement[]>();
  private maxPoolSize = 5;

  /** Get an iframe from the pool or create a new one */
  acquire(widgetId: string, srcdoc: string): HTMLIFrameElement {
    const available = this.pool.get(widgetId);
    if (available && available.length > 0) {
      return available.pop()!;
    }

    const iframe = document.createElement('iframe');
    iframe.sandbox.add('allow-scripts');
    iframe.srcdoc = srcdoc;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    return iframe;
  }

  /** Return an iframe to the pool for reuse */
  release(widgetId: string, iframe: HTMLIFrameElement): void {
    const pool = this.pool.get(widgetId) || [];
    if (pool.length < this.maxPoolSize) {
      pool.push(iframe);
      this.pool.set(widgetId, pool);
    } else {
      iframe.remove();
    }
  }
}
```

### 12.3 PostMessage Batching

Outbound `putValue` calls are batched within a single `requestAnimationFrame` cycle:

- Multiple tag value changes within the same frame produce a single `putValue` per unique variable ID.
- This prevents flooding the iframe with messages when many tags update simultaneously (e.g., MQTT batch publish).

### 12.4 Thumbnail Preloading for Catalog Browser

The FuxaWidgetBrowser uses `loading="lazy"` on thumbnail images and preloads the first 50 thumbnails when the browser opens:

```typescript
// Preload first 50 visible thumbnails
useEffect(() => {
  if (!isOpen) return;
  const visibleWidgets = filteredWidgets.slice(0, 50);
  for (const w of visibleWidgets) {
    const img = new Image();
    img.src = w.thumbnail;
  }
}, [isOpen, filteredWidgets]);
```

### 12.5 SVG Content Loading

SVG files are loaded on demand when a widget is placed on the canvas. The `fuxaSvgCache` (Section 10C.5) ensures each SVG is loaded at most once. The cache evicts entries when it exceeds 50 items.

### 12.6 Performance Budget

| Metric | Target | Measurement |
|--------|--------|-------------|
| Widget instantiation (catalog click to visible on canvas) | < 200ms | Performance.now() around loadFuxaSvg + iframe creation |
| postMessage round-trip (putValue -> visual update) | < 16ms | MessageEvent timestamps |
| Canvas FPS with 20 FUXA widgets | >= 60fps | requestAnimationFrame FPS counter |
| Canvas FPS with 50 FUXA widgets | >= 30fps | requestAnimationFrame FPS counter |
| FuxaWidgetBrowser open time | < 500ms | Time from click to first paint |
| Catalog search latency | < 50ms | Debounced search callback timing |
| Memory per FUXA iframe | < 2MB | Chrome DevTools Heap Snapshot |

---

## Testing Plan

### 13.1 Unit Tests

| Test | File | Description |
|------|------|-------------|
| FuxaExportParser: number variables | `fuxa-bridge/__tests__/FuxaExportParser.test.ts` | Parse `_pn_shade = 15` correctly |
| FuxaExportParser: string variables | Same file | Parse `_ps_label = 'Motor 1'` correctly |
| FuxaExportParser: boolean variables | Same file | Parse `_pb_flipX = false` correctly |
| FuxaExportParser: color variables | Same file | Parse `_pc_state0 = '#00FF00'` correctly |
| FuxaExportParser: no export block | Same file | Return empty array for SVGs without `//!export-start` |
| FuxaExportParser: grouping | Same file | Correctly assign `stateColor`, `appearance`, `transform`, `custom` groups |
| FuxaStateMapper: single rule | `fuxa-bridge/__tests__/FuxaStateMapper.test.ts` | `value=5, rule: gte 5 -> state 1` returns 1 |
| FuxaStateMapper: multiple rules | Same file | First matching rule wins |
| FuxaStateMapper: fallback | Same file | No rules match -> returns fallbackState |
| FuxaStateMapper: between | Same file | `value=15, rule: between [10,20] -> state 2` returns 2 |
| FuxaStateMapper: boolean tag | Same file | `true` maps to 1, `false` maps to 0 |
| FuxaStateMapper: NaN tag | Same file | Non-numeric string returns fallbackState |
| FuxaStateMapper: edge cases | Same file | Boundary values (exactly at threshold), negative values, Infinity |
| FuxaMessageBridge: rate limiting | `fuxa-bridge/__tests__/FuxaMessageBridge.test.ts` | 101st message in 1 second is dropped |
| FuxaMessageBridge: putValue batching | Same file | Multiple putValues in same frame produce single postMessage |
| FuxaMessageBridge: destroy cleanup | Same file | Removing event listener, clearing timers |
| FuxaMessageBridge: value validation | Same file | Reject non-primitive values, over-length strings, NaN/Infinity |

### 13.2 Integration Tests

| Test | Description |
|------|-------------|
| FuxaWidgetRenderer: iframe sandbox | Verify iframe has `sandbox="allow-scripts"` attribute and does NOT have `allow-same-origin` |
| FuxaWidgetRenderer: srcdoc CSP | Verify the srcdoc HTML contains the correct CSP meta tag |
| FuxaWidgetRenderer: tag subscription | Verify that changing a tag value in TagValueBus triggers putValue on the bridge |
| FuxaWidgetRenderer: config update | Verify that changing export overrides sends putExportOverrides to iframe |
| FuxaWidgetConfig: dynamic rendering | Verify that the config panel renders the correct controls for each export variable type |
| FuxaWidgetConfig: state mapping UI | Verify that adding/removing/editing state mapping rules updates config correctly |
| FuxaWidgetBrowser: search | Verify fuzzy search returns relevant results for partial matches |
| FuxaWidgetBrowser: category filter | Verify clicking a category shows only widgets from that category |
| FuxaWidgetBrowser: drag to canvas | Verify dragging a widget thumbnail and dropping on canvas creates a fuxaWidget node |

### 13.3 Security Tests

| Test | Description |
|------|-------------|
| Iframe cannot access parent DOM | `parent.document` access inside iframe throws SecurityError |
| Iframe cannot access cookies | `document.cookie` inside iframe returns empty string |
| Iframe cannot make network requests | `fetch('https://evil.com')` inside iframe is blocked by CSP |
| Iframe cannot open popups | `window.open()` inside iframe is blocked |
| Iframe cannot navigate parent | `parent.location = 'evil.com'` inside iframe is blocked |
| SVG size limit enforced | Attempting to load a 600KB SVG fails with appropriate error |
| PostMessage rate limit | Sending 200 messages in 1 second: only first 100 are processed |
| PostMessage value validation | Sending object/array/function values are rejected |

### 13.4 Performance Tests

| Test | Target | Method |
|------|--------|--------|
| 20 FUXA widgets at 60fps | >= 60fps sustained | RAF FPS counter over 10 seconds |
| 50 FUXA widgets at 30fps | >= 30fps sustained | RAF FPS counter over 10 seconds |
| Widget instantiation time | < 200ms | Performance.now() timing |
| postMessage latency | < 16ms | MessageEvent timing |
| Catalog browser render | < 500ms | First contentful paint |
| Memory usage: 20 iframes | < 40MB total | Chrome DevTools Heap Snapshot |

### 13.5 Accessibility Tests

| Test | Description |
|------|-------------|
| Iframe title attribute | Every FUXA iframe has `title="FUXA Widget: {name}"` |
| Catalog browser keyboard nav | Tab through categories, Enter to select, Escape to close |
| Config panel screen reader | All config controls have visible labels |
| Color contrast | State color defaults meet WCAG 2.1 AA contrast ratio |

---

## Dependency Graph

```
Phase 10E (Catalog Gen)  ──────────────────┐
                                            │
Phase 10B (Export Parser)  ───────┐         │
                                  v         v
Phase 10D (Bridge + Mapper)  --> Phase 10A (Renderer) --> Integration Tests
                                  ^         ^
Phase 10C (Browser UI)  ─────────┘         │
                                            │
Existing: TagValueBus, ScadaRuntime  ───────┘
```

**Critical path**: 10E -> 10B -> 10A -> Integration

**Parallel execution:**
- 10B (Export Parser) and 10D (Bridge) can be developed in parallel.
- 10C (Browser UI) can start as soon as 10E (Catalog Gen) produces sample catalog data.
- 10A (Renderer) requires 10B and 10D as inputs.

---

## Risk Register

| ID | Risk | Probability | Impact | Mitigation |
|----|------|-------------|--------|-----------|
| R1 | Some FUXA widgets use APIs not available in sandboxed iframe (e.g., `requestAnimationFrame` works, but `fetch` does not) | Medium | Low | FUXA widgets that require network access are rare (< 5%). Document which widget categories are affected. |
| R2 | iframe memory consumption too high with 50+ widgets on canvas | Medium | High | Implement viewport culling (Section 12.1) and iframe pooling (Section 12.2). Measure actual memory per iframe and set a cap. |
| R3 | postMessage latency introduces visible lag in state transitions | Low | Medium | Batch putValue calls within RAF (Section 10D.1). Measure and profile. |
| R4 | Some FUXA SVGs exceed 500KB size limit | Low | Low | Log warnings during catalog generation. Large SVGs are typically high-detail P&ID diagrams; they still work but trigger a size warning. |
| R5 | FUXA-SVG-Widgets repo updates break catalog generation | Low | Medium | Pin to a specific git tag/commit in the generation script. Run generation as a manual step, not CI-triggered. |
| R6 | Browser UI performance with 1,450+ thumbnails | Medium | Medium | Virtualized grid rendering (react-window or manual). Only render visible cells. |
| R7 | FUXA widget JavaScript errors crash the iframe | Low | Low | Iframe crashes are isolated -- they do not affect the parent page. The WidgetErrorBoundary at the container level will catch any rendering issues. |
| R8 | Cross-browser iframe sandbox behavior differences | Low | Medium | Test on Chrome, Firefox, Safari, Edge. All modern browsers support `sandbox="allow-scripts"` consistently. |
| R9 | FUXA widget `putValue`/`postValue` API changes in future versions | Low | Low | We pin to a specific FUXA-SVG-Widgets version. The `putValue`/`postValue` contract has been stable since FUXA v1.0. |
| R10 | SVG content stored in SCADA package JSON increases package size significantly | Medium | Medium | Each SVG averages 10-30KB. A screen with 20 FUXA widgets adds 200-600KB to the package JSON. For very large deployments, consider deduplication: store SVG content once and reference by ID. |

---

## Total Estimates

| Phase | Duration | New Files | Modified Files | Priority |
|-------|----------|-----------|----------------|----------|
| 10A: Sandboxed Widget Runtime Engine | 2 weeks | 1 | 4 | CRITICAL |
| 10B: Export Variable Parser & Auto-Config Panel | 1.5 weeks | 2 | 1 | HIGH |
| 10C: Widget Catalog & Browser UI | 2 weeks | 2 | 2 | HIGH |
| 10D: PostMessage Bridge & Tag Integration | 1.5 weeks | 3 | 1 | CRITICAL |
| 10E: SVG Asset Bundling & Catalog Generation | 1 week | 1 | 1 | HIGH |
| **Total** | **8 weeks** | **9 new files** | **6 modified files** | |

**Parallelization**: With 2-3 agents working in parallel, the effective timeline can be compressed to 4-5 weeks:
- Agent 1: 10E (week 1) -> 10A (weeks 2-3)
- Agent 2: 10B + 10D (weeks 1-3)
- Agent 3: 10C (weeks 2-3)
- All agents: Integration testing (week 4)

---

## Agent Prompts

### Agent Prompt 1: FuxaExportParser (Phase 10B)

```
ROLE: Senior TypeScript Engineer -- FUXA SVG Widget Export Variable Parser

CONTEXT:
You are implementing `FuxaExportParser.ts` for the Suderra SCADA Builder. This module parses
the `//!export-start` to `//!export-end` block found in FUXA SVG widget files to extract
typed export variable declarations. These declarations drive the auto-generated config panel
(FuxaWidgetConfig.tsx) that allows users to customize FUXA widget appearance without writing code.

FUXA uses a strict variable naming convention:
- `_pn_` prefix = number (e.g., `var _pn_shade = 15;`)
- `_ps_` prefix = string (e.g., `var _ps_label = 'Motor 1';`)
- `_pb_` prefix = boolean (e.g., `var _pb_flipX = false;`)
- `_pc_` prefix = color (e.g., `var _pc_state0 = '#00FF00';`)

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaExportParser.ts

REQUIREMENTS:
1. Export a `parseFuxaExports(svgContent: string): FuxaExportVariable[]` function.
2. The FuxaExportVariable interface must include: name, type, defaultValue, label, group.
3. The type field is derived from the 4-character prefix: _pn_=number, _ps_=string, _pb_=boolean, _pc_=color.
4. The label is derived by stripping the prefix and converting camelCase/snake_case to title case.
5. The group field assigns variables to semantic groups for UI organization:
   - 'stateColor': variables matching /^_pc_state\d$/
   - 'appearance': _pn_shade, _pn_padding, _pb_keepAspect
   - 'transform': _pn_rotate, _pn_offsetX, _pn_offsetY, _pb_flipX, _pb_flipY
   - 'custom': everything else
6. Handle edge cases: missing export block (return []), malformed declarations (skip), nested quotes in strings.
7. ZERO use of `any` type -- all variables fully typed.

TEST FILE: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/__tests__/FuxaExportParser.test.ts

TESTS REQUIRED:
- Parse all four variable types correctly with expected defaultValue
- Return empty array when no //!export-start block exists
- Correctly assign all four groups
- Handle single-quoted and double-quoted strings
- Handle negative numbers, decimals, zero
- Handle export block with extra whitespace, comments, blank lines
- Handle variable names with underscores and camelCase
- Skip malformed lines (missing semicolon, missing value, unknown prefix)

ARCHITECTURE RULES:
- Follow the existing pattern in this codebase: typed interfaces first, then implementation.
- File must be under 200 lines.
- Export only the public API: parseFuxaExports function and type definitions.
- No external dependencies -- pure TypeScript string parsing.
```

### Agent Prompt 2: FuxaMessageBridge (Phase 10D)

```
ROLE: Senior TypeScript Engineer -- FUXA postMessage Bridge

CONTEXT:
You are implementing `FuxaMessageBridge.ts` for the Suderra SCADA Builder. This module handles
all bidirectional postMessage communication between the parent window (React app) and FUXA widget
iframes (sandboxed with `sandbox="allow-scripts"`).

The bridge has two directions:
1. OUTBOUND (parent -> iframe): `putValue(id, value)` sends data to FUXA widgets.
   Used to switch states, update colors, and push live tag values.
2. INBOUND (iframe -> parent): `postValue` messages from FUXA widgets.
   Used when widgets emit values (knob rotation, button press, slider position).

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaMessageBridge.ts

REQUIREMENTS:
1. Class `FuxaMessageBridge` with constructor(iframeWindow: Window, widgetId: string, onCommand?: callback).
2. `putValue(id: string, value: unknown)`: Queue outbound messages, batched within a single requestAnimationFrame.
3. `putExportOverrides(overrides: Record<string, unknown>)`: Send export variable overrides to iframe.
4. `destroy()`: Remove event listener, cancel animation frame, clear intervals, prevent further messaging.
5. INBOUND rate limiting: max 100 messages per second per bridge instance. Excess messages are dropped with console.warn.
6. INBOUND value validation:
   - Only accept primitive values (number, string, boolean)
   - String values capped at 1000 characters
   - Number values must be finite (reject NaN, Infinity)
   - Reject messages with missing or malformed type/id fields
7. Outbound batching: Multiple putValue calls within the same animation frame produce a single postMessage per unique variable ID (last-write-wins within the frame).

EXISTING INTEGRATION POINTS:
- `onCommand` callback follows the same pattern as `WidgetRendererProps.onCommand` in WidgetRenderer.tsx
- The bridge instance is created/destroyed in FuxaWidgetRenderer.tsx via useRef lifecycle

SECURITY:
- Sandboxed iframes post messages with null origin. The bridge does NOT check e.origin (it would be 'null').
- Instead, validation relies on message shape checking and value type enforcement.

TEST FILE: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/__tests__/FuxaMessageBridge.test.ts

TESTS REQUIRED:
- putValue batching: 3 putValues for different IDs in same frame -> 3 postMessages
- putValue last-write-wins: 3 putValues for same ID in same frame -> 1 postMessage with last value
- Rate limiting: 101 inbound messages in 1 second -> 100 accepted, 1 dropped
- Rate limit reset: after 1 second, counter resets and new messages are accepted
- Destroy: after destroy(), putValue is no-op, no more event listeners
- Value validation: reject object, array, function, NaN, Infinity, string > 1000 chars
- Accept valid primitives: number, string (<=1000 chars), boolean

ARCHITECTURE RULES:
- ZERO use of `any` type
- File must be under 200 lines
- No external dependencies
- Use requestAnimationFrame for batching (mock in tests with jest.fn)
```

### Agent Prompt 3: FuxaStateMapper (Phase 10D)

```
ROLE: Senior TypeScript Engineer -- FUXA Tag-to-State Mapper

CONTEXT:
You are implementing `FuxaStateMapper.ts` for the Suderra SCADA Builder. This module maps
Suderra tag values (numbers, booleans, strings from TagValueBus) to FUXA's 6-state model
(states 0-5: Off, Running, Warning, Fault, Invalid, Spare).

Users configure mapping rules in the FuxaWidgetConfig panel. Rules are evaluated in order;
first match wins. If no rule matches, the fallback state is used.

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/FuxaStateMapper.ts

REQUIREMENTS:
1. Export `FuxaStateMapping` and `FuxaStateMappingRule` interfaces.
2. Export `computeStateFromTag(tagValue: unknown, mapping: FuxaStateMapping): number` function.
3. Support conditions: lt, lte, eq, gte, gt, between, notEqual.
4. `between` condition uses [min, max) semantics (inclusive min, exclusive max).
5. Boolean tag values: true -> 1, false -> 0 (then apply numeric rules).
6. String tag values: attempt parseFloat, use fallback if NaN.
7. Null/undefined tag values: return fallback state.
8. Rules are evaluated in array order; first match wins.

TEST FILE: web/modules/sensor-module/src/components/scada-builder/fuxa-bridge/__tests__/FuxaStateMapper.test.ts

TESTS REQUIRED:
- Each condition type with matching and non-matching values
- Between: inclusive min, exclusive max
- Multiple rules: first match wins (not last, not best)
- Fallback: no rules match -> fallbackState
- Boolean: true -> 1, false -> 0
- String: '42.5' -> 42.5, 'abc' -> fallback
- Null/undefined -> fallback
- Empty rules array -> fallback
- Edge: value exactly at boundary (e.g., rule is gte 10, value is 10)
- Edge: negative values, zero, very large numbers
- Edge: Infinity, -Infinity -> fallback (not finite)
```

### Agent Prompt 4: FuxaWidgetRenderer (Phase 10A)

```
ROLE: Senior React Engineer -- FUXA Sandboxed Widget Renderer

CONTEXT:
You are implementing `FuxaWidgetRenderer.tsx` for the Suderra SCADA Builder. This is the
core renderer that displays FUXA SVG widgets inside sandboxed iframes with full interactivity.

This renderer follows the exact same pattern as all other renderers in the codebase
(GaugeRenderer, ToggleSwitchRenderer, etc.) -- it is a default-exported React.FC that
implements the WidgetRendererProps interface.

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/widget-renderers/FuxaWidgetRenderer.tsx

EXISTING PATTERNS TO FOLLOW:
- Read WidgetRenderer.tsx to understand the WidgetRendererProps interface
- Read ScadaRuntime.tsx to understand the ScadaRuntimeContext pattern
- Read ScadaWidgetNode.tsx to understand how onCommand flows from renderer to store
- Read TagValueBus.ts to understand subscribe/publish patterns

REQUIREMENTS:
1. Default export a React.FC<WidgetRendererProps> component.
2. Build an srcdoc string that wraps the FUXA SVG in a minimal HTML shell with:
   - CSP meta tag: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
   - Export variable overrides injected as JS before widget script runs
   - postMessage bridge script: window.addEventListener('message', ...) for putValue
   - postValue override: parent.postMessage({ type: 'postValue', id, value }, '*')
3. Render an <iframe sandbox="allow-scripts" srcdoc={...}> element.
4. NEVER include allow-same-origin in the sandbox attribute.
5. Create a FuxaMessageBridge instance when iframe loads (onLoad callback).
6. Destroy the bridge on component unmount.
7. Subscribe to TagValueBus for the configured tag and push state changes via bridge.putValue.
8. Use IntersectionObserver for viewport culling: show static thumbnail when not visible.
9. Memoize srcdoc computation -- only recompute when svgContent or export overrides change.
10. Tag value changes MUST flow through postMessage, never through srcdoc regeneration.

INTEGRATION:
After implementing, modify these files:
- WidgetRenderer.tsx: add `fuxaWidget: React.lazy(() => import('./widget-renderers/FuxaWidgetRenderer'))` to lazyMap
- scada-widget.types.ts: add `| 'fuxaWidget'` to ScadaWidgetType union
- scada-widget-sizes.ts: add fuxaWidget size definition

SECURITY RULES:
- No allow-same-origin in sandbox
- No eval() or new Function() in bridge code
- CSP meta tag in srcdoc
- File size validated before srcdoc construction (500KB limit)

PERFORMANCE RULES:
- IntersectionObserver for viewport culling with 200px root margin
- srcdoc memoized with useMemo, keyed on svgContent hash
- Tag value updates via postMessage, never srcdoc regeneration
- Bridge uses requestAnimationFrame batching for outbound putValue

TEST: Verify iframe sandbox attribute, srcdoc CSP, tag subscription lifecycle
```

### Agent Prompt 5: FuxaWidgetConfig (Phase 10B)

```
ROLE: Senior React Engineer -- FUXA Auto-Generated Config Panel

CONTEXT:
You are implementing `FuxaWidgetConfig.tsx` for the Suderra SCADA Builder. This is a dynamic
config panel that auto-generates from the parsed export variables of any FUXA widget. Unlike
other widget configs in the codebase (GaugeConfig, SliderConfig, etc.) which are hand-crafted
per widget type, this single component serves ALL 1,450+ FUXA widgets.

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/widget-configs/FuxaWidgetConfig.tsx

EXISTING PATTERNS TO FOLLOW:
- Read widget-configs/index.ts for the WidgetConfigProps interface (config, onChange, deviceId)
- Read any existing config (e.g., GaugeConfig.tsx) for the UI pattern: labels, inputs, sections
- Read FuxaExportParser.ts for the FuxaExportVariable interface

REQUIREMENTS:
1. Export a named `FuxaWidgetConfig` React.FC that matches WidgetConfigProps interface.
2. Parse export variables from config.svgContent using parseFuxaExports.
3. Group variables by FuxaExportGroup: stateColor, appearance, transform, custom.
4. Render collapsible sections for each non-empty group:
   Section "Widget Info": Read-only display of fuxaWidgetName, fuxaCategory
   Section "Data Binding": Tag selector + state mapping rule editor
   Section "State Colors": 6 color pickers for _pc_state0 through _pc_state5
   Section "Appearance": Controls for shade, padding, aspect ratio
   Section "Transform": Controls for rotation, offset, flip
   Section "Custom Properties": Dynamic controls for all remaining export variables
5. State Mapping Rule Editor:
   - "Add Rule" button creates a new rule row
   - Each row: condition dropdown (lt/lte/eq/gte/gt/between/notEqual), value input(s), state dropdown (0-5 with color preview)
   - "Remove" button on each row
   - Fallback state dropdown at the bottom
   - Rules stored in config.stateMapping as FuxaStateMapping
6. Variable controls: number->input[type=number], string->input[type=text], boolean->checkbox, color->input[type=color]
7. All control changes call onChange({ [varName]: newValue })

STYLE:
- Use the same Tailwind classes as existing config panels (text-xs, border-gray-200, etc.)
- Collapsible sections with ChevronDown/ChevronRight icons (same as WidgetPalette)
- Compact layout suitable for the 240px-wide properties sidebar

INTEGRATION:
After implementing, modify widget-configs/index.ts:
- Import FuxaWidgetConfig
- Add `fuxaWidget: FuxaWidgetConfig` to widgetConfigMap

ARCHITECTURE RULES:
- ZERO use of `any` type (the existing WidgetConfigProps uses `any` with eslint-disable -- follow the same pattern for the interface but use proper types internally)
- File must be under 400 lines
- Use useMemo for parsed export variables to avoid re-parsing on every render
```

### Agent Prompt 6: FuxaWidgetBrowser (Phase 10C)

```
ROLE: Senior React Engineer -- FUXA Widget Catalog Browser UI

CONTEXT:
You are implementing `FuxaWidgetBrowser.tsx` for the Suderra SCADA Builder. This is a modal
dialog that lets users browse, search, preview, and add FUXA widgets from the 1,450+ widget
catalog to the SCADA canvas.

FILE LOCATION: web/modules/sensor-module/src/components/scada-builder/FuxaWidgetBrowser.tsx

REQUIREMENTS:
1. Modal dialog (full-width, 80vh height) triggered by a "Browse FUXA Widgets" button.
2. LEFT SIDEBAR (200px):
   - Category tree with collapsible nodes
   - Each node shows category name and widget count
   - Clicking a category filters the grid
   - "Recently Used" section at bottom (last 10, from localStorage, tenant-scoped)
   - "Favorites" section with star toggle (localStorage, tenant-scoped)
3. MAIN AREA:
   - Search bar at top with fuzzy matching (200ms debounce)
   - Tier filter dropdown: All / Tier 1 (Standard) / Tier 2 (Advanced)
   - Virtualized grid of widget thumbnails (96x96 with name below)
   - Click thumbnail: show preview panel
   - Drag thumbnail: initiate drag with application/reactflow-widget data
4. PREVIEW PANEL (when widget selected):
   - Larger preview (256x256)
   - Widget name, category, subcategory
   - State count, has output, file size, tier
   - Export variable count and list
   - "Add to Canvas" button
   - "Add to Favorites" star button
5. DRAG DATA format (must match existing drop handler in ScadaPackageBuilderPage):
   { widgetType: 'fuxaWidget', label: widgetName, defaultWidth, defaultHeight, defaultConfig: {...} }
6. Catalog data loaded from static import of catalog.json.

PERFORMANCE:
- Virtualized grid: only render visible thumbnail cells
- Lazy image loading for thumbnails
- Search debounced to 200ms
- Preload first 50 thumbnails when modal opens

STYLE:
- Tailwind CSS classes consistent with existing SCADA builder UI
- Modal overlay with backdrop blur
- Clean, professional industrial design aesthetic
- Close button (X) in top-right corner
- ESC key closes modal

TENANT SCOPING:
- localStorage keys: `scada-fuxa-recent-${tenantId}`, `scada-fuxa-favorites-${tenantId}`
- Use getTenantId() from auth context or pass as prop

INTEGRATION:
After implementing, modify WidgetPalette.tsx:
- Add "FUXA Library" category at the bottom
- Add a button that opens the FuxaWidgetBrowser modal
- Import FuxaWidgetBrowser and render it conditionally based on open state
```

### Agent Prompt 7: Catalog Generation Script (Phase 10E)

```
ROLE: Senior Node.js Engineer -- FUXA Widget Catalog Generator

CONTEXT:
You are implementing `generate-fuxa-catalog.ts`, a build-time Node.js script that processes
the FUXA-SVG-Widgets repository and generates:
1. A catalog.json manifest with metadata for all widgets
2. A directory of SVG files organized by category
3. Base64 thumbnail previews for each widget

FILE LOCATION: web/modules/sensor-module/scripts/generate-fuxa-catalog.ts

REQUIREMENTS:
1. Accept the FUXA-SVG-Widgets repo path as a CLI argument.
2. Recursively discover all .svg files.
3. For each SVG:
   a. Read content and compute file size
   b. Skip files > 500KB with warning
   c. Parse export variables using the same parseFuxaExports logic
   d. Count visual states (regex for class="...state\d...")
   e. Detect postValue capability (string search)
   f. Derive category/subcategory from directory structure
   g. Generate a unique widget ID from path components
   h. Generate a 128x128 PNG thumbnail as base64 data URI
   i. Extract search tags from filename, path, and export variables
   j. Classify tier: 1 (standard) or 2 (advanced -- has postValue or setInterval)
4. Build category tree with widget counts.
5. Output catalog.json to src/assets/fuxa-widgets/catalog.json.
6. Copy SVG files to src/assets/fuxa-widgets/svgs/ preserving directory structure.
7. Print summary: total widgets, categories, skipped files, generation time.

THUMBNAIL GENERATION:
- Use `sharp` npm package with SVG input buffer
- Render to 128x128 PNG, then convert to base64 data URI
- If sharp fails for a specific SVG, use a generic placeholder thumbnail
- Fallback: `data:image/png;base64,iVBOR...` (a gray square with "?" text)

HELPER FUNCTIONS:
- slugify(s: string): string -- lowercase, replace spaces/special chars with hyphens
- formatCategoryName(dir: string): string -- capitalize, replace hyphens with spaces
- formatWidgetName(filename: string): string -- remove extension, title case, expand abbreviations

SCRIPT INVOCATION:
npx ts-node scripts/generate-fuxa-catalog.ts /path/to/FUXA-SVG-Widgets

OUTPUT:
- src/assets/fuxa-widgets/catalog.json (JSON, ~2-5MB)
- src/assets/fuxa-widgets/svgs/**/*.svg (1,450+ files)
- Console: "Generated catalog: 1,450 widgets in 12 categories (took 45s)"

ERROR HANDLING:
- Individual SVG parse failure: warn and skip, do not abort
- Missing repo path: print usage and exit 1
- Write permission issues: fail fast with clear error
```

### Agent Prompt 8: Integration & Type Registration (Cross-Cutting)

```
ROLE: Senior TypeScript Engineer -- FUXA Widget Type Registration

CONTEXT:
You are responsible for the cross-cutting type and registration changes needed to integrate
the FUXA widget system into the existing Suderra SCADA builder. This involves modifying
4 existing files to register the new `fuxaWidget` type.

EXISTING FILES TO MODIFY:
1. web/modules/sensor-module/src/types/scada-widget.types.ts
2. web/modules/sensor-module/src/constants/scada-widget-sizes.ts
3. web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx
4. web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts
5. web/modules/sensor-module/src/components/scada-builder/WidgetPalette.tsx

CHANGES:

1. scada-widget.types.ts:
   - Add `| 'fuxaWidget'` to the ScadaWidgetType union (after 'dropdownSelect')

2. scada-widget-sizes.ts:
   - Add to WIDGET_SIZES:
     fuxaWidget: { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 12, maxH: 12 }
   - Comment: "// FUXA SVG widget (sandboxed iframe, flexible sizing)"

3. WidgetRenderer.tsx:
   - Add to lazyMap:
     fuxaWidget: React.lazy(() => import('./widget-renderers/FuxaWidgetRenderer'))

4. widget-configs/index.ts:
   - Import: import { FuxaWidgetConfig } from './FuxaWidgetConfig';
   - Add to widgetConfigMap: fuxaWidget: FuxaWidgetConfig

5. WidgetPalette.tsx:
   - Add new category to WIDGET_CATEGORIES array (before the closing bracket):
     {
       name: 'FUXA Library',
       widgets: [
         { type: 'fuxaWidget' as ScadaWidgetType, label: 'Browse 1,450+ Widgets...', icon: <Shapes className="w-4 h-4" /> },
       ],
     }
   Note: Clicking this palette entry should open the FuxaWidgetBrowser modal.
   This requires adding state to WidgetPalette and rendering the FuxaWidgetBrowser component.

VERIFICATION:
After changes, run:
- npm run build (must compile without errors)
- npm run lint (must pass)
- Verify that dragging a fuxaWidget from the palette creates a node on the canvas
- Verify that selecting a fuxaWidget node shows the FuxaWidgetConfig panel

ARCHITECTURE RULES:
- Minimal changes to existing files
- Follow the exact patterns already established
- No `any` types in new code
- Import paths must match the existing import conventions in each file
```

---

## Appendix A: FUXA Widget Interactivity Matrix

| Interaction Type | FUXA Internal | Suderra Container | Bridge Required |
|-----------------|--------------|-------------------|-----------------|
| State switching (0-5) | Widget JS | -- | putValue('_pn_setState', N) |
| Color transitions | Widget CSS/JS | -- | putValue('_pc_stateN', '#hex') |
| Blinking animation | Widget CSS | Also possible via AnimationEngine | Both work independently |
| Rotation animation | -- | CSS transform via AnimationEngine | No |
| Hide/Show | -- | CSS opacity via AnimationEngine | No |
| Fill level animation | -- | CSS via AnimationEngine | No |
| Knob/dial output | Widget JS emits postValue | -- | postValue -> onCommand('writeTag') |
| Button press output | Widget JS emits postValue | -- | postValue -> onCommand('writeTag') |
| Slider output | Widget JS emits postValue | -- | postValue -> onCommand('writeTag') |
| Mouse click event | -- | Container onClick via WidgetEventBus | No |
| Drag/resize | -- | ScadaWidgetNode handles | No |
| Tooltip on hover | -- | WidgetTooltip component | No |
| Theme color cascade | -- | Future: CSS variables in srcdoc | Not in Phase 10 |

## Appendix B: Migration Path for Existing customSvg Widgets

Users who have already imported FUXA SVGs as `customSvg` widgets lose the interactivity (no state switching, no putValue, no export variable config). A future migration tool could:

1. Detect `customSvg` widgets whose SVG content matches a FUXA catalog entry (by hash comparison).
2. Offer to convert them to `fuxaWidget` with full interactivity.
3. Preserve the user's position, size, and any configured tag bindings.

This migration is NOT in scope for Phase 10 but is documented here for future planning.

## Appendix C: Deduplication Strategy for Large Deployments

For deployments where many screens use the same FUXA widgets, storing the full SVG content in every widget config leads to significant JSON bloat. A deduplication strategy:

1. Store SVG content in a separate `fuxaAssets` map at the package level: `{ [catalogId]: svgContent }`.
2. Widget config references the catalog ID: `{ fuxaWidgetId: 'electrical.motor.three-phase', svgContent: null }`.
3. At load time, resolve `svgContent` from the package-level asset map.
4. Saves ~80% space when the same widget is used more than 3 times.

This optimization is NOT in scope for Phase 10 but is documented for Phase 11 consideration.
