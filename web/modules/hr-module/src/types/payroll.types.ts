/**
 * Payroll domain types
 */

import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

// WHY: GraphQL enums registered via NestJS registerEnumType use the TypeScript enum KEYS
// as the GraphQL enum values. The backend stores lowercase values in the DB column, but
// the GraphQL transport layer expects UPPERCASE keys (DRAFT, PENDING_APPROVAL, etc.).
// Using lowercase values here caused silent 400 errors on any query or mutation that
// includes a PayrollStatus or PayPeriodType enum variable.
export enum PayrollStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  PROCESSING = 'PROCESSING',
  PAID = 'PAID',
  CANCELLED = 'CANCELLED',
}

export enum PayPeriodType {
  WEEKLY = 'WEEKLY',
  BI_WEEKLY = 'BI_WEEKLY',
  SEMI_MONTHLY = 'SEMI_MONTHLY',
  MONTHLY = 'MONTHLY',
}

// =====================
// Interfaces
// =====================

export interface WorkHours {
  regularHours: number;
  overtimeHours?: number;
  holidayHours?: number;
  sickLeaveHours?: number;
  vacationHours?: number;
}

export interface EarningsBreakdown {
  baseSalary: number;
  overtime?: number;
  bonus?: number;
  commission?: number;
  allowances?: number;
  grossPay: number;
}

export interface DeductionsBreakdown {
  tax?: number;
  socialSecurity?: number;
  healthInsurance?: number;
  retirement?: number;
  otherDeductions?: number;
  totalDeductions: number;
}

export interface Payroll {
  id: string;
  tenantId: string;
  employeeId: string;
  employee?: Employee;
  payrollNumber: string;
  payPeriodType: PayPeriodType;
  payPeriodStart: string;
  payPeriodEnd: string;
  paymentDate?: string;
  workHours: WorkHours;
  // The BE Payroll schema exposes FLATTENED earnings*/deductions* columns
  // (DB-MEDIUM-004) — the previous nested `earnings {}` / `deductions {}`
  // selection was never in the schema. Money crosses the wire as exact-decimal
  // strings via the *Decimal siblings (ADR-0004 / DATA-MEDIUM-009); parse with
  // `parseMoney`.
  /** @deprecated Float — use `earningsGrossPayDecimal`. */
  earningsGrossPay: number;
  earningsGrossPayDecimal: string;
  /** @deprecated Float — use `deductionsTotalDecimal`. */
  deductionsTotal: number;
  deductionsTotalDecimal: string;
  /** @deprecated Float — use `netPayDecimal`. */
  netPay: number;
  netPayDecimal: string;
  currency: string;
  status: PayrollStatus;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
  paymentReference?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  version: number;
}

// =====================
// Input Types
// =====================

export interface WorkHoursInput {
  regularHours: number;
  overtimeHours?: number;
  holidayHours?: number;
  sickLeaveHours?: number;
  vacationHours?: number;
}

export interface EarningsInput {
  baseSalary: number;
  overtime?: number;
  bonus?: number;
  commission?: number;
  allowances?: number;
}

export interface DeductionsInput {
  tax?: number;
  socialSecurity?: number;
  healthInsurance?: number;
  retirement?: number;
  otherDeductions?: number;
}

export interface CreatePayrollInput {
  employeeId: string;
  payPeriodType: PayPeriodType;
  payPeriodStart: string;
  payPeriodEnd: string;
  workHours: WorkHoursInput;
  earnings: EarningsInput;
  deductions?: DeductionsInput;
  currency?: string;
  notes?: string;
}

export interface PayrollFilterInput {
  employeeId?: string;
  status?: PayrollStatus;
  limit?: number;
  page?: number;
}

// =====================
// Display Helpers
// =====================

export const PAYROLL_STATUS_CONFIG: Record<PayrollStatus, { label: string; variant: string }> = {
  [PayrollStatus.DRAFT]: { label: 'Draft', variant: 'default' },
  [PayrollStatus.PENDING_APPROVAL]: { label: 'Pending Approval', variant: 'warning' },
  [PayrollStatus.APPROVED]: { label: 'Approved', variant: 'info' },
  [PayrollStatus.PROCESSING]: { label: 'Processing', variant: 'primary' },
  [PayrollStatus.PAID]: { label: 'Paid', variant: 'success' },
  [PayrollStatus.CANCELLED]: { label: 'Cancelled', variant: 'error' },
};

export const PAY_PERIOD_TYPE_LABELS: Record<PayPeriodType, string> = {
  [PayPeriodType.WEEKLY]: 'Weekly',
  [PayPeriodType.BI_WEEKLY]: 'Bi-Weekly',
  [PayPeriodType.SEMI_MONTHLY]: 'Semi-Monthly',
  [PayPeriodType.MONTHLY]: 'Monthly',
};
