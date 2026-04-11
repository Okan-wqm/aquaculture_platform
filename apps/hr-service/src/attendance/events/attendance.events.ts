import { createBaseEvent } from '@platform/event-contracts';
import type { BaseEvent } from '@platform/event-contracts';
import { AttendanceRecord } from '../entities/attendance-record.entity';

/**
 * Attendance events conforming to BaseEvent for transactional outbox compatibility.
 *
 * CRITICAL-002 fix: Previously these were class-based events that did NOT conform
 * to the BaseEvent interface (missing eventId, timestamp, version). The outbox
 * publisher requires BaseEvent-compliant flat objects with createBaseEvent() fields.
 *
 * These interfaces and factory functions replace the old class-based events,
 * making the attendance domain compatible with the transactional outbox pattern.
 */

// ── Event interfaces ──────────────────────────────────────────────────

export interface EmployeeClockedInEventPayload extends BaseEvent {
  eventType: 'EmployeeClockedIn';
  aggregateId: string;
  aggregateType: 'AttendanceRecord';
  recordId: string;
  employeeId: string;
  clockInTime: string | undefined;
  isLate: boolean;
  lateMinutes: number;
}

export interface EmployeeClockedOutEventPayload extends BaseEvent {
  eventType: 'EmployeeClockedOut';
  aggregateId: string;
  aggregateType: 'AttendanceRecord';
  recordId: string;
  employeeId: string;
  clockOutTime: string | undefined;
  workedMinutes: number;
  overtimeMinutes: number;
}

// ── Factory functions (BaseEvent-compliant, outbox-safe) ──────────────

/**
 * Create a flat EmployeeClockedIn event from an AttendanceRecord.
 *
 * @param record - The saved attendance record (must have id and tenantId)
 */
export function EmployeeClockedInEvent(
  record: AttendanceRecord,
): EmployeeClockedInEventPayload {
  return {
    ...createBaseEvent<EmployeeClockedInEventPayload>(
      'EmployeeClockedIn',
      record.tenantId,
    ),
    eventType: 'EmployeeClockedIn' as const,
    aggregateId: record.id,
    aggregateType: 'AttendanceRecord' as const,
    recordId: record.id,
    employeeId: record.employeeId,
    clockInTime: record.clockIn?.toISOString(),
    isLate: (record.lateMinutes ?? 0) > 0,
    lateMinutes: record.lateMinutes ?? 0,
  };
}

/**
 * Create a flat EmployeeClockedOut event from an AttendanceRecord.
 *
 * @param record - The saved attendance record (must have id and tenantId)
 */
export function EmployeeClockedOutEvent(
  record: AttendanceRecord,
): EmployeeClockedOutEventPayload {
  return {
    ...createBaseEvent<EmployeeClockedOutEventPayload>(
      'EmployeeClockedOut',
      record.tenantId,
    ),
    eventType: 'EmployeeClockedOut' as const,
    aggregateId: record.id,
    aggregateType: 'AttendanceRecord' as const,
    recordId: record.id,
    employeeId: record.employeeId,
    clockOutTime: record.clockOut?.toISOString(),
    workedMinutes: record.workedMinutes ?? 0,
    overtimeMinutes: record.overtimeMinutes ?? 0,
  };
}
