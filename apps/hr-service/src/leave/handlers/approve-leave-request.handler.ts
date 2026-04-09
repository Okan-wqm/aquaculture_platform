import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { ApproveLeaveRequestCommand } from '../commands/approve-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveStateMachine } from '../leave-state-machine';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { createLeaveApprovedEvent } from '../events/leave.events';

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
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      // HR-HIGH-010: Pessimistic write lock prevents concurrent approvals.
      // Two managers approving overlapping leave requests simultaneously would
      // both see PENDING and both commit APPROVED without this lock.
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
        where: { id: leaveRequestId, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
      }

      // Resolve the approver's employee ID from auth userId to prevent cross-namespace comparison
      const approverEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });

      // Cannot approve own leave request
      if (approverEmployee && leaveRequest.employeeId === approverEmployee.id) {
        throw new ForbiddenException('You cannot approve your own leave request');
      }

      // HR-HIGH-008: Use centralized state machine for transition validation.
      // Invalid transitions (e.g., APPROVED→APPROVED, CANCELLED→APPROVED) throw immediately.
      LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.APPROVED);

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
          timestamp: new Date().toISOString(),
          notes: notes || 'Leave request approved',
        },
      ];
      leaveRequest.updatedBy = userId;

      const savedRequest = await queryRunner.manager.save(LeaveRequest, leaveRequest);

      await queryRunner.commitTransaction();

      // Publish event for notification/audit purposes
      this.eventBus.publish(createLeaveApprovedEvent(savedRequest, userId)).catch((err: unknown) => {
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
