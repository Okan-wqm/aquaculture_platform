import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
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

    unobserve() {}

    disconnect() {}
  };
}

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 900 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 700 });
