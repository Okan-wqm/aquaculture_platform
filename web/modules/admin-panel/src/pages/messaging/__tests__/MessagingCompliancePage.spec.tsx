import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MessagingCompliancePage from '../MessagingCompliancePage';
import { messagingApi } from '../../../services/api/messaging';
import { usersApi } from '../../../services/api/users';
import { clearAsyncCache } from '../../../hooks/useAsyncData';

const { CURRENT_USER_ID } = vi.hoisted(() => ({
  CURRENT_USER_ID: '44444444-4444-4444-8444-444444444444',
}));
const APPROVER_ID = '33333333-3333-4333-8333-333333333333';
const HOLD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const VALID_REASON =
  'Matter 2026-0042 concluded; retention obligation lifted per outside counsel written sign-off.';

// Lightweight shared-ui stubs. useAuthContext supplies the current SUPER_ADMIN
// so the dialog can exclude self from the approver list (dual-approver rule).
vi.mock('@aquaculture/shared-ui', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useAuthContext: () => ({ user: { id: CURRENT_USER_ID, email: 'me@platform.test', role: 'SUPER_ADMIN' } }),
}));

vi.mock('../../../services/api/messaging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api/messaging')>();
  return {
    ...actual,
    messagingApi: {
      getComplianceStats: vi.fn(),
      getLegalHolds: vi.fn(),
      releaseLegalHold: vi.fn(),
    },
  };
});

vi.mock('../../../services/api/users', () => ({
  usersApi: { list: vi.fn() },
}));

const FULL_STATS = {
  messagesUnderLegalHold: 0,
  pendingRetentionCleanup: 0,
  activeExports: 0,
  complianceScore: 100,
  activeHoldsCount: 1,
  retentionPoliciesCount: 0,
  auditEntriesCount: 0,
};

const ACTIVE_HOLD = {
  id: HOLD_ID,
  tenantId: TENANT_ID,
  tenantName: 'Acme Farms',
  channelId: null,
  channelName: null,
  reason: 'Litigation hold for matter 2026-0042',
  startedBy: 'someone',
  startedAt: '2026-07-01T00:00:00.000Z',
  releasedBy: null,
  releasedAt: null,
  isActive: true,
};

describe('MessagingCompliancePage — legal-hold release dialog (APA-163)', () => {
  beforeEach(() => {
    clearAsyncCache();
    vi.clearAllMocks();
    vi.mocked(messagingApi.getComplianceStats).mockResolvedValue(FULL_STATS);
    vi.mocked(messagingApi.getLegalHolds).mockResolvedValue([ACTIVE_HOLD]);
    vi.mocked(messagingApi.releaseLegalHold).mockResolvedValue(undefined);
    vi.mocked(usersApi.list).mockResolvedValue({
      data: [
        { id: APPROVER_ID, email: 'approver@platform.test', firstName: 'Ada', lastName: 'Approver', role: 'SUPER_ADMIN', tenantId: null, tenantName: null, isActive: true, lastLoginAt: null, createdAt: '', updatedAt: '' },
        { id: CURRENT_USER_ID, email: 'me@platform.test', firstName: 'Me', lastName: 'Self', role: 'SUPER_ADMIN', tenantId: null, tenantName: null, isActive: true, lastLoginAt: null, createdAt: '', updatedAt: '' },
        { id: 'inactive', email: 'ghost@platform.test', firstName: 'In', lastName: 'Active', role: 'SUPER_ADMIN', tenantId: null, tenantName: null, isActive: false, lastLoginAt: null, createdAt: '', updatedAt: '' },
      ],
      total: 3,
      page: 1,
      limit: 100,
      totalPages: 1,
    } as never);
  });

  it('opens the dialog and gates submit on approver + a ≥50-char reason, then releases with the full payload', async () => {
    const user = userEvent.setup();
    render(<MessagingCompliancePage />);

    // The active hold row renders a Release trigger.
    const releaseTrigger = await screen.findByRole('button', { name: 'Release' });
    await user.click(releaseTrigger);

    // Dialog is open.
    const dialogHeading = await screen.findByRole('heading', { name: 'Release Legal Hold' });
    expect(dialogHeading).toBeInTheDocument();

    const submit = screen.getByRole('button', { name: 'Release hold' });
    expect(submit).toBeDisabled();

    // Approver options exclude self and inactive users; only Ada Approver remains.
    const approverSelect = await screen.findByLabelText(/Countersigning approver/i);
    await waitFor(() =>
      expect(within(approverSelect).getByRole('option', { name: /Ada Approver/ })).toBeInTheDocument(),
    );
    expect(within(approverSelect).queryByRole('option', { name: /Me Self/ })).toBeNull();
    expect(within(approverSelect).queryByRole('option', { name: /In Active/ })).toBeNull();

    await user.selectOptions(approverSelect, APPROVER_ID);

    // A sub-threshold reason keeps submit disabled.
    const reason = screen.getByLabelText('Justification');
    await user.type(reason, 'too short');
    expect(submit).toBeDisabled();

    // A valid reason enables submit.
    await user.clear(reason);
    await user.type(reason, VALID_REASON);
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(submit);

    expect(messagingApi.releaseLegalHold).toHaveBeenCalledWith(HOLD_ID, TENANT_ID, {
      approverId: APPROVER_ID,
      releaseReason: VALID_REASON,
    });

    // The dialog closes on a successful release.
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Release Legal Hold' }),
      ).toBeNull(),
    );
  });
});
