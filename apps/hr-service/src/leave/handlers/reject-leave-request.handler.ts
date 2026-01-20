import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { RejectLeaveRequestCommand } from '../commands/reject-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';

@CommandHandler(RejectLeaveRequestCommand)
export class RejectLeaveRequestHandler
  implements ICommandHandler<RejectLeaveRequestCommand>
{
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: RejectLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, reason } = command;

    const leaveRequest = await this.leaveRequestRepository.findOne({
      where: { id: leaveRequestId, tenantId, isDeleted: false },
    });

    if (!leaveRequest) {
      throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
    }

    // Cannot reject own leave request
    if (leaveRequest.employeeId === userId) {
      throw new ForbiddenException('You cannot reject your own leave request');
    }

    // Can only reject PENDING requests
    if (leaveRequest.status !== LeaveRequestStatus.PENDING) {
      throw new BadRequestException(
        `Cannot reject leave request with status ${leaveRequest.status}. Only PENDING requests can be rejected.`,
      );
    }

    // Restore pending balance
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
      leaveBalance.pending = Math.max(
        0,
        Number(leaveBalance.pending) - Number(leaveRequest.totalDays),
      );
      leaveBalance.updatedBy = userId;
      await this.leaveBalanceRepository.save(leaveBalance);
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

    const savedRequest = await this.leaveRequestRepository.save(leaveRequest);

    // TODO: Publish LeaveRejectedEvent
    // this.eventBus.publish(new LeaveRejectedEvent(savedRequest));

    return savedRequest;
  }
}
