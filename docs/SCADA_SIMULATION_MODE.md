# SCADA Builder — Simulation Mode

> Technical reference for the offline simulation system integrated into the SCADA Package Builder.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Mode Switching](#mode-switching)
4. [Data Flow](#data-flow)
5. [Tag Value Injection](#tag-value-injection)
6. [Widget Interaction](#widget-interaction)
7. [Alarm Evaluation Engine](#alarm-evaluation-engine)
8. [Automation Closed-Loop](#automation-closed-loop)
9. [Scenario System](#scenario-system)
10. [File Reference](#file-reference)

---

## Overview

The Simulation Mode allows operators and engineers to test SCADA screens without a physical edge device. It provides:

- **Tag value injection** — manually set any tag via sliders, toggles, or text inputs
- **Alarm rule testing** — real-time evaluation with deadband hysteresis and on-delay
- **ST automation execution** — run IEC 61131-3 Structured Text programs in a closed feedback loop
- **Preset scenarios** — one-click test patterns (normal operation, pump fault, tank overflow, emergency stop)

The key design principle is **zero widget modification**: the simulation layer injects a fake data provider into the same React Context that the live data provider uses. Widget renderers call `getTagValue(deviceCode, tagName)` and receive simulated values transparently.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ScadaPackageBuilderPage                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Toolbar:  [Edit]  [Preview]  [Simulation]               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  mode = 'simulation'                                            │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐ │
│  │                         │  │     SimulationSidebar         │ │
│  │   SimulationDataProvider│  │  ┌────────────────────────┐  │ │
│  │   ┌───────────────────┐ │  │  │ A. Tag Values Table    │  │ │
│  │   │   ScreenCanvas    │ │  │  │    slider / toggle /   │  │ │
│  │   │   (isPreview=true)│ │  │  │    number input        │  │ │
│  │   │   deviceCode=     │ │  │  ├────────────────────────┤  │ │
│  │   │   "__sim__"       │ │  │  │ B. Scenarios           │  │ │
│  │   │                   │ │  │  │    built-in + custom    │  │ │
│  │   │  ┌─────┐ ┌─────┐ │ │  │  ├────────────────────────┤  │ │
│  │   │  │Pump │ │Tank │ │ │  │  │ C. Active Alarms       │  │ │
│  │   │  │ 75  │ │ 82% │ │ │  │  │    severity + message   │  │ │
│  │   │  └─────┘ └─────┘ │ │  │  ├────────────────────────┤  │ │
│  │   └───────────────────┘ │  │  │ D. Automation Programs │  │ │
│  │                         │  │  │    ST closed-loop       │  │ │
│  └─────────────────────────┘  │  └────────────────────────┘  │ │
│                               └──────────────────────────────┘ │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Status Bar:  ⚡ Simülasyon Aktif  │  3 ekran  12 widget │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Mode Switching

The builder page supports three mutually exclusive modes:

| Mode | Left Panel | Center | Right Panel | Data Source |
|------|-----------|--------|-------------|-------------|
| **Edit** | SceneTree + WidgetPalette | ScreenCanvas (editable) | PropertiesPanel | None (demo values) |
| **Preview** | Hidden | ScreenCanvas (read-only) | Hidden | `ScadaDataProvider` (live device) |
| **Simulation** | Hidden | ScreenCanvas (read-only) | SimulationSidebar | `SimulationDataProvider` (store) |

**State transitions:**

```
setMode('edit')       → setSimulationMode(false)  → store clears simTagValues + simAlarms
setMode('preview')    → setSimulationMode(false)  → store clears simTagValues + simAlarms
setMode('simulation') → setSimulationMode(true)   → simulation state is active
```

When exiting simulation mode, the store's `setSimulationMode(false)` automatically clears all `simTagValues` and `simAlarms` to prevent stale data from leaking into other modes.

---

## Data Flow

### How widgets receive simulated values

The simulation system reuses the existing `ScadaDataContext` (the same React Context that `ScadaDataProvider` uses for live device data). This means **no widget code changes are needed**.

```
SimulationSidebar                   Zustand Store                SimulationDataProvider
  setSimTagValue(                     simulationSlice              (ScadaDataContext.Provider)
    "pump1_speed", 75                   simTagValues: {
  ) ──────────────────►                   pump1_speed: 75  ──────►  getTagValue("__sim__",
                                          tank1_level: 82              "pump1_speed") → 75
                                        }                                    │
                                                                             ▼
                                                                    WidgetRenderer
                                                                    value={75}
```

**SimulationDataProvider** implements `ScadaDataContextValue`:

```typescript
{
  values: { __sim__: simTagValues },
  alarms: {},
  isConnected: true,
  connectionStatus: 'connected',
  getTagValue: (_deviceCode, tagName) => simTagValues[tagName],
  subscribeTag: () => {},       // no-op in simulation
  unsubscribeTag: () => {},     // no-op in simulation
}
```

The canvas receives `deviceCode="__sim__"` and `isPreview={true}`, so widget nodes call `scadaData.getTagValue("__sim__", tagName)` which reads from the store.

---

## Tag Value Injection

The SimulationSidebar scans all widgets across all screens and collects unique `config.tagName` values. Each tag is displayed with a type-appropriate control:

| Widget Type | Data Hint | Control |
|------------|-----------|---------|
| `toggleSwitch`, `pushButton`, `indicator`, `statusLight` | boolean | Toggle switch |
| `gauge`, `progressBar`, `numericDisplay`, `equipment` | number | Range slider + number input |
| `textDisplay`, `label` | string | Text input |

Min/max values are derived from widget config when available (e.g., gauge min/max).

**Change highlighting:** When a tag value changes, its row gets a 500ms yellow highlight (matching the pattern from the ST code `SimulationPanel`).

---

## Widget Interaction

In simulation mode, widget command handlers respond to user clicks:

```typescript
// ScadaWidgetNode.tsx — handleCommand()
if (store.simulationMode && tagName) {
  if (command === 'toggle')   store.setSimTagValue(tagName, !currentValue);
  if (command === 'press')    store.setSimTagValue(tagName, true);  // auto-reset after 200ms
  if (command === 'writeTag') store.setSimTagValue(tagName, value);
}
```

- **toggle** — Inverts the boolean value (for switch widgets)
- **press** — Sets `true`, then automatically resets to `false` after 200ms (momentary push-button behavior)
- **writeTag** — Sets an arbitrary value (for input widgets)

The press timer is tracked via a ref and cleaned up on unmount to prevent stale writes after mode transitions.

**Safety guard:** The store's `setSimTagValue` action no-ops when `simulationMode === false`, preventing zombie writes from orphaned timers or intervals.

---

## Alarm Evaluation Engine

### Hook: `useAlarmEvaluation(rules, getTagValue) → FiredAlarm[]`

Evaluates alarm rules against current tag values on every change. Supports the following condition operators:

| Operator | Description | Deadband Behavior |
|----------|-------------|-------------------|
| `gt` | Greater than | Clears when value drops below `threshold - deadband` |
| `lt` | Less than | Clears when value rises above `threshold + deadband` |
| `gte` | Greater or equal | Same as `gt` |
| `lte` | Less or equal | Same as `lt` |
| `eq` | Equal (±0.001 tolerance) | Tolerance band widens by deadband |
| `ne` | Not equal (±0.001 tolerance) | Inverse of `eq` |

### Deadband Hysteresis

Prevents alarm chatter when a process value oscillates around the threshold:

```
Threshold = 80, Deadband = 5

Value:  72  76  81  79  78  76  74  82
        ─── ─── ─── ─── ─── ─── ─── ───
Alarm:  OFF OFF ON  ON  ON  ON  OFF ON
                 ▲               ▲
                 │               │
            fires at 80    clears at 75 (80-5)
```

### On-Delay (Time Confirmation)

When `delay > 0` seconds is configured on a rule, the alarm does not fire immediately. Instead:

1. Condition triggers → start a timer
2. Timer fires after `delay` seconds → confirm the alarm
3. If the condition clears before the timer fires → cancel the timer

The delay timer uses a ref-based pattern (`evaluateRef.current`) to always call the latest evaluation function, avoiding stale closure issues.

### Orphan Cleanup

When alarm rules are added or removed, the hook automatically cleans up stale per-rule state (timers, hysteresis flags) via a `useEffect` that prunes entries not present in the current rule set.

### Integration Points

- **SimulationSidebar** — displays fired alarms with severity badges and current values
- **GlobalAlarmBanner** — shows severity counts and pulses red when critical alarms are active (displays "Alarmlar (SİM)" label in simulation mode)
- **Store** — `simAlarms` array is synced from the hook for cross-component access

---

## Automation Closed-Loop

This is the most complex subsystem. It runs IEC 61131-3 Structured Text programs inside the browser and feeds their outputs back into the simulation tag values.

### Prerequisites

1. An automation program must be imported into the SCADA package (via the Automation Binding Panel)
2. Program variables must be bound to widget tags:

```typescript
AutomationBinding {
  programId: "prog-123",
  programName: "DosingPump_Control",
  programCode: "PROGRAM DosingPump\n  VAR_INPUT\n    tank_level: REAL;\n  END_VAR\n  ...",
  variableBindings: [
    { varName: "tank_level",  scope: "INPUT",  boundTag: "tank1_level" },
    { varName: "pump_speed",  scope: "OUTPUT", boundTag: "pump1_speed" },
    { varName: "flow_rate",   scope: "INOUT",  boundTag: "flow1_rate"  },
  ]
}
```

### Execution Flow

When the user clicks "Çalıştır" (Run) on a program:

```
handleStartProgram(programId)
│
├─ 1. Stop any previously running program (prevent orphaned intervals)
├─ 2. simulation.load(programCode)
│      → parseST()  — tokenize + recursive descent parse → AST
│      → new StInterpreter(ast[0])  — create interpreter instance
├─ 3. Verify load succeeded via getVariableSnapshot()
├─ 4. Start setInterval(callback, scanInterval)
│
└─ Each interval tick (e.g., every 100ms):
   │
   ├─ Guard: check store.simulationMode === true
   │
   ├─ STEP 1: Feed INPUT + INOUT variables
   │   for each binding where scope ∈ {INPUT, INOUT}:
   │     value = store.simTagValues[boundTag]
   │     simulation.setInputDirect(varName, value)
   │     (writes directly to interpreter, no React state update)
   │
   ├─ STEP 2: Execute one PLC scan cycle
   │   simulation.runOneCycleDirect()
   │     → interpreter.runCycle()
   │     → all ST statements execute once
   │     (no refreshVariables — avoids React overhead)
   │
   └─ STEP 3: Read OUTPUT + INOUT variables
       snapshot = simulation.getVariableSnapshot()
       (reads synchronously from interpreter — no stale closure)
       for each binding where scope ∈ {OUTPUT, INOUT}:
         store.setSimTagValue(boundTag, snapshot[varName].value)
         → widget updates via SimulationDataProvider
```

### Why "Direct" Methods?

The `useSimulation` hook provides two API surfaces:

| Method | Purpose | React State Updates | Use Case |
|--------|---------|-------------------|----------|
| `setInput(name, value)` | Set one input variable | Yes (refreshVariables) | Interactive UI (SimulationPanel) |
| `runOneCycle()` | Execute one cycle | Yes (setState, setCycleCount) | Single-step debugging |
| `setInputDirect(name, value)` | Set input without re-render | No | Closed-loop interval |
| `runOneCycleDirect()` | Execute cycle without re-render | No (only cycleCount) | Closed-loop interval |
| `getVariableSnapshot()` | Read variables synchronously | No | Closed-loop interval |

The "Direct" methods were added to solve two critical issues discovered during code review:

1. **Stale closure problem:** `simulation.variables` captured in the `setInterval` closure would always be one cycle behind. `getVariableSnapshot()` reads directly from the interpreter ref.

2. **Excessive re-renders:** With 5 input bindings at 50ms interval, the standard `setInput()` would trigger ~120 React state updates per second. The Direct API writes to the interpreter without touching React state.

### Scan Interval

Configurable via a dropdown in the Automation section: 50ms, 100ms, 250ms, 500ms, 1000ms.

Changing the interval while a program is running automatically restarts the interval timer via a `useEffect` dependency.

### INOUT Variable Support

Variables with `scope: 'INOUT'` are handled as both inputs and outputs:
- Fed from `simTagValues` before each cycle (like INPUT)
- Written back to `simTagValues` after each cycle (like OUTPUT)

This matches IEC 61131-3 semantics where `VAR_IN_OUT` variables can be both read and written by the caller.

### Error Handling

- If `simulation.load()` fails (parse error), the interval is not started
- The interval checks `store.simulationMode` on each tick and self-terminates if simulation mode was turned off
- The `setSimTagValue` store action no-ops when `simulationMode === false`

### Full Closed-Loop Diagram

```
     User adjusts                                   User observes
     tag slider                                     widget update
         │                                              ▲
         ▼                                              │
  ┌──────────────┐                            ┌──────────────────┐
  │ Zustand Store │──── simTagValues ────────► │ SimulationData   │
  │               │                            │ Provider          │
  │ tank1_level:82│ ◄──── setSimTagValue ───── │ (ScadaDataContext)│
  │ pump1_speed:0 │          │                 └──────────────────┘
  └───────────────┘          │
         ▲                   │
         │              ┌────┴──────────────────────┐
    read inputs         │    setInterval (100ms)     │
         │              │                            │
         └──────────────┤  1. Read INPUT bindings    │
                        │  2. interpreter.runCycle() │
                        │  3. Write OUTPUT bindings  │
                        └───────────────────────────┘
                                    │
                            ST Program executes:
                            IF tank_level > 80 THEN
                              pump_speed := 0;
                            ELSE
                              pump_speed := 100;
                            END_IF;
```

---

## Scenario System

### Built-in Scenarios

Generated automatically from widget tags:

| Scenario | Logic |
|----------|-------|
| **Normal Operation** | Pumps ON, valves OPEN, numeric tags at midpoint |
| **Pump Fault** | First pump tag set to OFF/false, fault indicator to -1 |
| **Tank Overflow** | Tank/level tags set to 95% of max |
| **All Stop** | All booleans false, all numbers 0 |

### Custom Scenarios

Users can save the current tag state as a named scenario. Stored in `localStorage` under `scada-sim-scenarios`. Supports save and delete operations.

---

## File Reference

| File | Type | Description |
|------|------|-------------|
| `store/scada/simulationSlice.ts` | **New** | Zustand slice: `simulationMode`, `simTagValues`, `simAlarms` |
| `store/scada/types.ts` | Modified | `SimulationSlice` interface added to `ScadaStore` union |
| `store/scada/createScadaStore.ts` | Modified | Slice composition |
| `store/scada/index.ts` | Modified | Re-export `SimulationSlice` |
| `context/SimulationDataProvider.tsx` | **New** | Injects `simTagValues` into `ScadaDataContext` |
| `context/ScadaDataProvider.tsx` | Modified | `ScadaDataContext` exported (was private) |
| `hooks/useAlarmEvaluation.ts` | **New** | Alarm rule evaluation with deadband + delay |
| `components/scada-builder/SimulationSidebar.tsx` | **New** | Tag inject, scenarios, alarms, automation UI |
| `components/scada-builder/GlobalAlarmBanner.tsx` | Modified | Shows `simAlarms` in simulation mode |
| `components/scada-builder/nodes/ScadaWidgetNode.tsx` | Modified | `toggle`/`press`/`writeTag` simulation commands |
| `pages/scada/ScadaPackageBuilderPage.tsx` | Modified | Three-mode segment control, provider wrapping |
| `simulation/useSimulation.ts` | Modified | Added `getVariableSnapshot`, `setInputDirect`, `runOneCycleDirect` |

### Unchanged Files (zero modifications)

- `ScreenCanvas.tsx` — already uses generic `getTagValue(deviceCode, tagName)`
- `ScadaDataProvider.tsx` — same Context is shared (only export changed)
- `WidgetRenderer.tsx` and all `widget-renderers/*.tsx` — `value` prop works as-is
- `useSimulation.ts` core logic — existing API preserved, new methods are additive
- `st-interpreter.ts` / `st-parser-lite.ts` — reused without modification
