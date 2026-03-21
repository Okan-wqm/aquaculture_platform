import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { Employee } from './entities/employee.entity';
import { Payroll } from './entities/payroll.entity';
import { DepartmentHR } from './entities/department.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { HRResolver } from './hr.resolver';

// Command Handlers
import { CreateEmployeeHandler } from './handlers/create-employee.handler';
import { UpdateEmployeeHandler } from './handlers/update-employee.handler';
import { CreatePayrollHandler } from './handlers/create-payroll.handler';
import { ApprovePayrollHandler } from './handlers/approve-payroll.handler';
import { CreateDepartmentHandler } from './handlers/create-department.handler';
import { UpdateDepartmentHandler } from './handlers/update-department.handler';

// Query Handlers
import { GetEmployeeHandler } from './query-handlers/get-employee.handler';
import { GetEmployeesHandler } from './query-handlers/get-employees.handler';
import { GetPayrollsHandler } from './query-handlers/get-payrolls.handler';
import { GetDepartmentsHandler, GetDepartmentHandler } from './query-handlers/get-departments.handler';
import { GetHRDashboardStatsHandler } from './query-handlers/get-hr-dashboard-stats.handler';

const CommandHandlers = [
  CreateEmployeeHandler,
  UpdateEmployeeHandler,
  CreatePayrollHandler,
  ApprovePayrollHandler,
  CreateDepartmentHandler,
  UpdateDepartmentHandler,
];

const QueryHandlers = [
  GetEmployeeHandler,
  GetEmployeesHandler,
  GetPayrollsHandler,
  GetDepartmentsHandler,
  GetDepartmentHandler,
  GetHRDashboardStatsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, Payroll, DepartmentHR, AttendanceRecord]),
    CqrsModule,
  ],
  providers: [
    HRResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class HRModule {}
