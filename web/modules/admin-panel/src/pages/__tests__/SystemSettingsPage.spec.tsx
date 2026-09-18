/**
 * SystemSettingsPage's last two unmigrated call sites (ADMIN-HIGH-121).
 *
 * The settings half of this page already went through the data layer
 * (`usePlatformSettings` / `useSavePlatformSettings`, the GraphQL platform
 * configuration operations). Two call sites did not, and they were enough to
 * keep the second cache alive:
 *
 *   - the System tab's `/settings/system/info` read sat in `useAsyncData`
 *     under `cacheKey: 'system-info'` with its own 30s TTL — a cache no write
 *     invalidates and, before W8a, nothing cleared at logout;
 *   - the SMTP test send called `settingsApi.testEmailConfig` directly.
 *
 * Both are through the primitives now, and the read only fires on the tab that
 * shows it.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import type { UseMutationResult } from '@tanstack/react-query';

import SystemSettingsPage from '../SystemSettingsPage';
import { settingsApi } from '../../services/adminApi';
import { usePlatformSettings, useSavePlatformSettings } from '../../hooks/usePlatformConfiguration';
import type { PlatformConfigurationWrite } from '../../services/api/platform-configuration';

vi.mock('../../services/adminApi', () => ({
  settingsApi: {
    getSystemInfo: vi.fn(),
    testEmailConfig: vi.fn(),
  },
}));

vi.mock('../../hooks/usePlatformConfiguration', () => ({
  usePlatformSettings: vi.fn(),
  useSavePlatformSettings: vi.fn(),
  buildGeneralWrites: vi.fn(() => []),
  buildEmailWrites: vi.fn(() => []),
  buildSecurityWrites: vi.fn(() => []),
  buildBillingWrites: vi.fn(() => []),
  buildRateLimitWrites: vi.fn(() => []),
  DEFAULT_PLATFORM_SETTINGS: {
    general: { maintenanceMode: false },
    email: { fromAddress: 'platform@example.com', smtpPassword: '' },
    security: {},
    billing: { stripeSecretKey: '' },
    rateLimits: {},
  },
}));

const systemInfoMock = vi.mocked(settingsApi.getSystemInfo);
const testEmailMock = vi.mocked(settingsApi.testEmailConfig);
const settingsMock = vi.mocked(usePlatformSettings);
const saveMock = vi.mocked(useSavePlatformSettings);

/**
 * A complete, idle `UseMutationResult` — every field the type declares, none
 * of them cast.
 *
 * `as unknown as UseMutationResult<…>` would have been shorter and is banned
 * for a reason the gate states plainly: a cast type-checks nothing, so the
 * double drifts from the shape it stands in for and the suite goes green for
 * the wrong reason.
 */
function idleMutation(): UseMutationResult<void, Error, PlatformConfigurationWrite[]> {
  return {
    data: undefined,
    error: null,
    variables: undefined,
    isError: false,
    isIdle: true,
    isPending: false,
    isSuccess: false,
    isPaused: false,
    status: 'idle',
    failureCount: 0,
    failureReason: null,
    submittedAt: 0,
    context: undefined,
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SystemSettingsPage />
    </QueryClientProvider>,
  );
}

describe('SystemSettingsPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    systemInfoMock.mockResolvedValue({ platform: { version: '2.0.0' } });
    testEmailMock.mockResolvedValue({ success: true });
    settingsMock.mockReturnValue({
      settings: undefined,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    saveMock.mockReturnValue(idleMutation());
  });

  it('does not read system info until the System tab is open', async () => {
    renderPage();

    // `useAsyncData`'s `immediate: activeTab === 'system'` did the same thing;
    // the query's `enabled` keeps it, and puts the result in the shell cache.
    await waitFor(() => expect(settingsMock).toHaveBeenCalled());
    expect(systemInfoMock).not.toHaveBeenCalled();
  });

  it('reads system info with an abort signal once the tab is opened', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /System/i }));

    await waitFor(() => expect(systemInfoMock).toHaveBeenCalled());
    expect(systemInfoMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('treats an SMTP response of success:false as a failure, not a send', async () => {
    const user = userEvent.setup();
    testEmailMock.mockResolvedValue({ success: false, error: 'relay refused the message' });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Email/i }));
    await user.click(await screen.findByRole('button', { name: /Test/i }));

    // A refused relay answers 200 with success:false; the page must not
    // announce that a test email was sent.
    expect(await screen.findByText(/relay refused the message/)).toBeInTheDocument();
    expect(screen.queryByText('SMTP test email sent')).not.toBeInTheDocument();
  });
});
