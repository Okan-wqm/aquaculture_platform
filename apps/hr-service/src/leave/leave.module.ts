import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest } from './entities/leave-request.entity';
import { LeaveResolver } from './leave.resolver';
import { LeaveCommandHandlers } from './handlers';
import { LeaveQueryHandlers } from './query-handlers';
import { LeaveAccrualService } from './leave-accrual.service';
import { Employee } from '../hr/entities/employee.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LeaveType,
      LeaveBalance,
      LeaveRequest,
      Employee,
    ]),
    CqrsModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    LeaveResolver,
    ...LeaveCommandHandlers,
    ...LeaveQueryHandlers,
    LeaveAccrualService,
  ],
  exports: [TypeOrmModule],
})
export class LeaveModule {}
