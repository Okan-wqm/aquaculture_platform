import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { AUTH_USER_QUERY_SUBJECTS } from '@platform/event-contracts';

import { AuditModule } from '../../../../audit/audit.module';
import { AuditLog } from '../../../../audit/audit-log.entity';
import { User } from '../../../authentication/entities/user.entity';
import { AuthUserQueryNatsHandler } from '../auth-user-query-nats.handler';

/**
 * In production the DataSource token is registered globally by
 * TypeOrmModule.forRoot (TypeOrmCoreModule is @Global). The DI-resolution smoke
 * below deliberately does NOT boot a database, so it supplies the same token via
 * a @Global stub — exactly as ConfigModule.forRoot({ isGlobal: true }) supplies
 * ConfigService. AuditLogService (from the imported @Global AuditModule) injects
 * DataSource at constructor index [2] since #845 (standalone audit writes run in
 * an RLS system-context transaction); without this the smoke cannot resolve.
 */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: { transaction: jest.fn() } }],
  exports: [DataSource],
})
class StubDataSourceModule {}

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

interface UserRow {
  id: string;
  tenantId: string;
  isActive: boolean;
}

function makeHandler(rows: UserRow[]): {
  handler: AuthUserQueryNatsHandler;
  audit: { log: jest.Mock };
  find: jest.Mock;
} {
  const find = jest.fn().mockResolvedValue(rows);
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const handler = new AuthUserQueryNatsHandler(
    { find } as never,
    audit as never,
  );
  return { handler, audit, find };
}

describe('AuthUserQueryNatsHandler', () => {
  it('subject is the request.auth.* request/reply pattern', () => {
    expect(AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP).toBe(
      'request.auth.user.validateTenantMembership',
    );
  });

  it('rejects a malformed payload at the trust boundary without querying', async () => {
    const { handler, find } = makeHandler([]);
    const result = await handler.validateTenantMembership({
      tenantId: 'not-a-uuid',
      userIds: [U1],
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('VALIDATION_ERROR');
    expect(find).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the tenant — a cross-tenant userId is invalid, not leaked', async () => {
    // U2 is omitted from the result set => belongs to another tenant (or
    // does not exist); both must collapse to invalidUserIds identically.
    const { handler, find, audit } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: true },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1, U2],
    });
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT }) }),
    );
    expect(result.allValid).toBe(false);
    expect(result.validUserIds).toEqual([U1]);
    expect(result.invalidUserIds).toEqual([U2]);
    // A rejected validation is an awaited security audit.
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('requireActive=true pushes inactive members to inactiveUserIds AND forces allValid=false', async () => {
    const { handler } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: false },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1],
      requireActive: true,
    });
    expect(result.allValid).toBe(false);
    expect(result.inactiveUserIds).toEqual([U1]);
    expect(result.validUserIds).toEqual([]);
  });

  // DI-resolution smoke (FARM-/AUTH-hotfix): the unit cases above
  // construct the handler by hand and so cannot catch a wrong-token
  // injection. This compiles the handler against the REAL AuditModule
  // (@Global, provides auth-service's local AuditLogService) the way the
  // app does — a regression to the backend-common AuditLogService import
  // (the 2026-06-12 production crash-loop) fails this test at boot, not
  // in production.
  it('resolves via NestJS DI with the AuditModule-provided AuditLogService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // ConfigModule is global in the app (AppModule isGlobal:true); make
        // it global here too so AuditModule's AuditLogService resolves its
        // ConfigService dependency. The smoke focuses on the
        // handler↔AuditLogService wiring.
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StubDataSourceModule,
        AuditModule,
      ],
      controllers: [AuthUserQueryNatsHandler],
      providers: [
        // User repo is consumed by the handler directly (not via a module
        // here); AuditLog repo is consumed by AuditModule's service.
        { provide: getRepositoryToken(User), useValue: { find: jest.fn().mockResolvedValue([]) } },
      ],
    })
      .overrideProvider(getRepositoryToken(AuditLog))
      .useValue({ create: jest.fn(), save: jest.fn() })
      .compile();

    expect(moduleRef.get(AuthUserQueryNatsHandler)).toBeInstanceOf(
      AuthUserQueryNatsHandler,
    );
    await moduleRef.close();
  });

  it('requireActive=false keeps an inactive member valid', async () => {
    const { handler } = makeHandler([
      { id: U1, tenantId: TENANT, isActive: false },
    ]);
    const result = await handler.validateTenantMembership({
      tenantId: TENANT,
      userIds: [U1],
      requireActive: false,
    });
    expect(result.allValid).toBe(true);
    expect(result.validUserIds).toEqual([U1]);
    expect(result.inactiveUserIds).toEqual([]);
  });
});
