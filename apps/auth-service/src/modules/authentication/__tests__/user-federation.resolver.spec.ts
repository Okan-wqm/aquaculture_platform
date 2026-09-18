import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../entities/user.entity';
import { PublicUserProfileFederationResolver } from '../resolvers/user-federation.resolver';

describe('PublicUserProfileFederationResolver (SEC-MEDIUM-097 — 2026-08-23 scan №42)', () => {
  let resolver: PublicUserProfileFederationResolver;
  let userRepo: jest.Mocked<Repository<User>>;

  const tenantA = '11111111-1111-1111-1111-111111111111';
  const profileRow = (): User => {
    const user = new User();
    user.id = 'user-uuid-1';
    user.firstName = 'Ada';
    user.lastName = 'Lovelace';
    user.profileImageUrl = null;
    return user;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicUserProfileFederationResolver,
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn() },
        },
      ],
    }).compile();
    resolver = module.get(PublicUserProfileFederationResolver);
    userRepo = module.get(getRepositoryToken(User));
  });

  it('scopes the root query to the calling tenant', async () => {
    userRepo.findOne.mockResolvedValue(profileRow());

    await resolver.publicUserProfile('user-uuid-1', tenantA, ['MODULE_USER']);

    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-uuid-1', tenantId: tenantA } }),
    );
  });

  it('returns null for a foreign-tenant id (no cross-tenant display read)', async () => {
    userRepo.findOne.mockResolvedValue(null);

    const result = await resolver.publicUserProfile('other-tenant-user', tenantA, ['MODULE_USER']);

    expect(result).toBeNull();
    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'other-tenant-user', tenantId: tenantA } }),
    );
  });

  it('resolves platform-wide for SUPER_ADMIN', async () => {
    userRepo.findOne.mockResolvedValue(profileRow());

    await resolver.publicUserProfile('user-uuid-1', null, ['SUPER_ADMIN']);

    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-uuid-1' } }),
    );
  });

  it('fails closed for a tenantless non-admin (root query and federation path)', async () => {
    expect(await resolver.publicUserProfile('user-uuid-1', null, ['MODULE_USER'])).toBeNull();
    expect(
      await resolver.resolveReference(
        { __typename: 'PublicUserProfile', id: 'user-uuid-1' },
        { req: { user: { tenantId: null, roles: ['MODULE_USER'] } } },
      ),
    ).toBeNull();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('federation reference scopes by the context user tenant', async () => {
    userRepo.findOne.mockResolvedValue(profileRow());

    await resolver.resolveReference(
      { __typename: 'PublicUserProfile', id: 'user-uuid-1' },
      { req: { user: { tenantId: tenantA, roles: ['TENANT_ADMIN'] } } },
    );

    expect(userRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-uuid-1', tenantId: tenantA } }),
    );
  });

  it('never selects email/role/tenantId in the projection', async () => {
    userRepo.findOne.mockResolvedValue(profileRow());

    await resolver.publicUserProfile('user-uuid-1', tenantA, ['MODULE_USER']);

    const call = userRepo.findOne.mock.calls[0]?.[0];
    expect(call?.select).toEqual({
      id: true,
      firstName: true,
      lastName: true,
      profileImageUrl: true,
    });
  });
});
