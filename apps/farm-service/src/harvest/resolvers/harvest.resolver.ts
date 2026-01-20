/**
 * HarvestResolver
 *
 * GraphQL resolvers for harvest operations.
 *
 * @module Harvest/Resolvers
 */
import { Resolver, Mutation, Query, Args } from '@nestjs/graphql';
import { CommandBus } from '@platform/cqrs';
import { HarvestRecord } from '../entities/harvest-record.entity';
import { HarvestPlan } from '../entities/harvest-plan.entity';
import { CreateHarvestRecordInput } from '../dto/create-harvest-record.input';
import { CreateHarvestRecordCommand } from '../commands/create-harvest-record.command';
import { Batch } from '../../batch/entities/batch.entity';

@Resolver(() => HarvestRecord)
export class HarvestResolver {
  constructor(private readonly commandBus: CommandBus) {}

  /**
   * Create a new harvest record
   */
  @Mutation(() => Batch, { description: 'Create a harvest record and update batch/tank quantities' })
  async createHarvestRecord(
    @Args('tenantId') tenantId: string,
    @Args('userId') userId: string,
    @Args('input') input: CreateHarvestRecordInput,
  ): Promise<Batch> {
    return this.commandBus.execute(
      new CreateHarvestRecordCommand(tenantId, input, userId)
    );
  }
}
