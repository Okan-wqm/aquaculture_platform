import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type { ReactNode } from 'react';

// WHY: React 19 + @testing-library/react 16 escalate recharts' react-smooth
// <Animate> async state updates ("An update to Animate inside a test was not
// wrapped in act(...)") from console warnings (the React 18 behavior these
// chart tests were written against) into HARD test failures. The C2 React 19
// bump surfaced this in WaterChemistryPage.spec (DeffeyesChart <Line>/<Scatter>
// series animate; only the <Area>s set isAnimationActive=false).
// WHAT: disable the animation in TESTS ONLY (production keeps its animations)
// by rendering react-smooth's <Animate> (its DEFAULT export — recharts does
// `import Animate from 'react-smooth'`) children immediately. The other
// react-smooth exports recharts needs (AnimateGroup, configBezier, configSpring)
// are preserved via the actual-module spread.
vi.mock('react-smooth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-smooth')>();
  const AnimatePassthrough = ({
    children,
  }: {
    children: ReactNode | ((style: Record<string, unknown>) => ReactNode);
  }): ReactNode => (typeof children === 'function' ? children({}) : children);
  return { ...actual, default: AnimatePassthrough };
});

afterEach(() => {
  cleanup();
});

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.callback([
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width: 900,
            height: 700,
            top: 0,
            left: 0,
            right: 900,
            bottom: 700,
            toJSON: () => ({}),
          },
        } as ResizeObserverEntry,
      ], this);
    }

    unobserve(): void {
      return undefined;
    }

    disconnect(): void {
      return undefined;
    }
  };
}

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 900 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 700 });
