import {
  AdminHttpContractError,
  createStandardPaginatedResult,
} from '@platform/admin-http-contracts';
import { describe, expect, it } from 'vitest';

import {
  beginAdminRead,
  rejectAdminRead,
  settleAdminRead,
  verifyAdminRead,
} from '../admin-read-evidence';
import { AdminApiError } from '../http-client';

describe('admin read evidence state', () => {
  it('represents a contract-verified empty page as verified data', () => {
    const pending = beginAdminRead('GET /impersonation/sessions', {
      page: 1,
      limit: 20,
      status: 'active',
    });
    const page = createStandardPaginatedResult([], 0, 1, 20);

    const state = verifyAdminRead(pending, page);

    expect(state).toEqual(
      expect.objectContaining({
        outcome: 'VERIFIED',
        value: page,
        evidence: expect.objectContaining({
          authority: 'GET /impersonation/sessions',
          contractValidated: true,
          outcome: 'VERIFIED',
        }),
      }),
    );
  });

  it('preserves HTTP rejection identity without inventing an empty value', () => {
    const pending = beginAdminRead('GET /impersonation/sessions', {
      page: 3,
      limit: 20,
      search: 'Ocean',
    });

    const state = rejectAdminRead(
      pending,
      new AdminApiError(
        'Session authority unavailable',
        503,
        'SERVICE_UNAVAILABLE',
        undefined,
        'request_12345678',
      ),
    );

    expect(state).toEqual({
      outcome: 'REJECTED',
      evidence: {
        schemaVersion: 'admin-read-evidence.v1',
        authority: 'GET /impersonation/sessions',
        coordinates: { page: 3, limit: 20, search: 'Ocean' },
        outcome: 'REJECTED',
        contractValidated: false,
        failure: {
          kind: 'HTTP_REJECTION',
          message: 'Session authority unavailable',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          requestId: 'request_12345678',
        },
      },
    });
    expect(state).not.toHaveProperty('value');
  });

  it('distinguishes a contract rejection from transport rejection', () => {
    const pending = beginAdminRead('GET /impersonation/sessions', { page: 1, limit: 20 });

    const state = rejectAdminRead(
      pending,
      new AdminHttpContractError('$.meta.pagination', 'metadata is non-canonical'),
    );

    expect(state.evidence.failure).toEqual({
      kind: 'CONTRACT_REJECTION',
      message: '$.meta.pagination: metadata is non-canonical',
    });
  });

  it('settles rejected promises into the same typed rejection state', () => {
    const pending = beginAdminRead('GET /impersonation/stats', {});

    const state = settleAdminRead(pending, {
      status: 'rejected',
      reason: new Error('connection reset'),
    });

    expect(state).toEqual(
      expect.objectContaining({
        outcome: 'REJECTED',
        evidence: expect.objectContaining({
          contractValidated: false,
          failure: {
            kind: 'TRANSPORT_REJECTION',
            message: 'connection reset',
          },
        }),
      }),
    );
    expect(state).not.toHaveProperty('value');
  });
});
