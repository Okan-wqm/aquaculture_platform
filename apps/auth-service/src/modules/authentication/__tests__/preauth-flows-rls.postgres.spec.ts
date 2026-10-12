import { createHash, randomBytes } from 'node:crypto';

import {
  applyTenantRlsToSchema,
  AUTH_RLS_EXCLUDE_TABLES,
  createRlsConnectionBootstrap,
} from '@aquaculture/backend-common/database';
import { requestContextStorage } from '@aquaculture/backend-common/logging';
import {
  bootPostgresContainer,
  shutdownHarness,
  type HarnessContext,
} from '@platform/migration-harness';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  AUTH_SCHEMA_ENTITIES,
  buildPreAuthServiceGraph,
  seedPreAuthRlsFixtures,
} from '../../../__tests__/e2e/helpers/preauth-service-fixture';
import type { AuthenticationService } from '../services/authentication.service';

/**
 * REAL-POSTGRES proof for the pre-auth RLS boundary (SEC-HIGH-196/197,
 * PROC-HIGH-048): the production image, FORCE RLS armed by the platform
 * helper exactly as db-migrate arms it, a NON-OWNER runtime role (a
 * superuser would bypass RLS no matter what FORCE says), the REAL pool
 * checkout patch, the REAL BypassRlsService, and the REAL AuthenticationService.
 *
 * This is the tier that would have caught the 2026-10-12 outage: every unit
 * suite stubs the frame pass-through, so "row hidden by policy" and "mock
 * returned null" are indistinguishable there. Here they are not.
 */
describe('pre-auth flows under real Postgres RLS', () => {
  jest.setTimeout(240_000);

  let harness: HarnessContext;
  let admin: DataSource;
  let runtime: DataSource;
  let service: AuthenticationService;
  const runtimePassword = randomBytes(24).toString('hex');

  const TENANT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const TENANT_B = 'aaaaaaaa-0000-4000-8000-000000000002';
  const USER_A = 'bbbbbbbb-0000-4000-8000-000000000001';
  const USER_PLATFORM = 'bbbbbbbb-0000-4000-8000-0000000000ff';

  const tokenHash = createHash('sha256').update(randomBytes(32).toString('hex')).digest('hex');
  const ACTION_TOKEN_ID = 'cccccccc-0000-4000-8000-000000000001';
  const RESET_RAW = randomBytes(32).toString('hex');
  const resetTokenHash = createHash('sha256').update(RESET_RAW).digest('hex');

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 180_000 });
    admin = harness.dataSource;
    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA IF NOT EXISTS auth');
    await admin.query(`CREATE ROLE preauth_rls_spec LOGIN PASSWORD '${runtimePassword}'`);

    // DDL + seeding as the SUPERUSER (owner): FORCE RLS does not apply to it.
    const ddl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: 'preauth-rls-ddl',
      schema: 'auth',
      entities: AUTH_SCHEMA_ENTITIES,
      synchronize: true,
      logging: false,
    });
    await ddl.initialize();

    // The issuance-fence trigger the fix must survive (its DDL is owned by
    // migration 1819200000000; synchronize does not create triggers).
    await ddl.query(`
      CREATE OR REPLACE FUNCTION "auth".users_bump_credential_version()
      RETURNS trigger AS $credentialversion$
      BEGIN
        IF NEW."password"  IS DISTINCT FROM OLD."password"
        OR NEW."role"      IS DISTINCT FROM OLD."role"
        OR NEW."tenantId"  IS DISTINCT FROM OLD."tenantId"
        OR NEW."isActive"  IS DISTINCT FROM OLD."isActive" THEN
          NEW."credentialVersion" := OLD."credentialVersion" + 1;
        ELSE
          NEW."credentialVersion" := OLD."credentialVersion";
        END IF;
        RETURN NEW;
      END;
      $credentialversion$ LANGUAGE plpgsql`);
    await ddl.query(`DROP TRIGGER IF EXISTS trg_users_bump_credential_version ON "auth"."users"`);
    await ddl.query(`
      CREATE TRIGGER trg_users_bump_credential_version
        BEFORE UPDATE ON "auth"."users"
        FOR EACH ROW EXECUTE FUNCTION "auth".users_bump_credential_version()`);

    // auth_outbox carries `synchronize: false` on its entity (production DDL
    // is migration-owned), so the harness creates it explicitly — the REAL
    // OutboxPublisher writes here from the pre-auth transactions.
    await ddl.query(`
      CREATE TABLE IF NOT EXISTS "auth"."auth_outbox" (
        id bigserial PRIMARY KEY,
        "eventType" varchar(100) NOT NULL,
        "tenantId" uuid NULL,
        "aggregateId" uuid NULL,
        payload jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "publishedAt" timestamptz NULL,
        "retryCount" integer NOT NULL DEFAULT 0,
        "lastError" text NULL,
        "nextAttemptAt" timestamptz NULL,
        "idempotencyKey" varchar(255) NULL,
        "isDeadLettered" boolean NOT NULL DEFAULT false,
        "leasedAt" timestamptz NULL,
        "leasedBy" varchar(128) NULL
      )`);

    await seedPreAuthRlsFixtures(ddl, {
      tenantA: TENANT_A,
      tenantB: TENANT_B,
      userA: USER_A,
      userPlatform: USER_PLATFORM,
      actionTokenId: ACTION_TOKEN_ID,
      tokenHash,
      resetTokenHash,
    });

    await ddl.destroy();

    // Arm tenant RLS exactly as db-migrate's post-migration hardening does,
    // then add the audit append policy migration 1801900000000 installs.
    const prevAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    try {
      await applyTenantRlsToSchema(admin.createQueryBuilder().connection.createQueryRunner(), {
        schemaOverride: 'auth',
        excludeTables: [...AUTH_RLS_EXCLUDE_TABLES],
      });
    } finally {
      if (prevAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = prevAuthority;
    }
    await admin.query(`DROP POLICY IF EXISTS "audit_append_system" ON "auth"."audit_logs"`);
    await admin.query(
      `CREATE POLICY "audit_append_system" ON "auth"."audit_logs" FOR INSERT WITH CHECK (true)`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA auth, public TO preauth_rls_spec`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO preauth_rls_spec`,
    );
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO preauth_rls_spec`);

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: 'preauth_rls_spec',
      password: runtimePassword,
      name: 'preauth-rls-runtime',
      schema: 'auth',
      entities: AUTH_SCHEMA_ENTITIES,
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
    // The production pool checkout patch: emits both RLS GUCs from the
    // AsyncLocalStorage request context on EVERY connection checkout.
    const Bootstrap = createRlsConnectionBootstrap('auth-service');
    await new Bootstrap(runtime).onModuleInit();

    service = buildPreAuthServiceGraph(runtime).service;
  });

  afterAll(async () => {
    await runtime?.destroy().catch(() => undefined);
    await shutdownHarness(harness);
  });

  it('RLS is armed and bites on the non-owner runtime role (stage proof)', async () => {
    const policies = await admin.query(
      `SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'auth' AND tablename IN ('invitations', 'action_tokens', 'refresh_tokens')`,
    );
    expect((policies[0] as { n: number }).n).toBeGreaterThanOrEqual(3);

    const anon = await runtime.query(`SELECT count(*)::int AS n FROM auth.invitations`);
    expect((anon[0] as { n: number }).n).toBe(0);

    const tenantA = await requestContextStorage.run({ tenantId: TENANT_A }, () =>
      runtime.query(`SELECT count(*)::int AS n FROM auth.invitations`),
    );
    expect((tenantA[0] as { n: number }).n).toBe(1);
  });

  it('an anonymous validateInvitation resolves a valid invitation (the outage, replayed)', async () => {
    const result = await service.validateInvitation(ACTION_TOKEN_ID);
    expect(result).toMatchObject({ valid: true, email: 'invitee@tenant-a.test' });

    const bogus = await service.validateInvitation('dddddddd-0000-4000-8000-0000000000dd');
    expect(bogus).toMatchObject({ valid: false });
  });

  it('an anonymous acceptInvitation redeems, consumes, and mints (fence + RLS + tenant-homed refresh row)', async () => {
    const warnCalls: string[] = [];
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(function (
      this: Logger,
      message: string,
    ) {
      warnCalls.push(String(message));
    });

    try {
      const payload = await service.acceptInvitation(
        ACTION_TOKEN_ID,
        'BrandNewPass123!',
        'Inv',
        'Tee',
        '10.9.8.7',
        'spec-agent',
      );

      expect(payload.accessToken).toBeTruthy();
      expect(payload.refreshToken).toBeTruthy();
      // The tenant mint must NOT have run under a bypass.
      expect(warnCalls.some((m) => m.includes('platform-session-mint'))).toBe(false);
      expect(warnCalls.some((m) => m.includes('invitation-redemption'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }

    const invitation = await admin.query(`SELECT status FROM auth.invitations WHERE token = $1`, [
      tokenHash,
    ]);
    expect((invitation[0] as { status: string }).status).toBe('ACCEPTED');

    const actionToken = await admin.query(`SELECT status FROM auth.action_tokens WHERE id = $1`, [
      ACTION_TOKEN_ID,
    ]);
    expect((actionToken[0] as { status: string }).status).toBe('CONSUMED');

    // The issuance fence passed ⇒ the re-loaded row carried the post-write
    // credentialVersion the trigger advanced.
    const user = await admin.query(
      `SELECT "credentialVersion"::int AS v, "invitationToken" FROM auth.users WHERE id = $1`,
      [USER_A],
    );
    expect((user[0] as { v: number }).v).toBe(2);
    expect((user[0] as { invitationToken: string | null }).invitationToken).toBeNull();

    // Tenant-homed session write, exactly what the tenant frame guarantees.
    const refresh = await admin.query(
      `SELECT "tenantId" FROM auth.refresh_tokens WHERE "userId" = $1 LIMIT 1`,
      [USER_A],
    );
    expect((refresh[0] as { tenantId: string | null }).tenantId).toBe(TENANT_A);

    // The audit trail survived the anonymous path (audit_append_system).
    const auditRows = await admin.query(`SELECT count(*)::int AS n FROM auth.audit_logs`);
    expect((auditRows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('an anonymous initiatePasswordReset commits the ActionToken row for BOTH principal kinds', async () => {
    await service.initiatePasswordReset('invitee@tenant-a.test', '10.9.8.7');
    await service.initiatePasswordReset('platform@platform.test', '10.9.8.7');

    const tenantRow = await admin.query(
      `SELECT count(*)::int AS n FROM auth.action_tokens
       WHERE purpose = 'PASSWORD_RESET' AND "tenantId" = $1`,
      [TENANT_A],
    );
    expect((tenantRow[0] as { n: number }).n).toBe(1);

    const platformRow = await admin.query(
      `SELECT count(*)::int AS n FROM auth.action_tokens
       WHERE purpose = 'PASSWORD_RESET' AND "tenantId" IS NULL`,
    );
    expect((platformRow[0] as { n: number }).n).toBe(2);
  });

  it('an anonymous resetPassword (platform principal) resets, revokes, and mints', async () => {
    // The initiate test (above) rotated the platform user's reset credential;
    // re-seed a deterministic pair so this test redeems a known raw token.
    await admin.query(
      `UPDATE auth.users SET "passwordResetToken" = $1, "passwordResetExpires" = now() + interval '1 hour' WHERE id = $2`,
      [resetTokenHash, USER_PLATFORM],
    );
    await admin.query(
      `INSERT INTO auth.action_tokens (id, purpose, "tenantId", "userId", "tokenHash", status, "expiresAt", "createdAt", "updatedAt")
       VALUES ($1, 'PASSWORD_RESET', NULL, $2, $3, 'ACTIVE', now() + interval '1 hour', now(), now())`,
      ['cccccccc-0000-4000-8000-000000000003', USER_PLATFORM, resetTokenHash],
    );
    // Give the platform user a live refresh row so revocation is observable.
    await admin.query(
      `INSERT INTO auth.refresh_tokens (id, token, "userId", "tenantId", "expiresAt", "isRevoked", "createdAt")
       VALUES (gen_random_uuid(), 'legacy-revoked-by-reset', $1, NULL, now() + interval '7 days', false, now())`,
      [USER_PLATFORM],
    );

    const payload = await service.resetPassword(RESET_RAW, 'ResetPass123!', '10.9.8.7', 'spec');
    expect(payload.accessToken).toBeTruthy();

    const user = await admin.query(
      `SELECT "passwordResetToken", "credentialVersion"::int AS v FROM auth.users WHERE id = $1`,
      [USER_PLATFORM],
    );
    expect((user[0] as { passwordResetToken: string | null }).passwordResetToken).toBeNull();
    expect((user[0] as { v: number }).v).toBe(2);

    const revoked = await admin.query(
      `SELECT count(*)::int AS n FROM auth.refresh_tokens
       WHERE "userId" = $1 AND "isRevoked" = true AND "revokedReason" = 'Password reset'`,
      [USER_PLATFORM],
    );
    expect((revoked[0] as { n: number }).n).toBe(1);

    const fresh = await admin.query(
      `SELECT count(*)::int AS n FROM auth.refresh_tokens WHERE "userId" = $1`,
      [USER_PLATFORM],
    );
    expect((fresh[0] as { n: number }).n).toBe(2);
  });
});
