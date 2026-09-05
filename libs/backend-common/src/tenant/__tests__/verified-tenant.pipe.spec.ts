import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { TenantStatus } from '@platform/event-contracts';

import {
  VerifiedTenantPipe,
  isTenantParamRequest,
  type TenantParamRequest,
} from '../verified-tenant.pipe';

/**
 * ADMIN-CRITICAL-009 — the one resolution point from a client-supplied
 * tenant id to a verified tenant identity.
 */
describe('VerifiedTenantPipe', () => {
  const ACTIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SUSPENDED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  const lookupTenant = jest.fn((id: string) =>
    Promise.resolve(
      id === ACTIVE
        ? { status: TenantStatus.ACTIVE }
        : id === SUSPENDED
          ? { status: TenantStatus.SUSPENDED }
          : null,
    ),
  );
  const pipe = new VerifiedTenantPipe({ lookupTenant });

  const request = (overrides: Partial<TenantParamRequest>): TenantParamRequest => ({
    raw: ACTIVE,
    source: 'param',
    key: 'tenantId',
    optional: false,
    allow: undefined,
    method: 'POST',
    ...overrides,
  });

  beforeEach(() => lookupTenant.mockClear());

  it('returns the id of an existing ACTIVE tenant for a mutation', async () => {
    await expect(pipe.transform(request({}))).resolves.toBe(ACTIVE);
    expect(lookupTenant).toHaveBeenCalledWith(ACTIVE);
  });

  it('refuses a missing value unless the route said optional (then undefined, no lookup)', async () => {
    await expect(pipe.transform(request({ raw: undefined }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform(request({ raw: '' }))).rejects.toThrow(/tenantId is required/);
    await expect(
      pipe.transform(request({ raw: undefined, optional: true })),
    ).resolves.toBeUndefined();
    expect(lookupTenant).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a UUID before touching the lookup', async () => {
    await expect(pipe.transform(request({ raw: 'tenant-1' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(pipe.transform(request({ raw: 42 }))).rejects.toThrow(/must be a tenant UUID/);
    await expect(pipe.transform(request({ raw: { id: ACTIVE } }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(lookupTenant).not.toHaveBeenCalled();
  });

  it('refuses an unknown tenant with 404', async () => {
    await expect(pipe.transform(request({ raw: UNKNOWN }))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a mutation admits ACTIVE only by default; a read admits every existing tenant', async () => {
    await expect(pipe.transform(request({ raw: SUSPENDED }))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(pipe.transform(request({ raw: SUSPENDED }))).rejects.toThrow(
      /is SUSPENDED; this operation requires ACTIVE/,
    );
    await expect(pipe.transform(request({ raw: SUSPENDED, method: 'GET' }))).resolves.toBe(
      SUSPENDED,
    );
    await expect(pipe.transform(request({ raw: SUSPENDED, method: 'head' }))).resolves.toBe(
      SUSPENDED,
    );
  });

  it("a route's own tolerance overrides the method default", async () => {
    await expect(pipe.transform(request({ raw: SUSPENDED, allow: 'any' }))).resolves.toBe(
      SUSPENDED,
    );
    await expect(
      pipe.transform(
        request({ raw: SUSPENDED, allow: [TenantStatus.SUSPENDED, TenantStatus.DEACTIVATED] }),
      ),
    ).resolves.toBe(SUSPENDED);
    await expect(
      pipe.transform(request({ raw: ACTIVE, method: 'GET', allow: [TenantStatus.SUSPENDED] })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('only a @TenantParam envelope is a request: a bare id is refused by the guard', () => {
    expect(isTenantParamRequest(ACTIVE)).toBe(false);
    expect(isTenantParamRequest({ raw: ACTIVE })).toBe(false);
    expect(isTenantParamRequest(request({}))).toBe(true);
  });
});
