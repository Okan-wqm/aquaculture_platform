import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { InitializeLeaveBalancesCommand } from '../commands/initialize-leave-balances.command';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveType } from '../entities/leave-type.entity';

/**
 * Seed leave balances for one employee for a given year.
 *
 * Creates one LeaveBalance row per active, accrued leave type that the
 * employee does not already have a row for, with openingBalance seeded from
 * the leave type's defaultDaysPerYear (the same seed the accrual cron uses as
 * its cap). Idempotent: existing balance rows are left untouched, so re-running
 * never double-seeds.
 */
@CommandHandler(InitializeLeaveBalancesCommand)
export class InitializeLeaveBalancesHandler
  implements ICommandHandler<InitializeLeaveBalancesCommand>
{
  private readonly logger = new Logger(InitializeLeaveBalancesHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: InitializeLeaveBalancesCommand): Promise<LeaveBalance[]> {
    const { tenantId, userId, employeeId, year } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });
      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Accrued, active leave types are the ones that carry a balance.
      const leaveTypes = await queryRunner.manager.find(LeaveType, {
        where: { tenantId, isActive: true, isAccrued: true, isDeleted: false },
      });

      // Pre-fetch the employee's existing balances for this year for O(1) skip.
      const existing = await queryRunner.manager.find(LeaveBalance, {
        where: { tenantId, employeeId, year, isDeleted: false },
      });
      const existingByLeaveTypeId = new Set(existing.map((b) => b.leaveTypeId));

      const created: LeaveBalance[] = [];
      for (const leaveType of leaveTypes) {
        if (existingByLeaveTypeId.has(leaveType.id)) {
          continue; // idempotent: already seeded
        }
        const opening = leaveType.defaultDaysPerYear != null
          ? Number(leaveType.defaultDaysPerYear)
          : 0;
        const balance = queryRunner.manager.create(LeaveBalance, {
          tenantId,
          employeeId,
          leaveTypeId: leaveType.id,
          year,
          openingBalance: opening,
          accrued: 0,
          used: 0,
          pending: 0,
          adjustment: 0,
          carriedOver: 0,
          createdBy: userId,
          updatedBy: userId,
        });
        const saved = await queryRunner.manager.save(LeaveBalance, balance);
        created.push(saved);
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Initialized ${created.length} leave balance(s) for employee ${employeeId} ` +
          `(tenant ${tenantId}, year ${year}).`,
      );

      // Return the full current balance set (existing + newly created) so the FE
      // gets the complete picture, not just the delta.
      return queryRunner.manager.find(LeaveBalance, {
        where: { tenantId, employeeId, year, isDeleted: false },
        relations: ['leaveType'],
        order: { leaveTypeId: 'ASC' },
      });
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
