/**
 * SecuritySettings tests (ADR-042, ADMIN-HIGH-010).
 *
 * The hook module is mocked to control the loaded policy + capture the update
 * mutation; shared-ui is mocked for useToast + the Switch that the module's
 * Toggle wraps. Covers: MFA toggle + Save wiring, the session-timeout client
 * bound (mirrors the server's 5..1440), and the enable-MFA warning.
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

let mockPolicy: { enforceMfa: boolean; sessionTimeoutMinutes: number | null } | undefined = {
  enforceMfa: false,
  sessionTimeoutMinutes: 60,
};

vi.mock('../../../hooks/useTenantSecuritySettings', () => ({
  useTenantSecurityPolicy: () => ({
    data: mockPolicy,
    isLoading: false,
    isError: false,
  }),
  useUpdateTenantSecurityPolicy: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

vi.mock('@aquaculture/shared-ui', () => ({
  useToast: () => ({ toast: mockToast }),
  Switch: ({
    checked,
    onChange,
    'aria-label': ariaLabel,
  }: {
    checked?: boolean;
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    'aria-label'?: string;
  }) =>
    React.createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': ariaLabel,
      checked: !!checked,
      onChange,
    }),
}));

import SecuritySettings from '../SecuritySettings';

describe('SecuritySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicy = { enforceMfa: false, sessionTimeoutMinutes: 60 };
    mockMutateAsync.mockResolvedValue({ enforceMfa: true, sessionTimeoutMinutes: 60 });
  });

  it('toggles MFA and saves via the mutation with the timeout', async () => {
    render(<SecuritySettings />);

    const mfaSwitch = screen.getByRole('switch', { name: 'Require MFA for all users' });
    expect(mfaSwitch).not.toBeChecked();

    fireEvent.click(mfaSwitch);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      enforceMfa: true,
      sessionTimeoutMinutes: 60,
    });
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success' }),
      ),
    );
  });

  it('warns that users without MFA will be signed out when MFA is enabled', () => {
    render(<SecuritySettings />);

    expect(screen.queryByText(/will be required to set up MFA/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Require MFA for all users' }));
    expect(screen.getByText(/sign out any tenant users who do not yet have MFA/i)).toBeInTheDocument();
  });

  it('rejects an out-of-bound session timeout (5..1440) and blocks save', () => {
    render(<SecuritySettings />);

    const timeout = screen.getByRole('spinbutton');
    fireEvent.change(timeout, { target: { value: '2000' } });

    expect(screen.getByText(/between 5 and 1440 minutes/i)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled();

    fireEvent.click(save);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('accepts an in-bound timeout and omits it when left blank', async () => {
    render(<SecuritySettings />);

    const timeout = screen.getByRole('spinbutton');
    fireEvent.change(timeout, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    // Blank timeout ⇒ field omitted (leaves the stored value unchanged).
    expect(mockMutateAsync).toHaveBeenCalledWith({ enforceMfa: false });
  });
});
