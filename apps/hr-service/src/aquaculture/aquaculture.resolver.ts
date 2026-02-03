import { Resolver, Query, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { QueryBus } from '@nestjs/cqrs';
import { WorkArea, WorkAreaType } from './entities/work-area.entity';
import { WorkRotation, RotationStatus } from './entities/work-rotation.entity';
import { Employee } from '../hr/entities/employee.entity';
import {
  GetWorkAreasQuery,
  GetWorkRotationsQuery,
  GetCurrentlyOffshoreQuery,
} from './queries';
import { PaginatedWorkAreas } from './query-handlers/get-work-areas.handler';
import { PaginatedWorkRotations } from './query-handlers/get-work-rotations.handler';

@ObjectType()
class WorkAreaConnection {
  @Field(() => [WorkArea])
  items!: WorkArea[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@ObjectType()
class WorkRotationConnection {
  @Field(() => [WorkRotation])
  items!: WorkRotation[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

interface GraphQLContext {
  req: {
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
    };
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

@UseGuards(GqlAuthGuard)
@Resolver()
export class AquacultureResolver {
  constructor(private readonly queryBus: QueryBus) {}

  private getTenantId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified tenantId, never trust headers directly
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required - authentication required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified userId, never trust headers directly
    const userId = context.req.user?.sub;
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedException('User ID is required - authentication required');
    }
    return userId;
  }

  // =====================
  // Work Area Queries
  // =====================
  @Query(() => WorkAreaConnection, { name: 'workAreas' })
  async getWorkAreas(
    @Context() context: GraphQLContext,
    @Args('workAreaType', { type: () => WorkAreaType, nullable: true }) workAreaType?: WorkAreaType,
    @Args('isOffshore', { nullable: true }) isOffshore?: boolean,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedWorkAreas> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, workAreaType, isOffshore, isActive, limit, offset),
    );
  }

  @Query(() => [WorkArea], { name: 'offshoreWorkAreas' })
  async getOffshoreWorkAreas(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset: number,
    @Context() context: GraphQLContext,
  ): Promise<WorkArea[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, undefined, true, true, limit, offset),
    );
    return result.items;
  }

  // =====================
  // Work Rotation Queries
  // =====================
  @Query(() => WorkRotationConnection, { name: 'workRotations' })
  async getWorkRotations(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedWorkRotations> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, employeeId, workAreaId, status, startDate, endDate, limit, offset),
    );
  }

  @Query(() => [WorkRotation], { name: 'myWorkRotations' })
  async getMyWorkRotations(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const result = await this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, userId, undefined, status, undefined, undefined, limit, offset),
    );
    return result.items;
  }

  @Query(() => [Employee], { name: 'currentlyOffshore' })
  async getCurrentlyOffshore(
    @Context() context: GraphQLContext,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetCurrentlyOffshoreQuery(tenantId, workAreaId),
    );
  }

  @Query(() => [WorkRotation], { name: 'activeRotations' })
  async getActiveRotations(
    @Context() context: GraphQLContext,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetWorkRotationsQuery(
        tenantId,
        undefined,
        workAreaId,
        RotationStatus.IN_PROGRESS,
        undefined,
        undefined,
        limit,
        offset,
      ),
    );
    return result.items;
  }
}
