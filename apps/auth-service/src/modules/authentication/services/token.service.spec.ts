import { Role } from '@aquaculture/backend-common/decorators';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { User } from '../entities/user.entity';

import { JwtPayload, TokenService } from './token.service';

/**
 * MT-MEDIUM-001 — the `planLevel` JWT claim.
 *
 * generateTokens must stamp the tenant's plan-tier ordinal onto the access
 * token so downstream services gate by tier without a per-request lookup, and
 * must OMIT the claim for platform accounts that have no tenant.
 */
describe('TokenService — planLevel JWT claim (MT-MEDIUM-001)', () => {
  let service: TokenService;
  let signAsync: jest.Mock;
  let query: jest.Mock;

  /** Capture the payload handed to jwtService.signAsync. */
  const capturedPayload = (): JwtPayload => {
    expect(signAsync).toHaveBeenCalledTimes(1);
    return signAsync.mock.calls[0][0] as JwtPayload;
  };

  const buildUser = (overrides: Partial<User>): User =>
    Object.assign(new User(), {
      id: '11111111-1111-1111-1111-111111111111',
      role: Role.TENANT_ADMIN,
      tenantId: '22222222-2222-2222-2222-222222222222',
      ...overrides,
    });

  beforeEach(async () => {
    signAsync = jest.fn().mockResolvedValue('signed.access.token');
    // Route the two reads generateTokens performs: the tenant_modules lookup
    // (empty) and the auth.tenants plan lookup (professional → ordinal 2).
    query = jest.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM auth.tenants')) {
        return Promise.resolve([{ plan: 'professional' }]);
      }
      return Promise.resolve([]);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn((x: unknown) => x), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: DataSource, useValue: { query } },
        { provide: JwtService, useValue: { signAsync } },
        {
          provide: ConfigService,
          useValue: {
            // HASH_REFRESH_TOKENS=false skips bcrypt; every other key resolves to
            // its caller-supplied default.
            get: jest.fn((key: string, def?: unknown) =>
              key === 'HASH_REFRESH_TOKENS' ? false : def,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('includes the tenant plan ordinal as planLevel', async () => {
    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(2); // professional → PLAN_LEVEL 2
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM auth.tenants'),
      ['22222222-2222-2222-2222-222222222222'],
    );
  });

  it('omits planLevel for a platform account with no tenant', async () => {
    await service.generateTokens(
      buildUser({ role: Role.SUPER_ADMIN, tenantId: null }),
    );

    const payload = capturedPayload();
    expect('planLevel' in payload).toBe(false);
    // No tenant → the auth.tenants plan lookup must never run.
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM auth.tenants'),
      expect.anything(),
    );
  });

  it('falls back to 0 for an unrecognised plan string', async () => {
    query.mockImplementation((sql: string) =>
      typeof sql === 'string' && sql.includes('FROM auth.tenants')
        ? Promise.resolve([{ plan: 'legacy-unknown' }])
        : Promise.resolve([]),
    );

    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(0);
  });
});
