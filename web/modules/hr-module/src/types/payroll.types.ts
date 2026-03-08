/**
 * Payroll domain types
 */

import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum PayrollStatus {
  DRAFT = 'draft',
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  PROCESSING = 'processing',
  PAID = 'paid',
  CANCELLED = 'cancelled',
}

export enum PayPeriodType {
  WEEKLY = 'weekly',
  BI_WEEKLY = 'bi_weekly',
  SEMI_MONTHLY = 'semi_monthly',
  MONTHLY = 'monthly',
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
  earnings: EarningsBreakdown;
  deductions: DeductionsBreakdown;
  netPay: number;
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
  offset?: number;
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
