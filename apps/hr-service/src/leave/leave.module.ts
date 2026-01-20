import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest } from './entities/leave-request.entity';
import { LeaveResolver } from './leave.resolver';
import { LeaveCommandHandlers } from './handlers';
import { LeaveQueryHandlers } from './query-handlers';
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
  ],
  providers: [
    LeaveResolver,
    ...LeaveCommandHandlers,
    ...LeaveQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class LeaveModule {}
