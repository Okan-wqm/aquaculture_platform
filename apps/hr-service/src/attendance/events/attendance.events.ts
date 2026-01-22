import { AttendanceRecord } from '../entities/attendance-record.entity';

/**
 * Base class for attendance events
 */
export abstract class AttendanceEvent {
  constructor(public readonly attendanceRecord: AttendanceRecord) {}

  get recordId(): string {
    return this.attendanceRecord.id;
  }

  get employeeId(): string {
    return this.attendanceRecord.employeeId;
  }

  get tenantId(): string {
    return this.attendanceRecord.tenantId;
  }
}

/**
 * Event published when an employee clocks in
 */
export class EmployeeClockedInEvent extends AttendanceEvent {
  readonly eventType = 'attendance.clocked_in';

  get clockInTime(): Date | undefined {
    return this.attendanceRecord.clockIn;
  }

  get isLate(): boolean {
    return (this.attendanceRecord.lateMinutes ?? 0) > 0;
  }
}

/**
 * Event published when an employee clocks out
 */
export class EmployeeClockedOutEvent extends AttendanceEvent {
  readonly eventType = 'attendance.clocked_out';

  get clockOutTime(): Date | undefined {
    return this.attendanceRecord.clockOut;
  }

  get workedMinutes(): number {
    return this.attendanceRecord.workedMinutes ?? 0;
  }

  get overtimeMinutes(): number {
    return this.attendanceRecord.overtimeMinutes ?? 0;
  }
}
