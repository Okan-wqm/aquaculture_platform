# SCADA Advanced Configuration Guide

**Version:** 1.0
**Last Updated:** 2026-03-27
**Platform:** RuFlo Aquaculture v3
**Audience:** System administrators, engineers, integrators

---

## Table of Contents

1. [Advanced Widget Configuration](#1-advanced-widget-configuration)
2. [Animation System Deep Dive](#2-animation-system-deep-dive)
3. [SVG Integration](#3-svg-integration)
4. [Process Flow Diagrams](#4-process-flow-diagrams)
5. [Advanced Tag Management](#5-advanced-tag-management)
6. [Screen Templates and Reuse](#6-screen-templates-and-reuse)
7. [FUXA Widget Integration](#7-fuxa-widget-integration)
8. [Edge Integration and Real-Time Data](#8-edge-integration-and-real-time-data)
9. [Performance Optimization](#9-performance-optimization)
10. [Security and Access Control](#10-security-and-access-control)
11. [5 Complete SCADA Screen Blueprints](#11-5-complete-scada-screen-blueprints)
12. [Troubleshooting Advanced Issues](#12-troubleshooting-advanced-issues)
13. [Complete Widget Reference Table](#13-complete-widget-reference-table)

---

## 1. Advanced Widget Configuration

This chapter covers configuration options beyond the basics. If you have not read the User Guide, start there first.

### 1.1 Custom Widget Properties Deep Dive

Every widget has a set of properties that control its appearance and behavior. You access these by clicking a widget in Edit Mode and looking at the Properties panel on the right side.

**Property categories common to most widgets:**

| Category | Properties | What They Control |
|----------|-----------|-------------------|
| **Identity** | Label, Name, Description | How the widget is identified on screen and in code |
| **Data** | Tag, Expression Binding | Where the widget gets its data |
| **Appearance** | Colors, Font Size, Border, Opacity | How the widget looks |
| **Layout** | Width, Height, X, Y, Rotation | Size, position, and orientation |
| **Behavior** | Security Level, Modes | How the widget responds to user interaction |
| **Animation** | Zones, Color Ranges, State Rules | How the widget changes based on data values |

### 1.2 Conditional Formatting Rules

Conditional formatting changes a widget's appearance based on the value it is displaying. This is different from animation -- formatting is about static visual states, while animation is about motion.

**Color Zones (for Gauges and Progress Bars):**

Color zones let you define ranges of values and assign a color to each range. The widget automatically switches colors as the value changes.

**How to configure:**

1. **Click** the widget.
2. In Properties, **find** the **"Zones"** section.
3. **Click** "+ Add Zone."
4. For each zone, set:
   - **Min** -- the lower boundary of the zone
   - **Max** -- the upper boundary of the zone
   - **Color** -- the color for values within this range

**Example for a temperature gauge (0-40 C range):**

| Zone | Min | Max | Color | Meaning |
|------|-----|-----|-------|---------|
| 1 | 0 | 15 | Blue (#3b82f6) | Low temperature |
| 2 | 15 | 25 | Green (#22c55e) | Normal range |
| 3 | 25 | 40 | Red (#ef4444) | High temperature alarm |

**Color Ranges (for Status Indicators):**

Status Indicators can show up to 8 different colors based on the tag value. Each color range maps a numeric value to a specific color.

**Example for pump status:**

| Value | Color | Label |
|-------|-------|-------|
| 0 | Gray | Stopped |
| 1 | Green | Running |
| 2 | Red | Fault |

### 1.3 Multi-Condition Animations

When a single condition is not enough, you can chain multiple conditions using the FUXA state machine (covered in detail in Chapter 2) or by using computed tags on the backend.

**Backend-computed composite tags:**

When you need to combine multiple sensor readings into a single state:

```
Backend calculation:
  composite_status = if (temp > 30 AND pressure > 3) then 4
                     elif (temp > 25 OR pressure > 2.5) then 3
                     else 2

SCADA binding:
  tagName: "device.composite_status"
  Rule: tag = 4 -> State 4, tag = 3 -> State 3, tag = 2 -> State 2
```

This approach keeps complex logic on the server and gives SCADA a simple numeric state to display.

### 1.4 Dynamic Text with Tag Value Substitution

Some widgets support showing tag values within text labels. For example, a Static Text widget can display: "Current Temperature: {temperature_1} C" where `{temperature_1}` is replaced with the actual sensor value at runtime.

This is configured through expression bindings or template syntax, depending on the widget type.

### 1.5 Widget Grouping and Hierarchy

**Grouping widgets:**

When you have several widgets that belong together (for example, a pump icon, its status indicator, and its current display), you can group them:

1. **Hold Shift** and **click** each widget to select multiple widgets.
2. **Press** Ctrl+G (or right-click and select "Group").
3. The widgets are now grouped. Moving one moves them all. Resizing the group resizes all members proportionally.

**Ungrouping:** Select the group and press Ctrl+Shift+G or right-click and select "Ungroup."

**Hierarchy:** Within a group, widgets maintain their individual properties. You can click into a group to select individual members without ungrouping.

### 1.6 Z-Ordering and Layering

When widgets overlap, the z-order (stacking order) determines which widget appears on top.

**To change z-order:**

1. **Right-click** the widget.
2. **Select** one of:
   - "Bring to Front" -- puts the widget on top of all others
   - "Send to Back" -- puts the widget behind all others

**Practical use:** Place background shapes (like colored rectangles) behind equipment widgets to create visual zones on your screen. Send the rectangles to back so they do not cover your interactive widgets.

> **Summary:** Advanced widget configuration includes conditional color formatting, multi-condition logic via backend tags, dynamic text substitution, grouping for organization, and z-ordering for layered layouts.

---

## 2. Animation System Deep Dive

### 2.1 The Six Animation Types

The SCADA Builder supports six types of animation that can be applied to widgets:

#### Color Animation (Threshold-Based Color Changes)

**What it does:** Changes the widget's color based on a sensor value crossing predefined thresholds.

**Configuration:**
- Define color zones with Min/Max ranges
- Each zone maps to a specific color
- The widget transitions between colors as the value changes

**Example: Heat exchanger temperature indicator**

| Value Range | Color | Meaning |
|-------------|-------|---------|
| < 15 C | Blue | Cold |
| 15-25 C | Green | Normal |
| 25-30 C | Yellow | Warm |
| > 30 C | Red | Hot |

---

#### Visibility Animation (Show/Hide Based on Conditions)

**What it does:** Makes a widget visible or invisible depending on a tag value.

**Use cases:**
- Show a warning icon only when an alarm is active
- Hide a maintenance panel when equipment is running normally
- Display an "OFFLINE" label when a device is disconnected

**Configuration:** Bind the widget's visibility property to a boolean tag. When the tag value is true (or non-zero), the widget is visible. When false (or zero), it is hidden.

---

#### Rotation Animation (Continuous Spin or Angle-Based)

**What it does:** Rotates a widget element. Two sub-types:

- **Continuous spin:** The element rotates continuously while a condition is true (like a pump impeller spinning while the pump runs).
- **Angle-based:** The element rotates to a specific angle based on a numeric value (like a valve disc opening to 45 degrees based on a position reading).

**Configuration for continuous spin:**
- Bind rotation to a boolean tag (pump running = spin, pump stopped = still)

**Configuration for angle-based:**
- Bind rotation to a numeric tag
- Set the mapping: value range 0-100% maps to angle range 0-360 degrees
- Formula: rotation = (value / max_value) * 360

---

#### Scale Animation (Grow/Shrink Based on Value)

**What it does:** Changes the size of a widget element based on a numeric value. The element grows larger for higher values and shrinks for lower values.

**Use cases:**
- A circle that grows as pressure increases
- A bar that extends as a level rises

**Configuration:** Bind the scale property to a tag and set the value-to-scale mapping.

---

#### Fill Animation (Level Indicators and Progress Bars)

**What it does:** Changes the fill level of a container widget based on a numeric value.

**Use cases:**
- A tank graphic that fills with animated liquid proportional to the real tank level
- A progress bar that fills as a process completes

**Configuration:**
- Bind the fill level to a tag
- Set Min and Max values (0% and 100% fill)
- The Tank Level widget has a built-in wave animation that makes the liquid look realistic

---

#### Movement Animation (Position Change Based on Value)

**What it does:** Moves a widget element from one position to another based on a tag value.

**Use cases:**
- A slider indicator that moves along a track based on valve position
- A marker on a diagram that shifts position based on flow distribution

**Configuration:** Bind the X or Y position to a tag and set the value-to-position mapping.

### 2.2 FUXA State Machine (6-State Animation System)

FUXA widgets use a 6-state animation system. Each state represents a different operating condition with its own colors, animation speed, and behavior.

**The 6 states:**

| State | Meaning | Default Color | Animation Behavior |
|-------|---------|---------------|-------------------|
| **State 0** | Off / Stopped | Gray (#808080) | No movement |
| **State 1** | Starting / Opening | Yellow (#FFD700) | Slow rotation or opening |
| **State 2** | Running / Normal | Green (#00FF00) | Continuous rotation or flow |
| **State 3** | Warning | Orange (#FFA500) | Fast rotation + blinking |
| **State 4** | Alarm / Fault | Red (#FF0000) | Rapid blinking |
| **State 5** | Maintenance / Disabled | Blue (#0000FF) | No movement, semi-transparent |

**State transitions (how a pump widget moves between states):**

```
Motor off             -> State 0  (gray, still)
Start command sent    -> State 1  (yellow, slowly starting)
Reached normal speed  -> State 2  (green, spinning continuously)
Temperature high      -> State 3  (orange, warning)
Overcurrent detected  -> State 4  (red, alarm)
Maintenance mode      -> State 5  (blue, disabled)
```

**How to configure state rules:**

1. **Click** the FUXA widget on the canvas.
2. In Properties, **find** the **"State Machine"** section.
3. **Set** "Tag Name" to the tag that drives the state (for example, `pump1.temperature`).
4. **Click** "Add Rule" to create mapping rules.
5. For each rule, set:
   - **Condition:** Choose from `<`, `<=`, `=`, `>=`, `>`, or `Between`
   - **Value:** The threshold number (or range for Between)
   - **Target State:** Which state (0-5) to activate

**Example rule set for pump temperature monitoring:**

```
Rule 1: tag_value = 0           -> State 0 (Off)
Rule 2: tag_value between 1,2   -> State 1 (Starting)
Rule 3: tag_value between 3,79  -> State 2 (Normal running)
Rule 4: tag_value >= 80         -> State 3 (Warning)
Rule 5: tag_value >= 95         -> State 4 (Alarm)
Rule 6: tag_value = -1          -> State 5 (Maintenance)
```

> **WARNING:** Rules are evaluated top to bottom. The first matching rule wins. Place more specific rules above less specific ones. For example, put `>= 95` ABOVE `>= 80`, otherwise all values above 80 (including 95+) would match the warning rule and never reach the alarm rule.

**Multiple conditions (AND/OR logic):**

- For **AND logic**: Use the "Between" condition, which inherently checks that a value is both above a minimum and below a maximum.
- For **OR logic**: Create multiple separate rules that map to the same state.

```
AND example: tag between 20,60 -> State 2
  (means: tag >= 20 AND tag <= 60)

OR example:
  Rule A: tag = 0   -> State 0
  Rule B: tag = -1  -> State 0
  (means: tag = 0 OR tag = -1, both map to State 0)
```

### 2.3 Multiple Animations on One Widget

A single widget can have multiple animations active simultaneously:

- A pump can both **rotate** (based on running status) and **change color** (based on temperature).
- A tank can both **fill** (based on level) and **change border color** (based on alarm status).

When combining animations, ensure they do not conflict (for example, two animations trying to set the same color will cause unpredictable behavior).

### 2.4 Animation Performance Tips

- **Minimize animated widgets per screen.** Every animation consumes browser resources (CPU and GPU).
- **Use CSS animations** (which SCADA Builder applies automatically) rather than JavaScript-based animations. CSS animations are hardware-accelerated and much smoother.
- **Pause animations for hidden widgets.** The system automatically pauses animations for widgets that are scrolled out of view or on inactive screens.
- **Prefer simple animations.** A color change uses far fewer resources than a complex rotation with blinking.
- **Test on target hardware.** If operators use older computers or tablets, test animation performance on those devices, not just on your development machine.

> **Summary:** Six animation types cover most industrial visualization needs. The FUXA 6-state system provides standardized equipment status visualization. Rules are evaluated top to bottom. Watch performance when using many animations.

---

## 3. SVG Integration

### 3.1 What is SVG?

SVG (Scalable Vector Graphics) is a file format for images made of mathematical shapes rather than pixels. Unlike JPG or PNG images, SVG images stay sharp at any size -- they never get blurry when you zoom in. This makes SVG ideal for SCADA equipment symbols.

### 3.2 Importing Custom SVG Graphics

You can upload your own SVG files to use as custom equipment symbols, logos, or decorative elements.

**How to import an SVG:**

1. **Drag** a **Custom SVG** widget from the Widget Palette onto the canvas.
2. In Properties, **find** the SVG upload area.
3. **Click** "Upload SVG" and **select** your `.svg` file.
4. The SVG appears on the canvas. You can resize it freely.

**Requirements for SVG files:**
- File must end with `.svg`
- File size must be under 1 MB (1,048,576 bytes)
- File must start with `<svg>` or `<?xml>`
- For best results, set the `viewBox` attribute in the `<svg>` element

### 3.3 SVG Path Animation

SVG paths (the shapes inside an SVG file) can be animated by binding their properties to tags:

- **Fill color:** Change the color of a path based on a sensor value.
- **Stroke color:** Change the outline color.
- **Opacity:** Make a path fade in or out.
- **Transform (rotate, scale, translate):** Move or resize a path based on data.

### 3.4 Equipment Symbol Library

The SCADA Builder includes over 50 built-in industrial equipment symbols:

- **Pumps:** centrifugal, gear, diaphragm, submersible, vacuum
- **Valves:** butterfly, ball, gate, globe, check, relief, control, needle, solenoid
- **Tanks:** vertical, horizontal, conical, pressure vessel, mixer, silo
- **Filters:** drum, biological, sand, UV
- **Heat exchangers:** shell-tube, plate, air cooler
- **Electrical:** motor, VFD, fuse, contactor

All symbols follow ISA-5.1 (Instrumentation Symbols and Identification) standards, making them recognizable to engineers worldwide.

### 3.5 Creating Custom Equipment Symbols

If the built-in library does not include the equipment you need, you can create custom symbols:

1. **Design** the SVG in a vector graphics editor (such as Inkscape, Adobe Illustrator, or Figma).
2. **Set** the viewport to 64x64 pixels for icon-sized symbols.
3. **Keep** the design simple -- use basic paths and shapes, avoid complex gradients.
4. **Export** as SVG.
5. **Upload** to SCADA Builder using the Custom SVG widget.

**Best practices:**
- Use a consistent style across all custom symbols.
- Keep file sizes small (under 150 KB for icons).
- Test the symbol at different zoom levels to ensure readability.
- Use descriptive `id` attributes on SVG elements if you plan to animate individual parts.

### 3.6 SVG Color and Style Manipulation via Tags

For advanced use, SVG element styles can be bound to tags through the FUXA widget system:

1. Upload the SVG as a FUXA widget (not a plain Custom SVG).
2. Define variables inside the SVG using the FUXA export markers (`//!export-start` and `//!export-end`).
3. Bind each variable to a tag in the configuration panel.

This allows sensor data to dynamically control individual colors, visibility, and transforms within a complex SVG graphic.

### 3.7 Best Practices for SVG in SCADA

- **Optimize before uploading.** Remove unnecessary metadata, reduce decimal precision, and clean up unused elements. Use SVGO for automated optimization:
  ```bash
  npx svgo widget.svg -o widget-optimized.svg
  ```
  Note: For FUXA widgets, do NOT remove `<script>` elements -- they contain the animation engine.

- **Typical file sizes:**
  - Simple widget (LED, button): 10-30 KB
  - Medium widget (pump, valve): 50-150 KB
  - Complex widget (VFD, mixer): 150-300 KB
  - If a file exceeds 300 KB, it should be optimized.

- **Test in the target browser.** SVG rendering can vary slightly between browsers. Test in Chrome (recommended), Firefox, and Edge.

> **Summary:** SVG provides sharp, scalable graphics for SCADA. Import custom symbols, animate them with tags, and keep files optimized for performance.

---

## 4. Process Flow Diagrams

### 4.1 Process Design Principles

SCADA Builder enables you to create process flow diagrams that follow the ISA-5.1 (Instrumentation Symbols and Identification) standard for industrial process diagrams.

**Fundamental layout rules:**

1. **Flow direction:** Left to right, top to bottom (standard reading direction).
2. **Equipment placement:** Arrange equipment in process order, from left (input) to right (output).
3. **Pipe routing:** Use horizontal and vertical lines. Avoid diagonal lines.
4. **Instrumentation:** Place measurement points on or near the pipe they are measuring.
5. **Signal lines:** Use different line styles to distinguish signal lines from process pipes.

**ISA-5.1 Symbol Reference:**

```
Pump:              (O)>     (circle + arrow)
Valve:             >|<      (butterfly shape)
Tank:              [___]    (rectangle)
Heater:            <<<      (zigzag)
Filter:            |//|     (cross-hatched)
UV System:         |UV|     (labeled box)
Sensor/Transmitter: (TT)   (circle with letter pairs)
```

### 4.2 Pipe Connections (Edges)

Pipes connecting equipment are called "edges" in the SCADA Builder. There are three types:

| Edge Type | Description | Best Used For |
|-----------|-------------|---------------|
| **Orthogonal** | 90-degree right-angle routing (horizontal and vertical segments only) | Standard P&ID pipe lines. **Recommended for most industrial diagrams.** |
| **Multi-Handle** | Freeform curve with multiple draggable control points | Complex routing that cannot be done with right angles |
| **Draggable** | Smooth curve with one or two Bezier control points | Aesthetic decorative connections |

### 4.3 Pipe Color Coding (Connection Types)

Each pipe can be assigned a connection type that determines its visual style. These follow industrial color-coding conventions:

| Connection Type | Label | Color | Thickness | Line Style | Use For |
|----------------|-------|-------|-----------|-----------|---------|
| `process-pipe` | Process Pipe | Dark gray (#1f2937) | 3px | Solid | Main water/air lines |
| `electrical` | Electrical Signal | Red (#dc2626) | 2px | Dashed (8,4) | 4-20mA signals, voltage |
| `pneumatic` | Pneumatic Signal | Blue (#2563eb) | 2px | Double-dash (12,3,3,3) | Air/gas signal connections |
| `hydraulic` | Hydraulic Line | Green (#16a34a) | 2px | Long-short dash | Hydraulic fluid connections |
| `instrument` | Instrument Signal | Orange (#ea580c) | 2px | Dash-dot (8,3,2,3) | Sensor and control signals |
| `data-link` | Data/Communication | Purple (#7c3aed) | 2px | Dotted (2,4) | Digital data, network |
| `capillary` | Capillary Tube | Gray (#6b7280) | 1px | Solid (thin) | Capillary connections |
| `steam` | Steam Line | Orange (#f97316) | 3px | Short dashes (6,2) | Steam process lines |
| `drain-vent` | Drain/Vent | Teal (#0891b2) | 2px | Dash-dot-dot (4,4,1,4) | Drainage and ventilation |

**Recommended color codes for aquaculture:**

| Pipe Function | Connection Type | Appearance |
|--------------|----------------|------------|
| Clean water (inlet) | `process-pipe` | Dark gray, 3px, solid |
| Dirty water (outlet) | `drain-vent` | Teal, 2px, dash-dot-dot |
| Recirculated water | `hydraulic` | Green, 2px |
| Emergency line | `steam` | Orange, 3px |
| Chemical dosing | `capillary` | Gray, 1px |
| Air/oxygenation | `pneumatic` | Blue, 2px |

**General pipe thickness rules:**
- Main lines: 3px (`process-pipe`, `steam`)
- Secondary lines: 2px (`electrical`, `instrument`, `hydraulic`)
- Bypass / thin lines: 1px (`capillary`)

### 4.4 Drawing Pipes (Step by Step)

1. Make sure you are in **Edit Mode**.
2. **Hover** your mouse over the edge of a source widget (for example, the outlet side of a pump). A small circle (connection handle) appears.
3. **Click** the connection handle and **drag** your mouse toward the target widget (for example, a filter's inlet).
4. **Release** the mouse on the target widget's connection handle.
5. A pipe (edge) is drawn between the two widgets.
6. **Click** the pipe to select it. In the Properties panel:
   - **Change** the edge type (Orthogonal, Multi-Handle, Draggable)
   - **Set** the connection type (process-pipe, electrical, etc.)

**Connection validation rules:**
- A widget cannot connect to itself.
- Duplicate connections between the same outlet and inlet are blocked.
- Connections must go from an output handle to an input handle.

### 4.5 Orthogonal Edge Routing Modes

Orthogonal edges (right-angle pipes) support three routing modes:

| Routing Mode | Behavior |
|-------------|----------|
| `horizontal-first` | The pipe goes horizontal first, then turns vertical |
| `vertical-first` | The pipe goes vertical first, then turns horizontal |
| `auto` | The system chooses the best route based on the positions of the two widgets |

**Customizing pipe routes:**

- **Add a bend point:** Double-click on a pipe segment to add a new corner point.
- **Move a bend point:** Click and drag the small square at a corner.
- **Delete a bend point:** Right-click a bend point and select "Delete."
- **Reset the path:** If the pipe looks tangled, right-click and select "Reset Path" to let the system re-route automatically.

Snap precision for bend points is 5 pixels.

### 4.6 Flow Animation Details

Pipes can show animated flow (moving dashes) to indicate liquid or air is flowing through the pipe. This animation is controlled by the **EdgeFlowConfig** system.

**Architecture:**

```
Tag Value Bus          useEdgeFlowState           Edge Renderer
(live sensor data) --> (condition evaluation) --> (animation control)
                          |                          |
                          v                          v
                     { isFlowing,              CSS animation:
                       speed,                 edge-flow Xs linear
                       direction }            infinite [normal|reverse]
```

**EdgeFlowConfig settings:**

| Setting | Description | Values |
|---------|-------------|--------|
| **tagName** | The tag that controls the animation | Example: `pump1.running` |
| **flowCondition** | When the animation should run | `nonZero`: animate when value > 0. `boolean`: animate when truthy (1, true, "on"). `always`: always animate (for testing). |
| **flowSpeed** | Animation speed in seconds (lower = faster) | Default: 2. Range: 0.5 (fast) to 5 (slow). |
| **reverseOnNegative** | Reverse flow direction when value is negative | `true` or `false` |

**How to configure flow animation on a pipe:**

1. **Click** the pipe (edge) to select it.
2. In Properties, **find** the "Flow Config" section.
3. **Set** the Tag Name to the tag that indicates flow (for example, a pump's running status tag: `pump1.running`).
4. **Set** the Flow Condition:
   - Use `boolean` for digital (on/off) tags (like a pump running status).
   - Use `nonZero` for analog tags (like a flow meter reading -- animate when flow > 0).
   - Use `always` only for testing.
5. **Set** the Flow Speed (1.5 seconds is typical for water flow).
6. **Save** and **preview**.

**Flow direction control:**

- **Normal (forward):** Flow animates from the source widget to the target widget.
- **Reverse:** When `reverseOnNegative` is set to `true` and the tag value is negative, flow reverses direction. This is useful for bidirectional pumps.

**Pulsed flow (for dosing systems):**

Chemical dosing lines typically show intermittent flow rather than continuous flow. To achieve this:

1. Set `flowSpeed` to a high value (4-5 seconds).
2. Use the dosing pump's on/off tag with a `boolean` flow condition -- flow shows only when the dosing pump is running.

**Performance notes:**
- Each edge uses independent CSS animations (hardware-accelerated).
- Animations only run when `isFlowing = true`.
- Tag subscriptions are automatically cleaned up when the component unmounts.
- Animations pause for edges that are not visible on screen.

### 4.7 Flow Indicator (Chevron)

When flow animation is active on Orthogonal or Draggable edges, a small arrow (chevron) appears at the 50% midpoint of the pipe:

```xml
<polygon points="-7,-5 0,0 -7,5"
         fill="#374151"
         transform="translate(midX,midY) rotate(angle)">
  <animate attributeName="opacity"
           values="1;0.2;1"
           dur="1.5s"
           repeatCount="indefinite"/>
</polygon>
```

This arrow fades in and out and points in the flow direction, making it easy to see at a glance which way liquid is moving.

> **Summary:** Process flow diagrams use ISA-5.1 standards. Three edge types, nine connection type styles, and tag-driven flow animation create professional P&ID diagrams. Use orthogonal edges for standard industrial layouts.

---

## 5. Advanced Tag Management

### 5.1 Tag Expressions and Calculations

For Gauge and Progress Bar widgets, the "Expression Binding" field allows you to transform raw tag values before display.

**Common use cases:**

- **Unit conversion:** Convert Fahrenheit to Celsius using a formula.
- **Scaling:** Convert a raw sensor value (0-4096) to an engineering value (0-100%).
- **Averaging:** Compute the average of multiple sensors.
- **Threshold detection:** Output 1 when a value exceeds a threshold, 0 otherwise.

### 5.2 Virtual Tags (Computed from Other Tags)

Virtual tags are calculated on the backend from one or more real tags. They do not correspond to a physical sensor -- instead, they are computed values.

**Examples:**

| Virtual Tag | Calculation | Purpose |
|-------------|-------------|---------|
| `system.total_flow` | Sum of all flow meters | Total facility flow rate |
| `system.avg_temperature` | Average of all temperature sensors | Facility average temperature |
| `pump1.efficiency` | Power output / Power input | Motor efficiency calculation |
| `system.composite_alarm` | Combined alarm logic | Simplified alarm state for SCADA display |

Virtual tags are configured on the backend by your system administrator.

### 5.3 Tag Quality and Status

Tags can have a quality indicator that tells you whether the data is reliable:

| Quality | Meaning | Display |
|---------|---------|---------|
| **Good** | Data is fresh and reliable | Normal display |
| **Uncertain** | Data may be stale or approximate | Usually shown with a question mark or grayed text |
| **Bad** | Data is unavailable or corrupted | "No Data" or "---" |

When configuring critical displays, consider adding a Status Indicator widget next to each gauge to show the tag quality.

### 5.4 Historical Tag Data

Tags with history enabled store their values over time. The Trend Chart widget reads this historical data to draw line graphs.

**Time ranges available:**
- 1 hour, 6 hours, 24 hours, 7 days, 30 days

**Data resolution:** The system automatically aggregates data for longer time ranges to maintain performance. A 30-day chart does not store every individual reading -- it uses averages over intervals.

### 5.5 Tag Alarm Configuration

Each tag can have alarm thresholds configured:

- **Low-Low Alarm** (Critical): Value dangerously low
- **Low Warning**: Value below normal
- **High Warning**: Value above normal
- **High-High Alarm** (Critical): Value dangerously high

These thresholds are configured on the backend (not in the SCADA Builder directly). When a tag value crosses a threshold, the alarm system triggers and the Alarm Banner displays the alert.

### 5.6 Bulk Tag Operations

When building large SCADA screens, you may need to bind many tags at once. Tips for efficiency:

- Use the **Tag Browser's search function** to quickly find tags by name.
- Use the **"Recent Tags"** list to access frequently used tags without searching.
- When creating duplicate widgets (for example, six identical pump gauges), configure one widget fully, then **Ctrl+C / Ctrl+V** to copy it. You only need to change the tag on each copy.

> **Summary:** Expression bindings transform raw values. Virtual tags provide computed data. Tag quality indicates reliability. Historical data powers trend charts. Alarm thresholds trigger the alarm system.

---

## 6. Screen Templates and Reuse

### 6.1 Creating Screen Templates

When you have a screen layout that works well and you want to reuse it (for example, every pump station should look the same):

1. **Build** the screen with all widgets configured.
2. **Save** the screen as a template (check your system's template save option).
3. The template stores:
   - Widget types and positions
   - Widget properties (except tag bindings)
   - Edge connections and styles
   - Canvas settings

### 6.2 Template Parameters

When creating a new screen from a template, you need to:

1. **Select** the template from the template library.
2. **Assign** a new screen name.
3. **Rebind** all tags to the new equipment (templates save the layout but not the specific data connections, since each instance monitors different equipment).

### 6.3 Cloning Screens

To create an exact copy of an existing screen:

1. **Open** the screen you want to copy.
2. Use the **"Clone"** or **"Duplicate Screen"** function.
3. A copy is created with all widgets, connections, and tag bindings intact.
4. **Rename** the clone and **update** the tag bindings as needed.

### 6.4 Import/Export Screens

SCADA projects can be exported and imported as JSON files.

**Export format:**

```json
{
  "version": "2.0",
  "screens": [
    {
      "id": "screen-001",
      "name": "RAS Main Screen",
      "canvasSize": { "width": 1920, "height": 1080 },
      "nodes": [ ... ],
      "edges": [ ... ]
    }
  ],
  "metadata": {
    "exportedAt": "2026-03-27T14:30:00Z",
    "exportedBy": "engineer@aqua.com",
    "platform": "aquaculture-platform"
  }
}
```

**Version compatibility:**
- v1.x packages are automatically converted to v2.x format (connection type normalization: old `pipe` becomes `process-pipe`, old `cable` becomes `electrical`).
- FUXA widget SVG content is included in the package.

**Deploying to a different facility:**

1. **Export** the JSON package from the source facility.
2. **Import** the JSON package at the target facility.
3. Tag bindings will be empty -- **rebind** all tags to the target facility's sensors.
4. Equipment links will be broken -- **reconnect** them to the target facility's equipment.

> **Summary:** Templates, cloning, and import/export enable rapid deployment of SCADA screens across multiple facilities. Always rebind tags after importing.

---

## 7. FUXA Widget Integration

### 7.1 What is FUXA?

FUXA is an open-source SCADA/HMI project with a community of contributors who have created over 1,450 SVG widgets. These are industrial-quality animated components: pumps that spin, valves that open and close, tanks that fill and empty.

RuFlo SCADA Builder includes FUXA community widgets because:

- They provide industrial-standard animated visuals.
- Their 6-state animation system reflects real-time equipment status.
- They support variable binding for live sensor data.
- Each widget is self-contained and requires no additional development.

### 7.2 FUXA Widget Catalog

**Catalog categories:**

| Category | Subcategories | Widget Count |
|----------|--------------|--------------|
| Process Engineering | Pumps, Valves, Tanks, Heat Exchangers, Compressors | ~25 |
| Electrical | Logic elements, Instruments | ~10 |
| Dynamic SVG | Indicators, Controls, Meters | ~12 |
| Basic | Shapes, Flowchart elements | ~10 |

**Tier classification:**

- **Tier 1 (Standard):** 18 or fewer variables, 6 states. Loads synchronously (fast). Examples: Centrifugal Pump, Gate Valve, Vertical Tank.
- **Tier 2 (Complex):** More than 18 variables, custom JavaScript, advanced animations. Loads lazily (on demand). Examples: Control Valve (22 variables), VFD (24 variables), Mixing Tank (22 variables).

### 7.3 Uploading a FUXA SVG Widget

**Step 1: Prepare or download the SVG file.**

FUXA widget SVG files contain embedded `<script>` blocks that drive the animation engine. The file structure looks like this:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <script>
    //!export-start
    var _pn_setState = 0;
    var _pc_color0 = '#808080';
    var _pc_color1 = '#00ff00';
    var _pb_visible = true;
    var _ps_label = 'Pump 1';
    //!export-end

    function putValue(id, value) {
      // FUXA standard variable update function
    }
    function postValue(id, value) {
      // FUXA standard user interaction feedback function
    }
  </script>
  <!-- SVG visual elements -->
  <circle id="body" cx="100" cy="100" r="80" fill="#808080"/>
  <path id="impeller" d="..." fill="#fff"/>
</svg>
```

The variables between `//!export-start` and `//!export-end` are automatically detected by the system.

**Step 2: Upload in the Widget Config panel.**

1. In the SCADA Builder, **drag** a "FUXA Widget" from the left panel onto the canvas.
2. In the Properties panel, **find** "FUXA SVG File" and **click** "Upload FUXA SVG."
3. **Select** the `.svg` file.
4. The system validates the file and extracts the variables automatically.

**Step 3: File size limit (1 MB).**

FUXA SVG widgets have a maximum file size of 1 MB (1,048,576 bytes). Typical widgets are 50-300 KB. If the limit is exceeded:

```
Error: File too large (1250KB). Maximum: 1024KB
```

Optimize the SVG by removing unnecessary paths (see Section 3.7).

**Step 4: Script security (Sandbox iframe).**

FUXA widgets contain `<script>` blocks which could pose security risks. The system manages this by:

- The SVG file is **NOT** sanitized by DOMPurify (scripts are preserved because they are required for animation).
- The widget renders inside a **sandboxed `<iframe>`** with `allow-scripts` (JavaScript runs) but **without `allow-same-origin`** (the script cannot access cookies, localStorage, or the parent application).
- This means FUXA JavaScript is isolated from your application.

### 7.4 FUXA Variable Binding

After uploading, the system displays the extracted variables in the configuration panel.

**Variable types (determined by the prefix in the variable name):**

| Prefix | Type | Example | Description |
|--------|------|---------|-------------|
| `_pn_` | number | `_pn_setState` | Numeric value (temperature, speed, level) |
| `_ps_` | string | `_ps_label` | Text value (label, name) |
| `_pb_` | boolean | `_pb_visible` | On/off value (visible/hidden, enabled/disabled) |
| `_pc_` | color | `_pc_color0` | Color value (hex format like #FF0000) |

**Variable groups (auto-detected from keywords in variable names):**

| Group | Keywords | Purpose |
|-------|----------|---------|
| stateColor | `state`, `color` | Status colors and state index |
| appearance | `opacity`, `visible`, `font` | Visual settings |
| transform | `rotate`, `scale`, `translate` | Geometric transformations |
| custom | Everything else | Custom variables |

**Binding sensor tags to variables:**

Below each variable in the config panel, there is a "Bind to tag..." field. Type or browse for a sensor tag to connect it:

1. `_pn_setState` -> `pump1.status` (numeric state index 0-5)
2. `_pc_color2` -> (usually not bound to a tag; assign a fixed color)
3. `_pn_speed` -> `pump1.frequency` (pump speed)
4. `_pb_visible` -> `pump1.enabled` (true/false)

**Type compatibility:**

| Variable Type | Compatible Tag Data Types | Conversion |
|--------------|--------------------------|------------|
| number | FLOAT32, INT16, UINT16 | Direct |
| boolean | BOOL, DI/DO | Direct |
| string | Any | toString() |
| color | N/A | Usually fixed value, not bound to a tag |

### 7.5 FUXA Widget Examples

**Centrifugal Pump**
- Catalog ID: `pe-pump-centrifugal`
- Variables: 18, Tier: 1
- Features: 3D shaded body, impeller rotation animation, 6 states with different colors, speed-dependent rotation rate.
- Configuration:
  1. Select "Centrifugal Pump" from FUXA Browser.
  2. Bind `_pn_setState` -> `pump1.status`
  3. Bind `_pn_speed` -> `pump1.frequency`
  4. Configure state rules (see Section 2.2).

**Butterfly Valve**
- Catalog ID: `pe-valve-butterfly`
- Variables: 18, Tier: 1
- Features: Disc angle animation (0-90 degrees), open/closed position indicator, modulating control support.
- Configuration:
  1. Bind `_pn_setState` -> `valve1.position` (0=closed, 100=fully open)
  2. State rules: `= 0` -> State 0, `between 1,99` -> State 2, `= 100` -> State 2

**Motor Starter**
- Catalog ID: `el-inst-motor-starter`
- Variables: 18, Tier: 1
- Features: Overload indicator, start/stop status, 6-state animation.

**Vertical Tank**
- Catalog ID: `pe-tank-vertical`
- Variables: 18, Tier: 1
- Features: Level animation (0-100% fill), color change based on liquid type, overflow warning.
- Configuration:
  1. Bind `_pn_setState` -> (general status)
  2. Bind level variable -> `tank1.level` (0-100 percent)

**Shell and Tube / Plate Heat Exchanger**
- Catalog IDs: `pe-hx-shell-tube`, `pe-hx-plate`
- Variables: 18, Tier: 1
- Features: Hot/cold flow indicator, temperature-change color gradient.

> **Summary:** FUXA provides 1,450+ industrial SVG widgets with 6-state animation. Upload SVGs, bind variables to tags, configure state rules, and benefit from sandboxed security.

---

## 8. Edge Integration and Real-Time Data

### 8.1 WebSocket Connections

SCADA screens receive live data through WebSocket connections. Unlike traditional HTTP requests (which require the browser to ask for data each time), WebSockets maintain a persistent connection so the server can push data to the browser instantly.

**How it works:**

1. When you open a SCADA screen in Preview Mode, the browser establishes a WebSocket connection to the server.
2. The server pushes tag value updates as they arrive from edge devices (the hardware boxes at your facility).
3. The SCADA widgets update in real time.

### 8.2 Data Refresh Rates

Different types of data change at different speeds. The system optimizes by using different polling intervals:

| Widget Type | Recommended Interval | Reason |
|-------------|---------------------|--------|
| Alarm Banner | 500ms | Critical -- must be noticed immediately |
| Pump/Valve status | 1s | Operational -- needs quick response |
| Gauges (temperature, pH) | 2-3s | Measurement -- does not change instantly |
| Trend Chart | 5-10s | Visualization -- loads in segments |
| Energy meters | 30-60s | Totals -- changes slowly |
| Stock levels | 60s | Inventory -- changes rarely |

### 8.3 Handling Network Disconnections

If the network connection between the browser and server is lost:

- Widgets stop updating and may display stale (old) data.
- Some widgets show a "connection lost" indicator.
- When the connection is restored, widgets automatically resume with fresh data.

**Design tip:** Always include a visible timestamp or "last updated" indicator on critical screens so operators can tell if data is stale.

### 8.4 Offline Behavior

SCADA screens require a network connection to display live data. If the connection drops:

- The last known values remain on screen (they do not disappear).
- No control commands can be sent until the connection is restored.
- Alarms that occurred during the disconnection will appear when the connection resumes.

### 8.5 Data Quality Indicators

Each tag value has a quality attribute (Good, Uncertain, or Bad). Widgets should be configured to display data quality visually:

- **Good quality**: Normal display.
- **Uncertain quality**: Consider showing the value with a special indicator (like a question mark or dashed border).
- **Bad quality**: Display "---" or "No Data" instead of a potentially misleading value.

### 8.6 Edge Device Configuration for SCADA

Edge devices (the hardware at your facility that collects sensor data) must be properly configured for SCADA to work:

1. The edge device must be registered in the system and assigned an ID.
2. Sensors and I/O channels must be configured with tag names.
3. The MQTT connection between the edge device and the platform must be active.
4. I/O configuration records must have `isActive: true`.

**Equipment widget edge device binding:**

Each Equipment widget can be linked to a specific edge device:

| Property | Description | Default |
|----------|-------------|---------|
| `equipmentId` | Real equipment UUID | null (template mode) |
| `equipmentName` | Equipment name | - |
| `equipmentCode` | Equipment code | - |
| `edgeDeviceId` | Edge device connection | null |
| `ioBindings` | I/O tag connections | [] |
| `sensorMappings` | Sensor mappings | [] |
| `connectionPoints` | Connection handles (top/right/bottom/left) | top:input, right:output |

> **Summary:** Live data flows via WebSockets with tag-specific refresh intervals. Handle disconnections gracefully. Ensure edge devices are properly configured for SCADA operation.

---

## 9. Performance Optimization

### 9.1 Widget Count Recommendations

The number of widgets on a single screen directly affects performance (how smoothly the screen renders and how quickly widgets update).

| Widgets Per Screen | Performance | Recommendation |
|-------------------|-------------|----------------|
| 1-30 | Excellent | Ideal range |
| 31-50 | Good | Recommended maximum |
| 51-80 | Moderate | May see slow-downs; consider splitting |
| 80+ | Poor | Split the screen into multiple screens |

**How to split a large screen:**

1. Identify logical groups of widgets (for example, left half and right half, or "pumps" and "sensors").
2. Create a separate screen for each group.
3. On the main overview screen, add clickable summary areas and Screen Link buttons to navigate to each detail screen.

### 9.2 Data Refresh Interval Tuning

Not every widget needs to update every second. Reducing the refresh rate for non-critical widgets reduces network traffic and improves performance:

- **Critical** (alarms, safety): 500ms - 1s
- **Operational** (pump status, valve position): 1-2s
- **Monitoring** (temperature, pH): 2-5s
- **Informational** (energy totals, stock levels): 30-60s

**Hidden widget optimization:** The SCADA Builder automatically pauses data subscriptions for widgets that are off-screen (scrolled out of view or on a different screen tab). This prevents wasted network traffic.

### 9.3 Animation Performance

- **Minimize the number of simultaneously animated widgets.** Each animation uses browser CPU/GPU resources.
- **CSS animations** (used by the system) are hardware-accelerated and efficient. Avoid adding custom JavaScript animations that fight with the built-in CSS ones.
- **FUXA Tier 2 widgets** consume more resources than Tier 1. Replace unnecessary Tier 2 widgets with simpler Tier 1 alternatives.
- **Flow animations** use CSS `animation` properties and only run when `isFlowing = true`. They automatically stop for non-flowing pipes.

### 9.4 Large Screen Optimization

For screens displayed on large monitors (like a control room wall display):

- **Canvas size:** Set the canvas to match the display resolution (e.g., 1920x1080 for Full HD, 3840x2160 for 4K).
- **Font sizes:** Use larger fonts (14-18px minimum) for readability from a distance.
- **Widget sizes:** Scale widgets up. A gauge that works at 3x3 on a laptop may need to be 4x4 or larger on a wall display.

### 9.5 Memory Management

- **Close unused screens.** Each open screen tab consumes browser memory.
- **Limit trend chart history.** A 30-day trend chart with many tags uses significantly more memory than a 24-hour chart.
- **Browser choice:** Chrome is the recommended browser for SCADA Builder due to its strong memory management and hardware acceleration support.

### 9.6 Browser Compatibility

| Browser | Support Level | Notes |
|---------|--------------|-------|
| Chrome | Fully supported (recommended) | Best performance, hardware-accelerated CSS |
| Firefox | Supported | Good performance |
| Edge | Supported | Based on Chromium, similar to Chrome |
| Safari | Limited | Some animation differences |
| Mobile browsers | Limited | See Section 8 notes on mobile |

**Performance diagnosis:** Open Chrome DevTools (press F12), go to the Performance tab, and monitor the FPS (frames per second) counter. If FPS drops below 30, there is a performance problem -- reduce widget count or animation complexity.

> **Summary:** Keep under 50 widgets per screen. Tune refresh intervals. Minimize animations. Use Chrome. Split large screens into linked sub-screens.

---

## 10. Security and Access Control

### 10.1 Role-Based Screen Access

Different users can see different screens based on their role:

- **Operators** can view all monitoring screens and use control widgets.
- **Engineers** can view and edit all screens.
- **Administrators** can manage screen access permissions.
- **Viewers** can only view screens (no control).

Screen access is configured by your system administrator.

### 10.2 Control Action Permissions

Each control widget (Toggle Switch, Slider, Push Button, etc.) has a configurable security level:

| Security Level | Description |
|---------------|-------------|
| **None** | Action executes immediately. Use only for non-critical actions. |
| **Confirmation Required** | A dialog asks "Are you sure?" before executing. Recommended for most controls. |
| **PIN Required** | User must enter a PIN code. Use for critical operations (VFD programming, emergency controls). |

### 10.3 Audit Logging for SCADA Actions

All control actions taken through SCADA are logged for accountability:

- **Who** performed the action (user ID and name)
- **What** action was performed (start pump, change setpoint, acknowledge alarm)
- **When** it was performed (timestamp)
- **What value** was sent (new setpoint, command code)

This audit trail is stored in the database and can be reviewed by administrators.

### 10.4 VFD Programming Security (Maker-Checker)

VFD parameter changes use a Maker-Checker workflow:

1. **Maker** (operator or engineer): Creates a change set with new parameter values.
2. Change set enters `pending_approval` status.
3. **Checker** (a different authorized person): Reviews and approves (or rejects) the change set.
4. Only approved change sets are written to the VFD.
5. After writing, a read-back verification confirms the values were applied correctly.

This follows IEC 62443 SL-2 industrial security standards.

### 10.5 Screen-Level Security

Individual screens can have access restrictions:

- Public screens (visible to all logged-in users)
- Restricted screens (visible only to users with specific roles)
- Admin screens (visible only to administrators)

### 10.6 Widget-Level Security

Individual widgets can be hidden or disabled based on user role:

- A "Start Pump" button might be visible to operators and engineers but hidden from viewers.
- A "VFD Programming" widget might be visible only to engineers.

> **Summary:** Role-based access controls who sees and does what. Security levels on control widgets prevent unauthorized actions. Audit logs record everything. VFD changes use Maker-Checker approval.

---

## 11. 5 Complete SCADA Screen Blueprints

### Blueprint 1: RAS (Recirculating Aquaculture System) Overview

**Description:** A full-facility overview screen showing the water circulation path through all treatment stages, with live status for every piece of equipment.

**Canvas size:** 1920x1080 pixels (Full HD)

**Layout:**

```
+====================================================================+
|  [!] ALARM BANNER -- active alarms displayed here                   |
+====================================================================+
|                                                                     |
|  [FISH       ]                                                      |
|  [TANK 1     ] ---(O)>--- [PUMP 1] ---> [DRUM FILTER]              |
|  [Level: 85% ]                                |                     |
|       |                                       |                     |
|       |    [AERATOR] <------- [BIO FILTER (MBBR)]                   |
|       |       |                    |                                |
|       |       v                    |                                |
|       +--- [UV SYSTEM] <--- (O)>- [PUMP 2]                         |
|                                                                     |
|  +------------------+  +------------------+  +-----------------+    |
|  | Temperature      |  | Dissolved Oxygen |  | pH              |    |
|  |     22.5 C       |  |     7.8 mg/L     |  |     7.2         |    |
|  | [====>    ] 0-40  |  | [======>  ] 0-15 |  | [=====>  ] 4-10 |   |
|  +------------------+  +------------------+  +-----------------+    |
|                                                                     |
|  +--------------------------------------------------------------+   |
|  | TREND CHART -- Last 24 hours                                  |   |
|  |  Temperature (blue), DO (green), pH (orange)                  |   |
|  +--------------------------------------------------------------+   |
+====================================================================+
```

**Build steps:**

1. **Alarm Banner:** Place full-width at the top (12x2). Bind to `system.activeAlarms`.

2. **Fish Tank:** Tank Level widget at position (50, 80), size 120x160px. Bind to `tank1.level`. Label: "Fish Tank 1".

3. **Equipment widgets (6 items):**
   - Pump 1: Equipment (centrifugal-pump) at (250, 120). Bind to `pump1.status`.
   - Drum Filter: Equipment (drum-filter) at (500, 120).
   - Bio Filter: Equipment (bio-reactor) at (500, 280).
   - Aerator: Equipment (blower) at (250, 280).
   - UV System: Equipment (uv-unit) at (250, 400).
   - Pump 2: Equipment (centrifugal-pump) at (500, 400).

4. **Pipe connections (7 edges):**
   - Tank 1 output -> Pump 1 input: `process-pipe`
   - Pump 1 output -> Drum Filter input: `process-pipe`
   - Drum Filter output -> Bio Filter input: `process-pipe`
   - Bio Filter output -> Aerator input: `pneumatic`
   - Bio Filter output-2 -> Pump 2 input: `process-pipe`
   - Pump 2 output -> UV System input: `process-pipe`
   - UV System output -> Tank 1 input: `process-pipe`

5. **Flow animation on each pipe:**
   - Pump 1 outlet pipes: tagName=`pump1.running`, flowCondition=`boolean`
   - Pump 2 outlet pipes: tagName=`pump2.running`, flowCondition=`boolean`
   - Aerator line: tagName=`aerator.running`, flowCondition=`boolean`
   - Speed: 2s (normal flow), 1s (high flow)

6. **Gauges (3 items) along the bottom:**
   - Temperature: tag=`sensor.temperature`, min=0, max=40, unit=C
   - Dissolved Oxygen: tag=`sensor.dissolvedOxygen`, min=0, max=15, unit=mg/L
   - pH: tag=`sensor.pH`, min=4, max=10

7. **Trend Chart:** Full-width at the bottom. Tags: temperature, DO, pH. Range: 24 hours. Legend: on. Grid: on.

8. **Alarm thresholds:**
   - Temperature: warning > 28 C, alarm > 32 C, low warning < 18 C
   - DO: warning < 5 mg/L, alarm < 3 mg/L
   - pH: warning < 6.5 or > 8.5, alarm < 6.0 or > 9.0

---

### Blueprint 2: Pump Station Control

**Description:** A detailed control screen for a single pump with VFD drive, showing all operational parameters, control buttons, and fault history.

**Layout:**

```
+====================================================================+
|  PUMP STATION -- Pump #1 (Danfoss FC302)                            |
+====================================================================+
|                                                                     |
|  +---VFD GAUGES-----------------+  +--LIVE VALUES---------------+  |
|  |  Frequency    Current        |  |  Frequency:   42.5 Hz      |  |
|  |  [=====>  ]   [===>   ]      |  |  Current:     12.3 A       |  |
|  |   42.5 Hz      12.3 A       |  |  Torque:      85.2 %       |  |
|  |                               |  |  Power:       4.2 kW       |  |
|  |  Torque       Power          |  |  RPM:         1425 RPM     |  |
|  |  [======> ]   [====>  ]      |  |  Temperature: 45.3 C       |  |
|  |   85.2 %       4.2 kW       |  |  DC Bus:      562 V        |  |
|  +-------------------------------+  +---------------------------+  |
|                                                                     |
|  +---CONTROLS-------------------+  +--COUNTERS------------------+  |
|  |  [START]  [STOP]  [RESET]    |  |  Running Hours: 12,456 h   |  |
|  |                               |  |  Energy Used:   45,230 kWh |  |
|  |  Frequency Setting:          |  |  Start Count:   1,234      |  |
|  |  0 |====[|||]=====>| 50 Hz   |  |                            |  |
|  |  Speed Mode: [Fixed Speed v] |  |                            |  |
|  +-------------------------------+  +----------------------------+  |
|                                                                     |
|  +---VFD PROGRAMMER-----------------------------------------+      |
|  |  Parameter Groups: Ramp | Freq | Motor | PID | Protection |      |
|  |  Accel T1:  10.00s  ->  [5.0 ]   Risk: MEDIUM            |      |
|  |  [2 changes pending] [Submit for Approval] [Save Draft]   |      |
|  +-----------------------------------------------------------+      |
|                                                                     |
|  +---FAULT HISTORY----------------------------------------------+  |
|  |  Date       | Code | Description     | Duration | Status     |  |
|  |  2026-03-25 | F03  | Overcurrent     | 2.3s     | Resolved   |  |
|  |  2026-03-20 | F05  | Overtemperature  | 5.1s     | Resolved   |  |
|  +---------------------------------------------------------------+  |
+====================================================================+
```

**Key widgets:**
- 4 Gauges: Frequency (0-50Hz), Current (0-25A), Torque (0-100%), Power (0-11kW)
- 7 Numeric Displays: All live VFD parameters
- 3 Push Buttons: START, STOP, RESET (with Confirmation Required)
- 1 Slider: Frequency setpoint (0-50 Hz, step 0.5)
- 1 Dropdown: Speed mode (Fixed / PID / Multi-Step)
- 1 VFD Programmer widget: Parameter viewing and change set creation
- 1 Data Table: Fault history

---

### Blueprint 3: Water Quality Monitoring

**Description:** A comprehensive water quality screen showing five parameters with gauges, a 7-day trend chart, alarm threshold references, and dosing controls.

**Layout:**

```
+====================================================================+
|  WATER QUALITY MONITORING -- Tank Group A                           |
+====================================================================+
|                                                                     |
|  [pH]    [DO]    [Temp]   [Salinity]   [Turbidity]                  |
|  7.2     7.8     22.5 C   18.3 ppt     2.1 NTU                     |
|  [OK]    [OK]    [OK]     [OK]         [WARN]                       |
|                                                                     |
|  +---7-DAY TREND CHART-----------------------------------------+   |
|  |  pH (green), DO (blue), Temperature (red)                    |   |
|  +--------------------------------------------------------------+   |
|                                                                     |
|  +---ALARM THRESHOLDS----+  +--DOSING CONTROLS-----------------+   |
|  |  pH:   6.5-8.5 (warn) |  |  Lime Dosing:                    |   |
|  |  DO:   > 5.0  (warn)  |  |  [AUTOMATIC v]  pH > 8.0         |   |
|  |  Temp: 18-28  (warn)  |  |  Dose: 2.5 mL/L                  |   |
|  |  Turb: < 5.0  (warn)  |  |                                   |   |
|  +------------------------+  |  Chlorine Dosing:                 |   |
|                               |  [MANUAL v]  Status: STOPPED     |   |
|                               +----------------------------------+   |
+====================================================================+
```

**Key widgets:**
- 5 Gauges with color zones for each water quality parameter
- 1 Trend Chart (7-day, 3-5 parameters)
- Static Text for alarm threshold reference
- Toggle Switches and Numeric Inputs for dosing control
- Status Indicators for dosing system status

---

### Blueprint 4: Feeding System Management

**Description:** A feeding system screen with three feed silos, a conveyor line, destination tanks, feeding schedule, and daily statistics.

**Layout:**

```
+====================================================================+
|  FEEDING SYSTEM -- Automatic Feed Distribution                      |
+====================================================================+
|                                                                     |
|  [SILO 1]     [SILO 2]     [SILO 3]                                |
|   85%          62%          35%                                     |
|   2mm Pellet   3mm Pellet   5mm Pellet                              |
|     |            |            |                                     |
|     v            v            v                                     |
|  [=== DISTRIBUTION LINE (conveyor) ====>====>]                      |
|     |        |        |        |                                    |
|  [Tank A1] [Tank A2] [Tank B1] [Tank B2]                           |
|                                                                     |
|  +---FEEDING SCHEDULE------------------------------+                |
|  | Time  | Tank | Amount | Silo | Status           |                |
|  | 06:00 | A1   | 2.5 kg | S1   | Completed        |                |
|  | 12:00 | A1   | 2.5 kg | S2   | Waiting          |                |
|  +--------------------------------------------------+               |
|                                                                     |
|  [Today: 12.5 kg] [Weekly: 87.3 kg] [Stock: 450 kg]                |
+====================================================================+
```

**Key widgets:**
- 3 Tank Level widgets (silos)
- svgArrow widgets for flow indicators
- Equipment widgets for destination tanks
- Data Table for feeding schedule
- Numeric Displays for statistics

---

### Blueprint 5: Energy and VFD Dashboard

**Description:** An energy monitoring screen showing per-equipment consumption, totals, power factor, cost calculations, and hourly usage trends.

**Layout:**

```
+====================================================================+
|  ENERGY MONITORING -- Facility Overview                             |
+====================================================================+
|                                                                     |
|  +---VFD ENERGY CONSUMPTION (bar chart)--------------------------+ |
|  |  kWh per equipment: P1, P2, P3, Aerator, UV, Filter, Dosing  | |
|  +---------------------------------------------------------------+ |
|                                                                     |
|  [Total kWh]          [Power Factor]       [Cost]                   |
|  Today:   245 kWh     PF: 0.92             Today:  245 TL          |
|  Week:  1,680 kWh     Target: 0.95         Month: 7,450 TL         |
|  Month: 7,450 kWh                          Per kWh: 1.00 TL        |
|                                                                     |
|  +---HOURLY CONSUMPTION TREND (24h)------------------------------+ |
|  |  Power (kW) over time                                         | |
|  +---------------------------------------------------------------+ |
+====================================================================+
```

**Key widgets:**
- 1 Bar Chart (energy per equipment)
- 3 Numeric Display panels (totals, power factor, cost)
- 1 Gauge (power factor with target indicator)
- 1 Trend Chart (hourly consumption, 24 hours)

> **Summary:** These five blueprints cover the most common SCADA screen configurations for aquaculture: RAS overview, pump station, water quality, feeding, and energy. Use them as starting points and customize for your specific facility.

---

## 12. Troubleshooting Advanced Issues

### 12.1 Performance Problems

**Symptom:** Screens are slow, animations stutter, or widgets take a long time to update.

**Diagnostic steps:**

1. Open Chrome DevTools (press F12).
2. Go to the **Performance** tab.
3. Click "Record" and interact with the SCADA screen for 10-15 seconds.
4. Stop recording and analyze:
   - **FPS (Frames Per Second):** Should be 30+ for smooth operation. Below 30 indicates a problem.
   - **CPU usage:** High CPU means too many animations or widgets.
   - **Memory usage:** Constantly increasing memory suggests a memory leak.

**Solutions:**

| Problem | Solution |
|---------|----------|
| Too many widgets | Split the screen (see Section 9.1) |
| Too many animations | Reduce animated widgets; use simpler alternatives |
| FUXA Tier 2 widgets | Replace with Tier 1 when possible |
| Long trend chart ranges | Reduce default time range (use 24h instead of 30 days) |
| Many open tabs | Close unused screen tabs |

### 12.2 WebSocket Disconnections

**Symptom:** Widgets stop updating, display stale data, or show "connection lost" indicators.

**Diagnostic steps:**

1. Check your network connection (try loading another web page).
2. Open browser DevTools > Console tab. Look for WebSocket error messages.
3. Check the server status with your administrator.

**Solutions:**

| Cause | Solution |
|-------|----------|
| Network outage | Wait for network restoration; widgets auto-reconnect |
| Server overload | Contact administrator to check server resources |
| Browser timeout | Refresh the page (F5 or Ctrl+R) |
| Firewall blocking WebSocket | Contact IT to allow WebSocket connections |

### 12.3 Tag Binding Errors

**Symptom:** Widget shows "No Data," wrong values, or does not respond to tag changes.

**Detailed checklist:**

1. **Tag name exact match:** Tag names are case-sensitive. `pump1.frequency` is not the same as `Pump1.Frequency`.
2. **Edge device linked:** The Equipment widget must be linked to an edge device.
3. **I/O config active:** The backend DeviceIoConfig record must have `isActive: true`.
4. **Data type match:** Binding a number tag to a string variable (or vice versa) produces unexpected results.
5. **MQTT connected:** The edge device must have an active MQTT connection to the broker.
6. **SCADA Runtime context:** Widgets must be rendered within the ScadaRuntime context (only in Preview or Simulation mode, not raw Edit mode).

### 12.4 SVG Rendering Issues

**Symptom:** Custom SVG or FUXA widget appears blank, distorted, or partially rendered.

**Checklist:**

1. **Valid SVG:** File must start with `<svg>` or `<?xml>` header.
2. **ViewBox defined:** The `<svg>` element should have a `viewBox` attribute.
3. **File size:** Must be under 1 MB.
4. **Script integrity (FUXA):** Export markers (`//!export-start` / `//!export-end`) must be present.
5. **Browser console:** Check F12 > Console for JavaScript errors inside the iframe.
6. **Z-index:** The widget may be behind another widget. Right-click > "Bring to Front."

### 12.5 Cross-Browser Compatibility

**Known differences:**

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| CSS animations | Full support | Full support | Minor timing differences | Full support |
| SVG rendering | Full support | Full support | Some filter issues | Full support |
| WebSocket | Full support | Full support | Reconnection delays | Full support |
| Canvas performance | Excellent | Good | Moderate | Excellent |

**Recommendation:** Always test in Chrome first. If deploying to control rooms, standardize on Chrome for all operator stations.

### 12.6 Mobile and Tablet Optimization

**Design guidelines for mobile SCADA screens:**

1. **Design separate mobile screens** optimized for smaller viewports (375x812px for phone, 768x1024px for tablet).
2. **Use large touch targets:** Minimum 44x44px for any clickable element.
3. **Keep gauges large:** Minimum 120x120px for readability.
4. **Make trend charts scrollable horizontally.**
5. **Use Security Level "Confirmation Required"** on all control widgets to prevent accidental touches.

**Touch gestures:**

| Gesture | Action |
|---------|--------|
| Single tap | Select widget / click button |
| Long press | Open context menu (details, alarm history) |
| Pinch zoom | Zoom in/out on the screen |
| Two-finger drag | Pan (scroll) the screen |

**Mobile-specific behaviors:**
- Slider widgets render wider for easier touch control.
- Trend charts become horizontally scrollable.
- Alarm Banner remains fixed at the top (sticky header).
- VFD Programmer widget opens in full-screen mode.

> **Summary:** Use Chrome DevTools for performance diagnosis. Check WebSocket status for data flow issues. Verify tag bindings carefully. Design separate screens for mobile. Test across browsers.

---

## 13. Complete Widget Reference Table

This table lists every widget type in the SCADA Builder with its key information.

### Display Widgets

| Widget | Category | Description | Default Size | Tag Binding | Animations |
|--------|----------|-------------|-------------|-------------|------------|
| **Gauge** | Monitoring | Semicircular dial showing analog values with colored zones | 3x3 | Single tag (read) | Color zones |
| **Numeric Display** | Monitoring | Large number display with label and unit | 2x2 | Single tag (read) | None (static) |
| **Status Indicator** | Monitoring | Colored circle/rectangle showing on/off or multi-state status | 2x2 | Single tag (read) | Color ranges (up to 8) |
| **Tank Level** | Monitoring | Visual tank with animated liquid level and wave effect | 2x4 | Single tag (read) | Fill animation, wave |
| **Trend Chart** | Monitoring | Time-series line graph for one or more tags | 6x4 | Multiple tags (read) | None (live data updates) |
| **Progress Bar** | Monitoring | Horizontal fill bar with color zones | 3x1 | Single tag (read) | Fill, color zones |
| **Bar Chart** | Monitoring | Vertical bar chart for statistical data | 4x3 | Multiple tags (read) | None |
| **Pie Chart** | Monitoring | Circle divided into proportional slices | 3x3 | Multiple tags (read) | None |
| **Data Table** | Monitoring | Tabular data with sorting and filtering | 6x4 | Multiple tags (read) | None |

### Control Widgets

| Widget | Category | Description | Default Size | Tag Binding | Security |
|--------|----------|-------------|-------------|-------------|----------|
| **Toggle Switch** | Control | On/off sliding switch | 2x2 | Single tag (write) | None / Confirm / PIN |
| **Slider** | Control | Draggable handle for continuous value | 3x2 | Single tag (write) | None / Confirm / PIN |
| **Numeric Input** | Control | Type-in number box with up/down buttons | 2x2 | Single tag (write) | None / Confirm / PIN |
| **Push Button** | Control | Single-action or toggle button | 2x2 | Single tag (write) | None / Confirm / PIN |
| **Emergency Stop** | Control | Large red emergency stop (hold 2s) | 2x4 | Multiple tags (write) | No confirmation (safety) |
| **Dropdown Select** | Control | Pick from predefined options | 2x2 | Single tag (write) | None / Confirm |
| **Knob** | Control | Rotary dial control | 2x2 | Single tag (write) | None / Confirm / PIN |

### Equipment Widgets

| Widget | Category | Description | Default Size | Tag Binding | Status Colors |
|--------|----------|-------------|-------------|-------------|---------------|
| **Equipment** (Pumps) | Process | Centrifugal, Gear, Diaphragm, Piston, Submersible, Vacuum pumps | 2x2 | Status tag | Green=Running, Gray=Stopped, Red=Fault |
| **Equipment** (Valves) | Process | Gate, Ball, Butterfly, Globe, Check, Relief, Control, Needle, Solenoid valves | 2x2 | Status tag | Green=Open, Gray=Closed, Red=Fault |
| **Equipment** (Tanks) | Process | Vertical, Horizontal, Conical, Pressure, Silo, Mixing tanks | 2x3 | Level tag | Level-dependent fill |
| **Equipment** (Heat Ex.) | Process | Shell-Tube, Plate, Air Cooler, Condenser, Evaporator | 2x2 | Status tag | Standard colors |
| **Feeder** | Aquaculture | Fish feed distribution machine | 2x3 | Status tag | Standard colors |
| **Clean Water Tank** | Aquaculture | Treated water storage | 2x3 | Level tag | Level fill |
| **Dirty Water Tank** | Aquaculture | Untreated wastewater | 2x3 | Level tag | Level fill |
| **MBBR** | Aquaculture | Biological filtration reactor | 3x2 | Status tag | Standard colors |
| **HEPA Filter** | Aquaculture | Air filtration | 3x2 | Status tag | Standard colors |
| **Radial Filter** | Aquaculture | Mechanical solid separation | 2x3 | Status tag | Standard colors |
| **Cornell Dual Drain** | Aquaculture | Dual drain waste removal | 4x3 | Status tag | Standard colors |
| **Process View** | Aquaculture | Full process flow diagram | 12x6 | Multiple tags | Composite |

### Alarm Widgets

| Widget | Category | Description | Default Size | Tag Binding |
|--------|----------|-------------|-------------|-------------|
| **Alarm Banner** | Alarm | Horizontal scrolling alarm strip | 12x2 | System alarm tag |
| **Alarm List** | Alarm | Detailed alarm history table | 6x4 | System alarm tag |

### Calibration Widgets

| Widget | Category | Description | Default Size |
|--------|----------|-------------|-------------|
| **Calibration Wizard** | Calibration | Step-by-step sensor calibration guide | 6x4 |
| **Calibration History** | Calibration | Past calibration records table | 6x4 |
| **Calibration Status** | Calibration | Sensor calibration summary | 3x3 |

### Navigation and Information Widgets

| Widget | Category | Description | Default Size | Interactive |
|--------|----------|-------------|-------------|-------------|
| **Screen Link** | Navigation | Button/card linking to another screen | 2x2 | Click to navigate |
| **Static Text** | Information | Fixed text label | 3x1 | None |
| **Scheduler** | Information | Schedule calendar display | 4x3 | View schedules |
| **Video Stream** | Information | Live IP camera feed | 3x2 | View video |
| **Map View** | Information | Facility location on map | 3x3 | Pan/zoom |
| **IFrame** | Information | Embedded external web page | 4x3 | Interact with page |

### Shape Widgets

| Widget | Description | Default Size | Tag-Bindable |
|--------|-------------|-------------|-------------|
| **svgRect** | Rectangle | 2x2 | Fill color |
| **svgCircle** | Circle | 2x2 | Fill color |
| **svgEllipse** | Ellipse | 2x2 | Fill color |
| **svgLine** | Straight line | 3x1 | Stroke color |
| **svgPolygon** | Multi-sided shape | 2x2 | Fill color |
| **svgTriangle** | Triangle | 2x2 | Fill color |
| **svgDiamond** | Diamond shape | 2x2 | Fill color |
| **svgArrow** | Arrow | 3x2 | Fill color |
| **svgPath** | Freeform path | 4x3 | Fill/stroke |
| **svgText** | SVG text element | 2x1 | Text color |
| **Custom SVG** | User-uploaded SVG | 2x2 (free resize) | Depends on SVG |
| **Raster Image** | PNG/JPG image | 3x3 | None |

### Advanced Widgets

| Widget | Category | Description | Default Size | Special Features |
|--------|----------|-------------|-------------|-----------------|
| **FUXA Widget** | Advanced SVG | Animated industrial SVG with 6-state machine | 2x2 (up to 12x8) | Per-variable tag binding, state rules, iframe sandbox |
| **VFD Programmer** | Advanced | VFD parameter viewing and Maker-Checker change management | 300x200 (compact) / 600x400 (full) | Change set workflow, risk assessment, audit trail |

### Edge (Connection) Types

| Connection Type | Color | Thickness | Style | Use For |
|----------------|-------|-----------|-------|---------|
| `process-pipe` | #1f2937 | 3px | Solid | Main water/air lines |
| `electrical` | #dc2626 | 2px | Dashed | Electrical signals |
| `pneumatic` | #2563eb | 2px | Double-dash | Air/gas signals |
| `hydraulic` | #16a34a | 2px | Long-short dash | Hydraulic fluid |
| `instrument` | #ea580c | 2px | Dash-dot | Sensors, controls |
| `data-link` | #7c3aed | 2px | Dotted | Digital data |
| `capillary` | #6b7280 | 1px | Solid thin | Capillary connections |
| `steam` | #f97316 | 3px | Short dash | Steam lines |
| `drain-vent` | #0891b2 | 2px | Dash-dot-dot | Drainage, vents |

---

## Quick Reference Appendices

### Appendix A: Connection Type and Edge Type Quick Reference

| Scenario | Edge Type | Connection Type | Flow Condition |
|----------|-----------|----------------|----------------|
| Main water pipe | Orthogonal | `process-pipe` | `boolean` (pump tag) |
| Chemical dosing | Orthogonal | `capillary` | `boolean` (dosing pump) |
| Air line | Orthogonal | `pneumatic` | `boolean` (blower tag) |
| Sensor cable | Orthogonal | `instrument` | None (static) |
| VFD power cable | Orthogonal | `electrical` | None (static) |
| SCADA communication | Draggable | `data-link` | None (static) |
| Drainage | Orthogonal | `drain-vent` | `nonZero` (flow tag) |

### Appendix B: FUXA Variable Prefix Quick Reference

| Prefix | Type | TypeScript Type | Config Panel Control |
|--------|------|----------------|---------------------|
| `_pn_` | number | `number` | Number input box |
| `_ps_` | string | `string` | Text input box |
| `_pb_` | boolean | `boolean` | Checkbox (True/False) |
| `_pc_` | color | `string` (HEX) | Color picker + text |

### Appendix C: State Index Quick Reference

| State | Meaning | Default Color | Typical Trigger |
|-------|---------|---------------|-----------------|
| 0 | Off / Stopped | Gray (#808080) | `status = 0` |
| 1 | Starting / Opening | Yellow (#FFD700) | `status = 1` |
| 2 | Running / Normal | Green (#00FF00) | `status = 2` |
| 3 | Warning | Orange (#FFA500) | Threshold exceeded (warning) |
| 4 | Alarm / Fault | Red (#FF0000) | Threshold exceeded (alarm) |
| 5 | Maintenance / Disabled | Blue (#0000FF) | Manual setting |

---

**This guide was written for the RuFlo Aquaculture Platform v3 SCADA Builder system.**

**For questions, contact your platform administrator or system integrator.**
