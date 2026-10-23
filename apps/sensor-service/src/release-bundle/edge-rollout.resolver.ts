import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  CurrentUser,
  type CurrentUserPayload,
  Role,
  Roles,
  Tenant,
} from '@aquaculture/backend-common/decorators';
import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { EdgeDeviceService } from '../edge-device/edge-device.service';
import { EdgeUpdateRequestService } from '../edge-device/edge-update-request.service';
import { EdgeUpdateRequest } from '../edge-device/entities/edge-update-request.entity';

import {
  CreateEdgeRolloutInput,
  EdgeRolloutDeviceStatusType,
  EdgeRolloutProgressType,
} from './dto/edge-rollout.dto';
import { type RolloutPlan } from './edge-rollout-plan';
import { EdgeRolloutService } from './edge-rollout.service';
import { EdgeRolloutApproval } from './entities/edge-rollout-approval.entity';
import { EdgeRollout, EdgeRolloutKind, EdgeRolloutState } from './entities/edge-rollout.entity';

/**
 * The console's rollouts of agent releases and OS bundles (ADR-048 DEC-2.4, DEC-23).
 *
 * Planning and cancelling are open to the tenant administrator and the module
 * manager; approving is the tenant administrator's alone, and a rollout starts only
 * when two different administrators approved the same plan digest. The approver is
 * the authenticated user of the request (the JWT subject): nothing in the input
 * names who approves.
 *
 * Every mutation is an audited operation.
 */
@Resolver(() => EdgeRollout)
export class EdgeRolloutResolver {
  constructor(
    private readonly rollouts: EdgeRolloutService,
    private readonly requests: EdgeUpdateRequestService,
    private readonly devices: EdgeDeviceService,
  ) {}

  @Query(() => [EdgeRollout], {
    name: 'edgeRollouts',
    description: 'The tenant’s rollouts of agent releases and OS bundles, newest first',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async edgeRollouts(
    @Tenant() tenantId: string,
    @Args('state', { type: () => EdgeRolloutState, nullable: true }) state?: EdgeRolloutState,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit?: number,
  ): Promise<EdgeRollout[]> {
    return this.rollouts.list(tenantId, state, limit);
  }

  @Query(() => EdgeRollout, { name: 'edgeRollout', description: 'One rollout and its plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async edgeRollout(
    @Tenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<EdgeRollout> {
    return this.rollouts.get(tenantId, id);
  }

  @ResolveField(() => [EdgeRolloutApproval], {
    description: 'Who approved this plan, and when',
  })
  async approvals(
    @Parent() rollout: EdgeRollout,
    @Tenant() tenantId: string,
  ): Promise<EdgeRolloutApproval[]> {
    return this.rollouts.approvals(tenantId, rollout.id);
  }

  @ResolveField(() => EdgeRolloutProgressType, {
    description: 'How many devices are not signed yet, in flight, done and failed',
  })
  async progress(
    @Parent() rollout: EdgeRollout,
    @Tenant() tenantId: string,
  ): Promise<EdgeRolloutProgressType> {
    return Object.assign(
      new EdgeRolloutProgressType(),
      await this.rollouts.progress(tenantId, rollout.id),
    );
  }

  @ResolveField(() => [EdgeRolloutDeviceStatusType], {
    description: 'Where each device of the cohort stands, wave by wave',
  })
  async deviceStatuses(
    @Parent() rollout: EdgeRollout,
    @Tenant() tenantId: string,
  ): Promise<EdgeRolloutDeviceStatusType[]> {
    const statuses = await this.rollouts.devices(tenantId, rollout.id);
    return statuses.map((status) => Object.assign(new EdgeRolloutDeviceStatusType(), status));
  }

  @Query(() => [EdgeUpdateRequest], {
    name: 'edgeUpdateRequests',
    description:
      'The signed update requests owed to one Suderra OS device, newest first, and how each ended (never the statement itself)',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async edgeUpdateRequests(
    @Tenant() tenantId: string,
    @Args('deviceId', { type: () => ID }) deviceId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 50 }) limit?: number,
  ): Promise<EdgeUpdateRequest[]> {
    if ((await this.devices.findById(deviceId, tenantId)) === null) return [];
    const views = await this.requests.listForDevice(tenantId, deviceId, limit);
    return views.map((view) => Object.assign(new EdgeUpdateRequest(), view));
  }

  @Mutation(() => EdgeRollout, {
    name: 'createEdgeRollout',
    description:
      'Plans a rollout. Nothing is signed for any device until two administrators approved this plan',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditedOperation({ resource: 'EdgeRollout', action: 'CREATE' })
  async createEdgeRollout(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('input') input: CreateEdgeRolloutInput,
  ): Promise<EdgeRollout> {
    return this.rollouts.create(tenantId, user.sub, input.name, planOf(input));
  }

  @Mutation(() => EdgeRollout, {
    name: 'approveEdgeRollout',
    description:
      'Approves the plan with this digest as the authenticated administrator; the rollout starts when two different administrators did',
  })
  @Roles(Role.TENANT_ADMIN)
  @AuditedOperation({ resource: 'EdgeRollout', action: 'APPROVE' })
  async approveEdgeRollout(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('id', { type: () => ID }) id: string,
    @Args('planSha256') planSha256: string,
  ): Promise<EdgeRollout> {
    return this.rollouts.approve(tenantId, user.sub, id, planSha256);
  }

  @Mutation(() => EdgeRollout, {
    name: 'cancelEdgeRollout',
    description:
      'Ends a rollout; what no device has been handed yet is stopped, what a device holds is concluded by its result',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditedOperation({ resource: 'EdgeRollout', action: 'CANCEL' })
  async cancelEdgeRollout(
    @Tenant() tenantId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
  ): Promise<EdgeRollout> {
    return this.rollouts.cancel(tenantId, user.sub, id, reason);
  }
}

/** The plan an input describes; an input that names the wrong target for its kind is refused. */
function planOf(input: CreateEdgeRolloutInput): RolloutPlan {
  const common = {
    terms: input.terms,
    windowNotBefore: input.windowNotBefore ?? null,
    windowSeconds: input.windowSeconds,
    maxFailures: input.maxFailures,
    waves: input.waves,
  };
  if (input.kind === EdgeRolloutKind.EDGE_UPDATE) {
    if (input.version === undefined || input.osBundle !== undefined) {
      throw new BadRequestException('An edge-update rollout names a version and no OS bundle');
    }
    return { kind: EdgeRolloutKind.EDGE_UPDATE, version: input.version, ...common };
  }
  if (input.osBundle === undefined || input.version !== undefined) {
    throw new BadRequestException('An os-update rollout names an OS bundle and no version');
  }
  return { kind: EdgeRolloutKind.OS_UPDATE, bundle: input.osBundle, ...common };
}
