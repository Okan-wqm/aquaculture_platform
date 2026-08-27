import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler, EventBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { CreateLeaveRequestCommand } from '../commands/create-leave-request.command';
import { CalculateLeaveDaysQuery } from '../queries/calculate-leave-days.query';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveType } from '../entities/leave-type.entity';

@CommandHandler(CreateLeaveRequestCommand)
export class CreateLeaveRequestHandler implements ICommandHandler<CreateLeaveRequestCommand> {
  private readonly logger = new Logger(CreateLeaveRequestHandler.name);

  constructor(
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(LeaveType)
    private readonly leaveTypeRepository: Repository<LeaveType>,
    @InjectRepository(LeaveBalance)
    private readonly leaveBalanceRepository: Repository<LeaveBalance>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBus,
    private readonly queryBus: QueryBus,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
  ) {}

  async execute(command: CreateLeaveRequestCommand): Promise<LeaveRequest> {
    const {
      tenantId,
      userId,
      employeeId,
      leaveTypeId,
      startDate,
      endDate,
      isHalfDayStart,
      isHalfDayEnd,
      halfDayPeriod,
      reason,
      contactDuringLeave,
    } = command;

    // Validate employee exists
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    // Validate leave type exists and is active
    const leaveType = await this.leaveTypeRepository.findOne({
      where: { id: leaveTypeId, tenantId, isActive: true, isDeleted: false },
    });

    if (!leaveType) {
      throw new NotFoundException(`Leave type with ID ${leaveTypeId} not found or inactive`);
    }

    // Validate date range (can be done outside transaction)
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) {
      throw new BadRequestException('Start date must be before or equal to end date');
    }

    // Validate minimum notice days (can be done outside transaction)
    if (leaveType.minDaysNotice && leaveType.minDaysNotice > 0) {
      const today = new Date();
      const daysDifference = Math.ceil((start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDifference < leaveType.minDaysNotice) {
        throw new BadRequestException(
          `Leave type ${leaveType.name} requires at least ${leaveType.minDaysNotice} days notice`,
        );
      }
    }

    // Use transaction with READ COMMITTED + pessimistic locks to prevent race conditions
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'hr_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'createLeaveRequest',
        responseType: 'LeaveRequest',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(LeaveRequest, {
              where: { id: receipt.responseId, tenantId, isDeleted: false },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      // SEC-MEDIUM-076 (2026-08-23 scan №21): totalDays is SERVER-authoritative.
      // The client-supplied value is ignored on every write path — a
      // Jan-1-to-Jan-30 request with totalDays=0.5 used to deduct half a day.
      // The same calendar SSoT the calculateLeaveDays query exposes
      // (weekends + tenant holidays + half-day flags) decides the figure.
      const calculated = await this.queryBus.execute(
        new CalculateLeaveDaysQuery(
          tenantId,
          leaveTypeId,
          command.startDate,
          command.endDate,
          isHalfDayStart || false,
          isHalfDayEnd || false,
        ),
      );
      const totalDays = calculated.totalDays;

      // Check for overlapping leave requests (within transaction)
      const overlappingRequest = await queryRunner.manager
        .createQueryBuilder(LeaveRequest, 'lr')
        .where('lr.tenantId = :tenantId', { tenantId })
        .andWhere('lr.employeeId = :employeeId', { employeeId })
        .andWhere('lr.status NOT IN (:...excludedStatuses)', {
          excludedStatuses: [
            LeaveRequestStatus.CANCELLED,
            LeaveRequestStatus.REJECTED,
            LeaveRequestStatus.WITHDRAWN,
          ],
        })
        .andWhere('lr.isDeleted = false')
        .andWhere('(lr.startDate <= :endDate AND lr.endDate >= :startDate)', { startDate, endDate })
        .setLock('pessimistic_read')
        .getOne();

      if (overlappingRequest) {
        throw new BadRequestException(
          `Leave request overlaps with existing request ${overlappingRequest.requestNumber}`,
        );
      }

      // Check leave balance INSIDE the transaction to prevent TOCTOU race
      // Use the leave request's start year, not the current year
      // MEDIUM: Use SELECT FOR UPDATE to prevent concurrent double-spend on same balance row
      const leaveYear = start.getFullYear();
      if (leaveType.isAccrued) {
        const leaveBalance = await queryRunner.manager.findOne(LeaveBalance, {
          where: {
            tenantId,
            employeeId,
            leaveTypeId,
            year: leaveYear,
            isDeleted: false,
          },
          lock: { mode: 'pessimistic_write' },
        });

        if (!leaveBalance) {
          throw new BadRequestException(
            `No leave balance found for employee ${employeeId} and leave type ${leaveType.name}`,
          );
        }

        const availableBalance = leaveBalance.availableBalance;
        if (availableBalance < totalDays) {
          throw new BadRequestException(
            `Insufficient leave balance. Available: ${availableBalance}, Requested: ${totalDays}`,
          );
        }

        // Increment pending at draft-creation time to close the TOCTOU window
        leaveBalance.pending = Number(leaveBalance.pending) + Number(totalDays);
        leaveBalance.updatedBy = userId;
        await queryRunner.manager.save(LeaveBalance, leaveBalance);
      }

      // Create the leave request (within transaction)
      const leaveRequest = queryRunner.manager.create(LeaveRequest, {
        tenantId,
        employeeId,
        leaveTypeId,
        startDate: start,
        endDate: end,
        totalDays,
        isHalfDayStart: isHalfDayStart || false,
        isHalfDayEnd: isHalfDayEnd || false,
        halfDayPeriod,
        reason,
        contactDuringLeave,
        status: LeaveRequestStatus.DRAFT,
        currentApprovalLevel: 1,
        approvalHistory: [],
        createdBy: userId,
        updatedBy: userId,
      });

      const savedRequest = await queryRunner.manager.save(leaveRequest);
      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'hr_mobile_command_receipts',
        receipt,
        responseType: 'LeaveRequest',
        responseId: savedRequest.id,
        responsePayload: { id: savedRequest.id },
      });

      await queryRunner.commitTransaction();

      this.logger.log(`Leave request ${savedRequest.id} created for employee ${employeeId}`);

      return savedRequest;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create leave request: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
