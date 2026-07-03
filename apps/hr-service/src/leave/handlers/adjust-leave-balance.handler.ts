import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { AdjustLeaveBalanceCommand } from '../commands/adjust-leave-balance.command';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveType } from '../entities/leave-type.entity';

/**
 * Manual leave-balance adjustment (delta + reason).
 *
 * The signed `adjustment` delta is added to the balance row's persisted
 * `adjustment` accumulator — the SAME column the entity's currentBalance /
 * availableBalance getters already factor in. This reuses the existing balance
 * arithmetic instead of inventing a parallel ledger.
 *
 * A negative delta may not drive the resulting available balance below zero
 * (fail-closed): clawing back more than is available would corrupt downstream
 * deduction math.
 */
@CommandHandler(AdjustLeaveBalanceCommand)
export class AdjustLeaveBalanceHandler
  implements ICommandHandler<AdjustLeaveBalanceCommand>
{
  private readonly logger = new Logger(AdjustLeaveBalanceHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: AdjustLeaveBalanceCommand): Promise<LeaveBalance> {
    const { tenantId, userId, employeeId, leaveTypeId, year, adjustment, reason } = command;

    if (!Number.isFinite(adjustment) || adjustment === 0) {
      throw new BadRequestException('Adjustment must be a non-zero number');
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required for a manual balance adjustment');
    }

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

      const leaveType = await queryRunner.manager.findOne(LeaveType, {
        where: { id: leaveTypeId, tenantId, isDeleted: false },
      });
      if (!leaveType) {
        throw new NotFoundException(`Leave type with ID ${leaveTypeId} not found`);
      }

      // Pessimistic write lock: a concurrent request/adjustment on the same
      // balance row must serialize so the delta is applied to a fresh snapshot.
      let balance = await queryRunner.manager.findOne(LeaveBalance, {
        where: { tenantId, employeeId, leaveTypeId, year, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!balance) {
        // No row yet — seed a zeroed balance so the adjustment has a home.
        balance = queryRunner.manager.create(LeaveBalance, {
          tenantId,
          employeeId,
          leaveTypeId,
          year,
          openingBalance: 0,
          accrued: 0,
          used: 0,
          pending: 0,
          adjustment: 0,
          carriedOver: 0,
          createdBy: userId,
        });
      }

      const newAdjustment = Number(balance.adjustment) + Number(adjustment);

      // Fail-closed: a downward adjustment cannot push available below zero.
      const projectedAvailable =
        Number(balance.openingBalance) +
        Number(balance.accrued) +
        Number(balance.carriedOver) +
        newAdjustment -
        Number(balance.used) -
        Number(balance.pending);

      if (projectedAvailable < 0) {
        throw new BadRequestException(
          `Adjustment would drive available balance below zero (projected: ${projectedAvailable})`,
        );
      }

      balance.adjustment = newAdjustment;
      balance.updatedBy = userId;

      const saved = await queryRunner.manager.save(LeaveBalance, balance);
      await queryRunner.commitTransaction();

      this.logger.log(
        `Leave balance ${saved.id} adjusted by ${adjustment} for employee ${employeeId} ` +
          `(tenant ${tenantId}, year ${year}). Reason: ${reason}`,
      );
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
