/**
 * The account preferences the console's user menu and palette change, through
 * the one path the settings page uses too:
 *  - the language switches this session at once and is saved on the account,
 *    so UserLocaleSync does not flip it back on the next load (FE-HIGH-089);
 *  - the theme is the stored preference, applied to <html> — and the menu
 *    reads what is applied, so a change made on the settings page shows too.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  setLocale: vi.fn(),
  refreshAuth: vi.fn(async (): Promise<void> => undefined),
  request: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useI18n: () => ({ ...actual.useI18n(), setLocale: harness.setLocale }),
    useAuthContext: () => ({ refreshAuth: harness.refreshAuth }),
    graphqlClient: { request: harness.request },
  };
});

import { UPDATE_MY_PROFILE } from '../../graphql/settings.operations';
import { THEME_STORAGE_KEY } from '../../utils/theme';
import { useAccountLanguage } from '../useAccountLanguage';
import { useAppliedTheme } from '../useAppliedTheme';

beforeEach(() => {
  harness.setLocale.mockClear();
  harness.refreshAuth.mockClear();
  harness.request.mockReset();
  harness.request.mockResolvedValue({});
});
afterEach(() => {
  // Unmount first: the hooks observe <html>, and resetting it must not reach a mounted one.
  cleanup();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
  localStorage.clear();
});

describe('useAccountLanguage', () => {
  it('switches the session first, then saves the account and reloads it', async () => {
    const { result } = renderHook(() => useAccountLanguage());
    await act(() => result.current('tr'));
    expect(harness.setLocale).toHaveBeenCalledWith('tr');
    expect(harness.request).toHaveBeenCalledWith(UPDATE_MY_PROFILE, {
      input: { preferredLanguage: 'tr' },
    });
    expect(harness.refreshAuth).toHaveBeenCalledTimes(1);
    expect(harness.setLocale.mock.invocationCallOrder[0]).toBeLessThan(
      harness.request.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('reports a failed save to the caller and does not reload the account', async () => {
    harness.request.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useAccountLanguage());
    await expect(result.current('en')).rejects.toThrow('offline');
    expect(harness.setLocale).toHaveBeenCalledWith('en');
    expect(harness.refreshAuth).not.toHaveBeenCalled();
  });
});

describe('useAppliedTheme', () => {
  it('reads the theme applied to <html>', () => {
    document.documentElement.dataset.theme = 'dark';
    const { result } = renderHook(() => useAppliedTheme());
    expect(result.current[0]).toBe('dark');
  });

  it('stores and applies a choice, and follows a change made elsewhere', async () => {
    document.documentElement.dataset.theme = 'dark';
    const { result } = renderHook(() => useAppliedTheme());
    // The attribute is observed: the update lands on the observer's microtask.
    await act(async () => {
      result.current[1]('light');
      await Promise.resolve();
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(result.current[0]).toBe('light');

    // The settings page applies through the same theme util.
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
      await Promise.resolve();
    });
    expect(result.current[0]).toBe('dark');
  });
});
