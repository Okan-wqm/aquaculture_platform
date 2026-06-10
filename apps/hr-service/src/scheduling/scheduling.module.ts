import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { SchedulingSettings } from './entities/scheduling-settings.entity';
import { WeeklyPlan } from './entities/weekly-plan.entity';
import { WeeklyPlanEntry } from './entities/weekly-plan-entry.entity';
import { Holiday } from './entities/holiday.entity';
// External entities needed for handlers
import { Shift } from '../attendance/entities/shift.entity';
import { Employee } from '../hr/entities/employee.entity';
import { LeaveRequest } from '../leave/entities/leave-request.entity';
import { AttendanceRecord } from '../attendance/entities/attendance-record.entity';

// Resolver
import { SchedulingResolver } from './scheduling.resolver';

// Command Handlers
import { CreateWeeklyPlanHandler } from './handlers/create-weekly-plan.handler';
import { UpdatePlanEntryHandler } from './handlers/update-plan-entry.handler';
import { BulkAssignShiftsHandler } from './handlers/bulk-assign-shifts.handler';
import { PublishWeeklyPlanHandler } from './handlers/publish-weekly-plan.handler';
import { CopyWeeklyPlanHandler } from './handlers/copy-weekly-plan.handler';
import { UpdateSchedulingSettingsHandler } from './handlers/update-scheduling-settings.handler';
import { DeleteWeeklyPlanHandler } from './handlers/delete-weekly-plan.handler';

// Query Handlers
import { GetWeeklyPlansHandler } from './query-handlers/get-weekly-plans.handler';
import { GetWeeklyPlanHandler } from './query-handlers/get-weekly-plan.handler';
import { GetTeamWeeklyOverviewHandler } from './query-handlers/get-team-weekly-overview.handler';
import { GetSchedulingSettingsHandler } from './query-handlers/get-scheduling-settings.handler';
import { GetOvertimeSummaryHandler } from './query-handlers/get-overtime-summary.handler';

// Services
import { OvertimeCalculatorService } from './services/overtime-calculator.service';
import { ConflictDetectionService } from './services/conflict-detection.service';
import { ScheduleNotificationService } from './services/schedule-notification.service';

const CommandHandlers = [
  CreateWeeklyPlanHandler,
  UpdatePlanEntryHandler,
  BulkAssignShiftsHandler,
  PublishWeeklyPlanHandler,
  CopyWeeklyPlanHandler,
  UpdateSchedulingSettingsHandler,
  DeleteWeeklyPlanHandler,
];

const QueryHandlers = [
  GetWeeklyPlansHandler,
  GetWeeklyPlanHandler,
  GetTeamWeeklyOverviewHandler,
  GetSchedulingSettingsHandler,
  GetOvertimeSummaryHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SchedulingSettings,
      WeeklyPlan,
      WeeklyPlanEntry,
      Holiday,
      Shift,
      Employee,
      LeaveRequest,
      AttendanceRecord,
    ]),
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('hr-service'),
      },
    ]),
    CqrsModule,
  ],
  providers: [
    SchedulingResolver,
    ...CommandHandlers,
    ...QueryHandlers,
    OvertimeCalculatorService,
    ConflictDetectionService,
    ScheduleNotificationService,
  ],
  exports: [OvertimeCalculatorService, ConflictDetectionService, ScheduleNotificationService],
})
export class SchedulingModule {}
