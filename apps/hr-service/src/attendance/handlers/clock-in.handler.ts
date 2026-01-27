import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClockInCommand } from '../commands/clock-in.command';
import { AttendanceRecord, AttendanceStatus, ApprovalStatus, ClockMethod } from '../entities/attendance-record.entity';
import { Schedule, ScheduleStatus } from '../entities/schedule.entity';
import { Shift } from '../entities/shift.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { EmployeeClockedInEvent } from '../events/attendance.events';

/**
 * Safely parse time string in HH:mm format with validation
 * Returns [hours, minutes] or [0, 0] for invalid format (with logging)
 */
function safeParseTime(time: string | undefined): [number, number] {
  if (!time || typeof time !== 'string') {
    return [0, 0];
  }
  const parts = time.split(':');
  if (parts.length !== 2) {
    return [0, 0];
  }
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return [0, 0];
  }
  return [hours, minutes];
}

@CommandHandler(ClockInCommand)
export class ClockInHandler implements ICommandHandler<ClockInCommand> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ClockInCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, method, location, remarks, workAreaId } = command;

    // Validate employee
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check for existing clock-in today
    const existingRecord = await this.attendanceRepository.findOne({
      where: {
        tenantId,
        employeeId,
        date: today,
        isDeleted: false,
      },
    });

    if (existingRecord && existingRecord.clockIn) {
      throw new BadRequestException('Employee has already clocked in today');
    }

    // Get employee's schedule for today
    const schedule = await this.scheduleRepository.findOne({
      where: {
        tenantId,
        employeeId,
        status: ScheduleStatus.ACTIVE,
        isDeleted: false,
      },
      relations: ['shift'],
    });

    const now = new Date();
    let lateMinutes = 0;
    let status: AttendanceStatus = AttendanceStatus.PRESENT;

    // Calculate if late based on shift
    if (schedule?.shift) {
      // Safely parse shift start time with validation
      const [shiftHours, shiftMinutes] = safeParseTime(schedule.shift.startTime);
      const shiftStart = new Date(today);
      shiftStart.setHours(shiftHours, shiftMinutes, 0, 0);

      const graceEnd = new Date(shiftStart.getTime() + (schedule.shift.graceMinutes || 0) * 60000);

      if (now > graceEnd) {
        lateMinutes = Math.floor((now.getTime() - shiftStart.getTime()) / 60000);
        status = AttendanceStatus.LATE;
      }
    }

    // Determine if offshore
    const isOffshore = workAreaId ? true : employee.personnelCategory === 'offshore';

    // Create or update attendance record
    if (existingRecord) {
      // Update existing record (created by schedule)
      existingRecord.clockIn = now;
      existingRecord.clockInMethod = method;
      existingRecord.clockInLocation = location;
      existingRecord.status = status;
      existingRecord.lateMinutes = lateMinutes;
      existingRecord.isOffshore = isOffshore;
      existingRecord.workAreaId = workAreaId;
      existingRecord.remarks = remarks;
      existingRecord.updatedBy = userId;

      return this.attendanceRepository.save(existingRecord);
    }

    // Create new attendance record
    const attendanceRecord = this.attendanceRepository.create({
      tenantId,
      employeeId,
      departmentId: employee.departmentHrId,
      shiftId: schedule?.shiftId,
      date: today,
      clockIn: now,
      clockInMethod: method,
      clockInLocation: location,
      status,
      lateMinutes,
      approvalStatus: lateMinutes > 0 ? ApprovalStatus.PENDING_REVIEW : ApprovalStatus.AUTO_APPROVED,
      isOffshore,
      workAreaId,
      remarks,
      createdBy: userId,
      updatedBy: userId,
    });

    const savedRecord = await this.attendanceRepository.save(attendanceRecord);

    // Publish event for notification/audit purposes
    this.eventBus.publish(new EmployeeClockedInEvent(savedRecord));

    return savedRecord;
  }
}
