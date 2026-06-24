/**
 * Vitest Test Setup — shell.
 * Provides jsdom shims the auth surface needs (matchMedia for the reduced-motion
 * guard, ResizeObserver for FishBackground) and a clean storage per test.
 */
import { beforeEach } from 'vitest';

// jsdom does not implement matchMedia. Default to "no reduced motion"; tests that
// need a specific preference override window.matchMedia themselves.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    addListener: (): void => {},
    removeListener: (): void => {},
    dispatchEvent: (): boolean => false,
  });
}

// jsdom does not implement ResizeObserver (used by FishBackground). A no-op class
// satisfies the constructor + observe/unobserve/disconnect surface.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverMock;
}

beforeEach(() => {
  localStorage.clear();
});
