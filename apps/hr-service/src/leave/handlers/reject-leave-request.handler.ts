import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { RejectLeaveRequestCommand } from '../commands/reject-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveStateMachine } from '../leave-state-machine';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { createLeaveRejectedEvent } from '../events/leave.events';

@CommandHandler(RejectLeaveRequestCommand)
export class RejectLeaveRequestHandler
  implements ICommandHandler<RejectLeaveRequestCommand>
{
  private readonly logger = new Logger(RejectLeaveRequestHandler.name);

  constructor(
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: RejectLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, reason } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      // HR-HIGH-010: Pessimistic write lock prevents concurrent approve+reject race.
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
        where: { id: leaveRequestId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
      }

      // Resolve the rejector's employee ID from auth userId to prevent cross-namespace comparison
      const rejectorEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });

      // Cannot reject own leave request
      if (rejectorEmployee && leaveRequest.employeeId === rejectorEmployee.id) {
        throw new ForbiddenException('You cannot reject your own leave request');
      }

      // HR-HIGH-008: Use centralized state machine for transition validation.
      LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.REJECTED);

      // Restore pending balance
      const currentYear = new Date(leaveRequest.startDate).getFullYear();
      // Pessimistic lock prevents concurrent approve+reject from corrupting balance.
      const leaveBalance = await queryRunner.manager.findOne(LeaveBalance, {
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
        leaveBalance.pending = Math.max(
          0,
          Number(leaveBalance.pending) - Number(leaveRequest.totalDays),
        );
        leaveBalance.updatedBy = userId;
        await queryRunner.manager.save(LeaveBalance, leaveBalance);
      }

      // Update leave request
      leaveRequest.status = LeaveRequestStatus.REJECTED;
      leaveRequest.rejectedBy = userId;
      leaveRequest.rejectedAt = new Date();
      leaveRequest.rejectionReason = reason;
      leaveRequest.approvalHistory = [
        ...(leaveRequest.approvalHistory || []),
        {
          action: 'rejected',
          actorId: userId,
          timestamp: new Date(),
          notes: reason,
        },
      ];
      leaveRequest.updatedBy = userId;

      const savedRequest = await queryRunner.manager.save(LeaveRequest, leaveRequest);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(createLeaveRejectedEvent(savedRequest, userId, reason)).catch((err: unknown) => {
        this.logger.warn(`Failed to publish LeaveRejectedEvent: ${err instanceof Error ? err.message : String(err)}`);
      });

      return savedRequest;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
