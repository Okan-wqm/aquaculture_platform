/**
 * Who an escalated alarm pages — the directory's REAL queries on Postgres
 * (V-S1b-7, V-S1a-5).
 *
 * WHY Postgres: the recipient expansion is a set of TypeORM finds whose
 * tenant scoping, ACTIVE filter, role match and `In(...)` lists had only been
 * proven against mocked repositories, which answer whatever the test says. Here
 * the rows exist and the SQL runs: another tenant's admin, an inactive manager,
 * an expired site assignment and a manager of another site are all present,
 * and none of them may be paged.
 */
import { Role } from '@aquaculture/backend-common/decorators';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tenant } from '../../../tenant/entities/tenant.entity';
import { UserSiteAssignment } from '../../entities/user-site-assignment.entity';
import { User } from '../../entities/user.entity';
import { AlertRecipientDirectoryService } from '../alert-recipient-directory.service';

jest.setTimeout(120_000);

const TENANT = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const OTHER_TENANT = '8a7c19bc-01f3-47e4-9b22-3c4d5e6f7081';
const SITE = '11111111-1111-4111-8111-111111111111';
const OTHER_SITE = '22222222-2222-4222-8222-222222222222';
const UNMANAGED_SITE = '33333333-3333-4333-8333-333333333333';

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const INACTIVE_ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const FOREIGN_ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const SITE_MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const OTHER_SITE_MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const EXPIRED_MANAGER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';

describe('AlertRecipientDirectoryService on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let close: (() => Promise<void>) | undefined;
  let directory: AlertRecipientDirectoryService;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await harness.dataSource.query('CREATE SCHEMA IF NOT EXISTS auth');
    await harness.dataSource.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    const connection = harness.connectionOptions;
    // The service receives its repositories the production way (TypeOrmModule
    // DI); the schema comes from the entities themselves.
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: connection.host,
          port: connection.port,
          username: connection.username,
          password: connection.password,
          database: connection.database,
          entities: [User, UserSiteAssignment, Tenant],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([User, UserSiteAssignment, Tenant]),
      ],
      providers: [AlertRecipientDirectoryService],
    }).compile();
    close = () => moduleRef.close();

    const tenants = moduleRef.get<Repository<Tenant>>(getRepositoryToken(Tenant));
    for (const [id, slug] of [
      [TENANT, 'tenant-s1'],
      [OTHER_TENANT, 'tenant-other'],
    ] as const) {
      await tenants.save(tenants.create({ id, name: slug, slug }));
    }
    const users = moduleRef.get<Repository<User>>(getRepositoryToken(User));
    const user = (id: string, role: Role, tenantId: string, isActive = true): User =>
      users.create({
        id,
        email: `${id.slice(-4)}@farm.test`,
        role,
        tenantId,
        isActive,
        firstName: 'x',
        lastName: 'y',
      });
    await users.save([
      user(ADMIN, Role.TENANT_ADMIN, TENANT),
      user(INACTIVE_ADMIN, Role.TENANT_ADMIN, TENANT, false),
      user(FOREIGN_ADMIN, Role.TENANT_ADMIN, OTHER_TENANT),
      user(SITE_MANAGER, Role.MODULE_MANAGER, TENANT),
      user(OTHER_SITE_MANAGER, Role.MODULE_MANAGER, TENANT),
      user(EXPIRED_MANAGER, Role.MODULE_MANAGER, TENANT),
      user(OPERATOR, Role.MODULE_USER, TENANT),
    ]);
    const assignments = moduleRef.get<Repository<UserSiteAssignment>>(
      getRepositoryToken(UserSiteAssignment),
    );
    const assign = (userId: string, siteId: string, expiresAt: Date | null): UserSiteAssignment =>
      assignments.create({
        userId,
        siteId,
        tenantId: TENANT,
        isActive: true,
        assignedBy: ADMIN,
        expiresAt,
      });
    await assignments.save([
      assign(SITE_MANAGER, SITE, null),
      assign(OTHER_SITE_MANAGER, OTHER_SITE, null),
      assign(EXPIRED_MANAGER, SITE, new Date('2026-01-01T00:00:00.000Z')),
    ]);

    directory = moduleRef.get(AlertRecipientDirectoryService);
  });

  afterAll(async () => {
    await close?.();
    await shutdownHarness(harness);
  });

  it('pages the site manager first, then active admins of THIS tenant — nobody else', async () => {
    // SCENARIO: the default policy for an incident at SITE.
    // EXPECTS: [site manager, admin]; not the inactive admin, not the other tenant's
    //          admin, not the manager of another site, not the expired assignment.
    const result = await directory.resolve(TENANT, {
      tenantWideRoles: ['TENANT_ADMIN'],
      siteRoles: ['MODULE_MANAGER'],
      siteId: SITE,
      userIds: [],
    });

    expect(result).toEqual({ userIds: [SITE_MANAGER, ADMIN], truncated: false });
  });

  it('widens a site role with no holder at the site to the whole tenant (V-S1a-5)', async () => {
    const result = await directory.resolve(TENANT, {
      tenantWideRoles: [],
      siteRoles: ['MODULE_MANAGER'],
      siteId: UNMANAGED_SITE,
      userIds: [],
    });

    expect(result.userIds).toEqual([SITE_MANAGER, OTHER_SITE_MANAGER, EXPIRED_MANAGER].sort());
  });

  it('keeps an explicit id only when it is an active member of this tenant', async () => {
    const result = await directory.resolve(TENANT, {
      tenantWideRoles: [],
      siteRoles: [],
      siteId: null,
      userIds: [OPERATOR, INACTIVE_ADMIN, FOREIGN_ADMIN],
    });

    expect(result).toEqual({ userIds: [OPERATOR], truncated: false });
  });
});
