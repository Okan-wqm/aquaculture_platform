/**
 * LocalizationSettings tests (ADMIN-MEDIUM-011).
 *
 * This screen is not a display preference: farm-service's feeding jobs (day
 * plan, morning sweep, stock coverage, FCR alert, daily summary) run on the
 * tenant's LOCAL day and take that boundary from the timezone saved here.
 * A silent mis-save therefore shifts a whole tenant's feeding schedule, so
 * these specs pin the three ways this screen could lie to an operator:
 *
 *  1. a saved zone outside the shortlist must still render as the selection —
 *     otherwise the select falls back to `UTC` and the next save silently
 *     rewrites the tenant's day boundary to a zone nobody chose;
 *  2. "Not set" must reach the server as `null`, not as the empty string;
 *  3. a rejected save must surface a sanitized error instead of "Saved!" —
 *     and must not leak the raw transport message.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockMutateAsync = vi.fn();

let mockData: { timezone: string; locale: string | null } | undefined = {
  timezone: 'Europe/Oslo',
  locale: 'nb',
};
let mockIsLoading = false;

vi.mock('../../../hooks/useTenantLocalization', () => ({
  useTenantLocalization: () => ({ data: mockData, isLoading: mockIsLoading }),
  useUpdateTenantLocalization: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

import LocalizationSettings from '../LocalizationSettings';

describe('LocalizationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = { timezone: 'Europe/Oslo', locale: 'nb' };
    mockIsLoading = false;
    mockMutateAsync.mockResolvedValue({ timezone: 'Europe/Oslo', locale: 'nb' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves the timezone and locale the operator selected', async () => {
    render(<LocalizationSettings canEdit />);

    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'Europe/Istanbul' },
    });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'en-GB' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      timezone: 'Europe/Istanbul',
      locale: 'en-GB',
    });
    expect(await screen.findByText('Saved!')).toBeInTheDocument();
  });

  it('sends "Not set" as null rather than an empty locale string', async () => {
    render(<LocalizationSettings canEdit />);

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({ timezone: 'Europe/Oslo', locale: null });
  });

  it('keeps a saved zone that is outside the shortlist as the selection', async () => {
    mockData = { timezone: 'Pacific/Auckland', locale: null };

    render(<LocalizationSettings canEdit />);

    const select = screen.getByLabelText('Timezone') as HTMLSelectElement;
    expect(select.value).toBe('Pacific/Auckland');
    expect(screen.getByRole('option', { name: 'Pacific/Auckland' })).toBeInTheDocument();

    // The save must round-trip the zone the tenant already had, untouched.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        timezone: 'Pacific/Auckland',
        locale: null,
      }),
    );
  });

  it('shows a sanitized error instead of "Saved!" when the save is rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockMutateAsync.mockRejectedValue(new Error('403 Forbidden: tenant_policy_writer required'));

    render(<LocalizationSettings canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(
      await screen.findByText('You do not have permission to perform this action.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
    expect(screen.queryByText(/tenant_policy_writer/)).not.toBeInTheDocument();
  });

  it('is read-only without edit permission', () => {
    render(<LocalizationSettings />);

    expect(screen.getByLabelText('Timezone')).toBeDisabled();
    expect(screen.getByLabelText('Language')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
  });
});
