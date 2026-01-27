import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { CreateLeaveRequestCommand } from '../commands/create-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveType } from '../entities/leave-type.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { Employee } from '../../hr/entities/employee.entity';

@CommandHandler(CreateLeaveRequestCommand)
export class CreateLeaveRequestHandler
  implements ICommandHandler<CreateLeaveRequestCommand>
{
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
  ) {}

  async execute(command: CreateLeaveRequestCommand): Promise<LeaveRequest> {
    const {
      tenantId,
      userId,
      employeeId,
      leaveTypeId,
      startDate,
      endDate,
      totalDays,
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

    // Check leave balance
    const currentYear = new Date().getFullYear();
    const leaveBalance = await this.leaveBalanceRepository.findOne({
      where: {
        tenantId,
        employeeId,
        leaveTypeId,
        year: currentYear,
        isDeleted: false,
      },
    });

    if (leaveType.isAccrued) {
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
      const daysDifference = Math.ceil(
        (start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysDifference < leaveType.minDaysNotice) {
        throw new BadRequestException(
          `Leave type ${leaveType.name} requires at least ${leaveType.minDaysNotice} days notice`,
        );
      }
    }

    // Use transaction with SERIALIZABLE isolation to prevent race condition
    // between overlap check and insert
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
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
        .andWhere(
          '(lr.startDate <= :endDate AND lr.endDate >= :startDate)',
          { startDate, endDate },
        )
        .setLock('pessimistic_read')
        .getOne();

      if (overlappingRequest) {
        throw new BadRequestException(
          `Leave request overlaps with existing request ${overlappingRequest.requestNumber}`,
        );
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

      await queryRunner.commitTransaction();

      this.logger.log(`Leave request ${savedRequest.id} created for employee ${employeeId}`);

      return savedRequest;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to create leave request: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
