// FE-HIGH-053 — root + route ErrorBoundary recovery.
//
// The PWA previously had an ErrorBoundary only on 4 hub pages, so a render crash
// in a provider, the router, or any other page white-screened the whole app. The
// fix wraps the render tree at the ROOT (main.tsx, inside QueryClientProvider but
// outside BrowserRouter/AuthProvider) and at the ROUTE level (App.tsx, around the
// lazy Routes+Suspense). These tests prove the SAME audited component recovers a
// render crash into a Try-Again card instead of unmounting the app, and that the
// crash is logged (observable, not silently swallowed).

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ErrorBoundary } from '../ErrorBoundary';

import { logger } from '@/utils/logger';

// The boundary's componentDidCatch routes through the structured logger
// (FE-HIGH-056) — assert the crash is recorded, never swallowed silently.
vi.mock('@/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function Boom(): never {
  throw new Error('render-phase crash');
}

describe('ErrorBoundary (FE-HIGH-053)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // React logs caught render errors to console.error during the test; silence
    // it so the suite output stays readable. The boundary's OWN logging goes
    // through the mocked logger, which we still assert on.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the recoverable fallback card when a child throws during render', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // The fallback alert card is shown (default title + Try Again button).
    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('does NOT unmount sibling subtree — a non-throwing child still renders', () => {
    // A second, independent ErrorBoundary around a healthy subtree proves the
    // boundary contains the crash locally rather than tearing down everything:
    // the healthy content is still mounted alongside the crashed boundary.
    render(
      <div>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
        <ErrorBoundary>
          <div data-testid="healthy">still here</div>
        </ErrorBoundary>
      </div>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    // The sibling subtree under its own boundary is untouched by the crash.
    expect(screen.getByTestId('healthy').textContent).toBe('still here');
  });

  it('logs the caught render error through the structured logger (observable, not swallowed)', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [message, error] = vi.mocked(logger.error).mock.calls[0];
    expect(message).toContain('[ErrorBoundary]');
    expect(error).toBeInstanceOf(Error);
  });

  it('Try-Again triggers a reload (recovery), never an auto-reload on mount', () => {
    // Recovery is a USER-initiated reload — a poisoned SW cache must not loop.
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });

    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );

      // No reload fired automatically when the boundary caught the error.
      expect(reloadSpy).not.toHaveBeenCalled();

      // Reload fires ONLY on the explicit Try-Again click.
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('renders children unchanged when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok').textContent).toBe('healthy');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
