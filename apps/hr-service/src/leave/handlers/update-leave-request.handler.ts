import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler, QueryBus } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { UpdateLeaveRequestCommand } from '../commands/update-leave-request.command';
import { CalculateLeaveDaysQuery } from '../queries/calculate-leave-days.query';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveType } from '../entities/leave-type.entity';

/**
 * Edit a not-yet-decided leave request.
 *
 * Editable ONLY in DRAFT or PENDING — the two states that still hold a pending
 * balance reservation. APPROVED/REJECTED/CANCELLED/WITHDRAWN are decided/terminal
 * and may not be mutated (mirrors the state-machine's "no edit after decision"
 * intent; an approved request must be cancelled and re-created).
 *
 * When startDate/endDate/totalDays change, the pending balance reservation made
 * at create time is re-balanced inside the same transaction so the held days
 * always match the request — using the SAME pending arithmetic as
 * CreateLeaveRequestHandler / CancelLeaveRequestHandler.
 */
@CommandHandler(UpdateLeaveRequestCommand)
export class UpdateLeaveRequestHandler implements ICommandHandler<UpdateLeaveRequestCommand> {
  private readonly logger = new Logger(UpdateLeaveRequestHandler.name);

  private static readonly EDITABLE_STATUSES: ReadonlySet<LeaveRequestStatus> = new Set([
    LeaveRequestStatus.DRAFT,
    LeaveRequestStatus.PENDING,
  ]);

  constructor(
    private readonly dataSource: DataSource,
    private readonly queryBus: QueryBus,
  ) {}

  async execute(command: UpdateLeaveRequestCommand): Promise<LeaveRequest> {
    const { tenantId, userId, input } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const leaveRequest = await queryRunner.manager.findOne(LeaveRequest, {
        where: { id: input.id, tenantId, isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!leaveRequest) {
        throw new NotFoundException(`Leave request with ID ${input.id} not found`);
      }

      // Ownership: only the creator or the owning employee may edit (mirrors
      // submit/cancel ownership in the existing handlers).
      const editorEmployee = await queryRunner.manager.findOne(Employee, {
        where: { userId, tenantId, isDeleted: false },
      });
      const isCreator = leaveRequest.createdBy === userId;
      const isOwner = !!editorEmployee && leaveRequest.employeeId === editorEmployee.id;
      if (!isCreator && !isOwner) {
        throw new ForbiddenException('You can only edit your own leave requests');
      }

      if (!UpdateLeaveRequestHandler.EDITABLE_STATUSES.has(leaveRequest.status)) {
        throw new BadRequestException(
          `Leave request in status "${leaveRequest.status}" cannot be edited. ` +
            `Only draft or pending requests are editable.`,
        );
      }

      // Compute the candidate date range / totalDays from the patch.
      const newStart = input.startDate
        ? new Date(input.startDate)
        : new Date(leaveRequest.startDate);
      const newEnd = input.endDate ? new Date(input.endDate) : new Date(leaveRequest.endDate);
      if (newStart > newEnd) {
        throw new BadRequestException('Start date must be before or equal to end date');
      }
      const oldTotalDays = Number(leaveRequest.totalDays);
      // SEC-MEDIUM-076 (2026-08-23 scan №21): the figure is recomputed from
      // the calendar SSoT — input.totalDays is never trusted on any write path.
      const effectiveHalfStart =
        input.isHalfDayStart != null ? input.isHalfDayStart : leaveRequest.isHalfDayStart;
      const effectiveHalfEnd =
        input.isHalfDayEnd != null ? input.isHalfDayEnd : leaveRequest.isHalfDayEnd;
      const recalculated = await this.queryBus.execute(
        new CalculateLeaveDaysQuery(
          tenantId,
          leaveRequest.leaveTypeId,
          newStart.toISOString().slice(0, 10),
          newEnd.toISOString().slice(0, 10),
          effectiveHalfStart || false,
          effectiveHalfEnd || false,
        ),
      );
      const newTotalDays = recalculated.totalDays;

      // If the year changes we'd have to move the reservation across balance
      // rows; that is a re-create concern, not an edit. Reject it explicitly.
      const oldYear = new Date(leaveRequest.startDate).getFullYear();
      const newYear = newStart.getFullYear();
      if (oldYear !== newYear) {
        throw new BadRequestException(
          'Changing the leave year is not supported via edit; cancel and create a new request',
        );
      }

      // Re-balance the pending reservation only when the held day count changes.
      const dayDelta = newTotalDays - oldTotalDays;
      if (dayDelta !== 0) {
        const leaveType = await queryRunner.manager.findOne(LeaveType, {
          where: { id: leaveRequest.leaveTypeId, tenantId, isDeleted: false },
        });
        if (leaveType?.isAccrued) {
          const balance = await queryRunner.manager.findOne(LeaveBalance, {
            where: {
              tenantId,
              employeeId: leaveRequest.employeeId,
              leaveTypeId: leaveRequest.leaveTypeId,
              year: newYear,
              isDeleted: false,
            },
            lock: { mode: 'pessimistic_write' },
          });
          if (!balance) {
            throw new BadRequestException(
              `No leave balance found for employee ${leaveRequest.employeeId} and leave type ${leaveType.name}`,
            );
          }
          if (dayDelta > 0 && balance.availableBalance < dayDelta) {
            throw new BadRequestException(
              `Insufficient leave balance for the additional ${dayDelta} day(s). Available: ${balance.availableBalance}`,
            );
          }
          balance.pending = Math.max(0, Number(balance.pending) + dayDelta);
          balance.updatedBy = userId;
          await queryRunner.manager.save(LeaveBalance, balance);
        }
      }

      // Apply the patch.
      leaveRequest.startDate = newStart;
      leaveRequest.endDate = newEnd;
      leaveRequest.totalDays = newTotalDays;
      if (input.isHalfDayStart !== undefined) {
        leaveRequest.isHalfDayStart = input.isHalfDayStart;
      }
      if (input.isHalfDayEnd !== undefined) {
        leaveRequest.isHalfDayEnd = input.isHalfDayEnd;
      }
      if (input.halfDayPeriod !== undefined) {
        leaveRequest.halfDayPeriod = input.halfDayPeriod;
      }
      if (input.reason !== undefined) {
        leaveRequest.reason = input.reason;
      }
      if (input.contactDuringLeave !== undefined) {
        leaveRequest.contactDuringLeave = input.contactDuringLeave;
      }
      leaveRequest.approvalHistory = [
        ...(leaveRequest.approvalHistory || []),
        {
          action: 'edited',
          actorId: userId,
          timestamp: new Date(),
          notes: 'Leave request edited',
        },
      ];
      leaveRequest.updatedBy = userId;

      const saved = await queryRunner.manager.save(LeaveRequest, leaveRequest);
      await queryRunner.commitTransaction();

      this.logger.log(`Leave request ${saved.id} edited by ${userId} (tenant ${tenantId})`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
