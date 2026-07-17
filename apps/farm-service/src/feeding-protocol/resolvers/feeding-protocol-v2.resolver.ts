/**
 * FeedingProtocolV2 GraphQL resolver'ı.
 *
 * Authz matrisi (plan NFR bölümü):
 *  - okumalar: TENANT_ADMIN, MODULE_MANAGER, MODULE_USER
 *  - protokol CRUD + atama mutasyonları: TENANT_ADMIN, MODULE_MANAGER
 * Site-scoped yazma doğrulaması handler sink'lerinde (SEC-HIGH-051 duruşu:
 * ünitenin sitesi çözülemezse fail-closed red).
 *
 * @module FeedingProtocol/Resolvers
 */
import { Resolver, Query, Mutation, Args, ID, ObjectType } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Roles, Role, CurrentTenant, CurrentUser } from '@aquaculture/backend-common/decorators';
import {
  StandardPaginatedResponse,
  fromCqrsPaginated,
  IStandardPaginatedResult,
  StandardPaginationInput,
} from '@aquaculture/backend-common/pagination';

import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { FeedingProtocolStatus, FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
} from '../entities/protocol-assignment.entity';
import {
  AssignProtocolToUnitInput,
  CreateFeedingProtocolV2Input,
  UpdateFeedingProtocolV2Input,
  UpdateProtocolAssignmentInput,
} from '../dto/feeding-protocol-v2.inputs';
import {
  ArchiveFeedingProtocolV2Command,
  AssignProtocolToBatchUnitsCommand,
  AssignProtocolToUnitCommand,
  CreateFeedingProtocolV2Command,
  UnassignProtocolCommand,
  UpdateFeedingProtocolV2Command,
  UpdateProtocolAssignmentCommand,
} from '../commands/feeding-protocol-v2.commands';
import {
  GetFeedingProtocolV2Query,
  ListFeedingProtocolsV2Query,
  ListProtocolAssignmentsQuery,
} from '../queries/feeding-protocol-v2.queries';

@ObjectType()
export class FeedingProtocolV2Connection extends StandardPaginatedResponse(FeedingProtocolV2) {}

@ObjectType()
export class ProtocolAssignmentConnection extends StandardPaginatedResponse(ProtocolAssignment) {}

@UseGuards(GqlAuthGuard)
@Resolver(() => FeedingProtocolV2)
export class FeedingProtocolV2Resolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingProtocolV2Connection, { description: 'Birleşik yemleme protokolleri (v2)' })
  async feedingProtocolsV2(
    @CurrentTenant() tenantId: string,
    @Args('status', { type: () => FeedingProtocolStatus, nullable: true })
    status?: FeedingProtocolStatus,
    @Args('speciesId', { type: () => ID, nullable: true }) speciesId?: string,
    @Args('pagination', { nullable: true }) pagination?: StandardPaginationInput,
  ): Promise<IStandardPaginatedResult<FeedingProtocolV2>> {
    const result: PaginatedQueryResult<FeedingProtocolV2> = await this.queryBus.execute(
      new ListFeedingProtocolsV2Query(
        tenantId,
        { status, speciesId },
        pagination?.page ?? 1,
        pagination?.limit ?? 20,
      ),
    );
    return fromCqrsPaginated(result);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => FeedingProtocolV2, { description: 'Tek protokol (v2)' })
  async feedingProtocolV2(
    @CurrentTenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FeedingProtocolV2> {
    return this.queryBus.execute(new GetFeedingProtocolV2Query(id, tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => ProtocolAssignmentConnection, { description: 'Protokol atamaları' })
  async protocolAssignments(
    @CurrentTenant() tenantId: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('unitId', { type: () => ID, nullable: true }) unitId?: string,
    @Args('protocolId', { type: () => ID, nullable: true }) protocolId?: string,
    @Args('status', { type: () => ProtocolAssignmentStatus, nullable: true })
    status?: ProtocolAssignmentStatus,
    @Args('pagination', { nullable: true }) pagination?: StandardPaginationInput,
  ): Promise<IStandardPaginatedResult<ProtocolAssignment>> {
    const result: PaginatedQueryResult<ProtocolAssignment> = await this.queryBus.execute(
      new ListProtocolAssignmentsQuery(
        tenantId,
        { siteId, unitId, protocolId, status },
        pagination?.page ?? 1,
        pagination?.limit ?? 50,
      ),
    );
    return fromCqrsPaginated(result);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => FeedingProtocolV2)
  async createFeedingProtocolV2(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateFeedingProtocolV2Input,
  ): Promise<FeedingProtocolV2> {
    return this.commandBus.execute(new CreateFeedingProtocolV2Command(input, tenantId, userId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => FeedingProtocolV2)
  async updateFeedingProtocolV2(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateFeedingProtocolV2Input,
  ): Promise<FeedingProtocolV2> {
    return this.commandBus.execute(new UpdateFeedingProtocolV2Command(input, tenantId, userId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => FeedingProtocolV2)
  async archiveFeedingProtocolV2(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<FeedingProtocolV2> {
    return this.commandBus.execute(new ArchiveFeedingProtocolV2Command(id, tenantId, userId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ProtocolAssignment)
  async assignProtocolToUnit(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: AssignProtocolToUnitInput,
  ): Promise<ProtocolAssignment> {
    return this.commandBus.execute(new AssignProtocolToUnitCommand(input, tenantId, userId));
  }

  /**
   * Plan §1.2 kolaylık mutasyonu: batch'in güncel ünitelerine (primary ya da
   * batchDetails payı) toplu atama — her ünite tekil atama yolunun aynı
   * çekirdeğinden geçer, tek transaction.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => [ProtocolAssignment])
  async assignProtocolToBatchUnits(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('protocolId', { type: () => ID }) protocolId: string,
    @Args('speciesMismatchReason', { nullable: true }) speciesMismatchReason?: string,
  ): Promise<ProtocolAssignment[]> {
    return this.commandBus.execute(
      new AssignProtocolToBatchUnitsCommand(
        batchId,
        protocolId,
        tenantId,
        userId,
        speciesMismatchReason,
      ),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ProtocolAssignment)
  async updateProtocolAssignment(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateProtocolAssignmentInput,
  ): Promise<ProtocolAssignment> {
    return this.commandBus.execute(new UpdateProtocolAssignmentCommand(input, tenantId, userId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => ProtocolAssignment)
  async unassignProtocolFromUnit(
    @CurrentTenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('assignmentId', { type: () => ID }) assignmentId: string,
  ): Promise<ProtocolAssignment> {
    return this.commandBus.execute(new UnassignProtocolCommand(assignmentId, tenantId, userId));
  }
}
