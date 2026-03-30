# SCADA Professional Upgrade — Enterprise Architecture

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FUXA-seviyesi profesyonel SCADA deneyimi: tag-driven animasyon motoru, universal event bus, overlay view manager, pipe flow.

**Architecture:** Mevcut monolitik `onCommand` callback zincirini 3 bağımsız domain katmanına ayrıştırıyoruz. Her katman kendi slice'ı, context'i, hook'ları ve type'larıyla bağımsız çalışır. Mevcut widget renderer'lar değişmez — yeni katmanlar onları saran değil, onlara veri sağlayan servislerdir.

**Design Principles:**
- **Separation of Concerns:** Animation Engine, Event Bus, View Manager birbirinden bağımsız
- **Open/Closed:** Mevcut renderer'lar değişmez, yeni prop'lar opsiyonel olarak eklenir
- **Composition over Inheritance:** Hook-based composition (useAnimationState, useWidgetEvents)
- **Single Source of Truth:** Tag values → TagValueBus → tüm subscriber'lar
- **Backward Compatible:** Mevcut ScadaPackageJSON'a optional field'lar eklenir, eski JSON'lar sorunsuz yüklenir

**Tech Stack:** React 18, TypeScript strict, Zustand + Immer, ReactFlow v11, CSS Keyframes, React Context, ReactDOM.createPortal

**Base Path:** `web/modules/sensor-module/src/` (tüm path'ler buna relative)

---

## Mimari Overview

```
┌─────────────────────────────────────────────────────┐
│                  ScadaRuntime (Context)              │
│                                                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐│
│  │ TagValueBus  │ │  EventBus    │ │ ViewManager  ││
│  │              │ │              │ │              ││
│  │ subscribe()  │ │ publish()    │ │ openCard()   ││
│  │ publish()    │ │ subscribe()  │ │ openDialog() ││
│  │ getLatest()  │ │ handlers[]   │ │ close()      ││
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘│
│         │                │                │        │
│  ┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐│
│  │  Animation   │ │   Action     │ │   Overlay    ││
│  │  Engine      │ │   Handlers   │ │   Renderer   ││
│  │              │ │              │ │              ││
│  │ evaluate()   │ │ navigate()   │ │ PopupCard    ││
│  │ getState()   │ │ openCard()   │ │ ModalDialog  ││
│  │              │ │ setValue()   │ │ ScadaViewport││
│  └──────┬───────┘ └──────────────┘ └──────────────┘│
│         │                                           │
│  ┌──────▼──────────────────────────────────────────┐│
│  │           Widget Renderers (unchanged)          ││
│  │  + animationState prop (optional)               ││
│  │  + ScadaWidgetNode dispatches via EventBus      ││
│  └─────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

---

## File Structure

### Domain 1: Animation Engine (`engine/animation/`)

| File | Responsibility |
|------|---------------|
| `engine/animation/types.ts` | AnimationRule, AnimationState, ColorRange, typed action options |
| `engine/animation/AnimationEngine.ts` | Pure function: `evaluate(rules, tagValues) → AnimationState` |
| `engine/animation/useAnimationState.ts` | Hook: subscribes to TagValueBus, runs engine, returns `AnimationState` per widget |
| `engine/animation/AnimationStyles.ts` | CSS keyframes injected once (rotate-cw, rotate-ccw, blink, pipe-flow) |
| `engine/animation/__tests__/AnimationEngine.test.ts` | Unit tests for evaluate() — pure function, easy to test |

### Domain 2: Event Bus (`engine/events/`)

| File | Responsibility |
|------|---------------|
| `engine/events/types.ts` | WidgetEvent, EventTrigger, EventAction, EventParams — typed contracts |
| `engine/events/WidgetEventBus.ts` | Pub/sub event bus class (not React-specific) |
| `engine/events/handlers/NavigateHandler.ts` | Handles navigate action → setActiveScreen |
| `engine/events/handlers/OverlayHandler.ts` | Handles openCard/openDialog → ViewManager |
| `engine/events/handlers/TagWriteHandler.ts` | Handles setValue/toggleValue → TagValueBus |
| `engine/events/handlers/ScriptHandler.ts` | Handles runScript → automation binding |
| `engine/events/useWidgetEvents.ts` | Hook: binds widget click/hover → EventBus.publish() |
| `engine/events/__tests__/WidgetEventBus.test.ts` | Unit tests for pub/sub |
| `engine/events/__tests__/handlers.test.ts` | Unit tests for each handler |

### Domain 3: View Manager (`engine/views/`)

| File | Responsibility |
|------|---------------|
| `engine/views/types.ts` | OverlayEntry, ViewStackEntry, VariableMapping |
| `engine/views/viewManagerSlice.ts` | Zustand slice: overlays[], open/close/closeAll |
| `engine/views/ScadaViewport.tsx` | Reusable component: renders any ScreenDef's widgets as a mini-canvas |
| `engine/views/PopupCard.tsx` | Floating card overlay (positioned near mouse) |
| `engine/views/ModalDialog.tsx` | Centered modal overlay (backdrop + content) |
| `engine/views/OverlayStack.tsx` | Portal-based renderer for all active overlays |
| `engine/views/__tests__/viewManagerSlice.test.ts` | Unit tests for overlay state |

### Domain 4: Tag Value Bus (`engine/tags/`)

| File | Responsibility |
|------|---------------|
| `engine/tags/TagValueBus.ts` | Central tag value pub/sub — simulation + live data merge |
| `engine/tags/useTagValue.ts` | Hook: subscribe to single tag, returns latest value |
| `engine/tags/useTagValues.ts` | Hook: subscribe to multiple tags, returns Record |

### Domain 5: Runtime Context (`engine/ScadaRuntime.tsx`)

| File | Responsibility |
|------|---------------|
| `engine/ScadaRuntime.tsx` | React Context provider that wires TagValueBus + EventBus + ViewManager |
| `engine/useScadaRuntime.ts` | Hook: access runtime services from any component |

### New Widget: Pipe Flow

| File | Responsibility |
|------|---------------|
| `components/scada-builder/widget-renderers/PipeFlowRenderer.tsx` | SVG pipe with animated dash flow |
| `components/scada-builder/widget-configs/PipeFlowConfig.tsx` | Config panel for pipe properties |

### Config UI Panels

| File | Responsibility |
|------|---------------|
| `components/scada-builder/widget-configs/EventsPanel.tsx` | UI: add/edit/remove WidgetEvent[] on any widget |
| `components/scada-builder/widget-configs/AnimationsPanel.tsx` | UI: add/edit/remove AnimationRule[] on any widget |

### Modified Files

| File | What Changes |
|------|-------------|
| `types/scada-package.types.ts` | `ScreenWidget` gets optional `animations?: AnimationRule[]`, `events?: WidgetEvent[]` |
| `types/scada-widget.types.ts` | Add `'pipeFlow'` to `ScadaWidgetType` union |
| `store/scada/types.ts` | Add `ViewManagerSlice` to `ScadaStore` union, `ScreenDef` gets `backgroundImage?` |
| `store/scada/createScadaStore.ts` | Wire in `viewManagerSlice` |
| `store/scada/index.ts` | Re-export new types |
| `store/scada/projectSlice.ts` | Serialize/deserialize `animations`, `events`, `backgroundImage` in JSON |
| `components/scada-builder/WidgetRenderer.tsx` | Add `pipeFlow` to lazy map, add optional `animationState` to `WidgetRendererProps` |
| `components/scada-builder/nodes/ScadaWidgetNode.tsx` | Use `useAnimationState()`, `useWidgetEvents()`, pass `animationState` to renderer |
| `components/scada-builder/ScreenCanvas.tsx` | Wrap in `<ScadaRuntime>`, mount `<OverlayStack>`, mount `<AnimationStyles>` |
| `components/scada-builder/PropertiesPanel.tsx` | Add "Events" + "Animations" tabs |
| `components/scada-builder/WidgetPalette.tsx` | Add `pipeFlow` to palette |
| `components/scada-builder/CanvasSettings.tsx` | Add background image upload |
| `components/scada-builder/equipment-symbols/pumps/CentrifugalPumpSymbol.tsx` | Read `animationState.rotating` → apply CSS class |
| (All 6 pump symbols) | Same pattern |

---

## Task 1: Tag Value Bus

**Files:**
- Create: `engine/tags/TagValueBus.ts`
- Create: `engine/tags/useTagValue.ts`
- Create: `engine/tags/useTagValues.ts`
- Test: `engine/tags/__tests__/TagValueBus.test.ts`

- [ ] **Step 1: Write failing test for TagValueBus**

```typescript
// engine/tags/__tests__/TagValueBus.test.ts
import { TagValueBus } from '../TagValueBus';

describe('TagValueBus', () => {
  let bus: TagValueBus;
  beforeEach(() => { bus = new TagValueBus(); });

  it('publishes and receives tag value', () => {
    const cb = jest.fn();
    bus.subscribe('pump1.rpm', cb);
    bus.publish('pump1.rpm', 1450);
    expect(cb).toHaveBeenCalledWith(1450, 'pump1.rpm');
  });

  it('getLatest returns last published value', () => {
    bus.publish('tank1.level', 72.5);
    expect(bus.getLatest('tank1.level')).toBe(72.5);
  });

  it('getLatest returns undefined for unknown tag', () => {
    expect(bus.getLatest('nonexistent')).toBeUndefined();
  });

  it('unsubscribe stops delivery', () => {
    const cb = jest.fn();
    const unsub = bus.subscribe('tag1', cb);
    bus.publish('tag1', 1);
    unsub();
    bus.publish('tag1', 2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('publishBatch updates multiple tags', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    bus.subscribe('a', cb1);
    bus.subscribe('b', cb2);
    bus.publishBatch({ a: 10, b: 20 });
    expect(cb1).toHaveBeenCalledWith(10, 'a');
    expect(cb2).toHaveBeenCalledWith(20, 'b');
  });

  it('wildcard subscriber receives all changes', () => {
    const cb = jest.fn();
    bus.subscribe('*', cb);
    bus.publish('x', 1);
    bus.publish('y', 2);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('getSnapshot returns all current values', () => {
    bus.publish('a', 1);
    bus.publish('b', 2);
    expect(bus.getSnapshot()).toEqual({ a: 1, b: 2 });
  });
});
```

- [ ] **Step 2: Run test — verify it fails (TagValueBus not found)**

Run: `cd web && npx jest engine/tags/__tests__/TagValueBus.test.ts --no-cache`

- [ ] **Step 3: Implement TagValueBus**

```typescript
// engine/tags/TagValueBus.ts
type TagListener = (value: unknown, tagName: string) => void;

export class TagValueBus {
  private listeners = new Map<string, Set<TagListener>>();
  private values = new Map<string, unknown>();

  subscribe(tagName: string, listener: TagListener): () => void {
    if (!this.listeners.has(tagName)) {
      this.listeners.set(tagName, new Set());
    }
    this.listeners.get(tagName)!.add(listener);
    return () => { this.listeners.get(tagName)?.delete(listener); };
  }

  publish(tagName: string, value: unknown): void {
    this.values.set(tagName, value);
    this.listeners.get(tagName)?.forEach((cb) => cb(value, tagName));
    this.listeners.get('*')?.forEach((cb) => cb(value, tagName));
  }

  publishBatch(values: Record<string, unknown>): void {
    for (const [tag, val] of Object.entries(values)) {
      this.publish(tag, val);
    }
  }

  getLatest(tagName: string): unknown {
    return this.values.get(tagName);
  }

  getSnapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.values.forEach((v, k) => { result[k] = v; });
    return result;
  }

  clear(): void {
    this.listeners.clear();
    this.values.clear();
  }
}
```

- [ ] **Step 4: Implement useTagValue and useTagValues hooks**

```typescript
// engine/tags/useTagValue.ts
import { useState, useEffect } from 'react';
import { useScadaRuntime } from '../useScadaRuntime';

export function useTagValue(tagName: string | undefined): unknown {
  const { tagBus } = useScadaRuntime();
  const [value, setValue] = useState<unknown>(() => tagName ? tagBus.getLatest(tagName) : undefined);

  useEffect(() => {
    if (!tagName) return;
    setValue(tagBus.getLatest(tagName));
    return tagBus.subscribe(tagName, (val) => setValue(val));
  }, [tagBus, tagName]);

  return value;
}
```

```typescript
// engine/tags/useTagValues.ts
import { useState, useEffect, useRef } from 'react';
import { useScadaRuntime } from '../useScadaRuntime';

export function useTagValues(tagNames: string[]): Record<string, unknown> {
  const { tagBus } = useScadaRuntime();
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const snap: Record<string, unknown> = {};
    for (const t of tagNames) snap[t] = tagBus.getLatest(t);
    return snap;
  });

  const tagsRef = useRef(tagNames);
  tagsRef.current = tagNames;

  useEffect(() => {
    const unsubs = tagNames.map((tag) =>
      tagBus.subscribe(tag, (val, name) => {
        setValues((prev) => ({ ...prev, [name]: val }));
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [tagBus, tagNames.join(',')]);

  return values;
}
```

- [ ] **Step 5: Run tests — verify pass**

- [ ] **Step 6: Commit**

```bash
git add web/modules/sensor-module/src/engine/
git commit -m "feat(scada): add TagValueBus with pub/sub and hooks"
```

---

## Task 2: Animation Engine (Pure Functions + Hook)

**Files:**
- Create: `engine/animation/types.ts`
- Create: `engine/animation/AnimationEngine.ts`
- Create: `engine/animation/useAnimationState.ts`
- Create: `engine/animation/AnimationStyles.ts`
- Test: `engine/animation/__tests__/AnimationEngine.test.ts`

- [ ] **Step 1: Define animation types**

```typescript
// engine/animation/types.ts

export interface ColorRange {
  min: number;
  max: number;
  fill: string;
  stroke?: string;
  label?: string;
}

export interface AnimationRule {
  id: string;
  tagName: string;
  bitmask?: number;
  range: { min: number; max: number };
  type: AnimationRuleType;
  options: AnimationOptions;
}

export type AnimationRuleType =
  | 'colorRange'
  | 'rotate'
  | 'blink'
  | 'hide'
  | 'show'
  | 'fillLevel'
  | 'move';

export interface AnimationOptions {
  ranges?: ColorRange[];
  rotationSpeed?: number;       // ms per revolution (default 2000)
  direction?: 'cw' | 'ccw';
  blinkInterval?: number;       // ms (default 1000)
  fillA?: string;
  fillB?: string;
  strokeA?: string;
  strokeB?: string;
  fillMin?: number;
  fillMax?: number;
  fillColor?: string;
  fillWarningThreshold?: number;
  fillCriticalThreshold?: number;
  fillWarningColor?: string;
  fillCriticalColor?: string;
  toX?: number;
  toY?: number;
  duration?: number;
}

/** Output of AnimationEngine.evaluate() — consumed by renderers */
export interface AnimationState {
  visible: boolean;
  fill?: string;
  stroke?: string;
  rotating: boolean;
  rotationSpeed: number;
  rotationDirection: 'cw' | 'ccw';
  blinking: boolean;
  blinkInterval: number;
  blinkFillA?: string;
  blinkFillB?: string;
  fillPercent?: number;          // 0-100 for tank/level widgets
  fillColor?: string;
  translateX: number;
  translateY: number;
  transitionDuration: number;
}

export const DEFAULT_ANIMATION_STATE: AnimationState = {
  visible: true,
  rotating: false,
  rotationSpeed: 2000,
  rotationDirection: 'cw',
  blinking: false,
  blinkInterval: 1000,
  fillPercent: undefined,
  translateX: 0,
  translateY: 0,
  transitionDuration: 0,
};
```

- [ ] **Step 2: Write failing tests for AnimationEngine.evaluate()**

```typescript
// engine/animation/__tests__/AnimationEngine.test.ts
import { evaluate } from '../AnimationEngine';
import type { AnimationRule } from '../types';

describe('AnimationEngine.evaluate', () => {
  it('returns default state with no rules', () => {
    const state = evaluate([], {});
    expect(state.visible).toBe(true);
    expect(state.rotating).toBe(false);
    expect(state.blinking).toBe(false);
  });

  it('hides widget when hide rule matches', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'alarm', range: { min: 1, max: 1 },
      type: 'hide', options: {},
    }];
    expect(evaluate(rules, { alarm: 1 }).visible).toBe(false);
    expect(evaluate(rules, { alarm: 0 }).visible).toBe(true);
  });

  it('activates rotation when rotate rule matches', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'pump_status', range: { min: 1, max: 999 },
      type: 'rotate', options: { rotationSpeed: 1500, direction: 'ccw' },
    }];
    const state = evaluate(rules, { pump_status: 1 });
    expect(state.rotating).toBe(true);
    expect(state.rotationSpeed).toBe(1500);
    expect(state.rotationDirection).toBe('ccw');
  });

  it('resolves color from colorRange rule', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'temp', range: { min: 0, max: 100 },
      type: 'colorRange', options: {
        ranges: [
          { min: 0, max: 30, fill: '#22c55e' },
          { min: 31, max: 60, fill: '#eab308' },
          { min: 61, max: 100, fill: '#ef4444', stroke: '#dc2626' },
        ],
      },
    }];
    expect(evaluate(rules, { temp: 15 }).fill).toBe('#22c55e');
    expect(evaluate(rules, { temp: 45 }).fill).toBe('#eab308');
    expect(evaluate(rules, { temp: 80 }).fill).toBe('#ef4444');
    expect(evaluate(rules, { temp: 80 }).stroke).toBe('#dc2626');
  });

  it('calculates fillPercent from fillLevel rule', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'level', range: { min: 0, max: 1000 },
      type: 'fillLevel', options: { fillMin: 0, fillMax: 500 },
    }];
    expect(evaluate(rules, { level: 250 }).fillPercent).toBe(50);
    expect(evaluate(rules, { level: 0 }).fillPercent).toBe(0);
    expect(evaluate(rules, { level: 500 }).fillPercent).toBe(100);
    expect(evaluate(rules, { level: 600 }).fillPercent).toBe(100); // clamped
  });

  it('activates blink when rule matches', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'fault', range: { min: 1, max: 1 },
      type: 'blink', options: { blinkInterval: 500, fillA: 'red', fillB: 'gray' },
    }];
    const state = evaluate(rules, { fault: 1 });
    expect(state.blinking).toBe(true);
    expect(state.blinkInterval).toBe(500);
    expect(state.blinkFillA).toBe('red');
  });

  it('applies bitmask before evaluation', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'status_word', bitmask: 0b0100,
      range: { min: 1, max: 1 }, type: 'rotate', options: {},
    }];
    expect(evaluate(rules, { status_word: 0b0110 }).rotating).toBe(true);  // bit2 = 1
    expect(evaluate(rules, { status_word: 0b0010 }).rotating).toBe(false); // bit2 = 0
  });

  it('applies move when in range', () => {
    const rules: AnimationRule[] = [{
      id: '1', tagName: 'pos', range: { min: 1, max: 1 },
      type: 'move', options: { toX: 50, toY: -20, duration: 300 },
    }];
    const state = evaluate(rules, { pos: 1 });
    expect(state.translateX).toBe(50);
    expect(state.translateY).toBe(-20);
    expect(state.transitionDuration).toBe(300);
  });
});
```

- [ ] **Step 3: Run tests — verify they fail**

- [ ] **Step 4: Implement AnimationEngine.evaluate()**

```typescript
// engine/animation/AnimationEngine.ts
import type { AnimationRule, AnimationState, ColorRange } from './types';
import { DEFAULT_ANIMATION_STATE } from './types';

function applyBitmask(value: number, bitmask?: number): number {
  if (!bitmask) return value;
  const masked = value & bitmask;
  let shift = 0;
  let m = bitmask;
  while (m > 0 && (m & 1) === 0) { shift++; m >>= 1; }
  return masked >> shift;
}

function resolveColor(value: number, ranges: ColorRange[]): { fill?: string; stroke?: string } | null {
  for (const r of ranges) {
    if (value >= r.min && value <= r.max) return { fill: r.fill, stroke: r.stroke };
  }
  return null;
}

/**
 * Pure function — evaluates animation rules against current tag values.
 * No side effects, no DOM access, no React dependency.
 * Returns an AnimationState describing the visual state of a widget.
 */
export function evaluate(
  rules: AnimationRule[],
  tagValues: Record<string, unknown>,
): AnimationState {
  const state: AnimationState = { ...DEFAULT_ANIMATION_STATE };

  for (const rule of rules) {
    const raw = tagValues[rule.tagName];
    if (raw === undefined) continue;

    const num = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (Number.isNaN(num)) continue;

    const effective = applyBitmask(num, rule.bitmask);
    const inRange = effective >= rule.range.min && effective <= rule.range.max;
    if (!inRange) continue;

    const opts = rule.options;

    switch (rule.type) {
      case 'hide':
        state.visible = false;
        break;
      case 'show':
        state.visible = true;
        break;
      case 'rotate':
        state.rotating = true;
        state.rotationSpeed = opts.rotationSpeed ?? 2000;
        state.rotationDirection = opts.direction ?? 'cw';
        break;
      case 'blink':
        state.blinking = true;
        state.blinkInterval = opts.blinkInterval ?? 1000;
        state.blinkFillA = opts.fillA;
        state.blinkFillB = opts.fillB;
        break;
      case 'colorRange': {
        const resolved = resolveColor(effective, opts.ranges ?? []);
        if (resolved?.fill) state.fill = resolved.fill;
        if (resolved?.stroke) state.stroke = resolved.stroke;
        break;
      }
      case 'fillLevel': {
        const min = opts.fillMin ?? 0;
        const max = opts.fillMax ?? 100;
        const pct = Math.max(0, Math.min(100, ((effective - min) / (max - min)) * 100));
        state.fillPercent = pct;
        state.fillColor = opts.fillColor;
        if (opts.fillCriticalThreshold && pct >= opts.fillCriticalThreshold) {
          state.fillColor = opts.fillCriticalColor ?? '#ef4444';
        } else if (opts.fillWarningThreshold && pct >= opts.fillWarningThreshold) {
          state.fillColor = opts.fillWarningColor ?? '#eab308';
        }
        break;
      }
      case 'move':
        state.translateX = opts.toX ?? 0;
        state.translateY = opts.toY ?? 0;
        state.transitionDuration = opts.duration ?? 500;
        break;
    }
  }

  return state;
}
```

- [ ] **Step 5: Implement useAnimationState hook**

```typescript
// engine/animation/useAnimationState.ts
import { useMemo } from 'react';
import type { AnimationRule, AnimationState } from './types';
import { DEFAULT_ANIMATION_STATE } from './types';
import { evaluate } from './AnimationEngine';
import { useTagValues } from '../tags/useTagValues';

export function useAnimationState(rules: AnimationRule[] | undefined): AnimationState {
  const tagNames = useMemo(
    () => (rules ?? []).map((r) => r.tagName).filter(Boolean),
    [rules],
  );

  const tagValues = useTagValues(tagNames);

  return useMemo(() => {
    if (!rules || rules.length === 0) return DEFAULT_ANIMATION_STATE;
    return evaluate(rules, tagValues);
  }, [rules, tagValues]);
}
```

- [ ] **Step 6: Create AnimationStyles (CSS keyframes — inject once)**

```typescript
// engine/animation/AnimationStyles.ts
import { useEffect } from 'react';

const CSS = `
@keyframes scada-rotate-cw { to { transform: rotate(360deg); } }
@keyframes scada-rotate-ccw { to { transform: rotate(-360deg); } }
@keyframes scada-blink { 0%,100%{opacity:1} 50%{opacity:0.12} }
@keyframes scada-pipe-flow { from{stroke-dashoffset:24} to{stroke-dashoffset:0} }
@keyframes scada-pipe-flow-rev { from{stroke-dashoffset:0} to{stroke-dashoffset:24} }
@keyframes scada-fade-in { from{opacity:0;transform:scale(.96)} to{opacity:1;transform:scale(1)} }
`;

let injected = false;

export function AnimationStyles(): null {
  useEffect(() => {
    if (injected) return;
    const el = document.createElement('style');
    el.id = 'scada-animation-keyframes';
    el.textContent = CSS;
    document.head.appendChild(el);
    injected = true;
  }, []);
  return null;
}
```

- [ ] **Step 7: Run tests — verify all pass**

- [ ] **Step 8: Commit**

```bash
git add web/modules/sensor-module/src/engine/animation/
git commit -m "feat(scada): add AnimationEngine with pure evaluate + useAnimationState hook"
```

---

## Task 3: Event Bus + Action Handlers

**Files:**
- Create: `engine/events/types.ts`
- Create: `engine/events/WidgetEventBus.ts`
- Create: `engine/events/handlers/NavigateHandler.ts`
- Create: `engine/events/handlers/OverlayHandler.ts`
- Create: `engine/events/handlers/TagWriteHandler.ts`
- Create: `engine/events/useWidgetEvents.ts`
- Test: `engine/events/__tests__/WidgetEventBus.test.ts`

- [ ] **Step 1: Define event types**

```typescript
// engine/events/types.ts

export type EventTrigger = 'click' | 'dblclick' | 'mousedown' | 'mouseup' | 'mouseover' | 'mouseout';

export type EventAction =
  | 'navigate'
  | 'openCard'
  | 'openDialog'
  | 'setValue'
  | 'toggleValue'
  | 'runScript'
  | 'openUrl';

export interface WidgetEventDef {
  id: string;
  trigger: EventTrigger;
  action: EventAction;
  params: EventParams;
}

export interface EventParams {
  targetScreenId?: string;
  width?: number;
  height?: number;
  targetTag?: string;
  value?: unknown;
  toggleTag?: string;
  programId?: string;
  url?: string;
  variableMap?: Record<string, string>;
}

/** Internal event dispatched through the bus */
export interface WidgetEventPayload {
  widgetId: string;
  screenId: string;
  action: EventAction;
  params: EventParams;
  mousePosition?: { x: number; y: number };
}

export type EventHandler = (event: WidgetEventPayload) => void;
```

- [ ] **Step 2: Write failing test for WidgetEventBus**

```typescript
// engine/events/__tests__/WidgetEventBus.test.ts
import { WidgetEventBus } from '../WidgetEventBus';
import type { WidgetEventPayload } from '../types';

describe('WidgetEventBus', () => {
  let bus: WidgetEventBus;
  beforeEach(() => { bus = new WidgetEventBus(); });

  it('dispatches to registered handler', () => {
    const handler = jest.fn();
    bus.register('navigate', handler);
    const event: WidgetEventPayload = {
      widgetId: 'w1', screenId: 's1', action: 'navigate',
      params: { targetScreenId: 's2' },
    };
    bus.dispatch(event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not dispatch to unrelated handler', () => {
    const handler = jest.fn();
    bus.register('openCard', handler);
    bus.dispatch({
      widgetId: 'w1', screenId: 's1', action: 'navigate',
      params: { targetScreenId: 's2' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('unregister stops delivery', () => {
    const handler = jest.fn();
    const unsub = bus.register('navigate', handler);
    unsub();
    bus.dispatch({
      widgetId: 'w1', screenId: 's1', action: 'navigate', params: {},
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('supports multiple handlers for same action', () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    bus.register('setValue', h1);
    bus.register('setValue', h2);
    bus.dispatch({
      widgetId: 'w1', screenId: 's1', action: 'setValue',
      params: { targetTag: 't', value: 42 },
    });
    expect(h1).toHaveBeenCalled();
    expect(h2).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implement WidgetEventBus**

```typescript
// engine/events/WidgetEventBus.ts
import type { EventAction, EventHandler, WidgetEventPayload } from './types';

export class WidgetEventBus {
  private handlers = new Map<EventAction, Set<EventHandler>>();

  register(action: EventAction, handler: EventHandler): () => void {
    if (!this.handlers.has(action)) this.handlers.set(action, new Set());
    this.handlers.get(action)!.add(handler);
    return () => { this.handlers.get(action)?.delete(handler); };
  }

  dispatch(event: WidgetEventPayload): void {
    this.handlers.get(event.action)?.forEach((h) => h(event));
  }

  clear(): void {
    this.handlers.clear();
  }
}
```

- [ ] **Step 4: Implement action handlers**

```typescript
// engine/events/handlers/NavigateHandler.ts
import type { EventHandler } from '../types';

export function createNavigateHandler(
  setActiveScreen: (id: string) => void,
): EventHandler {
  return (event) => {
    if (event.params.targetScreenId) {
      setActiveScreen(event.params.targetScreenId);
    }
  };
}
```

```typescript
// engine/events/handlers/OverlayHandler.ts
import type { EventHandler } from '../types';

interface ViewManagerActions {
  openOverlay: (entry: { type: 'card' | 'dialog'; screenId: string; position?: { x: number; y: number }; size?: { width: number; height: number } }) => void;
}

export function createOverlayHandler(viewManager: ViewManagerActions): EventHandler {
  return (event) => {
    if (!event.params.targetScreenId) return;

    if (event.action === 'openCard') {
      viewManager.openOverlay({
        type: 'card',
        screenId: event.params.targetScreenId,
        position: event.mousePosition ?? { x: 300, y: 200 },
        size: { width: event.params.width ?? 400, height: event.params.height ?? 300 },
      });
    } else if (event.action === 'openDialog') {
      viewManager.openOverlay({
        type: 'dialog',
        screenId: event.params.targetScreenId,
        size: { width: event.params.width ?? 600, height: event.params.height ?? 450 },
      });
    }
  };
}
```

```typescript
// engine/events/handlers/TagWriteHandler.ts
import type { EventHandler } from '../types';
import type { TagValueBus } from '../../tags/TagValueBus';

export function createTagWriteHandler(tagBus: TagValueBus): EventHandler {
  return (event) => {
    if (event.action === 'setValue' && event.params.targetTag) {
      tagBus.publish(event.params.targetTag, event.params.value);
    } else if (event.action === 'toggleValue' && event.params.toggleTag) {
      const current = tagBus.getLatest(event.params.toggleTag);
      tagBus.publish(event.params.toggleTag, !current);
    }
  };
}
```

- [ ] **Step 5: Implement useWidgetEvents hook**

```typescript
// engine/events/useWidgetEvents.ts
import { useCallback } from 'react';
import type { WidgetEventDef, EventTrigger } from './types';
import { useScadaRuntime } from '../useScadaRuntime';

/**
 * Returns an object of React event handlers (onClick, onDoubleClick, etc.)
 * that dispatch through the EventBus when triggered.
 */
export function useWidgetEvents(
  widgetId: string,
  screenId: string,
  events: WidgetEventDef[] | undefined,
): Record<string, (e: React.MouseEvent) => void> {
  const { eventBus } = useScadaRuntime();

  const dispatch = useCallback(
    (trigger: EventTrigger, e: React.MouseEvent) => {
      if (!events) return;
      const matching = events.filter((ev) => ev.trigger === trigger);
      for (const ev of matching) {
        eventBus.dispatch({
          widgetId,
          screenId,
          action: ev.action,
          params: ev.params,
          mousePosition: { x: e.clientX, y: e.clientY },
        });
      }
    },
    [eventBus, widgetId, screenId, events],
  );

  return {
    onClick: useCallback((e: React.MouseEvent) => dispatch('click', e), [dispatch]),
    onDoubleClick: useCallback((e: React.MouseEvent) => dispatch('dblclick', e), [dispatch]),
    onMouseDown: useCallback((e: React.MouseEvent) => dispatch('mousedown', e), [dispatch]),
    onMouseUp: useCallback((e: React.MouseEvent) => dispatch('mouseup', e), [dispatch]),
    onMouseEnter: useCallback((e: React.MouseEvent) => dispatch('mouseover', e), [dispatch]),
    onMouseLeave: useCallback((e: React.MouseEvent) => dispatch('mouseout', e), [dispatch]),
  };
}
```

- [ ] **Step 6: Run tests — verify pass**

- [ ] **Step 7: Commit**

```bash
git add web/modules/sensor-module/src/engine/events/
git commit -m "feat(scada): add WidgetEventBus with typed handlers"
```

---

## Task 4: View Manager + Overlay Components

**Files:**
- Create: `engine/views/types.ts`
- Create: `engine/views/viewManagerSlice.ts`
- Create: `engine/views/ScadaViewport.tsx`
- Create: `engine/views/PopupCard.tsx`
- Create: `engine/views/ModalDialog.tsx`
- Create: `engine/views/OverlayStack.tsx`
- Modify: `store/scada/types.ts`
- Modify: `store/scada/createScadaStore.ts`
- Test: `engine/views/__tests__/viewManagerSlice.test.ts`

- [ ] **Step 1: Define view types**

```typescript
// engine/views/types.ts
export interface OverlayEntry {
  id: string;
  type: 'card' | 'dialog';
  screenId: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  variableMap?: Record<string, string>;
}
```

- [ ] **Step 2: Create viewManagerSlice**

New Zustand slice following exact same pattern as existing 10 slices in `store/scada/`.

- [ ] **Step 3: Wire slice into createScadaStore.ts**

Add `createViewManagerSlice` to the `immer((...args) => ({...}))` composition.

- [ ] **Step 4: Create ScadaViewport — renders any screen's widgets as read-only mini-canvas**

```typescript
// engine/views/ScadaViewport.tsx
// Receives a ScreenDef and renders its widgets using WidgetRenderer
// in read-only preview mode. This is the core reusable component
// for rendering screens inside overlays, popups, and dialogs.
```

- [ ] **Step 5: Create PopupCard and ModalDialog**

PopupCard: floating `position: fixed` card at mouse coordinates with close button, renders `<ScadaViewport>` inside.

ModalDialog: centered `position: fixed` modal with backdrop blur, renders `<ScadaViewport>` inside.

- [ ] **Step 6: Create OverlayStack — portal-based renderer**

Reads `overlays[]` from store, renders PopupCard or ModalDialog per entry via `ReactDOM.createPortal`.

- [ ] **Step 7: Run tests**

- [ ] **Step 8: Commit**

```bash
git add web/modules/sensor-module/src/engine/views/ \
        web/modules/sensor-module/src/store/scada/
git commit -m "feat(scada): add ViewManager with PopupCard and ModalDialog overlays"
```

---

## Task 5: ScadaRuntime Context

**Files:**
- Create: `engine/ScadaRuntime.tsx`
- Create: `engine/useScadaRuntime.ts`

- [ ] **Step 1: Create ScadaRuntime provider**

```typescript
// engine/ScadaRuntime.tsx
import React, { createContext, useMemo, useEffect } from 'react';
import { TagValueBus } from './tags/TagValueBus';
import { WidgetEventBus } from './events/WidgetEventBus';
import { createNavigateHandler } from './events/handlers/NavigateHandler';
import { createOverlayHandler } from './events/handlers/OverlayHandler';
import { createTagWriteHandler } from './events/handlers/TagWriteHandler';
import { useScadaStore } from '../store/scada';
import { AnimationStyles } from './animation/AnimationStyles';

export interface ScadaRuntimeContextValue {
  tagBus: TagValueBus;
  eventBus: WidgetEventBus;
}

export const ScadaRuntimeContext = createContext<ScadaRuntimeContextValue | null>(null);

export const ScadaRuntime: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const tagBus = useMemo(() => new TagValueBus(), []);
  const eventBus = useMemo(() => new WidgetEventBus(), []);

  const setActiveScreen = useScadaStore((s) => s.setActiveScreen);
  const openOverlay = useScadaStore((s) => s.openOverlay);

  // Register action handlers once
  useEffect(() => {
    const unsubs = [
      eventBus.register('navigate', createNavigateHandler(setActiveScreen)),
      eventBus.register('openCard', createOverlayHandler({ openOverlay })),
      eventBus.register('openDialog', createOverlayHandler({ openOverlay })),
      eventBus.register('setValue', createTagWriteHandler(tagBus)),
      eventBus.register('toggleValue', createTagWriteHandler(tagBus)),
    ];
    return () => unsubs.forEach((u) => u());
  }, [eventBus, tagBus, setActiveScreen, openOverlay]);

  // Bridge: sync simulation store values → TagValueBus
  const simTagValues = useScadaStore((s) => s.simTagValues);
  useEffect(() => {
    tagBus.publishBatch(simTagValues);
  }, [tagBus, simTagValues]);

  const value = useMemo(() => ({ tagBus, eventBus }), [tagBus, eventBus]);

  return (
    <ScadaRuntimeContext.Provider value={value}>
      <AnimationStyles />
      {children}
    </ScadaRuntimeContext.Provider>
  );
};
```

```typescript
// engine/useScadaRuntime.ts
import { useContext } from 'react';
import { ScadaRuntimeContext, type ScadaRuntimeContextValue } from './ScadaRuntime';

export function useScadaRuntime(): ScadaRuntimeContextValue {
  const ctx = useContext(ScadaRuntimeContext);
  if (!ctx) throw new Error('useScadaRuntime must be used within <ScadaRuntime>');
  return ctx;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/modules/sensor-module/src/engine/ScadaRuntime.tsx \
        web/modules/sensor-module/src/engine/useScadaRuntime.ts
git commit -m "feat(scada): add ScadaRuntime context wiring TagBus + EventBus + handlers"
```

---

## Task 6: Integration — Wire Into Existing Builder

**Files:**
- Modify: `types/scada-package.types.ts`
- Modify: `types/scada-widget.types.ts`
- Modify: `store/scada/types.ts`
- Modify: `store/scada/projectSlice.ts`
- Modify: `components/scada-builder/WidgetRenderer.tsx`
- Modify: `components/scada-builder/nodes/ScadaWidgetNode.tsx`
- Modify: `components/scada-builder/ScreenCanvas.tsx`
- Modify: `components/scada-builder/PropertiesPanel.tsx`
- Modify: `components/scada-builder/WidgetPalette.tsx`

- [ ] **Step 1: Extend ScreenWidget type**

In `types/scada-package.types.ts`:
```typescript
import type { AnimationRule } from '../engine/animation/types';
import type { WidgetEventDef } from '../engine/events/types';

export interface ScreenWidget {
  id: string;
  widgetType: string;
  position: WidgetPosition;
  config: Record<string, unknown>;
  groupId?: string | null;
  locked?: boolean;
  animations?: AnimationRule[];    // NEW
  events?: WidgetEventDef[];       // NEW
}
```

- [ ] **Step 2: Add `pipeFlow` to widget type union + `backgroundImage` to ScreenDef**

- [ ] **Step 3: Add `animationState` to WidgetRendererProps (optional)**

In `WidgetRenderer.tsx`:
```typescript
import type { AnimationState } from '../../engine/animation/types';

export interface WidgetRendererProps {
  config: Record<string, unknown>;
  value?: number | string | boolean;
  width: number;
  height: number;
  isEditing: boolean;
  onCommand?: (command: string, value?: unknown) => void;
  tagName?: string;
  label?: string;
  animationState?: AnimationState;  // NEW — optional, backward compatible
}
```

Add `pipeFlow` to lazy map.

- [ ] **Step 4: Upgrade ScadaWidgetNode — use hooks instead of onCommand**

In `ScadaWidgetNode.tsx`:
1. Use `useAnimationState(widgetAnimations)` to get `AnimationState`
2. Use `useWidgetEvents(id, screenId, widgetEvents)` to get event handlers
3. Apply `animationState` as CSS styles on the container (rotation, blink, visibility, translate)
4. Pass `animationState` to `WidgetRenderer` as prop
5. Attach event handlers from `useWidgetEvents` to the container div
6. Keep existing `handleCommand` for backward compat but route new actions through EventBus

- [ ] **Step 5: Wrap ScreenCanvas in ScadaRuntime, mount OverlayStack**

In `ScreenCanvas.tsx`:
```typescript
import { ScadaRuntime } from '../../engine/ScadaRuntime';
import { OverlayStack } from '../../engine/views/OverlayStack';

// Wrap the ReactFlow in <ScadaRuntime>:
return (
  <ScadaRuntime>
    <ReactFlow ...>
      {/* existing content */}
    </ReactFlow>
    <OverlayStack />
  </ScadaRuntime>
);
```

- [ ] **Step 6: Add Events + Animations tabs to PropertiesPanel**

- [ ] **Step 7: Add PipeFlow to WidgetPalette**

- [ ] **Step 8: Update projectSlice JSON serialization**

Ensure `toScadaPackageJSON` and `loadFromJSON` handle `animations`, `events`, `backgroundImage`.

- [ ] **Step 9: Commit**

```bash
git add web/modules/sensor-module/src/
git commit -m "feat(scada): wire ScadaRuntime into builder with animation + event + overlay"
```

---

## Task 7: Equipment Pump Rotation + PipeFlow Widget

**Files:**
- Modify: All 6 pump symbols in `equipment-symbols/pumps/`
- Create: `widget-renderers/PipeFlowRenderer.tsx`
- Create: `widget-configs/PipeFlowConfig.tsx`

- [ ] **Step 1: Pump symbols read animationState.rotating**

Each pump symbol receives `animationState` (passed through EquipmentRenderer). When `animationState?.rotating === true`, apply CSS class `scada-pump-spinning` to the impeller `<g>` with `--scada-spin-speed` CSS variable.

No change when `animationState` is undefined — backward compatible.

- [ ] **Step 2: Create PipeFlowRenderer (SVG pipe with dash animation)**

- [ ] **Step 3: Create PipeFlowConfig (direction, colors, speed)**

- [ ] **Step 4: Commit**

```bash
git add web/modules/sensor-module/src/components/scada-builder/
git commit -m "feat(scada): add pump rotation animation + PipeFlow widget"
```

---

## Task 8: Background Image + Canvas Settings

**Files:**
- Modify: `store/scada/types.ts` (backgroundImage on ScreenDef)
- Modify: `components/scada-builder/ScreenCanvas.tsx`
- Modify: `components/scada-builder/CanvasSettings.tsx`

- [ ] **Step 1: Add `backgroundImage?: string`, `backgroundOpacity?: number` to ScreenDef**

- [ ] **Step 2: Render background layer in ScreenCanvas (behind ReactFlow nodes)**

- [ ] **Step 3: Add Upload/Remove button to CanvasSettings**

- [ ] **Step 4: Commit**

```bash
git add web/modules/sensor-module/src/
git commit -m "feat(scada): add background image support to canvas"
```

---

## Task 9: Config UI Panels (Events + Animations)

**Files:**
- Create: `components/scada-builder/widget-configs/EventsPanel.tsx`
- Create: `components/scada-builder/widget-configs/AnimationsPanel.tsx`

- [ ] **Step 1: Create EventsPanel — add/edit/remove WidgetEventDef[]**

Trigger dropdown + action dropdown + conditional params (screen selector, tag input, URL, size).

- [ ] **Step 2: Create AnimationsPanel — add/edit/remove AnimationRule[]**

Tag selector + range (min/max) + action type + type-specific options (color picker, speed, blink interval).

- [ ] **Step 3: Commit**

```bash
git add web/modules/sensor-module/src/components/scada-builder/widget-configs/
git commit -m "feat(scada): add Events and Animations config panels"
```

---

## Task 10: Tests + Build Verification

- [ ] **Step 1: Run all unit tests**

```bash
cd web && npx jest --passWithNoTests 2>&1 | tail -30
```

- [ ] **Step 2: TypeScript type check**

```bash
cd web && npx tsc --noEmit 2>&1 | tail -20
```

- [ ] **Step 3: Build**

```bash
cd web && npm run build 2>&1 | tail -20
```

- [ ] **Step 4: Visual smoke test checklist**

1. Pump rotation: Add pump → Animations tab → add rotate rule (tagName=pump_status, range 1-999) → simulation → set pump_status=1 → blades spin
2. Color ranges: Add numericDisplay → Animations tab → add colorRange rule → set value → color changes
3. Blink: Add statusIndicator → Animations tab → add blink rule → alarm tag=1 → widget blinks
4. Event → navigate: Add equipment → Events tab → click → navigate to Screen 2 → simulation → click → screen changes
5. Event → openCard: Add pump → Events tab → click → openCard → simulation → click → popup card appears
6. Event → openDialog: Add tank → Events tab → click → openDialog → simulation → click → modal opens
7. Pipe flow: Add pipeFlow widget → bind tag → toggle → dash animation flows
8. Background: Canvas Settings → Upload → image appears behind widgets
9. Save/Load: Save package → reload → all animations, events, background persist

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(scada): SCADA Professional Upgrade - enterprise animation, events, overlays"
```

---

## Summary — Mimari Karşılaştırma

| | Önceki Plan (Yama) | Bu Plan (Enterprise) |
|---|---|---|
| **Animation** | CSS class ekle/kaldır, wrapper div | Dedicated engine: pure `evaluate()` + `useAnimationState` hook |
| **Events** | `handleCommand` switch'e yeni case'ler | `WidgetEventBus` pub/sub + typed `EventHandler` registry |
| **Overlays** | Store'a overlay array push | `ViewManager` slice + `ScadaViewport` reusable component |
| **Tag Values** | `simTagValues` doğrudan okuma | `TagValueBus` class + `useTagValue`/`useTagValues` hooks |
| **Test** | Yok | Her domain'in kendi unit testleri |
| **Coupling** | Widget → store → command → action (sıkı) | Widget → EventBus → Handler → Service (gevşek) |
| **Extensibility** | Yeni aksiyon = handleCommand'a case ekle | Yeni aksiyon = yeni Handler register et |
| **Backward Compat** | Mevcut renderer'ları değiştirmek gerekiyor | `animationState` prop optional, mevcut code dokunulmaz |

---

## Ruflo Memory References

- `scada-upgrade/scada-animation-engine-arch` — Animation Engine architecture
- `scada-upgrade/scada-event-bus-arch` — Event Bus architecture
- `scada-upgrade/scada-overlay-manager-arch` — Overlay View Manager architecture
