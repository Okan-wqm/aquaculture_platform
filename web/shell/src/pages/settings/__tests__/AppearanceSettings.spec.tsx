/**
 * The settings page's Appearance card reads the one theme store the console
 * shares: the preference and the theme applied to <html> (utils/theme.ts). A
 * change made anywhere else — the console's user menu or palette
 * (useAppliedTheme) — shows on its buttons at once, and the OS colour scheme
 * moves the screen only while the applied preference is "system".
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppliedTheme } from '../../../hooks/useAppliedTheme';
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  followSystemThemePreference,
} from '../../../utils/theme';
import { AppearanceSettings } from '../AppearanceSettings';

/** A controllable `(prefers-color-scheme: dark)` query. */
function installColorScheme(initiallyDark: boolean): { setDark: (dark: boolean) => void } {
  let dark = initiallyDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches(): boolean {
        return query.includes('dark') && dark;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void): void => {
        listeners.delete(listener);
      },
    })),
  );
  return {
    setDark(next: boolean): void {
      dark = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function pressed(name: string): string | null {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed');
}

/** The attributes are observed: an update lands on the observer's microtask. */
async function flushObserver(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

let scheme: ReturnType<typeof installColorScheme>;

beforeEach(() => {
  scheme = installColorScheme(false);
  applyThemePreference('system');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.themePreference;
  localStorage.clear();
});

describe('AppearanceSettings', () => {
  it('presses the applied preference and stores a choice made here', async () => {
    const user = userEvent.setup();
    const showToast = vi.fn();
    render(<AppearanceSettings showToast={showToast} />);
    expect(pressed('System')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Dark' }));
    await flushObserver();
    expect(pressed('Dark')).toBe('true');
    expect(pressed('System')).toBe('false');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('follows a theme the console changed while the card is open', async () => {
    render(<AppearanceSettings showToast={vi.fn()} />);
    const menu = renderHook(() => useAppliedTheme());
    expect(pressed('System')).toBe('true');

    act(() => menu.result.current[1]('dark'));
    await flushObserver();
    expect(pressed('Dark')).toBe('true');
    expect(pressed('System')).toBe('false');
    expect(screen.getByText('Current theme: Dark')).toBeInTheDocument();
  });

  it('lets the OS scheme move the screen only while the applied preference is system', async () => {
    const stop = followSystemThemePreference();
    render(<AppearanceSettings showToast={vi.fn()} />);
    const menu = renderHook(() => useAppliedTheme());

    act(() => scheme.setDark(true));
    await flushObserver();
    expect(document.documentElement.dataset.theme).toBe('dark');

    // An explicit choice made elsewhere holds against the OS.
    act(() => menu.result.current[1]('light'));
    await flushObserver();
    act(() => scheme.setDark(false));
    act(() => scheme.setDark(true));
    await flushObserver();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(pressed('Light')).toBe('true');
    stop();
  });
});
