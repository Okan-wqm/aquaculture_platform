/**
 * Species GraphQL Resolver
 * @module Species/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Context,
  ObjectType,
  Field,
  Int,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser } from '@platform/backend-common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Species } from '../entities/species.entity';
import { CreateSpeciesInput } from '../dto/create-species.dto';
import { UpdateSpeciesInput } from '../dto/update-species.dto';
import { SpeciesFilterInput } from '../dto/species-filter.dto';
import { CreateSpeciesCommand } from '../commands/create-species.command';
import { UpdateSpeciesCommand } from '../commands/update-species.command';
import { DeleteSpeciesCommand } from '../commands/delete-species.command';
import { GetSpeciesQuery } from '../queries/get-species.query';
import { ListSpeciesQuery } from '../queries/list-species.query';
import { GetSpeciesByCodeQuery } from '../queries/get-species-by-code.query';
import { SpeciesListResult } from '../handlers/list-species.handler';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class SpeciesListResponse {
  @Field(() => [Species])
  items: Species[];

  @Field(() => Int)
  total: number;

  @Field(() => Int)
  offset: number;

  @Field(() => Int)
  limit: number;

  @Field()
  hasMore: boolean;
}

@ObjectType()
export class DeleteSpeciesResponse {
  @Field()
  success: boolean;

  @Field()
  id: string;

  @Field({ nullable: true })
  message?: string;
}

// ============================================================================
// RESOLVER
// ============================================================================

/**
 * Predefined species tags
 */
export const PREDEFINED_SPECIES_TAGS = [
  'smolt',
  'cleaner-fish',
  'broodstock',
  'fry',
  'fingerling',
  'grower',
  'market-size',
  'organic',
  'certified',
] as const;

@Resolver(() => Species)
@UseGuards(TenantGuard)
export class SpeciesResolver {
  private readonly logger = new Logger(SpeciesResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  /**
   * Get a single species by ID
   */
  @Query(() => Species, { name: 'species' })
  async getSpecies(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Species> {
    this.logger.debug(`Getting species: ${id}`);
    return this.queryBus.execute(new GetSpeciesQuery(tenantId, id));
  }

  /**
   * Get a species by code
   */
  @Query(() => Species, { name: 'speciesByCode' })
  async getSpeciesByCode(
    @Args('code') code: string,
    @CurrentTenant() tenantId: string,
  ): Promise<Species> {
    this.logger.debug(`Getting species by code: ${code}`);
    return this.queryBus.execute(new GetSpeciesByCodeQuery(tenantId, code));
  }

  /**
   * List species with filtering and pagination
   */
  @Query(() => SpeciesListResponse, { name: 'speciesList' })
  async listSpecies(
    @CurrentTenant() tenantId: string,
    @Args('filter', { type: () => SpeciesFilterInput, nullable: true })
    filter?: SpeciesFilterInput,
  ): Promise<SpeciesListResult> {
    this.logger.debug(`Listing species for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListSpeciesQuery(tenantId, filter));
  }

  /**
   * Get all active species (shorthand query)
   */
  @Query(() => [Species], { name: 'activeSpecies' })
  async getActiveSpecies(
    @CurrentTenant() tenantId: string,
  ): Promise<Species[]> {
    const result = await this.queryBus.execute(
      new ListSpeciesQuery(tenantId, { isActive: true, limit: 100 }),
    ) as SpeciesListResult;
    return result.items;
  }

  /**
   * Get all unique tags used by species in the tenant
   * Returns both predefined tags and custom tags
   */
  @Query(() => [String], { name: 'speciesTags' })
  async getSpeciesTags(
    @CurrentTenant() tenantId: string,
  ): Promise<string[]> {
    this.logger.debug(`Getting species tags for tenant: ${tenantId}`);

    // Get all species with tags
    const speciesWithTags = await this.speciesRepository.find({
      where: { tenantId, isDeleted: false },
      select: ['tags'],
    });

    // Collect unique tags from all species
    const usedTags = new Set<string>();
    for (const species of speciesWithTags) {
      if (species.tags && Array.isArray(species.tags)) {
        species.tags.forEach((tag) => usedTags.add(tag));
      }
    }

    // Combine predefined tags with used custom tags
    const allTags = new Set([...PREDEFINED_SPECIES_TAGS, ...usedTags]);
    return Array.from(allTags).sort();
  }

  /**
   * Get predefined species tags (static list)
   */
  @Query(() => [String], { name: 'predefinedSpeciesTags' })
  async getPredefinedSpeciesTags(): Promise<string[]> {
    return [...PREDEFINED_SPECIES_TAGS];
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  /**
   * Create a new species
   */
  @Mutation(() => Species)
  async createSpecies(
    @Args('input') input: CreateSpeciesInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<Species> {
    this.logger.log(`Creating species: ${input.scientificName}`);
    return this.commandBus.execute(
      new CreateSpeciesCommand(tenantId, user.sub, input),
    );
  }

  /**
   * Update an existing species
   */
  @Mutation(() => Species)
  async updateSpecies(
    @Args('input') input: UpdateSpeciesInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<Species> {
    this.logger.log(`Updating species: ${input.id}`);
    return this.commandBus.execute(
      new UpdateSpeciesCommand(tenantId, user.sub, input),
    );
  }

  /**
   * Delete a species (soft delete)
   */
  @Mutation(() => DeleteSpeciesResponse)
  async deleteSpecies(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<DeleteSpeciesResponse> {
    this.logger.log(`Deleting species: ${id}`);
    const success = await this.commandBus.execute(
      new DeleteSpeciesCommand(tenantId, user.sub, id),
    ) as boolean;
    return {
      success,
      id,
      message: success ? 'Species deleted successfully' : 'Failed to delete species',
    };
  }
}
