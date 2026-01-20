import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateLeaveRequestCommand } from '../commands/create-leave-request.command';
import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { LeaveType } from '../entities/leave-type.entity';
import { LeaveBalance } from '../entities/leave-balance.entity';
import { Employee } from '../../hr/entities/employee.entity';

@CommandHandler(CreateLeaveRequestCommand)
export class CreateLeaveRequestHandler
  implements ICommandHandler<CreateLeaveRequestCommand>
{
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

    if (leaveType.requiresBalance) {
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

    // Check for overlapping leave requests
    const overlappingRequest = await this.leaveRequestRepository
      .createQueryBuilder('lr')
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
      .getOne();

    if (overlappingRequest) {
      throw new BadRequestException(
        `Leave request overlaps with existing request ${overlappingRequest.requestNumber}`,
      );
    }

    // Validate date range
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (start > end) {
      throw new BadRequestException('Start date must be before or equal to end date');
    }

    // Validate minimum notice days
    if (leaveType.minNoticeDays && leaveType.minNoticeDays > 0) {
      const today = new Date();
      const daysDifference = Math.ceil(
        (start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysDifference < leaveType.minNoticeDays) {
        throw new BadRequestException(
          `Leave type ${leaveType.name} requires at least ${leaveType.minNoticeDays} days notice`,
        );
      }
    }

    // Create the leave request
    const leaveRequest = this.leaveRequestRepository.create({
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

    const savedRequest = await this.leaveRequestRepository.save(leaveRequest);

    return savedRequest;
  }
}
