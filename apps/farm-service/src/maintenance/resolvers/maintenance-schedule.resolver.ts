/**
 * MaintenanceSchedule GraphQL Resolver
 *
 * Bakım planı yönetimi ve otomatik iş emri oluşturma için GraphQL API.
 *
 * @module Maintenance/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  MaintenanceSchedule,
  MaintenanceScheduleStatus,
  MaintenanceCategory,
  RecurrenceType,
} from '../entities/maintenance-schedule.entity';
import { WorkOrder } from '../entities/work-order.entity';
import {
  MaintenanceScheduleService,
  ScheduleAlert,
  ComplianceReport,
} from '../services/maintenance-schedule.service';
import { QueryBus } from '@platform/cqrs';
import { GetMaintenanceScheduleQuery } from '../queries/get-maintenance-schedule.query';
import { GetMaintenanceScheduleByCodeQuery } from '../queries/get-maintenance-schedule-by-code.query';
import { ListMaintenanceSchedulesQuery } from '../queries/list-maintenance-schedules.query';
import { ListUpcomingMaintenanceSchedulesQuery } from '../queries/list-upcoming-maintenance-schedules.query';
import { ListOverdueMaintenanceSchedulesQuery } from '../queries/list-overdue-maintenance-schedules.query';
import { ListMaintenanceScheduleAlertsQuery } from '../queries/list-maintenance-schedule-alerts.query';
import { GetMaintenanceComplianceReportQuery } from '../queries/get-maintenance-compliance-report.query';
import { CreateMaintenanceScheduleInput } from '../dto/create-maintenance-schedule.dto';
import {
  UpdateMaintenanceScheduleInput,
  UpdateMeterReadingInput,
  CompleteMaintenanceInput,
} from '../dto/update-maintenance-schedule.dto';
import { MaintenanceScheduleFilterInput } from '../dto/maintenance-schedule-filter.dto';

// Register enums for GraphQL
registerEnumType(MaintenanceScheduleStatus, {
  name: 'MaintenanceScheduleStatus',
  description: 'Bakım plan durumu',
});

registerEnumType(MaintenanceCategory, {
  name: 'MaintenanceCategory',
  description: 'Bakım kategorisi',
});

registerEnumType(RecurrenceType, {
  name: 'RecurrenceType',
  description: 'Tekrar sıklığı tipi',
});

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class MaintenanceScheduleListResponse extends StandardPaginatedResponse(MaintenanceSchedule) {}

@ObjectType()
export class ScheduleAlertResponse {
  @Field(() => MaintenanceSchedule)
  schedule!: MaintenanceSchedule;

  @Field(() => Int)
  daysUntilDue!: number;

  @Field()
  alertType!: string;
}

@ObjectType()
export class CategoryComplianceStats {
  @Field(() => Int)
  total!: number;

  @Field(() => Float)
  complianceRate!: number;
}

@ObjectType()
export class ComplianceReportResponse {
  @Field(() => Int)
  totalSchedules!: number;

  @Field(() => Int)
  activeSchedules!: number;

  @Field(() => Int)
  overdueSchedules!: number;

  @Field(() => Float)
  avgComplianceRate!: number;
}

@ObjectType()
export class DeleteMaintenanceScheduleResponse {
  @Field()
  success!: boolean;

  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  message?: string;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => MaintenanceSchedule)
export class MaintenanceScheduleResolver {
  private readonly logger = new Logger(MaintenanceScheduleResolver.name);

  constructor(
    private readonly maintenanceScheduleService: MaintenanceScheduleService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => MaintenanceSchedule, { name: 'maintenanceSchedule' })
  async getMaintenanceSchedule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.debug(`Getting maintenance schedule: ${id}`);
    return this.queryBus.execute(new GetMaintenanceScheduleQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => MaintenanceSchedule, { name: 'maintenanceScheduleByCode' })
  async getMaintenanceScheduleByCode(
    @Args('code') code: string,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.debug(`Getting maintenance schedule by code: ${code}`);
    return this.queryBus.execute(new GetMaintenanceScheduleByCodeQuery(tenantId, code));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => MaintenanceScheduleListResponse, { name: 'maintenanceSchedules' })
  async listMaintenanceSchedules(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => MaintenanceScheduleFilterInput, nullable: true })
    filter?: MaintenanceScheduleFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
    limit?: number,
    @Args('sortBy', { nullable: true, defaultValue: 'nextDueDate' })
    sortBy?: string,
    @Args('sortOrder', { nullable: true, defaultValue: 'ASC' })
    sortOrder?: 'ASC' | 'DESC',
  ): Promise<IStandardPaginatedResult<MaintenanceSchedule>> {
    this.logger.debug(`Listing maintenance schedules for tenant: ${tenantId}`);
    return this.queryBus.execute(
      new ListMaintenanceSchedulesQuery(tenantId, filter, page, limit, sortBy, sortOrder),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [MaintenanceSchedule], { name: 'upcomingMaintenanceSchedules' })
  async getUpcomingMaintenanceSchedules(
    @Tenant() tenantId: string,
    @Args('days', { type: () => Int, nullable: true, defaultValue: 7 })
    days?: number,
  ): Promise<MaintenanceSchedule[]> {
    this.logger.debug(`Getting upcoming maintenance schedules for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListUpcomingMaintenanceSchedulesQuery(tenantId, days));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [MaintenanceSchedule], { name: 'overdueMaintenanceSchedules' })
  async getOverdueMaintenanceSchedules(
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule[]> {
    this.logger.debug(`Getting overdue maintenance schedules for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListOverdueMaintenanceSchedulesQuery(tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [ScheduleAlertResponse], { name: 'maintenanceAlerts' })
  async getMaintenanceAlerts(
    @Tenant() tenantId: string,
  ): Promise<ScheduleAlertResponse[]> {
    this.logger.debug(`Getting maintenance alerts for tenant: ${tenantId}`);
    const alerts = await this.queryBus.execute<ListMaintenanceScheduleAlertsQuery, ScheduleAlert[]>(
      new ListMaintenanceScheduleAlertsQuery(tenantId),
    );

    return alerts.map((alert) => ({
      schedule: alert.schedule,
      daysUntilDue: alert.daysUntilDue,
      alertType: alert.alertType,
    }));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Query(() => ComplianceReportResponse, { name: 'maintenanceComplianceReport' })
  async getComplianceReport(
    @Tenant() tenantId: string,
  ): Promise<ComplianceReportResponse> {
    this.logger.debug(`Getting compliance report for tenant: ${tenantId}`);
    const report = await this.queryBus.execute<GetMaintenanceComplianceReportQuery, ComplianceReport>(
      new GetMaintenanceComplianceReportQuery(tenantId),
    );

    return {
      totalSchedules: report.totalSchedules,
      activeSchedules: report.activeSchedules,
      overdueSchedules: report.overdueSchedules,
      avgComplianceRate: report.avgComplianceRate,
    };
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async createMaintenanceSchedule(
    @Args('input') input: CreateMaintenanceScheduleInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Creating maintenance schedule: ${input.name}`);
    return this.maintenanceScheduleService.create(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async updateMaintenanceSchedule(
    @Args('input') input: UpdateMaintenanceScheduleInput,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Updating maintenance schedule: ${input.id}`);
    return this.maintenanceScheduleService.update(tenantId, input);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => DeleteMaintenanceScheduleResponse)
  async deleteMaintenanceSchedule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeleteMaintenanceScheduleResponse> {
    this.logger.log(`Deleting maintenance schedule: ${id}`);
    await this.maintenanceScheduleService.delete(tenantId, id);
    return {
      success: true,
      id,
      message: 'Bakım planı başarıyla silindi',
    };
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async pauseMaintenanceSchedule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Pausing maintenance schedule: ${id}`);
    return this.maintenanceScheduleService.pause(tenantId, id);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async resumeMaintenanceSchedule(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Resuming maintenance schedule: ${id}`);
    return this.maintenanceScheduleService.resume(tenantId, id);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async completeMaintenance(
    @Args('input') input: CompleteMaintenanceInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Completing maintenance: ${input.scheduleId}`);
    return this.maintenanceScheduleService.completeMaintenance(
      tenantId,
      input,
      user.sub,
    );
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => MaintenanceSchedule)
  async updateMeterReading(
    @Args('input') input: UpdateMeterReadingInput,
    @Tenant() tenantId: string,
  ): Promise<MaintenanceSchedule> {
    this.logger.log(`Updating meter reading: ${input.id}`);
    return this.maintenanceScheduleService.updateMeterReading(tenantId, input);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async generateWorkOrderFromSchedule(
    @Args('scheduleId', { type: () => ID }) scheduleId: string,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Generating work order from schedule: ${scheduleId}`);
    return this.maintenanceScheduleService.generateWorkOrder(
      tenantId,
      scheduleId,
      user.sub,
    );
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => [WorkOrder])
  async processAutoGenerateWorkOrders(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder[]> {
    this.logger.log(`Processing auto-generate work orders for tenant: ${tenantId}`);
    return this.maintenanceScheduleService.processAutoGenerateWorkOrders(
      tenantId,
      user.sub,
    );
  }
}
