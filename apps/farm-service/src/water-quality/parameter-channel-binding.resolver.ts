/**
 * Parameter channel binding — GraphQL adapter (FARM-HIGH-373, FARM-MEDIUM-374).
 *
 * Where each water-quality parameter is sourced: bind, unbind, replace and
 * check a sensor channel at a measurement point, list the sources at a point
 * with each channel's live status, and declare what a parameter records.
 * Writes are TENANT_ADMIN / MODULE_MANAGER; every operation goes through the
 * command or query bus.
 *
 * @module WaterQuality
 */
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { CommandBus, QueryBus } from '@platform/cqrs';

import { BindParameterChannelCommand } from './commands/bind-parameter-channel.command';
import {
  ClearParameterQuantityCommand,
  DeclareParameterQuantityCommand,
} from './commands/declare-parameter-quantity.command';
import { ReplaceParameterChannelCommand } from './commands/replace-parameter-channel.command';
import { UnbindParameterChannelCommand } from './commands/unbind-parameter-channel.command';
import {
  BindParameterChannelInput,
  channelSourceTargetOf,
  DeclareParameterQuantityInput,
  MeasurementPointInput,
  measurementPointOf,
  ReplaceParameterChannelInput,
} from './dto/parameter-channel-binding.input';
import {
  ChannelBindingCheck,
  ParameterChannelUnbinding,
  ParameterSourceStatus,
} from './dto/parameter-source-status.response';
import { ParameterQuantityDeclaration } from './entities/parameter-quantity-declaration.entity';
import {
  ChannelSourcePriority,
  WaterQualityParamEquipment,
} from './entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from './entities/water-quality-parameter-config.entity';
import {
  CheckParameterChannelBindingQuery,
  ListParameterQuantityDeclarationsQuery,
  ListParameterSourcesAtPointQuery,
} from './queries/parameter-source-queries';

@Resolver()
@UseGuards(TenantGuard)
export class ParameterChannelBindingResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /** Bind a sensor channel as a source; refused with problem codes when it cannot feed it there. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParamEquipment)
  async bindParameterChannel(
    @Args('input') input: BindParameterChannelInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParamEquipment> {
    return this.commandBus.execute(
      new BindParameterChannelCommand(
        tenantId,
        {
          ...channelSourceTargetOf(input),
          priority: input.priority ?? ChannelSourcePriority.PRIMARY,
        },
        user.sub,
      ),
    );
  }

  /** End a channel source; a primary's backup takes its place. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ParameterChannelUnbinding)
  async unbindParameterChannel(
    @Args('sourceId', { type: () => ID }) sourceId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<ParameterChannelUnbinding> {
    return this.commandBus.execute(new UnbindParameterChannelCommand(tenantId, sourceId, user.sub));
  }

  /** Swap a source's channel in one step, keeping its parameter, place and priority. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParamEquipment)
  async replaceParameterChannel(
    @Args('input') input: ReplaceParameterChannelInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParamEquipment> {
    return this.commandBus.execute(
      new ReplaceParameterChannelCommand(
        tenantId,
        input.sourceId,
        { sensorId: input.sensorId, channelKey: input.channelKey },
        user.sub,
      ),
    );
  }

  /**
   * The bind's own rule, without binding: the channel as it is now and the
   * problem codes a bind would be refused with (empty when it would pass the
   * channel rule; the priority rules are the bind's).
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => ChannelBindingCheck, { name: 'checkParameterChannelBinding' })
  async checkParameterChannelBinding(
    @Args('input') input: BindParameterChannelInput,
    @CurrentTenant() tenantId: string,
  ): Promise<ChannelBindingCheck> {
    return this.queryBus.execute(
      new CheckParameterChannelBindingQuery(tenantId, channelSourceTargetOf(input)),
    );
  }

  /** Every live source at a point (manual and channel), with each channel's status and problems now. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ParameterSourceStatus], { name: 'parameterSourcesAtPoint' })
  async parameterSourcesAtPoint(
    @Args('point') point: MeasurementPointInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; roles: Role[]; assignedSiteIds?: string[] },
  ): Promise<ParameterSourceStatus[]> {
    return this.queryBus.execute(
      new ListParameterSourcesAtPointQuery(tenantId, measurementPointOf(point), user),
    );
  }

  /** Declare which measured quantity a parameter records (e.g. ammonia as TAN). */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParameterConfig)
  async declareParameterQuantity(
    @Args('input') input: DeclareParameterQuantityInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParameterConfig> {
    return this.commandBus.execute(
      new DeclareParameterQuantityCommand(
        tenantId,
        input.parameterConfigId,
        input.quantity,
        user.sub,
      ),
    );
  }

  /** Clear a parameter's declaration, so its code's own meaning stands. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => WaterQualityParameterConfig)
  async clearParameterQuantity(
    @Args('parameterConfigId', { type: () => ID }) parameterConfigId: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<WaterQualityParameterConfig> {
    return this.commandBus.execute(
      new ClearParameterQuantityCommand(tenantId, parameterConfigId, user.sub),
    );
  }

  /** What a parameter was declared to record, by whom and when, newest first. */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ParameterQuantityDeclaration], { name: 'parameterQuantityDeclarations' })
  async parameterQuantityDeclarations(
    @Args('parameterConfigId', { type: () => ID }) parameterConfigId: string,
    @CurrentTenant() tenantId: string,
  ): Promise<ParameterQuantityDeclaration[]> {
    return this.queryBus.execute(
      new ListParameterQuantityDeclarationsQuery(tenantId, parameterConfigId),
    );
  }
}
