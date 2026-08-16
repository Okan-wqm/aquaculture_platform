import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminLegalHoldReleaseOperationV1,
  AdminLegalHoldV1,
} from '@platform/admin-http-contracts';

import { messagingApi } from '../../../services/api/messaging';
import MessagingCompliancePage from '../MessagingCompliancePage';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const HOLD_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const INITIATOR_ID = '44444444-4444-4444-8444-444444444444';
const APPROVER_ID = '55555555-5555-4555-8555-555555555555';

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');

  return {
    ...actual,
    useAuthContext: () => ({ user: { id: APPROVER_ID } }),
  };
});

vi.mock('../../../services/api/messaging', () => ({
  messagingApi: {
    getComplianceStats: vi.fn(),
    getLegalHolds: vi.fn(),
    getLegalHoldReleaseOperations: vi.fn(),
    createLegalHoldReleaseOperation: vi.fn(),
    authorizeLegalHoldReleaseOperation: vi.fn(),
  },
}));

const ACTIVE_HOLD: AdminLegalHoldV1 = {
  id: HOLD_ID,
  tenantId: TENANT_ID,
  channelId: null,
  legalMatterId: 'MATTER-2026-001',
  legalMatterDescription: 'Regulatory preservation order',
  reason: 'Preserve all tenant messaging records for the active investigation.',
  requestedBy: 'compliance@example.test',
  startedBy: INITIATOR_ID,
  startedAt: '2026-08-15T10:00:00.000Z',
  releasedBy: null,
  releasedByApprover: null,
  releaseReason: null,
  releasedAt: null,
  expiresAt: null,
  isActive: true,
};

const PENDING_OPERATION: AdminLegalHoldReleaseOperationV1 = {
  id: OPERATION_ID,
  tenantId: TENANT_ID,
  holdId: HOLD_ID,
  status: 'PENDING',
  releaseReason: 'The preservation order has closed and counsel approved documented release.',
  initiationRequestId: '66666666-6666-4666-8666-666666666666',
  initiatedBy: INITIATOR_ID,
  initiatedAt: '2099-08-15T10:00:00.000Z',
  initiatorMfaVerifiedAt: '2099-08-15T10:00:00.000Z',
  expiresAt: '2099-08-15T10:15:00.000Z',
  authorizationRequestId: null,
  authorizedBy: null,
  authorizedAt: null,
  approverMfaVerifiedAt: null,
  releasedAt: null,
  expiredAt: null,
  expiredBy: null,
};

describe('MessagingCompliancePage legal-hold release authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    window.dispatchEvent(new Event('aquaculture:logout'));
    window.history.replaceState(null, '', `/?tenantId=${TENANT_ID}`);

    vi.mocked(messagingApi.getComplianceStats).mockResolvedValue({
      activeHoldsCount: 1,
      retentionPoliciesCount: 1,
      auditLogEntriesCount: 2,
    });
    vi.mocked(messagingApi.getLegalHolds).mockResolvedValue([ACTIVE_HOLD]);
    vi.mocked(messagingApi.getLegalHoldReleaseOperations).mockResolvedValue([]);
  });

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('sends only tenant scope and idempotency key when a distinct admin countersigns', async () => {
    const user = userEvent.setup();
    vi.mocked(messagingApi.getLegalHoldReleaseOperations).mockResolvedValue([PENDING_OPERATION]);
    vi.mocked(messagingApi.authorizeLegalHoldReleaseOperation).mockResolvedValue({
      ...PENDING_OPERATION,
      status: 'RELEASED',
      authorizationRequestId: '77777777-7777-4777-8777-777777777777',
      authorizedBy: APPROVER_ID,
      authorizedAt: '2099-08-15T10:05:00.000Z',
      approverMfaVerifiedAt: '2099-08-15T10:05:00.000Z',
      releasedAt: '2099-08-15T10:05:00.000Z',
    });

    render(<MessagingCompliancePage />);

    const authorizeButton = await screen.findByRole('button', {
      name: 'Authorize release',
    });
    await user.click(authorizeButton);

    await waitFor(() => {
      expect(messagingApi.authorizeLegalHoldReleaseOperation).toHaveBeenCalledTimes(1);
    });

    const [, command] = vi.mocked(messagingApi.authorizeLegalHoldReleaseOperation).mock.calls[0];
    expect(command).toEqual({
      tenantId: TENANT_ID,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
  });

  it('creates a pending operation without accepting browser-supplied actor identity', async () => {
    const user = userEvent.setup();
    const releaseReason =
      'Counsel confirmed the matter is closed and approved release of preserved records.';
    vi.mocked(messagingApi.createLegalHoldReleaseOperation).mockResolvedValue({
      ...PENDING_OPERATION,
      initiatedBy: APPROVER_ID,
    });

    render(<MessagingCompliancePage />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Request release',
      }),
    );

    const createButton = screen.getByRole('button', { name: 'Create request' });
    expect(createButton).toBeDisabled();
    await user.type(screen.getByLabelText('Release justification'), releaseReason);
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await waitFor(() => {
      expect(messagingApi.createLegalHoldReleaseOperation).toHaveBeenCalledTimes(1);
    });

    const [, command] = vi.mocked(messagingApi.createLegalHoldReleaseOperation).mock.calls[0];
    expect(command).toEqual({
      tenantId: TENANT_ID,
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
      releaseReason,
    });
  });
});
