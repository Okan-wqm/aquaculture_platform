# SCADA Builder Enterprise Implementation Plan

**Date**: 2026-03-25
**Status**: Draft
**Reference**: [SCADA-FUXA-GAP-ANALYSIS.md](./SCADA-FUXA-GAP-ANALYSIS.md)
**Target**: Close all critical and high-priority gaps identified against FUXA

---

## Table of Contents

0. [Phase 0: Critical Bug Fixes & Security Hardening](#phase-0-critical-bug-fixes--security-hardening)
1. [Executive Summary](#executive-summary)
2. [Architectural Principles](#architectural-principles)
3. [Phase 1: SVG Editor Foundation](#phase-1-svg-editor-foundation)
4. [Phase 2: Layer Management & Z-Order](#phase-2-layer-management--z-order)
5. [Phase 3: Advanced Animations](#phase-3-advanced-animations)
6. [Phase 4: Expression Engine & Computed Tags](#phase-4-expression-engine--computed-tags)
7. [Phase 5: Client-Side Scripting (Sandboxed)](#phase-5-client-side-scripting-sandboxed)
8. [Phase 6: Gradient & Advanced SVG Features](#phase-6-gradient--advanced-svg-features)
9. [Cross-Cutting Concerns](#cross-cutting-concerns)
10. [Dependency Graph](#dependency-graph)
11. [Risk Register](#risk-register)
12. [Total Estimates](#total-estimates)

---

## Executive Summary

This plan closes every critical and high-priority gap between the Suderra SCADA Builder and FUXA while preserving Suderra's existing advantages (59 ISA equipment symbols, 3 edge types, simulation mode, scene hierarchy, theme system, tenant isolation). The plan is organized in seven phases (Phase 0-6) with clear dependency chains. **Phase 0 addresses 20 bugs found during code audit and MUST be completed before any feature work.**

---

## Phase 0: Critical Bug Fixes & Security Hardening

**Duration**: 1 week | **Files**: 12 modified | **Priority**: BLOCKER

> Full audit report: [SCADA-BUG-AUDIT-2026-03-25.md](./SCADA-BUG-AUDIT-2026-03-25.md)

### 0.1 — SVG XSS Elimination (CRITICAL)
- **Files**: `CustomSvgRenderer.tsx`, `CustomSvgConfig.tsx`
- **Action**: Replace regex sanitization with DOMPurify
- **Config**: `{ USE_PROFILES: { svg: true }, FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object'], FORBID_ATTR: ['xlink:href'] }`
- **Add**: File size limit (500KB) at upload time in CustomSvgConfig
- **Add**: Validate SVG root element at upload
- **Dep**: `npm install dompurify @types/dompurify`
- **Test**: XSS vectors: `<script>`, unquoted handlers, `<foreignObject>`, `<use href="data:">`, oversized files

### 0.2 — Fix Conditional Hooks in ScadaWidgetNode (CRITICAL)
- **File**: `nodes/ScadaWidgetNode.tsx:155-163`
- **Action**: Replace `useScadaRuntime()` (throws) with `useContext(ScadaRuntimeContext)` (returns null)
- **Action**: Always call `useAnimationState` and `useWidgetEvents` — pass empty rules/events when no runtime
- **Test**: Mount ScadaWidgetNode with and without ScadaRuntime provider, verify no hook violations

### 0.3 — Security Hardening (HIGH)
- **Remove `runScript`/`openUrl`** from `EventAction` type in `engine/events/types.ts` until Phase 5
- **Validate video URLs**: Only allow `http:`/`https:` in `VideoStreamRenderer.tsx`
- **Tenant-scope localStorage**: Change `'scada-theme-mode'` → `` `scada-theme-mode-${getTenantId()}` `` in `ThemeProvider.tsx`
- **Background image size limit**: Add 5MB check in `CanvasSettings.tsx`
- **Test**: URL injection vectors, cross-tenant localStorage isolation

### 0.4 — Performance Fixes (HIGH)
- **Move `<style>` injection** from per-widget (ScadaWidgetNode:437) to canvas-level (AnimationStyles.ts pattern)
- **Fix AnimationStyles cleanup**: Replace module-level `injected` boolean with `document.getElementById()` check
- **Fix useTagValues N+1**: Batch updates via `unstable_batchedUpdates` or wildcard subscription
- **Split Zustand selector**: Separate rapidly-changing sim state from stable UI state in ScadaPackageBuilderPage
- **Test**: Render 100 widgets, measure re-render count and FPS

### 0.5 — Bug Fixes (MEDIUM)
- **WidgetErrorBoundary**: Add retry button, reset error on prop change
- **TrendChart sim buffer**: Fix stale ref read — convert to useState
- **Direct setState**: Add `markClean()` action to store
- **`as any` casts**: Add proper type declarations for bringToFront, sendToBack, groupWidgets, toggleWidgetLock, saveAsTemplate
- **Scheduler overnight**: Handle `endHour < startHour` (split into two blocks)
- **VideoStream fullscreen**: Listen to `fullscreenchange` event
- **TagValueBus cleanup**: Call `clear()` on ScadaRuntime unmount
- **Test**: Each fix gets a dedicated test case

### Phase 0 Acceptance Criteria
- [ ] Zero XSS vectors pass through SVG sanitization (DOMPurify + test suite)
- [ ] No React hook violations in any render path
- [ ] All localStorage keys tenant-scoped
- [ ] All file uploads size-limited
- [ ] All URL inputs protocol-validated
- [ ] 100-widget canvas renders at 60fps
- [ ] All `as any` casts eliminated from SCADA builder
- [ ] WidgetErrorBoundary recoverable

**Scale targets:**
- 100+ widgets per screen rendered at 60 fps
- 50+ screens per SCADA package
- 1,000+ concurrent tenants with full data isolation
- Expression engine evaluating 500+ computed tags per second per screen
- Scripting sandbox executing per-widget scripts without main-thread jank

---

## Architectural Principles

All six phases follow these non-negotiable rules:

1. **Typed Interfaces First** -- Every new feature starts with a TypeScript interface in the canonical type files before any implementation.
2. **Lazy Loading** -- Every new renderer is added to the existing `lazyMap` in `WidgetRenderer.tsx` as a `React.lazy()` entry. No eager imports for widget renderers.
3. **Zustand Slice Pattern** -- New state belongs in dedicated slices under `store/scada/`, following the existing `StateCreator<ScadaStore>` pattern with immer middleware.
4. **Config/Renderer/Config-Panel Triple** -- Each new widget type follows the established triple: (a) size entry in `scada-widget-sizes.ts`, (b) lazy renderer in `WidgetRenderer.tsx`, (c) config panel registered in `widget-configs/index.ts`.
5. **Animation Engine Extension** -- New animation types extend `AnimationRuleType` union and the `evaluate()` function in `AnimationEngine.ts`, adding to `AnimationState` and `AnimationOptions` interfaces.
6. **Backward Compatibility** -- Existing SCADA package JSON must load without migration. New fields use optional properties with sensible defaults. A `version` field in `PackageMeta` drives progressive enhancement.
7. **Tenant Isolation** -- All persistent data (expressions, scripts, gradients) is scoped to the tenant schema. No cross-tenant data leakage is permitted.
8. **XSS Prevention** -- All user-provided SVG, HTML, and script content goes through DOMPurify sanitization. No raw `dangerouslySetInnerHTML` without sanitization.

---

## Phase 1: SVG Editor Foundation

**Goal**: Add SVG transform system, property panel depth, arrow markers, ellipse widget, path/polyline widget, and raster image widget.

**Duration estimate**: 3 weeks
**Priority**: CRITICAL + HIGH items from gap analysis

### 1.1 Architectural Design

#### 1.1.1 SVG Transform System

A universal transform model applied to ALL widgets (not just SVG shapes). The transform is stored in `ScreenWidget.config` under a `transform` key.

```typescript
// In types/scada-transform.types.ts
export interface SvgTransform {
  /** Rotation in degrees (0-360) */
  rotation: number;
  /** Scale X multiplier (0.1 - 10) */
  scaleX: number;
  /** Scale Y multiplier (0.1 - 10) */
  scaleY: number;
  /** Skew X in degrees (-89 to 89) */
  skewX: number;
  /** Skew Y in degrees (-89 to 89) */
  skewY: number;
  /** Transform origin X (0-1 ratio) */
  originX: number;
  /** Transform origin Y (0-1 ratio) */
  originY: number;
}

export const DEFAULT_SVG_TRANSFORM: SvgTransform = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  skewX: 0,
  skewY: 0,
  originX: 0.5,
  originY: 0.5,
};
```

The transform is applied in `ScadaWidgetNode.tsx` as a CSS `transform` property on the container div, computed from the `config.transform` field. This ensures ALL widget types benefit from transforms without modifying individual renderers.

```typescript
// Applied in ScadaWidgetNode.tsx containerStyle computation
function buildTransformCSS(t: SvgTransform): string {
  const parts: string[] = [];
  if (t.rotation !== 0) parts.push(`rotate(${t.rotation}deg)`);
  if (t.scaleX !== 1 || t.scaleY !== 1) parts.push(`scale(${t.scaleX}, ${t.scaleY})`);
  if (t.skewX !== 0) parts.push(`skewX(${t.skewX}deg)`);
  if (t.skewY !== 0) parts.push(`skewY(${t.skewY}deg)`);
  return parts.join(' ');
}
```

#### 1.1.2 SVG Property Panel Expansion

Extend the existing `SvgShapeConfig.tsx` pattern with a shared `SvgPropertyPanel` component that renders conditionally based on widget type. Properties to add:

- **Stroke dash patterns**: Pre-defined enum (`solid`, `dotted`, `dashed`, `dashDot`, `dashDotDot`) mapped to SVG `stroke-dasharray` values.
- **Line cap**: `butt | round | square` -- mapped to SVG `stroke-linecap`.
- **Line join**: `miter | round | bevel` -- mapped to SVG `stroke-linejoin`.
- **Per-color opacity**: Separate `fillOpacity` and `strokeOpacity` fields (0-1) alongside the existing `opacity` field.

```typescript
// In types/scada-svg-properties.types.ts
export type StrokeDashPattern = 'solid' | 'dotted' | 'dashed' | 'dashDot' | 'dashDotDot';
export type StrokeLineCap = 'butt' | 'round' | 'square';
export type StrokeLineJoin = 'miter' | 'round' | 'bevel';

export const DASH_PATTERN_MAP: Record<StrokeDashPattern, string> = {
  solid: '',
  dotted: '2 4',
  dashed: '8 4',
  dashDot: '8 4 2 4',
  dashDotDot: '8 4 2 4 2 4',
};
```

#### 1.1.3 Arrow Markers System

SVG `<marker>` definitions scoped per-screen to avoid cross-screen ID collisions. Markers are defined in a shared `<defs>` block injected into the ReactFlow SVG layer.

```typescript
// In types/scada-marker.types.ts
export type MarkerShape = 'arrow' | 'circle' | 'diamond' | 'square';
export type MarkerPosition = 'start' | 'mid' | 'end';

export interface MarkerConfig {
  shape: MarkerShape;
  size: number;       // 4-20
  fill: string;
  outline: boolean;
}

export interface EdgeMarkers {
  start?: MarkerConfig;
  mid?: MarkerConfig;
  end?: MarkerConfig;
}
```

Marker definitions are rendered once per screen in a `<SvgMarkerDefs>` component mounted inside the ReactFlow `<svg>` element via ReactFlow's `<SVGRenderer>` slot.

#### 1.1.4 Ellipse Widget

New widget type `svgEllipse` following the exact pattern of `svgRect` and `svgCircle`.

```typescript
// Addition to ScadaWidgetType union
| 'svgEllipse'
```

Config properties: `fill`, `stroke`, `strokeWidth`, `fillOpacity`, `strokeOpacity`, `dashPattern`, `lineCap`, `label`.

#### 1.1.5 Path/Polyline Widget

New widget type `svgPath` for interactive bezier and polyline editing.

```typescript
// In types/scada-path.types.ts
export type PathPointType = 'line' | 'cubic' | 'quadratic';

export interface PathPoint {
  x: number;
  y: number;
  type: PathPointType;
  /** Control point 1 (for cubic/quadratic) -- relative to this point */
  cp1?: { x: number; y: number };
  /** Control point 2 (for cubic only) -- relative to next point */
  cp2?: { x: number; y: number };
}

export interface PathConfig {
  points: PathPoint[];
  closed: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  dashPattern: StrokeDashPattern;
}
```

The path editor renders overlay handles on each point and control point when the widget is selected in edit mode. Mouse drag on handles updates the `points` array through the store's `updateWidgetConfig` action.

#### 1.1.6 Raster Image Widget

New widget type `rasterImage` for PNG/JPG import as a first-class widget (not background).

```typescript
// Addition to ScadaWidgetType union
| 'rasterImage'
```

Config: `imageData` (data URL or remote URL), `objectFit` (`contain | cover | fill | none`), `alt` (accessibility text), `borderRadius`, `opacity`.

Image data is stored in the SCADA package JSON. For production, images larger than 100KB trigger a warning suggesting upload to the tenant's asset storage (S3/MinIO) with a URL reference instead of inline data URL.

### 1.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `types/scada-transform.types.ts` | SvgTransform interface and defaults |
| `types/scada-svg-properties.types.ts` | StrokeDashPattern, LineCap, LineJoin types and maps |
| `types/scada-marker.types.ts` | MarkerConfig, MarkerShape, EdgeMarkers |
| `types/scada-path.types.ts` | PathPoint, PathConfig for path/polyline |
| `components/scada-builder/widget-configs/SvgEllipseConfig.tsx` | Ellipse config panel |
| `components/scada-builder/widget-configs/SvgPathConfig.tsx` | Path/Polyline config panel with point editor |
| `components/scada-builder/widget-configs/RasterImageConfig.tsx` | Raster image config panel |
| `components/scada-builder/widget-configs/TransformConfig.tsx` | Shared transform panel (rotation, scale, skew) |
| `components/scada-builder/widget-configs/StrokeConfig.tsx` | Shared stroke panel (dash, cap, join, width, color, opacity) |
| `components/scada-builder/widget-renderers/SvgEllipseRenderer.tsx` | Ellipse renderer |
| `components/scada-builder/widget-renderers/SvgPathRenderer.tsx` | Path/Polyline renderer |
| `components/scada-builder/widget-renderers/RasterImageRenderer.tsx` | Raster image renderer |
| `components/scada-builder/SvgMarkerDefs.tsx` | SVG marker definitions component |
| `components/scada-builder/path-editor/PathOverlay.tsx` | Interactive path point editor overlay |
| `components/scada-builder/path-editor/ControlPointHandle.tsx` | Draggable control point handle |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-widget.types.ts` | Add `svgEllipse`, `svgPath`, `rasterImage` to `ScadaWidgetType` |
| `constants/scada-widget-sizes.ts` | Add size definitions for 3 new widget types |
| `components/scada-builder/WidgetRenderer.tsx` | Add 3 new lazy entries to `lazyMap` |
| `components/scada-builder/widget-configs/index.ts` | Register 3 new config components |
| `components/scada-builder/widget-configs/SvgShapeConfig.tsx` | Add StrokeConfig and TransformConfig to all 4 SVG shape configs |
| `components/scada-builder/nodes/ScadaWidgetNode.tsx` | Apply `config.transform` as CSS transform on container |
| `components/scada-builder/WidgetPalette.tsx` | Add 3 new widgets to palette under "Shapes" and "Media" categories |
| `components/scada-builder/PropertiesPanel.tsx` | Conditionally render TransformConfig for all widget types |

### 1.3 Component Design

#### TransformConfig

```typescript
interface TransformConfigProps {
  transform: SvgTransform;
  onChange: (updates: Partial<SvgTransform>) => void;
}
```

Renders: rotation dial (0-360 with 15-degree snap), scaleX/scaleY sliders (0.1-10, linked by default with aspect-lock toggle), skewX/skewY sliders (-89 to 89), origin picker (9-point grid: TL/TC/TR/ML/MC/MR/BL/BC/BR).

#### StrokeConfig

```typescript
interface StrokeConfigProps {
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  dashPattern: StrokeDashPattern;
  lineCap: StrokeLineCap;
  lineJoin: StrokeLineJoin;
  onChange: (updates: Record<string, unknown>) => void;
}
```

Renders: color picker, width input, opacity slider, dash pattern dropdown (with visual preview of each pattern), line cap radio group (with SVG previews), line join radio group (with SVG previews).

#### PathOverlay

```typescript
interface PathOverlayProps {
  points: PathPoint[];
  closed: boolean;
  widgetBounds: { x: number; y: number; width: number; height: number };
  onPointMove: (index: number, x: number, y: number) => void;
  onControlPointMove: (index: number, cp: 'cp1' | 'cp2', x: number, y: number) => void;
  onPointAdd: (afterIndex: number, point: PathPoint) => void;
  onPointDelete: (index: number) => void;
  onPointTypeChange: (index: number, type: PathPointType) => void;
}
```

Renders as an absolutely positioned SVG overlay on top of the selected path widget. Points are draggable circles (8px radius). Control points are smaller circles (5px) connected to their anchor point by a thin dashed line. Double-click on a segment midpoint inserts a new point. Right-click on a point opens a context menu (delete, change type).

### 1.4 State Management

**No new Zustand slices needed.** Transform and SVG properties are stored in each widget's `config` record, which is already managed by `widgetSlice.updateWidgetConfig()`.

The `PropertiesPanel` must be extended to detect the selected widget type and conditionally render `TransformConfig` for all types, and `StrokeConfig` for SVG shape types.

### 1.5 Performance Strategy

- **Transform computation**: `buildTransformCSS()` is memoized per widget via `useMemo` keyed on `config.transform`.
- **Path rendering**: SVG `<path>` element uses the `d` attribute string computed once per `points` array change. Point count is bounded to 200 per widget.
- **Raster images**: Images are rendered as `<img>` with `loading="lazy"` and `decoding="async"`. Data URLs larger than 500KB are converted to `Blob` URLs on mount to reduce JSON parse overhead.
- **Marker defs**: `<SvgMarkerDefs>` renders once per screen with a stable `useMemo` keyed on the screen's edge marker configurations.

### 1.6 Security Considerations

- **SVG sanitization**: The existing `CustomSvgRenderer` regex-based sanitization is insufficient. All user SVG content (custom SVG, raster image SVG fallback) must go through **DOMPurify** with `ALLOW_DATA_ATTR: false` and `ADD_TAGS: []` (no script, no foreignObject).
- **Raster image validation**: Validate MIME type on upload (`image/png`, `image/jpeg`, `image/gif`, `image/webp`). Reject SVG-disguised-as-image.
- **Path point injection**: All `PathPoint` coordinate values are clamped to the widget bounds (0 to width/height). NaN/Infinity values are rejected at the config update boundary.
- **Transform bounds**: Rotation clamped to [0, 360], scale to [0.1, 10], skew to [-89, 89]. These bounds are enforced in `TransformConfig.onChange` and validated in the store.

### 1.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/types/scada-transform.test.ts` | DEFAULT_SVG_TRANSFORM values, buildTransformCSS edge cases |
| `__tests__/types/scada-svg-properties.test.ts` | DASH_PATTERN_MAP completeness, all enum values mapped |
| `__tests__/components/TransformConfig.test.tsx` | Rotation input, scale slider, skew slider, origin picker |
| `__tests__/components/StrokeConfig.test.tsx` | Dash pattern selection, cap/join selection, color change |
| `__tests__/components/SvgEllipseRenderer.test.tsx` | Renders ellipse with config, animation state, visibility |
| `__tests__/components/SvgPathRenderer.test.tsx` | Renders path d-attribute, closed/open, stroke properties |
| `__tests__/components/RasterImageRenderer.test.tsx` | Renders image, objectFit variants, accessibility alt text |
| `__tests__/components/PathOverlay.test.tsx` | Point drag, control point drag, add/delete point, type change |
| `__tests__/components/SvgMarkerDefs.test.tsx` | Arrow/circle/diamond marker shapes, unique IDs per screen |
| `__tests__/integration/transform-persistence.test.ts` | Transform survives save/load cycle (package JSON roundtrip) |

**Test location**: `web/modules/sensor-module/src/__tests__/`

### 1.8 Dependencies

| Package | Version | Reason |
|---------|---------|--------|
| `dompurify` | `^3.x` | SVG/HTML sanitization (replaces regex approach) |
| `@types/dompurify` | `^3.x` | TypeScript types |

No other new dependencies. All SVG rendering uses native browser SVG (no svg.js, no d3).

### 1.9 Migration Strategy

- `config.transform` is optional. Widgets without it default to `DEFAULT_SVG_TRANSFORM` (identity transform).
- `config.dashPattern` defaults to `'solid'` when absent.
- `config.lineCap` defaults to `'butt'`, `config.lineJoin` defaults to `'miter'`.
- `config.fillOpacity` and `config.strokeOpacity` default to `1` when absent.
- Existing `svgLine` widgets with `dashArray` string continue to work -- the renderer checks for both `dashPattern` (enum) and `dashArray` (legacy freetext), preferring `dashPattern` when present.
- Existing SCADA package JSON (version 1) loads unchanged. New features write `version: 2` in meta.

### 1.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 15 |
| Modified files | 8 |
| Total new lines of code | ~2,400 |
| Test lines of code | ~1,200 |

---

## Phase 2: Layer Management & Z-Order

**Goal**: Add a layers panel with element tree, drag reorder, visibility toggle, lock, 4-level z-order control, and element hover highlight.

**Duration estimate**: 2 weeks
**Dependencies**: None (can run in parallel with Phase 1)

### 2.1 Architectural Design

#### 2.1.1 Z-Index Model

Currently, all widgets share a static `zIndex: 500` in `ScadaWidgetNode.tsx`. This must be replaced with a per-widget z-index stored in `ScreenWidget`.

```typescript
// Addition to ScreenWidget in scada-package.types.ts
export interface ScreenWidget {
  // ... existing fields
  /** Z-order index. Higher = in front. Default = insertion order * 10 (sparse). */
  zIndex?: number;
}
```

Z-indices use sparse numbering (initial widget gets `zIndex = 10`, next gets `20`, etc.) to allow easy insertion between layers without renumbering all widgets.

#### 2.1.2 Layers Panel Data Model

The layers panel reads the current screen's widgets sorted by `zIndex` descending (highest z-index = top of list). Each entry shows:

- Widget type icon (from palette icon map)
- Label or widget type name
- Visibility eye icon (toggle: sets `config._hidden = true` which the renderer checks)
- Lock icon (uses existing `locked` field)
- Drag handle for reorder

Drag reorder updates the `zIndex` values of affected widgets in a single store transaction.

#### 2.1.3 Four-Level Z-Order Commands

```typescript
// In store/scada/layerSlice.ts
interface LayerSlice {
  bringToFront: (widgetId: string) => void;
  sendToBack: (widgetId: string) => void;
  bringForward: (widgetId: string) => void;  // +1 step
  sendBackward: (widgetId: string) => void;  // -1 step
  setWidgetZIndex: (widgetId: string, zIndex: number) => void;
  reorderWidgets: (widgetIds: string[], newZIndices: number[]) => void;
}
```

`bringForward` swaps the widget's z-index with the next-higher widget. `sendBackward` swaps with the next-lower. `bringToFront` sets z-index to max+10. `sendToBack` sets z-index to min-10.

#### 2.1.4 Element Hover Highlight

When hovering over an entry in the layers panel, the corresponding widget on the canvas receives a temporary highlight. This is implemented via a Zustand state field `highlightedWidgetId: string | null` in the selection slice. `ScadaWidgetNode` reads this value and applies a pulsing cyan outline when matched.

### 2.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `store/scada/layerSlice.ts` | Z-order manipulation actions |
| `components/scada-builder/LayersPanel.tsx` | Layers panel component (~300 lines) |
| `components/scada-builder/LayerEntry.tsx` | Single layer entry with controls (~80 lines) |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-package.types.ts` | Add `zIndex?: number` to `ScreenWidget` |
| `store/scada/types.ts` | Add `LayerSlice` interface, `highlightedWidgetId` to selection slice |
| `store/scada/createScadaStore.ts` | Compose `layerSlice` into the store |
| `store/scada/selectionSlice.ts` | Add `setHighlightedWidgetId` action |
| `components/scada-builder/nodes/ScadaWidgetNode.tsx` | Read `zIndex` from store, apply to container style; read `highlightedWidgetId` for highlight |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add LayersPanel to layout (collapsible left panel, below WidgetPalette or as a tab) |
| `components/scada-builder/PropertiesPanel.tsx` | Add z-order quick buttons (4 arrows) |

### 2.3 Component Design

#### LayersPanel

```typescript
interface LayersPanelProps {
  screenId: string;
}
```

Renders a scrollable list of `LayerEntry` components, sorted by z-index descending. Uses `@dnd-kit/core` and `@dnd-kit/sortable` for drag reorder (these are already indirect dependencies via ReactFlow). Falls back to manual drag handlers if `@dnd-kit` is not available.

The panel header contains: "Layers" title, a "Select All" checkbox, a "Collapse All Groups" button.

Grouped widgets (sharing a `groupId`) are shown as a collapsible tree node with child entries indented.

#### LayerEntry

```typescript
interface LayerEntryProps {
  widget: ScreenWidget;
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: (widgetId: string) => void;
  onToggleVisibility: (widgetId: string) => void;
  onToggleLock: (widgetId: string) => void;
  onHover: (widgetId: string | null) => void;
}
```

Renders: drag handle, widget type icon (16px), label text (truncated), eye icon (filled = visible, outline = hidden), lock icon, selected highlight (cyan background).

### 2.4 State Management

New `layerSlice` added to the store composition:

```typescript
// store/scada/layerSlice.ts
export const createLayerSlice: StateCreator<ScadaStore, [['zustand/immer', never]], [], LayerSlice> = (set, get) => ({
  bringToFront: (widgetId) => set((state) => {
    const screen = state.screens.find(s => s.id === state.activeScreenId);
    if (!screen) return;
    const maxZ = Math.max(...screen.widgets.map(w => w.zIndex ?? 0));
    const widget = screen.widgets.find(w => w.id === widgetId);
    if (widget) widget.zIndex = maxZ + 10;
  }),
  // ... other actions follow same pattern
});
```

Existing `selectionSlice` gains:

```typescript
highlightedWidgetId: null as string | null,
setHighlightedWidgetId: (id: string | null) => set({ highlightedWidgetId: id }),
```

### 2.5 Performance Strategy

- **LayersPanel** uses `React.memo` and renders only when the active screen's widget list changes (shallow comparison on widget IDs + z-indices).
- **LayerEntry** is memoized per-widget, re-renders only when `zIndex`, `locked`, `config._hidden`, or `isSelected` changes.
- **Highlight** is a single CSS class toggle (`outline: 2px dashed #06b6d4`) with no layout reflow.
- **Drag reorder** collects all z-index updates into a single `immer` draft mutation to avoid N separate re-renders.

### 2.6 Security Considerations

No new security surface. Layer operations are purely client-side state manipulation within the existing tenant-scoped store.

### 2.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/store/layerSlice.test.ts` | bringToFront, sendToBack, bringForward, sendBackward, reorder |
| `__tests__/components/LayersPanel.test.tsx` | Renders widget list sorted by z-index, drag reorder, visibility toggle, lock toggle |
| `__tests__/components/LayerEntry.test.tsx` | Click to select, hover to highlight, visibility icon state, lock icon state |
| `__tests__/integration/z-order-persistence.test.ts` | Z-index survives save/load cycle |
| `__tests__/integration/layer-highlight.test.ts` | Hover in layers panel highlights widget on canvas |

### 2.8 Dependencies

| Package | Version | Reason |
|---------|---------|--------|
| `@dnd-kit/core` | `^6.x` | Drag-and-drop for layer reorder |
| `@dnd-kit/sortable` | `^8.x` | Sortable list for layers |
| `@dnd-kit/utilities` | `^3.x` | CSS transform utilities for dnd-kit |

Note: If ReactFlow already bundles dnd-kit transitively, verify version compatibility before adding.

### 2.9 Migration Strategy

- Widgets without `zIndex` get assigned `zIndex = index * 10` (insertion order) on first load.
- The assignment happens in `loadFromJSON` in the project slice, preserving the existing visual order.
- `config._hidden` defaults to `false`/undefined (visible).

### 2.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 3 |
| Modified files | 7 |
| Total new lines of code | ~1,200 |
| Test lines of code | ~600 |

---

## Phase 3: Advanced Animations

**Goal**: Add value-mapped rotation, piston/down-up oscillation, image-along-path, recursive child SVG color change, animation preview, and basic animation timeline.

**Duration estimate**: 3 weeks
**Dependencies**: Phase 1 (transform system for rotation)

### 3.1 Architectural Design

#### 3.1.1 New Animation Rule Types

Extend the `AnimationRuleType` union:

```typescript
// Updated AnimationRuleType
export type AnimationRuleType =
  | 'colorRange'
  | 'rotate'           // existing: continuous rotation
  | 'blink'
  | 'hide'
  | 'show'
  | 'fillLevel'
  | 'move'
  // NEW:
  | 'valueMappedRotation'  // Rotation angle derived from tag value
  | 'piston'               // Vertical oscillation (down-up)
  | 'imageAlongPath'       // Image moves along an SVG path
  | 'recursiveColor'       // Walk all child SVGs and set fill/stroke
  | 'scale';               // Scale based on tag value
```

#### 3.1.2 Value-Mapped Rotation

Maps a tag value range to an angle range. Unlike the existing `rotate` (continuous spin), this sets a static angle proportional to the tag value.

```typescript
// New AnimationOptions fields
export interface AnimationOptions {
  // ... existing fields

  // valueMappedRotation
  angleMin?: number;        // Minimum angle (degrees), e.g. 0
  angleMax?: number;        // Maximum angle (degrees), e.g. 270
  valueMin?: number;        // Tag value that maps to angleMin
  valueMax?: number;        // Tag value that maps to angleMax
  clampAngle?: boolean;     // Clamp outside min/max or wrap

  // piston
  pistonAmplitude?: number; // Pixels of vertical travel
  pistonSpeed?: number;     // ms per cycle (default 1000)
  pistonDirection?: 'vertical' | 'horizontal';

  // imageAlongPath
  pathData?: string;        // SVG path d-attribute
  pathSpeed?: number;       // ms per full path traversal
  pathImageUrl?: string;    // Image to move along path
  pathImageSize?: number;   // Image size in pixels (square)

  // recursiveColor
  recursiveFill?: string;
  recursiveStroke?: string;

  // scale
  scaleMin?: number;
  scaleMax?: number;
  scaleValueMin?: number;
  scaleValueMax?: number;
}
```

#### 3.1.3 AnimationState Extensions

```typescript
export interface AnimationState {
  // ... existing fields

  // valueMappedRotation
  staticRotation?: number;  // degrees (NOT continuous)

  // piston
  pistonActive: boolean;
  pistonAmplitude: number;
  pistonSpeed: number;
  pistonDirection: 'vertical' | 'horizontal';

  // imageAlongPath
  imageAlongPathActive: boolean;
  pathData?: string;
  pathSpeed: number;
  pathImageUrl?: string;
  pathImageSize: number;

  // recursiveColor
  recursiveFill?: string;
  recursiveStroke?: string;

  // scale
  scaleX?: number;
  scaleY?: number;
}
```

#### 3.1.4 AnimationEngine.evaluate() Extensions

Each new rule type gets a case in the `switch` statement:

- `valueMappedRotation`: Linear interpolation from `[valueMin, valueMax]` to `[angleMin, angleMax]`.
- `piston`: Sets `pistonActive = true` with amplitude and speed.
- `imageAlongPath`: Sets `imageAlongPathActive = true` with path data.
- `recursiveColor`: Sets `recursiveFill` and `recursiveStroke`.
- `scale`: Linear interpolation from `[scaleValueMin, scaleValueMax]` to `[scaleMin, scaleMax]`.

#### 3.1.5 CSS Animation for Piston

A new `@keyframes scada-piston-v` and `scada-piston-h` keyframe is injected in `AnimationStyles.tsx`:

```css
@keyframes scada-piston-v {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(var(--piston-amp)); }
}
@keyframes scada-piston-h {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(var(--piston-amp)); }
}
```

The widget container sets `--piston-amp` as a CSS custom property.

#### 3.1.6 Image-Along-Path

Uses SVG `<animateMotion>` with a `<mpath>` reference to the path data. The animation is rendered as an SVG overlay within the widget renderer. This is a purely declarative SVG animation -- no JavaScript animation loop.

```xml
<svg>
  <path id="motionPath" d="..." fill="none" />
  <image href="..." width="..." height="...">
    <animateMotion dur="..." repeatCount="indefinite">
      <mpath href="#motionPath" />
    </animateMotion>
  </image>
</svg>
```

#### 3.1.7 Recursive Child Color Change

For equipment and customSvg widgets, `recursiveFill` and `recursiveStroke` are passed as props to the renderer. The renderer walks all child SVG elements and applies the color via CSS `--scada-fill` and `--scada-stroke` custom properties, with a global CSS rule:

```css
.scada-recursive-color * {
  fill: var(--scada-fill, inherit) !important;
  stroke: var(--scada-stroke, inherit) !important;
}
```

This avoids manual DOM walking and works reactively.

#### 3.1.8 Animation Preview in Edit Mode

A new toggle button "Preview Animations" in the toolbar (next to "Simulation Mode"). When active, the `AnimationEngine.evaluate()` runs with synthetic tag values derived from each rule's range midpoint. The `ScadaWidgetNode` reads a `previewAnimations` flag from the store.

#### 3.1.9 Animation Timeline (Basic)

Not a full timeline editor (that would be Phase 7+). For Phase 3, provide a simple sequencer that allows ordering animations with delay offsets:

```typescript
export interface AnimationSequence {
  ruleId: string;
  delayMs: number;  // Delay from sequence start
}
```

Stored per-widget in `config.animationSequence`. The evaluate function applies delays as CSS `animation-delay`.

### 3.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `engine/animation/valueMappedRotation.ts` | Linear interpolation for angle mapping |
| `engine/animation/pistonAnimation.ts` | Piston oscillation computation |
| `engine/animation/imageAlongPath.ts` | Path motion data preparation |
| `engine/animation/recursiveColor.ts` | Recursive color utility |
| `components/scada-builder/widget-configs/AnimationRuleEditor.tsx` | Enhanced animation rule editor (extends existing) |
| `components/scada-builder/AnimationPreviewToggle.tsx` | Toolbar toggle for animation preview |
| `components/scada-builder/AnimationSequenceEditor.tsx` | Basic sequence editor UI |

**Modified files:**

| File | Changes |
|------|---------|
| `engine/animation/types.ts` | Extend `AnimationRuleType`, `AnimationOptions`, `AnimationState` |
| `engine/animation/AnimationEngine.ts` | Add 5 new case handlers in `evaluate()` |
| `engine/animation/AnimationStyles.tsx` | Add piston keyframes |
| `components/scada-builder/nodes/ScadaWidgetNode.tsx` | Apply `staticRotation`, `piston`, `recursiveColor`, `scale` from animation state |
| `store/scada/types.ts` | Add `previewAnimations: boolean` to selection slice |

### 3.3 Component Design

#### AnimationRuleEditor

```typescript
interface AnimationRuleEditorProps {
  rule: AnimationRule;
  availableTags: string[];
  onChange: (updates: Partial<AnimationRule>) => void;
  onDelete: () => void;
}
```

Renders different option fields based on `rule.type`. For `valueMappedRotation`: min/max angle inputs, min/max value inputs, a visual angle indicator (SVG arc preview). For `piston`: amplitude slider, speed slider, direction toggle. For `imageAlongPath`: path data textarea, image upload, speed slider, visual preview.

### 3.4 State Management

`previewAnimations` boolean added to the selection slice. When true, `ScadaWidgetNode` calls `evaluate()` with synthetic midpoint values instead of real tag values.

### 3.5 Performance Strategy

- **Value-mapped rotation**: Pure math (linear interpolation), no animation frames. Applied as a static CSS `transform: rotate(Xdeg)` -- GPU-accelerated.
- **Piston**: CSS animation via `@keyframes` -- GPU-accelerated, zero JS per frame.
- **Image-along-path**: SVG `<animateMotion>` -- browser-native, zero JS per frame.
- **Recursive color**: CSS custom properties propagate to children automatically -- no DOM walking, no mutation observers.
- **Animation preview**: Evaluation runs once per rule set change (not per frame). Results are memoized.

### 3.6 Security Considerations

- `pathData` is an SVG `d` attribute string. It must be validated to contain only valid SVG path commands (`M`, `L`, `C`, `Q`, `A`, `Z`, numbers, commas, spaces). Reject any other characters.
- `pathImageUrl` must be validated: only data URLs (image/*) or tenant-scoped asset URLs.
- `recursiveFill` and `recursiveStroke` must be valid CSS color values. Validate with a color regex.

### 3.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/engine/valueMappedRotation.test.ts` | Linear interpolation, clamping, edge cases (min=max, NaN) |
| `__tests__/engine/pistonAnimation.test.ts` | Amplitude, speed, direction computation |
| `__tests__/engine/AnimationEngine.extended.test.ts` | All 5 new rule types in evaluate() |
| `__tests__/components/AnimationRuleEditor.test.tsx` | Renders correct fields per type, validates inputs |
| `__tests__/components/AnimationPreviewToggle.test.tsx` | Toggle state, synthetic values |
| `__tests__/integration/animation-roundtrip.test.ts` | New animation types survive save/load |

### 3.8 Dependencies

No new dependencies. All animations use CSS keyframes and native SVG `<animateMotion>`.

### 3.9 Migration Strategy

- New `AnimationRuleType` values are additive. Old packages with only `colorRange`, `rotate`, `blink`, `hide`, `show`, `fillLevel`, `move` continue to work unchanged.
- `DEFAULT_ANIMATION_STATE` is extended with new fields defaulting to inactive/zero.
- `config.animationSequence` is optional; omission means no sequencing.

### 3.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 7 |
| Modified files | 5 |
| Total new lines of code | ~1,800 |
| Test lines of code | ~900 |

---

## Phase 4: Expression Engine & Computed Tags

**Goal**: Implement a mathematical expression parser, expression editor with tag autocomplete, computed tag evaluation in TagValueBus, expression validation, and tenant-scoped caching.

**Duration estimate**: 3 weeks
**Dependencies**: Phase 1 (for property panel integration)

### 4.1 Architectural Design

#### 4.1.1 Expression Language Specification

A safe, deterministic expression language supporting:

**Operators**: `+`, `-`, `*`, `/`, `%`, `**` (power), `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`, `||`, `!`, `? :` (ternary)

**Functions**: `abs`, `min`, `max`, `round`, `floor`, `ceil`, `sqrt`, `clamp`, `lerp`, `map` (range mapping), `avg`, `sum`

**Tag references**: `$tagName` or `${tag.with.dots}` -- resolved from TagValueBus at evaluation time.

**Constants**: `PI`, `E`, `true`, `false`

**No**: variable assignment, loops, function definitions, string operations, object access, array operations, `eval`, `new`, `import`.

```typescript
// In engine/expressions/types.ts
export interface Expression {
  id: string;
  /** Human-readable name for this computed tag */
  name: string;
  /** Expression source, e.g. "($temperature - 32) * 5 / 9" */
  source: string;
  /** Output tag name -- the computed value is published to TagValueBus under this name */
  outputTag: string;
  /** Input tags extracted from the source (auto-detected) */
  inputTags: string[];
  /** Evaluation interval in ms (0 = on input change, >0 = periodic) */
  intervalMs: number;
  /** Last computed value (cached) */
  lastValue?: number;
  /** Last evaluation error (null if OK) */
  lastError?: string | null;
}

export interface ExpressionContext {
  tags: Record<string, number>;
  constants: Record<string, number>;
}
```

#### 4.1.2 Expression Parser Architecture

A recursive-descent parser that produces an AST (Abstract Syntax Tree). No `eval()`, no `new Function()`. The parser runs in a Web Worker for isolation.

```
Source string --> Tokenizer --> Token[] --> Parser --> AST --> Evaluator --> number
```

```typescript
// AST node types
export type ASTNode =
  | { type: 'number'; value: number }
  | { type: 'tag'; name: string }
  | { type: 'constant'; name: string }
  | { type: 'unary'; op: string; operand: ASTNode }
  | { type: 'binary'; op: string; left: ASTNode; right: ASTNode }
  | { type: 'ternary'; condition: ASTNode; consequent: ASTNode; alternate: ASTNode }
  | { type: 'call'; name: string; args: ASTNode[] };
```

The evaluator is a simple tree walker that resolves tags from the context. No recursion depth greater than 50 (stack overflow protection).

#### 4.1.3 Integration with TagValueBus

A new `ExpressionEvaluator` class subscribes to input tags on the TagValueBus. When any input tag changes, it re-evaluates the expression and publishes the result to the output tag.

```typescript
// In engine/expressions/ExpressionEvaluator.ts
export class ExpressionEvaluator {
  private expressions: Map<string, CompiledExpression>;
  private tagBus: TagValueBus;
  private unsubscribers: Array<() => void>;

  constructor(tagBus: TagValueBus) { ... }

  /** Register an expression. Subscribes to input tags, publishes output. */
  register(expr: Expression): void { ... }

  /** Unregister an expression. Stops listening to input tags. */
  unregister(exprId: string): void { ... }

  /** Evaluate all expressions once (for initialization). */
  evaluateAll(): void { ... }

  /** Destroy: unsubscribe from all tags. */
  destroy(): void { ... }
}
```

#### 4.1.4 Expression Validation

Before registration, expressions go through a validation step:

1. **Syntax check**: Parser returns errors with line/column positions.
2. **Tag existence check**: Warn (not error) if referenced tags are not yet in TagValueBus.
3. **Circular dependency check**: Build a dependency graph of all expressions. Detect cycles and reject.
4. **Evaluation check**: Dry-run with zero values. Catch division by zero, overflow.

```typescript
export interface ExpressionValidationResult {
  valid: boolean;
  errors: ExpressionError[];
  warnings: ExpressionWarning[];
  inputTags: string[];
}

export interface ExpressionError {
  message: string;
  line: number;
  column: number;
  type: 'syntax' | 'circular' | 'runtime';
}
```

### 4.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `engine/expressions/types.ts` | Expression, AST, validation types |
| `engine/expressions/tokenizer.ts` | Tokenizer (source -> tokens) |
| `engine/expressions/parser.ts` | Recursive-descent parser (tokens -> AST) |
| `engine/expressions/evaluator.ts` | AST tree-walker evaluator |
| `engine/expressions/ExpressionEvaluator.ts` | TagValueBus integration class |
| `engine/expressions/validator.ts` | Syntax, circular, runtime validation |
| `engine/expressions/functions.ts` | Built-in function implementations |
| `engine/expressions/constants.ts` | PI, E, true, false constants |
| `engine/expressions/expression.worker.ts` | Web Worker for off-main-thread evaluation |
| `components/scada-builder/ExpressionEditor.tsx` | Expression editor panel with syntax highlighting |
| `components/scada-builder/ExpressionList.tsx` | List of all expressions in a package |
| `components/scada-builder/ExpressionTagAutocomplete.tsx` | Tag autocomplete dropdown |
| `store/scada/expressionSlice.ts` | Expression CRUD actions |

**Modified files:**

| File | Changes |
|------|---------|
| `engine/ScadaRuntime.tsx` | Instantiate ExpressionEvaluator, pass expressions from store |
| `store/scada/types.ts` | Add `ExpressionSlice` and `expressions: Expression[]` to store |
| `store/scada/createScadaStore.ts` | Compose expressionSlice |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add Expressions tab/panel in sidebar |

### 4.3 Component Design

#### ExpressionEditor

```typescript
interface ExpressionEditorProps {
  expression: Expression;
  availableTags: string[];
  onSave: (updates: Partial<Expression>) => void;
  onDelete: () => void;
  onValidate: () => ExpressionValidationResult;
}
```

Features:
- Textarea with syntax highlighting (custom implementation using `<pre><code>` overlay pattern -- no Monaco/CodeMirror dependency for this phase).
- Tag autocomplete: typing `$` triggers a dropdown of available tags (from TagValueBus + other expression outputs).
- Validation indicators: red underline for syntax errors, yellow for warnings.
- Live preview: Shows current computed value next to the editor when in simulation mode.

#### ExpressionList

```typescript
interface ExpressionListProps {
  expressions: Expression[];
  onSelect: (exprId: string) => void;
  onAdd: () => void;
  onDelete: (exprId: string) => void;
}
```

Tabular list with columns: Name, Output Tag, Input Tags (badges), Status (valid/error), Last Value.

### 4.4 State Management

New `expressionSlice`:

```typescript
interface ExpressionSlice {
  expressions: Expression[];
  addExpression: (expr: Omit<Expression, 'id' | 'inputTags'>) => void;
  updateExpression: (id: string, updates: Partial<Expression>) => void;
  removeExpression: (id: string) => void;
}
```

Expressions are serialized in the SCADA package JSON under `meta.expressions`.

### 4.5 Performance Strategy

- **Web Worker evaluation**: Expressions with `intervalMs > 0` evaluate in a Web Worker. The worker receives the tag snapshot and returns computed values.
- **On-change evaluation**: Expressions with `intervalMs === 0` evaluate synchronously on the main thread (they are typically simple). If evaluation takes >5ms, auto-migrate to worker.
- **AST caching**: Parsed ASTs are cached per expression source string. Re-parsing only happens on source change.
- **Dependency graph**: Topological sort of expressions ensures that dependent expressions evaluate in correct order.
- **Batch publish**: Computed values are published to TagValueBus in a single `publishBatch()` call per evaluation cycle.

### 4.6 Security Considerations

- **No eval()**: The expression engine never calls `eval()`, `new Function()`, or `setTimeout` with string arguments.
- **AST depth limit**: Maximum AST depth of 50 nodes. Deeper expressions are rejected as potential DoS.
- **Execution timeout**: Web Worker evaluation has a 100ms timeout per expression. Timed-out expressions are marked as errored.
- **Tag name validation**: Tag names in expressions are validated against `^[a-zA-Z_][a-zA-Z0-9_.]*$`. No special characters.
- **Tenant isolation**: Expressions reference tags by name. Tags are tenant-scoped through the TagValueBus instance (one instance per ScadaRuntime, one runtime per tenant session).
- **Expression count limit**: Maximum 200 expressions per package. Enforced in `addExpression`.

### 4.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/engine/expressions/tokenizer.test.ts` | All token types, edge cases, invalid characters |
| `__tests__/engine/expressions/parser.test.ts` | Operator precedence, function calls, ternary, nested expressions |
| `__tests__/engine/expressions/evaluator.test.ts` | All operators, all functions, tag resolution, error cases |
| `__tests__/engine/expressions/validator.test.ts` | Syntax errors, circular deps, tag existence warnings |
| `__tests__/engine/expressions/ExpressionEvaluator.test.ts` | Register/unregister, tag change triggers, batch publish |
| `__tests__/components/ExpressionEditor.test.tsx` | Syntax highlighting, autocomplete, validation display |
| `__tests__/components/ExpressionList.test.tsx` | Add/delete/select, status display |
| `__tests__/integration/expression-e2e.test.ts` | Full pipeline: define expression -> change input tag -> verify output tag |

### 4.8 Dependencies

No new runtime dependencies. The expression parser is a custom implementation (~400 lines).

Optional for Phase 4.5 enhancement:
- `@codemirror/lang-javascript` for advanced syntax highlighting (deferred to Phase 5 when scripting needs it anyway).

### 4.9 Migration Strategy

- `meta.expressions` is a new optional array. Existing packages without it have zero expressions.
- Expression output tags are synthetic -- they do not exist in the backend sensor service. They exist only in the client-side TagValueBus during runtime.
- If an expression references a tag that does not exist, the expression returns `NaN` and logs a warning (not an error).

### 4.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 13 |
| Modified files | 4 |
| Total new lines of code | ~3,200 |
| Test lines of code | ~1,600 |

---

## Phase 5: Client-Side Scripting (Sandboxed)

**Goal**: Provide sandboxed JavaScript execution for per-widget scripts with a safe API surface (`setTag`, `getTag`, `navigate`, `openCard`, etc.), a script editor with syntax highlighting, and a debug console.

**Duration estimate**: 4 weeks
**Dependencies**: Phase 4 (expression engine provides the tag resolution foundation)

### 5.1 Architectural Design

#### 5.1.1 Sandbox Architecture

Scripts run inside a Web Worker with a `MessagePort` bridge to the main thread. The worker has NO access to `document`, `window`, `localStorage`, `fetch`, or any DOM API. All interaction with the SCADA runtime is mediated through a narrow API surface exposed via `postMessage`.

```
Main Thread                    Web Worker (per script)
-----------                    -----------------------
ScriptBridge  <--postMessage-->  ScriptSandbox
  |                                  |
  |-- tagBus.publish()               |-- $setTag(name, value)
  |-- tagBus.getLatest()             |-- $getTag(name)
  |-- eventBus.dispatch()            |-- $navigate(screenId)
  |-- store.openOverlay()            |-- $openCard(screenId)
  |-- console.log (proxy)            |-- $log(msg)
```

#### 5.1.2 Script API

```typescript
// Injected into worker global scope
interface ScadaScriptAPI {
  /** Read current tag value */
  $getTag(tagName: string): number | string | boolean | null;
  /** Write tag value */
  $setTag(tagName: string, value: number | string | boolean): void;
  /** Navigate to screen */
  $navigate(screenId: string): void;
  /** Open screen as overlay card */
  $openCard(screenId: string, width?: number, height?: number): void;
  /** Open URL in new tab */
  $openUrl(url: string): void;
  /** Log to debug console */
  $log(...args: unknown[]): void;
  /** Current widget ID */
  readonly $widgetId: string;
  /** Current screen ID */
  readonly $screenId: string;
  /** All tag values snapshot */
  readonly $tags: Readonly<Record<string, unknown>>;
}
```

#### 5.1.3 Script Definition

```typescript
// In engine/scripting/types.ts
export interface ScriptDef {
  id: string;
  /** Human-readable script name */
  name: string;
  /** Script source code */
  source: string;
  /** When to execute */
  trigger: ScriptTrigger;
  /** Parameters bound to tag values */
  params: ScriptParam[];
  /** Whether script is enabled */
  enabled: boolean;
  /** Last execution error (null if OK) */
  lastError?: string | null;
}

export type ScriptTrigger =
  | { type: 'event'; event: EventTrigger }   // onClick, onDblClick, etc.
  | { type: 'tagChange'; tagName: string }    // Fires when tag value changes
  | { type: 'interval'; intervalMs: number }  // Periodic execution
  | { type: 'load' };                         // Fires once on screen load

export interface ScriptParam {
  name: string;
  tagName: string;
  direction: 'in' | 'out' | 'inout';
}
```

#### 5.1.4 Script Compilation & Execution

Script source is wrapped in an async IIFE with the API injected:

```javascript
// What the worker actually executes:
(async function($getTag, $setTag, $navigate, $openCard, $openUrl, $log, $widgetId, $screenId, $tags) {
  "use strict";
  // --- user script source here ---
}).call(null, ...apiArgs);
```

The wrapper is generated by `ScriptCompiler`. The worker pool reuses workers (up to 4 concurrent) to avoid worker creation overhead.

#### 5.1.5 Security Hardening

1. **CSP**: The worker is created from a Blob URL with `Content-Security-Policy: script-src 'self'`. No `eval()`, no `importScripts()`.
2. **API surface**: Only the 8 functions listed above are available. All other globals (`XMLHttpRequest`, `WebSocket`, `indexedDB`, etc.) are explicitly deleted from the worker's global scope before script execution.
3. **Execution timeout**: Each script execution has a 500ms timeout. Workers that exceed the timeout are terminated and replaced.
4. **Output rate limiting**: `$setTag` calls are limited to 50 per execution. `$navigate`/`$openCard` limited to 1 per execution.
5. **Source validation**: Scripts are statically analyzed for forbidden patterns (`import`, `require`, `eval`, `Function`, `globalThis`, `self.postMessage`) before compilation. Scripts containing these are rejected.
6. **Tenant isolation**: Each worker receives only the tag values for the current tenant's active screen. No cross-tenant data is passed to the worker.

#### 5.1.6 Script Editor

Uses CodeMirror 6 for syntax highlighting, auto-completion, and bracket matching. CodeMirror is lazy-loaded only when the user opens the script editor (it is ~200KB).

### 5.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `engine/scripting/types.ts` | ScriptDef, ScriptTrigger, ScriptParam, ScadaScriptAPI |
| `engine/scripting/ScriptCompiler.ts` | Wraps user source in IIFE, validates forbidden patterns |
| `engine/scripting/ScriptBridge.ts` | Main-thread bridge: handles postMessage from workers |
| `engine/scripting/ScriptWorkerPool.ts` | Worker pool (max 4), creation, termination, recycling |
| `engine/scripting/script.worker.ts` | Web Worker entry: receives compiled script, executes, returns results |
| `engine/scripting/ScriptManager.ts` | Manages all scripts for a screen: trigger binding, lifecycle |
| `engine/scripting/staticAnalysis.ts` | Forbidden pattern detection (AST-free, regex + token scan) |
| `components/scada-builder/ScriptEditor.tsx` | CodeMirror-based script editor |
| `components/scada-builder/ScriptList.tsx` | List of scripts per widget |
| `components/scada-builder/ScriptDebugConsole.tsx` | Debug output panel (log, errors) |
| `components/scada-builder/widget-configs/ScriptConfig.tsx` | Script binding config (trigger, params) |
| `store/scada/scriptSlice.ts` | Script CRUD actions |

**Modified files:**

| File | Changes |
|------|---------|
| `engine/ScadaRuntime.tsx` | Instantiate ScriptManager, pass tagBus/eventBus |
| `engine/events/types.ts` | Add `'runScript'` action handling with script ID param |
| `store/scada/types.ts` | Add `ScriptSlice`, scripts per widget in `ScreenWidget` |
| `types/scada-package.types.ts` | Add `scripts?: ScriptDef[]` to `ScreenWidget` |
| `store/scada/createScadaStore.ts` | Compose scriptSlice |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add Script Editor tab in properties panel |

### 5.3 Component Design

#### ScriptEditor

```typescript
interface ScriptEditorProps {
  script: ScriptDef;
  availableTags: string[];
  onChange: (updates: Partial<ScriptDef>) => void;
  onRun: () => void;     // Manual test execution
  onDelete: () => void;
}
```

Features:
- CodeMirror 6 with JavaScript syntax highlighting.
- Custom autocomplete provider: typing `$` shows available API functions, typing `$getTag('` shows tag names.
- Error gutter: red markers on lines with errors from last execution.
- Run button for manual test execution with debug console output.

#### ScriptDebugConsole

```typescript
interface ScriptDebugConsoleProps {
  logs: ScriptLogEntry[];
  onClear: () => void;
}

interface ScriptLogEntry {
  timestamp: number;
  level: 'log' | 'warn' | 'error';
  message: string;
  scriptId: string;
  scriptName: string;
}
```

A scrollable, filterable log panel that shows output from `$log()` calls and execution errors. Maximum 500 entries with auto-pruning.

### 5.4 State Management

New `scriptSlice`:

```typescript
interface ScriptSlice {
  addScript: (widgetId: string, script: Omit<ScriptDef, 'id'>) => void;
  updateScript: (widgetId: string, scriptId: string, updates: Partial<ScriptDef>) => void;
  removeScript: (widgetId: string, scriptId: string) => void;
  toggleScript: (widgetId: string, scriptId: string) => void;
  scriptLogs: ScriptLogEntry[];
  appendScriptLog: (entry: ScriptLogEntry) => void;
  clearScriptLogs: () => void;
}
```

Scripts are stored per-widget in `ScreenWidget.scripts: ScriptDef[]`.

### 5.5 Performance Strategy

- **Worker pool**: Maximum 4 workers shared across all scripts. Workers are reused, not created per execution.
- **Lazy CodeMirror**: The editor bundle is loaded only when the script panel is opened. Estimated 200KB gzipped.
- **Debounced triggers**: `tagChange` triggers are debounced to 50ms to avoid flooding the worker pool.
- **Interval scripts**: Minimum interval is 100ms. Scripts with shorter intervals are clamped.
- **Memory**: Workers are terminated after 60 seconds of inactivity. Re-created on demand.
- **No blocking**: All script execution is async. The main thread never waits for a script result.

### 5.6 Security Considerations

This is the highest-risk phase. Security measures:

1. **No DOM access**: Workers have no `document`, `window`, or DOM APIs.
2. **No network access**: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` are deleted from worker scope.
3. **No eval**: `eval`, `Function`, `setTimeout(string)` are blocked by static analysis AND deleted from worker scope.
4. **No import**: `import()` and `importScripts()` are deleted from worker scope.
5. **Execution isolation**: Each script runs in a fresh worker context (no shared state between scripts).
6. **Output validation**: `$setTag` values are validated (number, string, boolean only -- no objects, no functions). Tag names are validated against the same regex as expressions.
7. **Rate limiting**: Max 50 tag writes per execution, max 1 navigation per execution.
8. **Timeout**: 500ms hard timeout. Worker is terminated on timeout.
9. **Static analysis**: Before compilation, source is scanned for forbidden globals. This is defense-in-depth (worker scope deletion is the primary defense).
10. **Audit logging**: All script executions and tag writes are logged to the debug console for operator review.

### 5.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/engine/scripting/ScriptCompiler.test.ts` | IIFE wrapping, forbidden pattern detection |
| `__tests__/engine/scripting/staticAnalysis.test.ts` | Forbidden patterns: eval, import, require, Function |
| `__tests__/engine/scripting/ScriptBridge.test.ts` | postMessage handling, tag read/write, navigate |
| `__tests__/engine/scripting/ScriptWorkerPool.test.ts` | Pool sizing, recycling, timeout termination |
| `__tests__/engine/scripting/ScriptManager.test.ts` | Trigger binding (event, tagChange, interval, load) |
| `__tests__/engine/scripting/security.test.ts` | No DOM access, no network, no eval, rate limiting, timeout |
| `__tests__/components/ScriptEditor.test.tsx` | Renders CodeMirror, autocomplete, run button |
| `__tests__/components/ScriptDebugConsole.test.tsx` | Log display, filtering, clear |
| `__tests__/integration/script-e2e.test.ts` | Define script -> trigger -> verify tag write |
| `__tests__/integration/script-security-e2e.test.ts` | Malicious scripts blocked, timeout enforced |

### 5.8 Dependencies

| Package | Version | Reason |
|---------|---------|--------|
| `@codemirror/view` | `^6.x` | CodeMirror core view |
| `@codemirror/state` | `^6.x` | CodeMirror state management |
| `@codemirror/lang-javascript` | `^6.x` | JavaScript syntax highlighting |
| `@codemirror/autocomplete` | `^6.x` | Autocomplete provider |
| `@codemirror/lint` | `^6.x` | Error gutter |
| `codemirror` | `^6.x` | CodeMirror bundle |

All CodeMirror packages are lazy-loaded and tree-shaken. They add ~200KB to the scripting feature chunk (not to the main bundle).

### 5.9 Migration Strategy

- `ScreenWidget.scripts` is a new optional array. Existing widgets without it have zero scripts.
- The `'runScript'` event action already exists in `engine/events/types.ts` (`EventAction` includes `'runScript'`). Phase 5 implements the handler.
- Packages with scripts are marked as `version: 3` in meta.

### 5.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 12 |
| Modified files | 6 |
| Total new lines of code | ~3,800 |
| Test lines of code | ~2,000 |

---

## Phase 6: Gradient & Advanced SVG Features

**Goal**: Add linear/radial gradient editor, SVG filter effects, per-color alpha channel, and custom SVG path editor.

**Duration estimate**: 2 weeks
**Dependencies**: Phase 1 (SVG property panel, path types)

### 6.1 Architectural Design

#### 6.1.1 Gradient System

```typescript
// In types/scada-gradient.types.ts
export type GradientType = 'none' | 'linear' | 'radial';

export interface GradientStop {
  offset: number;   // 0-1
  color: string;    // hex or rgba
  opacity: number;  // 0-1
}

export interface LinearGradientConfig {
  type: 'linear';
  angle: number;             // degrees, 0 = left-to-right, 90 = top-to-bottom
  stops: GradientStop[];     // minimum 2 stops
}

export interface RadialGradientConfig {
  type: 'radial';
  cx: number;   // center X (0-1)
  cy: number;   // center Y (0-1)
  r: number;    // radius (0-1)
  stops: GradientStop[];
}

export type GradientConfig = { type: 'none' } | LinearGradientConfig | RadialGradientConfig;
```

Gradients are stored in `config.gradient` for any widget. The renderer generates `<linearGradient>` or `<radialGradient>` SVG `<defs>` and references them via `url(#grad-{widgetId})`.

#### 6.1.2 SVG Filter Effects

```typescript
// In types/scada-filter.types.ts
export interface SvgFilterConfig {
  blur: number;           // 0-20 px (feGaussianBlur stdDeviation)
  dropShadow: {
    dx: number;           // -20 to 20
    dy: number;           // -20 to 20
    blur: number;         // 0-20
    color: string;        // hex
    opacity: number;      // 0-1
  } | null;
  glow: {
    color: string;
    blur: number;         // 0-20
    opacity: number;      // 0-1
  } | null;
}
```

Filters are applied via SVG `<filter>` elements in `<defs>`, referenced by `filter="url(#filter-{widgetId})"`.

#### 6.1.3 Per-Color Alpha Channel

Already partially addressed in Phase 1 (`fillOpacity`, `strokeOpacity`). Phase 6 adds a unified color picker component that outputs `rgba()` strings:

```typescript
// Color with alpha
export interface ColorWithAlpha {
  hex: string;       // #rrggbb
  alpha: number;     // 0-1
}

export function colorToRgba(c: ColorWithAlpha): string {
  const r = parseInt(c.hex.slice(1, 3), 16);
  const g = parseInt(c.hex.slice(3, 5), 16);
  const b = parseInt(c.hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${c.alpha})`;
}
```

#### 6.1.4 Custom SVG Path Editor (Point-by-Point)

Extends the Phase 1 `PathOverlay` with an advanced mode:

- Pen tool: Click to add line points, click-drag to add bezier curves.
- Direct selection tool: Click a point to select it, drag to move.
- Anchor point conversion: Double-click a point to toggle between smooth (cubic) and corner (line).
- Handle symmetry: Hold Shift while dragging a control point to maintain symmetry.

This is the same `svgPath` widget from Phase 1 with an enhanced editing experience.

### 6.2 File Structure

**New files:**

| File | Purpose |
|------|---------|
| `types/scada-gradient.types.ts` | Gradient type definitions |
| `types/scada-filter.types.ts` | Filter type definitions |
| `components/scada-builder/widget-configs/GradientEditor.tsx` | Gradient stop editor with visual preview |
| `components/scada-builder/widget-configs/FilterConfig.tsx` | Blur, shadow, glow controls |
| `components/scada-builder/widget-configs/ColorAlphaInput.tsx` | Color picker + alpha slider (reusable) |
| `components/scada-builder/SvgGradientDefs.tsx` | Renders gradient `<defs>` per screen |
| `components/scada-builder/SvgFilterDefs.tsx` | Renders filter `<defs>` per screen |
| `components/scada-builder/path-editor/PenTool.tsx` | Pen tool mode for path creation |
| `components/scada-builder/path-editor/DirectSelectTool.tsx` | Direct selection mode |

**Modified files:**

| File | Changes |
|------|---------|
| `components/scada-builder/widget-configs/SvgShapeConfig.tsx` | Add GradientEditor and FilterConfig to shape configs |
| `components/scada-builder/widget-configs/index.ts` | No new entries (gradient/filter are sub-panels of existing configs) |
| `components/scada-builder/widget-renderers/SvgRectRenderer.tsx` | Support gradient fill and filter attribute |
| `components/scada-builder/widget-renderers/SvgCircleRenderer.tsx` | Support gradient fill and filter attribute |
| `components/scada-builder/widget-renderers/SvgEllipseRenderer.tsx` | Support gradient fill and filter attribute |
| `components/scada-builder/widget-renderers/SvgPathRenderer.tsx` | Support gradient fill and filter attribute |
| `components/scada-builder/path-editor/PathOverlay.tsx` | Integrate PenTool and DirectSelectTool modes |

### 6.3 Component Design

#### GradientEditor

```typescript
interface GradientEditorProps {
  gradient: GradientConfig;
  onChange: (gradient: GradientConfig) => void;
}
```

Features:
- Type selector: None / Linear / Radial.
- For linear: Angle dial (0-360).
- For radial: Center point picker (9-point grid), radius slider.
- Stop editor: Horizontal bar showing gradient preview. Click to add stop. Drag stops to reposition. Click stop to edit color/opacity. Delete stop (minimum 2).
- Real-time preview rectangle showing the gradient.

#### FilterConfig

```typescript
interface FilterConfigProps {
  filter: SvgFilterConfig;
  onChange: (filter: SvgFilterConfig) => void;
}
```

Features:
- Blur slider (0-20px).
- Drop shadow section: dx/dy sliders, blur slider, color picker, opacity slider.
- Glow section: color picker, blur slider, opacity slider.
- Preview toggle.

#### ColorAlphaInput

```typescript
interface ColorAlphaInputProps {
  value: ColorWithAlpha;
  onChange: (value: ColorWithAlpha) => void;
  label: string;
}
```

A compound input: native color picker for hex + a slider for alpha (0-100%). Displays the resulting `rgba()` value as a text label.

### 6.4 State Management

No new slices. Gradient and filter configs are stored in each widget's `config` object:
- `config.gradient: GradientConfig`
- `config.filter: SvgFilterConfig`

### 6.5 Performance Strategy

- **Gradient defs**: One `<linearGradient>` or `<radialGradient>` per widget that uses a gradient. Unique IDs via `grad-{widgetId}`. Defs are rendered in a single `<SvgGradientDefs>` component.
- **Filter defs**: One `<filter>` per widget that uses filters. Filter complexity is bounded (max blur 20px, max 3 filter primitives).
- **Stop count limit**: Maximum 10 gradient stops per widget.
- **Memoization**: Gradient and filter SVG elements are memoized per config hash.

### 6.6 Security Considerations

- **Gradient stops**: Color values validated as hex strings. Offset clamped to [0, 1]. Alpha clamped to [0, 1].
- **Filter values**: All numeric values clamped to their respective ranges. No arbitrary SVG filter attributes (only blur, drop-shadow, glow).
- **No filter URL injection**: Filter references use ID-based `url(#filter-{widgetId})` only. No external URL references.

### 6.7 Test Plan

| Test File | Coverage |
|-----------|----------|
| `__tests__/types/scada-gradient.test.ts` | GradientConfig construction, stop validation |
| `__tests__/types/scada-filter.test.ts` | FilterConfig construction, value bounds |
| `__tests__/components/GradientEditor.test.tsx` | Type switch, stop add/delete/move, angle change |
| `__tests__/components/FilterConfig.test.tsx` | Blur slider, shadow controls, glow controls |
| `__tests__/components/ColorAlphaInput.test.tsx` | Color change, alpha change, rgba output |
| `__tests__/components/SvgGradientDefs.test.tsx` | Correct SVG defs generation, unique IDs |
| `__tests__/components/SvgFilterDefs.test.tsx` | Correct filter defs, blur/shadow/glow primitives |
| `__tests__/integration/gradient-persistence.test.ts` | Gradient survives save/load cycle |

### 6.8 Dependencies

No new dependencies. All gradient and filter rendering uses native SVG elements.

### 6.9 Migration Strategy

- `config.gradient` defaults to `{ type: 'none' }` when absent.
- `config.filter` defaults to `{ blur: 0, dropShadow: null, glow: null }` when absent.
- Existing fill colors continue to work. Gradient overrides the flat fill when present and type is not `'none'`.

### 6.10 Estimated Complexity

| Metric | Estimate |
|--------|----------|
| New files | 9 |
| Modified files | 7 |
| Total new lines of code | ~2,000 |
| Test lines of code | ~800 |

---

## Cross-Cutting Concerns

### Accessibility (WCAG 2.1 AA)

All new UI components must comply:

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All panels (Layers, Expressions, Scripts) navigable via Tab/Shift+Tab. Arrow keys for lists. Enter/Space for actions. |
| Focus indicators | Visible 2px cyan focus ring on all interactive elements (matches existing SCADA theme). |
| Screen reader labels | `aria-label` on all icon buttons. `role="list"` / `role="listitem"` on panels. `aria-expanded` on collapsible sections. |
| Color contrast | All text meets 4.5:1 contrast ratio. Status colors (red/yellow/green) have additional shape indicators. |
| Error messages | Validation errors include descriptive text (not just red color). `aria-invalid` on fields. `role="alert"` on error summaries. |
| Reduced motion | `prefers-reduced-motion: reduce` disables all CSS animations (piston, blink, rotate). SVG `<animateMotion>` paused. |

### Testing Strategy

| Test Type | Framework | Location | Run Command |
|-----------|-----------|----------|-------------|
| Unit tests | Vitest + React Testing Library | `src/__tests__/` | `npm test` |
| Integration tests | Vitest + jsdom | `src/__tests__/integration/` | `npm test` |
| Visual regression | Storybook + Chromatic (if available) | `src/stories/` | `npm run storybook` |
| Snapshot tests | Vitest inline snapshots | Per-test file | `npm test -- --update` |
| Performance benchmarks | Vitest bench | `src/__tests__/bench/` | `npm run bench` |

### Monitoring & Observability

- Expression evaluation errors are logged via `console.error` with `[SCADA:Expression]` prefix.
- Script execution errors are logged via `console.error` with `[SCADA:Script]` prefix.
- Animation performance is tracked via `Performance.mark` / `Performance.measure` in development mode.
- Widget render count is tracked in development mode via React DevTools profiler marks.

### Package JSON Schema Versioning

| Version | Features |
|---------|----------|
| 1 (current) | Base widgets, animations, events, edges |
| 2 (Phase 1-3) | Transform, SVG properties, markers, new widgets, new animations, z-index |
| 3 (Phase 4-5) | Expressions, scripts |
| 4 (Phase 6) | Gradients, filters |

Loaders are backward-compatible: version 4 loader reads version 1 packages with all new fields defaulting to their zero values.

---

## Dependency Graph

```
Phase 1 (SVG Editor Foundation)
    |
    +---> Phase 3 (Advanced Animations)      [needs transform system]
    |         |
    |         +---> Phase 4 (Expression Engine)  [needs tag infrastructure]
    |                   |
    |                   +---> Phase 5 (Scripting)  [needs expression tag resolution]
    |
    +---> Phase 6 (Gradient & SVG Features)  [needs SVG property panel]

Phase 2 (Layer Management)  [independent, can run in parallel with Phase 1]
```

**Critical path**: Phase 1 -> Phase 3 -> Phase 4 -> Phase 5

**Parallel opportunities**:
- Phase 2 can start immediately alongside Phase 1.
- Phase 6 can start as soon as Phase 1 completes.
- Phase 4 can start alongside Phase 3 (only depends on Phase 1 for property panel integration, not animation).

**Optimal schedule with 2 developers**:

| Week | Dev A | Dev B |
|------|-------|-------|
| 1-3 | Phase 1 | Phase 2 |
| 4-6 | Phase 3 | Phase 4 |
| 7-8 | Phase 6 | Phase 4 (cont.) |
| 9-12 | Phase 5 | Phase 5 |

**Total calendar time**: ~12 weeks (2 developers) or ~17 weeks (1 developer).

---

## Risk Register

| ID | Risk | Impact | Probability | Mitigation |
|----|------|--------|-------------|------------|
| R1 | Path editor UX is too complex for non-technical users | HIGH | MEDIUM | Provide pre-built path templates (pipe elbow, pipe tee, etc.). Add a "Simple mode" with fewer controls. |
| R2 | Expression engine circular dependency detection misses edge cases | HIGH | LOW | Use Kahn's algorithm (topological sort) -- mathematically complete. Add 100% branch coverage tests. |
| R3 | Script sandbox escape via prototype pollution | CRITICAL | LOW | Delete `__proto__`, `constructor`, `prototype` from worker scope. Run security penetration tests before release. |
| R4 | Worker pool memory leak under heavy script load | MEDIUM | MEDIUM | Implement worker lifecycle monitoring. Auto-terminate workers after 60s idle. Cap pool at 4 workers. |
| R5 | Large SCADA packages (100+ widgets, 50+ screens) have slow JSON parse | MEDIUM | MEDIUM | Implement lazy screen loading (only parse active screen + adjacent). Compress package JSON with LZ-string for storage. |
| R6 | CodeMirror bundle size impacts initial page load | LOW | HIGH | Lazy-load CodeMirror only when script editor is opened. Use dynamic import with React.lazy. |
| R7 | DOMPurify false-positives strip valid SVG content | MEDIUM | MEDIUM | Configure DOMPurify with a whitelist of allowed SVG tags/attributes. Test against the existing 25 ISA equipment SVGs. |
| R8 | Cross-browser SVG filter rendering differences | LOW | MEDIUM | Test on Chrome, Firefox, Safari. Provide graceful degradation (no filter) for unsupported browsers. |
| R9 | Gradient editor stop ordering is confusing | LOW | MEDIUM | Auto-sort stops by offset. Provide visual feedback (gradient bar) during editing. |
| R10 | Animation preview conflicts with simulation mode | MEDIUM | LOW | Mutually exclusive: entering simulation mode disables animation preview and vice versa. |

---

## Total Estimates

| Phase | New Files | Modified Files | New LOC | Test LOC | Duration |
|-------|-----------|----------------|---------|----------|----------|
| 1. SVG Editor Foundation | 15 | 8 | 2,400 | 1,200 | 3 weeks |
| 2. Layer Management | 3 | 7 | 1,200 | 600 | 2 weeks |
| 3. Advanced Animations | 7 | 5 | 1,800 | 900 | 3 weeks |
| 4. Expression Engine | 13 | 4 | 3,200 | 1,600 | 3 weeks |
| 5. Scripting (Sandboxed) | 12 | 6 | 3,800 | 2,000 | 4 weeks |
| 6. Gradient & SVG Features | 9 | 7 | 2,000 | 800 | 2 weeks |
| **TOTAL** | **59** | **37** | **14,400** | **7,100** | **17 weeks** |

**Grand total**: ~21,500 lines of production + test code across 96 file touches.

**New npm dependencies**: 8 packages (dompurify, @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities, codemirror, @codemirror/view, @codemirror/state, @codemirror/lang-javascript + related).

**Risk-adjusted timeline**: 17-20 weeks (1 developer), 12-14 weeks (2 developers).
