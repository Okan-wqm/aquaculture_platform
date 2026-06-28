import {
  Resolver,
  Query,
  Mutation,
  Args,
  Int,
  ID,
  ResolveReference,
} from '@nestjs/graphql';
import { BadRequestException, NotFoundException, UseGuards, Logger } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { Farm } from '../entities/farm.entity';
import { Pond } from '../entities/pond.entity';
import { GetFarmQuery } from '../queries/get-farm.query';
import { ListFarmsQuery } from '../queries/list-farms.query';
import { GetPondQuery } from '../queries/get-pond.query';
import { CreateFarmInput } from '../dto/create-farm.input';
import { CreatePondInput } from '../dto/create-pond.input';

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Farm Resolver
 * GraphQL resolver for farm-related operations
 * Implements Apollo Federation
 */
@UseGuards(GqlAuthGuard)
@Resolver(() => Farm)
export class FarmResolver {
  private readonly logger = new Logger(FarmResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Federation reference resolver
   *
   * NOTE: Federation __resolveReference calls bypass tenant context.
   * This query is tenant-agnostic by design for federation stitching.
   * Security is enforced at the gateway level where the initial query
   * must pass tenant authorization.
   */
  @ResolveReference()
  async resolveReference(reference: {
    __typename: string;
    id: string;
    tenantId?: string;
  }): Promise<Farm | null> {
    if (!reference.tenantId) {
      this.logger.warn(`resolveReference called without tenantId for farm ${reference.id} — rejecting for tenant isolation`);
      return null;
    }
    try {
      return await this.queryBus.execute(
        new GetFarmQuery(reference.id, reference.tenantId, true, false),
      );
    } catch (error: unknown) {
      // A reference to a farm that does not exist is a legitimate null for
      // federation entity resolution. A lost/wrong tenant context
      // (TenantContextError) must NOT be masked as "not found" — surface it.
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get a single farm by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Farm, { name: 'farm', nullable: true })
  async getFarm(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Farm> {
    this.logger.debug(`Query: getFarm(${id})`);
    return await this.queryBus.execute(
      new GetFarmQuery(id, tenantId, true, false),
    );
  }

  /**
   * List all farms for the tenant
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [Farm], { name: 'farms' })
  async listFarms(
    @Tenant() tenantId: string,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 })
    limit: number,
    @Args('isActive', { type: () => Boolean, nullable: true })
    isActive?: boolean,
    @Args('search', { type: () => String, nullable: true })
    search?: string,
  ): Promise<Farm[]> {
    this.logger.debug(`Query: listFarms(tenant=${tenantId})`);
    const result: PaginatedQueryResult<Farm> = await this.queryBus.execute(
      new ListFarmsQuery(
        tenantId,
        { page, limit },
        { isActive, search },
        true,
      ),
    );
    return fromCqrsPaginated(result).items;
  }

  /**
   * Get a single pond by ID
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => Pond, { name: 'pond', nullable: true })
  async getPond(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<Pond> {
    this.logger.debug(`Query: getPond(${id})`);
    return await this.queryBus.execute(
      new GetPondQuery(id, tenantId, true, true),
    );
  }

  /**
   * @deprecated Farm is a legacy concept. The real hierarchy is
   * Site → Department → System → Tank. Use {@link SiteResolver.createSite}
   * via the `createSite` mutation instead.
   *
   * This mutation is intentionally disabled; invoking it throws a
   * BadRequestException. The `farm` / `farms` / `pond` queries remain
   * available for read access to legacy rows that may still exist in
   * `farm.farms` / `farm.ponds`.
   */
  @Mutation(() => Farm, {
    name: 'createFarm',
    deprecationReason:
      'Legacy farm concept. Use createSite (SiteResolver) — Site → Department → System → Tank.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createFarm(
    @Args('input') _input: CreateFarmInput,
    @Tenant() _tenantId: string,
    @CurrentUser() _user: UserContext,
  ): Promise<Farm> {
    this.logger.warn(
      'Rejected call to deprecated createFarm mutation — clients should use createSite.',
    );
    throw new BadRequestException(
      'createFarm is disabled. The system does not register farm entities; ' +
        'use createSite (Site → Department → System → Tank hierarchy). ' +
        'See docs/illustrator/ for the active architecture.',
    );
  }

  /**
   * @deprecated Pond is a legacy concept. Tanks are modelled as
   * {@link Equipment} rows with `is_tank = true`. Use
   * {@link TankResolver.createTank} via the `createTank` mutation.
   *
   * This mutation is intentionally disabled; invoking it throws a
   * BadRequestException. The `pond` query remains available for
   * read access to legacy rows in `farm.ponds`.
   */
  @Mutation(() => Pond, {
    name: 'createPond',
    deprecationReason:
      'Legacy pond concept. Use createTank (TankResolver) — equipment with is_tank=true.',
  })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createPond(
    @Args('input') _input: CreatePondInput,
    @Tenant() _tenantId: string,
    @CurrentUser() _user: UserContext,
  ): Promise<Pond> {
    this.logger.warn(
      'Rejected call to deprecated createPond mutation — clients should use createTank.',
    );
    throw new BadRequestException(
      'createPond is disabled. Tanks/ponds are modelled as Equipment rows ' +
        '(is_tank=true). Use createTank (TankResolver). ' +
        'See docs/illustrator/ for the active architecture.',
    );
  }

}
