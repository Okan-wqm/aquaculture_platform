import { Role } from '@aquaculture/backend-common/decorators';
import { ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getRequestContext, requestContextStorage } from '@aquaculture/backend-common/logging';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { User } from '../entities/user.entity';
import { snapshotCredentialProof, assertCredentialProof, withLockedCredentialPrincipal } from './credential-state';

describe('credential proof', () => {
  function principal(): User {
    return Object.assign(new User(), { id: 'principal', role: Role.SUPER_ADMIN,
      tenantId: null, isActive: true, credentialVersion: 4 });
  }
  it('retains the authenticated version independently of mutable entity bookkeeping', () => {
    const user = principal();
    const proof = snapshotCredentialProof(user);
    user.updatedAt = new Date();
    expect(() => assertCredentialProof(proof, user)).not.toThrow();
    user.credentialVersion += 1;
    expect(proof.credentialVersion).toBe(4);
    expect(() => assertCredentialProof(proof, user)).toThrow(ForbiddenException);
    expect(Object.isFrozen(proof)).toBe(true);
  });
  it.each([undefined, 0, -1, 1.5, Number.NaN])('rejects absent or invalid version %s', (version) => {
    const user = principal();
    Object.assign(user, { credentialVersion: version });
    expect(() => snapshotCredentialProof(user)).toThrow(ForbiddenException);
  });
  it('rejects a principal moved to another tenant even with equal versions', () => {
    const user = principal();
    const proof = snapshotCredentialProof(user);
    user.tenantId = 'different';
    expect(() => assertCredentialProof(proof, user)).toThrow(ForbiddenException);
  });
});


describe('proof-owned pre-auth RLS context', () => {
  it.each([Role.TENANT_ADMIN, Role.SUPER_ADMIN])('binds %s scope before transaction checkout and restores the caller frame', async (role) => {
    const source = new DataSource({ type: 'postgres' });
    const runner = source.createQueryRunner();
    const user = Object.assign(new User(), { id: 'principal', role,
      tenantId: role === Role.SUPER_ADMIN ? null : 'tenant', isActive: true, credentialVersion: 1 });
    jest.spyOn(source, 'createQueryRunner').mockReturnValue(runner);
    jest.spyOn(runner, 'connect').mockImplementation(async () => {
      expect(getRequestContext()).toMatchObject({ userId: user.id,
        tenantId: user.tenantId ?? undefined, bypassRls: role === Role.SUPER_ADMIN });
    });
    jest.spyOn(runner, 'startTransaction').mockImplementation(async () => {
      await runner.connect();
      jest.replaceProperty(runner, 'isTransactionActive', true);
    });
    jest.spyOn(runner, 'commitTransaction').mockImplementation(async () => { jest.replaceProperty(runner, 'isTransactionActive', false); });
    jest.spyOn(runner, 'rollbackTransaction').mockResolvedValue(undefined);
    jest.spyOn(runner, 'release').mockResolvedValue(undefined);
    jest.spyOn(runner.manager, 'findOne').mockImplementation(async (entity) => entity === User ? user
      : Object.assign(new Tenant(), { id: user.tenantId, status: TenantStatus.ACTIVE }));
    await requestContextStorage.run({ tenantId: 'caller', bypassRls: true }, async () => {
      await withLockedCredentialPrincipal(source, snapshotCredentialProof(user), async (context) => {
        context.assertSessionAdmission();
      });
      expect(getRequestContext()).toEqual({ tenantId: 'caller', bypassRls: true });
    });
    expect(runner.connect).toHaveBeenCalled();
  });
});
