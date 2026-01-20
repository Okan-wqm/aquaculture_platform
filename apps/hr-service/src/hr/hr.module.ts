import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { Employee } from './entities/employee.entity';
import { Payroll } from './entities/payroll.entity';
import { HRResolver } from './hr.resolver';

// Command Handlers
import { CreateEmployeeHandler } from './handlers/create-employee.handler';
import { UpdateEmployeeHandler } from './handlers/update-employee.handler';
import { CreatePayrollHandler } from './handlers/create-payroll.handler';
import { ApprovePayrollHandler } from './handlers/approve-payroll.handler';

// Query Handlers
import { GetEmployeeHandler } from './query-handlers/get-employee.handler';
import { GetEmployeesHandler } from './query-handlers/get-employees.handler';
import { GetPayrollsHandler } from './query-handlers/get-payrolls.handler';

const CommandHandlers = [
  CreateEmployeeHandler,
  UpdateEmployeeHandler,
  CreatePayrollHandler,
  ApprovePayrollHandler,
];

const QueryHandlers = [
  GetEmployeeHandler,
  GetEmployeesHandler,
  GetPayrollsHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, Payroll]),
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
