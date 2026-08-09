import * as crypto from 'crypto';

import { bindTenantRlsContext } from '@aquaculture/backend-common/database';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  USER_TOKEN_REVOCATION,
  IUserTokenRevocation,
} from '@aquaculture/backend-common/security';
import { Injectable, Logger, NotFoundException, ConflictException, BadRequestException, Inject } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  type ActivateTenantCommand,
  type ArchiveTenantLifecycleCommand,
  assertTransition,
  createBaseEvent,
  type AssignTenantModulesCommand,
  type AuthTenantCommandMetadata,
  type AuthTenantSnapshot,
  type BeginProvisioningCommand,
  type CreateTenantAdminCommand,
  type DeprovisionTenantCommand,
  type FailProvisioningCommand,
  type RemoveTenantModuleCommand,
  type ReserveTenantCommand,
  type RollbackTenantProvisioningCommand,
  type SetupTenantRolesCommand,
  type SuspendTenantLifecycleCommand,
  type TenantStatusChangedEvent,
  type UserInvitedEvent,
  TenantPlan,
  toTenantPlan,
  resolvePlanLimits,
  isLoginAllowed,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { ActionToken, ActionTokenPurpose, ActionTokenStatus } from '../../authentication/entities/action-token.entity';
import { Invitation, InvitationStatus } from '../../authentication/entities/invitation.entity';
import { User } from '../../authentication/entities/user.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';

interface DefaultTenantRole {
  code: string;
  name: string;
  description: string;
  permissions: string[];
  isDefault: boolean;
  isEditable: boolean;
  displayOrder: number;
}

type RequestedTenantModule = NonNullable<AssignTenantModulesCommand['modules']>[number];

interface TenantCommandReceiptRow<TResult> {
  payloadHash: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  entityId: string | null;
  resultSummary: TResult | null;
}

interface TenantCommandResultBase {
  operationId?: string;
  tenantId?: string;
  status?: string;
}

interface TenantCommandReceiptExecution<TResult> {
  result: TResult;
  replayed: boolean;
}

interface IdRow {
  id: string;
}

interface RelationRow {
  relation: string | null;
}

/**
 * Command → lifecycle authorization (MT-HIGH-003 / W3.3-c). This map is NOT a
 * transition-legality table — that authority is the canonical
 * `TenantStatusMachine` (TENANT_STATUS_TRANSITIONS), the single SSoT consulted
 * via `assertTransition`. This map only narrows WHICH command may drive a given
 * transition: e.g. ActivateTenant completes provisioning (PROVISIONING → ACTIVE)
 * and must NOT reactivate a SUSPENDED/DEACTIVATED/CANCELLED tenant, even though
 * those edges are individually legal in the machine and owned by other flows.
 * By construction every `sources[]` entry is a legal machine edge into `target`;
 * tenant-provisioning-ssot.spec asserts that subset relationship so this map can
 * never drift looser than the machine.
 */
export const LIFECYCLE_COMMANDS: Readonly<
  Record<
    string,
    {
      readonly target: TenantStatus;
      readonly sources: readonly TenantStatus[];
      // Compensation commands the saga issues on failure regardless of the
      // tenant's current state: a no-op (not an error) when invoked from a state
      // outside `sources`.
      readonly tolerant?: boolean;
    }
  >
> = {
  // PENDING → PROVISIONING (saga start) or PROVISIONING_FAILED → PROVISIONING (retry).
  BeginProvisioning: {
    target: TenantStatus.PROVISIONING,
    sources: [TenantStatus.PENDING, TenantStatus.PROVISIONING_FAILED],
  },
  // Provisioning completed: only from the in-flight PROVISIONING state.
  ActivateTenant: {
    target: TenantStatus.ACTIVE,
    sources: [TenantStatus.PROVISIONING],
  },
  // Provisioning failed: a forward transition only from the in-flight
  // PROVISIONING state, but tolerant — the saga's failure handler issues it on
  // any operation failure (incl. before provisioning started or after it
  // succeeded), where it is a no-op rather than an illegal-transition error.
  FailProvisioning: {
    target: TenantStatus.PROVISIONING_FAILED,
    sources: [TenantStatus.PROVISIONING],
    tolerant: true,
  },
  SuspendTenant: {
    target: TenantStatus.SUSPENDED,
    sources: [TenantStatus.ACTIVE],
  },
  DeprovisionTenant: {
    target: TenantStatus.DEACTIVATED,
    sources: [TenantStatus.ACTIVE, TenantStatus.SUSPENDED],
  },
  ArchiveTenant: {
    target: TenantStatus.ARCHIVED,
    sources: [TenantStatus.DEACTIVATED, TenantStatus.CANCELLED],
  },
};

@Injectable()
export class TenantProvisioningCommandService {
  private readonly logger = new Logger(TenantProvisioningCommandService.name);

  private readonly defaultRoles: DefaultTenantRole[] = [
    {
      code: 'TENANT_ADMIN',
      name: 'Tenant Administrator',
      description: 'Full administrative access to all tenant features.',
      permissions: ['*'],
      isDefault: false,
      isEditable: false,
      displayOrder: 1,
    },
  ];

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // DATA-HIGH-001/W3.3: tenant lifecycle + first-admin events are enqueued to
    // auth_outbox inside the command's SERIALIZABLE receipt transaction, so the
    // status write and its event commit atomically (no raw fire-and-forget bus).
    private readonly outboxPublisher: OutboxPublisher,
    // RBAC-HIGH-007: transitioning a tenant OUT of the operational state cuts
    // its users' live access tokens fleet-wide (shared Redis user blacklist —
    // the RBAC-HIGH-001 primitive the gateway already enforces on every request).
    @Inject(USER_TOKEN_REVOCATION)
    private readonly userTokenRevocation: IUserTokenRevocation,
  ) {}

  async reserveTenant(command: ReserveTenantCommand): Promise<{ tenant: AuthTenantSnapshot; status: string }> {
    const execution = await this.runWithReceipt(
      'ReserveTenant',
      command,
      'tenant',
      async (manager) => {
        // Reserve is a create-or-idempotent seed, not a forward transition:
        // allowMissing creates the PENDING row; seed lets an existing still-PENDING
        // row return without a (self-)transition assertion the machine would reject.
        await this.assertTenantTransition(manager, command, [TenantStatus.PENDING], TenantStatus.PENDING, {
          allowMissing: true,
          seed: true,
        });

        const existingBySlug = await manager.findOne(Tenant, {
          where: { slug: command.slug },
        });
        if (existingBySlug && existingBySlug.id !== command.tenantId) {
          throw new ConflictException(`Tenant with slug "${command.slug}" already exists`);
        }

        if (command.customDomain) {
          const existingByDomain = await manager.findOne(Tenant, {
            where: { customDomain: command.customDomain },
          });
          if (existingByDomain && existingByDomain.id !== command.tenantId) {
            throw new ConflictException(`Tenant with domain "${command.customDomain}" already exists`);
          }
        }

        const existing = await manager.findOne(Tenant, {
          where: { id: command.tenantId },
        });
        if (existing) {
          return {
            tenant: this.toTenantSnapshot(existing),
            status: existing.status,
          };
        }

        const tenant = manager.create(Tenant, {
          id: command.tenantId,
          name: command.name,
          slug: command.slug,
          description: command.description ?? null,
          customDomain: command.customDomain ?? null,
          contactEmail: command.contactEmail ?? null,
          contactPhone: command.contactPhone ?? null,
          plan: command.plan as Tenant['plan'],
          status: TenantStatus.PENDING,
          // Fallback to the canonical per-plan user limit (PLAN_CATALOG SSoT)
          // instead of a hardcoded 5, so an omitted maxUsers matches what the
          // tenant's plan actually grants.
          maxUsers:
            command.maxUsers ??
            resolvePlanLimits(toTenantPlan(command.plan) ?? TenantPlan.STARTER)
              .maxUsers,
          maxStorage: command.maxStorage ?? -1,
          // MT-MEDIUM-001: isTrialActive is no longer stored — trial state is
          // derived from trialEndsAt (the SSoT), which is the only trial field
          // the command carries.
          trialEndsAt: command.trialEndsAt ? new Date(command.trialEndsAt) : null,
          settings: command.settings ?? null,
          createdBy: command.createdBy,
          userCount: 0,
        });

        const saved = await manager.save(Tenant, tenant);
        return {
          tenant: this.toTenantSnapshot(saved),
          status: saved.status,
        };
      },
      {
        replay: async (manager) => {
          const tenant = await this.assertTenantExists(command.tenantId, manager);
          return {
            tenant: this.toTenantSnapshot(tenant),
            status: tenant.status,
          };
        },
      },
    );
    return execution.result;
  }

  async setupTenantRoles(command: SetupTenantRolesCommand): Promise<{ rolesCreated: number }> {
    const execution = await this.runWithReceipt(
      'SetupRoles',
      command,
      'tenant_roles',
      async (manager) => {
        await this.assertTenantExists(command.tenantId, manager);
        await this.assertTenantRolesTableExists(manager);

        const roles = command.roles && command.roles.length > 0
          ? command.roles
          : this.defaultRoles;

        let rolesCreated = 0;
        for (const role of roles) {
          const roleRowsRaw: unknown = await manager.query(
            `
            INSERT INTO auth.tenant_roles (
              id, "tenantId", code, name, description, permissions,
              is_default, is_editable, display_order, created_by, created_at, updated_at
            ) VALUES (
              uuid_generate_v4(), $1, $2, $3, $4, $5::jsonb,
              $6, $7, $8, $9, NOW(), NOW()
            )
            ON CONFLICT DO NOTHING
            RETURNING id
            `,
            [
              command.tenantId,
              role.code,
              role.name,
              role.description,
              JSON.stringify(role.permissions),
              role.isDefault,
              role.isEditable,
              role.displayOrder,
              command.createdBy ?? command.actor.id,
            ],
          );
          rolesCreated += this.rowsFromQuery<IdRow>(roleRowsRaw).length;
        }

        return { rolesCreated };
      },
    );
    return execution.result;
  }

  async assignTenantModules(command: AssignTenantModulesCommand): Promise<{ modulesAssigned: number }> {
    const execution = await this.runWithReceipt(
      'AssignModules',
      command,
      'tenant_modules',
      async (manager) => {
        await this.assertTenantExists(command.tenantId, manager);

        const requestedModules: RequestedTenantModule[] = command.modules && command.modules.length > 0
          ? command.modules
          : command.moduleIds.map((moduleId) => ({ moduleId }));
        const moduleIds = Array.from(new Set(requestedModules.map((module) => module.moduleId)));

        if (moduleIds.length === 0) {
          throw new BadRequestException('At least one module must be assigned');
        }

        const existingRowsRaw: unknown = await manager.query(
          `SELECT id FROM auth.modules WHERE id = ANY($1::uuid[])`,
          [moduleIds],
        );
        const existingIds = new Set(
          this.rowsFromQuery<IdRow>(existingRowsRaw).map((row) => row.id),
        );
        const missingIds = moduleIds.filter((moduleId) => !existingIds.has(moduleId));
        if (missingIds.length > 0) {
          throw new NotFoundException(`Modules not found: ${missingIds.join(', ')}`);
        }

        const assignedBy = command.assignedBy ?? command.actor.id;
        let modulesAssigned = 0;
        for (const requested of requestedModules) {
          const quantities = requested.quantities ?? {};
          const configuration = {
            ...(requested.configuration ?? {}),
            quantities,
          };
          const rows: unknown = await manager.query(
            `
            INSERT INTO auth.tenant_modules (
              id, "tenantId", "moduleId", "isEnabled", "activatedAt",
              "assignedBy", "expiresAt", configuration, "createdAt", "updatedAt"
            ) VALUES (
              uuid_generate_v4(), $1, $2, true, NOW(), $3, $4,
              jsonb_build_object('quantities', $5::jsonb), NOW(), NOW()
            )
            ON CONFLICT ("tenantId", "moduleId")
            DO UPDATE SET
              "isEnabled" = true,
              "activatedAt" = NOW(),
              "assignedBy" = EXCLUDED."assignedBy",
              "expiresAt" = EXCLUDED."expiresAt",
              configuration = COALESCE(auth.tenant_modules.configuration, '{}')::jsonb || $5::jsonb,
              "updatedAt" = NOW()
            RETURNING id
            `,
            [
              command.tenantId,
              requested.moduleId,
              assignedBy,
              requested.expiresAt ? new Date(requested.expiresAt) : null,
              JSON.stringify(configuration),
            ],
          );
          modulesAssigned += Array.isArray(rows) ? rows.length : 0;
        }

        return { modulesAssigned };
      },
    );
    return execution.result;
  }

  async removeTenantModule(command: RemoveTenantModuleCommand): Promise<{ modulesRemoved: number }> {
    const execution = await this.runWithReceipt(
      'RemoveModule',
      command,
      'tenant_modules',
      async (manager) => {
        await this.assertTenantExists(command.tenantId, manager);

        const rows: unknown = await manager.query(
          `
          UPDATE auth.tenant_modules
          SET "isEnabled" = false,
              "updatedAt" = NOW()
          WHERE "tenantId" = $1
            AND "moduleId" = $2
            AND "isEnabled" = true
          RETURNING id
          `,
          [command.tenantId, command.moduleId],
        );

        return { modulesRemoved: this.rowCount(rows) };
      },
    );
    return execution.result;
  }

  async createTenantAdmin(command: CreateTenantAdminCommand): Promise<{
    userId: string;
    invitationId?: string;
    email: string;
  }> {
    const execution = await this.runWithReceipt(
      'CreateFirstAdminInvite',
      command,
      'invitations',
      async (manager) => {
        await this.assertTenantExists(command.tenantId, manager);
        const normalisedEmail = command.email.toLowerCase();

        const existingUser = await manager.findOne(User, {
          where: { email: normalisedEmail },
        });
        if (existingUser) {
          if (existingUser.tenantId === command.tenantId && existingUser.role === Role.TENANT_ADMIN) {
            const invitation = await manager.findOne(Invitation, {
              where: { userId: existingUser.id, tenantId: command.tenantId },
              order: { createdAt: 'DESC' },
            });
            const actionTokenId = invitation
              ? await this.ensureInvitationActionToken(manager, {
                  tenantId: command.tenantId,
                  userId: existingUser.id,
                  tokenHash: invitation.token,
                  expiresAt: invitation.expiresAt,
                  source: 'first-admin-invite-replay',
                })
              : undefined;
            // Re-notify (re-send invite) only when a deliverable invitation
            // token exists. A pre-existing admin with no recoverable token has
            // nothing to deliver, so skip the event rather than throw — the
            // enqueue is atomic with the token refresh above via `manager`.
            if (actionTokenId) {
              await this.enqueueFirstAdminInvite(manager, command, existingUser.id, actionTokenId);
            }
            return {
              userId: existingUser.id,
              invitationId: invitation?.id,
              actionTokenId,
              email: existingUser.email,
            };
          }
          throw new ConflictException(`User with email "${command.email}" already exists`);
        }

        const rawInvitationToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = this.hashToken(rawInvitationToken);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const invitedBy = command.invitedBy ?? command.actor.id;

        const user = manager.create(User, {
          email: normalisedEmail,
          firstName: command.firstName,
          lastName: command.lastName,
          role: Role.TENANT_ADMIN,
          tenantId: command.tenantId,
          isActive: true,
          isEmailVerified: false,
          invitationToken: tokenHash,
          invitationExpiresAt: expiresAt,
          invitedBy,
        });
        const savedUser = await manager.save(User, user);

        const invitation = manager.create(Invitation, {
          token: tokenHash,
          email: normalisedEmail,
          firstName: command.firstName,
          lastName: command.lastName,
          role: Role.TENANT_ADMIN,
          tenantId: command.tenantId,
          status: InvitationStatus.PENDING,
          expiresAt,
          userId: savedUser.id,
          invitedBy,
          sendCount: 1,
          lastSentAt: new Date(),
        });
        const savedInvitation = await manager.save(Invitation, invitation);
        const actionToken = manager.create(ActionToken, {
          purpose: ActionTokenPurpose.INVITATION,
          tenantId: command.tenantId,
          userId: savedUser.id,
          tokenHash,
          status: ActionTokenStatus.ACTIVE,
          expiresAt,
          auditMetadata: {
            source: 'first-admin-invite',
            operationId: command.operationId,
          },
        });
        const savedActionToken = await manager.save(ActionToken, actionToken);

        await manager.query(
          `UPDATE auth.tenants
              SET user_count = (
                SELECT COUNT(*)::int FROM auth.users WHERE "tenantId" = $1
              ),
              "updatedAt" = NOW()
            WHERE id = $1`,
          [command.tenantId],
        );

        // Durable, atomic-with-the-write UserInvited (replaces the post-commit
        // raw eventBus.publish). The invitation/user/actionToken rows and this
        // event commit together in the SERIALIZABLE receipt transaction.
        await this.enqueueFirstAdminInvite(manager, command, savedUser.id, savedActionToken.id);

        return {
          userId: savedUser.id,
          invitationId: savedInvitation.id,
          actionTokenId: savedActionToken.id,
          email: normalisedEmail,
        };
      },
      {
        replay: (manager) => this.getExistingFirstAdminInviteResult(manager, command),
      },
    );
    const result = execution.result;

    this.logger.log(`Created first tenant admin userId=${result.userId} tenantId=${command.tenantId}`);
    return {
      userId: result.userId,
      invitationId: result.invitationId,
      email: result.email,
    };
  }

  async rollbackTenantProvisioning(command: RollbackTenantProvisioningCommand): Promise<{
    removedUsers: number;
    removedInvitations: number;
    removedRoles: number;
    removedModules: number;
  }> {
    const execution = await this.runWithReceipt(
      'RollbackProvisioning',
      command,
      'tenant',
      async (manager) => {
        const result = {
          removedUsers: 0,
          removedInvitations: 0,
          removedRoles: 0,
          removedModules: 0,
        };

        if (command.completedSteps.includes('create_admin')) {
          const invitations: unknown = await manager.query(
            `DELETE FROM auth.invitations WHERE "tenantId" = $1 RETURNING id`,
            [command.tenantId],
          );
          const users: unknown = await manager.query(
            `DELETE FROM auth.users WHERE "tenantId" = $1 AND role = $2 RETURNING id`,
            [command.tenantId, Role.TENANT_ADMIN],
          );
          result.removedInvitations = this.rowCount(invitations);
          result.removedUsers = this.rowCount(users);
        }

        if (command.completedSteps.includes('setup_roles')) {
          const roles: unknown = await manager.query(
            `DELETE FROM auth.tenant_roles WHERE "tenantId" = $1 RETURNING id`,
            [command.tenantId],
          );
          result.removedRoles = this.rowCount(roles);
        }

        if (command.completedSteps.includes('assign_modules')) {
          const modules: unknown = await manager.query(
            `DELETE FROM auth.tenant_modules WHERE "tenantId" = $1 RETURNING id`,
            [command.tenantId],
          );
          result.removedModules = this.rowCount(modules);
        }

        if (command.completedSteps.includes('activate_tenant')) {
          await manager.query(
            `UPDATE auth.tenants SET status = 'PENDING', "updatedAt" = NOW() WHERE id = $1`,
            [command.tenantId],
          );
        }

        await manager.query(
          `UPDATE auth.tenants
              SET user_count = (
                SELECT COUNT(*)::int FROM auth.users WHERE "tenantId" = $1
              ),
              "updatedAt" = NOW()
            WHERE id = $1`,
          [command.tenantId],
        );

        return result;
      },
    );
    const removed = execution.result;

    this.logger.warn(
      `Rolled back tenant auth provisioning tenantId=${command.tenantId} reason=${command.reason}`,
    );
    return removed;
  }

  async beginProvisioning(command: BeginProvisioningCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus('BeginProvisioning', command, TenantStatus.PROVISIONING);
  }

  async activateTenant(command: ActivateTenantCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus('ActivateTenant', command, TenantStatus.ACTIVE);
  }

  async failProvisioning(command: FailProvisioningCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus(
      'FailProvisioning',
      command,
      TenantStatus.PROVISIONING_FAILED,
      command.reason,
    );
  }

  async suspendTenant(command: SuspendTenantLifecycleCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus('SuspendTenant', command, TenantStatus.SUSPENDED, command.reason);
  }

  async deprovisionTenant(command: DeprovisionTenantCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus(
      'DeprovisionTenant',
      command,
      TenantStatus.DEACTIVATED,
      command.reason,
    );
  }

  async archiveTenant(command: ArchiveTenantLifecycleCommand): Promise<TenantCommandResultBase> {
    return this.transitionTenantStatus('ArchiveTenant', command, TenantStatus.ARCHIVED, command.reason);
  }

  private async assertTenantExists(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<Tenant> {
    const tenant = manager
      ? await manager.findOne(Tenant, { where: { id: tenantId } })
      : await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID "${tenantId}" not found`);
    }
    return tenant;
  }

  private async assertTenantRolesTableExists(manager?: EntityManager): Promise<void> {
    const rowsRaw: unknown = await (manager ?? this.dataSource).query(
      `SELECT to_regclass('"auth"."tenant_roles"') AS relation`,
    );
    const relation = this.rowsFromQuery<RelationRow>(rowsRaw)[0]?.relation;
    if (!relation) {
      throw new Error('auth.tenant_roles is missing; run auth migrations before tenant provisioning');
    }
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private rowCount(rows: unknown): number {
    return Array.isArray(rows) ? rows.length : 0;
  }

  private rowsFromQuery<TRow extends object>(rows: unknown): TRow[] {
    return Array.isArray(rows) ? (rows as TRow[]) : [];
  }

  private async transitionTenantStatus(
    commandType: string,
    command: AuthTenantCommandMetadata,
    targetStatus: TenantStatus,
    reason?: string,
  ): Promise<TenantCommandResultBase> {
    const lifecycle = LIFECYCLE_COMMANDS[commandType];
    if (!lifecycle) {
      throw new BadRequestException(`Unsupported tenant lifecycle command=${commandType}`);
    }
    if (lifecycle.target !== targetStatus) {
      // Defensive: the handler's declared target must match the command's
      // single authorized target in lifecycleCommands.
      throw new BadRequestException(
        `Lifecycle command ${commandType} targets ${lifecycle.target}, not ${targetStatus}`,
      );
    }
    // RBAC-HIGH-007: users locked out by THIS live execution (closure, not part
    // of the receipt result — an idempotent replay must not re-blacklist).
    const lockedOutUserIds: string[] = [];
    const execution = await this.runWithReceipt(
      commandType,
      command,
      'tenant',
      async (manager) => {
        const { tenant, transition } = await this.assertTenantTransition(
          manager,
          command,
          lifecycle.sources,
          targetStatus,
          { tolerant: lifecycle.tolerant },
        );
        const previousStatus = tenant.status;

        // No-op when the tenant is already at the target (idempotent re-issue) or
        // when a tolerant compensation command (FailProvisioning) is invoked from
        // a non-authorized state — persist nothing and emit no status-change event
        // so the receipt still succeeds without a spurious transition.
        if (!transition) {
          return {
            operationId: command.operationId,
            tenantId: command.tenantId,
            status: tenant.status,
            previousStatus,
            reason,
          };
        }

        tenant.status = targetStatus;

        // Suspension audit trio (DB-ADMIN-HIGH-003): persisted atomically with
        // the status write by the single writer of auth.tenants. The SUSPENDED
        // transition records when/why/who (actor.id travels on every lifecycle
        // command via AuthTenantCommandMetadata); the ACTIVE transition clears
        // all three because an active tenant is, by definition, not suspended.
        // Other targets (DEACTIVATED/ARCHIVED/…) deliberately leave the trio
        // untouched so a tenant deactivated OUT of suspension keeps the audit
        // trail of its last suspension.
        if (targetStatus === TenantStatus.SUSPENDED) {
          tenant.suspendedAt = new Date();
          tenant.suspendedReason = reason ?? null;
          tenant.suspendedBy = command.actor.id;
        } else if (targetStatus === TenantStatus.ACTIVE) {
          tenant.suspendedAt = null;
          tenant.suspendedReason = null;
          tenant.suspendedBy = null;
        }

        await manager.save(Tenant, tenant);

        // Durable TenantStatusChanged, atomic with the status write. The local
        // lifecycle handlers previously emitted nothing on transition (events
        // were dropped on the live path); routing through auth_outbox here is
        // the single emission point for all five lifecycle transitions and
        // commits in the same SERIALIZABLE receipt transaction.
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent<TenantStatusChangedEvent>('TenantStatusChanged', command.tenantId, {
              aggregateId: command.tenantId,
              aggregateType: 'Tenant',
            }),
            previousStatus,
            newStatus: targetStatus,
            reason,
          },
          manager,
          {
            aggregateId: command.tenantId,
            idempotencyKey: `${command.operationId}:${commandType}:TenantStatusChanged`,
          },
        );

        // RBAC-HIGH-007: a transition OUT of the operational state (SUSPENDED /
        // DEACTIVATED / CANCELLED / ARCHIVED / PURGED — anything the
        // isLoginAllowed SSoT rejects) must terminate the tenant's live
        // sessions NOW, not at natural token expiry. Before this, suspend
        // flipped the status + emitted the event but revoked nothing: every
        // logged-in user kept full access and silently rotated new tokens for
        // the refresh-token lifetime (days). The refresh-token kill is atomic
        // with the status write (same SERIALIZABLE receipt transaction — a
        // rolled-back suspend revokes nothing). The tx-local tenant GUC gives
        // the RLS policy on auth.refresh_tokens exactly this tenant's rows —
        // tenant-SCOPED context, not a bypass; the lifecycle command arrives
        // over NATS with no request tenant context.
        if (!isLoginAllowed(targetStatus)) {
          const userRows = this.rowsFromQuery<{ id: string }>(await manager.query(
            `SELECT id FROM "auth"."users" WHERE "tenantId" = $1`,
            [command.tenantId],
          ));
          lockedOutUserIds.push(...userRows.map((row) => row.id));
          if (lockedOutUserIds.length > 0) {
            await manager.query(
              `SELECT set_config('app.current_tenant', $1, true)`,
              [command.tenantId],
            );
            await manager.query(
              `UPDATE "auth"."refresh_tokens"
                  SET "isRevoked" = true, "revokedAt" = NOW(), "revokedReason" = $2
                WHERE "userId" = ANY($1::uuid[])
                  AND "isRevoked" = false`,
              [lockedOutUserIds, `Tenant ${targetStatus}`],
            );
          }
        }

        return {
          operationId: command.operationId,
          tenantId: command.tenantId,
          status: targetStatus,
          previousStatus,
          reason,
        };
      },
    );

    // Post-commit: cut LIVE access tokens fleet-wide via the shared Redis user
    // blacklist (the gateway rejects blacklisted users on their next request).
    // Deliberately outside the transaction — Redis is not transactional — and
    // deliberately non-fatal per user: the durable guarantee is the in-tx
    // refresh-token revocation above plus the refresh-path tenant gate; access
    // tokens self-expire within their ≤15-minute TTL even if Redis is down.
    for (const userId of lockedOutUserIds) {
      try {
        await this.userTokenRevocation.revokeUserTokens(userId);
      } catch (err) {
        this.logger.warn(
          `Access-token blacklist failed for userId=${userId} after ${commandType} on tenant ${command.tenantId}: ${(err as Error).message}`,
        );
      }
    }

    return execution.result;
  }

  private async assertTenantTransition(
    manager: EntityManager,
    command: AuthTenantCommandMetadata,
    authorizedSources: readonly TenantStatus[],
    targetStatus: TenantStatus,
    options: { allowMissing?: boolean; seed?: boolean; tolerant?: boolean } = {},
  ): Promise<{ tenant: Tenant; transition: boolean }> {
    const tenant = await manager.findOne(Tenant, {
      where: { id: command.tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!tenant) {
      if (options.allowMissing) {
        return {
          tenant: manager.create(Tenant, { id: command.tenantId, status: targetStatus }),
          transition: true,
        };
      }
      throw new NotFoundException(`Tenant with ID "${command.tenantId}" not found`);
    }

    // Idempotent re-issue: the tenant is already at the desired end-state — a
    // success no-op (retried ActivateTenant on an ACTIVE tenant, re-issued
    // FailProvisioning on an already-PROVISIONING_FAILED tenant), not a
    // transition. Never re-emit a status change for an unchanged status.
    if (tenant.status === targetStatus) {
      return { tenant, transition: false };
    }

    // Seed path (ReserveTenant re-reserve): an existing row must still be in an
    // authorized source; there is no forward transition to validate or persist.
    if (options.seed) {
      if (!authorizedSources.includes(tenant.status)) {
        throw new BadRequestException(
          `Tenant ${command.tenantId} already exists with status ${tenant.status}; cannot re-reserve`,
        );
      }
      return { tenant, transition: false };
    }

    // Command authorization (W3.3-c): this command may only act from one of its
    // declared source states — a deliberate narrowing of the machine's incoming
    // edges so e.g. ActivateTenant cannot reactivate a SUSPENDED tenant.
    if (!authorizedSources.includes(tenant.status)) {
      // Tolerant compensation (FailProvisioning): the saga issues it on any
      // operation failure, regardless of how far the tenant got. From a state it
      // is not authorized to fail (PENDING never provisioned, ACTIVE already
      // succeeded) it is a no-op, not an error — the run-level FAILED state
      // already records the failure.
      if (options.tolerant) {
        return { tenant, transition: false };
      }
      throw new BadRequestException(
        `Tenant ${command.tenantId} is ${tenant.status}; this command requires one of ` +
          `[${authorizedSources.join(', ')}] to reach ${targetStatus}`,
      );
    }

    // Edge-legality SSoT (MT-HIGH-003): the canonical TenantStatusMachine is the
    // single authority on whether from->to is a legal lifecycle transition. The
    // authorizedSources above are a subset of its incoming edges, so this only
    // ever throws on real drift; wrap its Error in a 400 so a caller-illegal
    // transition stays a client error rather than a 500.
    try {
      assertTransition(tenant.status, targetStatus);
    } catch (error) {
      throw new BadRequestException(
        `Invalid tenant transition for ${command.tenantId}: ${tenant.status} -> ` +
          `${targetStatus} (${(error as Error).message})`,
      );
    }

    return { tenant, transition: true };
  }

  private async runWithReceipt<TResult>(
    commandType: string,
    command: AuthTenantCommandMetadata,
    entityType: string,
    work: (manager: EntityManager) => Promise<TResult>,
    options: {
      replay?: (manager: EntityManager) => Promise<TResult>;
      toSummary?: (result: TResult) => unknown;
      entityId?: (result: TResult) => string | null;
    } = {},
  ): Promise<TenantCommandReceiptExecution<TResult>> {
    this.assertCommandMetadata(commandType, command);
    const canonicalPayloadHash = this.hashCommandPayload(commandType, command);
    const receiptIdempotencyKey = this.receiptIdempotencyKey(
      commandType,
      command,
      canonicalPayloadHash,
    );

    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      // ORPHAN-CRITICAL-573 — bind the RLS tenant context before the FIRST
      // statement of the receipt lifecycle.
      //
      // `auth.tenant_command_receipts` carries the standard isolation policy:
      // a row is visible/writable only under `app.bypass_rls=on` or when
      // `app.current_tenant` equals its `tenantId`. This transaction ran with
      // NEITHER, so every INSERT here was refused — and because the receipt is
      // written before any provisioning step executes, EVERY tenant creation
      // failed at step zero. Production carried two tenants stuck in PENDING
      // with no schema for months as a result.
      //
      // Tenant-SCOPED, not a bypass: the receipt belongs to exactly this
      // tenant, so the policy is satisfied honestly rather than switched off.
      // Third argument `true` makes the setting transaction-local, so a pooled
      // connection cannot carry this tenant into the next caller's query -
      // the failure mode that makes a bypass here unacceptable.
      await bindTenantRlsContext(manager, command.tenantId, 'auth');

      const receiptRowsRaw: unknown = await manager.query(
        `SELECT "payloadHash", status, "entityId", "resultSummary"
           FROM auth.tenant_command_receipts
          WHERE "operationId" = $1
            AND "tenantId" = $2
            AND "commandType" = $3
            AND "idempotencyKey" = $4
          FOR UPDATE`,
        [command.operationId, command.tenantId, commandType, receiptIdempotencyKey],
      );
      const receiptRows = this.rowsFromQuery<TenantCommandReceiptRow<TResult>>(receiptRowsRaw);

      const existing = receiptRows[0];
      if (existing) {
        if (existing.payloadHash !== canonicalPayloadHash) {
          throw new ConflictException(
            `${commandType} idempotency key was reused with a different payload`,
          );
        }
        if (existing.status === 'SUCCEEDED') {
          if (options.replay) {
            return {
              result: await options.replay(manager),
              replayed: true,
            };
          }
          if (existing.resultSummary !== null) {
            return {
              result: existing.resultSummary,
              replayed: true,
            };
          }
        }
      } else {
        await manager.query(
          `INSERT INTO auth.tenant_command_receipts (
             id, "operationId", "tenantId", "commandType", "entityType",
             "idempotencyKey", "payloadHash", status, actor, "auditMetadata",
             "createdAt", "updatedAt"
           ) VALUES (
             uuid_generate_v4(), $1, $2, $3, $4,
             $5, $6, 'STARTED', $7::jsonb, $8::jsonb,
             now(), now()
           )`,
          [
            command.operationId,
            command.tenantId,
            commandType,
            entityType,
            receiptIdempotencyKey,
            canonicalPayloadHash,
            JSON.stringify(command.actor),
            JSON.stringify(command.auditMetadata ?? {}),
          ],
        );
      }

      try {
        const result = await work(manager);
        const resultHash = this.hashValue(result);
        const resultSummary = options.toSummary
          ? options.toSummary(result)
          : this.toReceiptResultSummary(result);
        await manager.query(
          `UPDATE auth.tenant_command_receipts
              SET "entityId" = $5,
                  status = 'SUCCEEDED',
                  "resultHash" = $6,
                  "resultSummary" = $7::jsonb,
                  error = NULL,
                  "completedAt" = now(),
                  "updatedAt" = now()
            WHERE "operationId" = $1
              AND "tenantId" = $2
              AND "commandType" = $3
              AND "idempotencyKey" = $4`,
          [
            command.operationId,
            command.tenantId,
            commandType,
            receiptIdempotencyKey,
            options.entityId?.(result)
              ?? (this.isRecord(result) && typeof result['userId'] === 'string'
                ? result['userId']
                : command.tenantId),
            resultHash,
            JSON.stringify(resultSummary),
          ],
        );

        return { result, replayed: false };
      } catch (error) {
        await manager.query(
          `UPDATE auth.tenant_command_receipts
              SET status = 'FAILED',
                  error = $5,
                  "completedAt" = now(),
                  "updatedAt" = now()
            WHERE "operationId" = $1
              AND "tenantId" = $2
              AND "commandType" = $3
              AND "idempotencyKey" = $4`,
          [
            command.operationId,
            command.tenantId,
            commandType,
            receiptIdempotencyKey,
            error instanceof Error ? error.message : String(error),
          ],
        );
        throw error;
      }
    });
  }

  private assertCommandMetadata(
    commandType: string,
    command: AuthTenantCommandMetadata,
  ): void {
    const missing = [
      ['operationId', command.operationId],
      ['tenantId', command.tenantId],
      ['actor.id', command.actor?.id],
    ].filter(([, value]) => typeof value !== 'string' || value.length === 0);

    if (missing.length > 0) {
      throw new BadRequestException(
        `${commandType} missing required metadata: ${missing.map(([name]) => name).join(', ')}`,
      );
    }
  }

  private async ensureInvitationActionToken(
    manager: EntityManager,
    input: {
      tenantId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      source: string;
    },
  ): Promise<string> {
    const existing = await manager.findOne(ActionToken, {
      where: {
        tenantId: input.tenantId,
        userId: input.userId,
        purpose: ActionTokenPurpose.INVITATION,
        tokenHash: input.tokenHash,
        status: ActionTokenStatus.ACTIVE,
      },
    });
    if (existing && existing.isActive()) {
      return existing.id;
    }

    const actionToken = manager.create(ActionToken, {
      purpose: ActionTokenPurpose.INVITATION,
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      status: ActionTokenStatus.ACTIVE,
      expiresAt: input.expiresAt,
      auditMetadata: {
        source: input.source,
      },
    });
    const saved = await manager.save(ActionToken, actionToken);
    return saved.id;
  }

  private async getExistingFirstAdminInviteResult(
    manager: EntityManager,
    command: CreateTenantAdminCommand,
  ): Promise<{
    userId: string;
    invitationId?: string;
    actionTokenId?: string;
    email: string;
  }> {
    const normalisedEmail = command.email.toLowerCase();
    const existingUser = await manager.findOne(User, {
      where: {
        email: normalisedEmail,
        tenantId: command.tenantId,
        role: Role.TENANT_ADMIN,
      },
    });

    if (!existingUser) {
      throw new NotFoundException(
        `First admin user for tenant "${command.tenantId}" was not found for invite replay`,
      );
    }

    const invitation = await manager.findOne(Invitation, {
      where: { userId: existingUser.id, tenantId: command.tenantId },
      order: { createdAt: 'DESC' },
    });

    return {
      userId: existingUser.id,
      invitationId: invitation?.id,
      actionTokenId: invitation
        ? await this.ensureInvitationActionToken(manager, {
            tenantId: command.tenantId,
            userId: existingUser.id,
            tokenHash: invitation.token,
            expiresAt: invitation.expiresAt,
            source: 'first-admin-invite-replay',
          })
        : undefined,
      email: existingUser.email,
    };
  }

  /**
   * Enqueue the durable UserInvited event for a first-admin invite, atomic with
   * the user/invitation/action-token writes via the receipt transaction's
   * `manager`. Only opaque references travel on the event (actionTokenId, userId,
   * role) — the notification service resolves PII at delivery time.
   */
  private async enqueueFirstAdminInvite(
    manager: EntityManager,
    command: CreateTenantAdminCommand,
    userId: string,
    actionTokenId: string,
  ): Promise<void> {
    await this.outboxPublisher.enqueue(
      {
        ...createBaseEvent<UserInvitedEvent>('UserInvited', command.tenantId, {
          aggregateId: userId,
          aggregateType: 'User',
        }),
        userId,
        role: Role.TENANT_ADMIN,
        invitedBy: command.invitedBy ?? command.actor.id,
        credentialType: 'reset_token',
        actionTokenId,
        cryptoShredKeyId: userId,
      },
      manager,
      { aggregateId: userId, idempotencyKey: `${command.operationId}:UserInvited` },
    );
  }

  private toReceiptResultSummary(result: unknown): unknown {
    if (!this.isRecord(result)) {
      return result;
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      if (this.isSensitiveReceiptKey(key)) {
        continue;
      }

      if (this.isRecord(value)) {
        redacted[key] = this.toReceiptResultSummary(value);
      } else if (Array.isArray(value)) {
        redacted[key] = value.map((item) => this.toReceiptResultSummary(item));
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private isSensitiveReceiptKey(key: string): boolean {
    const normalized = key.toLowerCase();
    if (normalized === 'actiontokenid') {
      return false;
    }
    return (
      normalized.includes('email') ||
      normalized.includes('phone') ||
      normalized.includes('settings') ||
      normalized.includes('contact') ||
      normalized.includes('token')
    );
  }

  private toTenantSnapshot(tenant: Tenant): AuthTenantSnapshot {
    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      plan: tenant.plan,
      customDomain: tenant.customDomain ?? null,
      contactEmail: tenant.contactEmail ?? null,
      contactPhone: tenant.contactPhone ?? null,
      settings: tenant.settings ?? null,
      createdAt: tenant.createdAt?.toISOString(),
      updatedAt: tenant.updatedAt?.toISOString(),
    };
  }

  private hashValue(value: unknown): string {
    return crypto.createHash('sha256').update(this.stableStringify(value)).digest('hex');
  }

  private hashCommandPayload(
    commandType: string,
    command: AuthTenantCommandMetadata,
  ): string {
    const {
      auditMetadata: _auditMetadata,
      requestReference: _requestReference,
      ...canonical
    } = command;
    return this.hashValue({
      commandType,
      ...canonical,
    });
  }

  private receiptIdempotencyKey(
    commandType: string,
    command: AuthTenantCommandMetadata,
    canonicalPayloadHash: string,
  ): string {
    return `${command.operationId}:${command.tenantId}:${commandType}:${canonicalPayloadHash}`;
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (this.isRecord(value)) {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
    }

    return JSON.stringify(value);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
