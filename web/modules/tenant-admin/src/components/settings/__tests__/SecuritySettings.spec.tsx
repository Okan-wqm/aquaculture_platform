/**
 * SecuritySettings tests (ADR-046, ADMIN-HIGH-010).
 *
 * The screen used to be a "not yet available" banner because nothing persisted
 * or enforced the policy. Now auth-service owns both, so these specs pin that
 * the screen renders ONLY the enforced controls, mirrors the server's 5..1440
 * bound before a round trip, warns before the disruptive MFA flip, and sends
 * exactly the fields the server semantics expect.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockMutateAsync = vi.fn();

let mockPolicy: { enforceMfa: boolean; sessionTimeoutMinutes: number | null } | undefined = {
  enforceMfa: false,
  sessionTimeoutMinutes: 60,
};
let mockIsLoading = false;
let mockIsError = false;

vi.mock('../../../hooks/useTenantSecuritySettings', () => ({
  useTenantSecurityPolicy: () => ({
    data: mockPolicy,
    isLoading: mockIsLoading,
    isError: mockIsError,
  }),
  useUpdateTenantSecurityPolicy: () => ({
    mutateAsync: mockMutateAsync,
    isPending: false,
  }),
}));

import SecuritySettings from '../SecuritySettings';

describe('SecuritySettings (ADR-046)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicy = { enforceMfa: false, sessionTimeoutMinutes: 60 };
    mockIsLoading = false;
    mockIsError = false;
    mockMutateAsync.mockResolvedValue({ enforceMfa: true, sessionTimeoutMinutes: 60 });
  });

  it('toggles MFA enforcement and saves it together with the timeout', async () => {
    render(<SecuritySettings canEdit />);

    const mfaSwitch = screen.getByRole('switch', { name: 'Require MFA for all users' });
    expect(mfaSwitch).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(mfaSwitch);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      enforceMfa: true,
      sessionTimeoutMinutes: 60,
    });
  });

  it('warns that factor-less users are signed out — but only when turning it ON', () => {
    render(<SecuritySettings canEdit />);

    expect(screen.queryByText(/signs out every tenant user/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Require MFA for all users' }));
    expect(screen.getByText(/signs out every tenant user/i)).toBeInTheDocument();
  });

  it('does not warn when enforcement was already on', () => {
    mockPolicy = { enforceMfa: true, sessionTimeoutMinutes: 60 };
    render(<SecuritySettings canEdit />);

    expect(screen.queryByText(/signs out every tenant user/i)).not.toBeInTheDocument();
  });

  it('rejects an out-of-bound session timeout (5..1440) and blocks the save', () => {
    render(<SecuritySettings canEdit />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2000' } });

    expect(screen.getByText(/between 5 and 1440 minutes/i)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: /save changes/i });
    expect(save).toBeDisabled();

    fireEvent.click(save);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('rejects a timeout below the lower bound too', () => {
    render(<SecuritySettings canEdit />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });

    expect(screen.getByText(/between 5 and 1440 minutes/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('omits the timeout entirely when left blank, so the stored value is untouched', async () => {
    render(<SecuritySettings canEdit />);

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({ enforceMfa: false });
  });

  it('surfaces a save failure instead of reporting success', async () => {
    mockMutateAsync.mockRejectedValue(new Error('Policy write refused'));
    render(<SecuritySettings canEdit />);

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // The message is routed through sanitizeErrorMessage (no raw server text
    // leaks to the UI), so assert the ANNOUNCEMENT exists and that the success
    // state was never entered.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent?.trim().length).toBeGreaterThan(0);
    expect(screen.queryByText(/saved!/i)).not.toBeInTheDocument();
  });

  it('renders no Save control for a viewer without edit rights', () => {
    render(<SecuritySettings canEdit={false} />);

    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toBeDisabled();
  });

  it('states that IP whitelisting is unavailable rather than rendering a dead control', () => {
    render(<SecuritySettings canEdit />);

    expect(screen.getByText(/IP whitelisting/i)).toBeInTheDocument();
    // Exactly two interactive policy controls: the MFA switch and the timeout.
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(1);
  });

  it('reports a load failure instead of rendering an empty, editable form', () => {
    mockIsError = true;
    mockPolicy = undefined;
    render(<SecuritySettings canEdit />);

    expect(screen.getByText(/could not load security settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
