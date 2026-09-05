/**
 * Vitest Test Setup
 * Global mocks and environment configuration for shared-ui tests.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...) for vitest.
// The dependency was already present; the matchers were simply never wired,
// so every spec that used them had to import the entry point itself.
import '@testing-library/jest-dom/vitest';

// ============================================================================
// localStorage mock (jsdom provides a basic one, but we ensure it's clean)
// ============================================================================

beforeEach(() => {
  localStorage.clear();
  const authState = (window as any).__AQUACULTURE_AUTH_STATE_V2__;
  if (authState && typeof authState === 'object') {
    authState.accessToken = null;
    authState.tenantId = null;
  }
});

// ============================================================================
// crypto.randomUUID mock
// ============================================================================

if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      randomUUID: () => '00000000-0000-0000-0000-000000000000',
    },
  });
} else if (typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    value: () => '00000000-0000-0000-0000-000000000000',
    configurable: true,
  });
}

// ============================================================================
// recharts render polyfills — ResponsiveContainer needs ResizeObserver +
// element dimensions, which jsdom does not provide. Required by the promoted
// water-chemistry chart components (DeffeyesChart) tested under shared-ui.
// ============================================================================

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      this.callback(
        [
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
        ],
        this,
      );
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

// ============================================================================
// Suppress console.warn / console.error in tests (optional, keep errors visible)
// ============================================================================

const originalWarn = console.warn;
beforeEach(() => {
  console.warn = vi.fn();
});
afterEach(() => {
  console.warn = originalWarn;
});
