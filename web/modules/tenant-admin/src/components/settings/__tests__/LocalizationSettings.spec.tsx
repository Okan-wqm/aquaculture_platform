/**
 * LocalizationSettings tests (ADR-045, ADMIN-MEDIUM-010).
 *
 * The hook module is mocked to control the loaded preferences + capture the
 * update mutation. Covers: timezone + date-format save wiring (wire enum
 * names), and the English-only decision (no language selector).
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

const mockMutateAsync = vi.fn();
const mockToast = vi.fn();

let mockPrefs: { timezone: string | null; dateFormat: string | null } | undefined = {
  timezone: 'UTC',
  dateFormat: 'YYYY_MM_DD',
};

vi.mock('../../../hooks/useTenantSecuritySettings', () => ({
  useTenantLocalizationPreferences: () => ({
    data: mockPrefs,
    isLoading: false,
    isError: false,
  }),
  useUpdateTenantLocalizationPreferences: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock('@aquaculture/shared-ui', () => ({
  useToast: () => ({ toast: mockToast }),
}));

import LocalizationSettings from '../LocalizationSettings';

describe('LocalizationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrefs = { timezone: 'UTC', dateFormat: 'YYYY_MM_DD' };
    mockMutateAsync.mockResolvedValue({ timezone: 'Europe/Istanbul', dateFormat: 'DD_MM_YYYY' });
  });

  it('saves the selected timezone and date format (wire enum names)', async () => {
    render(<LocalizationSettings />);

    fireEvent.change(screen.getByLabelText('Timezone'), {
      target: { value: 'Europe/Istanbul' },
    });
    fireEvent.change(screen.getByLabelText('Date format'), {
      target: { value: 'DD_MM_YYYY' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      timezone: 'Europe/Istanbul',
      dateFormat: 'DD_MM_YYYY',
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success' }),
      ),
    );
  });

  it('renders no language selector (English-only decision)', () => {
    render(<LocalizationSettings />);

    expect(screen.getByLabelText('Timezone')).toBeInTheDocument();
    expect(screen.getByLabelText('Date format')).toBeInTheDocument();
    expect(screen.queryByLabelText(/language/i)).not.toBeInTheDocument();
  });
});
