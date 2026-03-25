# SCADA Builder UI/UX Design Plan

**Version:** 2.0
**Date:** 2026-03-25
**Status:** Proposal
**Classification:** Enterprise-Grade
**Target URL:** https://app.suderra.com/sensor/scada-builder/new

---

## Table of Contents

1. [Current State Assessment](#1-current-state-assessment)
2. [Layout Redesign Proposal](#2-layout-redesign-proposal)
3. [Right Panel Tab Restructuring](#3-right-panel-tab-restructuring)
4. [Widget Palette UX](#4-widget-palette-ux)
5. [Properties Panel UX](#5-properties-panel-ux)
6. [Canvas Interaction](#6-canvas-interaction)
7. [Mode System](#7-mode-system-edit--preview--simulation)
8. [Accessibility (WCAG 2.1 AA)](#8-accessibility-wcag-21-aa)
9. [Mobile/Tablet Considerations](#9-mobiletablet-considerations)
10. [Visual Design System](#10-visual-design-system)
11. [User Flow Analysis](#11-user-flow-analysis)
12. [Performance UX](#12-performance-ux)
13. [Error Handling UX](#13-error-handling-ux)
14. [Undo/Redo Architecture](#14-undoredo-architecture)
15. [Cross-Screen & Cross-Package Operations](#15-cross-screen--cross-package-operations)
16. [Multi-User Collaboration](#16-multi-user-collaboration)
17. [Version History & Audit Trail](#17-version-history--audit-trail)
18. [Export & Import System](#18-export--import-system)
19. [Search & Bulk Operations](#19-search--bulk-operations)
20. [Template Management System](#20-template-management-system)
21. [Internationalization (i18n)](#21-internationalization-i18n)
22. [Print & Reporting](#22-print--reporting)
23. [Alarm UX & Real-Time Indicators](#23-alarm-ux--real-time-indicators)
24. [Performance Benchmarks & SLA](#24-performance-benchmarks--sla)
25. [Offline Mode & Resilience](#25-offline-mode--resilience)
26. [Advanced Data Binding UX](#26-advanced-data-binding-ux)

---

## 1. Current State Assessment

### 1.1 What Works Well

- **3-panel canonical layout** matches industry-standard design tools (Figma, Adobe XD, Unity). Users familiar with any design tool will understand the spatial model immediately.
- **Scene tree + Layers in the far-left narrow panel (w-48)** provides a clean hierarchy view with drag-to-reparent and z-order controls. The collapsible group headers with color-coded borders are effective.
- **Zustand store architecture** with purpose-based selectors keeps re-renders minimal. The `useShallow` pattern in the main page is well-structured.
- **Mode segment control** (Edit / Preview / Simulation) is clearly visible in the top-right toolbar area and uses distinct visual treatments (Simulation gets a cyan-600 background).
- **Widget drag-and-drop** from palette to canvas using `application/reactflow-widget` dataTransfer is a solid interaction pattern.
- **Status bar** provides useful at-a-glance metrics: screen count, widget count, connection count, alarm count.
- **Keyboard shortcuts** (Ctrl+S, Ctrl+Z/Y, Ctrl+C/V/X, Del, Esc) are registered and functional.
- **ScreenTabBar** with drag-to-reorder, context menu, and screen type icons is well-executed.
- **CanvasSettings** floating toolbar (bottom-right) for grid/snap/zoom/theme is unobtrusive and accessible.

### 1.2 Pain Points and UX Issues

**P1 - Tab Overflow in Right Panel:**
The 8 tabs (`Widget | Alarms | Control | Trend | Auto | Events | Anim | Scripts`) are squeezed into a 320px-wide panel using `text-[10px]` font and `px-1.5` padding. The "Animations" tab is already truncated to "Anim" to fit. At this size, tab labels become illegible and tap targets fall below the 44x44px WCAG minimum. The `overflow-x-auto` CSS means tabs can scroll horizontally, but there is no visual indicator (scrollbar or gradient fade) that more tabs exist off-screen.

**P2 - Widget-scoped vs Package-scoped Tab Confusion:**
Five of the 8 tabs require a widget to be selected (Widget, Events, Animations) while three are package-level (Alarms, Control, Trend). The Automation tab is package-level but sits between widget-scoped tabs. The Scripts tab is package-level. There is no visual distinction between these two categories, leading to confusion when clicking "Events" without a widget selected and seeing a "Select a widget" placeholder.

**P3 - Toolbar Overload:**
The top toolbar has 10+ elements in a single row: Back link, package name input, unsaved badge, device selector, undo/redo, search, templates, CSV, save, mode switcher, deploy. On screens narrower than 1440px, this row wraps or overflows. Elements have inconsistent sizing: the device selector is larger than the mode segment control.

**P4 - Left Panel Dual-Purpose Ambiguity:**
The left side has TWO panels side by side: a w-48 scene-tree/layers panel AND a w-56 widget palette. Combined, they consume 416px (w-48 = 192px, w-56 = 224px) of horizontal space. On a 1920px screen this is 21.7% of width. On a 1440px laptop this is 28.9%. The canvas gets proportionally squeezed.

**P5 - Widget Palette Category Explosion:**
With 16 categories and 65+ widget entries (11 shapes, 6 pumps, 9 valves, 6 tanks, 5 heat exchangers, plus Indicators/Control/Trend/Alarm/Calibration/Process/Navigation/Piping/Automation/Media/Process Equipment/Water Tanks), the palette is extremely long. All categories default to expanded (`new Set(WIDGET_CATEGORIES.map(c => c.name))`), requiring extensive scrolling. There is no search, no filter, no favorites, no recently-used section.

**P6 - No Search in Widget Palette:**
Users who know they want a "Ball Valve" must scroll through the entire palette to find the Valves category, then locate it among 9 valve subtypes. There is a toolbar-level "Widget Search" button that opens `WidgetSearchPanel`, but this searches widgets already ON the canvas (by ID/name), not the palette's available widget catalog.

**P7 - Properties Panel Depth:**
The Widget tab has a 3-layer sandwich (General + Config + Permissions). For complex widgets like `TrendChart` or `Equipment`, the config section alone can be 20+ fields deep. Combined with General (8 fields) and Permissions (2 lists), users scroll extensively within a single tab. There are no collapsible sub-sections within the sandwich layers.

**P8 - Edge Properties Inline in Widget Tab:**
When an edge (connection) is selected, its properties replace the widget properties in the Widget tab. There is no visual affordance indicating that the tab content has changed context. The header just shows "Connection Properties" inline.

**P9 - Simulation Sidebar Visual Disconnect:**
The Simulation sidebar uses a dark theme (bg-gray-800) that contrasts sharply with the rest of the UI (bg-white). While this does draw attention to simulation mode, it creates a jarring visual when switching between Edit (white right panel) and Simulation (dark right panel).

**P10 - No Contextual Help or Onboarding:**
With 40+ widget types, 8 property tabs, expressions, scripts, animations, and per-widget permissions, there is no contextual help, tooltip-based documentation, or progressive onboarding. A new user is presented with the full complexity immediately.

### 1.3 Dimensional Analysis (Current Layout)

```
+---------------------------------------------------------------+
| TOOLBAR (h=52px)                                              |
| [Back] [Name___] [Unsaved] | [Device v] | Undo/Redo | ...    |
+------+--------+---------------------------+-------------------+
|ScnTre|  Widget |     CANVAS                | Properties Panel  |
|+Layer|  Palette|                           |  [8 tabs]         |
| w=192|  w=224  |     flex-1                |  w=320            |
|      |         |                           |                   |
|      |         |                           | General           |
|      |         |                           | Config            |
|      |         |                           | Permissions       |
|      |         |                           |                   |
+------+--------+---------------------------+-------------------+
| STATUS BAR (h=28px)                                           |
+---------------------------------------------------------------+

Total sidebar width: 192 + 224 + 320 = 736px
Canvas width on 1920px: 1920 - 736 = 1184px (61.7%)
Canvas width on 1440px: 1440 - 736 = 704px (48.9%) <-- PROBLEM
Canvas width on 1280px: 1280 - 736 = 544px (42.5%) <-- CRITICAL
```

---

## 2. Layout Redesign Proposal

### 2.1 Core Principle: Collapsible Panels with Canvas Priority

The canvas must always get at least 55% of the viewport width. All panels should be collapsible to maximize canvas real estate when needed.

### 2.2 Proposed Layout

```
+---------------------------------------------------------------+
| TOOLBAR PRIMARY (h=48px)                                      |
| [<Back] [Package Name________] [*Unsaved]    [Save] [Deploy] |
+---------------------------------------------------------------+
| TOOLBAR SECONDARY (h=36px, contextual)                        |
| [Edit|Preview|Sim] | Undo/Redo | Zoom 100% | Grid | Snap     |
+-------+---------------------------------+---------------------+
| LEFT  |         CANVAS                  | RIGHT PANEL         |
| PANEL |                                 |                     |
| w=240 |         flex-1                  | w=320               |
| (coll)|                                 | (collapsible)       |
|       |                                 |                     |
| [tab] |   Screen Tab Bar                |  [Widget-scoped]    |
| Scene |   +----------------------------+|  Properties         |
| Layers|   | Canvas content             ||  Events             |
| Widget|   |                            ||  Animations         |
| Palette   |                            ||                     |
|       |   |                            ||  [Package-scoped]   |
|       |   |                            ||  Alarms             |
|       |   |                            ||  Control            |
|       |   +----------------------------+|  Trends             |
|       |   [Canvas Settings Bar]         |  Scripts            |
+-------+---------------------------------+---------------------+
| STATUS BAR (h=24px)                                           |
+---------------------------------------------------------------+
```

### 2.3 Toolbar Split: Primary + Secondary

**Recommendation:** Split the current single toolbar into two rows.

**Primary Toolbar (h=48px) - Always visible:**
- Left: Back link, Package Name (editable), Unsaved indicator
- Center: Target Device selector (moved from left cluster for better visual balance)
- Right: Save button, Deploy dropdown

**Secondary Toolbar (h=36px) - Contextual:**
- Left: Mode segment (Edit / Preview / Simulation)
- Center: Undo/Redo, Separator, Search, Templates, CSV Import
- Right: Zoom controls, Grid toggle, Snap toggle, Theme toggle (merged from CanvasSettings)

**Rationale:** Moving canvas controls (zoom, grid, snap) from the floating bottom-right overlay into the secondary toolbar provides a consistent location and frees canvas real estate. The floating CanvasSettings bar currently overlaps widgets near the bottom-right corner.

### 2.4 Left Panel: Unified Tabbed Sidebar

**Recommendation:** Merge the current two left panels (SceneTree+Layers at w=192, WidgetPalette at w=224) into a SINGLE left panel at w=240 with internal tabs.

```
+-------------------+
| [Scene] [Palette] |  <-- Two pill-toggle tabs
+-------------------+
|                   |
| Tab content here  |
|                   |
+-------------------+
| LAYERS (always    |
|  visible at       |
|  bottom, h=200    |
|  collapsible)     |
+-------------------+
```

- **Scene tab:** Shows the SceneTreePanel content (screen hierarchy, drag-to-reparent, context menu).
- **Palette tab:** Shows the WidgetPalette content (categories, drag-to-add).
- **Layers section:** Remains docked at the bottom of the left panel (as it is now), always visible regardless of which tab is active. This is critical because layer ordering is needed while both browsing the scene tree AND while adding new widgets.

**Space savings:** 192 + 224 = 416px reduced to 240px. That returns 176px to the canvas.

### 2.5 Right Panel: Restructured (see Section 3)

Remains at w=320 but with improved tab organization. Collapsible via a toggle button on its left edge.

### 2.6 Panel Collapse Behavior

Add collapse/expand toggles to both side panels:

- **Left panel collapse:** Clicking a toggle on the right edge of the left panel collapses it to a 40px-wide icon rail showing Scene/Palette/Layers icons. Clicking any icon expands the panel and activates that tab.
- **Right panel collapse:** Clicking a toggle on the left edge collapses it to a 40px icon rail showing grouped icons (Properties, Package Settings). Useful when working on canvas layout without needing property editing.
- **Keyboard shortcuts:** `Ctrl+[` collapses left panel, `Ctrl+]` collapses right panel, `Ctrl+\` toggles both (maximizes canvas).

### 2.7 Revised Dimensional Analysis

```
Full panels open:
  Left: 240px, Right: 320px, Chrome: 560px
  Canvas on 1920px: 1360px (70.8%)  -- was 1184px
  Canvas on 1440px: 880px (61.1%)   -- was 704px
  Canvas on 1280px: 720px (56.3%)   -- was 544px

One panel collapsed:
  Left rail: 40px, Right: 320px = 360px
  Canvas on 1440px: 1080px (75%)

Both panels collapsed:
  Left rail: 40px, Right rail: 40px = 80px
  Canvas on 1280px: 1200px (93.8%)
```

---

## 3. Right Panel Tab Restructuring

### 3.1 Current Problem

Eight tabs in 320px width at text-[10px]:

```
[Widget] [Alarms] [Control] [Trend] [Auto] [Events] [Anim] [Scripts]
```

Each tab gets ~40px. Minimum readable tab width with icon + label is ~56px. This forces abbreviated labels ("Anim", "Auto") and makes touch targets too small.

### 3.2 Proposed Solution: Two-Tier Tab Groups

Split the 8 tabs into TWO groups using a group selector above the tabs:

```
+----------------------------------+
| [Widget-scoped] [Package-scoped] |  <-- Group toggle (pill style)
+----------------------------------+
| [Properties] [Events] [Anims]    |  <-- 3 tabs (widget-scoped)
+----------------------------------+
|                                  |
| Tab content                      |
|                                  |
+----------------------------------+
```

**Group 1 -- Widget-Scoped (requires widget selection):**
- **Properties** (was "Widget") -- General + Config + Permissions sandwich
- **Events** -- Widget event bindings
- **Animations** -- Widget animation rules

**Group 2 -- Package-Scoped (no widget selection required):**
- **Alarms** -- Package alarm rules
- **Control** -- Security levels + Emergency stop
- **Trends** -- Trend data configuration
- **Automation** -- Automation binding panel
- **Scripts** -- Package-level script management

### 3.3 Tab Rendering Details

When "Widget-scoped" group is active, show 3 tabs. Each tab gets ~107px (320/3), allowing full labels with icons:
```
[Settings icon] Properties | [Zap icon] Events | [Play icon] Animations
```

When "Package-scoped" group is active, show 5 tabs. Each tab gets ~64px. Use icon + short label:
```
[Bell] Alarms | [Shield] Control | [Chart] Trends | [Cpu] Auto | [Code] Scripts
```

### 3.4 Group Toggle Behavior

- Default group: Widget-scoped (since most editing is widget-centric)
- When a widget is deselected, the group toggle remains on Widget-scoped but shows the "Select a widget" placeholder consistently across all 3 tabs, rather than just on two of them
- When no widget is selected, a subtle badge on "Widget-scoped" reads "(no selection)" in gray text
- The Package-scoped group is always fully functional regardless of widget selection

### 3.5 Alternative Considered: Scrollable Tabs with Overflow Indicators

An alternative is to keep all 8 tabs in a single row with gradient fade indicators at the edges showing that more tabs exist. This was rejected because:
- Users would not discover tabs hidden off-screen
- Horizontal scrolling in a vertical panel is disorienting
- The two-group approach also solves the conceptual confusion between widget-level and package-level settings

### 3.6 Edge Properties Handling

When a connection (edge) is selected instead of a widget:
- The Widget-scoped group auto-switches to show "Connection Properties" in the Properties tab
- A visual indicator (pipe icon + "Connection" badge) replaces the widget type badge
- Events and Animations tabs become disabled (greyed out) since edges do not have these

---

## 4. Widget Palette UX

### 4.1 Current Problems

- 16 categories, 65+ widgets, all expanded by default
- No search functionality within the palette
- No favorites or recently-used section
- No visual preview of what a widget looks like
- Widget labels like "Cornell Dual Drain" are truncated in the narrow panel
- Size hints (e.g., "240x200") use tiny 9px text and are hard to read

### 4.2 Proposed Palette Redesign

```
+-----------------------------+
| [Search widgets...]    [X]  |  <-- Sticky search bar
+-----------------------------+
| [Recently Used]        (3)  |  <-- Collapsible, shows last 5 used
|   [Gauge] [Toggle] [Pump]  |
+-----------------------------+
| [Favorites]            (2)  |  <-- Star-marked widgets
|   [Ball Valve] [Tank]      |
+-----------------------------+
| [Indicators]           (4)  |  <-- Category accordion
|   Gauge           120x120  |
|   Numeric Display  80x60   |
|   Status Indicator 60x60   |
|   Tank Level      120x200  |
+-----------------------------+
| [Control]              (5)  |
|   ...                       |
+-----------------------------+
| [Shapes]              (11)  |
|   ...                       |
+-----------------------------+
| ...remaining categories...  |
+-----------------------------+
```

### 4.3 Search Bar

- **Position:** Sticky at the top of the palette, always visible
- **Behavior:** Fuzzy search across widget labels, category names, and equipment subtypes
- **Results:** Flatten all matching widgets into a single list, grouped by category
- **Keyboard shortcut:** Pressing `/` while the palette tab is active focuses the search bar
- **Clear button (X):** Resets search and returns to the category view

### 4.4 Recently Used Section

- Track the last 8 unique widget types dropped onto the canvas
- Store in localStorage per tenant: `scada-palette-recent-{tenantId}`
- Show as a horizontally-scrollable pill row with small icons
- Collapsed by default on first visit, open by default after first use

### 4.5 Favorites Section

- Users can right-click any widget in the palette and select "Add to Favorites"
- A star icon appears on favorited widgets
- Favorites persist in localStorage: `scada-palette-favorites-{tenantId}`
- The Favorites section appears only when at least one widget is favorited

### 4.6 Category Defaults

- **On first load:** Only "Indicators" and "Control" categories are expanded. All others are collapsed.
- **Category expansion state persists** in localStorage per session
- Each category header shows a widget count badge (e.g., "(4)")

### 4.7 Widget Card Enhancement

Replace the current single-line card with a two-line card for ISA equipment types:

```
Current:
  [grip] [icon] Ball Valve           240x200

Proposed:
  [grip] [icon] Ball Valve           [star]
                Valves | 240x200px
```

- Line 1: Widget label + optional star (favorite toggle)
- Line 2: Category breadcrumb + pixel dimensions (muted text)
- On hover: Show a tooltip with a 120x80px thumbnail preview of the widget's default appearance

### 4.8 Drag Interaction Feedback

- **Drag start:** The palette card gets a `shadow-lg` elevation and 90% opacity
- **Over canvas:** Show a ghost outline at the drop position sized to the widget's default dimensions
- **Over invalid zone:** Change cursor to `not-allowed`
- **Drop success:** Brief green flash on the canvas at the drop position
- **Drop from palette auto-selects** the new widget and switches right panel to Properties tab

---

## 5. Properties Panel UX

### 5.1 3-Layer Sandwich Analysis

The current Widget tab sandwich:

```
Layer 1: GeneralPropertiesSection
  - Name (text input)
  - Type (badge, read-only)
  - X, Y (number inputs, 2-col grid)
  - W, H (number inputs, 2-col grid)
  - Locked, Visible (checkboxes)

Layer 2: Per-widget ConfigComponent
  - Varies wildly: GaugeConfig (5 fields) vs EquipmentConfig (15+ fields)
  - Tag binding, range mapping, color mapping, gradient editor, etc.

Layer 3: WidgetPermissionsSection
  - Show Roles (multi-select)
  - Enable Roles (multi-select)
```

### 5.2 Recommendations

**A. Collapsible Sub-sections within each Layer:**

Each layer should be a collapsible `<details>` (or custom accordion) with a sticky header:

```
+----------------------------------+
| v General Properties         [-] |  <-- Collapsible, default open
|   Name: [________________]      |
|   Type: [Gauge]                 |
|   X: [10]  Y: [5]              |
|   W: [6]   H: [4]              |
|   [x] Locked  [x] Visible      |
+----------------------------------+
| v Configuration              [-] |  <-- Collapsible, default open
|   Tag: [sensor.temp.1]         |
|   Min: [0]  Max: [100]         |
|   Unit: [degC]                  |
|   ...                           |
+----------------------------------+
| > Permissions                [+] |  <-- Collapsible, default CLOSED
|   (collapsed by default)        |
+----------------------------------+
```

**Rationale:** Permissions are rarely edited after initial setup. Collapsing them by default saves vertical space for the Config section, which users interact with most frequently.

**B. Tag Binding Visibility Enhancement:**

The tag binding field (e.g., `tagName`, `tag`) is the most important field in the config section but is currently rendered like any other text input. Propose:

- **Visual treatment:** Tag input gets a distinct style -- monospace font, dark background (bg-gray-800 text-green-400), with an inline "browse" button that opens a tag picker dialog
- **Validation indicator:** Green checkmark if tag exists in device tag list, yellow warning if unverified, red X if malformed
- **Quick-bind:** Right-clicking a tag field shows recently used tags

**C. Expression Editor Positioning:**

For widgets that support expressions (formula binding), the expression field should:

- Show a compact single-line preview by default
- Expand to a multi-line code editor (with syntax highlighting) on click
- Use a modal or slide-out panel for the full formula editor rather than inline expansion that pushes the rest of the form down
- Show expression evaluation result in a read-only field below

**D. Gradient and Filter Editors:**

These are complex sub-editors (color stops, blend modes, SVG filter parameters). They should:

- Open as popovers/flyouts anchored to their trigger button, NOT inline in the form
- Use a standard popover width of 280px
- Include a "Reset to Default" action

### 5.3 Config Section Scroll Optimization

For widget types with many config fields (Equipment, TrendChart), organize fields into collapsible sub-groups within the Config layer:

```
v Configuration
  v Appearance
    Color, Size, Rotation, etc.
  v Data Binding
    Tag, Expression, Update interval
  v Ranges & Thresholds
    Min, Max, Warning, Critical levels
  > Advanced
    SVG filters, custom CSS, etc.
```

---

## 6. Canvas Interaction

### 6.1 Selection Feedback

**Current state:** Selected widget gets a ReactFlow selection indicator (blue border). Multi-select uses `selectedWidgetIds` array.

**Recommendations:**

- **Single selection:** 2px solid cyan-500 border with 8 resize handles (corner + midpoint). Handles should be 8x8px filled squares.
- **Multi-selection:** Each selected widget gets a 1px dashed cyan-400 border. A bounding box around all selected widgets shows the group selection area with 4 corner resize handles.
- **Hover (not selected):** 1px dashed gray-300 border appears on mouse enter, disappears on mouse leave. This helps users identify widget boundaries on a busy canvas.
- **Locked widget selection:** Same border as normal selection but with a lock icon overlay in the top-right corner. Resize handles are hidden.

### 6.2 Multi-Select Experience

- **Shift+Click:** Add/remove from selection
- **Ctrl+A:** Select all widgets on the active screen
- **Rubber-band selection:** Click and drag on empty canvas area to create a selection rectangle
- **Selection count:** Show "3 widgets selected" in the status bar
- **Bulk operations:** When multiple widgets are selected, the Properties panel should show:
  - Shared properties (position offset, locked, visible) editable for all
  - Type-specific properties hidden with a note: "Multiple widget types selected"

### 6.3 Group Visual Indicators

**Current state:** Groups have color-coded borders in the Layers panel. On canvas, the `ScadaWidgetNode` shows a colored border when `groupId` is set.

**Recommendations:**

- Add a subtle filled background tint (5% opacity of the group color) behind all widgets in a group
- When hovering over any group member, highlight ALL group members with a 1px solid border of the group color
- Show a "Group" label floating above the bounding box of the group when any member is hovered
- Double-click a group to enter "group edit mode" where only group members are selectable

### 6.4 Zoom and Pan Controls

**Current state:** CanvasSettings floating bar in bottom-right with zoom in/out/percentage/fit-view.

**Recommendations:**

- Move zoom controls to the secondary toolbar (as proposed in Section 2.3)
- Keep a minimap in the bottom-right corner (ReactFlow's `<MiniMap>` component) showing a bird's-eye view of the canvas with a viewport rectangle
- Add keyboard zoom: `Ctrl+=` zoom in, `Ctrl+-` zoom out, `Ctrl+0` reset to 100%
- Add scroll-wheel zoom: `Ctrl+Scroll` for zoom (already standard in ReactFlow)
- Add double-click on empty canvas to fit-view
- Show a zoom level toast (briefly appearing centered notification) when zoom changes via keyboard

### 6.5 Grid and Snap UX

**Current state:** Grid toggle and Snap toggle in CanvasSettings bar.

**Recommendations:**

- **Grid visual:** Major gridlines every 100px (1px solid gray-200), minor gridlines every 20px (1px solid gray-100). Major gridlines should show distance labels at the top ruler.
- **Rulers:** Add horizontal and vertical pixel rulers along the top and left edges of the canvas (similar to Photoshop). Rulers should show the current cursor position with a red marker line.
- **Smart guides:** When dragging a widget, show alignment guides (thin magenta lines) when the widget's edges or center align with other widgets' edges or centers. Show distance indicators between aligned widgets.
- **Snap behavior:** Snap to grid (configurable: 10px, 20px, 50px), snap to other widgets (edge alignment), snap to canvas center (vertical and horizontal midlines).

### 6.6 Context Menu Organization

Right-clicking a widget on the canvas should show:

```
+---------------------------+
| Cut              Ctrl+X   |
| Copy             Ctrl+C   |
| Paste            Ctrl+V   |
| Duplicate        Ctrl+D   |
+---------------------------+
| Delete           Del      |
+---------------------------+
| Bring to Front   Ctrl+]   |
| Bring Forward             |
| Send Backward             |
| Send to Back     Ctrl+[   |
+---------------------------+
| Group            Ctrl+G   |
| Ungroup          Ctrl+U   |
+---------------------------+
| Lock / Unlock             |
| Hide / Show               |
+---------------------------+
| Save as Template          |
+---------------------------+
```

Right-clicking empty canvas:

```
+---------------------------+
| Paste            Ctrl+V   |
+---------------------------+
| Select All       Ctrl+A   |
+---------------------------+
| Canvas Settings           |
|   > Grid Size             |
|   > Background            |
+---------------------------+
| Fit View         Ctrl+0   |
+---------------------------+
```

---

## 7. Mode System (Edit / Preview / Simulation)

### 7.1 Mode Switching Clarity

**Current state:** A 3-button segment control in the top-right toolbar. Simulation mode changes the right panel from PropertiesPanel to SimulationSidebar (which has a dark theme).

**Recommendations:**

**A. Prominent mode indicator:**
When in Preview or Simulation mode, add a full-width colored banner below the secondary toolbar:

```
Preview mode:
+---------------------------------------------------------------+
| [eye icon] PREVIEW MODE - Live data from [Device Name]  [Exit]|  <- bg-blue-50, text-blue-700
+---------------------------------------------------------------+

Simulation mode:
+---------------------------------------------------------------+
| [zap icon] SIMULATION MODE - Using simulated tag values [Exit]|  <- bg-cyan-50, text-cyan-700
+---------------------------------------------------------------+
```

**B. Canvas border color change:**
- Edit mode: No border (current)
- Preview mode: 2px solid blue-400 border around the canvas area
- Simulation mode: 2px solid cyan-400 border with a subtle pulse animation

**C. Toolbar state changes:**
- In Preview mode: Left panel (Scene Tree, Widget Palette) is hidden (current behavior, good). The secondary toolbar should hide Edit-only controls (grid, snap) and show Preview-only controls (data refresh rate, time range selector for trends).
- In Simulation mode: Left panel hidden (current behavior). The right panel switches to SimulationSidebar (current behavior). The secondary toolbar should show simulation controls (Play/Pause, Reset, Step).

### 7.2 Preview Mode Limitations

The current Preview mode only works when a device is selected (`selectedDevice?.deviceCode`). Without a device, clicking Preview does nothing useful -- the canvas renders but with no live data.

**Recommendation:** When Preview is clicked without a target device selected:
- Show a modal/dialog: "Select a target device to preview live data" with the device dropdown
- Allow Preview without a device as "layout preview" -- shows widgets in their default states with a subtle watermark "No device connected"

### 7.3 Simulation Mode Sidebar UX

**Current state:** Dark-themed (bg-gray-800) sidebar with 4 collapsible sections: Tag Values, Scenarios, Active Alarms, Automation Programs.

**Recommendations:**

**A. Match the builder's theme rather than forcing a dark theme.**
The dark sidebar creates visual disconnect. Use the same bg-white with slightly different accent colors (e.g., cyan borders on all simulation controls) to indicate simulation context.

**B. Tag Values section improvements:**
- Add a search/filter bar at the top of the tag list
- Group tags by widget type (Pumps, Valves, Sensors) with collapsible headers
- Show the current value prominently with a visual spark-line of the last 30 seconds of changes

**C. Scenarios section improvements:**
- Show scenario descriptions (not just names)
- Add a "Random Walk" built-in scenario that continuously varies numeric values within their min/max range
- Add scenario import/export (JSON file)

### 7.4 Mode Transition Safety

When switching FROM Edit mode to Preview or Simulation with unsaved changes:
- Show a confirmation dialog: "You have unsaved changes. Save before switching modes?"
- Options: "Save & Switch", "Switch Without Saving", "Cancel"

When switching FROM Simulation back to Edit:
- Auto-stop any running automation programs
- Clear simulated tag values (or offer to keep them as test data)
- Show a brief toast: "Simulation stopped. Returning to Edit mode."

---

## 8. Accessibility (WCAG 2.1 AA)

### 8.1 Keyboard Navigation Plan

**Tab Order (logical):**
1. Primary toolbar: Back, Package Name, Device Selector, Save, Deploy
2. Secondary toolbar: Mode switcher, Undo, Redo, Search, Templates, CSV, Zoom controls
3. Left panel: Tab selector (Scene/Palette), panel content, Layers section
4. Center: Screen tab bar, Canvas (widget focus ring navigation)
5. Right panel: Group selector, Tab bar, Tab content

**Canvas Keyboard Navigation:**
- `Tab` key moves focus between widgets in z-order (top to bottom)
- `Arrow keys` move the focused/selected widget by 1 grid unit (with Shift: 10 grid units)
- `Enter` on a focused widget selects it and opens Properties in the right panel
- `Escape` deselects the current widget
- `Space` on a focused control widget (toggle, button) activates it in Preview/Simulation mode

**Panel Navigation:**
- `F6` cycles focus between major panels (left, canvas, right) -- standard pattern from IDEs
- Within a panel, `Tab` moves between interactive elements
- `Ctrl+1` through `Ctrl+3` jump focus to left panel, canvas, right panel respectively

### 8.2 Color Contrast Requirements

All text must meet a minimum contrast ratio of 4.5:1 against its background (AA standard).

**Current violations to fix:**
- `text-gray-400` on `bg-white` = 2.7:1 contrast ratio (FAIL). Used in: GeneralPropertiesSection LABEL_CLASS. **Fix:** Change to `text-gray-500` (4.6:1) or `text-gray-600` (7.0:1).
- `text-[10px]` tab labels in PropertiesPanel may fall below minimum readable size. **Fix:** Use minimum 11px for interactive text, 10px only for supplementary badges.
- `text-gray-500` on `bg-gray-50` = 4.4:1 (borderline). **Fix:** Change to `text-gray-600` for critical labels.
- Layers panel `text-[10px] text-gray-400` for "No widgets on this screen" placeholder = very low contrast.

**Color-independent status indicators:**
- Do not rely solely on color to indicate alarm severity. Add text labels (CRITICAL, HIGH, WARNING, INFO) and/or icons (exclamation triangle, warning, info circle) alongside the color badges.
- Widget online/offline status in device selector: add "(Online)" or "(Offline)" text alongside the colored dot.

### 8.3 Screen Reader Support

- All icon-only buttons must have `aria-label` attributes (currently, many buttons use `title` but not `aria-label`)
- The canvas area should have `role="application"` with an `aria-label="SCADA canvas editor"`
- Widget selection changes should be announced via `aria-live="polite"` region: "Gauge widget selected"
- Tab panels should use proper `role="tablist"`, `role="tab"`, `role="tabpanel"` ARIA patterns
- Mode changes should be announced: "Switched to Simulation mode"

### 8.4 Focus Management

- When a dialog opens (Deploy, CSV Import), focus must move to the dialog's first interactive element
- When a dialog closes, focus must return to the element that triggered it
- When switching right panel tabs, focus should move to the first interactive element in the new tab panel
- When a widget is deleted, focus should move to the next widget in z-order (or the canvas if no widgets remain)

### 8.5 Reduced Motion

- Respect `prefers-reduced-motion` media query
- The pulse animation on the Simulation mode status dot should be disabled
- Canvas transitions (zoom, pan) should be instant rather than animated
- Widget animation previews should show a static representation

---

## 9. Mobile/Tablet Considerations

### 9.1 Minimum Viewport Requirements

The SCADA builder is a complex desktop application. Define minimum supported viewports:

- **Minimum supported width:** 1024px (iPad landscape)
- **Optimal width:** 1440px+ (desktop)
- **Below 1024px:** Show a full-screen message: "The SCADA builder requires a screen width of at least 1024px. Please use a desktop browser or rotate your tablet to landscape mode."

### 9.2 Touch-Friendly Adjustments (Tablet)

For viewport widths 1024-1279px:

- **Minimum tap target:** 44x44px (WCAG 2.5.5)
- **Toolbar buttons:** Increase padding from `py-1.5` to `py-2.5` when touch input is detected (via `pointer: coarse` media query)
- **Tab labels:** Increase font from 10px to 12px
- **Palette widget cards:** Increase padding from `py-1.5` to `py-2.5`

### 9.3 Panel Collapse on Tablet

On viewports 1024-1279px:
- Left panel auto-collapses to icon rail on page load
- Right panel remains open but can be swiped away (touch gesture: swipe right to collapse)
- Only one panel can be fully open at a time -- opening the left panel collapses the right panel to icon rail, and vice versa

### 9.4 Canvas Touch Interactions

- **Single tap:** Select widget
- **Double tap:** Open widget Properties (expand right panel if collapsed)
- **Two-finger pinch:** Zoom in/out
- **Two-finger drag:** Pan canvas
- **Long press on widget:** Open context menu
- **Long press on empty canvas:** Open canvas context menu
- **Drag (single finger on widget):** Move widget (with 100ms delay to distinguish from scroll)

---

## 10. Visual Design System

### 10.1 Color Palette for the Builder UI

The builder UI (chrome, toolbars, panels) uses a neutral palette that does not compete with the SCADA content on the canvas.

| Token | Light Mode | Dark Mode | Usage |
|-------|-----------|-----------|-------|
| `surface-primary` | white (#FFFFFF) | gray-900 (#111827) | Panel backgrounds |
| `surface-secondary` | gray-50 (#F9FAFB) | gray-800 (#1F2937) | Toolbar, tab bar, section headers |
| `surface-canvas` | gray-100 (#F3F4F6) | gray-950 (#030712) | Canvas background |
| `border-primary` | gray-200 (#E5E7EB) | gray-700 (#374151) | Panel borders, dividers |
| `border-active` | cyan-500 (#06B6D4) | cyan-400 (#22D3EE) | Selected tabs, active toggles |
| `text-primary` | gray-900 (#111827) | gray-100 (#F3F4F6) | Headings, labels |
| `text-secondary` | gray-600 (#4B5563) | gray-400 (#9CA3AF) | Descriptions, hints |
| `text-muted` | gray-400 (#9CA3AF) | gray-600 (#4B5563) | Placeholders, disabled |
| `accent-primary` | cyan-600 (#0891B2) | cyan-500 (#06B6D4) | Primary actions, active state |
| `accent-danger` | red-600 (#DC2626) | red-500 (#EF4444) | Delete, critical alarms |
| `accent-success` | green-600 (#16A34A) | green-500 (#22C55E) | Save confirmation, online status |
| `accent-warning` | yellow-500 (#EAB308) | yellow-400 (#FACC15) | Unsaved, warnings |
| `accent-deploy` | indigo-600 (#4F46E5) | indigo-500 (#6366F1) | Deploy button |

### 10.2 Typography Scale

| Level | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `heading-lg` | 16px (1rem) | 600 (semibold) | 24px | Panel titles (rare) |
| `heading-sm` | 13px (0.8125rem) | 600 (semibold) | 20px | Section headers |
| `body` | 12px (0.75rem) | 400 (normal) | 18px | Form labels, descriptions |
| `body-sm` | 11px (0.6875rem) | 400 (normal) | 16px | Widget palette items, layer rows |
| `caption` | 10px (0.625rem) | 500 (medium) | 14px | Badges, dimensions, status bar |

**Font family:** System font stack (Tailwind's default `font-sans`). Monospace for tag names and expressions.

### 10.3 Icon Style Consistency

**Current state:** All icons use lucide-react, which is good for consistency. Custom SVG icons are used for equipment types (pumps, valves, tanks, heat exchangers).

**Recommendations:**
- Standardize all icons to 16x16px (w-4 h-4) in toolbars and 14x14px (w-3.5 h-3.5) in panels
- Use 1.5px stroke weight consistently (lucide-react default)
- Custom equipment SVG icons should match lucide-react's visual weight: 1.5px stroke, no fills for outlines, rounded corners
- Add a `currentColor` inheritance pattern to all custom SVG icons (most already do this)

### 10.4 Spacing and Sizing System

Use Tailwind's 4px base unit consistently:

| Token | Value | Usage |
|-------|-------|-------|
| `gap-xs` | 4px (gap-1) | Icon-to-label spacing |
| `gap-sm` | 8px (gap-2) | Between form fields, between toolbar items |
| `gap-md` | 12px (gap-3) | Between form sections |
| `gap-lg` | 16px (gap-4) | Between major panel sections |
| `pad-panel` | 16px (p-4) | Panel content padding |
| `pad-toolbar` | 8px vertically, 16px horizontally (py-2 px-4) | Toolbar padding |
| `pad-tab` | 10px vertically, 12px horizontally (py-2.5 px-3) | Tab button padding |
| `radius-sm` | 6px (rounded-md) | Buttons, inputs |
| `radius-lg` | 8px (rounded-lg) | Cards, dropdowns, dialogs |

### 10.5 Light/Dark Theme for the Builder

**Current state:** A theme toggle exists in CanvasSettings that changes the SCADA canvas content theme, but the builder chrome itself is always light.

**Recommendation:** Extend the theme system to cover the builder chrome as well:
- Use CSS custom properties (`--surface-primary`, `--text-primary`, etc.) that change based on `data-scada-theme` attribute
- The canvas content theme and builder chrome theme can be independent (a user may want dark chrome with light canvas for ISA-101 compliance)
- Default: Both follow system preference via `prefers-color-scheme`

---

## 11. User Flow Analysis

### 11.1 Flow: Creating a New SCADA Package

**Current steps:** 9 steps with 3 friction points

1. Navigate to /sensor/scada-builder/new
2. Type package name in toolbar input
3. (Friction) No guidance on what to do next
4. Select target device from dropdown
5. Widgets are shown in palette but no hint to drag them
6. Drag first widget to canvas
7. Configure widget in right panel
8. Repeat steps 6-7
9. Click Save

**Proposed optimization (7 steps, 0 friction):**

1. Navigate to /sensor/scada-builder/new
2. **Onboarding modal** appears: "Create a SCADA Package" with fields for:
   - Package name (required, focused)
   - Target device (dropdown, optional)
   - Start from: "Blank Canvas" / "Template" / "Import JSON"
3. Click "Create" -- package name is set, canvas is ready
4. **Tooltip walkthrough** (dismissible, one-time):
   - Step 1: "Drag widgets from the palette to the canvas" (highlights left panel)
   - Step 2: "Configure widget properties here" (highlights right panel)
   - Step 3: "Use Simulation mode to test" (highlights mode switcher)
5. Drag widget to canvas
6. Configure in right panel
7. Ctrl+S or click Save

### 11.2 Flow: Adding and Configuring a Widget

**Current steps:** 5 steps

1. Find widget in palette (scrolling through 16 categories)
2. Drag to canvas
3. Widget is added but not selected (must click to select)
4. Right panel shows Properties tab
5. Configure tag binding, appearance, etc.

**Proposed optimization (3 steps):**

1. Type widget name in palette search bar, or find in Recently Used / Favorites
2. Drag to canvas -- widget is **auto-selected** on drop
3. Right panel auto-shows Properties tab with Config section expanded, tag field focused

### 11.3 Flow: Binding a Tag to a Widget and Setting Up Animations

**Current steps:** 8+ steps across 3 different tabs

1. Select widget
2. In Widget tab, find tag field
3. Type tag name (no auto-complete)
4. Switch to Animations tab
5. Click "Add Animation Rule"
6. Configure trigger tag (type again)
7. Configure animation type
8. No preview -- must switch to Simulation mode to test

**Proposed optimization (5 steps):**

1. Select widget -- Properties tab opens, tag field is prominent at top of Config section
2. Click tag field -- tag picker opens with auto-complete from device tag list
3. Click "Add Animation" link shown inline below the tag field (contextual shortcut)
4. Configure animation -- the selected tag is **pre-filled** as the trigger tag
5. Click "Preview" button within the animation editor -- inline animation preview plays in the right panel

### 11.4 Flow: Creating SVG Diagrams with Connections

**Current steps:** Complex, involves multiple interactions

1. Add SVG shape widgets from palette
2. Position on canvas
3. Create connections by dragging from connection ports
4. Configure connection properties (select edge, edit in Widget tab)

**Proposed enhancements:**

- **Pen tool mode:** Add a "Draw Connection" tool in the secondary toolbar. When active, clicking a widget port starts a connection line, clicking another port completes it.
- **Auto-connect:** When dragging a widget near another widget, show potential connection points with glowing indicators. Releasing the widget within the snap zone auto-creates the connection.
- **Connection routing:** Add "Auto-route" button that cleans up connection paths to avoid overlapping widgets.

### 11.5 Flow: Testing with Simulation Mode

**Current steps:** 6 steps

1. Switch to Simulation mode
2. Right panel changes to SimulationSidebar
3. Find tags to modify
4. Adjust slider/toggle values
5. Observe canvas widgets respond
6. Switch back to Edit mode

**Proposed enhancements:**

- **Quick simulate button** on individual widgets: Right-click widget in Edit mode, select "Simulate this widget". Opens a mini-simulation panel as a popover just for that widget's tags.
- **Record & replay:** Allow users to record a sequence of tag value changes as a "test scenario", then replay it with a single click.
- **Split-screen simulation:** Instead of replacing the right panel, show the Simulation controls in a bottom drawer below the canvas, allowing the canvas to take full width while simulation controls are accessible.

### 11.6 Flow: Deploying to an Edge Device

**Current steps:** 4 steps

1. Save package (auto-triggered if unsaved)
2. Click Deploy dropdown
3. Select "Deploy to Edge Device"
4. DeployScadaDialog handles the rest

**Proposed enhancements:**

- **Pre-deploy validation:** Before opening the dialog, run a validation check:
  - Are all tags bound to valid tag names?
  - Does the target device support all widget types used?
  - Are there any widgets with default/empty configurations?
  - Show a validation summary with warnings/errors
- **Deploy history:** Show recent deployments in the Deploy dropdown with timestamps and status

---

## 12. Performance UX

### 12.1 Loading States and Skeletons

**Package loading (existing package):**

```
+---------------------------------------------------------------+
| [Toolbar skeleton: gray bars]                                 |
+-------+-----------------------------------+-------------------+
| [Left |  [Centered spinner]               | [Right panel      |
| panel |  Loading package...               |  skeleton:        |
| skel- |  [Package Name placeholder]       |  gray bars]       |
| eton] |                                   |                   |
+-------+-----------------------------------+-------------------+
```

- Skeleton panels (left and right) should match the real panel dimensions and show animated shimmer bars where content will appear
- Canvas shows a centered spinner with the package name (if known from the URL)
- Estimated load time shown: "Usually takes 2-3 seconds"

**Widget rendering (lazy):**
- When scrolling the Widget Palette, use virtualized rendering (e.g., react-window) for the 65+ widget cards
- Canvas widgets should render immediately with their outline/container, then load their complex SVG/chart content asynchronously

### 12.2 Canvas Performance with 100+ Widgets

**Problem:** ReactFlow with 100+ nodes can become sluggish, especially with complex SVG renderers.

**Recommendations:**

- **Viewport culling:** Only render widgets that are within the current viewport bounds. ReactFlow supports this natively via `nodesDraggable` and viewport change callbacks.
- **Level-of-detail rendering:** At zoom levels below 50%, replace complex widget renderers with simplified placeholders (colored rectangles with type icons). Full rendering activates at 50%+ zoom.
- **Canvas virtualization threshold:** When widget count exceeds 150, show a performance warning banner: "Large canvas detected. Consider splitting into multiple screens for better performance."
- **Debounced property updates:** When editing properties in the right panel, debounce updates to the canvas by 100ms to prevent per-keystroke re-renders.

### 12.3 Lazy Panel Rendering

- The right panel's tab content should only mount the active tab's component. Other tabs should be unmounted (not just hidden with CSS display:none). This saves memory for heavy tabs like Scripts (CodeMirror) and Animations (preview engine).
- Exception: The Widget/Properties tab should stay mounted when switching between widget-scoped tabs to preserve scroll position and unsaved input states.

### 12.4 Perceived Performance Improvements

- **Optimistic save:** When Save is clicked, immediately show the "Saved" badge and mark as clean, then perform the API call. If the API call fails, revert to "Unsaved" and show error. (Current implementation already does the network call first -- reverse this for perceived speed.)
- **Background auto-save:** Every 60 seconds, if `isDirty`, auto-save to localStorage as a recovery draft. Show a subtle "Draft saved locally" toast. This protects against browser crashes.
- **Widget drop animation:** When a widget is dropped on the canvas, animate it from 0% opacity + slight scale-up to 100% opacity + full size over 150ms. This gives a sense of responsiveness even if the store update takes a few ms.

---

## 13. Error Handling UX

### 13.1 Widget Error States (WidgetErrorBoundary)

**Recommendation:** Every widget renderer should be wrapped in an error boundary that shows:

```
+---------------------------+
|  [!] Widget Error         |
|                           |
|  [Type: Gauge]            |
|  [Error: "tagName is      |
|   undefined"]             |
|                           |
|  [Retry] [Remove Widget]  |
+---------------------------+
```

- **Background:** Red-50 with red-200 border (subtle, not alarming)
- **Error details:** Truncated to 2 lines, expandable on click
- **Retry button:** Re-mounts the widget component
- **Remove Widget button:** Deletes the widget with a confirmation dialog
- **In Preview/Simulation mode:** Show just the error icon with a tooltip (no buttons)

### 13.2 Save Failure Feedback

**Current state:** `saveError` shows a red badge in the toolbar for 5 seconds.

**Recommendations:**

- **Persistent error banner:** Instead of a timed-out badge, show a red banner below the toolbar that persists until the user acknowledges or retries:

```
+---------------------------------------------------------------+
| [X icon] Save failed: Network error. [Retry] [Dismiss]       |  <- bg-red-50
+---------------------------------------------------------------+
```

- **Auto-retry with backoff:** On save failure, attempt retry after 5s, then 15s, then 30s. Show retry countdown: "Retrying in 12s..."
- **Offline detection:** If the browser goes offline (`navigator.onLine` + `offline` event), show a persistent yellow banner: "You are offline. Changes are saved locally and will sync when you reconnect."
- **Conflict detection:** If another user saved the same package while this user was editing (detected via ETag or version mismatch), show a conflict resolution dialog.

### 13.3 Deploy Failure Feedback

- **Deployment progress:** Show a multi-step progress indicator in the DeployScadaDialog:
  1. Validating package...
  2. Compiling for target device...
  3. Transferring to edge device...
  4. Verifying deployment...
- **On failure:** Show the specific step that failed with error details and a "Retry from step X" button
- **Device offline:** If the target device is offline, show: "Device [name] is offline. Deploy will resume automatically when the device reconnects. [Cancel Deploy]"

### 13.4 Expression/Script Error Display

For the Expression engine and the Scripts tab:

- **Syntax errors:** Show inline below the expression/code input with line and column number:
  ```
  Error on line 3, col 12: Unexpected token ')'
  ```
- **Runtime errors (during simulation):** Show in a dedicated "Console" panel at the bottom of the SimulationSidebar:
  ```
  [14:32:05] ERROR: Script "autoLevel" threw: ReferenceError: tank1 is not defined
  [14:32:05] WARN: Expression "=IF(temp>50, ..." returned NaN
  ```
- **Error count badge:** Show on the Scripts tab: `Scripts (2)` where 2 is the number of scripts with errors

### 13.5 Validation Error Presentation

**When should validation run:**
- On save: Validate all widgets have required config (tagName for data-bound widgets)
- On deploy: Full validation including device compatibility
- On tab switch in Properties: Validate the current tab's form fields

**Validation error display:**

- **Field-level:** Red border on invalid inputs with error message below:
  ```
  Tag Name: [_______________]
            ^ Tag not found on device "WQ-Edge-01"
  ```
- **Widget-level:** Show a small warning badge on widgets with validation errors in both the canvas (corner indicator) and the Layers panel (icon)
- **Package-level:** Show a validation summary panel (slide-up from status bar):
  ```
  3 issues found:
    [!] Widget "Gauge 1" - Tag "sensor.pH" not found on target device
    [!] Widget "Pump Control" - No security level assigned for control widget
    [i] Screen "Dashboard" has no default screen link
  ```

---

## 14. Undo/Redo Architecture

### 14.1 Stack Design

The undo/redo system must use an **immutable command stack** with explicit operation boundaries.

```
UndoStack {
  maxDepth: 200             // Hard limit to prevent memory bloat
  commands: Command[]       // Ordered list of applied commands
  cursor: number            // Points to current state (for redo)
  checkpointInterval: 25    // Auto-checkpoint every 25 operations
}

Command {
  id: string                // UUID
  type: CommandType         // 'widget.move' | 'widget.resize' | 'widget.delete' | ...
  timestamp: number
  userId: string            // For multi-user audit
  description: string       // Human-readable: "Moved Gauge 1 to (120, 340)"
  forward: () => void       // Apply
  reverse: () => void       // Undo
  mergeable: boolean        // Whether consecutive same-type ops should merge
}
```

### 14.2 Undoable Operations

| Category | Operations | Merge Policy |
|----------|-----------|--------------|
| Position | Widget move, resize | Merge consecutive moves within 500ms |
| Property | Any config field change | Merge consecutive changes to same field within 300ms |
| Structure | Add widget, delete widget, group, ungroup | Never merge |
| Layer | Z-order change, reparent | Never merge |
| Connection | Add edge, delete edge, reroute | Never merge |
| Screen | Add screen, delete screen, rename | Never merge |
| Bulk | Multi-select move, bulk property change | Atomic (undo reverts ALL) |
| Animation | Add/edit/delete animation rule | Never merge |
| Script | Script content change | Merge within 1000ms |

### 14.3 Merge Policy Detail

Merging prevents the undo stack from filling with per-keystroke entries:

```
Example WITHOUT merge:
  User types "sensor.pH" in tag field:
  Stack: [s] [se] [sen] [sens] [senso] [sensor] [sensor.] [sensor.p] [sensor.pH]
  9 undo steps for one logical action

Example WITH merge (300ms window):
  User types "sensor.pH" in tag field (all keystrokes within 300ms of each other):
  Stack: [sensor.pH]
  1 undo step
```

If the user pauses typing for >300ms, a new command is created. This preserves granularity for thoughtful edits while collapsing rapid typing.

### 14.4 Undo History Panel

Add an optional slide-out panel accessible via `Ctrl+Shift+Z` or from the secondary toolbar:

```
+----------------------------------+
| UNDO HISTORY            [Close]  |
+----------------------------------+
|   > Current State                |
|   -  Moved Gauge 1        14:32 |
|   -  Changed tag binding   14:31 |
|   -  Added Pump 3          14:30 |
|   -- Checkpoint #4 --      14:28 |
|   -  Deleted Valve 2       14:25 |
|   -  Resized Tank 1        14:24 |
|   -  Grouped 3 widgets     14:20 |
|   -- Checkpoint #3 --      14:18 |
|   ...                            |
+----------------------------------+
```

- Clicking any row jumps the state to that point (multi-step undo/redo)
- Checkpoints are shown as visual separators
- Each entry shows: operation icon, description, timestamp
- Entries beyond the cursor (undone) are dimmed with strikethrough

### 14.5 Checkpoint System

Checkpoints capture a full serialized snapshot every 25 operations:

- **Purpose:** Fast jump to distant states without replaying 200 individual undo operations
- **Storage:** In-memory during session, persisted to localStorage on page unload
- **Recovery:** On page reload, restore from the latest checkpoint + replay commands after it
- **Manual checkpoint:** `Ctrl+Shift+S` creates a named checkpoint ("Before refactoring layout")

---

## 15. Cross-Screen & Cross-Package Operations

### 15.1 Cross-Screen Copy/Paste

Widgets must be copyable between screens within the same package:

```
Flow:
1. Select widget(s) on Screen A
2. Ctrl+C (copies to internal clipboard with full config)
3. Switch to Screen B via ScreenTabBar
4. Ctrl+V (paste at center of viewport, or at cursor position if canvas is focused)
```

**Internal clipboard format:**

```typescript
interface ScadaClipboard {
  source: {
    packageId: string;
    screenId: string;
    packageVersion: number;
  };
  widgets: SerializedWidget[];      // Full widget config + position
  edges: SerializedEdge[];          // Connections between copied widgets only
  groups: SerializedGroup[];        // Group definitions if all members are copied
  relativeBounds: { x: number; y: number; w: number; h: number }; // Bounding box
}
```

**Paste behavior:**
- Widgets paste at the center of the current viewport
- If pasting on the same screen, offset by (+20, +20) to avoid exact overlap
- Widget IDs are regenerated (new UUIDs)
- Tag bindings are preserved but flagged with a warning badge if the target screen's device differs
- Group membership is preserved if all group members are in the clipboard

### 15.2 Cross-Package Widget Sharing

Allow copying widgets between different packages via an export/import mechanism:

```
+----------------------------------+
| EXPORT WIDGET(S)                 |
+----------------------------------+
| Selected: 3 widgets, 2 edges    |
|                                  |
| Export as:                       |
|   (*) Widget Snippet (.scada-w) |
|   ( ) Full Screen Template      |
|                                  |
| Include:                         |
|   [x] Tag bindings              |
|   [x] Animation rules           |
|   [x] Script references         |
|   [ ] Permission assignments    |
|                                  |
| [Cancel]              [Export]   |
+----------------------------------+
```

- `.scada-w` files are JSON with a standardized schema
- Import via drag-and-drop onto the canvas or via File > Import Widget
- On import, tag bindings are shown as unresolved (yellow warning) until mapped to the new device's tags

### 15.3 Screen Navigation Links

For multi-screen packages, widgets can act as navigation triggers:

- Any widget can have a `navigateTo` property pointing to another screen
- In Preview/Simulation mode, clicking the widget navigates to that screen
- Visual indicator: A small link icon in the widget's top-right corner (edit mode only)
- Screen navigation map: A visual graph showing which screens link to which others (accessible from the ScreenTabBar context menu)

---

## 16. Multi-User Collaboration

### 16.1 Concurrency Model

The SCADA builder uses **Optimistic Concurrency Control (OCC)** with conflict detection at the field level.

```
Concurrency Flow:
1. User A opens package (version 5)
2. User B opens package (version 5)
3. User A moves Widget 1 to (100, 200) → saves → version 6
4. User B changes Widget 1 color to red → saves → CONFLICT DETECTED
   - Widget 1 position changed by User A (non-overlapping field) → AUTO-MERGE
   - If User B also moved Widget 1 → MANUAL RESOLUTION required
```

### 16.2 Presence Awareness

When multiple users have the same package open, show real-time presence indicators:

```
+---------------------------------------------------------------+
| TOOLBAR                                                       |
|                                    [Avatar A] [Avatar B] [+1] |
+---------------------------------------------------------------+
```

**Presence features:**
- **Avatar row:** Show up to 3 user avatars in the toolbar. Overflow as "+N" badge
- **Cursor ghosts:** Each remote user's cursor is shown as a colored arrow with their name label on the canvas (opacity 40%, fades after 5s of inactivity)
- **Selection indicators:** When User B selects a widget, User A sees a colored dashed border (User B's color) around that widget with a small name label
- **Active screen indicator:** In the ScreenTabBar, show colored dots indicating which screens other users are viewing

### 16.3 Lock System

For critical edits, users can request a temporary lock:

| Lock Type | Scope | Duration | Behavior |
|-----------|-------|----------|----------|
| Widget Lock | Single widget | 5 min auto-release | Others see "Editing by [name]" overlay; properties read-only |
| Screen Lock | Entire screen | 15 min auto-release | Others can view but not edit any widget on the screen |
| Package Lock | Full package | 30 min auto-release | Others get read-only mode with banner "Locked by [name]" |

- Locks auto-release on timeout, page close, or explicit unlock
- Lock holder sees a timer countdown in the status bar
- Admin users can force-release any lock

### 16.4 Conflict Resolution Dialog

When a save conflict is detected that cannot be auto-merged:

```
+-----------------------------------------------+
| CONFLICT DETECTED                     [Close]  |
+-----------------------------------------------+
| Widget "Gauge 1" was modified by both you      |
| and Ayse K. since your last save.              |
|                                                 |
| +-------------------+  +-------------------+   |
| | YOUR VERSION      |  | SERVER VERSION    |   |
| | X: 120, Y: 340    |  | X: 200, Y: 340   |   |
| | Color: #FF0000    |  | Color: #00FF00    |   |
| | Tag: sensor.pH    |  | Tag: sensor.temp  |   |
| +-------------------+  +-------------------+   |
|                                                 |
| For each conflict:                              |
|   Position: (*) Mine  ( ) Theirs  ( ) Merge    |
|   Color:    ( ) Mine  (*) Theirs               |
|   Tag:      (*) Mine  ( ) Theirs               |
|                                                 |
| [Cancel]  [Apply Mine for All]  [Resolve]      |
+-----------------------------------------------+
```

### 16.5 WebSocket Infrastructure

Real-time collaboration requires a persistent WebSocket connection:

```typescript
interface CollaborationMessage {
  type: 'cursor_move' | 'widget_select' | 'widget_update' | 'lock_request' |
        'lock_release' | 'presence_join' | 'presence_leave' | 'save_notify';
  userId: string;
  packageId: string;
  screenId?: string;
  payload: Record<string, unknown>;
  timestamp: number;
  version: number;          // For OCC
}
```

- **Transport:** WebSocket via NATS (existing infrastructure) with automatic reconnect
- **Heartbeat:** Every 30s to maintain presence; timeout after 90s marks user as inactive
- **Bandwidth:** Cursor moves are throttled to 10 updates/sec per user; property changes are debounced by 200ms

---

## 17. Version History & Audit Trail

### 17.1 Version Storage Model

Every save creates an immutable version record:

```typescript
interface PackageVersion {
  id: string;                    // UUID
  packageId: string;
  version: number;               // Sequential: 1, 2, 3, ...
  createdAt: Date;
  createdBy: {
    userId: string;
    displayName: string;
  };
  changeDescription?: string;    // Optional user-provided note
  changeSummary: {               // Auto-generated
    widgetsAdded: number;
    widgetsRemoved: number;
    widgetsModified: number;
    screensAdded: number;
    screensRemoved: number;
    connectionsChanged: number;
  };
  snapshotHash: string;          // SHA-256 of the serialized package
  snapshot: SerializedPackage;   // Full package state at this version
}
```

### 17.2 Version History Panel

Accessible via the primary toolbar menu (kebab icon) > "Version History":

```
+------------------------------------------+
| VERSION HISTORY               [Close]     |
+------------------------------------------+
| v12  Current (unsaved changes)            |
|      [Save as new version]                |
+------------------------------------------+
| v11  "Added alarm thresholds"    Mar 25   |
|      by Okan K.  |  +3 widgets, ~5 props |
|      [View] [Restore] [Compare with v10]  |
+------------------------------------------+
| v10  "Refactored pump layout"    Mar 24   |
|      by Ayse T.  |  ~12 widgets moved    |
|      [View] [Restore] [Compare with v9]   |
+------------------------------------------+
| v9   Auto-save                   Mar 24   |
|      by System   |  ~2 props             |
|      [View] [Restore]                     |
+------------------------------------------+
| ...                                       |
| [Load older versions]                     |
+------------------------------------------+
```

### 17.3 Visual Diff View

"Compare" opens a split-screen diff viewer:

```
+---------------------------------------------------------------+
| COMPARING v10 vs v11                          [Close]          |
+---------------------------+-----------------------------------+
| VERSION 10 (Mar 24)      | VERSION 11 (Mar 25)               |
|                           |                                   |
| [Canvas render of v10]   | [Canvas render of v11]            |
|                           |                                   |
| Widgets in red = removed  | Widgets in green = added          |
| Widgets in yellow = moved | Widgets in blue = config changed  |
+---------------------------+-----------------------------------+
| CHANGE LOG:                                                    |
|  + Added: Gauge "pH Monitor" at (300, 150)                    |
|  + Added: Alarm Rule "High pH" on Gauge "pH Monitor"         |
|  ~ Moved: Pump "Main Intake" from (100,100) to (100, 250)    |
|  ~ Changed: Tank "Storage A" tag from sensor.level1 → .level2|
|  - Removed: Valve "Bypass V3"                                 |
+---------------------------------------------------------------+
```

### 17.4 Restore Behavior

Restoring a previous version:
1. Show confirmation: "Restore package to version 10? This creates a NEW version (v12) with the restored state. No data is lost."
2. On confirm: Serialize v10 snapshot, apply as a new version v12
3. The current unsaved state is preserved as an auto-save checkpoint in localStorage (recoverable)
4. Show toast: "Restored to version 10. Your unsaved changes are backed up locally."

### 17.5 Audit Trail (Enterprise Compliance)

For regulated environments (ISA-62443, FDA 21 CFR Part 11), maintain an immutable audit log:

```typescript
interface AuditEntry {
  id: string;
  timestamp: Date;
  userId: string;
  userDisplayName: string;
  action: AuditAction;          // 'package.create' | 'package.save' | 'package.deploy' | ...
  resourceType: 'package' | 'screen' | 'widget' | 'alarm' | 'script';
  resourceId: string;
  resourceName: string;
  details: Record<string, unknown>;  // Action-specific payload
  ipAddress: string;
  sessionId: string;
}

type AuditAction =
  | 'package.create' | 'package.save' | 'package.delete' | 'package.deploy'
  | 'package.restore' | 'package.export' | 'package.import'
  | 'widget.add' | 'widget.delete' | 'widget.config_change'
  | 'alarm.create' | 'alarm.modify' | 'alarm.acknowledge'
  | 'script.create' | 'script.modify' | 'script.delete'
  | 'permission.grant' | 'permission.revoke'
  | 'collaboration.lock' | 'collaboration.force_unlock';
```

- Audit log is **append-only**, never deleted
- Stored in a separate database table (`scada_audit_log`) with tenant isolation
- Accessible to ADMIN role via a dedicated "Audit Log" page
- Exportable as CSV/PDF for compliance audits
- Retention: Minimum 7 years (configurable per tenant)

---

## 18. Export & Import System

### 18.1 Export Formats

| Format | Contents | Use Case |
|--------|----------|----------|
| `.scada-pkg` (JSON) | Full package: screens, widgets, edges, alarms, scripts, animations | Backup, migration, cross-tenant sharing |
| `.scada-screen` (JSON) | Single screen: widgets, edges, local scripts | Screen template sharing |
| `.scada-w` (JSON) | Widget snippet: 1-N widgets with configs | Widget library building |
| PNG | Rasterized canvas at 2x resolution | Documentation, reports |
| SVG | Vector canvas export (shapes + connections only) | Print-quality diagrams |
| PDF | Multi-page document with all screens | Compliance documentation |
| CSV | Flat table: widget ID, type, tag, position, config | Bulk audit, spreadsheet analysis |

### 18.2 Export Dialog UX

```
+------------------------------------------+
| EXPORT PACKAGE                  [Close]   |
+------------------------------------------+
| Format:                                   |
|   [Package JSON v] [.scada-pkg]          |
|                                           |
| Scope:                                    |
|   (*) Entire package (4 screens)         |
|   ( ) Current screen only                |
|   ( ) Selected widgets (3 selected)      |
|                                           |
| Options:                                  |
|   [x] Include tag bindings               |
|   [x] Include animation rules            |
|   [x] Include scripts                    |
|   [x] Include alarm definitions          |
|   [ ] Include permission assignments     |
|   [ ] Include version history            |
|                                           |
| Image options (PNG/SVG/PDF only):         |
|   Resolution: [2x (Retina) v]            |
|   Background: [Transparent v]            |
|   Include grid: [ ]                      |
|                                           |
| [Cancel]                    [Export]      |
+------------------------------------------+
```

### 18.3 Import Flow

```
Import sources:
1. File upload (.scada-pkg, .scada-screen, .scada-w, .csv)
2. Drag-and-drop onto canvas (auto-detects format)
3. URL import (fetch from remote server)
4. Paste from clipboard (JSON detection)
```

**Import validation pipeline:**

```
1. Schema validation     → Reject if structure is invalid
2. Version compatibility → Warn if exported from newer builder version
3. Widget type check     → Flag unknown widget types (from custom extensions)
4. Tag resolution        → Map source tags to target device tags
5. ID deduplication      → Regenerate all IDs to prevent collisions
6. Permission mapping    → Map source role IDs to target tenant roles
```

**Tag remapping dialog (shown when tag bindings don't match target device):**

```
+----------------------------------------------------+
| TAG REMAPPING REQUIRED                    [Close]   |
+----------------------------------------------------+
| The imported widgets reference tags that don't      |
| exist on the target device "WQ-Edge-01".            |
|                                                     |
| Source Tag            → Target Tag                  |
| sensor.pH.value       → [sensor.pH.value     v] OK |
| sensor.temp.outdoor   → [____________] NOT FOUND    |
| pump.intake.status    → [pump.main.status   v] OK  |
|                                                     |
| [ ] Skip unresolved tags (bind later)              |
|                                                     |
| [Cancel]                         [Import]           |
+----------------------------------------------------+
```

### 18.4 Bulk CSV Import for Widget Configuration

For industrial deployments with 50-200 widgets, manual configuration is impractical. CSV import allows bulk setup:

```csv
widgetType,name,x,y,width,height,tagName,minValue,maxValue,unit,alarmHigh,alarmLow
Gauge,pH Sensor 1,100,100,120,120,sensor.pH.1,0,14,pH,9.5,5.5
Gauge,pH Sensor 2,250,100,120,120,sensor.pH.2,0,14,pH,9.5,5.5
NumericDisplay,Temp 1,100,250,80,60,sensor.temp.1,0,50,C,40,5
Pump,Intake Pump,400,100,200,200,pump.intake.1,,,,,
```

- Import creates widgets at specified positions with full configuration
- Validation: Type-check each row against the widget's config schema
- Error handling: Skip invalid rows with a summary report
- Preview: Show all widgets on canvas in a "pending" state (dashed borders) before committing

---

## 19. Search & Bulk Operations

### 19.1 Global Search (Ctrl+K)

A command-palette style search accessible from anywhere in the builder:

```
+------------------------------------------+
| > Search widgets, tags, screens...  [Esc] |
+------------------------------------------+
| WIDGETS                                   |
|   [Gauge icon] pH Monitor        Screen 1 |
|   [Gauge icon] Temperature Gauge Screen 2 |
| TAGS                                      |
|   sensor.pH.value     → pH Monitor       |
|   sensor.temp.outdoor → Temp Gauge       |
| SCREENS                                   |
|   Dashboard                               |
|   Pump Station Overview                   |
| ACTIONS                                   |
|   Save Package              Ctrl+S       |
|   Deploy to Device                        |
|   Export Package                          |
+------------------------------------------+
```

**Search scope:**
- Widget names, types, IDs
- Tag names (bound to any widget)
- Screen names
- Alarm rule names
- Script names
- Builder actions (command palette)

**Result actions:**
- Click widget result → Navigate to its screen, select it, center in viewport
- Click tag result → Select the widget bound to that tag
- Click screen result → Switch to that screen
- Click action result → Execute the action

### 19.2 Find & Replace Tags

`Ctrl+Shift+H` opens a specialized Find & Replace for tag bindings:

```
+------------------------------------------+
| FIND & REPLACE TAGS              [Close]  |
+------------------------------------------+
| Find:    [sensor.old.*          ]        |
| Replace: [sensor.new.*          ]        |
|                                           |
| [x] Use wildcard matching (* = any)     |
| [ ] Case sensitive                       |
|                                           |
| Scope:                                    |
|   (*) All screens                        |
|   ( ) Current screen only                |
|                                           |
| MATCHES (12 found):                       |
|   [x] Gauge 1     sensor.old.pH    Scr1 |
|   [x] Gauge 2     sensor.old.temp  Scr1 |
|   [x] Pump 3      sensor.old.flow  Scr2 |
|   ...                                    |
|                                           |
| [Replace Selected (12)]  [Cancel]        |
+------------------------------------------+
```

- Wildcard `*` matches any substring: `sensor.old.*` matches `sensor.old.pH`, `sensor.old.temp.value`
- Preview: Selected matches are highlighted on the canvas with an overlay showing the replacement value
- Undo: The entire replace operation is a single undo step

### 19.3 Bulk Property Editor

When multiple widgets of the **same type** are selected, show a bulk edit panel:

```
+------------------------------------------+
| BULK EDIT: 8 Gauge widgets       [Close]  |
+------------------------------------------+
| Shared Properties:                        |
|   Min Value: [0___]  (all same)          |
|   Max Value: [100_]  (all same)          |
|   Unit:      [degC]  (all same)          |
|                                           |
| Mixed Properties:                         |
|   Tag Name:  [-- mixed --]  [Edit Each]  |
|   Color:     [-- mixed --]  [Set All]    |
|                                           |
| Position:                                 |
|   [Align Left] [Align Top] [Distribute H]|
|   [Align Right] [Align Bottom] [Dist. V] |
|   [Same Width] [Same Height]             |
|                                           |
| [Apply]                     [Cancel]      |
+------------------------------------------+
```

- "All same" fields can be edited to change all widgets at once
- "Mixed" fields show a placeholder; editing sets the same value on all
- "Edit Each" opens a compact table view for per-widget editing
- Alignment and distribution tools work on any multi-selection (even mixed types)

### 19.4 Alignment & Distribution Tools

Add to the secondary toolbar when multiple widgets are selected:

```
[Align: Left | Center | Right | Top | Middle | Bottom] | [Distribute: H | V] | [Match: Width | Height | Both]
```

- **Align Left:** Move all selected widgets so their left edges align with the leftmost widget
- **Distribute Horizontal:** Space all selected widgets evenly between the leftmost and rightmost
- **Match Width:** Set all selected widgets to the same width as the first-selected widget
- All alignment operations are a single undo step

---

## 20. Template Management System

### 20.1 Template Hierarchy

```
Templates
├── System Templates (read-only, shipped with the platform)
│   ├── Water Treatment Dashboard
│   ├── Pump Station Overview
│   ├── Tank Farm Monitoring
│   ├── Alarm Summary Screen
│   └── ...
├── Tenant Templates (shared within organization)
│   ├── [Created by users with TEMPLATE_MANAGE permission]
│   └── ...
└── Personal Templates (per user)
    ├── [Created by any user via "Save as Template"]
    └── ...
```

### 20.2 Template Browser Dialog

Accessible from: Onboarding modal "Start from Template", Primary toolbar menu > "Templates", or `Ctrl+T`:

```
+---------------------------------------------------------------+
| TEMPLATE BROWSER                                     [Close]   |
+---------------------------------------------------------------+
| [Search templates...]          [System v] [Tenant] [Personal] |
+---------------------------------------------------------------+
| CATEGORIES:           | PREVIEW:                               |
| > Water Treatment (5) | +-------------------------------------+
| > Pump Stations (3)   | |                                     |
|   Aquaculture (4)     | |  [Canvas preview render at 50%]     |
| > Alarm Views (2)     | |                                     |
| > Custom (3)          | +-------------------------------------+
|                        | Water Treatment Dashboard              |
|                        | 12 widgets | 3 screens | 2 alarms    |
|                        | By: System | Updated: 2026-03-01     |
|                        |                                       |
|                        | Description:                          |
|                        | Standard water treatment monitoring    |
|                        | layout with pH, temperature, flow,    |
|                        | and dissolved oxygen gauges.          |
|                        |                                       |
|                        | [Use Template]  [Preview Full Screen] |
+---------------------------------------------------------------+
```

### 20.3 Save as Template

From widget context menu or primary toolbar menu:

```
+------------------------------------------+
| SAVE AS TEMPLATE                [Close]   |
+------------------------------------------+
| Name:     [_____________________]        |
| Category: [Water Treatment     v]        |
| Description:                              |
| [________________________________]       |
| [________________________________]       |
|                                           |
| Scope:                                    |
|   (*) Current screen (14 widgets)        |
|   ( ) Selected widgets (3 selected)      |
|   ( ) Entire package (4 screens)         |
|                                           |
| Visibility:                               |
|   ( ) Personal (only me)                 |
|   (*) Tenant (shared with organization)  |
|                                           |
| [x] Include tag binding placeholders     |
|     (tags become ${TAG_1}, ${TAG_2}...)  |
| [ ] Include alarm definitions            |
| [ ] Include scripts                      |
|                                           |
| [Cancel]              [Save Template]    |
+------------------------------------------+
```

**Tag placeholder system:** When saving as template, tag bindings are converted to numbered placeholders (`${TAG_1}`, `${TAG_2}`). When applying the template, a mapping dialog asks the user to assign real tags to each placeholder:

```
+------------------------------------------+
| MAP TEMPLATE TAGS                [Close]  |
+------------------------------------------+
| This template requires 4 tag bindings:    |
|                                           |
| ${TAG_1} (pH reading)                    |
|   → [sensor.pH.1          v] [Browse]    |
|                                           |
| ${TAG_2} (temperature)                   |
|   → [sensor.temp.1        v] [Browse]    |
|                                           |
| ${TAG_3} (flow rate)                     |
|   → [_____________________] [Browse]     |
|                                           |
| ${TAG_4} (pump status)                   |
|   → [pump.intake.status   v] [Browse]    |
|                                           |
| [Cancel]                    [Apply]       |
+------------------------------------------+
```

### 20.4 Template CRUD Permissions

| Action | Required Permission |
|--------|-------------------|
| Browse system templates | Any authenticated user |
| Use any template | `SCADA_EDIT` |
| Save personal template | `SCADA_EDIT` |
| Save tenant template | `TEMPLATE_MANAGE` |
| Edit/delete personal template | Owner only |
| Edit/delete tenant template | `TEMPLATE_MANAGE` |
| Manage system templates | `SUPER_ADMIN` |

---

## 21. Internationalization (i18n)

### 21.1 Scope Definition

| Layer | i18n Support | Mechanism |
|-------|-------------|-----------|
| Builder Chrome (menus, labels, buttons) | Full i18n | `react-i18next` with namespace `scada-builder` |
| Widget Labels (on canvas) | User-defined, not translated | Stored as-is in package JSON |
| Alarm Text | Translatable per tenant | Alarm rules store `text_key`, translations in `i18n` table |
| Error Messages | Full i18n | Error codes mapped to translation keys |
| Tooltip & Help Text | Full i18n | `scada-builder.help.*` namespace |
| Right-to-Left (RTL) | Builder chrome only | CSS logical properties (`margin-inline-start`, etc.) |

### 21.2 Supported Languages (Phase 1)

| Language | Code | Direction | Priority |
|----------|------|-----------|----------|
| English | `en` | LTR | P0 -- Default |
| Turkish | `tr` | LTR | P0 -- Primary user base |
| Arabic | `ar` | RTL | P2 -- Future expansion |
| Norwegian | `no` | LTR | P2 -- Aquaculture market |

### 21.3 Translation Key Structure

```json
{
  "scada-builder": {
    "toolbar": {
      "save": "Save",
      "deploy": "Deploy",
      "undo": "Undo",
      "redo": "Redo",
      "mode": {
        "edit": "Edit",
        "preview": "Preview",
        "simulation": "Simulation"
      }
    },
    "palette": {
      "search": "Search widgets...",
      "recentlyUsed": "Recently Used",
      "favorites": "Favorites",
      "categories": {
        "indicators": "Indicators",
        "control": "Control",
        "shapes": "Shapes",
        "pumps": "Pumps",
        "valves": "Valves",
        "tanks": "Tanks"
      }
    },
    "properties": {
      "general": "General Properties",
      "configuration": "Configuration",
      "permissions": "Permissions",
      "noSelection": "Select a widget to view properties"
    },
    "errors": {
      "saveFailed": "Save failed: {{reason}}",
      "tagNotFound": "Tag \"{{tag}}\" not found on device \"{{device}}\""
    }
  }
}
```

### 21.4 RTL Layout Adaptations

When the builder locale is RTL (Arabic):
- **Panel positions flip:** Left panel moves to right, right panel moves to left
- **Toolbar direction:** Primary and secondary toolbars flow right-to-left
- **Tab order:** Tab navigation follows RTL reading order
- **Canvas:** Canvas itself does NOT mirror (SCADA diagrams are spatial, not linguistic)
- **Rulers:** Horizontal ruler numbers increase right-to-left
- **CSS approach:** Use CSS logical properties throughout:
  ```css
  /* Instead of: margin-left: 16px */
  margin-inline-start: 16px;
  /* Instead of: padding-right: 8px */
  padding-inline-end: 8px;
  /* Instead of: text-align: left */
  text-align: start;
  ```

### 21.5 Date/Number Formatting

- Dates: Use `Intl.DateTimeFormat` with the active locale
- Numbers: Use `Intl.NumberFormat` (Turkish uses comma for decimal: `3,14`)
- Tag values on canvas: Always use the device's locale (typically `en-US` with dot decimal) regardless of builder locale, since tag values are technical data

---

## 22. Print & Reporting

### 22.1 Print Mode

Accessible via `Ctrl+P` or Primary toolbar menu > "Print":

```
+---------------------------------------------------------------+
| PRINT PREVIEW                                       [Close]    |
+---------------------------------------------------------------+
| Page Setup:                                                    |
|   Size: [A4 Landscape v]  Margin: [10mm v]                   |
|   [x] Include header (package name + date)                    |
|   [x] Include footer (page number + tenant name)             |
|   [ ] Include widget labels                                   |
|   [ ] Include tag names below widgets                         |
|   [x] Fit to page (auto-scale)                               |
|                                                                |
| Screens to print:                                              |
|   [x] Dashboard                                   Page 1     |
|   [x] Pump Station                                Page 2     |
|   [ ] Alarm Summary                                           |
|   [x] Sensor Layout                               Page 3     |
|                                                                |
| +-----------------------------------------------------------+ |
| |                                                           | |
| |              [Page 1 preview render]                      | |
| |                                                           | |
| +-----------------------------------------------------------+ |
|                    < Page 1 of 3 >                             |
|                                                                |
| [Cancel]                    [Print]  [Export PDF]              |
+---------------------------------------------------------------+
```

### 22.2 Print Stylesheet

```css
@media print {
  /* Hide builder chrome */
  .toolbar, .left-panel, .right-panel, .status-bar { display: none; }

  /* Canvas takes full page */
  .canvas-container {
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  /* Widget optimizations */
  .scada-widget {
    break-inside: avoid;        /* Don't split widgets across pages */
    -webkit-print-color-adjust: exact;  /* Preserve colors */
  }

  /* Grid and guides hidden */
  .canvas-grid, .smart-guides, .selection-handles { display: none; }

  /* Page breaks between screens */
  .screen-container { break-after: page; }
}
```

### 22.3 Report Generation

For compliance and documentation purposes, generate a structured report:

```
SCADA Package Report
====================
Package: Water Treatment Plant HMI
Version: 12 | Last saved: 2026-03-25 14:32 by Okan K.
Target Device: WQ-Edge-01

1. SCREEN SUMMARY
   - Dashboard (14 widgets, 6 connections)
   - Pump Station (8 widgets, 4 connections)
   - Alarm Summary (3 widgets, 0 connections)

2. WIDGET INVENTORY
   | # | Type    | Name          | Screen    | Tag              | Alarm |
   |---|---------|---------------|-----------|------------------|-------|
   | 1 | Gauge   | pH Monitor    | Dashboard | sensor.pH.1      | Yes   |
   | 2 | Gauge   | Temp Monitor  | Dashboard | sensor.temp.1    | Yes   |
   | 3 | Pump    | Intake Pump   | PumpStn   | pump.intake.1    | No    |
   ...

3. TAG BINDING MAP
   | Tag Name          | Widget(s)              | Screen(s)   |
   |-------------------|------------------------|-------------|
   | sensor.pH.1       | pH Monitor, pH Trend   | Dashboard   |
   | sensor.temp.1     | Temp Monitor           | Dashboard   |
   ...

4. ALARM RULES
   | Alarm Name    | Severity | Condition              | Widgets   |
   |---------------|----------|------------------------|-----------|
   | High pH       | CRITICAL | sensor.pH.1 > 9.5     | pH Monitor|
   | Low Temp      | WARNING  | sensor.temp.1 < 5     | Temp Mon. |
   ...

5. SCRIPT INVENTORY
   | Script Name  | Type   | Trigger       | Lines |
   |-------------|--------|---------------|-------|
   | autoLevel   | Worker | On tag change | 45    |
   ...

6. PERMISSION MATRIX
   | Widget         | View Roles        | Control Roles    |
   |---------------|-------------------|------------------|
   | Intake Pump   | operator, admin   | admin            |
   ...
```

- Export formats: PDF (primary), HTML, CSV (tables only)
- Auto-generated on deploy (stored with deployment record)
- Accessible from Version History panel per version

---

## 23. Alarm UX & Real-Time Indicators

### 23.1 Canvas Alarm Visualization

When a widget's bound tag triggers an alarm condition (in Preview or Simulation mode):

```
ALARM SEVERITY VISUAL MAP:

CRITICAL (red):
+---------------------------+
| [!] CRITICAL              |  ← Pulsing red border (2px)
|                           |     Red-50 background tint
|    [Widget Content]       |     Alarm icon top-right
|                           |     Audible beep (if enabled)
+---------------------------+

HIGH (orange):
+---------------------------+
| [!] HIGH                  |  ← Solid orange border (2px)
|                           |     Orange-50 background tint
|    [Widget Content]       |     Warning icon top-right
|                           |
+---------------------------+

WARNING (yellow):
+---------------------------+
|                           |  ← Solid yellow border (1px)
|    [Widget Content]       |     Yellow-50 background tint
|                    [!]    |     Small badge bottom-right
+---------------------------+

INFO (blue):
+---------------------------+
|                           |  ← Blue dot indicator only
|    [Widget Content]       |     No border change
|                       [i] |     Info badge bottom-right
+---------------------------+
```

### 23.2 Alarm Banner (Preview/Simulation Mode)

A persistent alarm summary bar between the mode banner and the canvas:

```
+---------------------------------------------------------------+
| [!] 2 CRITICAL  [!] 1 HIGH  [!] 3 WARNING         [Mute] [v] |
+---------------------------------------------------------------+
```

- Clicking severity count expands to show individual alarms
- "Mute" silences audible alarms for this session
- `[v]` expands full alarm list panel

### 23.3 Alarm Acknowledge Flow

In Preview/Simulation mode, operators need to acknowledge alarms:

```
+------------------------------------------+
| ACTIVE ALARMS                    [Close]  |
+------------------------------------------+
| [!] CRITICAL  pH Sensor 1 > 9.5          |
|     sensor.pH.1 = 10.2  |  Since 14:32  |
|     [Acknowledge] [Silence] [Details]    |
+------------------------------------------+
| [!] HIGH  Temperature > 40C              |
|     sensor.temp.1 = 42.1 |  Since 14:28 |
|     [Acknowledge] [Silence] [Details]    |
+------------------------------------------+
| [i] WARNING  Flow rate low               |
|     sensor.flow.1 = 2.1  |  Since 14:15 |
|     Acknowledged by Okan K. at 14:20     |
+------------------------------------------+
```

**Acknowledge states:**
1. **Active (unacknowledged):** Pulsing indicator, audible alarm
2. **Acknowledged:** Static indicator, no audio, shows who acknowledged and when
3. **Cleared:** Alarm condition no longer true, moves to alarm history
4. **Silenced:** Active but muted for configured duration (15m, 30m, 1h)

### 23.4 Alarm History Timeline

Accessible from the Package-scoped "Alarms" tab:

```
+------------------------------------------+
| ALARM HISTORY                    [Filter] |
+------------------------------------------+
| Timeline:  [Today v] [All Severities v]  |
+------------------------------------------+
| 14:32 ─── CRITICAL ─── pH Sensor 1      |
|            Value: 10.2 (threshold: 9.5)  |
|            Duration: active (23 min)     |
|            Ack: Okan K. at 14:35        |
| ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ |
| 14:28 ─── HIGH ─── Temperature           |
|            Value: 42.1 (threshold: 40)   |
|            Duration: 14:28 – 14:45 (17m) |
|            Ack: System auto-ack          |
| ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ |
| 14:15 ─── WARNING ─── Flow Rate Low     |
|            Value: 2.1 (threshold: 5.0)   |
|            Duration: 14:15 – 14:22 (7m)  |
| ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ |
```

### 23.5 Alarm Sound Configuration

```
+------------------------------------------+
| ALARM SOUND SETTINGS             [Close]  |
+------------------------------------------+
| Master Volume: [========|--] 80%         |
|                                           |
| CRITICAL: [Siren v]     [x] Repeat      |
| HIGH:     [3-Beep v]    [x] Repeat      |
| WARNING:  [Single v]    [ ] Repeat      |
| INFO:     [None v]                       |
|                                           |
| [ ] Respect browser "Do Not Disturb"    |
| [x] Auto-mute after acknowledgement     |
+------------------------------------------+
```

---

## 24. Performance Benchmarks & SLA

### 24.1 Target Metrics

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| **Initial Load (empty package)** | < 2s (P95) | Time from navigation to interactive canvas |
| **Initial Load (100-widget package)** | < 4s (P95) | Time from navigation to all widgets rendered |
| **Widget Drop Response** | < 50ms | Time from drop event to widget visible on canvas |
| **Property Panel Update** | < 100ms | Time from field change to canvas re-render |
| **Undo/Redo Execution** | < 30ms | Time from Ctrl+Z to state restored |
| **Canvas Pan/Zoom FPS** | 60fps | Measured during continuous pan at 100% zoom with 100 widgets |
| **Canvas Pan/Zoom FPS (200+ widgets)** | 30fps minimum | Same as above but with LOD rendering active |
| **Save (API round-trip)** | < 1s (P95) | Time from Save click to confirmation |
| **Mode Switch** | < 200ms | Time from mode button click to new mode rendered |
| **Search Results (Ctrl+K)** | < 50ms | Time from keystroke to results displayed |
| **Memory (100 widgets)** | < 150MB heap | Measured via Chrome DevTools Performance Monitor |
| **Memory (200 widgets)** | < 250MB heap | Same |
| **Bundle Size (initial)** | < 500KB gzipped | Main chunk loaded on first visit |
| **Bundle Size (lazy)** | < 200KB per tab | Code-split right panel tabs |

### 24.2 Performance Budget

```
Resource Budget (gzipped):
  React + ReactFlow core:     180KB
  SCADA builder page:         120KB
  Widget renderers (lazy):    150KB (loaded on demand per widget type)
  Properties panel tabs:       80KB (5 tabs × 16KB average)
  Simulation engine:           60KB (loaded only in Simulation mode)
  Script editor (CodeMirror):  90KB (loaded only when Scripts tab opens)
  Total initial:             ~300KB
  Total with all features:   ~680KB
```

### 24.3 Performance Monitoring

Embed lightweight performance telemetry in the builder:

```typescript
interface PerformanceMetrics {
  // Collected automatically
  initialLoadMs: number;
  widgetCount: number;
  screenCount: number;
  fps: number;                    // Rolling 5-second average
  heapUsedMB: number;

  // Collected on user actions
  widgetDropMs: number;
  propertyUpdateMs: number;
  undoRedoMs: number;
  saveMs: number;

  // Sent to telemetry endpoint every 60 seconds
  sessionId: string;
  tenantId: string;
  browserInfo: string;
  viewportSize: string;
}
```

- **FPS warning:** If rolling FPS drops below 24 for 5+ seconds, show a yellow status bar warning: "Performance degraded. Consider splitting into multiple screens or collapsing panels."
- **Memory warning:** If heap exceeds 300MB, show a warning: "High memory usage detected. Save your work and refresh the browser."
- **Performance dashboard:** Tenant admins can view aggregated performance metrics on the Admin panel to identify heavy packages

### 24.4 Lighthouse Targets

| Category | Target Score |
|----------|-------------|
| Performance | > 85 |
| Accessibility | > 90 |
| Best Practices | > 90 |
| SEO | N/A (internal app) |

---

## 25. Offline Mode & Resilience

### 25.1 Offline Capability Tiers

| Tier | Capability | Implementation |
|------|-----------|----------------|
| **Tier 1: Edit Continuity** | Continue editing when network drops | Local state in Zustand (already in place) |
| **Tier 2: Local Persistence** | Survive browser crash/close | Auto-save to IndexedDB every 30s |
| **Tier 3: Background Sync** | Auto-upload when reconnected | Service Worker with Background Sync API |

### 25.2 Network State Detection & UI

```typescript
enum NetworkState {
  ONLINE = 'online',           // Normal operation
  DEGRADED = 'degraded',       // High latency (>2s API response)
  OFFLINE = 'offline',         // No network connectivity
  RECONNECTING = 'reconnecting' // Attempting to restore connection
}
```

**Status bar indicator:**

```
ONLINE:       [Green dot] Connected
DEGRADED:     [Yellow dot] Slow connection — changes saving locally
OFFLINE:      [Red dot] Offline — changes saved locally, will sync when reconnected
RECONNECTING: [Spinner] Reconnecting... (attempt 3/5)
```

### 25.3 IndexedDB Storage Schema

```typescript
interface OfflineStore {
  // Current working state
  packages: {
    [packageId: string]: {
      data: SerializedPackage;
      lastModified: number;
      serverVersion: number;      // Version when last synced
      isDirty: boolean;
      pendingChanges: ChangeRecord[];
    };
  };

  // Queued API calls
  syncQueue: {
    id: string;
    method: 'PUT' | 'POST';
    url: string;
    body: string;
    createdAt: number;
    retryCount: number;
  }[];
}
```

### 25.4 Sync Strategy on Reconnect

```
Reconnection Flow:
1. Detect online status (navigator.onLine + fetch heartbeat)
2. Fetch server version of the package
3. Compare server version with local serverVersion:
   a. Server same version → Push local changes (no conflict)
   b. Server newer version:
      i.  Fetch server diff since local serverVersion
      ii. Attempt auto-merge (field-level, non-overlapping changes)
      iii. If conflict → Show conflict resolution dialog (Section 16.4)
4. Process syncQueue in order (FIFO)
5. Update local serverVersion to latest
6. Show toast: "All changes synced successfully" or "3 of 5 changes synced, 2 conflicts need resolution"
```

### 25.5 Service Worker Registration

```typescript
// Only register if browser supports required APIs
if ('serviceWorker' in navigator && 'BackgroundSync' in window) {
  const registration = await navigator.serviceWorker.register('/sw-scada.js');

  // Register background sync for pending saves
  await registration.sync.register('scada-sync-pending');
}
```

**Service Worker scope:** `/sensor/scada-builder/*` only. Does not interfere with other platform modules.

**Cached assets:** Builder JS/CSS chunks, widget SVG icons, font files. NOT API responses (those are too dynamic).

### 25.6 Data Loss Prevention

Multiple layers of protection against data loss:

| Layer | Mechanism | Recovery |
|-------|-----------|----------|
| **L1: In-memory** | Zustand store | Survives minor UI re-renders |
| **L2: Session** | sessionStorage snapshot every 10s | Survives tab crash, not browser crash |
| **L3: Persistent** | IndexedDB auto-save every 30s | Survives browser crash, OS crash |
| **L4: Server** | Explicit save to API | Survives device loss |
| **L5: Version History** | All saved versions retained | Survives accidental overwrite |

**Recovery prompt on page load:**

```
+------------------------------------------+
| UNSAVED WORK DETECTED            [Close]  |
+------------------------------------------+
| A local backup of "Water Treatment HMI"  |
| was found from 14:32 today.              |
|                                           |
| Server version: v11 (saved at 14:20)     |
| Local backup:   v11 + unsaved changes    |
|                 (12 minutes of work)      |
|                                           |
| [Restore Local Backup]                   |
| [Discard and Load Server Version]        |
+------------------------------------------+
```

---

## 26. Advanced Data Binding UX

### 26.1 Tag Picker Dialog

Replace the plain text input for tag binding with a rich tag picker:

```
+------------------------------------------+
| TAG PICKER                       [Close]  |
+------------------------------------------+
| [Search tags...                       ]  |
| Device: [WQ-Edge-01 v]                  |
+------------------------------------------+
| TAG TREE:                                 |
| v sensor                                 |
|   v pH                                   |
|     - sensor.pH.1          numeric  [+]  |
|     - sensor.pH.2          numeric  [+]  |
|   v temperature                          |
|     - sensor.temp.outdoor  numeric  [+]  |
|     - sensor.temp.indoor   numeric  [+]  |
|   v flow                                 |
|     - sensor.flow.intake   numeric  [+]  |
| v pump                                   |
|   - pump.intake.status     boolean  [+]  |
|   - pump.intake.speed      numeric  [+]  |
| v valve                                  |
|   - valve.main.position    numeric  [+]  |
|   - valve.bypass.status    boolean  [+]  |
+------------------------------------------+
| RECENTLY USED:                            |
|   sensor.pH.1 | sensor.temp.outdoor      |
+------------------------------------------+
| Selected: sensor.pH.1                    |
| Type: numeric | Range: 0-14 | Unit: pH  |
|                                           |
| [Cancel]                    [Bind Tag]   |
+------------------------------------------+
```

**Features:**
- **Tree view:** Tags organized hierarchically by dot-separated path segments
- **Search:** Fuzzy search across tag paths, with real-time filtering of the tree
- **Type indicators:** `numeric`, `boolean`, `string`, `enum` shown as colored badges
- **Live value preview:** When hovering a tag in Preview/Simulation mode, show its current value
- **Recently used:** Last 10 tags used in this package, persisted in localStorage
- **Multi-device support:** Device dropdown switches the tag tree (for packages that span multiple devices)
- **Click `[+]`:** Immediately binds the tag and closes the dialog

### 26.2 Expression Builder

For widgets that support computed values (expressions), provide a visual builder alongside the text editor:

```
+------------------------------------------+
| EXPRESSION EDITOR                [Close]  |
+------------------------------------------+
| Mode: [Visual v] [Text]                 |
+------------------------------------------+
| VISUAL BUILDER:                           |
|                                           |
|  IF  [sensor.pH.1] [>] [9.0]            |
|  THEN [#FF0000] (red)                   |
|  ELSE IF [sensor.pH.1] [<] [6.0]        |
|  THEN [#FFAA00] (orange)                |
|  ELSE [#00FF00] (green)                 |
|                                           |
| [+ Add condition]                        |
+------------------------------------------+
| GENERATED EXPRESSION:                     |
| =IF(sensor.pH.1 > 9.0, "#FF0000",       |
|   IF(sensor.pH.1 < 6.0, "#FFAA00",      |
|     "#00FF00"))                           |
+------------------------------------------+
| PREVIEW: #00FF00 (green)                 |
|   Using: sensor.pH.1 = 7.2              |
+------------------------------------------+
| [Cancel]                    [Apply]       |
+------------------------------------------+
```

- **Visual mode:** Drag-and-drop condition builder for non-programmers
- **Text mode:** Full expression editor with syntax highlighting and auto-complete
- **Live preview:** Evaluates the expression with current or simulated tag values
- **Validation:** Real-time syntax checking with clear error messages
- **Function library:** Sidebar listing all available functions (`IF`, `MIN`, `MAX`, `AVG`, `ROUND`, etc.) with descriptions

### 26.3 Wildcard & Pattern Binding

For bulk operations and dynamic dashboards, support pattern-based tag bindings:

```
Pattern syntax:
  sensor.pH.*           → Matches sensor.pH.1, sensor.pH.2, sensor.pH.inlet
  sensor.*.temperature  → Matches sensor.tank1.temperature, sensor.tank2.temperature
  pump.{1,2,3}.status   → Matches pump.1.status, pump.2.status, pump.3.status
```

**Use cases:**
- **Template widgets:** A gauge template bound to `sensor.pH.*` auto-creates N gauge instances (one per matching tag) when applied to a device
- **Dynamic tables:** A table widget bound to `sensor.*.temperature` auto-populates rows for all matching tags
- **Reusable screens:** Screen templates with pattern bindings adapt to any device's tag structure

### 26.4 Tag Alias System

Allow users to define human-readable aliases for cryptic tag paths:

```
+------------------------------------------+
| TAG ALIASES                      [Close]  |
+------------------------------------------+
| Alias                 | Tag Path          |
|----------------------|-------------------|
| pH Inlet             | sensor.pH.1       |
| pH Outlet            | sensor.pH.2       |
| Water Temperature    | sensor.temp.1     |
| Main Pump Status     | pump.intake.1     |
| [+ Add Alias]                            |
+------------------------------------------+
```

- Aliases are package-scoped (defined per package)
- In the Tag Picker, aliases are shown alongside the raw tag path
- On the canvas, widgets can optionally display the alias instead of the raw tag
- CSV export/import includes alias column
- Aliases are purely cosmetic — the raw tag path is always stored in the package JSON

### 26.5 Data Transformation Pipeline

For advanced users, allow a transformation pipeline between the raw tag value and the widget display:

```
Tag Value → [Transform 1] → [Transform 2] → Widget Display

Example pipeline:
  sensor.temp.1 (raw: 295.15 Kelvin)
    → Unit Convert (Kelvin → Celsius): 22.0
    → Round (2 decimal places): 22.00
    → Format ("{{value}} C"): "22.00 C"
    → Widget displays: "22.00 C"
```

**Available transforms:**

| Transform | Parameters | Example |
|-----------|-----------|---------|
| Unit Convert | from, to | Kelvin → Celsius |
| Scale | factor, offset | `value * 0.1 + 5` |
| Round | decimals | 2 decimal places |
| Clamp | min, max | Clamp to 0-100 |
| Format | template | `"{{value}} PSI"` |
| Map | valueMap | `{0: "Off", 1: "On", 2: "Fault"}` |
| Threshold | ranges | `[{max:30, label:"Normal"}, {max:50, label:"High"}]` |

**Pipeline editor UI:**

```
+------------------------------------------+
| DATA PIPELINE               [Close]       |
+------------------------------------------+
| Source: sensor.temp.1                     |
| Raw value: 295.15                        |
+------------------------------------------+
| 1. [Unit Convert v]                      |
|    From: [Kelvin v]  To: [Celsius v]     |
|    → 22.0                                |
+------------------------------------------+
| 2. [Round v]                             |
|    Decimals: [2]                         |
|    → 22.00                               |
+------------------------------------------+
| 3. [Format v]                            |
|    Template: [{{value}} C       ]        |
|    → "22.00 C"                           |
+------------------------------------------+
| [+ Add Transform]                        |
| Final output: "22.00 C"                  |
|                                           |
| [Cancel]                    [Apply]       |
+------------------------------------------+
```

---

## Implementation Priority

### Tier 1: Foundation (Weeks 1-4)

| Priority | Section | Effort | Impact |
|----------|---------|--------|--------|
| P0 | 3. Right Panel Tab Restructuring | M | High -- fixes the tab overflow/truncation issue |
| P0 | 2.4 Left Panel Unification | M | High -- recovers 176px of canvas space |
| P0 | 14.1-14.3 Undo/Redo Stack & Merge | M | High -- data safety foundation |
| P1 | 4.3 Palette Search Bar | S | High -- dramatically improves widget discovery |
| P1 | 2.6 Panel Collapse | M | High -- enables full-canvas mode |
| P1 | 8.2 Color Contrast Fixes | S | High -- accessibility compliance |
| P1 | 24.1 Performance Benchmarks | S | High -- establishes measurable targets |

### Tier 2: Core Experience (Weeks 5-8)

| Priority | Section | Effort | Impact |
|----------|---------|--------|--------|
| P2 | 2.3 Toolbar Split | M | Medium -- reduces toolbar crowding |
| P2 | 4.4/4.5 Recently Used + Favorites | S | Medium -- speeds up repeat workflows |
| P2 | 5.2A Collapsible Sub-sections | M | Medium -- reduces scroll in Properties |
| P2 | 7.1A Mode Indicator Banner | S | Medium -- prevents user confusion about active mode |
| P2 | 15.1 Cross-Screen Copy/Paste | M | Medium -- essential multi-screen workflow |
| P2 | 19.1 Global Search (Ctrl+K) | M | High -- central discoverability for all entities |
| P2 | 26.1 Tag Picker Dialog | M | High -- replaces error-prone manual tag typing |
| P2 | 23.1-23.2 Canvas Alarm Visualization | M | High -- core SCADA operator requirement |

### Tier 3: Enterprise Features (Weeks 9-12)

| Priority | Section | Effort | Impact |
|----------|---------|--------|--------|
| P3 | 6.5 Smart Guides | L | Medium -- quality-of-life for precise layouts |
| P3 | 11.1 Onboarding Modal | M | Medium -- first-run experience |
| P3 | 12.2 Canvas LOD Rendering | L | Medium -- performance for large projects |
| P3 | 13.2 Save Failure Enhancements | M | Medium -- data loss prevention |
| P3 | 17.1-17.4 Version History & Diff | L | High -- enterprise requirement for audit |
| P3 | 18.1-18.3 Export/Import System | L | Medium -- inter-system interoperability |
| P3 | 19.2-19.3 Find/Replace Tags + Bulk Edit | M | Medium -- industrial-scale configuration |
| P3 | 20.1-20.3 Template Management | L | Medium -- reusability and standardization |
| P3 | 25.1-25.4 Offline Mode | L | High -- field deployment resilience |

### Tier 4: Advanced & Polish (Weeks 13-16)

| Priority | Section | Effort | Impact |
|----------|---------|--------|--------|
| P4 | 6.4 Minimap | S | Low -- helpful but not critical |
| P4 | 9.2 Touch-Friendly Adjustments | M | Low -- limited tablet user base |
| P4 | 10.5 Builder Dark Theme | L | Low -- cosmetic preference |
| P4 | 14.4 Undo History Panel | M | Low -- power user feature |
| P4 | 16.1-16.5 Multi-User Collaboration | XL | High -- but complex, phased rollout |
| P4 | 17.5 Audit Trail (Compliance) | L | Medium -- regulatory environments |
| P4 | 21.1-21.4 Internationalization | L | Medium -- market expansion |
| P4 | 22.1-22.3 Print & Reporting | M | Medium -- compliance documentation |
| P4 | 23.3-23.5 Alarm Acknowledge + Sound | M | Medium -- operator workflow |
| P4 | 26.2-26.5 Expression Builder + Pipeline | L | Medium -- advanced user features |

**Effort key:** S = 1-3 days, M = 3-7 days, L = 1-2 weeks, XL = 3-4 weeks

**Total estimated timeline:** 16 weeks (4 months) for full enterprise-grade implementation

---

## Appendix: Current File Reference

| File | Role |
|------|------|
| `ScadaPackageBuilderPage.tsx` | Main page layout, toolbar, mode switching, panel orchestration |
| `PropertiesPanel.tsx` | Right panel with 8 tabs, widget config, alarms, control, trends |
| `WidgetPalette.tsx` | Left panel with 16 categories, 65+ draggable widget cards |
| `LayersPanel.tsx` | Bottom-left panel with z-ordered widget list, group support |
| `SceneTreePanel.tsx` | Top-left panel with hierarchical screen tree, drag-to-reparent |
| `CanvasSettings.tsx` | Floating canvas toolbar (zoom, grid, snap, theme, background) |
| `ScreenTabBar.tsx` | Screen tab bar with drag-to-reorder, context menu |
| `SimulationSidebar.tsx` | Right panel in simulation mode (tag values, scenarios, alarms) |
| `UndoRedoToolbar.tsx` | Undo/redo buttons with stack depth indicators |
| `widget-configs/index.ts` | Registry mapping 36 widget types to config components |
| `widget-configs/GeneralPropertiesSection.tsx` | Shared general properties (name, position, lock, visible) |
| `scada-widget.types.ts` | Canonical ScadaWidgetType union (36 types) + EquipmentSubType (25 types) |
