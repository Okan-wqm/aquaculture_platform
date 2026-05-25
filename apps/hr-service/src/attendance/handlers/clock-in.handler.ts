import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { Repository, DataSource, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';

import { WorkArea } from '../../aquaculture/entities/work-area.entity';
import { Employee, EmployeeStatus, PersonnelCategory } from '../../hr/entities/employee.entity';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';
import { ClockInCommand } from '../commands/clock-in.command';
import {
  AttendanceRecord,
  AttendanceStatus,
  ApprovalStatus,
  convertLocalToUtc,
  getTimezoneOffset,
  isValidTimezone,
} from '../entities/attendance-record.entity';
import { Schedule, ScheduleStatus } from '../entities/schedule.entity';
import { EmployeeClockedInEvent } from '../events/attendance.events';


/** Default timezone if none specified */
const DEFAULT_TIMEZONE = 'UTC';

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
  const [hoursPart, minutesPart] = parts;
  if (hoursPart === undefined || minutesPart === undefined) {
    return [0, 0];
  }
  const hours = parseInt(hoursPart, 10);
  const minutes = parseInt(minutesPart, 10);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return [0, 0];
  }
  return [hours, minutes];
}

/**
 * Haversine formula to calculate distance between two GPS points in meters.
 */
function haversineDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

@CommandHandler(ClockInCommand)
export class ClockInHandler implements ICommandHandler<ClockInCommand> {
  private readonly logger = new Logger(ClockInHandler.name);

  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
    @InjectRepository(Schedule)
    private readonly scheduleRepository: Repository<Schedule>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly dataSource: DataSource,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
  ) {}

  async execute(command: ClockInCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, employeeId, method, location, remarks, workAreaId, timezone: commandTimezone } = command;

    // Current time in UTC for storage - compute before parallel reads so all reads
    // share the same reference point.
    const nowUtc = new Date();

    // Run all three read queries concurrently before opening the transaction.
    // READ COMMITTED isolation means ordering these reads serially provides no
    // additional correctness guarantee; parallelising removes ~2 round-trip latencies
    // from the hot clock-in path.
    const [employee, , schedule] = await Promise.all([
      this.employeeRepository.findOne({
        where: { id: employeeId, tenantId, isDeleted: false },
      }),
      // existingRecord placeholder – re-checked inside the transaction to close the TOCTOU window
      Promise.resolve(null),
      this.scheduleRepository.findOne({
        where: { tenantId, employeeId, status: ScheduleStatus.ACTIVE, isDeleted: false },
        relations: ['shift'],
      }),
    ]);

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    // Prevent terminated or suspended employees from clocking in
    if (
      employee.status === EmployeeStatus.TERMINATED ||
      employee.status === EmployeeStatus.SUSPENDED
    ) {
      throw new BadRequestException(
        `Employee with status '${employee.status}' cannot clock in`,
      );
    }

    // HIGH-1: Prevent clock-in while on approved leave
    const todayDate = new Date();
    todayDate.setHours(0, 0, 0, 0);
    const activeLeave = await this.leaveRequestRepository.findOne({
      where: {
        tenantId,
        employeeId,
        status: LeaveRequestStatus.APPROVED,
        startDate: LessThanOrEqual(todayDate),
        endDate: MoreThanOrEqual(todayDate),
        isDeleted: false,
      },
    });
    if (activeLeave) {
      throw new ConflictException(
        `Cannot clock in while on approved leave (${activeLeave.requestNumber}, ` +
        `${new Date(activeLeave.startDate).toISOString().slice(0, 10)} - ` +
        `${new Date(activeLeave.endDate).toISOString().slice(0, 10)})`,
      );
    }

    // HIGH-3: GPS geofence validation when workAreaId and location are provided
    if (workAreaId && location?.latitude != null && location?.longitude != null) {
      const workArea = await this.workAreaRepository.findOne({
        where: { id: workAreaId, tenantId, isDeleted: false, isActive: true },
      });
      if (workArea?.coordinates?.latitude != null && workArea?.coordinates?.longitude != null) {
        const geofenceRadius = workArea.geofenceRadiusMeters ?? 500; // default 500m
        const distance = haversineDistance(
          { lat: location.latitude, lng: location.longitude },
          { lat: workArea.coordinates.latitude, lng: workArea.coordinates.longitude },
        );
        if (distance > geofenceRadius) {
          throw new BadRequestException(
            `Clock-in location is outside work area geofence (${Math.round(distance)}m away, limit: ${geofenceRadius}m)`,
          );
        }
      }
    }

    // Determine timezone: use command timezone, employee timezone, or default to UTC
    const timezone = commandTimezone && isValidTimezone(commandTimezone)
      ? commandTimezone
      : (employee.timezone && isValidTimezone(employee.timezone) ? employee.timezone : DEFAULT_TIMEZONE);

    // Calculate today's date in the employee's local timezone for record lookup
    const tzOffset = getTimezoneOffset(timezone, nowUtc);
    const localNow = new Date(nowUtc.getTime() - tzOffset * 60000);
    const today = new Date(localNow);
    today.setHours(0, 0, 0, 0);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'hr_mobile_command_receipts',
        tenantId,
        envelope: command.mobileCommand,
        operationType: 'clockIn',
        responseType: 'AttendanceRecord',
      });
      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(AttendanceRecord, {
              where: { id: receipt.responseId, tenantId, isDeleted: false },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      // Re-check for existing clock-in inside the transaction to prevent double clock-in race
      const existingRecord = await queryRunner.manager.findOne(AttendanceRecord, {
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

      let lateMinutes = 0;
      let status: AttendanceStatus = AttendanceStatus.PRESENT;
      let isScheduled = true;

      // Calculate if late based on shift (using local time for comparison)
      if (schedule?.shift) {
        const shift = schedule.shift;
        // Safely parse shift start/end time with validation
        const [shiftHours, shiftMinutes] = safeParseTime(shift.startTime);
        const shiftStartLocal = new Date(today);
        shiftStartLocal.setHours(shiftHours, shiftMinutes, 0, 0);

        const [endHours, endMinutes] = safeParseTime(shift.endTime);
        const shiftEndLocal = new Date(today);
        shiftEndLocal.setHours(endHours, endMinutes, 0, 0);
        // Handle overnight shifts
        if (shift.crossesMidnight && shiftEndLocal <= shiftStartLocal) {
          shiftEndLocal.setDate(shiftEndLocal.getDate() + 1);
        }

        // Convert to UTC for comparison
        const shiftStartUtc = convertLocalToUtc(shiftStartLocal, timezone);
        const shiftEndUtc = convertLocalToUtc(shiftEndLocal, timezone);

        // Time window validation: earliest allowed = shiftStart - earlyClockInMinutes
        // latest allowed = shiftEnd + lateClockOutMinutes
        const earlyClockIn = shift.earlyClockInMinutes ?? 60;
        const lateClockOut = shift.lateClockOutMinutes ?? 300;
        const windowStart = new Date(shiftStartUtc.getTime() - earlyClockIn * 60000);
        const windowEnd = new Date(shiftEndUtc.getTime() + lateClockOut * 60000);

        if (nowUtc < windowStart || nowUtc > windowEnd) {
          const windowStartLocal = new Date(windowStart.getTime() - getTimezoneOffset(timezone, windowStart) * 60000);
          const windowEndLocal = new Date(windowEnd.getTime() - getTimezoneOffset(timezone, windowEnd) * 60000);
          throw new BadRequestException(
            `Clock-in is only allowed between ${windowStartLocal.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} and ${windowEndLocal.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
          );
        }

        const graceEndUtc = new Date(shiftStartUtc.getTime() + (shift.graceMinutes || 0) * 60000);

        if (nowUtc > graceEndUtc) {
          lateMinutes = Math.floor((nowUtc.getTime() - shiftStartUtc.getTime()) / 60000);
          status = AttendanceStatus.LATE;
        }
      } else {
        // No shift assigned - employee can still clock in but marked as unscheduled
        isScheduled = false;
      }

      // Determine if offshore
      const isOffshore = workAreaId ? true : employee.personnelCategory === PersonnelCategory.OFFSHORE;

      let savedRecord: AttendanceRecord;

      // Create or update attendance record
      // All times are stored in UTC with timezone field for local conversion
      if (existingRecord) {
        // Update existing record (created by schedule)
        existingRecord.clockIn = nowUtc; // Store in UTC
        existingRecord.timezone = timezone;
        existingRecord.clockInMethod = method;
        existingRecord.clockInLocation = location;
        existingRecord.status = status;
        existingRecord.lateMinutes = lateMinutes;
        existingRecord.isOffshore = isOffshore;
        existingRecord.workAreaId = workAreaId;
        existingRecord.remarks = remarks;
        existingRecord.updatedBy = userId;

        savedRecord = await queryRunner.manager.save(AttendanceRecord, existingRecord);
      } else {
        // Create new attendance record
        const effectiveRemarks = !isScheduled
          ? (remarks ? `[Unscheduled] ${remarks}` : '[Unscheduled]')
          : remarks;
        const attendanceRecord = queryRunner.manager.create(AttendanceRecord, {
          tenantId,
          employeeId,
          departmentId: employee.departmentHrId,
          shiftId: schedule?.shiftId,
          date: today,
          clockIn: nowUtc, // Store in UTC
          timezone, // Store timezone for local time conversion
          clockInMethod: method,
          clockInLocation: location,
          status,
          lateMinutes,
          approvalStatus: !isScheduled ? ApprovalStatus.PENDING_REVIEW : (lateMinutes > 0 ? ApprovalStatus.PENDING_REVIEW : ApprovalStatus.AUTO_APPROVED),
          isOffshore,
          workAreaId,
          remarks: effectiveRemarks,
          createdBy: userId,
          updatedBy: userId,
        });

        savedRecord = await queryRunner.manager.save(AttendanceRecord, attendanceRecord);
      }

      // CRITICAL-002 fix: Enqueue event into transactional outbox BEFORE commit.
      // Previously eventBus.publish() was called AFTER commit — fire-and-forget.
      const clockInEvent = EmployeeClockedInEvent(savedRecord);
      await this.outboxPublisher.enqueue(clockInEvent, queryRunner.manager);
      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'hr_mobile_command_receipts',
        receipt,
        responseType: 'AttendanceRecord',
        responseId: savedRecord.id,
        responsePayload: { id: savedRecord.id },
      });

      // Commit transaction (domain write + outbox row are atomic)
      await queryRunner.commitTransaction();

      return savedRecord;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
