/**
 * Leave Management domain types
 */

import type { BaseEntity, PaginatedResponse } from './common.types';
import type { Employee } from './employee.types';

// =====================
// Enums
// =====================

export enum LeaveCategory {
  ANNUAL = 'annual',
  SICK = 'sick',
  PARENTAL = 'parental',
  MATERNITY = 'maternity',
  PATERNITY = 'paternity',
  BEREAVEMENT = 'bereavement',
  UNPAID = 'unpaid',
  COMPENSATORY = 'compensatory',
  SHORE_LEAVE = 'shore_leave',
  ROTATION_BREAK = 'rotation_break',
  EMERGENCY = 'emergency',
  OTHER = 'other',
}

export enum LeaveRequestStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  CANCELLED = 'cancelled',
  WITHDRAWN = 'withdrawn',
}

export enum HalfDayPeriod {
  AM = 'am',
  PM = 'pm',
}

// =====================
// Interfaces
// =====================

export interface LeaveType extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  category: LeaveCategory;
  defaultDaysPerYear: number;
  maxCarryOverDays: number;
  requiresApproval: boolean;
  requiresDocumentation: boolean;
  minNoticeDays?: number;
  maxConsecutiveDays?: number;
  allowsHalfDay: boolean;
  isPaid: boolean;
  requiresBalance: boolean;
  colorCode?: string;
  displayOrder: number;
  isActive: boolean;
}

export interface LeaveBalance {
  id: string;
  tenantId: string;
  employeeId: string;
  employee?: Employee;
  leaveTypeId: string;
  leaveType?: LeaveType;
  year: number;
  openingBalance: number;
  accrued: number;
  used: number;
  pending: number;
  adjustment: number;
  carriedOver: number;
  currentBalance: number;
  availableBalance: number;
  lastAccrualDate?: string;
}

export interface ApprovalHistoryEntry {
  action: string;
  actorId: string;
  timestamp: string;
  notes?: string;
}

export interface LeaveAttachment {
  documentId: string;
  fileName: string;
  uploadedAt: string;
}

export interface LeaveRequest extends BaseEntity {
  requestNumber: string;
  employeeId: string;
  employee?: Employee;
  leaveTypeId: string;
  leaveType?: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: number;
  isHalfDayStart: boolean;
  isHalfDayEnd: boolean;
  halfDayPeriod?: HalfDayPeriod;
  reason?: string;
  contactDuringLeave?: string;
  status: LeaveRequestStatus;
  currentApprovalLevel: number;
  approvalHistory?: ApprovalHistoryEntry[];
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  cancelledBy?: string;
  cancelledAt?: string;
  cancellationReason?: string;
  attachments?: LeaveAttachment[];
}

export interface LeaveCalendarEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  leaveTypeName: string;
  leaveTypeColor: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  status: LeaveRequestStatus;
  isHalfDayStart: boolean;
  isHalfDayEnd: boolean;
}

// =====================
// Input Types
// =====================

export interface CreateLeaveRequestInput {
  employeeId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: HalfDayPeriod;
  reason?: string;
  contactDuringLeave?: string;
}

export interface UpdateLeaveRequestInput {
  id: string;
  startDate?: string;
  endDate?: string;
  totalDays?: number;
  isHalfDayStart?: boolean;
  isHalfDayEnd?: boolean;
  halfDayPeriod?: HalfDayPeriod;
  reason?: string;
  contactDuringLeave?: string;
}

export interface LeaveRequestFilterInput {
  employeeId?: string;
  status?: LeaveRequestStatus;
  leaveTypeId?: string;
  startDate?: string;
  endDate?: string;
}

// =====================
// Response Types
// =====================

export type LeaveRequestConnection = PaginatedResponse<LeaveRequest>;

// =====================
// Display Helpers
// =====================

export const LEAVE_STATUS_CONFIG: Record<LeaveRequestStatus, { label: string; variant: string }> = {
  [LeaveRequestStatus.DRAFT]: { label: 'Draft', variant: 'default' },
  [LeaveRequestStatus.PENDING]: { label: 'Pending', variant: 'warning' },
  [LeaveRequestStatus.APPROVED]: { label: 'Approved', variant: 'success' },
  [LeaveRequestStatus.REJECTED]: { label: 'Rejected', variant: 'error' },
  [LeaveRequestStatus.CANCELLED]: { label: 'Cancelled', variant: 'default' },
  [LeaveRequestStatus.WITHDRAWN]: { label: 'Withdrawn', variant: 'default' },
};

export const LEAVE_CATEGORY_CONFIG: Record<LeaveCategory, { label: string; icon: string }> = {
  [LeaveCategory.ANNUAL]: { label: 'Annual Leave', icon: 'Sun' },
  [LeaveCategory.SICK]: { label: 'Sick Leave', icon: 'Thermometer' },
  [LeaveCategory.PARENTAL]: { label: 'Parental Leave', icon: 'Users' },
  [LeaveCategory.MATERNITY]: { label: 'Maternity Leave', icon: 'Baby' },
  [LeaveCategory.PATERNITY]: { label: 'Paternity Leave', icon: 'Baby' },
  [LeaveCategory.BEREAVEMENT]: { label: 'Bereavement Leave', icon: 'Heart' },
  [LeaveCategory.UNPAID]: { label: 'Unpaid Leave', icon: 'Clock' },
  [LeaveCategory.COMPENSATORY]: { label: 'Compensatory Off', icon: 'Gift' },
  [LeaveCategory.SHORE_LEAVE]: { label: 'Shore Leave', icon: 'Anchor' },
  [LeaveCategory.ROTATION_BREAK]: { label: 'Rotation Break', icon: 'RefreshCw' },
  [LeaveCategory.EMERGENCY]: { label: 'Emergency Leave', icon: 'AlertTriangle' },
  [LeaveCategory.OTHER]: { label: 'Other Leave', icon: 'FileText' },
};
