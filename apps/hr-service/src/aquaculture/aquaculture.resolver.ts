import { Resolver, Query, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { WorkArea, WorkAreaType } from './entities/work-area.entity';
import { WorkRotation, RotationStatus } from './entities/work-rotation.entity';
import { Employee } from '../hr/entities/employee.entity';
import {
  GetWorkAreasQuery,
  GetWorkRotationsQuery,
  GetCurrentlyOffshoreQuery,
} from './queries';

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

@Resolver()
export class AquacultureResolver {
  constructor(private readonly queryBus: QueryBus) {}

  private getTenantId(context: GraphQLContext): string {
    const tenantId =
      context.req.user?.tenantId ||
      context.req.headers['x-tenant-id'];
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    const userId =
      context.req.user?.sub ||
      context.req.headers['x-user-id'] ||
      'system';
    return userId;
  }

  // =====================
  // Work Area Queries
  // =====================
  @Query(() => [WorkArea], { name: 'workAreas' })
  async getWorkAreas(
    @Context() context: GraphQLContext,
    @Args('workAreaType', { type: () => WorkAreaType, nullable: true }) workAreaType?: WorkAreaType,
    @Args('isOffshore', { nullable: true }) isOffshore?: boolean,
    @Args('isActive', { nullable: true }) isActive?: boolean,
  ): Promise<WorkArea[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, workAreaType, isOffshore, isActive),
    );
  }

  @Query(() => [WorkArea], { name: 'offshoreWorkAreas' })
  async getOffshoreWorkAreas(
    @Context() context: GraphQLContext,
  ): Promise<WorkArea[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkAreasQuery(tenantId, undefined, true, true),
    );
  }

  // =====================
  // Work Rotation Queries
  // =====================
  @Query(() => [WorkRotation], { name: 'workRotations' })
  async getWorkRotations(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('workAreaId', { type: () => ID, nullable: true }) workAreaId?: string,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, employeeId, workAreaId, status, startDate, endDate),
    );
  }

  @Query(() => [WorkRotation], { name: 'myWorkRotations' })
  async getMyWorkRotations(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => RotationStatus, nullable: true }) status?: RotationStatus,
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetWorkRotationsQuery(tenantId, userId, undefined, status),
    );
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
  ): Promise<WorkRotation[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetWorkRotationsQuery(
        tenantId,
        undefined,
        workAreaId,
        RotationStatus.IN_PROGRESS,
      ),
    );
  }
}
