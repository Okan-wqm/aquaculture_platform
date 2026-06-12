import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { of, throwError } from 'rxjs';

import { TenantUserAdmissionService } from '../tenant-user-admission.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U1 = '11111111-1111-4111-8111-111111111111';

function makeService(send: jest.Mock): TenantUserAdmissionService {
  return new TenantUserAdmissionService({ send } as never);
}

describe('TenantUserAdmissionService', () => {
  it('returns the de-duplicated ids when auth says all are active members', async () => {
    const send = jest.fn().mockReturnValue(
      of({
        success: true,
        allValid: true,
        validUserIds: [U1],
        invalidUserIds: [],
        inactiveUserIds: [],
      }),
    );
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, [U1, U1]),
    ).resolves.toEqual([U1]);
  });

  it('rejects (ForbiddenException) when auth reports a non-member', async () => {
    const send = jest.fn().mockReturnValue(
      of({
        success: true,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [U1],
        inactiveUserIds: [],
      }),
    );
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, [U1]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('FAILS CLOSED (ServiceUnavailable) when the auth round-trip errors', async () => {
    const send = jest.fn().mockReturnValue(throwError(() => new Error('nats down')));
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, [U1]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('FAILS CLOSED when auth returns success:false', async () => {
    const send = jest.fn().mockReturnValue(
      of({
        success: false,
        allValid: false,
        validUserIds: [],
        invalidUserIds: [],
        inactiveUserIds: [],
        errorCode: 'INTERNAL_ERROR',
      }),
    );
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, [U1]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects a malformed userId locally before spending a round-trip', async () => {
    const send = jest.fn();
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, ['not-a-uuid']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(send).not.toHaveBeenCalled();
  });

  it('no-ops on an empty id list (no round-trip)', async () => {
    const send = jest.fn();
    await expect(
      makeService(send).assertActiveTenantUsers(TENANT, []),
    ).resolves.toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
