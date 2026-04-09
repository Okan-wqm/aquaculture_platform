/**
 * HR Module Error Message Keys
 *
 * HR-HIGH-018: Centralized error message keys for i18n support.
 * All user-facing error messages reference these keys instead of
 * hardcoded English strings. Each key maps to a default English
 * string that can be overridden by locale-specific resource files.
 *
 * Convention: DOMAIN.CONTEXT.ERROR_TYPE
 * Example: HR.EMPLOYEE.NOT_FOUND → "Employee not found"
 *
 * Usage:
 * ```typescript
 * import { HR_ERRORS, getErrorMessage } from '../i18n/error-keys';
 * throw new Error(getErrorMessage(HR_ERRORS.EMPLOYEE.NOT_FOUND));
 * ```
 */

export const HR_ERRORS = {
  EMPLOYEE: {
    NOT_FOUND: 'hr.employee.not_found',
    ALREADY_EXISTS: 'hr.employee.already_exists',
    INVALID_STATUS: 'hr.employee.invalid_status',
    CANNOT_TERMINATE: 'hr.employee.cannot_terminate',
    MISSING_REQUIRED_FIELDS: 'hr.employee.missing_required_fields',
  },
  LEAVE: {
    NOT_FOUND: 'hr.leave.not_found',
    INSUFFICIENT_BALANCE: 'hr.leave.insufficient_balance',
    INVALID_DATE_RANGE: 'hr.leave.invalid_date_range',
    CANNOT_APPROVE_OWN: 'hr.leave.cannot_approve_own',
    CANNOT_REJECT_OWN: 'hr.leave.cannot_reject_own',
    ALREADY_STARTED: 'hr.leave.already_started',
    INVALID_TRANSITION: 'hr.leave.invalid_transition',
    OVERLAP_EXISTS: 'hr.leave.overlap_exists',
  },
  PAYROLL: {
    NOT_FOUND: 'hr.payroll.not_found',
    OVERLAPPING_PERIOD: 'hr.payroll.overlapping_period',
    DEDUCTIONS_EXCEED_GROSS: 'hr.payroll.deductions_exceed_gross',
    NEGATIVE_NET_PAY: 'hr.payroll.negative_net_pay',
    INVALID_DATE_RANGE: 'hr.payroll.invalid_date_range',
    ALREADY_APPROVED: 'hr.payroll.already_approved',
  },
  CERTIFICATION: {
    NOT_FOUND: 'hr.certification.not_found',
    ALREADY_ACTIVE: 'hr.certification.already_active',
    ALREADY_REVOKED: 'hr.certification.already_revoked',
    ALREADY_VERIFIED: 'hr.certification.already_verified',
    TYPE_NOT_FOUND: 'hr.certification.type_not_found',
  },
  SCHEDULING: {
    PLAN_NOT_EDITABLE: 'hr.scheduling.plan_not_editable',
    SHIFT_NOT_FOUND: 'hr.scheduling.shift_not_found',
    ENTRY_NOT_FOUND: 'hr.scheduling.entry_not_found',
    OVERTIME_LIMIT_EXCEEDED: 'hr.scheduling.overtime_limit_exceeded',
  },
  ATTENDANCE: {
    ALREADY_CLOCKED_IN: 'hr.attendance.already_clocked_in',
    NOT_CLOCKED_IN: 'hr.attendance.not_clocked_in',
    FUTURE_DATE: 'hr.attendance.future_date',
  },
  GENERAL: {
    UNAUTHORIZED: 'hr.general.unauthorized',
    FORBIDDEN: 'hr.general.forbidden',
    INTERNAL_ERROR: 'hr.general.internal_error',
    VALIDATION_FAILED: 'hr.general.validation_failed',
  },
} as const;

/**
 * Default English messages for all error keys.
 * In a full i18n migration, these would be loaded from a locale file.
 */
const DEFAULT_MESSAGES: Record<string, string> = {
  // Employee
  [HR_ERRORS.EMPLOYEE.NOT_FOUND]: 'Employee not found',
  [HR_ERRORS.EMPLOYEE.ALREADY_EXISTS]: 'An employee with this information already exists',
  [HR_ERRORS.EMPLOYEE.INVALID_STATUS]: 'Invalid employee status',
  [HR_ERRORS.EMPLOYEE.CANNOT_TERMINATE]: 'Employee cannot be terminated in the current state',
  [HR_ERRORS.EMPLOYEE.MISSING_REQUIRED_FIELDS]: 'Required fields are missing',

  // Leave
  [HR_ERRORS.LEAVE.NOT_FOUND]: 'Leave request not found',
  [HR_ERRORS.LEAVE.INSUFFICIENT_BALANCE]: 'Insufficient leave balance',
  [HR_ERRORS.LEAVE.INVALID_DATE_RANGE]: 'Invalid date range for leave request',
  [HR_ERRORS.LEAVE.CANNOT_APPROVE_OWN]: 'You cannot approve your own leave request',
  [HR_ERRORS.LEAVE.CANNOT_REJECT_OWN]: 'You cannot reject your own leave request',
  [HR_ERRORS.LEAVE.ALREADY_STARTED]: 'Cannot modify leave request that has already started',
  [HR_ERRORS.LEAVE.INVALID_TRANSITION]: 'Invalid leave request status transition',
  [HR_ERRORS.LEAVE.OVERLAP_EXISTS]: 'Leave request overlaps with an existing request',

  // Payroll
  [HR_ERRORS.PAYROLL.NOT_FOUND]: 'Payroll record not found',
  [HR_ERRORS.PAYROLL.OVERLAPPING_PERIOD]: 'Overlapping payroll period exists',
  [HR_ERRORS.PAYROLL.DEDUCTIONS_EXCEED_GROSS]: 'Total deductions cannot exceed gross pay',
  [HR_ERRORS.PAYROLL.NEGATIVE_NET_PAY]: 'Net pay cannot be negative',
  [HR_ERRORS.PAYROLL.INVALID_DATE_RANGE]: 'Pay period start date must be before end date',
  [HR_ERRORS.PAYROLL.ALREADY_APPROVED]: 'Payroll has already been approved',

  // Certification
  [HR_ERRORS.CERTIFICATION.NOT_FOUND]: 'Certification not found',
  [HR_ERRORS.CERTIFICATION.ALREADY_ACTIVE]: 'Employee already has an active certification of this type',
  [HR_ERRORS.CERTIFICATION.ALREADY_REVOKED]: 'Certification is already revoked',
  [HR_ERRORS.CERTIFICATION.ALREADY_VERIFIED]: 'Certification is already verified',
  [HR_ERRORS.CERTIFICATION.TYPE_NOT_FOUND]: 'Certification type not found',

  // Scheduling
  [HR_ERRORS.SCHEDULING.PLAN_NOT_EDITABLE]: 'Plan cannot be modified in its current status',
  [HR_ERRORS.SCHEDULING.SHIFT_NOT_FOUND]: 'Shift not found',
  [HR_ERRORS.SCHEDULING.ENTRY_NOT_FOUND]: 'Plan entry not found',
  [HR_ERRORS.SCHEDULING.OVERTIME_LIMIT_EXCEEDED]: 'Overtime limit would be exceeded',

  // Attendance
  [HR_ERRORS.ATTENDANCE.ALREADY_CLOCKED_IN]: 'Already clocked in',
  [HR_ERRORS.ATTENDANCE.NOT_CLOCKED_IN]: 'Not currently clocked in',
  [HR_ERRORS.ATTENDANCE.FUTURE_DATE]: 'Cannot record attendance for a future date',

  // General
  [HR_ERRORS.GENERAL.UNAUTHORIZED]: 'Authentication required',
  [HR_ERRORS.GENERAL.FORBIDDEN]: 'Insufficient permissions',
  [HR_ERRORS.GENERAL.INTERNAL_ERROR]: 'An internal error occurred',
  [HR_ERRORS.GENERAL.VALIDATION_FAILED]: 'Validation failed',
};

/**
 * Get the default English message for an error key.
 *
 * @param key - Error key from HR_ERRORS
 * @param fallback - Optional fallback message if key not found
 * @returns The error message string
 */
export function getErrorMessage(key: string, fallback?: string): string {
  return DEFAULT_MESSAGES[key] ?? fallback ?? key;
}
