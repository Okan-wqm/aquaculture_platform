import { toEventIso, createBaseEvent } from '@platform/event-contracts';
import type {
  EmployeeCreatedEvent,
  EmployeeUpdatedEvent,
  EmployeeTerminatedEvent,
} from '@platform/event-contracts';
import { Employee } from '../entities/employee.entity';

/**
 * Factory: EmployeeCreatedEvent
 *
 * WHY: create-employee.handler.ts previously had no EventBus injection and never
 * published this event. Downstream services (notifications, messaging, billing)
 * that react to new employee creation were silently receiving nothing.
 *
 * Published AFTER transaction commit to guarantee the employee row exists in DB
 * before consumers attempt to load it.
 *
 * SECURITY: Raw PII (firstName, lastName, email) removed from event payload.
 * Consumers must query HR service directly using employeeId for display names.
 */
export function createEmployeeCreatedEvent(
  employee: Employee,
  createdBy?: string,
): EmployeeCreatedEvent {
  return {
    ...createBaseEvent<EmployeeCreatedEvent>('EmployeeCreated', employee.tenantId, {
      userId: createdBy,
    }),
    aggregateId: employee.id,
    aggregateType: 'Employee',
    eventType: 'EmployeeCreated' as const,
    employeeId: employee.id,
    position: employee.position,
    hireDate: toEventIso(employee.hireDate),
  };
}

/**
 * Factory: EmployeeUpdatedEvent
 *
 * WHY: update-employee.handler.ts previously had no EventBus injection and never
 * published this event. Cross-service caches and derived data (sensor assignments,
 * messaging profiles) were never invalidated on employee profile changes.
 *
 * SECURITY: Raw PII (firstName, lastName, email) removed from event payload.
 * Consumers must query HR service directly using employeeId for display names.
 */
export function createEmployeeUpdatedEvent(
  employee: Employee,
  updatedBy?: string,
): EmployeeUpdatedEvent {
  return {
    ...createBaseEvent<EmployeeUpdatedEvent>('EmployeeUpdated', employee.tenantId, {
      userId: updatedBy,
    }),
    aggregateId: employee.id,
    aggregateType: 'Employee',
    eventType: 'EmployeeUpdated' as const,
    employeeId: employee.id,
    position: employee.position,
  };
}

/**
 * Factory: EmployeeTerminatedEvent
 *
 * WHY: terminate-employee.handler.ts previously had no EventBus injection.
 * When an employee is terminated, access revocation, notification cleanup,
 * and sensor deassignment all depend on this event being published.
 */
export function createEmployeeTerminatedEvent(
  employee: Employee,
  terminationDate: Date,
  reason: string | undefined,
  terminatedBy?: string,
): EmployeeTerminatedEvent {
  return {
    ...createBaseEvent<EmployeeTerminatedEvent>('EmployeeTerminated', employee.tenantId, {
      userId: terminatedBy,
    }),
    aggregateId: employee.id,
    aggregateType: 'Employee',
    eventType: 'EmployeeTerminated' as const,
    employeeId: employee.id,
    terminationDate: toEventIso(terminationDate),
    reason,
  };
}
