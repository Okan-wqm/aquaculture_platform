/**
 * Ünite → yemleyici ataması GraphQL yüzeyi.
 *
 * Authz FeedingProtocolV2Resolver ile aynı matristir: okumalar TENANT_ADMIN /
 * MODULE_MANAGER / MODULE_USER, yazma TENANT_ADMIN / MODULE_MANAGER. Site-scoped
 * doğrulama handler sink'inde (site'sız ünite fail-closed reddedilir).
 *
 * @module FeedingProtocol/Resolvers
 */
import { UseGuards } from '@nestjs/common';
import { Args, Float, ID, Mutation, ObjectType, Field, Query, Resolver } from '@nestjs/graphql';
import { CommandBus, QueryBus } from '@platform/cqrs';
import { CurrentTenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { SetUnitFeedersCommand } from '../commands/feeder-assignment.commands';
import { SetUnitFeedersInput } from '../dto/feeder-assignment.inputs';
import { FeederAssignment } from '../entities/feeder-assignment.entity';
import { GetUnitFeederAssignmentsQuery } from '../queries/feeder-assignment.queries';
import { FeederDoseSplitService } from '../services/feeder-dose-split.service';

/** Bir yemleyiciye düşen kg — dozun paya göre bölünmüş hâli. */
@ObjectType('FeederDoseAllocation')
export class FeederDoseAllocationType {
  @Field(() => ID)
  feederEquipmentId!: string;

  @Field()
  feederName!: string;

  @Field()
  feederCode!: string;

  @Field(() => Float)
  doseSharePercent!: number;

  @Field(() => Float)
  kg!: number;
}

@UseGuards(GqlAuthGuard)
@Resolver(() => FeederAssignment)
export class FeederAssignmentResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    private readonly doseSplitService: FeederDoseSplitService,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeederAssignment], {
    description: 'Ünitenin yemleyicileri ve günlük dozdaki payları',
  })
  async unitFeederAssignments(
    @CurrentTenant() tenantId: string,
    @Args('unitId', { type: () => ID }) unitId: string,
    @Args('includeEnded', { nullable: true, defaultValue: false }) includeEnded?: boolean,
  ): Promise<FeederAssignment[]> {
    return this.queryBus.execute(
      new GetUnitFeederAssignmentsQuery(unitId, tenantId, includeEnded ?? false),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [FeederDoseAllocationType], {
    description: 'Verilen günlük dozun ünitenin yemleyicilerine paya göre bölünmüş hâli',
  })
  async unitFeederDoseSplit(
    @CurrentTenant() tenantId: string,
    @Args('unitId', { type: () => ID }) unitId: string,
    @Args('totalKg', { type: () => Float }) totalKg: number,
  ): Promise<FeederDoseAllocationType[]> {
    return this.doseSplitService.splitDailyDose(tenantId, unitId, totalKg);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [FeederAssignment], {
    description: 'Ünitenin yemleyici listesini TAM olarak ayarlar; payların toplamı %100 olmalıdır',
  })
  async setUnitFeeders(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: SetUnitFeedersInput,
  ): Promise<FeederAssignment[]> {
    return this.commandBus.execute(new SetUnitFeedersCommand(input, tenantId, userId));
  }
}
