import { createHash } from 'node:crypto';

import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import {
  DEFAULT_IMPERSONATION_PERMISSIONS,
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  impersonationAuthorizationOperationSetDigestV1,
  impersonationAuthorizationRequestDigestV1,
} from '@aquaculture/shared-contracts';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  DataSource,
  Repository,
  type EntityTarget,
  type ObjectLiteral,
  type QueryRunner,
} from 'typeorm';

import { AuditLog } from '../../audit/audit.entity';
import { AuditLogService } from '../../audit/audit.service';
import {
  ImpersonationPermission,
  ImpersonationAuthorizationOperationReceipt,
  ImpersonationAuthorizationReceipt,
  ImpersonationReason,
  ImpersonationSession,
  ImpersonationStatus,
} from '../../impersonation/entities/impersonation-session.entity';
import {
  ImpersonationService,
  type AuthorizeImpersonationOperationsRequest,
  type StartImpersonationRequest,
} from '../../impersonation/services/impersonation.service';
import { RetireImpersonationDeadSecretAndConstrainCredential1808600000000 } from '../1808600000000-RetireImpersonationDeadSecretAndConstrainCredential';
import { CreateImpersonationAuthorizationReceipts1808700000000 } from '../1808700000000-CreateImpersonationAuthorizationReceipts';
import { EstablishAdminAuditTrustClasses1808750000000 } from '../1808750000000-EstablishAdminAuditTrustClasses';
import { ConsolidateTenantActivityAuthority1808800000000 } from '../1808800000000-ConsolidateTenantActivityAuthority';
import { ConsolidateAdminActivityAuthority1808900000000 } from '../1808900000000-ConsolidateAdminActivityAuthority';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_TENANT_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';
const CLIENT_IP = '198.51.100.44';
const CLIENT_USER_AGENT = 'impersonation-authority-integration-test/1.0';
const RAW_TOKEN = 'a'.repeat(64);
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');
const AUTHORIZATION_RECEIPT_ID = '77777777-7777-4777-8777-777777777777';

async function installBaseline(queryRunner: QueryRunner): Promise<void> {
  await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await queryRunner.query('DROP SCHEMA IF EXISTS "admin" CASCADE');
  await queryRunner.query('CREATE SCHEMA "admin"');
  await queryRunner.query(`
    CREATE TYPE "admin"."audit_logs_severity_enum"
      AS ENUM ('info', 'warning', 'critical')
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."audit_logs" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "action" character varying(100) NOT NULL,
      "entityType" character varying(50) NOT NULL,
      "entityId" uuid,
      "tenantId" uuid,
      "performedBy" character varying(100) NOT NULL,
      "performedByEmail" character varying(100),
      "ipAddress" inet,
      "userAgent" character varying(500),
      "details" jsonb,
      "previousValue" jsonb,
      "newValue" jsonb,
      "severity" "admin"."audit_logs_severity_enum" NOT NULL DEFAULT 'info',
      "requestId" character varying(100),
      "sessionId" character varying(100),
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "legalHold" boolean NOT NULL DEFAULT false,
      CONSTRAINT "PK_test_admin_audit_logs" PRIMARY KEY ("id")
    )
  `);
  await queryRunner.query(`
    CREATE FUNCTION "admin".audit_logs_prevent_update()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'admin.audit_logs rows are immutable - UPDATE is not permitted';
    END
    $function$
  `);
  await queryRunner.query(`
    CREATE TRIGGER trg_audit_logs_prevent_update
    BEFORE UPDATE ON "admin"."audit_logs"
    FOR EACH ROW
    EXECUTE FUNCTION "admin".audit_logs_prevent_update()
  `);
  await queryRunner.query(`
    CREATE TYPE "admin"."tenant_activities_activitytype_enum" AS ENUM ('created')
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."tenant_activities" (
      "id" uuid PRIMARY KEY,
      "tenantId" uuid NOT NULL,
      "performedBy" varchar(100),
      "performedByEmail" varchar(100),
      "activityType" "admin"."tenant_activities_activitytype_enum" NOT NULL,
      "title" varchar(255),
      "description" text,
      "metadata" jsonb,
      "previousValue" jsonb,
      "newValue" jsonb,
      "createdAt" timestamptz NOT NULL
    )
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."activity_logs" (
      "id" uuid PRIMARY KEY,
      "action" varchar(100) NOT NULL,
      "entityType" varchar(50),
      "entityId" varchar(100),
      "tenantId" varchar(100),
      "userId" varchar(100),
      "userEmail" varchar(100),
      "severity" varchar(20),
      "previousValue" jsonb,
      "newValue" jsonb,
      "createdAt" timestamptz NOT NULL
    )
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."retention_policies" (
      "id" uuid PRIMARY KEY,
      "name" varchar(100) NOT NULL,
      "createdBy" varchar(100),
      "createdAt" timestamptz NOT NULL
    )
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."impersonation_sessions" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "superAdminId" uuid NOT NULL,
      "superAdminEmail" character varying(255),
      "targetTenantId" uuid NOT NULL,
      "targetTenantName" character varying(255),
      "targetUserId" uuid,
      "targetUserEmail" character varying(255),
      "status" character varying(50) NOT NULL DEFAULT 'active',
      "reason" character varying(50) NOT NULL,
      "reasonDetails" text,
      "ticketReference" text,
      "permissions" jsonb,
      "ipAddress" inet,
      "userAgent" text,
      "originalSessionToken" text,
      "impersonationToken" text,
      "mfaCompleted" boolean NOT NULL DEFAULT false,
      "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "endedAt" TIMESTAMP WITH TIME ZONE,
      "endReason" text,
      "actionsPerformed" jsonb,
      "actionCount" integer NOT NULL DEFAULT 0,
      "accessedResources" jsonb,
      "metadata" jsonb,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_test_impersonation_sessions" PRIMARY KEY ("id")
    )
  `);
  await queryRunner.query(`
    CREATE TABLE "admin"."impersonation_permissions" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "superAdminId" uuid NOT NULL,
      "superAdminEmail" character varying(255),
      "canImpersonate" boolean NOT NULL DEFAULT true,
      "isActive" boolean NOT NULL DEFAULT true,
      "allowedTenants" jsonb,
      "restrictedTenants" jsonb,
      "defaultPermissions" jsonb,
      "maxSessionDurationMinutes" integer NOT NULL DEFAULT 60,
      "maxConcurrentSessions" integer NOT NULL DEFAULT 3,
      "requireReason" boolean NOT NULL DEFAULT true,
      "requireTicketReference" boolean NOT NULL DEFAULT false,
      "notifyTenantAdmin" boolean NOT NULL DEFAULT true,
      "grantedBy" uuid,
      "grantedAt" TIMESTAMP WITH TIME ZONE,
      "expiresAt" TIMESTAMP WITH TIME ZONE,
      "notes" text,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_test_impersonation_permissions" PRIMARY KEY ("id")
    )
  `);
}

async function migrate(queryRunner: QueryRunner): Promise<void> {
  const migrations = [
    new RetireImpersonationDeadSecretAndConstrainCredential1808600000000(),
    new CreateImpersonationAuthorizationReceipts1808700000000(),
    new EstablishAdminAuditTrustClasses1808750000000(),
    new ConsolidateTenantActivityAuthority1808800000000(),
    new ConsolidateAdminActivityAuthority1808900000000(),
  ];
  await queryRunner.startTransaction();
  try {
    for (const migration of migrations) await migration.up(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  }
}

async function seedLegacyDrift(queryRunner: QueryRunner): Promise<void> {
  const permissions = JSON.stringify(DEFAULT_IMPERSONATION_PERMISSIONS);
  const validScope = JSON.stringify([TENANT_ID]);
  const duplicateToken = 'b'.repeat(64);
  await queryRunner.query(
    `INSERT INTO admin.impersonation_sessions (
       id, "superAdminId", "targetTenantId", status, reason, permissions,
       "ipAddress", "userAgent", "impersonationToken", "mfaCompleted",
       "expiresAt", "endedAt", "actionsPerformed", "actionCount", "createdAt"
     ) VALUES
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', $1, $2, 'active', 'support_request', $3,
        NULL, NULL, 'INVALID', false, now() + interval '1 hour', NULL, '[]', 0,
        '2026-01-01T00:00:00Z'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', $1, $2, 'active', 'support_request', $3,
        $4, $5, $6, true, now() + interval '1 hour', NULL, '[]', 0,
        '2026-01-02T00:00:00Z'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', $1, $2, 'active', 'support_request', $3,
        $4, $5, $6, true, now() + interval '1 hour', NULL, '[]', 0,
        '2026-01-03T00:00:00Z'),
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', $1, $2, 'ended', 'support_request', $3,
        $4, $5, $7, true, now() - interval '1 hour', now(), '[]', 0,
        '2026-01-04T00:00:00Z')`,
    [
      ADMIN_ID,
      TENANT_ID,
      permissions,
      CLIENT_IP,
      CLIENT_USER_AGENT,
      duplicateToken,
      'c'.repeat(64),
    ],
  );
  await queryRunner.query(
    `INSERT INTO admin.impersonation_permissions (
       id, "superAdminId", "allowedTenants", "restrictedTenants",
       "defaultPermissions", "maxSessionDurationMinutes", "maxConcurrentSessions",
       "notifyTenantAdmin", "createdAt"
     ) VALUES
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, $5, '[]', $6, 60, 3, true,
        '2026-01-01T00:00:00Z'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, $5, '[]', $6, 60, 3, false,
        '2026-01-02T00:00:00Z'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', $2, $7, $7, $6, 60, 3, false,
        '2026-01-03T00:00:00Z'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4', $3, $5, '[]', $6, 900, 0, false,
        '2026-01-04T00:00:00Z'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5', $4, $5, '[]', $6, 60, 3, true,
        '2026-01-05T00:00:00Z')`,
    [
      ADMIN_ID,
      OTHER_ADMIN_ID,
      ACTOR_ID,
      '66666666-6666-4666-8666-666666666666',
      validScope,
      permissions,
      JSON.stringify([TENANT_ID, TENANT_ID]),
    ],
  );
}

function startRequest(
  overrides: Partial<StartImpersonationRequest> = {},
): StartImpersonationRequest {
  return {
    superAdminId: ADMIN_ID,
    targetTenantId: TENANT_ID,
    reason: ImpersonationReason.SUPPORT_REQUEST,
    durationMinutes: 30,
    ipAddress: CLIENT_IP,
    userAgent: CLIENT_USER_AGENT,
    mfaVerified: true,
    ...overrides,
  };
}

describe('180860-180890 impersonation and audit authorities — real PostgreSQL', () => {
  let harness: HarnessContext | undefined;
  let queryRunner: QueryRunner;
  let applicationDataSource: DataSource | undefined;
  const services: ImpersonationService[] = [];
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'test';
    harness = await bootPostgresContainer({
      startTimeoutMs: 120_000,
      labels: { 'com.aqua-saas.test.role': 'impersonation-security-authority' },
    });
    queryRunner = harness.dataSource.createQueryRunner();
    await queryRunner.connect();
  }, 150_000);

  afterEach(async () => {
    for (const service of services.splice(0)) service.onModuleDestroy();
    if (applicationDataSource?.isInitialized) await applicationDataSource.destroy();
    applicationDataSource = undefined;
  });

  afterAll(async () => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    await queryRunner?.release();
    await shutdownHarness(harness);
  }, 60_000);

  async function resetDatabase(seed?: (runner: QueryRunner) => Promise<void>): Promise<void> {
    await installBaseline(queryRunner);
    if (seed) await seed(queryRunner);
    await migrate(queryRunner);
    if (!harness) throw new Error('PostgreSQL harness did not start');
    applicationDataSource = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      entities: [
        ImpersonationSession,
        ImpersonationPermission,
        ImpersonationAuthorizationReceipt,
        ImpersonationAuthorizationOperationReceipt,
        AuditLog,
      ],
      synchronize: false,
      logging: false,
      name: `impersonation-security-authority-${Date.now()}`,
    });
    await applicationDataSource.initialize();
  }

  function harnessApplicationDataSource(): DataSource {
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    return applicationDataSource;
  }

  function harnessRepository<T extends ObjectLiteral>(entity: EntityTarget<T>): Repository<T> {
    return new Repository(entity, harnessApplicationDataSource().manager);
  }

  function service(auditOverride?: AuditLogService): ImpersonationService {
    const dataSource = harnessApplicationDataSource();
    const auditService = auditOverride ?? new AuditLogService(harnessRepository(AuditLog));
    const instance = new ImpersonationService(
      harnessRepository(ImpersonationSession),
      harnessRepository(ImpersonationPermission),
      harnessRepository(ImpersonationAuthorizationReceipt),
      harnessRepository(ImpersonationAuthorizationOperationReceipt),
      dataSource,
      auditService,
    );
    services.push(instance);
    return instance;
  }

  async function seedPermission(maxConcurrentSessions = 3): Promise<void> {
    const repository = harnessRepository(ImpersonationPermission);
    await repository.save(
      repository.create({
        superAdminId: ADMIN_ID,
        canImpersonate: true,
        isActive: true,
        allowedTenants: [TENANT_ID],
        restrictedTenants: [],
        defaultPermissions: DEFAULT_IMPERSONATION_PERMISSIONS,
        maxSessionDurationMinutes: 60,
        maxConcurrentSessions,
        requireReason: true,
        requireTicketReference: false,
        notifyTenantAdmin: false,
        grantedBy: ACTOR_ID,
        grantedAt: new Date(),
      }),
    );
  }

  async function seedActiveSession(rawToken = RAW_TOKEN): Promise<ImpersonationSession> {
    const repository = harnessRepository(ImpersonationSession);
    return repository.save(
      repository.create({
        superAdminId: ADMIN_ID,
        targetTenantId: TENANT_ID,
        status: ImpersonationStatus.ACTIVE,
        reason: ImpersonationReason.SUPPORT_REQUEST,
        permissions: DEFAULT_IMPERSONATION_PERMISSIONS,
        ipAddress: CLIENT_IP,
        userAgent: CLIENT_USER_AGENT,
        impersonationToken: createHash('sha256').update(rawToken).digest('hex'),
        mfaCompleted: true,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        actionsPerformed: [],
        accessedResources: [],
        actionCount: 0,
      }),
    );
  }

  function authorizationRequest(
    sessionId: string,
    options: {
      readonly authorizationReceiptId?: string;
      readonly bodyHash?: string;
      readonly operation?: string;
    } = {},
  ): AuthorizeImpersonationOperationsRequest {
    const operations = [
      {
        authority: 'data.read' as const,
        module: 'farm' as const,
        operation: options.operation ?? 'Query.farms',
      },
    ];
    const coordinate = {
      schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
      authorizationReceiptId: options.authorizationReceiptId ?? AUTHORIZATION_RECEIPT_ID,
      sessionId,
      actorId: ADMIN_ID,
      mfaVerified: true as const,
      effectiveTenantId: TENANT_ID,
      method: 'POST' as const,
      normalizedPath: '/graphql',
      normalizedQueryHash: 'b'.repeat(64),
      bodyHash: options.bodyHash ?? 'c'.repeat(64),
      clientIp: CLIENT_IP,
      clientUserAgent: CLIENT_USER_AGENT,
    };
    return {
      ...coordinate,
      credential: RAW_TOKEN,
      requestDigest: impersonationAuthorizationRequestDigestV1(coordinate),
      operations,
      operationSetDigest: impersonationAuthorizationOperationSetDigestV1(operations),
    };
  }

  it('disposes legacy drift with required audits and installs immutable DB constraints', async () => {
    await resetDatabase(seedLegacyDrift);
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');

    const sessions: Array<{ id: string; status: string; impersonationToken: string | null }> =
      await applicationDataSource.query(
        `SELECT id, status, "impersonationToken"
           FROM admin.impersonation_sessions ORDER BY id`,
      );
    expect(sessions.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(sessions.filter((row) => row.status !== 'active')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ impersonationToken: null }),
        expect.objectContaining({ impersonationToken: null }),
        expect.objectContaining({ impersonationToken: null }),
      ]),
    );

    const permissions: Array<{
      superAdminId: string;
      isActive: boolean;
      canImpersonate: boolean;
      allowedTenants: string[] | null;
      notifyTenantAdmin: boolean;
      maxSessionDurationMinutes: number;
      maxConcurrentSessions: number;
    }> = await applicationDataSource.query(
      `SELECT "superAdminId", "isActive", "canImpersonate", "allowedTenants",
              "notifyTenantAdmin", "maxSessionDurationMinutes", "maxConcurrentSessions"
         FROM admin.impersonation_permissions ORDER BY "superAdminId"`,
    );
    expect(permissions.filter((row) => row.superAdminId === ADMIN_ID)).toEqual([
      expect.objectContaining({
        isActive: false,
        canImpersonate: false,
        notifyTenantAdmin: false,
      }),
    ]);
    expect(permissions.find((row) => row.superAdminId === OTHER_ADMIN_ID)).toEqual(
      expect.objectContaining({ isActive: false, canImpersonate: false, allowedTenants: null }),
    );
    expect(permissions.find((row) => row.superAdminId === ACTOR_ID)).toEqual(
      expect.objectContaining({ maxSessionDurationMinutes: 60, maxConcurrentSessions: 1 }),
    );
    expect(permissions.every((row) => row.notifyTenantAdmin === false)).toBe(true);

    const defaultRows: Array<{ column_default: string }> = await applicationDataSource.query(
      `SELECT column_default
         FROM information_schema.columns
        WHERE table_schema = 'admin'
          AND table_name = 'impersonation_permissions'
          AND column_name = 'notifyTenantAdmin'`,
    );
    expect(defaultRows[0]?.column_default).toContain('false');

    const actions: Array<{ action: string }> = await applicationDataSource.query(
      `SELECT action FROM admin.audit_logs ORDER BY action`,
    );
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'IMPERSONATION_TERMINATED_BY_SECURITY_MIGRATION',
        'IMPERSONATION_TERMINAL_CREDENTIAL_SCRUBBED_BY_MIGRATION',
        'IMPERSONATION_DUPLICATE_PERMISSION_CANONICALIZED_BY_MIGRATION',
        'IMPERSONATION_DUPLICATE_PERMISSION_REMOVED_BY_MIGRATION',
        'IMPERSONATION_INVALID_TENANT_SCOPE_DEACTIVATED_BY_MIGRATION',
        'IMPERSONATION_PERMISSION_LIMIT_REPAIRED_BY_MIGRATION',
        'IMPERSONATION_UNSUPPORTED_NOTIFICATION_DISABLED_BY_MIGRATION',
      ]),
    );

    await expect(
      applicationDataSource.query(
        `INSERT INTO admin.impersonation_permissions (
           "superAdminId", "allowedTenants", "restrictedTenants",
           "defaultPermissions", "notifyTenantAdmin"
         ) VALUES ($1, $2::jsonb, '[]'::jsonb, $3::jsonb, false)`,
        [ADMIN_ID, JSON.stringify([TENANT_ID]), JSON.stringify(DEFAULT_IMPERSONATION_PERMISSIONS)],
      ),
    ).rejects.toThrow();
    await expect(
      applicationDataSource.query(
        `UPDATE admin.impersonation_permissions
            SET "allowedTenants" = $2::jsonb, "restrictedTenants" = $2::jsonb,
                "isActive" = true, "canImpersonate" = true
          WHERE "superAdminId" = $1`,
        [OTHER_ADMIN_ID, JSON.stringify([TENANT_ID])],
      ),
    ).rejects.toThrow();
    await expect(
      applicationDataSource.query(
        `UPDATE admin.impersonation_permissions
            SET "notifyTenantAdmin" = true
          WHERE "superAdminId" = $1`,
        [ACTOR_ID],
      ),
    ).rejects.toThrow();
  }, 30_000);

  it('uses the advisory cap authority so only one concurrent start commits', async () => {
    await resetDatabase();
    await seedPermission(1);
    const impersonationService = service();

    const results = await Promise.allSettled([
      impersonationService.startImpersonation(startRequest()),
      impersonationService.startImpersonation(startRequest()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    const sessions: Array<{ count: string }> = await applicationDataSource.query(
      `SELECT count(*)::text AS count FROM admin.impersonation_sessions WHERE status = 'active'`,
    );
    const audits: Array<{ count: string }> = await applicationDataSource.query(
      `SELECT count(*)::text AS count FROM admin.audit_logs
        WHERE action = 'IMPERSONATION_STARTED'`,
    );
    expect(sessions[0]?.count).toBe('1');
    expect(audits[0]?.count).toBe('1');
  });

  it('rolls back permission revocation and every session transition on audit failure', async () => {
    await resetDatabase();
    await seedPermission();
    const first = await seedActiveSession();
    const second = await seedActiveSession('b'.repeat(64));
    const impersonationService = service();
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    await applicationDataSource.query(`
      CREATE FUNCTION admin.fail_revoke_audit() RETURNS trigger AS $failure$
      BEGIN
        IF NEW.action = 'IMPERSONATION_TERMINATED_PERMISSION_REVOKED' THEN
          RAISE EXCEPTION 'forced revoke audit failure';
        END IF;
        RETURN NEW;
      END;
      $failure$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_revoke_audit
        BEFORE INSERT ON admin.audit_logs
        FOR EACH ROW EXECUTE FUNCTION admin.fail_revoke_audit()
    `);

    await expect(
      impersonationService.revokeImpersonationPermission(ADMIN_ID, ACTOR_ID),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const permissions: Array<{ isActive: boolean; canImpersonate: boolean }> =
      await applicationDataSource.query(
        `SELECT "isActive", "canImpersonate"
           FROM admin.impersonation_permissions WHERE "superAdminId" = $1`,
        [ADMIN_ID],
      );
    expect(permissions[0]).toEqual({ isActive: true, canImpersonate: true });
    const sessions: Array<{ id: string; status: string; impersonationToken: string | null }> =
      await applicationDataSource.query(
        `SELECT id, status, "impersonationToken"
           FROM admin.impersonation_sessions WHERE id IN ($1, $2) ORDER BY id`,
        [first.id, second.id],
      );
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.status === 'active')).toBe(true);
    expect(sessions.every((row) => row.impersonationToken !== null)).toBe(true);
  });

  it('rejects unsupported notification grants and starts normally with false', async () => {
    await resetDatabase();
    const impersonationService = service();

    await expect(
      impersonationService.grantImpersonationPermission({
        superAdminId: ADMIN_ID,
        allowedTenants: [TENANT_ID],
        notifyTenantAdmin: true,
        grantedBy: ACTOR_ID,
      }),
    ).rejects.toThrow('recipient resolution is authoritative');

    await impersonationService.grantImpersonationPermission({
      superAdminId: ADMIN_ID,
      allowedTenants: [TENANT_ID],
      restrictedTenants: [],
      notifyTenantAdmin: false,
      grantedBy: ACTOR_ID,
    });
    const started = await impersonationService.startImpersonation(startRequest());
    expect(started.impersonationToken).toHaveLength(64);
    expect(started.mfaCompleted).toBe(true);
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    const rows: Array<{ sessionCount: string; auditCount: string }> =
      await applicationDataSource.query(`
        SELECT
          (SELECT count(*)::text FROM admin.impersonation_sessions) AS "sessionCount",
          (SELECT count(*)::text FROM admin.audit_logs
            WHERE action = 'IMPERSONATION_STARTED') AS "auditCount"
      `);
    expect(rows[0]).toEqual({ sessionCount: '1', auditCount: '1' });
  });

  it('linearizes concurrent receipt replay and rejects digest reuse or active-row mutation', async () => {
    await resetDatabase();
    await seedPermission();
    const session = await seedActiveSession();
    const impersonationService = service();
    const exactRequest = authorizationRequest(session.id);

    const results = await Promise.all([
      impersonationService.authorizeOperations(exactRequest),
      impersonationService.authorizeOperations(exactRequest),
    ]);
    expect(results.map((result) => result?.replayed).sort()).toEqual([false, true]);
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    const counts: Array<{ parents: string; children: string; audits: string }> =
      await applicationDataSource.query(`
        SELECT
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_receipts) AS parents,
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_operation_receipts) AS children,
          (SELECT count(*)::text FROM admin.audit_logs
            WHERE action = 'IMPERSONATION_OPERATIONS_AUTHORIZED') AS audits
      `);
    expect(counts[0]).toEqual({ parents: '1', children: '1', audits: '1' });

    await expect(
      impersonationService.authorizeOperations(
        authorizationRequest(session.id, { bodyHash: 'e'.repeat(64) }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      applicationDataSource.query(
        `UPDATE admin.impersonation_authorization_receipts
            SET "bodyHash" = $2 WHERE "sessionId" = $1`,
        [session.id, 'f'.repeat(64)],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      applicationDataSource.query(
        `DELETE FROM admin.impersonation_authorization_receipts WHERE "sessionId" = $1`,
        [session.id],
      ),
    ).rejects.toThrow('terminal sessions');
    await expect(
      applicationDataSource.query(
        `INSERT INTO admin.impersonation_authorization_operation_receipts (
           "sessionId", "authorizationReceiptId", "operationSetDigest",
           operations, "operationCount", decision,
           "sessionGeneration", "permissionGeneration"
         )
         SELECT "sessionId", "authorizationReceiptId", $2,
           $3::jsonb, 2, 'authorized', "sessionGeneration", "permissionGeneration"
         FROM admin.impersonation_authorization_receipts
         WHERE "sessionId" = $1`,
        [
          session.id,
          '9'.repeat(64),
          JSON.stringify([
            { authority: 'data.read', module: 'farm', operation: 'Query.zeta' },
            { authority: 'data.read', module: 'farm', operation: 'Query.alpha' },
          ]),
        ],
      ),
    ).rejects.toThrow('canonical order');
  });

  it('rechecks current permission generation on exact replay', async () => {
    await resetDatabase();
    await seedPermission();
    const session = await seedActiveSession();
    const impersonationService = service();
    const exactRequest = authorizationRequest(session.id);
    await expect(impersonationService.authorizeOperations(exactRequest)).resolves.toMatchObject({
      replayed: false,
    });
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    await applicationDataSource.query(
      `UPDATE admin.impersonation_permissions
          SET "canImpersonate" = false, "updatedAt" = clock_timestamp()
        WHERE "superAdminId" = $1`,
      [ADMIN_ID],
    );

    await expect(impersonationService.authorizeOperations(exactRequest)).resolves.toBeNull();
    const rows: Array<{ children: string; audits: string }> = await applicationDataSource.query(`
      SELECT
        (SELECT count(*)::text
           FROM admin.impersonation_authorization_operation_receipts) AS children,
        (SELECT count(*)::text FROM admin.audit_logs
          WHERE action LIKE 'IMPERSONATION_OPERATIONS_%') AS audits
    `);
    expect(rows[0]).toEqual({ children: '1', audits: '1' });
  });

  it('rolls back parent and child receipts when the mandatory audit append fails', async () => {
    await resetDatabase();
    await seedPermission();
    const session = await seedActiveSession();
    const impersonationService = service();
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');
    await applicationDataSource.query(`
      CREATE FUNCTION admin.fail_operation_authorization_audit() RETURNS trigger AS $failure$
      BEGIN
        IF NEW.action = 'IMPERSONATION_OPERATIONS_AUTHORIZED' THEN
          RAISE EXCEPTION 'forced authorization audit failure';
        END IF;
        RETURN NEW;
      END;
      $failure$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_fail_operation_authorization_audit
        BEFORE INSERT ON admin.audit_logs
        FOR EACH ROW EXECUTE FUNCTION admin.fail_operation_authorization_audit()
    `);

    await expect(
      impersonationService.authorizeOperations(authorizationRequest(session.id)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    const counts: Array<{ parents: string; children: string }> = await applicationDataSource.query(`
        SELECT
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_receipts) AS parents,
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_operation_receipts) AS children
      `);
    expect(counts[0]).toEqual({ parents: '0', children: '0' });
  });

  it('retires bounded replay rows only inside the terminal session transaction', async () => {
    await resetDatabase();
    await seedPermission();
    const session = await seedActiveSession();
    const impersonationService = service();
    await impersonationService.authorizeOperations(authorizationRequest(session.id));
    await impersonationService.endImpersonation(session.id, 'completed', ADMIN_ID);
    if (!applicationDataSource) throw new Error('Application DataSource is not initialized');

    const counts: Array<{ parents: string; children: string; authorizationAudits: string }> =
      await applicationDataSource.query(`
        SELECT
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_receipts) AS parents,
          (SELECT count(*)::text
             FROM admin.impersonation_authorization_operation_receipts) AS children,
          (SELECT count(*)::text FROM admin.audit_logs
            WHERE action = 'IMPERSONATION_OPERATIONS_AUTHORIZED') AS "authorizationAudits"
      `);
    expect(counts[0]).toEqual({
      parents: '0',
      children: '0',
      authorizationAudits: '1',
    });
  });
});
