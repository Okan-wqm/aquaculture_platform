import { Resolver, Query, Mutation, Args, ID, Context } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
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

@Resolver(() => Employee)
export class HRResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

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

  // Employee Queries
  @Query(() => Employee, { name: 'employee' })
  async getEmployee(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Employee> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetEmployeeQuery(tenantId, id));
  }

  @Query(() => [Employee], { name: 'employees' })
  async getEmployees(
    @Args('filter', { nullable: true }) filter: EmployeeFilterInput,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetEmployeesQuery(tenantId, filter));
  }

  @Query(() => [Employee], { name: 'employeesByDepartment' })
  async getEmployeesByDepartment(
    @Args('department', { type: () => Department }) department: Department,
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { department }),
    );
  }

  @Query(() => [Employee], { name: 'activeEmployees' })
  async getActiveEmployees(
    @Context() context: GraphQLContext,
  ): Promise<Employee[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetEmployeesQuery(tenantId, { status: EmployeeStatus.ACTIVE }),
    );
  }

  // Employee Mutations
  @Mutation(() => Employee)
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
  @Query(() => [Payroll], { name: 'payrolls' })
  async getPayrolls(
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId: string,
    @Args('status', { type: () => PayrollStatus, nullable: true }) status: PayrollStatus,
    @Context() context: GraphQLContext,
  ): Promise<Payroll[]> {
    const tenantId = this.getTenantId(context);
    const filter: PayrollFilterInput = {};
    if (employeeId) filter.employeeId = employeeId;
    if (status) filter.status = status;
    return this.queryBus.execute(new GetPayrollsQuery(tenantId, filter));
  }

  @Query(() => [Payroll], { name: 'pendingPayrolls' })
  async getPendingPayrolls(
    @Context() context: GraphQLContext,
  ): Promise<Payroll[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetPayrollsQuery(tenantId, { status: PayrollStatus.PENDING_APPROVAL }),
    );
  }

  // Payroll Mutations
  @Mutation(() => Payroll)
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
