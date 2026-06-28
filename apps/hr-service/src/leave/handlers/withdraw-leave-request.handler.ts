import {
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { WithdrawLeaveRequestCommand } from '../commands/withdraw-leave-request.command';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveStateMachine } from '../leave-state-machine';

/**
 * Employee self-service withdrawal of a not-yet-decided leave request.
 *
 * WITHDRAWN is a FIRST-CLASS terminal status in LeaveStateMachine, distinct
 * from CANCELLED:
 *   - withdraw: employee retracts their OWN request before a decision
 *     (DRAFT → WITHDRAWN, PENDING → WITHDRAWN);
 *   - cancel: also covers APPROVED → CANCELLED (admin/employee voiding an
 *     already-granted leave that hasn't started).
 * Because the state machine already models WITHDRAWN with its own transitions,
 * this maps to that real transition rather than aliasing cancel.
 *
 * The transition is validated through LeaveStateMachine (never bypassed), so a
 * withdraw from APPROVED/REJECTED/CANCELLED is structurally rejected. The
 * pending balance reserved at create time is released using the SAME arithmetic
 * as the cancel handler.
 */
@CommandHandler(WithdrawLeaveRequestCommand)
export class WithdrawLeaveRequestHandler
  implements ICommandHandler<WithdrawLeaveRequestCommand>
{
  private readonly logger = new Logger(WithdrawLeaveRequestHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: WithdrawLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
        where: { id: leaveRequestId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
      }

      // Ownership: only the requesting employee (or the creator) may withdraw.
      // Withdrawal is a self-service action — NOT a supervisory one — so there
      // is no manager override path here (that is what cancel/reject are for).
      const withdrawerEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });
      const isCreator = leaveRequest.createdBy === userId;
      const isOwner =
        !!withdrawerEmployee && leaveRequest.employeeId === withdrawerEmployee.id;
      if (!isCreator && !isOwner) {
        throw new ForbiddenException('You can only withdraw your own leave requests');
      }

      // Validate the transition through the centralized state machine.
      LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.WITHDRAWN);

      // Release the pending reservation (only DRAFT/PENDING hold pending days;
      // both are the only legal source states for WITHDRAWN per the FSM).
      const year = new Date(leaveRequest.startDate).getFullYear();
      const balance = await queryRunner.manager.findOne(LeaveBalance, {
        where: {
          tenantId,
          employeeId: leaveRequest.employeeId,
          leaveTypeId: leaveRequest.leaveTypeId,
          year,
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (balance) {
        balance.pending = Math.max(
          0,
          Number(balance.pending) - Number(leaveRequest.totalDays),
        );
        balance.updatedBy = userId;
        await queryRunner.manager.save(LeaveBalance, balance);
      }

      leaveRequest.status = LeaveRequestStatus.WITHDRAWN;
      leaveRequest.approvalHistory = [
        ...(leaveRequest.approvalHistory || []),
        {
          action: 'withdrawn',
          actorId: userId,
          timestamp: new Date(),
          notes: 'Leave request withdrawn by employee',
        },
      ];
      leaveRequest.updatedBy = userId;

      const saved = await queryRunner.manager.save(LeaveRequest, leaveRequest);
      await queryRunner.commitTransaction();

      this.logger.log(`Leave request ${saved.id} withdrawn by ${userId} (tenant ${tenantId})`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
