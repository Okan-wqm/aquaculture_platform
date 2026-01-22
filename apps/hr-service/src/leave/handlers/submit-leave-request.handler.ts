import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { SubmitLeaveRequestCommand } from '../commands/submit-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequestSubmittedEvent } from '../events/leave.events';

@CommandHandler(SubmitLeaveRequestCommand)
export class SubmitLeaveRequestHandler
  implements ICommandHandler<SubmitLeaveRequestCommand>
{
  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: SubmitLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId } = command;

    const leaveRequest = await this.leaveRequestRepository.findOne({
      where: { id: leaveRequestId, tenantId, isDeleted: false },
    });

    if (!leaveRequest) {
      throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
    }

    // Only the employee who created the request can submit it
    if (leaveRequest.createdBy !== userId && leaveRequest.employeeId !== userId) {
      throw new ForbiddenException('You can only submit your own leave requests');
    }

    // Can only submit from DRAFT status
    if (leaveRequest.status !== LeaveRequestStatus.DRAFT) {
      throw new BadRequestException(
        `Cannot submit leave request with status ${leaveRequest.status}. Only DRAFT requests can be submitted.`,
      );
    }

    // Update pending balance
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
      leaveBalance.pending = Number(leaveBalance.pending) + Number(leaveRequest.totalDays);
      leaveBalance.updatedBy = userId;
      await this.leaveBalanceRepository.save(leaveBalance);
    }

    // Update status and add to approval history
    leaveRequest.status = LeaveRequestStatus.PENDING;
    leaveRequest.approvalHistory = [
      ...(leaveRequest.approvalHistory || []),
      {
        action: 'submitted',
        actorId: userId,
        timestamp: new Date(),
        notes: 'Leave request submitted for approval',
      },
    ];
    leaveRequest.updatedBy = userId;

    const savedRequest = await this.leaveRequestRepository.save(leaveRequest);

    // Publish event for notification/audit purposes
    this.eventBus.publish(new LeaveRequestSubmittedEvent(savedRequest));

    return savedRequest;
  }
}
