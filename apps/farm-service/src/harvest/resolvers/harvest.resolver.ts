/**
 * HarvestResolver
 *
 * GraphQL resolvers for harvest operations.
 *
 * @module Harvest/Resolvers
 */
import { Resolver, Mutation, Query, Args } from '@nestjs/graphql';
import { CommandBus } from '@platform/cqrs';
import { Tenant, CurrentUser } from '@platform/backend-common';
import { HarvestRecord } from '../entities/harvest-record.entity';
import { HarvestPlan } from '../entities/harvest-plan.entity';
import { CreateHarvestRecordInput } from '../dto/create-harvest-record.input';
import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { Batch } from '../../batch/entities/batch.entity';

/**
 * User context interface for CurrentUser decorator
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

@Resolver(() => HarvestRecord)
export class HarvestResolver {
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * Create a new harvest record
   */
  @Mutation(() => Batch, { description: 'Create a harvest record and update batch/tank quantities' })
  async createHarvestRecord(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('input') input: CreateHarvestRecordInput,
  ): Promise<Batch> {
    return this.commandBus.execute(
      new CreateHarvestRecordCommand(tenantId, input, user.sub)
    );
  }
}
