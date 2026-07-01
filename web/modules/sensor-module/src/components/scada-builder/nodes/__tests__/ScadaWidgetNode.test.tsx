/**
 * ScadaWidgetNode hook-safety tests
 *
 * Bu testler React Rules of Hooks ihlalinin duzeltildigini dogrular.
 * Eski kod: useScadaRuntime() try/catch icinde cagiriliyordu. Throw ettiginde
 * useAnimationState ve useWidgetEvents atlaniyor, hook sayisi degisiyordu.
 *
 * These tests verify the Rules of Hooks violation fix.
 * Old code: useScadaRuntime() was called inside try/catch. When it threw,
 * useAnimationState and useWidgetEvents were skipped, changing hook count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScadaRuntimeContext } from '../../../../engine/ScadaRuntime';
import type { ScadaRuntimeContextValue } from '../../../../engine/ScadaRuntime';
import { TagValueBus } from '../../../../engine/tags/TagValueBus';
import { WidgetEventBus } from '../../../../engine/events/WidgetEventBus';
import { DEFAULT_ANIMATION_STATE } from '../../../../engine/animation/types';
import type { NodeProps, Node } from '@xyflow/react';
import type { ScadaWidgetNodeData } from '../../../../types/scada-widget.types';

// React act() uyarisini sustur — test ortaminda act destegi etkinlestir
// Silence React act() warning — enable act support in test environment
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ */
/*  Mock all heavy dependencies so we can unit-test the node in       */
/*  isolation.                                                         */
/* ------------------------------------------------------------------ */

// Mock @xyflow/react — bilesenin Handle/Position bağımlılığını karşıla
// Mock @xyflow/react — satisfy component's Handle/Position dependency
vi.mock('@xyflow/react', () => ({
  Handle: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'handle' }, children),
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

// Mock lucide-react Lock icon
vi.mock('lucide-react', () => ({
  Lock: () => React.createElement('span', null, 'lock-icon'),
}));

// Mock WidgetRenderer — gercek renderer'lari yuklemeden test et
// Mock WidgetRenderer — test without loading real renderers
vi.mock('../../WidgetRenderer', () => ({
  WidgetRenderer: (props: Record<string, unknown>) =>
    React.createElement('div', {
      'data-testid': 'widget-renderer',
      'data-widget-type': props.widgetType,
      'data-has-animation': props.animationState != null ? 'true' : 'false',
    }),
}));

// Mock WidgetTooltip
vi.mock('../../WidgetTooltip', () => ({
  WidgetTooltip: () => React.createElement('div', { 'data-testid': 'widget-tooltip' }),
}));

// Mock equipment-symbols
vi.mock('../../equipment-symbols/types', () => ({
  CONNECTION_POINTS: {},
  CONNECTION_POINT_COLORS: {},
  EQUIPMENT_VIEWBOX: {},
}));

// Mock widget sizes
vi.mock('../../../../constants/scada-widget-sizes', () => ({
  getWidgetPixelConstraints: () => ({
    minW: 50,
    minH: 50,
    maxW: 800,
    maxH: 600,
    defaultW: 200,
    defaultH: 150,
  }),
}));

// Mock zustand store — her selector icin varsayilan deger dondur
// Mock zustand store — return default value for each selector
const mockStoreSelectors: Record<string, unknown> = {
  locked: false,
  gridPosition: { col: 0, row: 0, w: 1, h: 1 },
  widgetAnimations: undefined,
  widgetEvents: undefined,
};

vi.mock('../../../../store/scada', () => ({
  useScadaPackageStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => {
      // Zustand store mock: selector'u sahte state ile cagir
      // Zustand store mock: call selector with fake state
      const fakeState = {
        screens: [{
          id: 'screen-1',
          widgets: [{
            id: 'widget-1',
            locked: mockStoreSelectors.locked,
            position: mockStoreSelectors.gridPosition,
            animations: mockStoreSelectors.widgetAnimations,
            events: mockStoreSelectors.widgetEvents,
          }],
        }],
      };
      return selector(fakeState);
    },
    {
      getState: () => ({
        setActiveScreen: vi.fn(),
        simulationMode: false,
        simTagValues: {},
        setSimTagValue: vi.fn(),
      }),
    },
  ),
}));

/* ------------------------------------------------------------------ */
/*  Test helpers                                                       */
/* ------------------------------------------------------------------ */

function createMinimalNodeData() {
  return {
    widgetType: 'gauge' as const,
    config: {},
    screenId: 'screen-1',
    isPreview: false,
  };
}

function createRuntimeValue(): ScadaRuntimeContextValue {
  return {
    tagBus: new TagValueBus(),
    eventBus: new WidgetEventBus(),
  };
}

/* ------------------------------------------------------------------ */
/*  Dynamic import because mocks must be registered first              */
/* ------------------------------------------------------------------ */

let ScadaWidgetNodeDefault: React.NamedExoticComponent<NodeProps<Node<ScadaWidgetNodeData>>>;

beforeEach(async () => {
  // Dinamik import — mock'lar etkinlestikten sonra yukle
  // Dynamic import — load after mocks are active
  const mod = await import('../ScadaWidgetNode');
  ScadaWidgetNodeDefault = mod.default;
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ScadaWidgetNode — Rules of Hooks fix', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
  });

  const nodeProps = {
    id: 'widget-1',
    type: 'scadaWidget',
    selected: false,
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
  };

  // Test 1: ScadaRuntime provider olmadan (edit modu) — crash olmamali
  // Test 1: Without ScadaRuntime provider (edit mode) — no crash
  it('renders without ScadaRuntime provider (edit mode) — no crash', () => {
    expect(() => {
      act(() => {
        root.render(
          React.createElement(ScadaWidgetNodeDefault, {
            ...nodeProps,
            data: createMinimalNodeData(),
          }),
        );
      });
    }).not.toThrow();

    const renderer = container.querySelector('[data-testid="widget-renderer"]');
    expect(renderer).not.toBeNull();
    expect(renderer?.getAttribute('data-widget-type')).toBe('gauge');
  });

  // Test 2: ScadaRuntime provider ile (preview modu) — animasyonlar calismali
  // Test 2: With ScadaRuntime provider (preview mode) — animations work
  it('renders with ScadaRuntime provider (preview mode) — no crash', () => {
    const runtimeValue = createRuntimeValue();

    expect(() => {
      act(() => {
        root.render(
          React.createElement(
            ScadaRuntimeContext.Provider,
            { value: runtimeValue },
            React.createElement(ScadaWidgetNodeDefault, {
              ...nodeProps,
              data: { ...createMinimalNodeData(), isPreview: true },
            }),
          ),
        );
      });
    }).not.toThrow();

    const renderer = container.querySelector('[data-testid="widget-renderer"]');
    expect(renderer).not.toBeNull();
    // animationState her zaman iletilir — has-animation true olmali
    // animationState is always passed — has-animation should be true
    expect(renderer?.getAttribute('data-has-animation')).toBe('true');
  });

  // Test 3: Hook sayisi provider ile/olmadan tutarli — Rules of Hooks uyumu
  // Test 3: Hook count consistent with/without provider — Rules of Hooks compliance
  it('hook count is consistent between renders with/without provider', () => {
    const runtimeValue = createRuntimeValue();

    // Ilk render: provider yok
    // First render: no provider
    act(() => {
      root.render(
        React.createElement(ScadaWidgetNodeDefault, {
          ...nodeProps,
          data: createMinimalNodeData(),
        }),
      );
    });

    // Ikinci render: provider var — hook sayisi degisirse React hata verir
    // Second render: with provider — React errors if hook count changes
    expect(() => {
      act(() => {
        root.render(
          React.createElement(
            ScadaRuntimeContext.Provider,
            { value: runtimeValue },
            React.createElement(ScadaWidgetNodeDefault, {
              ...nodeProps,
              data: createMinimalNodeData(),
            }),
          ),
        );
      });
    }).not.toThrow();

    // Ucuncu render: provider tekrar yok — hook sayisi yine ayni olmali
    // Third render: no provider again — hook count must still be the same
    expect(() => {
      act(() => {
        root.render(
          React.createElement(ScadaWidgetNodeDefault, {
            ...nodeProps,
            data: createMinimalNodeData(),
          }),
        );
      });
    }).not.toThrow();
  });

  // Test 4: Runtime yokken varsayilan animasyon durumu visible:true
  // Test 4: Default animation state is visible:true when no runtime
  it('default animation state is visible:true when no runtime', () => {
    act(() => {
      root.render(
        React.createElement(ScadaWidgetNodeDefault, {
          ...nodeProps,
          data: createMinimalNodeData(),
        }),
      );
    });

    // Widget gorunur olmali — opacity:0 veya display:none olmamali
    // Widget should be visible — no opacity:0 or display:none
    const outerDiv = container.firstElementChild as HTMLDivElement;
    expect(outerDiv).not.toBeNull();
    const style = outerDiv.style;
    // Gorunmez (hidden) animasyonda opacity 0 olur, varsayilan durumda olmamali
    // Hidden animation sets opacity to 0, default state should not have it
    expect(style.opacity).not.toBe('0');
    expect(style.pointerEvents).not.toBe('none');
  });

  // Test 5: Runtime yokken widget event'leri no-op (hata vermez)
  // Test 5: Widget events are no-op when no runtime (no errors)
  it('widget events are no-op when no runtime — click does not throw', () => {
    act(() => {
      root.render(
        React.createElement(ScadaWidgetNodeDefault, {
          ...nodeProps,
          data: createMinimalNodeData(),
        }),
      );
    });

    const outerDiv = container.firstElementChild as HTMLDivElement;
    expect(outerDiv).not.toBeNull();

    // Click eventi tetikle — event handler bos olmali, hata vermemeli
    // Fire click event — event handler should be empty, no errors
    expect(() => {
      act(() => {
        outerDiv.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }).not.toThrow();
  });

  // Test 6: Provider ile animasyon state her zaman renderer'a iletilir
  // Test 6: With provider, animation state is always passed to renderer
  it('passes animation state to renderer regardless of runtime presence', () => {
    // Provider olmadan
    // Without provider
    act(() => {
      root.render(
        React.createElement(ScadaWidgetNodeDefault, {
          ...nodeProps,
          data: createMinimalNodeData(),
        }),
      );
    });

    const rendererWithout = container.querySelector('[data-testid="widget-renderer"]');
    expect(rendererWithout?.getAttribute('data-has-animation')).toBe('true');

    // Provider ile
    // With provider
    const runtimeValue = createRuntimeValue();
    act(() => {
      root.render(
        React.createElement(
          ScadaRuntimeContext.Provider,
          { value: runtimeValue },
          React.createElement(ScadaWidgetNodeDefault, {
            ...nodeProps,
            data: createMinimalNodeData(),
          }),
        ),
      );
    });

    const rendererWith = container.querySelector('[data-testid="widget-renderer"]');
    expect(rendererWith?.getAttribute('data-has-animation')).toBe('true');
  });
});

/* ------------------------------------------------------------------ */
/*  useAnimationState + useWidgetEvents — bos girdi testleri           */
/*  useAnimationState + useWidgetEvents — empty input tests            */
/* ------------------------------------------------------------------ */

describe('useAnimationState — empty rules handling', () => {
  it('returns DEFAULT_ANIMATION_STATE with empty rules', async () => {
    const { useAnimationState } = await import('../../../../engine/animation/useAnimationState');

    // Hook'u test icin minimal bir sarmalayici ile cagir
    // Call hook via a minimal test wrapper
    let result: ReturnType<typeof useAnimationState> | undefined;
    const TestComponent = () => {
      result = useAnimationState(undefined, {});
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => { root.render(React.createElement(TestComponent)); });

    expect(result).toEqual(DEFAULT_ANIMATION_STATE);
    expect(result?.visible).toBe(true);
    expect(result?.rotating).toBe(false);
    expect(result?.blinking).toBe(false);

    act(() => { root.unmount(); });
    container.remove();
  });

  it('returns DEFAULT_ANIMATION_STATE with empty array', async () => {
    const { useAnimationState } = await import('../../../../engine/animation/useAnimationState');

    let result: ReturnType<typeof useAnimationState> | undefined;
    const TestComponent = () => {
      result = useAnimationState([], {});
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => { root.render(React.createElement(TestComponent)); });

    expect(result).toEqual(DEFAULT_ANIMATION_STATE);

    act(() => { root.unmount(); });
    container.remove();
  });
});

describe('useWidgetEvents — empty events handling', () => {
  it('returns handler map even with undefined events', async () => {
    const { useWidgetEvents } = await import('../../../../engine/events/useWidgetEvents');
    const noopBus = new WidgetEventBus();

    let result: Record<string, (e: React.MouseEvent) => void> | undefined;
    const TestComponent = () => {
      result = useWidgetEvents('w-1', 's-1', undefined, noopBus);
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => { root.render(React.createElement(TestComponent)); });

    // Handler objeleri donmeli — click cagrildiginda hata vermemeli
    // Handler objects should be returned — clicking should not throw
    expect(result).toBeDefined();
    expect(typeof result?.onClick).toBe('function');
    expect(typeof result?.onDoubleClick).toBe('function');

    // Click handler no-op olmali (events undefined oldugundan dispatch yapilmaz)
    // Click handler should be no-op (events undefined means no dispatch)
    const dispatchSpy = vi.spyOn(noopBus, 'dispatch');
    result?.onClick({ clientX: 0, clientY: 0 } as React.MouseEvent);
    expect(dispatchSpy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    container.remove();
  });

  it('returns handler map with empty events array', async () => {
    const { useWidgetEvents } = await import('../../../../engine/events/useWidgetEvents');
    const noopBus = new WidgetEventBus();

    let result: Record<string, (e: React.MouseEvent) => void> | undefined;
    const TestComponent = () => {
      result = useWidgetEvents('w-1', 's-1', [], noopBus);
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => { root.render(React.createElement(TestComponent)); });

    expect(result).toBeDefined();
    expect(typeof result?.onClick).toBe('function');

    // Bos events dizisi — dispatch cagrilmamali
    // Empty events array — dispatch should not be called
    const dispatchSpy = vi.spyOn(noopBus, 'dispatch');
    result?.onClick({ clientX: 0, clientY: 0 } as React.MouseEvent);
    expect(dispatchSpy).not.toHaveBeenCalled();

    act(() => { root.unmount(); });
    container.remove();
  });
});
