import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClockOutCommand } from '../commands/clock-out.command';
import { AttendanceRecord, AttendanceStatus, ApprovalStatus } from '../entities/attendance-record.entity';
import { Shift } from '../entities/shift.entity';

@CommandHandler(ClockOutCommand)
export class ClockOutHandler implements ICommandHandler<ClockOutCommand> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: ClockOutCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, method, location, remarks } = command;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find today's attendance record with clock-in
    const attendanceRecord = await this.attendanceRepository.findOne({
      where: {
        tenantId,
        employeeId,
        date: today,
        isDeleted: false,
      },
      relations: ['shift'],
    });

    if (!attendanceRecord) {
      throw new NotFoundException('No attendance record found for today. Please clock in first.');
    }

    if (!attendanceRecord.clockIn) {
      throw new BadRequestException('Cannot clock out without clocking in first');
    }

    if (attendanceRecord.clockOut) {
      throw new BadRequestException('Employee has already clocked out today');
    }

    const now = new Date();
    const clockInTime = new Date(attendanceRecord.clockIn);

    // Calculate worked minutes
    const workedMinutes = Math.floor((now.getTime() - clockInTime.getTime()) / 60000);

    // Get shift details if available
    let earlyLeaveMinutes = 0;
    let overtimeMinutes = 0;
    let shift: Shift | null = null;

    if (attendanceRecord.shiftId) {
      shift = await this.shiftRepository.findOne({
        where: { id: attendanceRecord.shiftId },
      });
    }

    if (shift) {
      const [shiftEndHours, shiftEndMinutes] = shift.endTime.split(':').map(Number);
      const shiftEnd = new Date(today);
      shiftEnd.setHours(shiftEndHours, shiftEndMinutes, 0, 0);

      if (shift.crossesMidnight) {
        shiftEnd.setDate(shiftEnd.getDate() + 1);
      }

      // Calculate early leave
      if (now < shiftEnd) {
        earlyLeaveMinutes = Math.floor((shiftEnd.getTime() - now.getTime()) / 60000);
      }

      // Calculate overtime
      if (now > shiftEnd) {
        overtimeMinutes = Math.floor((now.getTime() - shiftEnd.getTime()) / 60000);
      }
    }

    // Update status based on calculations
    let status = attendanceRecord.status;
    if (earlyLeaveMinutes > 0) {
      status = status === AttendanceStatus.LATE ? AttendanceStatus.LATE : AttendanceStatus.EARLY_LEAVE;
    }

    // Calculate actual break time (if any recorded breaks)
    const breakMinutes = shift?.breakMinutes || 0;
    const netWorkedMinutes = workedMinutes - breakMinutes;

    // Update attendance record
    attendanceRecord.clockOut = now;
    attendanceRecord.clockOutMethod = method;
    attendanceRecord.clockOutLocation = location;
    attendanceRecord.workedMinutes = netWorkedMinutes > 0 ? netWorkedMinutes : 0;
    attendanceRecord.overtimeMinutes = overtimeMinutes;
    attendanceRecord.earlyLeaveMinutes = earlyLeaveMinutes;
    attendanceRecord.breakMinutes = breakMinutes;
    attendanceRecord.status = status;

    // If there were any irregularities, set for review
    if (earlyLeaveMinutes > 0 || attendanceRecord.lateMinutes > 0) {
      attendanceRecord.approvalStatus = ApprovalStatus.PENDING_REVIEW;
    }

    if (remarks) {
      attendanceRecord.remarks = attendanceRecord.remarks
        ? `${attendanceRecord.remarks}; ${remarks}`
        : remarks;
    }

    attendanceRecord.updatedBy = userId;

    const savedRecord = await this.attendanceRepository.save(attendanceRecord);

    // TODO: Publish EmployeeClockedOutEvent
    // this.eventBus.publish(new EmployeeClockedOutEvent(savedRecord));

    return savedRecord;
  }
}
