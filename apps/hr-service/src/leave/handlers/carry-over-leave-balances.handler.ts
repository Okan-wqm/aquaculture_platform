import { BadRequestException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';

import { CarryOverLeaveBalancesCommand } from '../commands/carry-over-leave-balances.command';
import { CarryOverLeaveBalancesResult } from '../dto/leave-admin.types';
import { LeaveAccrualService } from '../leave-accrual.service';

/**
 * On-demand year-end carry-over for the calling tenant.
 *
 * Delegates the carry-over math to LeaveAccrualService.carryOverWithinSchema —
 * the SAME routine the year-end rollover cron uses — so the operator-triggered
 * path and the scheduled path can never diverge. The transaction is owned here;
 * the request is already routed to the tenant schema (search_path =
 * tenant_<uuid> via TenantContextMiddleware), so no schema switching is needed.
 */
@CommandHandler(CarryOverLeaveBalancesCommand)
export class CarryOverLeaveBalancesHandler
  implements ICommandHandler<CarryOverLeaveBalancesCommand>
{
  private readonly logger = new Logger(CarryOverLeaveBalancesHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly leaveAccrualService: LeaveAccrualService,
  ) {}

  async execute(
    command: CarryOverLeaveBalancesCommand,
  ): Promise<CarryOverLeaveBalancesResult> {
    const { tenantId, userId, fromYear, toYear } = command;

    if (toYear <= fromYear) {
      throw new BadRequestException('toYear must be greater than fromYear');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const outcome = await this.leaveAccrualService.carryOverWithinSchema(
        queryRunner.manager,
        fromYear,
        toYear,
        userId,
      );

      await queryRunner.commitTransaction();

      this.logger.log(
        `Carry-over for tenant ${tenantId}: ${outcome.successful} of ${outcome.processed} ` +
          `balance(s) carried from ${fromYear} to ${toYear} (${outcome.failed} failed).`,
      );

      return outcome;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
