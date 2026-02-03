import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { Role } from '../common/enums/role.enum';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Employee, EmployeeStatus, Department } from './entities/employee.entity';
import { Payroll, PayrollStatus } from './entities/payroll.entity';
import { CreateEmployeeInput } from './dto/create-employee.input';
import { UpdateEmployeeInput } from './dto/update-employee.input';
import { CreatePayrollInput } from './dto/create-payroll.input';
import { EmployeeFilterInput } from './dto/employee-filter.input';
import { CreateEmployeeCommand } from './commands/create-employee.command';
import { UpdateEmployeeCommand } from './commands/update-employee.command';
import { CreatePayrollCommand } from './commands/create-payroll.command';
import { ApprovePayrollCommand } from './commands/approve-payroll.command';
import { GetEmployeeQuery } from './queries/get-employee.query';
import { GetEmployeesQuery } from './queries/get-employees.query';
import { GetPayrollsQuery, PayrollFilterInput } from './queries/get-payrolls.query';
import { PaginatedEmployees } from './query-handlers/get-employees.handler';
import { PaginatedPayrolls } from './query-handlers/get-payrolls.handler';

@ObjectType()
class EmployeeConnection {
  @Field(() => [Employee])
  items!: Employee[];

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
class PayrollConnection {
  @Field(() => [Payroll])
  items!: Payroll[];

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
  @Roles(Role.ADMIN, Role.HR_MANAGER, Role.MANAGER)
  async getEmployee(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetEmployeeQuery(tenantId, id));
  }

  @Query(() => EmployeeConnection, { name: 'employees' })
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR_MANAGER, Role.MANAGER)
  async getEmployees(
    @Args('filter', { nullable: true }) filter: EmployeeFilterInput,
    @Context() context: GraphQLContext,
  ): Promise<PaginatedEmployees> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetEmployeesQuery(tenantId, filter));
  }

  @Query(() => [Employee], { name: 'employeesByDepartment' })
  async getEmployeesByDepartment(
    @Args('department', { type: () => Department }) department: Department,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset: number,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { department, limit, offset }),
    );
    return result.items;
  }

  @Query(() => [Employee], { name: 'activeEmployees' })
  async getActiveEmployees(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset: number,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { status: EmployeeStatus.ACTIVE, limit, offset }),
    );
    return result.items;
  }

  // Employee Mutations
  @Mutation(() => Employee)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR_MANAGER)
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
  @Roles(Role.ADMIN, Role.HR_MANAGER)
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
  @Roles(Role.ADMIN, Role.HR_MANAGER)
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
  @Roles(Role.ADMIN, Role.HR_MANAGER)
  async getPayrolls(
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId: string,
    @Args('status', { type: () => PayrollStatus, nullable: true }) status: PayrollStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset: number,
    @Context() context: GraphQLContext,
  ): Promise<PaginatedPayrolls> {
    const tenantId = this.getTenantId(context);
    const filter: PayrollFilterInput = { limit, offset };
    if (employeeId) filter.employeeId = employeeId;
    if (status) filter.status = status;
    return this.queryBus.execute(new GetPayrollsQuery(tenantId, filter));
  }

  @Query(() => [Payroll], { name: 'pendingPayrolls' })
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR_MANAGER)
  async getPendingPayrolls(
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset: number,
    @Context() context: GraphQLContext,
  ): Promise<Payroll[]> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetPayrollsQuery(tenantId, { status: PayrollStatus.PENDING_APPROVAL, limit, offset }),
    );
    return result.items;
  }

  // Payroll Mutations
  @Mutation(() => Payroll)
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR_MANAGER)
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
  @Roles(Role.ADMIN)
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
}
