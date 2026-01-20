import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreateManualAttendanceCommand } from '../commands/create-manual-attendance.command';
import { AttendanceRecord, AttendanceStatus, ApprovalStatus, ClockMethod } from '../entities/attendance-record.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift } from '../entities/shift.entity';

@CommandHandler(CreateManualAttendanceCommand)
export class CreateManualAttendanceHandler implements ICommandHandler<CreateManualAttendanceCommand> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
  ) {}

  async execute(command: CreateManualAttendanceCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, date, clockIn, clockOut, reason, shiftId } = command;

    // Validate employee
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const recordDate = new Date(date);
    recordDate.setHours(0, 0, 0, 0);

    // Check for existing record on this date
    const existingRecord = await this.attendanceRepository.findOne({
      where: {
        tenantId,
        employeeId,
        date: recordDate,
        isDeleted: false,
      },
    });

    if (existingRecord) {
      throw new BadRequestException(`Attendance record already exists for ${date}`);
    }

    // Validate shift if provided
    let shift: Shift | null = null;
    if (shiftId) {
      shift = await this.shiftRepository.findOne({
        where: { id: shiftId, tenantId, isDeleted: false },
      });
      if (!shift) {
        throw new NotFoundException(`Shift with ID ${shiftId} not found`);
      }
    }

    // Parse clock times
    const clockInTime = clockIn ? new Date(clockIn) : undefined;
    const clockOutTime = clockOut ? new Date(clockOut) : undefined;

    // Calculate worked minutes
    let workedMinutes = 0;
    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let status: AttendanceStatus = AttendanceStatus.PRESENT;

    if (clockInTime && clockOutTime) {
      workedMinutes = Math.floor((clockOutTime.getTime() - clockInTime.getTime()) / 60000);

      if (shift) {
        // Calculate late arrival
        const [shiftStartHours, shiftStartMins] = shift.startTime.split(':').map(Number);
        const shiftStart = new Date(recordDate);
        shiftStart.setHours(shiftStartHours, shiftStartMins, 0, 0);

        if (clockInTime > shiftStart) {
          lateMinutes = Math.floor((clockInTime.getTime() - shiftStart.getTime()) / 60000);
          if (lateMinutes > (shift.graceMinutes || 0)) {
            status = AttendanceStatus.LATE;
          }
        }

        // Calculate early leave
        const [shiftEndHours, shiftEndMins] = shift.endTime.split(':').map(Number);
        const shiftEnd = new Date(recordDate);
        shiftEnd.setHours(shiftEndHours, shiftEndMins, 0, 0);

        if (shift.crossesMidnight) {
          shiftEnd.setDate(shiftEnd.getDate() + 1);
        }

        if (clockOutTime < shiftEnd) {
          earlyLeaveMinutes = Math.floor((shiftEnd.getTime() - clockOutTime.getTime()) / 60000);
          if (earlyLeaveMinutes > 0) {
            status = status === AttendanceStatus.LATE ? AttendanceStatus.LATE : AttendanceStatus.EARLY_LEAVE;
          }
        }
      }
    } else if (!clockInTime && !clockOutTime) {
      status = AttendanceStatus.ABSENT;
    }

    // Create manual attendance record
    const attendanceRecord = this.attendanceRepository.create({
      tenantId,
      employeeId,
      departmentId: employee.departmentId,
      shiftId: shift?.id,
      date: recordDate,
      clockIn: clockInTime,
      clockOut: clockOutTime,
      clockInMethod: clockInTime ? ClockMethod.MANUAL : undefined,
      clockOutMethod: clockOutTime ? ClockMethod.MANUAL : undefined,
      status,
      workedMinutes: Math.max(0, workedMinutes - (shift?.breakMinutes || 0)),
      lateMinutes,
      earlyLeaveMinutes,
      breakMinutes: shift?.breakMinutes || 0,
      approvalStatus: ApprovalStatus.PENDING_REVIEW,
      reason,
      isManualEntry: true,
      createdBy: userId,
      updatedBy: userId,
    });

    return this.attendanceRepository.save(attendanceRecord);
  }
}
