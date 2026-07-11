import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';
import { HrOutboxModule } from '../hr-outbox.module';
import { HrFinanceModule } from '../finance/hr-finance.module';
import { LeaveRequest } from '../leave/entities/leave-request.entity';
import { EmployeeCertification } from '../training/entities/employee-certification.entity';

import { InternalHrContactController } from './controllers/internal-hr-contact.controller';
import { DepartmentHR } from './entities/department.entity';
import { Employee } from './entities/employee.entity';
import { PayrollAudit } from './entities/payroll-audit.entity';
import { Payroll } from './entities/payroll.entity';
import { HRResolver } from './hr.resolver';
import { EmployeeErasureService } from './services/employee-erasure.service';

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
import {
  GetDepartmentsHandler,
  GetDepartmentHandler,
} from './query-handlers/get-departments.handler';
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
    TypeOrmModule.forFeature([
      Employee,
      Payroll,
      PayrollAudit,
      DepartmentHR,
      AttendanceRecord,
      LeaveRequest,
      EmployeeCertification,
    ]),
    CqrsModule,
    HrOutboxModule,
    // Currency SSoT: CreateEmployeeHandler resolves the tenant default
    // currency through PayrollCostSettingsService (exported by
    // HrFinanceModule). HrFinanceModule does not import HRModule, so
    // there is no DI cycle.
    HrFinanceModule,
  ],
  providers: [HRResolver, ...CommandHandlers, ...QueryHandlers, EmployeeErasureService],
  controllers: [InternalHrContactController],
  exports: [TypeOrmModule, EmployeeErasureService],
})
export class HRModule {}
