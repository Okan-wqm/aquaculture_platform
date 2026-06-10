import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WorkArea } from '../aquaculture/entities/work-area.entity';
import { Employee } from '../hr/entities/employee.entity';
import { HrOutboxModule } from '../hr-outbox.module';
import { LeaveRequest } from '../leave/entities/leave-request.entity';
import { HrMobileCommandReceipt } from '../mobile-command/entities/hr-mobile-command-receipt.entity';

import { AttendanceResolver } from './attendance.resolver';
import { AttendanceRecord } from './entities/attendance-record.entity';
import { ScheduleEntry } from './entities/schedule-entry.entity';
import { Schedule } from './entities/schedule.entity';
import { Shift } from './entities/shift.entity';
import { AttendanceCommandHandlers } from './handlers';
import { AttendanceQueryHandlers } from './query-handlers';


@Module({
  imports: [
    TypeOrmModule.forFeature([
      Shift,
      Schedule,
      ScheduleEntry,
      AttendanceRecord,
      Employee,
      LeaveRequest,
      WorkArea,
      HrMobileCommandReceipt,
    ]),
    CqrsModule,
    HrOutboxModule,
  ],
  providers: [
    AttendanceResolver,
    MobileCommandReceiptService,
    ...AttendanceCommandHandlers,
    ...AttendanceQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class AttendanceModule {}
