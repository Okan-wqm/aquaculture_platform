import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { Shift } from './entities/shift.entity';
import { Schedule } from './entities/schedule.entity';
import { ScheduleEntry } from './entities/schedule-entry.entity';
import { AttendanceRecord } from './entities/attendance-record.entity';
import { AttendanceResolver } from './attendance.resolver';
import { AttendanceCommandHandlers } from './handlers';
import { AttendanceQueryHandlers } from './query-handlers';
import { Employee } from '../hr/entities/employee.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Shift,
      Schedule,
      ScheduleEntry,
      AttendanceRecord,
      Employee,
    ]),
    CqrsModule,
  ],
  providers: [
    AttendanceResolver,
    ...AttendanceCommandHandlers,
    ...AttendanceQueryHandlers,
  ],
  exports: [TypeOrmModule],
})
export class AttendanceModule {}
