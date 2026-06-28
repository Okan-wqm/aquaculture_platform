import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Employee } from '../hr/entities/employee.entity';
import { HrOutboxModule } from '../hr-outbox.module';
import { HrMobileCommandReceipt } from '../mobile-command/entities/hr-mobile-command-receipt.entity';
// Holiday is owned by the scheduling domain but read (no writes) by the
// calculateLeaveDays query to exclude tenant holidays from working-day counts.
import { Holiday } from '../scheduling/entities/holiday.entity';

import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest } from './entities/leave-request.entity';
import { LeaveType } from './entities/leave-type.entity';
import { LeaveCommandHandlers } from './handlers';
import { LeaveAccrualService } from './leave-accrual.service';
import { LeaveResolver } from './leave.resolver';
import { LeaveQueryHandlers } from './query-handlers';


@Module({
  imports: [
    TypeOrmModule.forFeature([
      LeaveType,
      LeaveBalance,
      LeaveRequest,
      Employee,
      Holiday,
      HrMobileCommandReceipt,
    ]),
    CqrsModule,
    ScheduleModule,
    HrOutboxModule,
  ],
  providers: [
    LeaveResolver,
    MobileCommandReceiptService,
    // SEC-HIGH-052: mobile-feature guard ('leave' entitlement).
    MobileFeatureGuard,
    ...LeaveCommandHandlers,
    ...LeaveQueryHandlers,
    LeaveAccrualService,
  ],
  exports: [TypeOrmModule],
})
export class LeaveModule {}
