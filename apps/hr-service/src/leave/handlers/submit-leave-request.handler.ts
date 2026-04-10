import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { SubmitLeaveRequestCommand } from '../commands/submit-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveStateMachine } from '../leave-state-machine';
import { Employee } from '../../hr/entities/employee.entity';
import { createLeaveRequestSubmittedEvent } from '../events/leave.events';

@CommandHandler(SubmitLeaveRequestCommand)
export class SubmitLeaveRequestHandler
  implements ICommandHandler<SubmitLeaveRequestCommand>
{
  private readonly logger = new Logger(SubmitLeaveRequestHandler.name);

  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    private readonly eventBus: EventBus,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: SubmitLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, leaveRequestId } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
        where: { id: leaveRequestId, tenantId, isDeleted: false },
      });

      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${leaveRequestId} not found`);
      }

      // Resolve the submitter's employee ID from auth userId
      const submitterEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });

      // Only the employee who created the request can submit it
      const isCreator = leaveRequest.createdBy === userId;
      const isOwner = submitterEmployee && leaveRequest.employeeId === submitterEmployee.id;
      if (!isCreator && !isOwner) {
        throw new ForbiddenException('You can only submit your own leave requests');
      }

      // HR-HIGH-008: Use centralized state machine for transition validation.
      LeaveStateMachine.transition(leaveRequest.status, LeaveRequestStatus.PENDING);

      // NOTE: pending balance is already incremented at DRAFT creation time
      // (CreateLeaveRequestHandler) to close the TOCTOU window on the balance check.
      // Do NOT increment again here — that would double-count the days.

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
      this.eventBus.publish(createLeaveRequestSubmittedEvent(savedRequest)).catch((err: unknown) => {
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
