import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { RejectLeaveRequestCommand } from '../commands/reject-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRejectedEvent } from '../events/leave.events';

@CommandHandler(RejectLeaveRequestCommand)
export class RejectLeaveRequestHandler
  implements ICommandHandler<RejectLeaveRequestCommand>
{
  private readonly logger = new Logger(RejectLeaveRequestHandler.name);

  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: RejectLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, reason } = command;

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
      this.eventBus.publish(new LeaveRejectedEvent(savedRequest)).catch((err: unknown) => {
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
