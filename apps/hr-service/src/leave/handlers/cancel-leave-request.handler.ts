import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { CancelLeaveRequestCommand } from '../commands/cancel-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveCancelledEvent } from '../events/leave.events';

@CommandHandler(CancelLeaveRequestCommand)
export class CancelLeaveRequestHandler
  implements ICommandHandler<CancelLeaveRequestCommand>
{
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CancelLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, reason } = command;

    const leaveRequest = await this.leaveRequestRepository.findOne({
      where: { id: leaveRequestId, tenantId, isDeleted: false },
    });

    if (!leaveRequest) {
      throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
    }

    // Only the employee or an approver can cancel
    const isOwnRequest = leaveRequest.employeeId === userId || leaveRequest.createdBy === userId;

    // Cannot cancel already cancelled, rejected or withdrawn requests
    const nonCancellableStatuses = [
      LeaveRequestStatus.CANCELLED,
      LeaveRequestStatus.REJECTED,
      LeaveRequestStatus.WITHDRAWN,
    ];

    if (nonCancellableStatuses.includes(leaveRequest.status)) {
      throw new BadRequestException(
        `Cannot cancel leave request with status ${leaveRequest.status}`,
      );
    }

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
    const leaveBalance = await this.leaveBalanceRepository.findOne({
      where: {
        tenantId,
        employeeId: leaveRequest.employeeId,
        leaveTypeId: leaveRequest.leaveTypeId,
        year: currentYear,
        isDeleted: false,
      },
    });

    if (leaveBalance) {
      if (leaveRequest.status === LeaveRequestStatus.PENDING) {
        // Restore from pending
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
      await this.leaveBalanceRepository.save(leaveBalance);
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

    const savedRequest = await this.leaveRequestRepository.save(leaveRequest);

    // Publish event for notification/audit purposes
    this.eventBus.publish(new LeaveCancelledEvent(savedRequest));

    return savedRequest;
  }
}
