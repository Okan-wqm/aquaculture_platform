import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger, InternalServerErrorException } from '@nestjs/common';
import { CancelLeaveRequestCommand } from '../commands/cancel-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveStateMachine } from '../leave-state-machine';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { createLeaveCancelledEvent } from '../events/leave.events';

@CommandHandler(CancelLeaveRequestCommand)
export class CancelLeaveRequestHandler
  implements ICommandHandler<CancelLeaveRequestCommand>
{
  private readonly logger = new Logger(CancelLeaveRequestHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CancelLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, reason } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const leaveRequestRepo = queryRunner.manager.getRepository(LeaveRequest);
      const leaveBalanceRepo = queryRunner.manager.getRepository(LeaveBalance);

      const leaveRequest = await leaveRequestRepo.findOne({
        where: { id: leaveRequestId, tenantId, isDeleted: false },
      });

      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
      }

      // Resolve the canceller's employee ID from auth userId to prevent cross-namespace comparison.
      // leaveRequest.employeeId is an HR employee UUID; userId is an auth-service user UUID.
      // Comparing them directly would be comparing different ID spaces (Bug H-9 / cancel variant).
      const cancellerEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });

      // Only the employee who owns the request or the user who created it can cancel
      const isCreator = leaveRequest.createdBy === userId;
      const isOwner = cancellerEmployee && leaveRequest.employeeId === cancellerEmployee.id;
      if (!isCreator && !isOwner) {
        throw new ForbiddenException('You can only cancel your own leave requests');
      }

      // HR-HIGH-008: Use centralized state machine for transition validation.
      // Replaces ad-hoc nonCancellableStatuses array with FSM-enforced transitions.
      LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.CANCELLED);

      // If approved, check if leave hasn't started yet
      if (leaveRequest.status === LeaveRequestStatus.APPROVED) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const startDate = new Date(leaveRequest.startDate);
        startDate.setHours(0, 0, 0, 0);

        if (startDate <= today) {
          throw new BadRequestException(
            'Cannot cancel leave request that has already started or completed',
          );
        }
      }

      // Restore balance based on previous status
      const currentYear = new Date(leaveRequest.startDate).getFullYear();
      // Pessimistic lock: concurrent cancel calls on the same leave request
      // could both read the same balance snapshot and corrupt it.
      const leaveBalance = await leaveBalanceRepo.findOne({
        where: {
          tenantId,
          employeeId: leaveRequest.employeeId,
          leaveTypeId: leaveRequest.leaveTypeId,
          year: currentYear,
          isDeleted: false,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (leaveBalance) {
        if (leaveRequest.status === LeaveRequestStatus.DRAFT || leaveRequest.status === LeaveRequestStatus.PENDING) {
          // Restore from pending — note: pending is incremented at DRAFT creation time
          // (CreateLeaveRequestHandler) to close the TOCTOU window on balance checks.
          leaveBalance.pending = Math.max(
            0,
            Number(leaveBalance.pending) - Number(leaveRequest.totalDays),
          );
        } else if (leaveRequest.status === LeaveRequestStatus.APPROVED) {
          // Restore from used
          leaveBalance.used = Math.max(
            0,
            Number(leaveBalance.used) - Number(leaveRequest.totalDays),
          );
        }
        leaveBalance.updatedBy = userId;
        await leaveBalanceRepo.save(leaveBalance);
      }

      // Update leave request
      leaveRequest.status = LeaveRequestStatus.CANCELLED;
      leaveRequest.cancelledBy = userId;
      leaveRequest.cancelledAt = new Date();
      leaveRequest.cancellationReason = reason;
      leaveRequest.approvalHistory = [
        ...(leaveRequest.approvalHistory || []),
        {
          action: 'cancelled',
          actorId: userId,
          timestamp: new Date(),
          notes: reason || 'Leave request cancelled',
        },
      ];
      leaveRequest.updatedBy = userId;

      const savedRequest = await leaveRequestRepo.save(leaveRequest);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(createLeaveCancelledEvent(savedRequest, userId, reason));

      return savedRequest;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to cancel leave request ${leaveRequestId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to cancel leave request');
    } finally {
      await queryRunner.release();
    }
  }
}
