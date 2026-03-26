# SCADA Phase 9: Remaining FUXA Gap Closure Plan

**Date**: 2026-03-26
**Status**: Draft
**Author**: Architecture Team
**Reference**: [SCADA-FUXA-GAP-ANALYSIS.md](./SCADA-FUXA-GAP-ANALYSIS.md), [SCADA-ENTERPRISE-IMPLEMENTATION-PLAN.md](./SCADA-ENTERPRISE-IMPLEMENTATION-PLAN.md)
**Prerequisite Phases**: Phase 0 (bug fixes), Phase 1-6 (completed)

---

## Table of Contents

0. [Executive Summary](#executive-summary)
1. [Architectural Principles (Inherited)](#architectural-principles-inherited)
2. [Phase 9A: Missing Widget Types (7 widgets)](#phase-9a-missing-widget-types)
3. [Phase 9B: SVG Editor Enhancements (3 features)](#phase-9b-svg-editor-enhancements)
4. [Phase 9C: Animation & Event Enhancements (5 features)](#phase-9c-animation--event-enhancements)
5. [Phase 9D: Scripting Extensions (5 features)](#phase-9d-scripting-extensions)
6. [Phase 9E: Platform Features (5 features)](#phase-9e-platform-features)
7. [Dependency Graph](#dependency-graph)
8. [Risk Register](#risk-register)
9. [Total Estimates](#total-estimates)
10. [Acceptance Criteria](#acceptance-criteria)

---

## Executive Summary

Phase 9 closes the final 25 gaps between the Suderra SCADA Builder and FUXA, completing feature parity and surpassing FUXA in every category. The phase is organized into five sub-phases (9A-9E), each independently deployable. Phase 9A adds seven missing widget types (DataTable, IFrame, BarChart, PieChart, Knob, DropdownSelect, ProgressBar). Phase 9B enhances the SVG editor with freehand drawing, interactive path point editing, and SVG child element selection. Phase 9C extends the animation engine with five new capabilities. Phase 9D extends the scripting sandbox with four new API methods and a scheduling UI. Phase 9E adds five platform-level features for production SCADA deployments.

**Scale targets (maintained from Phase 0):**
- 100+ widgets per screen rendered at 60 fps
- 50+ screens per SCADA package
- 1,000+ concurrent tenants with full data isolation
- All new widgets lazy-loaded via React.lazy()
- All user-supplied content sanitized through DOMPurify

**Total new features**: 25
**Estimated new files**: ~82
**Estimated modified files**: ~28
**Estimated lines of code**: ~12,000 (implementation) + ~6,000 (tests)
**Estimated duration**: 8-10 weeks (with parallelization across 9A-9E sub-phases)

---

## Architectural Principles (Inherited)

All Phase 9 work follows the non-negotiable rules established in the original plan:

1. **Typed Interfaces First** -- Every new feature starts with a TypeScript interface in the canonical type files before any implementation. No `any` types permitted.
2. **Lazy Loading** -- Every new renderer is added to the existing `lazyMap` in `WidgetRenderer.tsx` as a `React.lazy()` entry.
3. **Zustand Slice Pattern** -- New state belongs in dedicated slices under `store/scada/`, following the existing `StateCreator<ScadaStore>` pattern with immer middleware.
4. **Config/Renderer/Config-Panel Triple** -- Each new widget type follows the established triple: (a) size entry in `scada-widget-sizes.ts`, (b) lazy renderer in `WidgetRenderer.tsx`, (c) config panel registered in `widget-configs/index.ts`.
5. **Animation Engine Extension** -- New animation types extend `AnimationRuleType` union and the `evaluate()` function in `AnimationEngine.ts`.
6. **Backward Compatibility** -- Existing SCADA package JSON must load without migration. New fields use optional properties with sensible defaults.
7. **Tenant Isolation** -- All persistent data is scoped to the tenant schema.
8. **XSS Prevention** -- All user-provided SVG, HTML, and script content goes through DOMPurify sanitization.

**Additional Phase 9 principles:**
9. **No New Runtime Dependencies** -- Avoid adding npm packages where browser APIs suffice. Charting uses native SVG, not chart libraries.
10. **Accessibility** -- All interactive widgets include ARIA attributes, keyboard navigation, and screen reader labels.
11. **English Code Comments** -- All code comments are written in professional English. Turkish inline comments are limited to JSDoc `@description` blocks where dual-language context aids team comprehension.

---

## Phase 9A: Missing Widget Types

**Goal**: Add seven new widget types to the SCADA builder palette, completing the control and visualization toolkit to full FUXA parity.

**Duration estimate**: 3-4 weeks
**Dependencies**: Phase 0 (WidgetErrorBoundary fix), Phase 1 (established widget triple pattern)
**Priority**: HIGH

### 9A.1 DataTable Widget

#### Architecture

The DataTable widget displays tabular tag data with sortable columns, pagination, and configurable row styling. It reads multiple tag values and presents them in a scrollable, virtualized table.

**Type additions to `types/scada-widget.types.ts`:**

```typescript
| 'dataTable'
```

**New interface in `types/scada-datatable.types.ts`:**

```typescript
/** Column definition for the DataTable widget */
export interface DataTableColumn {
  /** Unique column identifier */
  id: string;
  /** Column header display text */
  header: string;
  /** Tag name that provides the value for this column */
  tagName: string;
  /** Display width in pixels (0 = auto) */
  width: number;
  /** printf-style format string (e.g., '%.2f', '%d') */
  format: string;
  /** Text alignment within the cell */
  align: 'left' | 'center' | 'right';
  /** Unit label appended after the value */
  unit: string;
  /** Whether this column is sortable */
  sortable: boolean;
}

/** Row color rule: when a column's value matches a condition, apply a background */
export interface DataTableRowRule {
  id: string;
  /** Column ID to evaluate */
  columnId: string;
  /** Comparison operator */
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  /** Threshold value */
  value: number;
  /** CSS background color for matching rows */
  backgroundColor: string;
  /** CSS text color for matching rows */
  textColor: string;
}

/** DataTable widget configuration */
export interface DataTableConfig {
  columns: DataTableColumn[];
  rowRules: DataTableRowRule[];
  /** Number of visible rows without scrolling */
  visibleRows: number;
  /** Whether to show column headers */
  showHeader: boolean;
  /** Whether to show alternating row colors (zebra striping) */
  zebraStripe: boolean;
  /** Whether to show row numbers */
  showRowNumbers: boolean;
  /** Header background color */
  headerBgColor: string;
  /** Header text color */
  headerTextColor: string;
  /** Row height in pixels */
  rowHeight: number;
  /** Font size in pixels */
  fontSize: number;
  /** Refresh interval in milliseconds for tag polling */
  refreshInterval: number;
}
```

**Integration points:**
- `WidgetRenderer.tsx` -- lazy entry in `lazyMap`
- `widget-configs/index.ts` -- config panel registration
- `scada-widget-sizes.ts` -- size definition
- `WidgetPalette.tsx` -- palette entry under "Data Display" category
- `TagValueBus` -- subscribes to all tag names from `columns[].tagName`

**State management:** No new Zustand slices. Sorting state (column, direction) and pagination offset are local component state managed by `useState` inside the renderer. Column configuration persists in `ScreenWidget.config`.

**Data persistence:** The `DataTableConfig` is stored in `ScreenWidget.config` and serialized as part of `ScadaPackageData`. All fields are optional with defaults (see migration strategy).

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-datatable.types.ts` | DataTableColumn, DataTableRowRule, DataTableConfig interfaces | ~80 |
| `widget-renderers/DataTableRenderer.tsx` | Virtualized table with sorting, pagination, row rules | ~350 |
| `widget-configs/DataTableConfig.tsx` | Column editor, row rule editor, appearance settings | ~280 |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-widget.types.ts` | Add `'dataTable'` to `ScadaWidgetType` union |
| `constants/scada-widget-sizes.ts` | Add `dataTable` size definition |
| `WidgetRenderer.tsx` | Add `dataTable` lazy entry to `lazyMap` |
| `widget-configs/index.ts` | Register `DataTableConfig` |
| `WidgetPalette.tsx` | Add DataTable to "Data Display" category |

#### Implementation Details

**DataTableRenderer component design:**

```typescript
interface DataTableRendererInternalState {
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc';
  currentPage: number;
}
```

The renderer uses CSS `position: sticky` for the header row, ensuring it stays visible during vertical scroll. Row virtualization is implemented via a simple window calculation: only render rows in the visible viewport range `[scrollTop / rowHeight, scrollTop / rowHeight + visibleRows + 2]`. This avoids the need for a virtualization library while supporting up to 1,000 rows at 60fps.

Each cell value is read from the `value` prop (which contains the latest tag snapshot) or from a `useTagValues` subscription. The renderer computes formatted display values using a lightweight `formatValue(raw: number, format: string)` utility that supports `%.Nf` (fixed decimals), `%d` (integer), `%e` (scientific notation), and `%s` (string passthrough).

**Config panel design:**

The DataTableConfig panel provides:
- A column list with add/remove/reorder controls
- Per-column tag browser, format input, alignment selector, width input, sortable toggle
- A row rules list with add/remove controls
- Per-rule column selector, operator selector, value input, color pickers
- Appearance section: visible rows, zebra stripe toggle, header colors, row height, font size

#### Security

- **XSS in column headers**: Column headers are rendered via `textContent` (not `innerHTML`). React's JSX escaping handles this natively.
- **Format string injection**: The `formatValue` function only supports `%` format specifiers. It does not evaluate user input as code. The implementation uses `Number.toFixed()` and `Number.toExponential()` rather than `eval` or `Function()`.
- **Tag name validation**: Column tag names are validated against the tag browser's known tag list. Unknown tags produce a "N/A" display value rather than errors.

#### Performance

- **Virtualization**: Only visible rows are rendered in the DOM. With 30px row height and 400px viewport, at most ~15 rows are in the DOM at any time regardless of data volume.
- **Memoization**: Each row is wrapped in `React.memo` with a shallow comparison on its data array. Column width calculations are memoized via `useMemo`.
- **Lazy loading**: The renderer chunk is ~8KB gzipped. It loads on first DataTable widget render.

#### Testing

| Test File | Coverage |
|-----------|----------|
| `__tests__/components/DataTableRenderer.test.tsx` | Renders columns, sorts by column, paginates, applies row rules, handles missing tags |
| `__tests__/components/DataTableConfig.test.tsx` | Adds/removes columns, edits column properties, adds/removes row rules |
| `__tests__/types/scada-datatable.test.ts` | Type exports, default values, format string edge cases |

**Test cases:**
1. Renders N columns with correct headers and tag values
2. Click column header sorts ascending, second click sorts descending
3. Row rule with `> 80` turns row background red
4. Missing tag value displays "N/A" instead of crashing
5. Pagination controls advance page and render correct row subset
6. 500-row dataset renders at 60fps (performance test)
7. Zebra stripe alternates row colors
8. Format string `%.2f` shows two decimal places

#### Agent Prompt: DataTable Widget

```
TASK: Implement the DataTable widget for the Suderra SCADA Builder.

CONTEXT: The Suderra SCADA Builder uses a Config/Renderer/Config-Panel triple pattern for every widget. You must follow this pattern exactly. The codebase is a React 18 + TypeScript + Zustand application. All widget renderers are lazy-loaded via React.lazy() in WidgetRenderer.tsx.

BEFORE CODING, READ THESE FILES IN FULL:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-widget.types.ts (widget type union)
2. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx (lazy map pattern)
3. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts (config registry)
4. /var/aqua-saas/web/modules/sensor-module/src/constants/scada-widget-sizes.ts (size definitions)
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx (simple renderer reference)
6. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/SliderConfig.tsx (config panel reference)
7. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx (complex renderer reference)
8. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/WidgetPalette.tsx (palette categories)

IMPLEMENTATION STEPS:
1. Create /var/aqua-saas/web/modules/sensor-module/src/types/scada-datatable.types.ts with DataTableColumn, DataTableRowRule, and DataTableConfig interfaces. Every field must have a JSDoc comment. No `any` types.
2. Add 'dataTable' to the ScadaWidgetType union in scada-widget.types.ts.
3. Add dataTable size definition to scada-widget-sizes.ts: { defaultW: 6, defaultH: 4, minW: 3, minH: 2, maxW: 12, maxH: 8 }.
4. Create DataTableRenderer.tsx in widget-renderers/. It must:
   - Accept WidgetRendererProps
   - Implement row virtualization (only render visible rows)
   - Support sortable columns (local state, no Zustand)
   - Support row color rules (evaluate condition per row)
   - Use formatValue utility for %.2f, %d, %e, %s patterns
   - Show "N/A" for missing tag values
   - Be wrapped in React.memo
   - Have displayName set
   - Export as default
5. Create DataTableConfig.tsx in widget-configs/. It must:
   - Follow the WidgetConfigProps interface pattern from existing configs
   - Include a column list editor with add/remove/reorder
   - Include TagBrowser for each column's tag selection
   - Include row rule editor with condition builder
   - Include appearance settings (zebra stripe, header colors, row height, font size)
6. Register in WidgetRenderer.tsx lazyMap and widget-configs/index.ts widgetConfigMap.
7. Add to WidgetPalette.tsx under a "Data Display" category with Table2 icon from lucide-react.
8. Write tests covering: column rendering, sorting, pagination, row rules, missing tags, format strings.

CONSTRAINTS:
- Zero `any` types -- use proper TypeScript interfaces for everything
- All code comments in professional English
- No new npm dependencies -- use native browser APIs and SVG
- Must render at 60fps with 500 rows (virtualization required)
- Must work in both edit mode (demo data) and runtime mode (tag bus data)
- XSS safe -- never use dangerouslySetInnerHTML for user data
- Follow existing code style: 2-space indent, single quotes, no semicolons in imports
```

---

### 9A.2 IFrame Widget

#### Architecture

The IFrame widget embeds external URLs or raw HTML content in a sandboxed `<iframe>`. This enables operators to embed external dashboards, documentation, or camera feeds directly within SCADA views.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'iframe'

// In types/scada-iframe.types.ts
export interface IFrameConfig {
  /** URL to load inside the iframe */
  url: string;
  /** Raw HTML content (alternative to URL -- only used if url is empty) */
  htmlContent: string;
  /** Iframe sandbox attribute flags */
  sandbox: IFrameSandboxFlags;
  /** Whether to show a border around the iframe */
  showBorder: boolean;
  /** Border color */
  borderColor: string;
  /** Border width in pixels */
  borderWidth: number;
  /** Border radius in pixels */
  borderRadius: number;
  /** Loading indicator text shown while iframe loads */
  loadingText: string;
  /** Whether to allow fullscreen via allowfullscreen attribute */
  allowFullscreen: boolean;
  /** Scroll behavior: auto shows scrollbar when needed, hidden hides it */
  scrolling: 'auto' | 'hidden';
}

export interface IFrameSandboxFlags {
  allowScripts: boolean;
  allowSameOrigin: boolean;
  allowForms: boolean;
  allowPopups: boolean;
  allowModals: boolean;
}

export const DEFAULT_IFRAME_SANDBOX: IFrameSandboxFlags = {
  allowScripts: false,
  allowSameOrigin: false,
  allowForms: false,
  allowPopups: false,
  allowModals: false,
};
```

**Integration points:**
- Standard widget triple (renderer, config, sizes)
- No TagValueBus subscription (IFrame is static content)
- DOMPurify sanitization for `htmlContent` mode

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-iframe.types.ts` | IFrameConfig, IFrameSandboxFlags interfaces | ~60 |
| `widget-renderers/IFrameRenderer.tsx` | Sandboxed iframe with URL validation and loading state | ~180 |
| `widget-configs/IFrameConfig.tsx` | URL input, sandbox flag toggles, appearance settings | ~200 |

**Modified files:** Same 5-file pattern as 9A.1 (types union, sizes, lazyMap, configMap, palette).

#### Implementation Details

**IFrameRenderer:**
- In edit mode: displays a placeholder with the configured URL text and an iframe icon
- In runtime mode: renders `<iframe>` with computed `sandbox` attribute
- URL validation: only `https:` URLs permitted in production. `http:` allowed only for `localhost` and `127.0.0.1`
- HTML content mode: content is sanitized through DOMPurify with `{ WHOLE_DOCUMENT: true, FORBID_TAGS: ['script', 'style', 'link', 'meta'], ADD_ATTR: ['target'] }` and rendered via `srcdoc` attribute
- Loading state: shows a skeleton shimmer until the `onLoad` event fires
- Error state: shows an error message if the URL fails to load (via `onError` event)

**Sandbox attribute computation:**

```typescript
function buildSandboxAttribute(flags: IFrameSandboxFlags): string {
  const parts: string[] = [];
  if (flags.allowScripts) parts.push('allow-scripts');
  if (flags.allowSameOrigin) parts.push('allow-same-origin');
  if (flags.allowForms) parts.push('allow-forms');
  if (flags.allowPopups) parts.push('allow-popups');
  if (flags.allowModals) parts.push('allow-modals');
  return parts.join(' ');
}
```

#### Security

- **URL injection**: URLs are validated via `new URL()` constructor. Only `https:` protocol is allowed (with localhost exception for development). `javascript:`, `data:`, `blob:`, `file:` protocols are explicitly rejected.
- **HTML content XSS**: All raw HTML goes through DOMPurify with restrictive configuration. No `<script>`, `<style>`, `<link>`, `<meta>` tags allowed.
- **Sandbox attribute**: Default is empty string (maximum restriction). Each flag must be explicitly enabled by the operator. A warning message is displayed when `allow-scripts` + `allow-same-origin` are both enabled (this combination can escape the sandbox).
- **Tenant isolation**: The iframe's `sandbox` attribute prevents it from accessing the parent page's DOM, cookies, or localStorage by default.
- **CSP**: The iframe respects the application's Content-Security-Policy `frame-src` directive.

#### Performance

- **Lazy loading**: IFrame renderer chunk is ~4KB gzipped
- **Loading attribute**: `<iframe loading="lazy">` defers loading until the widget is in the viewport
- **No re-render on parent updates**: The iframe is rendered with a stable `key` prop derived from the URL, preventing unnecessary reloads

#### Testing

| Test File | Coverage |
|-----------|----------|
| `__tests__/components/IFrameRenderer.test.tsx` | URL validation, sandbox attribute, loading state, error state, edit mode placeholder |
| `__tests__/components/IFrameConfig.test.tsx` | URL input, sandbox toggles, combined sandbox warning |
| `__tests__/security/iframe-security.test.ts` | XSS vectors for URL and HTML content, protocol rejection, sandbox escape prevention |

**Test cases:**
1. Renders iframe with valid HTTPS URL
2. Rejects `javascript:alert(1)` URL
3. Rejects `data:text/html,...` URL
4. Sanitizes HTML content removing `<script>` tags
5. Sandbox attribute correctly concatenates enabled flags
6. Shows warning when `allow-scripts` + `allow-same-origin` both enabled
7. Edit mode shows placeholder instead of live iframe
8. Loading skeleton appears before iframe loads

#### Agent Prompt: IFrame Widget

```
TASK: Implement the IFrame widget for the Suderra SCADA Builder.

CONTEXT: The Suderra SCADA Builder uses a Config/Renderer/Config-Panel triple pattern for every widget. This widget embeds external content in a sandboxed iframe. SECURITY IS PARAMOUNT -- this is a multi-tenant SaaS SCADA system. All URLs must be validated, all HTML content must be sanitized.

BEFORE CODING, READ THESE FILES IN FULL:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-widget.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts
4. /var/aqua-saas/web/modules/sensor-module/src/constants/scada-widget-sizes.ts
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/VideoStreamRenderer.tsx (URL validation pattern reference)
6. /var/aqua-saas/web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts (isValidScriptUrl reference for URL validation)
7. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/WidgetPalette.tsx

IMPLEMENTATION STEPS:
1. Create /var/aqua-saas/web/modules/sensor-module/src/types/scada-iframe.types.ts with IFrameConfig, IFrameSandboxFlags, DEFAULT_IFRAME_SANDBOX. Every field JSDoc commented.
2. Add 'iframe' to ScadaWidgetType union.
3. Add iframe size: { defaultW: 4, defaultH: 3, minW: 2, minH: 2, maxW: 12, maxH: 8 }.
4. Create IFrameRenderer.tsx:
   - Edit mode: icon + URL text placeholder (never render actual iframe in editor)
   - Runtime: <iframe sandbox={computed} src={validated_url} /> or srcdoc={sanitized_html}
   - URL validation: only https: (+ http://localhost for dev). Use new URL() parsing.
   - HTML sanitization: DOMPurify with FORBID_TAGS: ['script', 'style', 'link', 'meta']
   - Loading shimmer + onLoad/onError handlers
   - React.memo wrapped, displayName set, default export
5. Create IFrameConfig.tsx:
   - URL input with validation feedback
   - HTML content textarea (shown when URL is empty)
   - Sandbox flag toggles with security warning for scripts+sameOrigin combo
   - Appearance: border, radius, fullscreen toggle
6. Register in all standard locations.
7. Write security-focused tests: URL injection vectors, HTML XSS vectors, sandbox attribute correctness.

CONSTRAINTS:
- Zero `any` types
- All comments in professional English
- No dangerouslySetInnerHTML -- use srcdoc for HTML content
- Default sandbox is EMPTY STRING (maximum restriction)
- URL validation must reject: javascript:, data:, blob:, file:, ftp:
- DOMPurify is already installed (used in CustomSvgRenderer)
```

---

### 9A.3 BarChart Widget

#### Architecture

The BarChart widget renders vertical or horizontal bar charts using native SVG. It supports multiple data sources (tags), value-based or time-based X axis, and configurable colors per bar.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'barChart'

// In types/scada-barchart.types.ts
export interface BarChartSeries {
  id: string;
  label: string;
  tagName: string;
  color: string;
}

export interface BarChartConfig {
  series: BarChartSeries[];
  orientation: 'vertical' | 'horizontal';
  /** 'value' = each series is one bar, 'time' = bars represent time buckets */
  xAxisMode: 'value' | 'time';
  showGrid: boolean;
  showLegend: boolean;
  showValues: boolean;
  /** Value label format string (%.1f, %d, etc.) */
  valueFormat: string;
  /** Y-axis minimum (null = auto-scale) */
  yMin: number | null;
  /** Y-axis maximum (null = auto-scale) */
  yMax: number | null;
  /** Gap between bars as ratio (0 = no gap, 1 = bar width equals gap) */
  barGap: number;
  /** Border radius on bar corners in pixels */
  barRadius: number;
  /** Animation duration in ms for bar height transitions */
  animationDuration: number;
  /** Background color of the chart area */
  backgroundColor: string;
  /** Grid line color */
  gridColor: string;
  /** Axis label font size */
  labelFontSize: number;
}
```

**Integration points:**
- Standard widget triple pattern
- TagValueBus subscription for each `series[].tagName`
- SVG-based rendering (no chart library dependency)

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-barchart.types.ts` | BarChartSeries, BarChartConfig interfaces | ~55 |
| `widget-renderers/BarChartRenderer.tsx` | SVG bar chart with transitions and axis labels | ~320 |
| `widget-configs/BarChartConfig.tsx` | Series editor, axis settings, appearance | ~250 |

#### Implementation Details

**BarChartRenderer:**

The chart is rendered as a single `<svg>` element with computed viewBox. Bars are `<rect>` elements with CSS `transition: height 300ms ease-out` for smooth value updates. Axis labels use `<text>` elements positioned at grid lines.

Layout computation:
1. Compute chart area (total width/height minus axis label margins)
2. Compute bar width: `chartWidth / (seriesCount * (1 + barGap))`
3. Compute bar height: `(value - yMin) / (yMax - yMin) * chartHeight`
4. Y-axis auto-scaling: compute `yMin = Math.min(0, ...values)`, `yMax = max(...values) * 1.1`

Edit mode renders demo data (sine-wave series) for visual preview.

**Chart area layout:**

```
+--+---------------------------+
|  |                           |  <- Y-axis labels (left margin)
|  |  [bar] [bar] [bar]       |
|  |  [bar] [bar] [bar]       |
|  |  [bar] [bar] [bar]       |
+--+---------------------------+
   | label  label  label       |  <- X-axis labels (bottom margin)
   +---------------------------+
```

#### Security

- Tag names are validated against the tag browser's known tag list
- SVG elements are all built via React JSX (no raw SVG strings or innerHTML)
- Value format strings use the same safe `formatValue` utility as DataTable

#### Performance

- Bars use CSS transitions instead of requestAnimationFrame loops
- SVG elements are keyed by series ID to minimize DOM mutations
- Chart dimensions are memoized via `useMemo` keyed on `[width, height, series.length]`
- Lazy loading: renderer chunk is ~6KB gzipped

#### Testing

| Test File | Coverage |
|-----------|----------|
| `__tests__/components/BarChartRenderer.test.tsx` | Renders bars, vertical/horizontal orientation, auto-scaling, value labels, legend |
| `__tests__/components/BarChartConfig.test.tsx` | Series CRUD, orientation toggle, axis settings |

**Test cases:**
1. Renders N bars matching N series
2. Vertical orientation: bars grow upward from baseline
3. Horizontal orientation: bars grow rightward from baseline
4. Auto-scaling adjusts Y axis to data range
5. Fixed yMin/yMax clamps bar heights
6. Value labels display formatted values above bars
7. Legend shows series labels with color swatches
8. Edit mode displays demo data

#### Agent Prompt: BarChart Widget

```
TASK: Implement the BarChart widget for the Suderra SCADA Builder using native SVG (no chart library).

BEFORE CODING, READ THESE FILES:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-widget.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/WidgetRenderer.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/index.ts
4. /var/aqua-saas/web/modules/sensor-module/src/constants/scada-widget-sizes.ts
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/TrendChartRenderer.tsx (SVG chart reference)
6. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts (chart utilities reference)

IMPLEMENTATION:
1. Create types/scada-barchart.types.ts with BarChartSeries and BarChartConfig.
2. Add 'barChart' to ScadaWidgetType. Size: { defaultW: 4, defaultH: 3, minW: 2, minH: 2, maxW: 12, maxH: 8 }.
3. Create BarChartRenderer.tsx using pure SVG:
   - <svg> with computed viewBox
   - <rect> elements for bars with CSS transition on height/width
   - <text> elements for axis labels and value labels
   - <line> elements for grid lines
   - Vertical and horizontal orientation support
   - Auto-scaling Y axis with nice step calculation (reuse niceStep from trendChartUtils)
   - Edit mode: sine-wave demo data
   - Runtime: reads from WidgetRendererProps.value or tag subscriptions
4. Create BarChartConfig.tsx: series list editor with TagBrowser per series, color picker, orientation toggle, grid/legend/values toggles, yMin/yMax inputs.
5. Register everywhere, add to palette under "Charts" category with BarChart3 icon.
6. Tests: rendering, orientation, auto-scaling, value labels, legend.

CONSTRAINTS:
- No chart libraries (recharts, chart.js, etc.) -- native SVG only
- No `any` types
- English comments
- Must render 20 bars at 60fps with smooth CSS transitions
- React.memo + displayName + default export
```

---

### 9A.4 PieChart Widget

#### Architecture

The PieChart widget displays proportional data using SVG arc paths. Each slice represents a tag value as a proportion of the total.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'pieChart'

// In types/scada-piechart.types.ts
export interface PieChartSlice {
  id: string;
  label: string;
  tagName: string;
  color: string;
}

export interface PieChartConfig {
  slices: PieChartSlice[];
  showLabels: boolean;
  showLegend: boolean;
  showPercentage: boolean;
  showValues: boolean;
  /** Inner radius as ratio (0 = full pie, 0.5 = donut) */
  innerRadius: number;
  /** Start angle in degrees (0 = 12 o'clock position) */
  startAngle: number;
  /** Label font size */
  labelFontSize: number;
  /** Animation duration for slice transitions */
  animationDuration: number;
  /** Value format string */
  valueFormat: string;
}
```

#### File Structure

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-piechart.types.ts` | PieChartSlice, PieChartConfig | ~45 |
| `widget-renderers/PieChartRenderer.tsx` | SVG pie/donut chart with labels | ~280 |
| `widget-configs/PieChartConfig.tsx` | Slice editor, appearance settings | ~220 |

#### Implementation Details

**SVG arc path computation:**

```typescript
function describeArc(cx: number, cy: number, outerR: number, innerR: number,
                     startAngle: number, endAngle: number): string {
  const startOuter = polarToCartesian(cx, cy, outerR, endAngle);
  const endOuter = polarToCartesian(cx, cy, outerR, startAngle);
  const startInner = polarToCartesian(cx, cy, innerR, startAngle);
  const endInner = polarToCartesian(cx, cy, innerR, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    innerR > 0 ? `L ${startInner.x} ${startInner.y}` : `L ${cx} ${cy}`,
    innerR > 0 ? `A ${innerR} ${innerR} 0 ${largeArc} 1 ${endInner.x} ${endInner.y}` : '',
    'Z',
  ].join(' ');
}
```

Labels are positioned at the midpoint of each arc at `(outerR + innerR) / 2 + labelOffset` distance from center.

#### Security

- SVG paths are computed mathematically, no user strings in path data
- Label text rendered via React JSX (automatic escaping)

#### Performance

- SVG paths are memoized per slice values array
- CSS transitions on `d` attribute path morphing (supported in modern browsers)
- Lazy loaded: ~5KB gzipped

#### Testing

1. Renders correct number of slices
2. Slice angles sum to 360 degrees
3. Donut mode (innerRadius > 0) creates hole
4. Percentage labels show correct values
5. Legend displays all slice labels with colors
6. Single-slice renders full circle
7. Zero-value slice is not rendered

#### Agent Prompt: PieChart Widget

```
TASK: Implement the PieChart widget for the Suderra SCADA Builder using native SVG arc paths.

BEFORE CODING, READ:
1-7: Same standard files as BarChart prompt (types, WidgetRenderer, configs/index, sizes, TrendChartRenderer, palette)

IMPLEMENTATION:
1. Create types/scada-piechart.types.ts with PieChartSlice and PieChartConfig interfaces.
2. Add 'pieChart' to ScadaWidgetType. Size: { defaultW: 3, defaultH: 3, minW: 2, minH: 2, maxW: 8, maxH: 8 }.
3. Create PieChartRenderer.tsx:
   - SVG-based pie chart using arc path computation
   - Support donut mode via innerRadius config
   - Labels at midpoint of each arc
   - Percentage display: (sliceValue / totalValue * 100).toFixed(1) + '%'
   - Legend below or to the right based on aspect ratio
   - Edit mode: demo data [30, 25, 20, 15, 10]
   - CSS transition on path d attribute for smooth updates
4. Create PieChartConfig.tsx: slice list editor with TagBrowser, color picker, label input per slice. Appearance: labels, legend, percentage, values toggles, inner radius slider (0-0.8), start angle input.
5. Register everywhere, palette under "Charts" with PieChart icon.
6. Tests for rendering, angles, donut, labels, edge cases (zero, single slice).

CONSTRAINTS:
- No chart libraries -- native SVG arc path math
- Must implement polarToCartesian and describeArc utility functions
- No `any` types, English comments
- React.memo + displayName + default export
```

---

### 9A.5 Knob Widget

#### Architecture

The Knob widget is a rotary input control that maps angular position to a numeric value. The operator drags around a circular track to change the value, which writes to a tag.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'knob'

// In types/scada-knob.types.ts
export interface KnobConfig {
  min: number;
  max: number;
  step: number;
  /** Start angle in degrees (0 = top, clockwise) */
  startAngle: number;
  /** End angle in degrees (default 360 for full rotation) */
  endAngle: number;
  /** Track color (the circular background arc) */
  trackColor: string;
  /** Fill color (the arc from startAngle to current value's angle) */
  fillColor: string;
  /** Pointer/thumb color */
  thumbColor: string;
  /** Whether to show the numeric value below the knob */
  showValue: boolean;
  /** Value display format string */
  valueFormat: string;
  /** Unit label */
  unit: string;
  /** Label text */
  label: string;
  /** Track width in pixels */
  trackWidth: number;
  /** Whether knob is read-only (display only, no drag interaction) */
  readOnly: boolean;
  /** Demo value for edit mode preview */
  demoValue: number;
  /** Security level for write operations */
  security: 'none' | 'confirm' | 'pin';
}
```

#### File Structure

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-knob.types.ts` | KnobConfig interface | ~40 |
| `widget-renderers/KnobRenderer.tsx` | SVG knob with drag interaction | ~280 |
| `widget-configs/KnobConfig.tsx` | Min/max/step, angle range, colors, security | ~200 |

#### Implementation Details

**Drag interaction:**

The knob uses pointer events (`onPointerDown`, `onPointerMove`, `onPointerUp`) with `setPointerCapture` for reliable drag tracking even when the cursor leaves the widget bounds.

Angle-to-value mapping:
```typescript
function angleToValue(angle: number, startAngle: number, endAngle: number,
                      min: number, max: number, step: number): number {
  const totalAngle = endAngle - startAngle;
  const ratio = (angle - startAngle) / totalAngle;
  const raw = min + ratio * (max - min);
  const stepped = Math.round(raw / step) * step;
  return Math.max(min, Math.min(max, stepped));
}
```

The current value is sent to the tag bus via `onCommand('setValue', newValue)` on each drag update (throttled to 60fps via `requestAnimationFrame`).

**SVG structure:**
- Background track arc (`<path>` with stroke, no fill)
- Value fill arc (`<path>` from startAngle to current value angle)
- Thumb indicator (`<circle>` positioned on the arc at the current angle)
- Value text (`<text>` at center)
- Label text (`<text>` below center)

#### Security

- Drag interaction disabled in edit mode and when `readOnly` is true
- Security level gates the `onCommand` call (confirm/pin validation happens in ScadaWidgetNode)
- Value is clamped to `[min, max]` range before writing to tag
- Step enforcement prevents sub-step value writes

#### Performance

- Pointer events throttled via rAF to prevent excessive tag writes
- SVG arc path computation memoized on `[value, startAngle, endAngle, width, height]`
- Lazy loaded: ~5KB gzipped

#### Testing

1. Renders knob at correct angle for given value
2. Pointer drag updates value proportionally
3. Step enforcement rounds to nearest step
4. Min/max clamping prevents out-of-range values
5. ReadOnly mode ignores pointer events
6. Edit mode uses demoValue instead of tag value
7. onCommand fires with 'setValue' on drag
8. Custom angle range (e.g., 45-315) works correctly

#### Agent Prompt: Knob Widget

```
TASK: Implement the Knob rotary input widget for the Suderra SCADA Builder.

BEFORE CODING, READ:
1-4: Standard type/renderer/config/sizes files
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx (input widget with onCommand pattern)
6. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/GaugeRenderer.tsx (SVG circular rendering reference)

IMPLEMENTATION:
1. Create types/scada-knob.types.ts with KnobConfig interface.
2. Add 'knob' to ScadaWidgetType. Size: { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4, maxH: 4 }.
3. Create KnobRenderer.tsx:
   - SVG knob with background track arc, value fill arc, thumb circle
   - Pointer event drag interaction (onPointerDown/Move/Up with setPointerCapture)
   - Angle-to-value and value-to-angle mapping with step snapping
   - Value display at center, label below
   - Edit mode uses config.demoValue
   - Runtime: onCommand('setValue', value) on drag (rAF throttled)
   - Disabled interaction when isEditing or config.readOnly
4. Create KnobConfig.tsx: min/max/step, angle range, colors (track/fill/thumb), readOnly toggle, security select, unit, label, format.
5. Register everywhere, palette under "Controls" with Disc icon.
6. Tests for rendering, drag interaction, step snapping, clamping, readOnly.

CONSTRAINTS:
- No `any` types, English comments
- Use pointer events (not mouse events) for cross-device support
- rAF-throttle drag updates to prevent tag bus flooding
- React.memo + displayName + default export
```

---

### 9A.6 DropdownSelect Widget

#### Architecture

The DropdownSelect widget allows operators to pick from a predefined list of options, writing the selected value to a tag.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'dropdownSelect'

// In types/scada-dropdown.types.ts
export interface DropdownOption {
  label: string;
  value: string | number;
}

export interface DropdownSelectConfig {
  options: DropdownOption[];
  placeholder: string;
  label: string;
  /** Whether to allow clearing the selection */
  clearable: boolean;
  /** Whether the dropdown is searchable/filterable */
  searchable: boolean;
  /** Tag name to write the selected value to */
  tagName: string;
  /** Font size in pixels */
  fontSize: number;
  /** Security level for write operations */
  security: 'none' | 'confirm' | 'pin';
  /** Demo value for edit mode preview */
  demoValue: string | number;
}
```

#### File Structure

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-dropdown.types.ts` | DropdownOption, DropdownSelectConfig | ~35 |
| `widget-renderers/DropdownSelectRenderer.tsx` | Custom select with keyboard navigation | ~220 |
| `widget-configs/DropdownSelectConfig.tsx` | Options list editor, tag browser, appearance | ~180 |

#### Implementation Details

**DropdownSelectRenderer:**
- Renders a custom dropdown (not native `<select>`) for consistent cross-browser styling
- Closed state: button showing current selection or placeholder
- Open state: absolutely positioned list below the button
- Keyboard navigation: ArrowUp/ArrowDown to navigate, Enter to select, Escape to close
- Search: when `searchable` is true, typing filters the visible options
- On selection: calls `onCommand('setValue', option.value)`
- Click outside closes the dropdown (via `useEffect` with document click listener)
- ARIA attributes: `role="listbox"`, `aria-expanded`, `aria-activedescendant`, `role="option"` per item

**Z-index handling:** The dropdown popover uses `z-index: 9999` and `position: fixed` with computed position to avoid clipping by parent overflow containers.

#### Security

- Option values are strings or numbers only (no objects, no functions)
- Security level gates the `onCommand` call
- Selected value is validated against the options list before writing

#### Performance

- Option list is memoized via `useMemo`
- Search filtering uses `useMemo` with debounce
- Lazy loaded: ~4KB gzipped

#### Testing

1. Renders closed dropdown with placeholder
2. Click opens the option list
3. Click option selects it and closes
4. Keyboard navigation works (ArrowDown, Enter, Escape)
5. Search filters options by label
6. Clearable mode shows X button to clear selection
7. onCommand fires with selected value
8. Click outside closes dropdown

#### Agent Prompt: DropdownSelect Widget

```
TASK: Implement the DropdownSelect widget for the Suderra SCADA Builder.

BEFORE CODING, READ:
1-4: Standard type/renderer/config/sizes files
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx (onCommand pattern)

IMPLEMENTATION:
1. Create types/scada-dropdown.types.ts with DropdownOption and DropdownSelectConfig.
2. Add 'dropdownSelect' to ScadaWidgetType. Size: { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4, maxH: 3 }.
3. Create DropdownSelectRenderer.tsx:
   - Custom dropdown (NOT native <select>) for consistent styling
   - Button shows current value label or placeholder
   - Popover list with position:fixed for z-index safety
   - Keyboard navigation: ArrowUp/Down, Enter, Escape
   - Optional search/filter mode
   - onCommand('setValue', option.value) on selection
   - ARIA attributes for accessibility
   - Click-outside-to-close via document listener
   - Edit mode: shows demoValue selection
4. Create DropdownSelectConfig.tsx: options list editor (add/remove/reorder), label/value per option, tag browser, placeholder, searchable/clearable toggles, security select.
5. Register everywhere, palette under "Controls" with ChevronDown icon.
6. Tests: open/close, selection, keyboard, search, clearable, ARIA.

CONSTRAINTS:
- No `any` types, English comments
- Must be fully keyboard-accessible (ARIA listbox pattern)
- Use position:fixed for popover to avoid overflow clipping
- React.memo + displayName + default export
```

---

### 9A.7 ProgressBar Widget

#### Architecture

The ProgressBar widget displays a horizontal linear fill bar representing a tag value as a percentage of a configured range, with color zones for normal/warning/critical states.

**Type additions:**

```typescript
// In types/scada-widget.types.ts
| 'progressBar'

// In types/scada-progressbar.types.ts
export interface ProgressBarColorZone {
  min: number;
  max: number;
  color: string;
}

export interface ProgressBarConfig {
  min: number;
  max: number;
  /** Color zones (evaluated in order, first match wins) */
  zones: ProgressBarColorZone[];
  /** Default fill color when no zone matches */
  fillColor: string;
  /** Track (background) color */
  trackColor: string;
  /** Whether to show the percentage text */
  showPercentage: boolean;
  /** Whether to show the raw value text */
  showValue: boolean;
  /** Value format string */
  valueFormat: string;
  /** Unit label */
  unit: string;
  /** Label text */
  label: string;
  /** Bar height as ratio of widget height (0.1 - 1.0) */
  barHeightRatio: number;
  /** Border radius on bar corners */
  borderRadius: number;
  /** Whether to animate fill changes */
  animated: boolean;
  /** Animation duration in ms */
  animationDuration: number;
  /** Demo value for edit mode */
  demoValue: number;
}
```

#### File Structure

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-progressbar.types.ts` | ProgressBarColorZone, ProgressBarConfig | ~40 |
| `widget-renderers/ProgressBarRenderer.tsx` | Horizontal bar with zones and labels | ~160 |
| `widget-configs/ProgressBarConfig.tsx` | Min/max, zones editor, appearance | ~180 |

#### Implementation Details

The renderer computes fill percentage as `((value - min) / (max - min)) * 100`, clamped to [0, 100]. The fill bar is a `<div>` with `width: ${percent}%` and `transition: width ${duration}ms ease-out` when animated.

Color zone evaluation:
```typescript
function getZoneColor(value: number, zones: ProgressBarColorZone[], defaultColor: string): string {
  for (const zone of zones) {
    if (value >= zone.min && value <= zone.max) return zone.color;
  }
  return defaultColor;
}
```

**Layout:**
```
[Label]
[==========----------] 75% | 750 L
```

#### Security

- No user-supplied HTML or SVG -- pure div-based rendering
- Value is clamped to [0, 100] percentage range

#### Performance

- CSS transition handles animation (no JS animation loop)
- Re-renders only when value or config changes (React.memo)
- Lazy loaded: ~3KB gzipped

#### Testing

1. Renders fill at correct percentage width
2. Color zone switches color at threshold
3. Multiple zones evaluate in order
4. Percentage text shows correct value
5. Value text shows formatted value with unit
6. Animated mode transitions smoothly
7. Min/max range mapping works (e.g., min=100, max=500, value=300 = 50%)
8. Value below min clamps to 0%, above max clamps to 100%

#### Agent Prompt: ProgressBar Widget

```
TASK: Implement the ProgressBar widget for the Suderra SCADA Builder.

BEFORE CODING, READ:
1-4: Standard type/renderer/config/sizes files
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SliderRenderer.tsx (simple layout reference)

IMPLEMENTATION:
1. Create types/scada-progressbar.types.ts with ProgressBarColorZone and ProgressBarConfig.
2. Add 'progressBar' to ScadaWidgetType. Size: { defaultW: 3, defaultH: 1, minW: 2, minH: 1, maxW: 12, maxH: 3 }.
3. Create ProgressBarRenderer.tsx:
   - Track div (full width, trackColor background)
   - Fill div (width = percentage, with CSS transition)
   - Color zone evaluation for dynamic fill color
   - Label above bar, percentage and/or value beside or below bar
   - Edit mode: demoValue
4. Create ProgressBarConfig.tsx: min/max, zones list editor (min/max/color per zone), colors, showPercentage/showValue, format, unit, label, barHeightRatio slider, borderRadius, animated toggle.
5. Register everywhere, palette under "Indicators" with BarChart2 icon.
6. Tests: percentage rendering, zone colors, clamping, animation, formatting.

CONSTRAINTS:
- No `any` types, English comments
- CSS transitions for animation (no requestAnimationFrame)
- React.memo + displayName + default export
```

---

### 9A Summary: All Widget Registration Changes

After all 9A widgets are implemented, the following canonical files receive these additions:

**`types/scada-widget.types.ts` -- ScadaWidgetType union additions:**
```typescript
| 'dataTable'
| 'iframe'
| 'barChart'
| 'pieChart'
| 'knob'
| 'dropdownSelect'
| 'progressBar'
```

**`constants/scada-widget-sizes.ts` -- WIDGET_SIZES additions:**
```typescript
dataTable:      { defaultW: 6, defaultH: 4, minW: 3, minH: 2, maxW: 12, maxH: 8 },
iframe:         { defaultW: 4, defaultH: 3, minW: 2, minH: 2, maxW: 12, maxH: 8 },
barChart:       { defaultW: 4, defaultH: 3, minW: 2, minH: 2, maxW: 12, maxH: 8 },
pieChart:       { defaultW: 3, defaultH: 3, minW: 2, minH: 2, maxW: 8,  maxH: 8 },
knob:           { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4,  maxH: 4 },
dropdownSelect: { defaultW: 2, defaultH: 2, minW: 1, minH: 1, maxW: 4,  maxH: 3 },
progressBar:    { defaultW: 3, defaultH: 1, minW: 2, minH: 1, maxW: 12, maxH: 3 },
```

**`WidgetRenderer.tsx` -- lazyMap additions:**
```typescript
dataTable:      React.lazy(() => import('./widget-renderers/DataTableRenderer')),
iframe:         React.lazy(() => import('./widget-renderers/IFrameRenderer')),
barChart:       React.lazy(() => import('./widget-renderers/BarChartRenderer')),
pieChart:       React.lazy(() => import('./widget-renderers/PieChartRenderer')),
knob:           React.lazy(() => import('./widget-renderers/KnobRenderer')),
dropdownSelect: React.lazy(() => import('./widget-renderers/DropdownSelectRenderer')),
progressBar:    React.lazy(() => import('./widget-renderers/ProgressBarRenderer')),
```

**`widget-configs/index.ts` -- widgetConfigMap additions:**
```typescript
dataTable: DataTableConfig,
iframe: IFrameConfig,
barChart: BarChartConfig,
pieChart: PieChartConfig,
knob: KnobConfig,
dropdownSelect: DropdownSelectConfig,
progressBar: ProgressBarConfig,
```

**`WidgetPalette.tsx` -- new categories and entries:**
```
Charts:        BarChart, PieChart
Data Display:  DataTable
Controls:      Knob, DropdownSelect
Indicators:    ProgressBar
Embed:         IFrame
```

---

## Phase 9B: SVG Editor Enhancements

**Goal**: Add freehand drawing, interactive path point editing, and SVG child element selection to the canvas editor.

**Duration estimate**: 2-3 weeks
**Dependencies**: Phase 1 (SVG Path widget, PathOverlay)
**Priority**: MEDIUM-HIGH

### 9B.1 Freehand/Pencil Tool

#### Architecture

The freehand tool allows operators to draw curves directly on the SCADA canvas using mouse drag. On mouse-up, the drawn points are simplified and converted to an SVG path widget.

**New state in `store/scada/types.ts`:**

```typescript
export type CanvasToolMode = 'select' | 'pan' | 'pencil';

// In ScadaStore (via selectionSlice or new toolSlice):
interface ToolSlice {
  canvasTool: CanvasToolMode;
  setCanvasTool: (tool: CanvasToolMode) => void;
  /** Temporary pencil stroke points during drawing */
  pencilPoints: Array<{ x: number; y: number }>;
  addPencilPoint: (point: { x: number; y: number }) => void;
  clearPencilPoints: () => void;
  /** Finalize pencil stroke: simplify points, create svgPath widget */
  finalizePencilStroke: () => void;
}
```

**Point simplification algorithm:** Use the Ramer-Douglas-Peucker (RDP) algorithm to reduce the raw mouse points to a manageable set of anchor points. The epsilon parameter controls how aggressively points are reduced (default: 2.0 pixels).

**Conversion to SVG path:** The simplified points are converted to cubic bezier segments using Catmull-Rom spline interpolation, then stored as `PathPoint[]` in a new `svgPath` widget's config.

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `store/scada/toolSlice.ts` | Canvas tool mode state and pencil stroke management | ~120 |
| `components/scada-builder/canvas/PencilOverlay.tsx` | SVG overlay rendering the in-progress stroke | ~80 |
| `components/scada-builder/canvas/pencilUtils.ts` | RDP simplification + Catmull-Rom to cubic bezier conversion | ~150 |

**Modified files:**

| File | Changes |
|------|---------|
| `store/scada/types.ts` | Add `CanvasToolMode` type, `ToolSlice` interface |
| `store/scada/createScadaStore.ts` | Compose `toolSlice` into the store |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add toolbar with pencil/select/pan buttons; render PencilOverlay; handle pointer events for pencil mode |
| `components/scada-builder/WidgetPalette.tsx` | Add pencil tool button in the palette toolbar area |

#### Implementation Details

**PencilOverlay:**

An SVG element overlaid on the ReactFlow canvas (same coordinate space). During drawing, it renders a `<polyline>` with the raw pencil points. On mouse-up, the overlay is hidden and a new `svgPath` widget is created at the bounding box of the simplified points.

**Drawing flow:**
1. User selects pencil tool from toolbar (`setCanvasTool('pencil')`)
2. Canvas enters pencil mode: cursor changes to crosshair
3. `onPointerDown` on canvas: begin stroke, capture pointer
4. `onPointerMove`: add points to `pencilPoints` array (throttled to 60fps)
5. `onPointerUp`: call `finalizePencilStroke()`
6. `finalizePencilStroke`:
   a. Run RDP simplification on raw points
   b. Convert to Catmull-Rom spline control points
   c. Create new `svgPath` widget via `addWidget()` store action
   d. Clear pencil points
   e. Switch tool back to `'select'`
   f. Select the newly created widget

**RDP Algorithm:**

```typescript
function simplifyRDP(points: Array<{x: number; y: number}>, epsilon: number):
  Array<{x: number; y: number}> {
  if (points.length <= 2) return points;
  // Find the point with the maximum distance from the line(first, last)
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyRDP(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}
```

#### Security

- Pencil points are ephemeral local state, not persisted until finalization
- Maximum point count capped at 10,000 to prevent memory issues from very long strokes
- Finalized path points capped at 200 (via RDP epsilon auto-adjustment)

#### Performance

- Raw points collected at 60fps via rAF throttle
- PencilOverlay renders `<polyline>` (single DOM element) for smooth preview
- RDP simplification runs synchronously on mouse-up (sub-1ms for 10K points)
- No re-renders during drawing -- pencilPoints updates bypass React via direct SVG element attribute mutation

#### Testing

| Test File | Coverage |
|-----------|----------|
| `__tests__/canvas/pencilUtils.test.ts` | RDP simplification, Catmull-Rom conversion, point count limits |
| `__tests__/canvas/PencilOverlay.test.tsx` | Renders polyline during draw, clears on finalize |
| `__tests__/store/toolSlice.test.ts` | Tool mode switching, pencil point management |

**Test cases:**
1. RDP simplifies 100 collinear points to 2
2. RDP preserves corner points (high curvature)
3. Catmull-Rom produces smooth cubic bezier control points
4. Point count cap at 10,000 during drawing
5. Finalized path creates svgPath widget with correct position
6. Tool mode resets to 'select' after finalization

#### Agent Prompt: Freehand/Pencil Tool

```
TASK: Implement the freehand/pencil drawing tool for the Suderra SCADA canvas editor.

CONTEXT: The SCADA builder uses ReactFlow for the canvas. The svgPath widget type already exists (Phase 1) with PathPoint[] config. This tool draws freehand curves and converts them to svgPath widgets.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/store/scada/types.ts (store type structure)
2. /var/aqua-saas/web/modules/sensor-module/src/store/scada/createScadaStore.ts (slice composition)
3. /var/aqua-saas/web/modules/sensor-module/src/store/scada/widgetSlice.ts (addWidget action)
4. /var/aqua-saas/web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx (canvas layout)
5. /var/aqua-saas/web/modules/sensor-module/src/types/scada-path.types.ts (PathPoint interface)
6. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SvgPathRenderer.tsx (path rendering)

IMPLEMENTATION:
1. Create store/scada/toolSlice.ts with CanvasToolMode, pencilPoints, addPencilPoint, clearPencilPoints, finalizePencilStroke.
2. Create canvas/pencilUtils.ts with: RDP point simplification, Catmull-Rom to cubic bezier conversion, perpendicularDistance helper.
3. Create canvas/PencilOverlay.tsx: absolute SVG overlay, renders <polyline> from pencilPoints.
4. Modify ScadaPackageBuilderPage.tsx:
   - Add toolbar buttons for select/pencil/pan
   - Add pointer event handlers for pencil mode on the canvas container
   - Render PencilOverlay when tool is 'pencil'
5. Modify createScadaStore.ts to compose toolSlice.
6. Tests for RDP algorithm, Catmull-Rom conversion, tool state management.

CONSTRAINTS:
- No `any` types, English comments
- RDP epsilon default: 2.0 pixels
- Max raw points: 10,000 (truncate after)
- Max finalized points: 200 (auto-adjust epsilon)
- Direct SVG attribute mutation during drawing (bypass React for performance)
- Pointer events (not mouse events) for cross-device support
```

---

### 9B.2 Interactive Path Point Editing

#### Architecture

When an `svgPath` widget is selected in edit mode, an overlay appears showing draggable anchor points and bezier control point handles. This extends the PathOverlay component designed in Phase 1.

**State management:** Path editing state is managed in the existing `selectionSlice` with a new field:

```typescript
interface SelectionSlice {
  // ... existing fields
  /** ID of the widget currently in path-editing mode (double-click to enter) */
  pathEditingWidgetId: string | null;
  setPathEditingWidget: (widgetId: string | null) => void;
}
```

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `components/scada-builder/path-editor/PathPointEditor.tsx` | Main overlay controller with point drag handlers | ~200 |
| `components/scada-builder/path-editor/AnchorHandle.tsx` | Draggable anchor point SVG circle | ~60 |
| `components/scada-builder/path-editor/ControlHandle.tsx` | Draggable bezier control point with connecting line | ~80 |
| `components/scada-builder/path-editor/pathEditorUtils.ts` | Hit testing, midpoint insertion, tangent computation | ~100 |

**Modified files:**

| File | Changes |
|------|---------|
| `store/scada/selectionSlice.ts` | Add `pathEditingWidgetId`, `setPathEditingWidget` |
| `store/scada/types.ts` | Extend `SelectionSlice` interface |
| `nodes/ScadaWidgetNode.tsx` | Double-click handler on svgPath widgets to enter path editing mode |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Render PathPointEditor overlay when `pathEditingWidgetId` is set |

#### Implementation Details

**Entry/exit flow:**
1. Double-click on an `svgPath` widget sets `pathEditingWidgetId` to its ID
2. PathPointEditor reads the widget's `config.points` from the store
3. Overlay renders at the widget's position on the canvas
4. Drag anchor: calls `updateWidgetConfig(widgetId, { points: newPoints })`
5. Drag control handle: updates the `cp1`/`cp2` of the relevant PathPoint
6. Click away or press Escape: sets `pathEditingWidgetId` to null
7. Double-click on path segment midpoint: inserts a new point

**Anchor handles:**
- 8px radius circles at each PathPoint position
- Blue color for regular points, red for the selected/dragging point
- Right-click opens context menu: Delete Point, Change Type (line/cubic/quadratic)

**Control handles:**
- 5px radius circles at `cp1` and `cp2` positions (relative to anchor)
- Connected to their anchor by a thin dashed line
- Only visible for cubic/quadratic point types
- Green color to distinguish from anchor handles

**Coordinate space:** Handles are in the widget's local coordinate space. The PathPointEditor transforms mouse coordinates from canvas space to widget-local space using the widget's position and dimensions.

#### Security

- Point coordinates are clamped to widget bounds (0 to width, 0 to height)
- NaN/Infinity values are rejected in the store update

#### Performance

- Handle positions are computed once per config change (not per frame)
- Drag updates use the store's immer middleware for efficient patching
- Only the dragged point's coordinates change per frame

#### Testing

1. Double-click enters path editing mode
2. Drag anchor point updates PathPoint position
3. Drag control handle updates cp1/cp2
4. Click midpoint inserts new point
5. Right-click > Delete removes point
6. Escape exits path editing mode
7. Coordinate clamping prevents out-of-bounds points

#### Agent Prompt: Interactive Path Point Editing

```
TASK: Implement interactive path point editing with draggable anchor and control point handles.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-path.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SvgPathRenderer.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/store/scada/selectionSlice.ts
4. /var/aqua-saas/web/modules/sensor-module/src/store/scada/types.ts
5. /var/aqua-saas/web/modules/sensor-module/src/store/scada/widgetSlice.ts (updateWidgetConfig)
6. /var/aqua-saas/web/modules/sensor-module/src/nodes/ScadaWidgetNode.tsx (widget node rendering)
7. /var/aqua-saas/web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx

IMPLEMENTATION:
1. Add pathEditingWidgetId to selectionSlice and types.
2. Create path-editor/PathPointEditor.tsx: overlay SVG rendering anchor and control handles.
3. Create path-editor/AnchorHandle.tsx: draggable circle with pointer events.
4. Create path-editor/ControlHandle.tsx: draggable circle with dashed line to anchor.
5. Create path-editor/pathEditorUtils.ts: canvas-to-widget coordinate transform, midpoint calculation, hit testing.
6. Wire double-click on svgPath widgets in ScadaWidgetNode to enter editing mode.
7. Wire Escape key and click-outside to exit editing mode.
8. Tests for drag, insert, delete, coordinate transform.

CONSTRAINTS:
- No `any` types, English comments
- Coordinates clamped to [0, widgetWidth] and [0, widgetHeight]
- Use pointer events for cross-device support
- Maximum 200 points per path widget (enforced in insert)
```

---

### 9B.3 SVG Child Element Selection

#### Architecture

When a `customSvg` widget is double-clicked, the editor enters a sub-element selection mode. The SVG's child elements (`<rect>`, `<circle>`, `<path>`, `<text>`, etc.) become individually selectable, allowing the operator to attach animations or events to specific child elements rather than the entire widget.

**New interface:**

```typescript
// In types/scada-svg-subelement.types.ts
export interface SvgSubElementSelection {
  /** Widget ID of the customSvg widget being edited */
  widgetId: string;
  /** CSS selector path to the selected child element (e.g., '#motor-blade', 'g:nth-child(2) > rect') */
  elementSelector: string;
  /** Computed bounding box of the selected element */
  bounds: { x: number; y: number; width: number; height: number };
}

export interface SvgSubElementBinding {
  /** CSS selector for the target child element */
  selector: string;
  /** Animation rules specific to this child element */
  animations: AnimationRule[];
  /** Event definitions specific to this child element */
  events: WidgetEventDef[];
}
```

**Config extension for customSvg:**

```typescript
// Addition to customSvg widget config
interface CustomSvgExtendedConfig {
  // ... existing fields (svgContent, sanitized, etc.)
  /** Per-child-element animation and event bindings */
  subElementBindings?: SvgSubElementBinding[];
}
```

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-svg-subelement.types.ts` | SvgSubElementSelection, SvgSubElementBinding | ~40 |
| `components/scada-builder/svg-editor/SvgSubElementOverlay.tsx` | Highlight overlay on selected child element | ~120 |
| `components/scada-builder/svg-editor/SvgElementPicker.tsx` | Click handler + element enumeration for child selection | ~150 |
| `components/scada-builder/svg-editor/SubElementPropertiesPanel.tsx` | Animation/event editors for selected sub-element | ~200 |

**Modified files:**

| File | Changes |
|------|---------|
| `store/scada/selectionSlice.ts` | Add `svgSubElementSelection: SvgSubElementSelection | null` |
| `nodes/ScadaWidgetNode.tsx` | Double-click on customSvg enters sub-element mode |
| `widget-renderers/CustomSvgRenderer.tsx` | Apply sub-element animation bindings at runtime |
| `PropertiesPanel.tsx` | Show SubElementPropertiesPanel when sub-element is selected |

#### Implementation Details

**Element enumeration:**
When entering sub-element mode, `SvgElementPicker` parses the sanitized SVG content and builds a list of selectable elements. Only elements with geometric content are listed: `rect`, `circle`, `ellipse`, `path`, `polygon`, `polyline`, `text`, `image`, `line`, `g` (groups). Each element is identified by:
1. Its `id` attribute (preferred, most stable)
2. A computed CSS selector path (fallback: `svg > g:nth-child(2) > rect:nth-child(1)`)

**Selection flow:**
1. Double-click customSvg widget enters sub-element mode
2. Hovering over child elements shows a blue highlight outline
3. Clicking a child element selects it (cyan outline + resize handles)
4. Properties panel switches to SubElementPropertiesPanel
5. Operator can add animations/events to the selected sub-element
6. Bindings are stored in `config.subElementBindings[]`
7. Click outside or Escape exits sub-element mode

**Runtime application:**
At runtime, `CustomSvgRenderer` iterates `subElementBindings` and applies CSS animations/styles to each targeted element via `document.querySelector` within the SVG container. This is done in a `useEffect` after the SVG is mounted in the DOM.

#### Security

- Element selectors are sanitized to prevent CSS injection
- Only pre-defined selector patterns are allowed (no arbitrary CSS)
- Sub-element animations go through the same AnimationEngine validation as widget-level animations

#### Performance

- Element enumeration runs once on entering sub-element mode
- Highlight overlay uses a single `<rect>` element repositioned on hover (no DOM walking per frame)
- Runtime sub-element styling uses CSS classes injected once, not per-frame DOM mutations

#### Testing

1. Double-click customSvg enters sub-element mode
2. Hovering highlights child elements
3. Click selects child element
4. Animation added to sub-element persists in config
5. Runtime applies sub-element animations
6. Escape exits sub-element mode
7. Selector generation produces stable selectors for elements with IDs
8. Selector generation works for elements without IDs (nth-child fallback)

#### Agent Prompt: SVG Child Element Selection

```
TASK: Implement SVG child element selection mode for customSvg widgets in the SCADA builder.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/CustomSvgRenderer.tsx
2. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-configs/CustomSvgConfig.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/engine/animation/types.ts
4. /var/aqua-saas/web/modules/sensor-module/src/engine/events/types.ts
5. /var/aqua-saas/web/modules/sensor-module/src/store/scada/selectionSlice.ts
6. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx

IMPLEMENTATION:
1. Create types/scada-svg-subelement.types.ts with SvgSubElementSelection and SvgSubElementBinding.
2. Add svgSubElementSelection to selectionSlice.
3. Create svg-editor/SvgElementPicker.tsx: parses SVG DOM, enumerates selectable elements, handles hover/click for selection.
4. Create svg-editor/SvgSubElementOverlay.tsx: renders highlight rectangle over hovered/selected elements.
5. Create svg-editor/SubElementPropertiesPanel.tsx: animation rule editor and event editor scoped to selected sub-element.
6. Modify CustomSvgRenderer.tsx: apply subElementBindings at runtime via useEffect + CSS class injection.
7. Modify ScadaWidgetNode.tsx: double-click on customSvg enters sub-element mode.
8. Tests for element enumeration, selector generation, binding persistence, runtime application.

CONSTRAINTS:
- No `any` types, English comments
- Selectors must be stable (prefer id-based, fallback to nth-child)
- Maximum 50 sub-element bindings per customSvg widget
- All SVG manipulation must go through DOMPurify-sanitized content
- No direct innerHTML manipulation at runtime
```

---

## Phase 9C: Animation & Event Enhancements

**Goal**: Extend the animation engine with five new capabilities: video playback control, opacity animation, text value formatting, setProperty event action, and closeDialog event action.

**Duration estimate**: 1.5-2 weeks
**Dependencies**: Phase 3 (animation engine), Phase 5 (scripting/events)
**Priority**: MEDIUM

### 9C.1 Video Playback Animation

#### Architecture

A new animation rule type `videoPlayback` that controls a videoStream widget's playback state (play/pause/stop) based on a tag value.

**Type additions to `engine/animation/types.ts`:**

```typescript
// Add to AnimationRuleType union:
| 'videoPlayback'

// Add to AnimationOptions:
/** videoPlayback: action to perform when tag is in range */
videoAction?: 'play' | 'pause' | 'stop';

// Add to AnimationState:
/** Video playback command (consumed by VideoStreamRenderer) */
videoCommand?: 'play' | 'pause' | 'stop';
```

**Integration:** The `AnimationEngine.evaluate()` function gets a new case for `videoPlayback`. The `VideoStreamRenderer` reads `animationState.videoCommand` and calls the `<video>` element's `.play()`, `.pause()`, or sets `currentTime = 0` accordingly.

#### File Structure

**Modified files:**

| File | Changes |
|------|---------|
| `engine/animation/types.ts` | Add `videoPlayback` to union, `videoAction` to options, `videoCommand` to state |
| `engine/animation/AnimationEngine.ts` | Add `case 'videoPlayback'` in evaluate() |
| `widget-renderers/VideoStreamRenderer.tsx` | Read `animationState.videoCommand`, control `<video>` element |

No new files needed.

#### Implementation Details

**AnimationEngine addition:**

```typescript
case 'videoPlayback': {
  state.videoCommand = opts.videoAction ?? 'play';
  break;
}
```

**VideoStreamRenderer addition:**

```typescript
const videoRef = useRef<HTMLVideoElement>(null);

useEffect(() => {
  const video = videoRef.current;
  if (!video || !animationState?.videoCommand) return;

  switch (animationState.videoCommand) {
    case 'play':
      video.play().catch(() => { /* autoplay policy may block */ });
      break;
    case 'pause':
      video.pause();
      break;
    case 'stop':
      video.pause();
      video.currentTime = 0;
      break;
  }
}, [animationState?.videoCommand]);
```

#### Testing

1. Tag in range triggers video play
2. Tag out of range stops video
3. Multiple rules: play in range [1,1], pause in range [0,0]
4. Stop resets currentTime to 0
5. Autoplay blocked by browser policy does not throw unhandled rejection

---

### 9C.2 Opacity Animation Rule

#### Architecture

A new animation rule type `opacity` that smoothly transitions a widget's opacity between two values based on a tag value's position within a range.

**Type additions:**

```typescript
// Add to AnimationRuleType:
| 'opacity'

// Add to AnimationOptions:
/** opacity: minimum opacity (0-1) when tag equals range.min */
opacityMin?: number;
/** opacity: maximum opacity (0-1) when tag equals range.max */
opacityMax?: number;
/** opacity: transition duration in ms */
opacityTransitionMs?: number;

// Add to AnimationState:
/** Computed opacity value (0-1) */
opacity?: number;
/** Opacity transition duration in ms */
opacityTransitionMs?: number;
```

**AnimationEngine addition:**

```typescript
case 'opacity': {
  const oMin = opts.opacityMin ?? 0;
  const oMax = opts.opacityMax ?? 1;
  const oTagMin = rule.range.min;
  const oTagMax = rule.range.max;
  const oRatio = oTagMax !== oTagMin
    ? (effective - oTagMin) / (oTagMax - oTagMin)
    : 0;
  const oClamped = Math.max(0, Math.min(1, oRatio));
  state.opacity = oMin + oClamped * (oMax - oMin);
  state.opacityTransitionMs = opts.opacityTransitionMs ?? 300;
  break;
}
```

**Consumer:** `ScadaWidgetNode.tsx` reads `animationState.opacity` and applies it to the container's `style.opacity` with a CSS `transition: opacity ${ms}ms ease-in-out`.

#### Testing

1. Tag at range.min produces opacityMin
2. Tag at range.max produces opacityMax
3. Tag at midpoint produces linear interpolation
4. Transition applies smoothly (CSS transition property set)
5. Default values: opacityMin=0, opacityMax=1, transition=300ms

---

### 9C.3 Text Value Format

#### Architecture

A new animation rule type `textFormat` that displays a formatted tag value as the text content of an `svgText` widget. This enables showing real-time values with engineering unit formatting (e.g., "Temperature: 24.5 C").

**Type additions:**

```typescript
// Add to AnimationRuleType:
| 'textFormat'

// Add to AnimationOptions:
/** textFormat: printf-style format template (e.g., 'Temp: %.1f C') */
formatTemplate?: string;

// Add to AnimationState:
/** Formatted text string for display */
formattedText?: string;
```

**AnimationEngine addition:**

```typescript
case 'textFormat': {
  const template = opts.formatTemplate ?? '%.2f';
  state.formattedText = applyFormat(template, effective);
  break;
}
```

**`applyFormat` utility function:**

```typescript
function applyFormat(template: string, value: number): string {
  return template.replace(/%(\.\d+)?[dfegs]/g, (match) => {
    if (match.endsWith('d')) return Math.round(value).toString();
    if (match.endsWith('f')) {
      const decimals = match.match(/\.(\d+)/);
      return value.toFixed(decimals ? parseInt(decimals[1]) : 2);
    }
    if (match.endsWith('e')) return value.toExponential();
    if (match.endsWith('g')) return value.toPrecision();
    if (match.endsWith('s')) return String(value);
    return match;
  });
}
```

**Consumer:** `SvgTextRenderer.tsx` reads `animationState.formattedText` and uses it as the `<text>` element's content when present.

#### Security

- Format template only supports `%` specifiers (no arbitrary code execution)
- Template is not evaluated via `eval` or `Function()`
- Output is rendered via React text content (auto-escaped)

#### Testing

1. `%.2f` with value 24.567 produces "24.57"
2. `%d` with value 24.567 produces "25"
3. `Temperature: %.1f C` produces "Temperature: 24.6 C"
4. `%e` produces scientific notation
5. Template without `%` specifier returns template as-is
6. NaN value produces "NaN" string (no crash)

---

### 9C.4 setProperty Event Action

#### Architecture

A new event action type `setProperty` that allows changing any widget config property via an event trigger. This enables dynamic UI behavior like changing a widget's color, label, or visibility based on operator interaction.

**Type additions to `engine/events/types.ts`:**

```typescript
// Add to EventAction:
| 'setProperty'

// Add to EventParams:
/** setProperty: target widget ID (default = self) */
targetWidgetId?: string;
/** setProperty: property path in the config object (e.g., 'fillColor', 'label') */
propertyPath?: string;
/** setProperty: value to set */
propertyValue?: unknown;
```

**New handler in `engine/events/handlers/`:**

```typescript
// SetPropertyHandler.ts
export function createSetPropertyHandler(
  updateWidgetConfig: (widgetId: string, updates: Record<string, unknown>) => void
): EventHandler {
  return (event: WidgetEventPayload) => {
    const { targetWidgetId, propertyPath, propertyValue } = event.params;
    const widgetId = targetWidgetId || event.widgetId;
    if (!propertyPath || propertyValue === undefined) return;

    // Only allow top-level config properties (no nested path traversal for security)
    if (propertyPath.includes('.') || propertyPath.includes('[')) {
      console.warn('[SCADA] setProperty: nested paths are not allowed for security');
      return;
    }

    updateWidgetConfig(widgetId, { [propertyPath]: propertyValue });
  };
}
```

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `engine/events/handlers/SetPropertyHandler.ts` | Event handler for setProperty action | ~40 |

**Modified files:**

| File | Changes |
|------|---------|
| `engine/events/types.ts` | Add `'setProperty'` to EventAction, add params |
| `engine/ScadaRuntime.tsx` | Register SetPropertyHandler |

#### Security

- Only top-level config properties can be set (no nested path traversal)
- Property paths with `.` or `[` are rejected to prevent prototype pollution
- The handler does not evaluate property values as code
- Widget ID is validated against the current screen's widget list

#### Testing

1. Click triggers setProperty on self widget
2. Click triggers setProperty on another widget
3. Nested property path is rejected
4. Missing propertyPath is silently ignored
5. Property value persists after event

---

### 9C.5 closeDialog Event Action

#### Architecture

A new event action type `closeDialog` that programmatically closes an opened card/dialog overlay.

**Type additions:**

```typescript
// Add to EventAction:
| 'closeDialog'

// Add to EventParams:
/** closeDialog: ID of the dialog/overlay to close (default = closest parent overlay) */
dialogId?: string;
```

**New handler:**

```typescript
// CloseDialogHandler.ts
export function createCloseDialogHandler(
  closeOverlay: (overlayId?: string) => void
): EventHandler {
  return (event: WidgetEventPayload) => {
    closeOverlay(event.params.dialogId);
  };
}
```

#### File Structure

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `engine/events/handlers/CloseDialogHandler.ts` | Event handler for closeDialog action | ~20 |

**Modified files:**

| File | Changes |
|------|---------|
| `engine/events/types.ts` | Add `'closeDialog'` to EventAction, add `dialogId` param |
| `engine/ScadaRuntime.tsx` | Register CloseDialogHandler |
| `store/scada/viewManagerSlice.ts` | Add `closeOverlay(id?: string)` action if not present |

#### Testing

1. closeDialog event closes the most recent overlay
2. closeDialog with specific dialogId closes that overlay
3. closeDialog with invalid ID is silently ignored
4. Multiple overlays: closing one preserves others

---

### 9C Agent Prompts Summary

```
TASK: Implement five animation and event enhancements for the SCADA builder.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/engine/animation/types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/engine/animation/AnimationEngine.ts
3. /var/aqua-saas/web/modules/sensor-module/src/engine/events/types.ts
4. /var/aqua-saas/web/modules/sensor-module/src/engine/events/WidgetEventBus.ts
5. /var/aqua-saas/web/modules/sensor-module/src/engine/events/handlers/ (all handler files)
6. /var/aqua-saas/web/modules/sensor-module/src/engine/ScadaRuntime.tsx
7. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/nodes/ScadaWidgetNode.tsx
8. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/VideoStreamRenderer.tsx
9. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/SvgTextRenderer.tsx

FEATURES TO IMPLEMENT:
1. videoPlayback animation rule (AnimationEngine + VideoStreamRenderer)
2. opacity animation rule (AnimationEngine + ScadaWidgetNode CSS)
3. textFormat animation rule (AnimationEngine + SvgTextRenderer)
4. setProperty event action (new handler + types + runtime registration)
5. closeDialog event action (new handler + types + runtime registration)

For each feature:
- Add types to animation/types.ts or events/types.ts
- Add evaluate case in AnimationEngine.ts
- Add consumer code in the appropriate renderer or ScadaWidgetNode
- Add handler in events/handlers/ and register in ScadaRuntime.tsx
- Write tests

CONSTRAINTS:
- No `any` types, English comments
- Format template evaluation must NOT use eval/Function
- setProperty must reject nested paths (security)
- All animation state fields are optional with sensible defaults
```

---

## Phase 9D: Scripting Extensions

**Goal**: Extend the Web Worker scripting sandbox with four new API methods and add a scheduling configuration UI.

**Duration estimate**: 1-2 weeks
**Dependencies**: Phase 5 (scripting system complete)
**Priority**: MEDIUM

### 9D.1 $setProperty(widgetId, prop, value)

#### Architecture

A new sandbox API method that allows scripts to change widget config properties at runtime. This mirrors the `setProperty` event action (9C.4) but is callable from script code.

**Type additions to `engine/scripting/types.ts`:**

```typescript
// Add to ScriptSandboxAPI:
/** Change a widget's config property at runtime */
$setProperty: (widgetId: string, prop: string, value: TagPrimitive) => void;
```

**Worker-side implementation (workerScript.ts):**
The worker's `$setProperty` proxy sends an `api-call` message with method `'$setProperty'` and args `[widgetId, prop, value]`.

**Main-thread handler (ScriptExecutor.ts):**

```typescript
case '$setProperty': {
  const [widgetId, prop, val] = apiArgs as [string, string, TagPrimitive];
  if (typeof widgetId !== 'string' || typeof prop !== 'string') break;
  if (prop.includes('.') || prop.includes('[')) break; // Security: no nested paths
  // Route through store
  this.onSetProperty?.(widgetId, prop, val);
  break;
}
```

**Integration:** `ScriptExecutor` constructor receives an `onSetProperty` callback that routes to `useScadaStore.getState().updateWidgetConfig()`.

#### Security

- Only top-level config properties allowed (same restriction as 9C.4)
- Property values must be `TagPrimitive` (number, string, boolean) -- no objects/arrays
- Widget ID is validated against the current screen
- Rate limited by the existing `SANDBOX_LIMITS.MAX_TAG_WRITES` counter (shares the write budget)

#### Testing

1. Script calls `$setProperty('widget-1', 'fillColor', '#ff0000')` -- widget config updates
2. Nested property path rejected
3. Object value rejected (only primitives allowed)
4. Rate limiting applies (counts against MAX_TAG_WRITES)

---

### 9D.2 $getProperty(widgetId, prop)

#### Architecture

A new sandbox API method that reads a widget's config property from within a script.

**Type additions:**

```typescript
// Add to ScriptSandboxAPI:
/** Read a widget's config property */
$getProperty: (widgetId: string, prop: string) => TagPrimitive;
```

**Implementation:** Unlike `$setProperty` (which is fire-and-forget via postMessage), `$getProperty` needs to return a value synchronously to the script. Since Web Worker message passing is asynchronous, we use a **pre-populated snapshot** approach: before executing the script, the main thread builds a `widgetProperties` snapshot alongside the `tagValues` snapshot. The worker's `$getProperty` reads from this local snapshot.

**WorkerRequest extension:**

```typescript
export interface WorkerRequest {
  // ... existing fields
  /** Snapshot of widget config properties for $getProperty access */
  widgetProperties?: Record<string, Record<string, TagPrimitive>>;
}
```

**Snapshot building (ScriptExecutor):**

```typescript
private getWidgetPropertySnapshot(): Record<string, Record<string, TagPrimitive>> {
  const screen = this.getActiveScreen?.();
  if (!screen) return {};
  const snapshot: Record<string, Record<string, TagPrimitive>> = {};
  for (const widget of screen.widgets) {
    const props: Record<string, TagPrimitive> = {};
    for (const [key, val] of Object.entries(widget.config)) {
      if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') {
        props[key] = val;
      }
    }
    snapshot[widget.id] = props;
  }
  return snapshot;
}
```

#### Security

- Only `TagPrimitive` values are exposed (no objects, functions, or nested structures)
- Widget properties are read-only snapshots (no live references to store state)
- Snapshot is filtered: only config fields with primitive values are included

#### Testing

1. `$getProperty('widget-1', 'fillColor')` returns the widget's fillColor
2. Non-existent widget returns undefined
3. Non-existent property returns undefined
4. Object/array properties are excluded from snapshot

---

### 9D.3 $closeDialog()

#### Architecture

A new sandbox API method to close the current dialog/card overlay from script code.

**Type additions:**

```typescript
// Add to ScriptSandboxAPI:
/** Close the current dialog/card overlay */
$closeDialog: () => void;
```

**Implementation:** Routes through the WidgetEventBus as a `closeDialog` action (reusing the handler from 9C.5).

```typescript
case '$closeDialog': {
  this.eventBus.dispatch({
    widgetId: '__script__',
    screenId: '',
    action: 'closeDialog',
    params: {},
  });
  break;
}
```

#### Testing

1. Script calls `$closeDialog()` -- most recent overlay closes
2. No overlay open -- silently ignored

---

### 9D.4 $setAlarm(tagName, level, message)

#### Architecture

A new sandbox API method to raise an alarm from script code. This enables scripts to implement custom alarm logic beyond simple threshold comparisons.

**Type additions:**

```typescript
// Add to ScriptSandboxAPI:
/** Raise a script-generated alarm */
$setAlarm: (tagName: string, level: 'critical' | 'high' | 'warning' | 'info', message: string) => void;
```

**Implementation:** The main thread handler validates the alarm level and publishes it to the alarm bus (or creates a store action if the alarm bus is not yet implemented).

```typescript
case '$setAlarm': {
  const [tagName, level, message] = apiArgs as [string, string, string];
  if (typeof tagName !== 'string' || typeof message !== 'string') break;
  const validLevels = ['critical', 'high', 'warning', 'info'];
  if (!validLevels.includes(level)) break;
  if (message.length > 500) break; // Prevent abuse
  this.onAlarm?.(tagName, level as 'critical' | 'high' | 'warning' | 'info', message);
  break;
}
```

**Integration:** `ScriptExecutor` receives an `onAlarm` callback that routes to the alarm store slice's `addScriptAlarm()` action.

#### Security

- Alarm level must be one of the four valid levels
- Message length capped at 500 characters
- Rate limited by script execution limits (one execution produces at most one alarm)
- Alarm messages are displayed as text content (not HTML)

#### Testing

1. `$setAlarm('pH', 'critical', 'pH below safe threshold')` adds alarm to store
2. Invalid level is rejected
3. Message longer than 500 chars is rejected
4. Alarm appears in AlarmBanner/AlarmList widgets

---

### 9D.5 Script Scheduling UI

#### Architecture

The `ScadaScript` type already supports `interval` and `tagChange` triggers. This task adds a proper UI for configuring script schedules within the SCADA builder.

**File Structure:**

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `components/scada-builder/scripting/ScriptScheduleConfig.tsx` | Schedule configuration panel with interval/trigger settings | ~180 |
| `components/scada-builder/scripting/ScriptListPanel.tsx` | Package-level script list with enable/disable toggles | ~200 |

**Modified files:**

| File | Changes |
|------|---------|
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "Scripts" tab in the side panel |
| `store/scada/projectSlice.ts` | Add `addScript`, `updateScript`, `removeScript`, `toggleScript` actions |

#### Implementation Details

**ScriptScheduleConfig:**

```typescript
interface ScriptScheduleConfigProps {
  script: ScadaScript;
  onChange: (updates: Partial<ScadaScript>) => void;
}
```

Renders:
- Trigger type selector (event, tagChange, interval, load)
- For `tagChange`: TagBrowser to select the trigger tag
- For `interval`: numeric input with minimum 1000ms enforcement
- Enabled/disabled toggle
- Code editor placeholder (textarea with monospace font, syntax highlighting is a future enhancement)

**ScriptListPanel:**

Shows all package-level scripts in a list with:
- Script name (editable inline)
- Trigger type badge (event/tagChange/interval/load)
- Enabled toggle
- Edit button (opens ScriptScheduleConfig in a slide-out panel)
- Delete button (with confirmation dialog)
- Add Script button

#### Testing

1. Add new script appears in list
2. Toggle enabled/disabled updates script.enabled
3. Interval trigger enforces minimum 1000ms
4. tagChange trigger requires tag selection
5. Delete script with confirmation
6. Script list persists in package JSON

#### Agent Prompt: Scripting Extensions

```
TASK: Extend the SCADA scripting sandbox with 4 new API methods and add a scheduling UI.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/engine/scripting/types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/engine/scripting/ScriptExecutor.ts
3. /var/aqua-saas/web/modules/sensor-module/src/engine/scripting/workerScript.ts
4. /var/aqua-saas/web/modules/sensor-module/src/engine/scripting/useScriptEngine.ts
5. /var/aqua-saas/web/modules/sensor-module/src/engine/events/types.ts
6. /var/aqua-saas/web/modules/sensor-module/src/store/scada/projectSlice.ts
7. /var/aqua-saas/web/modules/sensor-module/src/store/scada/alarmSlice.ts

NEW API METHODS:
1. $setProperty(widgetId, prop, value) -- change widget config (fire-and-forget via postMessage)
2. $getProperty(widgetId, prop) -- read widget config (pre-populated snapshot, synchronous in worker)
3. $closeDialog() -- close current dialog (routes to WidgetEventBus)
4. $setAlarm(tagName, level, message) -- raise alarm (routes to alarm store)

SCHEDULING UI:
5. ScriptListPanel.tsx: list of package scripts with CRUD
6. ScriptScheduleConfig.tsx: trigger type config (interval/tagChange/event/load)
7. Add to ScadaPackageBuilderPage.tsx as a "Scripts" tab

For each API method:
- Add type to ScriptSandboxAPI in scripting/types.ts
- Add worker-side proxy in workerScript.ts
- Add main-thread handler in ScriptExecutor.ts
- Write tests

CONSTRAINTS:
- No `any` types, English comments
- $setProperty: only top-level string props, TagPrimitive values only
- $getProperty: uses snapshot approach (not async postMessage round-trip)
- $setAlarm: level validated, message capped at 500 chars
- All API methods rate-limited by existing SANDBOX_LIMITS
- Script scheduling minimum interval: 1000ms (enforced in UI and executor)
```

---

## Phase 9E: Platform Features

**Goal**: Add five platform-level capabilities for production SCADA deployments: PNG/PDF export, live tag watch window, recipe management, DAQ configuration, and i18n for view labels.

**Duration estimate**: 2-3 weeks
**Dependencies**: None (can start immediately, independent of 9A-9D)
**Priority**: MEDIUM

### 9E.1 PNG/PDF Export

#### Architecture

Export the current SCADA view as a PNG image or PDF document. Uses the browser's native Canvas API for PNG and a lightweight PDF generation approach.

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `engine/export/ViewExporter.ts` | Export orchestrator: captures SVG+HTML to canvas, converts to PNG/PDF | ~200 |
| `engine/export/pdfBuilder.ts` | Minimal PDF builder (no library -- uses raw PDF spec for single-page documents) | ~180 |
| `components/scada-builder/ExportDialog.tsx` | Export settings dialog (format, resolution, filename) | ~120 |

**Modified files:**

| File | Changes |
|------|---------|
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "Export" button in toolbar |

#### Implementation Details

**PNG export flow:**
1. Clone the ReactFlow viewport DOM subtree
2. Inline all computed CSS styles
3. Serialize to SVG via `XMLSerializer`
4. Draw SVG onto `<canvas>` via `canvasCtx.drawImage(svgImage, 0, 0)`
5. Convert canvas to PNG via `canvas.toBlob('image/png')`
6. Trigger browser download via `URL.createObjectURL` + `<a>` click

**PDF export flow:**
1. Generate PNG as above
2. Build minimal PDF document:
   - PDF header, catalog, page tree, page (dimensions matching viewport)
   - Image XObject referencing the PNG data
   - Cross-reference table and trailer
3. Output as Blob and trigger download

**Alternative consideration:** If the raw PDF builder proves too complex, fall back to `window.print()` with `@media print` CSS rules that hide non-viewport elements. This produces browser-native PDF via the print dialog.

**Export settings:**
- Format: PNG or PDF
- Resolution: 1x, 2x, 3x (DPR multiplier for high-res export)
- Background: include canvas background or transparent
- Filename: auto-generated from `packageName + screenName + timestamp`

#### Security

- Export operates entirely client-side (no server round-trip)
- Exported content is the user's own SCADA view (no cross-tenant data)
- No external URLs are fetched during export (all content is already loaded)

#### Performance

- Canvas rendering is synchronous and blocks the main thread. For large views (100+ widgets), show a progress indicator.
- 2x DPR export doubles memory usage. Cap at 3x (8000x6000 max canvas size).

#### Testing

1. PNG export produces valid PNG blob
2. PDF export produces valid PDF blob (starts with %PDF-1.4)
3. 2x resolution export is 2x pixel dimensions
4. Export includes all visible widgets
5. Hidden widgets are excluded from export

#### Agent Prompt: PNG/PDF Export

```
TASK: Implement PNG and PDF export for SCADA views.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx
2. /var/aqua-saas/web/modules/sensor-module/src/engine/ScadaRuntime.tsx

IMPLEMENTATION:
1. Create engine/export/ViewExporter.ts:
   - exportPng(container: HTMLElement, options: ExportOptions): Promise<Blob>
   - exportPdf(container: HTMLElement, options: ExportOptions): Promise<Blob>
   - Uses DOM cloning + CSS inlining + XMLSerializer + Canvas API
2. Create engine/export/pdfBuilder.ts:
   - buildPdf(pngData: ArrayBuffer, width: number, height: number): Uint8Array
   - Minimal PDF 1.4 spec: header, catalog, pages, page, image XObject, xref, trailer
3. Create ExportDialog.tsx: format selector, resolution selector, filename input, export button.
4. Add "Export" button to builder toolbar.
5. Tests: PNG blob validity, PDF header validity, resolution scaling, hidden widget exclusion.

CONSTRAINTS:
- No `any` types, English comments
- No npm dependencies for PDF (raw PDF spec implementation)
- Max canvas size: 8000x6000 pixels
- Client-side only (no server round-trip)
- Show progress indicator for large views
```

---

### 9E.2 Live Tag Watch Window

#### Architecture

A debug panel that shows all tag values in real-time, updated as they change through the TagValueBus. Essential for commissioning and troubleshooting SCADA views.

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `components/scada-builder/debug/TagWatchPanel.tsx` | Main watch window component | ~250 |
| `components/scada-builder/debug/TagWatchEntry.tsx` | Single tag entry with value, type, and sparkline | ~80 |
| `components/scada-builder/debug/useTagWatch.ts` | Hook that subscribes to TagValueBus and collects all tag updates | ~60 |

**Modified files:**

| File | Changes |
|------|---------|
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "Tag Watch" toggle button in toolbar; render TagWatchPanel as bottom drawer |

#### Implementation Details

**TagWatchPanel:**
- Bottom drawer that slides up from the bottom of the viewport
- Resizable height (drag handle)
- Columns: Tag Name, Current Value, Type (number/string/boolean), Last Updated (timestamp), Sparkline (last 30 values for numbers)
- Search/filter input at the top
- Sort by name, value, or last updated
- Pin specific tags to the top of the list
- Export tag snapshot as CSV

**useTagWatch hook:**

```typescript
function useTagWatch(tagBus: TagValueBus): TagWatchEntry[] {
  const [entries, setEntries] = useState<Map<string, TagWatchEntry>>(new Map());

  useEffect(() => {
    const handler = (tagName: string, value: unknown) => {
      setEntries(prev => {
        const next = new Map(prev);
        const existing = next.get(tagName);
        const history = existing?.history ?? [];
        if (typeof value === 'number') {
          history.push(value);
          if (history.length > 30) history.shift();
        }
        next.set(tagName, {
          tagName,
          value,
          type: typeof value,
          lastUpdated: Date.now(),
          history,
        });
        return next;
      });
    };
    return tagBus.subscribeAll(handler);
  }, [tagBus]);

  return useMemo(() => [...entries.values()], [entries]);
}
```

**Note:** `TagValueBus.subscribeAll` may not exist yet. If not, add it: a new method that registers a listener for all tag changes (wildcard subscription).

#### Performance

- Tag entries are virtualized (only visible rows rendered)
- Sparkline uses a simple `<svg>` polyline (30 points max)
- Update batching: collect updates for 100ms before re-rendering the list

#### Testing

1. New tag value appears in watch list
2. Existing tag updates show new value
3. Sparkline shows last 30 numeric values
4. Search filters tags by name
5. Pin keeps tag at top of list
6. CSV export contains all current tag values

#### Agent Prompt: Live Tag Watch Window

```
TASK: Implement a live tag watch debug panel for the SCADA builder.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/engine/tags/TagValueBus.ts
2. /var/aqua-saas/web/modules/sensor-module/src/engine/ScadaRuntime.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/pages/scada/ScadaPackageBuilderPage.tsx

IMPLEMENTATION:
1. If TagValueBus lacks subscribeAll(), add it: registers wildcard listener for all tag changes.
2. Create debug/useTagWatch.ts: hook subscribing to all tag changes, maintaining value + history + timestamp map.
3. Create debug/TagWatchEntry.tsx: row component with name, value, type, timestamp, SVG sparkline.
4. Create debug/TagWatchPanel.tsx: bottom drawer with search, sort, pin, CSV export, virtualized list.
5. Add "Tag Watch" toggle to builder toolbar.
6. Tests for subscription, update display, sparkline, search, CSV export.

CONSTRAINTS:
- No `any` types, English comments
- Virtualize the tag list (only visible rows in DOM)
- Batch updates: 100ms collection window before re-render
- Sparkline: max 30 points, SVG polyline
- CSV export uses Blob + download link (no server)
```

---

### 9E.3 Recipe Management

#### Architecture

Recipes are named sets of tag values that can be saved and loaded to quickly configure equipment parameters. An operator saves the current tag state as a "recipe" and can later load it to restore those values.

**New types:**

```typescript
// In types/scada-recipe.types.ts
export interface RecipeParameter {
  tagName: string;
  value: number | string | boolean;
  label: string;
  unit: string;
}

export interface ScadaRecipe {
  id: string;
  name: string;
  description: string;
  parameters: RecipeParameter[];
  createdAt: string;
  updatedAt: string;
}
```

**Storage:** Recipes are stored in the `ScadaPackageData`:

```typescript
// Addition to ScadaPackageData in scada-package.types.ts
export interface ScadaPackageData {
  // ... existing fields
  /** Saved parameter recipes for quick equipment configuration */
  recipes?: ScadaRecipe[];
}
```

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-recipe.types.ts` | ScadaRecipe, RecipeParameter interfaces | ~30 |
| `components/scada-builder/recipes/RecipeManagerPanel.tsx` | Recipe list with save/load/delete controls | ~200 |
| `components/scada-builder/recipes/RecipeEditor.tsx` | Recipe name, description, parameter list editor | ~150 |
| `store/scada/recipeSlice.ts` | Recipe CRUD actions | ~100 |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-package.types.ts` | Add `recipes?: ScadaRecipe[]` to `ScadaPackageData` |
| `store/scada/types.ts` | Add `RecipeSlice` interface |
| `store/scada/createScadaStore.ts` | Compose `recipeSlice` |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "Recipes" tab in side panel |

#### Implementation Details

**Save recipe:**
1. Open RecipeEditor with the current tag values pre-populated
2. Operator names the recipe, adds description, can modify values
3. Save creates a new `ScadaRecipe` in the store
4. Recipe persists in the package JSON

**Load recipe:**
1. Select a recipe from RecipeManagerPanel
2. Confirm dialog: "This will write N tag values. Continue?"
3. On confirm: iterate recipe parameters, call `tagBus.publish(tagName, value)` for each
4. Tag values propagate to all subscribed widgets

**Security:**
- Recipe loading requires confirmation (prevents accidental parameter changes)
- Tag names are validated against the known tag list
- Recipe storage is scoped to the package (tenant isolation via package ownership)

#### Testing

1. Save recipe captures current tag values
2. Load recipe writes all parameter values to tag bus
3. Delete recipe removes from store
4. Recipe persists through save/load cycle
5. Confirmation dialog appears before loading
6. Unknown tag names in recipe are skipped with warning

#### Agent Prompt: Recipe Management

```
TASK: Implement recipe management (save/load named parameter sets) for the SCADA builder.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-package.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/engine/tags/TagValueBus.ts
3. /var/aqua-saas/web/modules/sensor-module/src/store/scada/types.ts
4. /var/aqua-saas/web/modules/sensor-module/src/store/scada/createScadaStore.ts
5. /var/aqua-saas/web/modules/sensor-module/src/store/scada/projectSlice.ts

IMPLEMENTATION:
1. Create types/scada-recipe.types.ts with RecipeParameter and ScadaRecipe interfaces.
2. Add recipes?: ScadaRecipe[] to ScadaPackageData.
3. Create store/scada/recipeSlice.ts: addRecipe, updateRecipe, removeRecipe, loadRecipe actions.
4. Create recipes/RecipeManagerPanel.tsx: recipe list with save current, load, delete controls.
5. Create recipes/RecipeEditor.tsx: name, description, parameter list (tag + value + label + unit per row).
6. Add "Recipes" tab in builder side panel.
7. Tests: save, load (with confirmation), delete, persistence, unknown tag handling.

CONSTRAINTS:
- No `any` types, English comments
- Load recipe must show confirmation dialog
- Unknown tags skipped with console warning
- Recipe stored in ScadaPackageData (not separate API)
```

---

### 9E.4 DAQ Configuration Panel

#### Architecture

The DAQ (Data Acquisition) configuration panel allows operators to configure tag logging intervals, retention policies, and buffer settings directly within the SCADA builder. This information is stored in the package and deployed to the edge device.

**New types:**

```typescript
// In types/scada-daq.types.ts
export interface DaqTagConfig {
  tagName: string;
  /** Logging interval in seconds */
  logIntervalSec: number;
  /** Whether to log on value change (deadband-triggered) */
  logOnChange: boolean;
  /** Deadband value (minimum change to trigger logging) */
  deadband: number;
  /** Whether this tag is enabled for logging */
  enabled: boolean;
}

export interface DaqConfig {
  /** Tag-specific logging configurations */
  tags: DaqTagConfig[];
  /** Global retention period in days */
  retentionDays: number;
  /** Maximum buffer size before flush (number of samples) */
  bufferSize: number;
  /** Flush interval in seconds */
  flushIntervalSec: number;
}
```

**Storage:** Extends the existing `TrendConfig` or sits alongside it:

```typescript
// Addition to ScadaPackageData
export interface ScadaPackageData {
  // ... existing fields
  /** Data acquisition configuration for edge deployment */
  daqConfig?: DaqConfig;
}
```

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-daq.types.ts` | DaqTagConfig, DaqConfig interfaces | ~35 |
| `components/scada-builder/daq/DaqConfigPanel.tsx` | DAQ settings panel with tag list and global settings | ~220 |
| `components/scada-builder/daq/DaqTagEntry.tsx` | Per-tag DAQ configuration row | ~80 |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-package.types.ts` | Add `daqConfig?: DaqConfig` to `ScadaPackageData` |
| `store/scada/projectSlice.ts` | Add `updateDaqConfig` action |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "DAQ" tab in side panel |

#### Implementation Details

**DaqConfigPanel:**
- Global settings section: retention days, buffer size, flush interval
- Tag list section: table of configured tags with add/remove
- Per-tag: tag browser, interval input (min 1s), deadband input, on-change toggle, enabled toggle
- "Add All Used Tags" button: scans all widgets on all screens, collects unique tag names, adds them with default 10s interval

#### Security

- Interval minimum enforced: 1 second (prevents flooding)
- Buffer size capped at 100,000 samples
- DAQ config is stored in the package and validated on edge deployment

#### Testing

1. Add tag to DAQ configuration
2. Remove tag from DAQ configuration
3. "Add All Used Tags" discovers tags from all widgets
4. Interval minimum enforcement (1s)
5. Global settings persist in package JSON
6. Buffer size cap enforcement

#### Agent Prompt: DAQ Configuration Panel

```
TASK: Implement DAQ (Data Acquisition) configuration panel for the SCADA builder.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-package.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/store/scada/projectSlice.ts
3. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/TagBrowser.tsx

IMPLEMENTATION:
1. Create types/scada-daq.types.ts with DaqTagConfig and DaqConfig.
2. Add daqConfig?: DaqConfig to ScadaPackageData.
3. Add updateDaqConfig action to projectSlice.
4. Create daq/DaqConfigPanel.tsx: global settings + tag list table.
5. Create daq/DaqTagEntry.tsx: per-tag row with interval, deadband, on-change, enabled.
6. Add "DAQ" tab in builder side panel.
7. "Add All Used Tags" scans all screen widgets for unique tagNames.
8. Tests: add/remove tags, interval enforcement, "add all" discovery, persistence.

CONSTRAINTS:
- No `any` types, English comments
- Minimum interval: 1 second
- Maximum buffer: 100,000 samples
- "Add All Used Tags" traverses screens[].widgets[].config.tagName
```

---

### 9E.5 i18n for View Labels

#### Architecture

Runtime language switching for operator displays. View labels, widget labels, and static text can have translations that switch based on the operator's selected language.

**New types:**

```typescript
// In types/scada-i18n.types.ts
export type SupportedLocale = 'en' | 'tr' | 'de' | 'fr' | 'es' | 'ar' | 'zh' | 'ja' | 'ru';

export interface TranslationEntry {
  /** The default (fallback) text */
  defaultText: string;
  /** Locale-specific translations */
  translations: Partial<Record<SupportedLocale, string>>;
}

export interface PackageTranslations {
  /** Map of translation key -> TranslationEntry */
  entries: Record<string, TranslationEntry>;
  /** Default locale for the package */
  defaultLocale: SupportedLocale;
}
```

**Storage:**

```typescript
// Addition to ScadaPackageData
export interface ScadaPackageData {
  // ... existing fields
  /** i18n translations for operator displays */
  translations?: PackageTranslations;
}
```

**Runtime context:**

```typescript
// In engine/i18n/I18nProvider.tsx
export const I18nContext = createContext<{
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (key: string, defaultText?: string) => string;
}>({
  locale: 'en',
  setLocale: () => {},
  t: (_, defaultText) => defaultText ?? '',
});
```

**New files:**

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `types/scada-i18n.types.ts` | SupportedLocale, TranslationEntry, PackageTranslations | ~30 |
| `engine/i18n/I18nProvider.tsx` | React context provider for translations | ~80 |
| `engine/i18n/useTranslation.ts` | Hook for consuming translations | ~30 |
| `components/scada-builder/i18n/TranslationManager.tsx` | Translation key/value editor panel | ~220 |
| `components/scada-builder/i18n/LanguageSwitcher.tsx` | Runtime locale selector (dropdown) | ~60 |

**Modified files:**

| File | Changes |
|------|---------|
| `types/scada-package.types.ts` | Add `translations?: PackageTranslations` |
| `engine/ScadaRuntime.tsx` | Wrap children with I18nProvider |
| `store/scada/projectSlice.ts` | Add translation CRUD actions |
| `widget-renderers/StaticTextRenderer.tsx` | Use `useTranslation` for label text |
| `widget-renderers/ScreenLinkRenderer.tsx` | Use `useTranslation` for link label |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Add "Translations" tab; add LanguageSwitcher to runtime toolbar |

#### Implementation Details

**Translation resolution (`t` function):**

```typescript
function t(key: string, defaultText?: string): string {
  const entry = translations.entries[key];
  if (!entry) return defaultText ?? key;
  return entry.translations[currentLocale] ?? entry.defaultText;
}
```

**TranslationManager:**
- Table of translation keys with columns for each configured locale
- Add/remove keys
- Auto-detect translatable strings: scan all screen widget labels/names
- Import/export as CSV for professional translation workflows

**Widget integration:**
Widgets that display text labels check if their `label` value starts with `$t:` prefix:
```typescript
const displayLabel = label.startsWith('$t:')
  ? t(label.slice(3), label.slice(3))
  : label;
```

This opt-in approach means existing packages work unchanged. Only labels explicitly prefixed with `$t:` are resolved through the translation system.

#### Security

- Translation values are plain strings (no HTML, no template evaluation)
- Locale is stored per-session in localStorage (tenant-scoped key)

#### Performance

- Translation lookup is O(1) (object property access)
- Language switching is instant (React context update, all consumers re-render)
- Translation data is typically < 10KB even for 500 keys

#### Testing

1. `t('greeting')` returns English translation when locale is 'en'
2. `t('greeting')` returns Turkish translation when locale is 'tr'
3. Missing translation falls back to defaultText
4. `$t:` prefix in widget label triggers translation lookup
5. LanguageSwitcher changes locale
6. TranslationManager adds/removes keys
7. CSV export/import roundtrip preserves all translations

#### Agent Prompt: i18n for View Labels

```
TASK: Implement internationalization (i18n) for SCADA view labels with runtime language switching.

BEFORE CODING, READ:
1. /var/aqua-saas/web/modules/sensor-module/src/types/scada-package.types.ts
2. /var/aqua-saas/web/modules/sensor-module/src/engine/ScadaRuntime.tsx
3. /var/aqua-saas/web/modules/sensor-module/src/store/scada/projectSlice.ts
4. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/StaticTextRenderer.tsx
5. /var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/ScreenLinkRenderer.tsx

IMPLEMENTATION:
1. Create types/scada-i18n.types.ts with SupportedLocale, TranslationEntry, PackageTranslations.
2. Add translations?: PackageTranslations to ScadaPackageData.
3. Create engine/i18n/I18nProvider.tsx: React context with locale, setLocale, t function.
4. Create engine/i18n/useTranslation.ts: hook consuming I18nContext.
5. Wrap ScadaRuntime children with I18nProvider.
6. Create i18n/TranslationManager.tsx: table editor for translation keys, CSV import/export.
7. Create i18n/LanguageSwitcher.tsx: dropdown for runtime locale selection.
8. Modify StaticTextRenderer and ScreenLinkRenderer: use $t: prefix for translation lookup.
9. Add "Translations" tab in builder side panel.
10. Tests: translation resolution, fallback, locale switching, $t: prefix, CSV roundtrip.

CONSTRAINTS:
- No `any` types, English comments
- Opt-in via $t: prefix (backward compatible)
- Translation values are plain strings only (no HTML)
- Locale stored in tenant-scoped localStorage key
- Supported locales: en, tr, de, fr, es, ar, zh, ja, ru
```

---

## Dependency Graph

```
Phase 9A (Widget Types)
  |-- 9A.1 DataTable          (no deps, can start immediately)
  |-- 9A.2 IFrame             (no deps)
  |-- 9A.3 BarChart           (no deps)
  |-- 9A.4 PieChart           (no deps)
  |-- 9A.5 Knob               (no deps)
  |-- 9A.6 DropdownSelect     (no deps)
  |-- 9A.7 ProgressBar        (no deps)

Phase 9B (SVG Editor)
  |-- 9B.1 Pencil Tool        (depends on: Phase 1 svgPath widget)
  |-- 9B.2 Path Point Editing (depends on: Phase 1 PathOverlay, 9B.1 optional)
  |-- 9B.3 SVG Child Selection(depends on: Phase 1 customSvg widget)

Phase 9C (Animation & Events)
  |-- 9C.1 Video Playback     (depends on: Phase 3 animation engine)
  |-- 9C.2 Opacity Animation  (depends on: Phase 3 animation engine)
  |-- 9C.3 Text Value Format  (depends on: Phase 3 animation engine)
  |-- 9C.4 setProperty Event  (depends on: Phase 3 event system)
  |-- 9C.5 closeDialog Event  (depends on: Phase 3 event system)

Phase 9D (Scripting)
  |-- 9D.1 $setProperty       (depends on: Phase 5 scripting, 9C.4)
  |-- 9D.2 $getProperty       (depends on: Phase 5 scripting)
  |-- 9D.3 $closeDialog       (depends on: Phase 5 scripting, 9C.5)
  |-- 9D.4 $setAlarm          (depends on: Phase 5 scripting)
  |-- 9D.5 Script Scheduling  (depends on: Phase 5 scripting)

Phase 9E (Platform)
  |-- 9E.1 PNG/PDF Export     (no deps, can start immediately)
  |-- 9E.2 Tag Watch Window   (no deps)
  |-- 9E.3 Recipe Management  (no deps)
  |-- 9E.4 DAQ Configuration  (no deps)
  |-- 9E.5 i18n               (no deps)
```

**Parallelization strategy:**
- All 9A widgets can be implemented in parallel (7 independent tasks)
- 9E features are fully independent and can run in parallel with 9A
- 9B tasks are mostly independent (9B.1 and 9B.2 share the path concept but can be parallel)
- 9C tasks are independent of each other but depend on earlier phases
- 9D.1 depends on 9C.4 (shared setProperty handler); 9D.3 depends on 9C.5

**Critical path:** 9A widgets (3-4 weeks) + 9C animations (1.5 weeks) + 9D scripting (1 week) = ~6.5 weeks sequentially. With parallelization, total timeline is ~8-10 weeks.

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| DataTable virtualization complexity exceeds estimate | Medium | Medium | Use simple offset-based windowing (not intersection observer). If insufficient, bring in `@tanstack/virtual` (~5KB). |
| IFrame sandbox escape via allow-scripts + allow-same-origin | Low | Critical | Display prominent warning in config panel. Consider blocking this combination entirely in multi-tenant mode. |
| PDF raw spec builder too complex | Medium | Low | Fallback to `window.print()` with print CSS. Alternatively, use `jspdf` (~30KB) as last resort. |
| SVG child element selection unreliable for complex SVGs | Medium | Medium | Limit selectable elements to top-2 DOM levels within the SVG. Deeper elements accessible via manual CSS selector input. |
| Pencil tool performance on low-end devices | Low | Medium | Cap raw point collection at 30fps instead of 60fps. Increase RDP epsilon for aggressive simplification. |
| i18n translation key management complexity | Low | Low | Start with simple key-value approach. Upgrade to ICU message format only if users request pluralization/gender. |
| Script $getProperty snapshot staleness | Medium | Low | Document that snapshot reflects state at script invocation time, not real-time. Scripts needing latest values should use $getTag instead. |
| Recipe loading accidental production parameter changes | Medium | High | Require double-confirmation for recipe load. Add "dry run" mode that shows changes without applying them. |

---

## Total Estimates

### Phase 9A: Missing Widget Types

| Widget | New Files | Modified Files | New Lines | Test Lines |
|--------|-----------|---------------|-----------|------------|
| DataTable | 3 | 5 | ~710 | ~300 |
| IFrame | 3 | 5 | ~440 | ~250 |
| BarChart | 3 | 5 | ~625 | ~200 |
| PieChart | 3 | 5 | ~545 | ~200 |
| Knob | 3 | 5 | ~520 | ~200 |
| DropdownSelect | 3 | 5 | ~435 | ~200 |
| ProgressBar | 3 | 5 | ~380 | ~150 |
| **Subtotal** | **21** | **5 unique** | **~3,655** | **~1,500** |

### Phase 9B: SVG Editor Enhancements

| Feature | New Files | Modified Files | New Lines | Test Lines |
|---------|-----------|---------------|-----------|------------|
| Pencil Tool | 3 | 4 | ~350 | ~150 |
| Path Point Editor | 4 | 4 | ~440 | ~200 |
| SVG Child Selection | 4 | 4 | ~510 | ~200 |
| **Subtotal** | **11** | **8 unique** | **~1,300** | **~550** |

### Phase 9C: Animation & Event Enhancements

| Feature | New Files | Modified Files | New Lines | Test Lines |
|---------|-----------|---------------|-----------|------------|
| Video Playback | 0 | 3 | ~40 | ~60 |
| Opacity Animation | 0 | 3 | ~30 | ~50 |
| Text Value Format | 0 | 3 | ~50 | ~80 |
| setProperty Event | 1 | 2 | ~60 | ~80 |
| closeDialog Event | 1 | 3 | ~40 | ~60 |
| **Subtotal** | **2** | **6 unique** | **~220** | **~330** |

### Phase 9D: Scripting Extensions

| Feature | New Files | Modified Files | New Lines | Test Lines |
|---------|-----------|---------------|-----------|------------|
| $setProperty | 0 | 3 | ~40 | ~60 |
| $getProperty | 0 | 3 | ~60 | ~60 |
| $closeDialog | 0 | 2 | ~20 | ~30 |
| $setAlarm | 0 | 3 | ~40 | ~50 |
| Script Scheduling UI | 2 | 3 | ~380 | ~150 |
| **Subtotal** | **2** | **5 unique** | **~540** | **~350** |

### Phase 9E: Platform Features

| Feature | New Files | Modified Files | New Lines | Test Lines |
|---------|-----------|---------------|-----------|------------|
| PNG/PDF Export | 3 | 1 | ~500 | ~200 |
| Tag Watch Window | 3 | 1 | ~390 | ~150 |
| Recipe Management | 4 | 4 | ~480 | ~200 |
| DAQ Configuration | 3 | 3 | ~335 | ~150 |
| i18n | 5 | 5 | ~420 | ~200 |
| **Subtotal** | **18** | **9 unique** | **~2,125** | **~900** |

### Grand Total

| Metric | Estimate |
|--------|----------|
| New files | ~54 |
| Modified files (unique) | ~28 |
| New implementation lines | ~7,840 |
| New test lines | ~3,630 |
| **Total new lines** | **~11,470** |
| New npm dependencies | 0 (all native browser APIs) |
| Estimated duration (sequential) | 10-12 weeks |
| Estimated duration (parallel) | 8-10 weeks |

---

## Acceptance Criteria

### Phase 9A

- [ ] All 7 widget types render correctly in both edit and runtime modes
- [ ] All 7 widgets registered in WidgetRenderer lazyMap, widget-configs, sizes, palette
- [ ] DataTable sorts by column, paginates, and applies row color rules
- [ ] IFrame sandbox attribute correctly enforces configured restrictions
- [ ] BarChart and PieChart render proportional SVG visualizations without chart libraries
- [ ] Knob drag interaction writes values to tag bus at correct step intervals
- [ ] DropdownSelect is fully keyboard-accessible (ARIA listbox)
- [ ] ProgressBar color zones switch dynamically based on value
- [ ] All widgets maintain 60fps with 100+ widgets on a single screen
- [ ] All new types are fully typed (zero `any`)
- [ ] All widgets have unit tests with >80% branch coverage

### Phase 9B

- [ ] Pencil tool draws freehand curves and converts to svgPath widgets
- [ ] Path point editor shows draggable anchor/control handles on double-click
- [ ] SVG child element selection allows attaching animations to sub-elements
- [ ] RDP simplification reduces 10,000 points to <200 in <1ms
- [ ] Path coordinates clamped to widget bounds

### Phase 9C

- [ ] Video playback animation controls play/pause/stop based on tag value
- [ ] Opacity animation smoothly transitions between two opacity values
- [ ] Text format animation displays formatted tag values in SVG text
- [ ] setProperty event action changes widget config at runtime
- [ ] closeDialog event action closes the most recent overlay
- [ ] All new animation types registered in AnimationEngine.evaluate()
- [ ] All new event actions registered in ScadaRuntime

### Phase 9D

- [ ] $setProperty writes widget config from script code
- [ ] $getProperty reads widget config from snapshot
- [ ] $closeDialog closes dialog from script
- [ ] $setAlarm raises alarm with validated level and message
- [ ] Script scheduling UI configures interval/tagChange triggers
- [ ] All API methods rate-limited by SANDBOX_LIMITS
- [ ] Worker proxy + main-thread handler pattern followed for all methods

### Phase 9E

- [ ] PNG export produces valid image of the current view
- [ ] PDF export produces valid single-page PDF document
- [ ] Tag watch panel shows all tag values with real-time updates
- [ ] Recipe save/load roundtrip preserves all parameter values
- [ ] DAQ config panel scans all widgets for tag names
- [ ] i18n $t: prefix resolves translations based on current locale
- [ ] Language switcher changes locale instantly
- [ ] All platform features persist in ScadaPackageData JSON

### Cross-Cutting

- [ ] No new npm dependencies added
- [ ] All code comments in professional English
- [ ] Zero TypeScript `any` types in new code
- [ ] Existing SCADA packages load without errors (backward compatibility)
- [ ] DOMPurify used for all user-supplied HTML/SVG content
- [ ] All URL inputs validate protocol (https only in production)
- [ ] All new features work with the existing theme system (light/dark mode)
- [ ] All interactive widgets have ARIA attributes for accessibility

---

*End of Phase 9 Implementation Plan*
