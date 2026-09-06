import { Role } from '@aquaculture/backend-common/decorators';
import { ForbiddenException } from '@nestjs/common';
import { User } from '../entities/user.entity';
import { snapshotCredentialProof, assertCredentialProof } from './credential-state';

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
