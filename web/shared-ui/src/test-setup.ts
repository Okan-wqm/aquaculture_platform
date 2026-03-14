/**
 * Vitest Test Setup
 * Global mocks and environment configuration for shared-ui tests.
 */

import { vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// localStorage mock (jsdom provides a basic one, but we ensure it's clean)
// ============================================================================

beforeEach(() => {
  localStorage.clear();
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
// Suppress console.warn / console.error in tests (optional, keep errors visible)
// ============================================================================

const originalWarn = console.warn;
beforeEach(() => {
  console.warn = vi.fn();
});
afterEach(() => {
  console.warn = originalWarn;
});
