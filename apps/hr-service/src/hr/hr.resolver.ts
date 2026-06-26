import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role, AuditLog } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Employee, EmployeeStatus, Department } from './entities/employee.entity';
import { DepartmentHR } from './entities/department.entity';
import { Payroll, PayrollStatus } from './entities/payroll.entity';
import { CreateEmployeeInput } from './dto/create-employee.input';
import { UpdateEmployeeInput } from './dto/update-employee.input';
import { CreatePayrollInput } from './dto/create-payroll.input';
import { CreateDepartmentInput } from './dto/create-department.input';
import { UpdateDepartmentInput } from './dto/update-department.input';
import { EmployeeFilterInput, EmployeePaginationInput } from './dto/employee-filter.input';
import { CreateEmployeeCommand } from './commands/create-employee.command';
import { UpdateEmployeeCommand } from './commands/update-employee.command';
import { CreatePayrollCommand } from './commands/create-payroll.command';
import { ApprovePayrollCommand } from './commands/approve-payroll.command';
import { CreateDepartmentCommand } from './commands/create-department.command';
import { UpdateDepartmentCommand } from './commands/update-department.command';
import { GetEmployeeQuery } from './queries/get-employee.query';
import { GetEmployeesQuery } from './queries/get-employees.query';
import { GetPayrollsQuery, PayrollFilterInput } from './queries/get-payrolls.query';
import { GetDepartmentsQuery, GetDepartmentQuery } from './queries/get-departments.query';
import { GetHRDashboardStatsQuery } from './queries/get-hr-dashboard-stats.query';
import { HRDashboardStats } from './query-handlers/get-hr-dashboard-stats.handler';

@ObjectType()
class EmployeeConnection extends StandardPaginatedResponse(Employee) {}

@ObjectType()
class PayrollConnection extends StandardPaginatedResponse(Payroll) {}

// SECURITY: Context only exposes JWT-verified user fields.
// Do NOT add x-tenant-id or x-user-id headers here — those are attacker-controlled
// and must never be used directly (LOW-01).
interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

@UseGuards(GqlAuthGuard)
@Resolver(() => Employee)
export class HRResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

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

  // Employee Queries
  @Query(() => Employee, { name: 'employee' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getEmployee(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetEmployeeQuery(tenantId, id));
  }

  @Query(() => EmployeeConnection, { name: 'employees' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getEmployees(
    @Args('filter', { nullable: true }) filter: EmployeeFilterInput,
    @Args('pagination', { nullable: true }) pagination: EmployeePaginationInput,
    @Context() context: GraphQLContext,
  ): Promise<IStandardPaginatedResult<Employee>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(new GetEmployeesQuery(tenantId, filter, pagination));
    return fromCqrsPaginated(result);
  }

  @Query(() => [Employee], { name: 'employeesByDepartment' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getEmployeesByDepartment(
    @Args('department', { type: () => Department }) department: Department,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { department }, { page, limit }),
    );
    return result.data;
  }

  @Query(() => [Employee], { name: 'activeEmployees' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getActiveEmployees(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { status: EmployeeStatus.ACTIVE }, { page, limit }),
    );
    return result.data;
  }

  // Employee Mutations
  @Mutation(() => Employee)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_EMPLOYEE', resource: 'Employee', description: 'Create a new employee record' })
  async createEmployee(
    @Args('input') input: CreateEmployeeInput,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateEmployeeCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Employee)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_EMPLOYEE', resource: 'Employee', description: 'Update an existing employee record' })
  async updateEmployee(
    @Args('input') input: UpdateEmployeeInput,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateEmployeeCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Employee)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @AuditLog({ action: 'TOGGLE_FARM_WORKER', resource: 'Employee', description: 'Toggle farm worker status on employee' })
  async toggleFarmWorker(
    @Args('id', { type: () => ID }) id: string,
    @Args('isFarmWorker') isFarmWorker: boolean,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateEmployeeCommand(tenantId, { id, isFarmWorker }, userId),
    );
  }

  @Mutation(() => Employee)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'TERMINATE_EMPLOYEE', resource: 'Employee', description: 'Terminate an employee' })
  async terminateEmployee(
    @Args('id', { type: () => ID }) id: string,
    @Args('terminationDate') terminationDate: string,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateEmployeeCommand(
        tenantId,
        {
          id,
          status: EmployeeStatus.TERMINATED,
          terminationDate,
        },
        userId,
      ),
    );
  }

  // Payroll Queries
  @Query(() => PayrollConnection, { name: 'payrolls' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPayrolls(
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId: string,
    @Args('status', { type: () => PayrollStatus, nullable: true }) status: PayrollStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Context() context: GraphQLContext,
  ): Promise<IStandardPaginatedResult<Payroll>> {
    const tenantId = this.getTenantId(context);
    const filter: PayrollFilterInput = { limit, page };
    if (employeeId) filter.employeeId = employeeId;
    if (status) filter.status = status;
    const result = await this.queryBus.execute(new GetPayrollsQuery(tenantId, filter));
    return fromCqrsPaginated(result);
  }

  @Query(() => [Payroll], { name: 'pendingPayrolls' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPendingPayrolls(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page: number,
    @Context() context: GraphQLContext,
  ): Promise<Payroll[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetPayrollsQuery(tenantId, { status: PayrollStatus.PENDING_APPROVAL, limit, page }),
    );
    return result.data;
  }

  // Payroll Mutations
  @Mutation(() => Payroll)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_PAYROLL', resource: 'Payroll', description: 'Create a new payroll entry' })
  async createPayroll(
    @Args('input') input: CreatePayrollInput,
    @Context() context: GraphQLContext,
  ): Promise<Payroll> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreatePayrollCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => Payroll)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'APPROVE_PAYROLL', resource: 'Payroll', description: 'Approve a payroll entry for payment' })
  async approvePayroll(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Payroll> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ApprovePayrollCommand(tenantId, id, userId),
    );
  }

  // Department Queries
  @Query(() => [DepartmentHR], { name: 'hrDepartments' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getDepartments(
    @Context() context: GraphQLContext,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('isDeleted', { nullable: true, defaultValue: false }) isDeleted?: boolean,
  ): Promise<DepartmentHR[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetDepartmentsQuery(tenantId, siteId, isDeleted));
  }

  @Query(() => DepartmentHR, { name: 'hrDepartment' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getDepartment(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<DepartmentHR> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetDepartmentQuery(tenantId, id));
  }

  // Department Mutations
  @Mutation(() => DepartmentHR, { name: 'createHRDepartment' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_DEPARTMENT', resource: 'Department', description: 'Create a new HR department' })
  async createHRDepartment(
    @Args('input') input: CreateDepartmentInput,
    @Context() context: GraphQLContext,
  ): Promise<DepartmentHR> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateDepartmentCommand(tenantId, input, userId),
    );
  }

  @Mutation(() => DepartmentHR, { name: 'updateHRDepartment' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_DEPARTMENT', resource: 'Department', description: 'Update an HR department' })
  async updateHRDepartment(
    @Args('input') input: UpdateDepartmentInput,
    @Context() context: GraphQLContext,
  ): Promise<DepartmentHR> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateDepartmentCommand(tenantId, input, userId),
    );
  }

  // HR Dashboard Stats
  @Query(() => HRDashboardStats, { name: 'hrDashboardStats' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getHRDashboardStats(
    @Context() context: GraphQLContext,
  ): Promise<HRDashboardStats> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetHRDashboardStatsQuery(tenantId));
  }
}
