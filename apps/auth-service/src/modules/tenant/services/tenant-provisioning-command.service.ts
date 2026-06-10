import * as crypto from 'crypto';

import { Role } from '@aquaculture/backend-common/decorators';
import { Inject, Injectable, Logger, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { IEventBus } from '@platform/event-bus';
import {
  type ActivateTenantCommand,
  type ArchiveTenantLifecycleCommand,
  createBaseEvent,
  type AssignTenantModulesCommand,
  type AuthTenantCommandMetadata,
  type AuthTenantSnapshot,
  type CreateTenantAdminCommand,
  type DeprovisionTenantCommand,
  type FailProvisioningCommand,
  type RemoveTenantModuleCommand,
  type ReserveTenantCommand,
  type RollbackTenantProvisioningCommand,
  type SetupTenantRolesCommand,
  type SuspendTenantLifecycleCommand,
  type UserInvitedEvent,
} from '@platform/event-contracts';
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

  private readonly lifecycleTransitionPolicy: Readonly<Record<string, Readonly<Record<string, readonly TenantStatus[]>>>> = {
    ActivateTenant: {
      [TenantStatus.ACTIVE]: [
        TenantStatus.PENDING,
        TenantStatus.PROVISIONING,
        TenantStatus.PROVISIONING_FAILED,
      ],
    },
    FailProvisioning: {
      [TenantStatus.PROVISIONING_FAILED]: [
        TenantStatus.PENDING,
        TenantStatus.PROVISIONING,
        TenantStatus.ACTIVE,
        TenantStatus.PROVISIONING_FAILED,
      ],
    },
    SuspendTenant: {
      [TenantStatus.SUSPENDED]: [
        TenantStatus.ACTIVE,
      ],
    },
    DeprovisionTenant: {
      [TenantStatus.DEACTIVATED]: [
        TenantStatus.ACTIVE,
        TenantStatus.SUSPENDED,
        TenantStatus.PROVISIONING_FAILED,
        TenantStatus.CANCELLED,
      ],
      [TenantStatus.CANCELLED]: [
        TenantStatus.ACTIVE,
        TenantStatus.SUSPENDED,
        TenantStatus.PROVISIONING_FAILED,
        TenantStatus.DEACTIVATED,
      ],
    },
    ArchiveTenant: {
      [TenantStatus.ARCHIVED]: [
        TenantStatus.DEACTIVATED,
        TenantStatus.CANCELLED,
      ],
    },
  };

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus,
  ) {}

  async reserveTenant(command: ReserveTenantCommand): Promise<{ tenant: AuthTenantSnapshot; status: string }> {
    const execution = await this.runWithReceipt(
      'ReserveTenant',
      command,
      'tenant',
      async (manager) => {
        await this.assertTenantTransition(manager, command, [TenantStatus.PENDING], TenantStatus.PENDING, {
          allowMissing: true,
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
          maxUsers: command.maxUsers ?? 5,
          maxStorage: command.maxStorage ?? -1,
          isTrialActive: command.isTrialActive ?? false,
          trialEndsAt: command.trialEndsAt ? new Date(command.trialEndsAt) : null,
          settings: command.settings ?? null,
          createdBy: command.createdBy,
          userCount: 0,
          farmCount: 0,
          sensorCount: 0,
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

    if (!execution.replayed) {
      const event: UserInvitedEvent = {
        ...createBaseEvent<UserInvitedEvent>('UserInvited', command.tenantId, {
          aggregateId: result.userId,
          aggregateType: 'User',
        }),
        userId: result.userId,
        role: Role.TENANT_ADMIN,
        invitedBy: command.invitedBy ?? command.actor.id,
        credentialType: 'reset_token',
        actionTokenId: this.requireActionTokenId(result.actionTokenId),
        cryptoShredKeyId: result.userId,
      };
      await this.eventBus.publish(event);
    }

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
    targetStatus: TenantStatus | string,
    reason?: string,
  ): Promise<TenantCommandResultBase> {
    const allowedFrom = this.getAllowedLifecycleTransition(commandType, targetStatus);
    const execution = await this.runWithReceipt(
      commandType,
      command,
      'tenant',
      async (manager) => {
        const tenant = await this.assertTenantTransition(manager, command, allowedFrom, targetStatus);
        const previousStatus = tenant.status;

        tenant.status = targetStatus as TenantStatus;
        await manager.save(Tenant, tenant);

        return {
          operationId: command.operationId,
          tenantId: command.tenantId,
          status: targetStatus,
          previousStatus,
          reason,
        };
      },
    );
    return execution.result;
  }

  private async assertTenantTransition(
    manager: EntityManager,
    command: AuthTenantCommandMetadata,
    defaultFrom: readonly (TenantStatus | string)[] | undefined,
    targetStatus: TenantStatus | string,
    options: { allowMissing?: boolean } = {},
  ): Promise<Tenant> {
    const tenant = await manager.findOne(Tenant, {
      where: { id: command.tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!tenant) {
      if (options.allowMissing) {
        return manager.create(Tenant, {
          id: command.tenantId,
          status: targetStatus as TenantStatus,
        });
      }
      throw new NotFoundException(`Tenant with ID "${command.tenantId}" not found`);
    }

    const allowedFrom = defaultFrom;
    if (allowedFrom && !allowedFrom.includes(tenant.status)) {
      throw new BadRequestException(
        `Invalid tenant transition for ${command.tenantId}: ${tenant.status} -> ${targetStatus}`,
      );
    }

    return tenant;
  }

  private getAllowedLifecycleTransition(
    commandType: string,
    targetStatus: TenantStatus | string,
  ): readonly TenantStatus[] {
    const allowedFrom = this.lifecycleTransitionPolicy[commandType]?.[targetStatus];
    if (!allowedFrom) {
      throw new BadRequestException(
        `Unsupported tenant lifecycle transition command=${commandType} target=${targetStatus}`,
      );
    }
    return allowedFrom;
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

  private requireActionTokenId(actionTokenId: string | undefined): string {
    if (!actionTokenId) {
      throw new Error('First-admin invitation handoff did not produce an auth.action_tokens id');
    }
    return actionTokenId;
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
