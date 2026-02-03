import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { SubmitLeaveRequestCommand } from '../commands/submit-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequestSubmittedEvent } from '../events/leave.events';

@CommandHandler(SubmitLeaveRequestCommand)
export class SubmitLeaveRequestHandler
  implements ICommandHandler<SubmitLeaveRequestCommand>
{
  private readonly logger = new Logger(SubmitLeaveRequestHandler.name);

  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: SubmitLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
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
      const leaveBalance = await queryRunner.manager.findOne(LeaveBalance, {
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
        await queryRunner.manager.save(LeaveBalance, leaveBalance);
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

      const savedRequest = await queryRunner.manager.save(LeaveRequest, leaveRequest);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new LeaveRequestSubmittedEvent(savedRequest)).catch((err: unknown) => {
        this.logger.warn(`Failed to publish LeaveRequestSubmittedEvent: ${err instanceof Error ? err.message : String(err)}`);
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
