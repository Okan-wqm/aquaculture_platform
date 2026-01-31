import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ApproveLeaveRequestCommand } from '../commands/approve-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveApprovedEvent } from '../events/leave.events';

@CommandHandler(ApproveLeaveRequestCommand)
export class ApproveLeaveRequestHandler
  implements ICommandHandler<ApproveLeaveRequestCommand>
{
  private readonly logger = new Logger(ApproveLeaveRequestHandler.name);

  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ApproveLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId, notes } = command;

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

      // Cannot approve own leave request
      if (leaveRequest.employeeId === userId) {
        throw new ForbiddenException('You cannot approve your own leave request');
      }

      // Can only approve PENDING requests
      if (leaveRequest.status !== LeaveRequestStatus.PENDING) {
        throw new BadRequestException(
          `Cannot approve leave request with status ${leaveRequest.status}. Only PENDING requests can be approved.`,
        );
      }

      // Update balance - move from pending to used
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
        leaveBalance.used = Number(leaveBalance.used) + Number(leaveRequest.totalDays);
        leaveBalance.updatedBy = userId;
        await queryRunner.manager.save(LeaveBalance, leaveBalance);
      }

      // Update leave request
      leaveRequest.status = LeaveRequestStatus.APPROVED;
      leaveRequest.approvedBy = userId;
      leaveRequest.approvedAt = new Date();
      leaveRequest.approvalHistory = [
        ...(leaveRequest.approvalHistory || []),
        {
          action: 'approved',
          actorId: userId,
          timestamp: new Date(),
          notes: notes || 'Leave request approved',
        },
      ];
      leaveRequest.updatedBy = userId;

      const savedRequest = await queryRunner.manager.save(LeaveRequest, leaveRequest);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(new LeaveApprovedEvent(savedRequest)).catch((err) => {
        this.logger.warn(`Failed to publish LeaveApprovedEvent: ${err instanceof Error ? err.message : String(err)}`);
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
