/**
 * Vitest Test Setup — shell.
 * Provides jsdom shims the auth surface needs (matchMedia for the reduced-motion
 * guard, ResizeObserver for the reef scene) and a clean storage per test.
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

// jsdom does not implement ResizeObserver (used by the reef scene). A no-op class
// satisfies the constructor + observe/unobserve/disconnect surface.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverMock;
}

// jsdom does not implement Element.scrollTo (used by the AI drawer's
// scroll-to-latest effect). A no-op keeps the layout effect harmless.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollTo !== 'function') {
  Element.prototype.scrollTo = (): void => {};
}

// Nor Element.scrollIntoView (the command palette keeps its highlighted row in
// view). A no-op keeps the effect harmless.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = (): void => {};
}

// A spec that runs Vite itself declares `@vitest-environment node`
// (shell/__tests__/buildManifestPlugin.spec.ts): there is no window, so no storage to clear.
beforeEach(() => {
  if (typeof window !== 'undefined') localStorage.clear();
});
