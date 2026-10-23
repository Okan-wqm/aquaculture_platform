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
import { isNetpolicyBody } from '../edge-device/site-netpolicy-manifest.service';

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
    return this.rollouts.create(
      tenantId,
      user.sub,
      input.name,
      planOf(input, this.rollouts, tenantId),
    );
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

const MEMBERS = ['version', 'osBundle', 'terms', 'siteFiles', 'netpolicy'] as const;
type Member = (typeof MEMBERS)[number];

/** The members of the input a kind does not take must be absent. */
function onlyMembers(input: CreateEdgeRolloutInput, allowed: readonly Member[]): void {
  const extra = MEMBERS.filter(
    (member) => !allowed.includes(member) && input[member] !== undefined && input[member] !== null,
  );
  if (extra.length > 0) {
    throw new BadRequestException(`A ${input.kind} rollout does not take ${extra.join(' or ')}`);
  }
}

/** A member a kind needs. */
function needed<T>(input: CreateEdgeRolloutInput, value: T | null | undefined, name: Member): T {
  if (value === undefined || value === null) {
    throw new BadRequestException(`A ${input.kind} rollout needs ${name}`);
  }
  return value;
}

/**
 * The plan an input describes. Which members a plan names is decided by its kind, and an
 * input that names another kind's member, or leaves out one the kind needs, is refused.
 * A trust-anchors plan names no member: the plan is the bundle the cloud holds, by the
 * digest and `bundle_seq` it states, which is what the two approvers confirm.
 */
function planOf(
  input: CreateEdgeRolloutInput,
  rollouts: EdgeRolloutService,
  tenantId: string,
): RolloutPlan {
  const common = {
    windowNotBefore: input.windowNotBefore ?? null,
    windowSeconds: input.windowSeconds,
    maxFailures: input.maxFailures,
    waves: input.waves,
  };
  switch (input.kind) {
    case EdgeRolloutKind.EDGE_UPDATE:
      onlyMembers(input, ['version', 'terms']);
      return {
        kind: input.kind,
        version: needed(input, input.version, 'version'),
        terms: needed(input, input.terms, 'terms'),
        ...common,
      };
    case EdgeRolloutKind.OS_UPDATE:
      onlyMembers(input, ['osBundle', 'terms']);
      return {
        kind: input.kind,
        bundle: needed(input, input.osBundle, 'osBundle'),
        terms: needed(input, input.terms, 'terms'),
        ...common,
      };
    case EdgeRolloutKind.SITE_CONFIG: {
      onlyMembers(input, ['siteFiles']);
      const files: Record<string, string> = {};
      for (const file of input.siteFiles ?? []) {
        if (file.path in files) {
          throw new BadRequestException(`The site file ${file.path} is named twice`);
        }
        files[file.path] = file.contentBase64;
      }
      return { kind: input.kind, files, ...common };
    }
    case EdgeRolloutKind.SITE_NETPOLICY: {
      onlyMembers(input, ['netpolicy']);
      const policy = needed(input, input.netpolicy, 'netpolicy');
      if (!isNetpolicyBody(policy)) {
        throw new BadRequestException(
          'The policy is not one the contract admits: exactly interfaces, ot_rules and time_sources, each as the contract states it',
        );
      }
      return { kind: input.kind, policy, ...common };
    }
    case EdgeRolloutKind.TRUST_ANCHORS:
      onlyMembers(input, []);
      return { kind: input.kind, ...rollouts.heldTrustAnchors(tenantId), ...common };
  }
}
