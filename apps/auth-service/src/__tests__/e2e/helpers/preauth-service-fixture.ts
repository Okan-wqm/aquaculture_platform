import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DataSource, Repository } from 'typeorm';

import { AuditLog, AuditLogSeverity } from '../../../audit/audit-log.entity';
import { AuditLogService } from '../../../audit/audit-log.service';
import {
  ActionToken,
  ActionTokenPurpose,
  ActionTokenStatus,
} from '../../../modules/authentication/entities/action-token.entity';
import {
  Invitation,
  InvitationStatus,
} from '../../../modules/authentication/entities/invitation.entity';
import { RefreshToken } from '../../../modules/authentication/entities/refresh-token.entity';
import { User } from '../../../modules/authentication/entities/user.entity';
import { UserModuleAssignment } from '../../../modules/authentication/entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../../../modules/authentication/entities/user-site-assignment.entity';
import { WebAuthnCredential } from '../../../modules/authentication/entities/webauthn-credential.entity';
import { ActionTokenResolver } from '../../../modules/authentication/services/action-token-resolver.service';
import { AuthenticationService } from '../../../modules/authentication/services/authentication.service';
import { DurableAccessTokenInvalidationService } from '../../../modules/authentication/services/durable-access-token-invalidation.service';
import { DurableUserTokenInvalidationService } from '../../../modules/authentication/services/durable-user-token-invalidation.service';
import { MfaService } from '../../../modules/authentication/services/mfa.service';
import { PreAuthRlsFrameService } from '../../../modules/authentication/services/pre-auth-rls-frame.service';
import { TokenService } from '../../../modules/authentication/services/token.service';
import { BestEffortEventPublisher } from '../../../outbox/best-effort-event-publisher';
import { AuthOutbox } from '../../../outbox/auth-outbox.entity';
import { MobileUserSettings } from '../../../modules/tenant/entities/mobile-user-settings.entity';
import { MobileSettingsService } from '../../../modules/tenant/services/mobile-settings.service';
import { Tenant, TenantStatus } from '../../../modules/tenant/entities/tenant.entity';
import { TenantModule } from '../../../modules/tenant/entities/tenant-module.entity';
import { PlatformCapabilityGrant } from '../../../modules/tenant/entities/platform-capability-grant.entity';
import { TenantRole } from '../../../modules/tenant/entities/tenant-role.entity';
import { TenantRolePermission } from '../../../modules/tenant/entities/tenant-role-permission.entity';
import { UserRoleAssignment } from '../../../modules/tenant/entities/user-role-assignment.entity';
import { Module } from '../../../modules/system-module/entities/module.entity';
import { OutboxPublisher } from '@platform/outbox';

import { Role } from '@aquaculture/backend-common/decorators';

/**
 * Shared fixture for real-Postgres pre-auth RLS suites (SEC-HIGH-196/197,
 * PROC-HIGH-048): the entity set the auth schema is synchronized from, the
 * deterministic two-tenant seed, and the REAL service graph
 * (AuthenticationService + TokenService + PreAuthRlsFrameService +
 * BypassRlsService) over a non-owner runtime DataSource.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED (farm-tenant-fixture.ts precedent):
 * a suite that drives the production AuthenticationService against a real
 * database has to hand it the `Repository<T>` instances its constructor
 * declares, and there is no tenant-scoped equivalent of that shape — the
 * tenant scoping is exactly what the suite asserts. Keeping the raw
 * repository acquisition in ONE exempt fixture file (instead of copied into
 * every suite) is the pattern `banned-construct.ts`'s e2e/helpers exemption
 * documents. Nothing here serves a request; RLS visibility is the unit
 * under test.
 */

/** Every auth-schema entity the runtime maps — the DDL synchronize set. */
export const AUTH_SCHEMA_ENTITIES = [
  AuditLog,
  ActionToken,
  Invitation,
  RefreshToken,
  User,
  UserModuleAssignment,
  UserSiteAssignment,
  WebAuthnCredential,
  Tenant,
  TenantModule,
  MobileUserSettings,
  Module,
  PlatformCapabilityGrant,
  TenantRole,
  TenantRolePermission,
  UserRoleAssignment,
  // The outbox entity's own `synchronize: false` keeps DDL with the harness;
  // registering it here lets the runtime manager persist outbox rows.
  AuthOutbox,
];

export interface PreAuthSeedIds {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly userA: string;
  readonly userPlatform: string;
  readonly actionTokenId: string;
  readonly tokenHash: string;
  readonly resetTokenHash: string;
}

/** Seed two operational tenants, an invitee and a platform admin, plus their
 * action-token rows — as the superuser owner, before RLS is armed. */
export async function seedPreAuthRlsFixtures(ddl: DataSource, ids: PreAuthSeedIds): Promise<void> {
  const tenants = ddl.getRepository(Tenant);
  await tenants.save(
    tenants.create([
      { id: ids.tenantA, name: 'Tenant A', slug: 'tenant-a', status: TenantStatus.ACTIVE },
      { id: ids.tenantB, name: 'Tenant B', slug: 'tenant-b', status: TenantStatus.ACTIVE },
    ]),
  );

  const users = ddl.getRepository(User);
  await users.save(
    users.create([
      {
        id: ids.userA,
        email: 'invitee@tenant-a.test',
        password: 'InitialPass123!',
        role: Role.MODULE_USER,
        tenantId: ids.tenantA,
        isActive: true,
        invitationToken: ids.tokenHash,
        invitationExpiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      },
      {
        id: ids.userPlatform,
        email: 'platform@platform.test',
        password: 'InitialPass123!',
        role: Role.SUPER_ADMIN,
        tenantId: null,
        isActive: true,
        passwordResetToken: ids.resetTokenHash,
        passwordResetExpires: new Date(Date.now() + 3600_000),
      },
    ]),
  );

  const invitations = ddl.getRepository(Invitation);
  await invitations.save(
    invitations.create({
      token: ids.tokenHash,
      email: 'invitee@tenant-a.test',
      firstName: 'Inv',
      lastName: 'Tee',
      role: Role.MODULE_USER,
      tenantId: ids.tenantA,
      invitedBy: ids.userPlatform,
      status: InvitationStatus.PENDING,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      sendCount: 1,
    }),
  );

  const actionTokens = ddl.getRepository(ActionToken);
  await actionTokens.save(
    actionTokens.create([
      {
        id: ids.actionTokenId,
        purpose: ActionTokenPurpose.INVITATION,
        tenantId: ids.tenantA,
        userId: ids.userA,
        tokenHash: ids.tokenHash,
        status: ActionTokenStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
      },
      {
        id: 'cccccccc-0000-4000-8000-000000000002',
        purpose: ActionTokenPurpose.PASSWORD_RESET,
        tenantId: null,
        userId: ids.userPlatform,
        tokenHash: ids.resetTokenHash,
        status: ActionTokenStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    ]),
  );
}

export interface PreAuthServiceGraph {
  readonly service: AuthenticationService;
  readonly bypassRls: BypassRlsService;
}

/** Build the REAL pre-auth service graph over a non-owner runtime DataSource. */
export function buildPreAuthServiceGraph(runtime: DataSource): PreAuthServiceGraph {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const config = new ConfigService({
    JWT_EXPIRES_IN: '15m',
    JWT_AUDIENCE: 'preauth-rls-spec',
    JWT_KEY_ID: 'spec-key-1',
    REFRESH_TOKEN_EXPIRY_DAYS: 7,
    MAX_SESSIONS_PER_USER: 5,
    HASH_REFRESH_TOKENS: false,
    MIN_LOGIN_DURATION_MS: 0,
    NODE_ENV: 'test',
  });
  const jwt = new JwtService({ privateKey, signOptions: { algorithm: 'RS256' } });
  const bypassRls = new BypassRlsService();
  const mobileSettings = new MobileSettingsService(
    runtime.getRepository(MobileUserSettings) as Repository<MobileUserSettings>,
  );
  const tokenService = new TokenService(
    runtime.getRepository(User) as Repository<User>,
    runtime.getRepository(RefreshToken) as Repository<RefreshToken>,
    runtime.getRepository(UserSiteAssignment) as Repository<UserSiteAssignment>,
    runtime,
    jwt,
    config,
    mobileSettings,
    { isTokenValid: async () => true, revokeUserTokens: async () => undefined },
    undefined,
  );
  const frame = new PreAuthRlsFrameService(bypassRls, tokenService, runtime);
  const auditLogService = new AuditLogService(
    runtime.getRepository(AuditLog) as Repository<AuditLog>,
    config,
    runtime,
    { run: async () => 'ran' },
  );
  const mfaService = new MfaService(
    runtime.getRepository(User) as Repository<User>,
    jwt,
    config,
    auditLogService,
    tokenService,
    frame,
  );
  const outboxPublisher = new OutboxPublisher(AuthOutbox, {
    allowSystemRouting: true,
    allowSecurityRecovery: true,
  });
  const tokenBlacklist = { add: async () => undefined, isBlacklisted: async () => false };
  const userTokenRevocation = {
    isTokenValid: async () => true,
    revokeUserTokens: async () => undefined,
  };
  const service = new AuthenticationService(
    runtime.getRepository(User) as Repository<User>,
    runtime.getRepository(RefreshToken) as Repository<RefreshToken>,
    runtime.getRepository(Invitation) as Repository<Invitation>,
    runtime.getRepository(ActionToken) as Repository<ActionToken>,
    runtime.getRepository(Tenant) as Repository<Tenant>,
    runtime.getRepository(WebAuthnCredential) as Repository<WebAuthnCredential>,
    runtime,
    jwt,
    config,
    new BestEffortEventPublisher({ publish: async () => undefined }),
    outboxPublisher,
    new ActionTokenResolver(),
    auditLogService,
    tokenService,
    frame,
    new DurableAccessTokenInvalidationService(outboxPublisher, tokenBlacklist),
    new DurableUserTokenInvalidationService(outboxPublisher, userTokenRevocation),
    mfaService,
    bypassRls,
    tokenBlacklist,
    userTokenRevocation,
    undefined,
  );
  return { service, bypassRls };
}

/** Deterministic raw/hash token material for a seeded invitation link. */
export function mintInvitationTokenMaterial(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: createHash('sha256').update(raw).digest('hex') };
}
