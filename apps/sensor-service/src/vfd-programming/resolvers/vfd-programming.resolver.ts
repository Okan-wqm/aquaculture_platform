import { UseGuards } from '@nestjs/common';
import { Resolver, Query, Mutation, Args, ID, Int } from '@nestjs/graphql';
import { Roles, Role, Tenant, CurrentUser, CurrentUserPayload } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { GraphQLJSON } from 'graphql-scalars';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { VfdParameterDefinition } from '../entities/vfd-parameter-definition.entity';
import { VfdChangeSet } from '../entities/vfd-change-set.entity';
import { VfdParameterAuditLog } from '../entities/vfd-parameter-audit-log.entity';
import { VfdChangeSetStatus } from '../../vfd/entities/vfd.enums';
import { VfdParameterDefinitionService } from '../services/vfd-parameter-definition.service';
import { VfdChangeSetService } from '../services/vfd-change-set.service';
import { VfdParameterWriterService } from '../services/vfd-parameter-writer.service';
import {
  CreateChangeSetInput,
  ChangeSetItemInput,
  RejectChangeSetInput,
  RollbackChangeSetInput,
} from '../dto';

/**
 * VFD Programming GraphQL Resolver
 * Provides queries and mutations for VFD parameter management,
 * change set workflow (Maker-Checker), and audit trail.
 */
@Resolver()
@UseGuards(TenantGuard)
export class VfdProgrammingResolver {
  constructor(
    private readonly parameterDefinitionService: VfdParameterDefinitionService,
    private readonly changeSetService: VfdChangeSetService,
    private readonly parameterWriterService: VfdParameterWriterService,
    @InjectRepository(VfdParameterAuditLog)
    private readonly auditLogRepository: Repository<VfdParameterAuditLog>,
  ) {}

  // ─── PARAMETER DEFINITION QUERIES ──────────────────────────────────

  @Query(() => [VfdParameterDefinition], { name: 'vfdParameterDefinitions' })
  async getParameterDefinitions(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('group', { type: () => String, nullable: true }) group: string | null,
    @Tenant() tenantId: string,
  ): Promise<VfdParameterDefinition[]> {
    const definitions = await this.parameterDefinitionService.getDefinitionsForDevice(
      vfdDeviceId,
      tenantId,
    );

    if (group) {
      return definitions.filter((d) => d.group === group);
    }

    return definitions;
  }

  // ─── CHANGE SET QUERIES ────────────────────────────────────────────

  @Query(() => [VfdChangeSet], { name: 'vfdChangeSets' })
  async getChangeSets(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('status', { type: () => VfdChangeSetStatus, nullable: true }) status: VfdChangeSetStatus | null,
    @Args('limit', { type: () => Int, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset: number,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet[]> {
    const result = await this.changeSetService.findByDevice(
      tenantId,
      vfdDeviceId,
      status ?? undefined,
      limit,
      offset,
    );

    return result.items;
  }

  @Query(() => VfdChangeSet, { name: 'vfdChangeSet', nullable: true })
  async getChangeSet(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet | null> {
    return this.changeSetService.findById(id, tenantId);
  }

  // ─── AUDIT LOG QUERY ──────────────────────────────────────────────

  @Query(() => [VfdParameterAuditLog], { name: 'vfdParameterAuditLog' })
  async getParameterAuditLog(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('parameterName', { type: () => String, nullable: true }) parameterName: string | null,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit: number,
    @Tenant() tenantId: string,
  ): Promise<VfdParameterAuditLog[]> {
    const where: Record<string, unknown> = { tenantId, vfdDeviceId };

    if (parameterName) {
      where.parameterName = parameterName;
    }

    return this.auditLogRepository.find({
      where,
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  // ─── LIVE PARAMETER VALUE QUERY ───────────────────────────────────

  @Query(() => GraphQLJSON, { name: 'vfdCurrentParameterValues' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async getCurrentParameterValues(
    @Args('vfdDeviceId', { type: () => ID }) vfdDeviceId: string,
    @Args('parameterNames', { type: () => [String] }) parameterNames: string[],
    @Tenant() tenantId: string,
  ): Promise<Record<string, unknown>> {
    const definitions = await this.parameterDefinitionService.getDefinitionsForDevice(
      vfdDeviceId,
      tenantId,
    );

    const defMap = new Map(definitions.map((d) => [d.parameterName, d]));
    const results: Record<string, unknown> = {};

    for (const paramName of parameterNames) {
      const def = defMap.get(paramName);

      if (!def) {
        results[paramName] = { error: 'Parameter definition not found' };
        continue;
      }

      try {
        const value = await this.parameterWriterService.readParameterValue(
          vfdDeviceId,
          tenantId,
          def,
        );
        results[paramName] = { value, unit: def.unit };
      } catch (error) {
        results[paramName] = {
          error: error instanceof Error ? error.message : 'Read failed',
        };
      }
    }

    return results;
  }

  // ─── PENDING APPROVAL COUNT ───────────────────────────────────────

  @Query(() => Int, { name: 'vfdPendingApprovalCount' })
  async getPendingApprovalCount(
    @Tenant() tenantId: string,
  ): Promise<number> {
    return this.changeSetService.getPendingApprovalCount(tenantId);
  }

  // ─── CHANGE SET MUTATIONS ─────────────────────────────────────────

  /**
   * Create a new VFD change set (DRAFT status).
   * Maker role: MODULE_MANAGER or TENANT_ADMIN.
   */
  @Mutation(() => VfdChangeSet, { name: 'createVfdChangeSet' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async createChangeSet(
    @Args('input') input: CreateChangeSetInput,
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.createChangeSet(tenantId, input, userId);
  }

  /**
   * Submit a DRAFT change set for approval.
   */
  @Mutation(() => VfdChangeSet, { name: 'submitVfdChangeSetForApproval' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async submitForApproval(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @CurrentUser('sub') userId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.submitForApproval(changeSetId, userId, tenantId);
  }

  /**
   * Approve a PENDING_APPROVAL change set.
   * Checker role: ONLY TENANT_ADMIN (4-eye principle).
   */
  @Mutation(() => VfdChangeSet, { name: 'approveVfdChangeSet' })
  @Roles(Role.TENANT_ADMIN)
  async approveChangeSet(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @CurrentUser('sub') userId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.approveChangeSet(changeSetId, userId, tenantId);
  }

  /**
   * Reject a PENDING_APPROVAL change set.
   * ONLY TENANT_ADMIN can reject.
   */
  @Mutation(() => VfdChangeSet, { name: 'rejectVfdChangeSet' })
  @Roles(Role.TENANT_ADMIN)
  async rejectChangeSet(
    @Args('input') input: RejectChangeSetInput,
    @CurrentUser('sub') userId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.rejectChangeSet(
      input.changeSetId,
      userId,
      input.reason,
      tenantId,
    );
  }

  /**
   * Cancel a DRAFT or APPROVED change set before it is applied.
   * Distinct from reject (the checker's PENDING_APPROVAL verdict): cancel is the
   * maker/admin aborting their own change set, so MODULE_MANAGER may cancel as
   * well as TENANT_ADMIN — the same gate as create/submit/rollback.
   */
  @Mutation(() => VfdChangeSet, { name: 'cancelVfdChangeSet' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async cancelChangeSet(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @CurrentUser('sub') userId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.cancelChangeSet(changeSetId, userId, tenantId);
  }

  /**
   * Rollback an APPLIED or VERIFIED change set.
   * Creates an inverse change set.
   */
  @Mutation(() => VfdChangeSet, { name: 'rollbackVfdChangeSet' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async rollbackChangeSet(
    @Args('input') input: RollbackChangeSetInput,
    @CurrentUser('sub') userId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.rollbackChangeSet(
      input.changeSetId,
      input.reason,
      userId,
      tenantId,
    );
  }

  /**
   * Add items to a DRAFT change set.
   */
  @Mutation(() => VfdChangeSet, { name: 'addVfdChangeSetItems' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async addChangeSetItems(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @Args('items', { type: () => [ChangeSetItemInput] }) items: ChangeSetItemInput[],
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.addItems(changeSetId, items, tenantId);
  }

  /**
   * Remove an item from a DRAFT change set.
   */
  @Mutation(() => VfdChangeSet, { name: 'removeVfdChangeSetItem' })
  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  async removeChangeSetItem(
    @Args('changeSetId', { type: () => ID }) changeSetId: string,
    @Args('itemId', { type: () => ID }) itemId: string,
    @Tenant() tenantId: string,
  ): Promise<VfdChangeSet> {
    return this.changeSetService.removeItem(changeSetId, itemId, tenantId);
  }
}
