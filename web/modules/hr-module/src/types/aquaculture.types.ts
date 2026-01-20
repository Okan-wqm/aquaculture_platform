/**
 * Aquaculture-specific HR types
 * Work areas, offshore rotations, crew management
 */

import type { BaseEntity, PaginatedResponse, GeoLocation } from './common.types';
import type { Employee, WorkAreaType } from './employee.types';

// =====================
// Enums
// =====================

export enum RotationType {
  OFFSHORE = 'offshore',
  ONSHORE = 'onshore',
  FIELD = 'field',
  VESSEL = 'vessel',
  MIXED = 'mixed',
}

export enum RotationStatus {
  SCHEDULED = 'scheduled',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum TransportType {
  BOAT = 'boat',
  HELICOPTER = 'helicopter',
  FERRY = 'ferry',
  VEHICLE = 'vehicle',
  SELF = 'self',
}

// =====================
// Interfaces
// =====================

export interface WorkArea extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  workAreaType: WorkAreaType;
  siteId?: string;
  siteName?: string;
  location?: GeoLocation;
  maxCapacity?: number;
  currentOccupancy?: number;
  isOffshore: boolean;
  requiresCertifications: string[];
  requiredCertifications?: { id: string; name: string }[];
  safetyEquipment?: string[];
  emergencyProcedures?: string;
  displayOrder: number;
  isActive: boolean;
}

export interface WorkRotation extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  workAreaId: string;
  workArea?: WorkArea;
  rotationType: RotationType;
  startDate: string;
  endDate: string;
  actualStartDate?: string;
  actualEndDate?: string;
  status: RotationStatus;
  daysOn: number;
  daysOff: number;
  transportToSite?: TransportType;
  transportFromSite?: TransportType;
  accommodationDetails?: string;
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface SafetyTrainingRecord extends BaseEntity {
  employeeId: string;
  employee?: Employee;
  workAreaId: string;
  workArea?: WorkArea;
  trainingType: string;
  conductedBy: string;
  conductedAt: string;
  validUntil?: string;
  topics: string[];
  attendanceConfirmed: boolean;
  notes?: string;
}

export interface CrewAssignment {
  workAreaId: string;
  workArea: WorkArea;
  assignedEmployees: Employee[];
  currentCount: number;
  maxCapacity: number;
  occupancyRate: number;
}

export interface OffshoreStatus {
  employee: Employee;
  workArea?: WorkArea;
  rotation?: WorkRotation;
  dayOnRotation: number;
  totalDaysOnRotation: number;
  estimatedReturnDate: string;
  transportMethod?: TransportType;
}

export interface RotationCalendarEntry {
  id: string;
  employeeId: string;
  employeeName: string;
  workAreaName: string;
  rotationType: RotationType;
  startDate: string;
  endDate: string;
  status: RotationStatus;
  isOffshore: boolean;
  daysOn: number;
  daysOff: number;
}

export interface WorkAreaOccupancyReport {
  workArea: WorkArea;
  date: string;
  scheduledCount: number;
  actualCount: number;
  occupancyRate: number;
  employees: { id: string; name: string; rotationStatus: RotationStatus }[];
}

// =====================
// Input Types
// =====================

export interface CreateWorkAreaInput {
  code: string;
  name: string;
  description?: string;
  workAreaType: WorkAreaType;
  siteId?: string;
  location?: GeoLocation;
  maxCapacity?: number;
  isOffshore?: boolean;
  requiresCertifications?: string[];
  safetyEquipment?: string[];
  emergencyProcedures?: string;
}

export interface UpdateWorkAreaInput {
  id: string;
  name?: string;
  description?: string;
  maxCapacity?: number;
  isOffshore?: boolean;
  requiresCertifications?: string[];
  safetyEquipment?: string[];
  emergencyProcedures?: string;
  isActive?: boolean;
}

export interface CreateWorkRotationInput {
  employeeId: string;
  workAreaId: string;
  rotationType: RotationType;
  startDate: string;
  endDate: string;
  daysOn: number;
  daysOff: number;
  transportToSite?: TransportType;
  transportFromSite?: TransportType;
  accommodationDetails?: string;
  notes?: string;
}

export interface UpdateWorkRotationInput {
  id: string;
  startDate?: string;
  endDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  status?: RotationStatus;
  transportToSite?: TransportType;
  transportFromSite?: TransportType;
  notes?: string;
}

export interface CreateSafetyTrainingRecordInput {
  employeeId: string;
  workAreaId: string;
  trainingType: string;
  conductedBy: string;
  conductedAt: string;
  validUntil?: string;
  topics: string[];
  notes?: string;
}

export interface WorkAreaFilterInput {
  workAreaType?: WorkAreaType;
  siteId?: string;
  isOffshore?: boolean;
  isActive?: boolean;
}

export interface WorkRotationFilterInput {
  employeeId?: string;
  workAreaId?: string;
  rotationType?: RotationType;
  status?: RotationStatus;
  startDate?: string;
  endDate?: string;
}

// =====================
// Response Types
// =====================

export type WorkAreaConnection = PaginatedResponse<WorkArea>;
export type WorkRotationConnection = PaginatedResponse<WorkRotation>;

// =====================
// Display Helpers
// =====================

export const ROTATION_TYPE_CONFIG: Record<RotationType, { label: string; variant: string }> = {
  [RotationType.OFFSHORE]: { label: 'Offshore', variant: 'primary' },
  [RotationType.ONSHORE]: { label: 'Onshore', variant: 'success' },
  [RotationType.FIELD]: { label: 'Field', variant: 'info' },
  [RotationType.VESSEL]: { label: 'Vessel', variant: 'warning' },
  [RotationType.MIXED]: { label: 'Mixed', variant: 'default' },
};

export const ROTATION_STATUS_CONFIG: Record<RotationStatus, { label: string; variant: string }> = {
  [RotationStatus.SCHEDULED]: { label: 'Scheduled', variant: 'info' },
  [RotationStatus.IN_PROGRESS]: { label: 'In Progress', variant: 'warning' },
  [RotationStatus.COMPLETED]: { label: 'Completed', variant: 'success' },
  [RotationStatus.CANCELLED]: { label: 'Cancelled', variant: 'default' },
};

export const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
  [TransportType.BOAT]: 'Boat',
  [TransportType.HELICOPTER]: 'Helicopter',
  [TransportType.FERRY]: 'Ferry',
  [TransportType.VEHICLE]: 'Vehicle',
  [TransportType.SELF]: 'Self-arranged',
};

/**
 * Calculate rotation progress percentage
 */
export function calculateRotationProgress(rotation: WorkRotation): number {
  const start = new Date(rotation.actualStartDate || rotation.startDate);
  const end = new Date(rotation.endDate);
  const now = new Date();

  if (now < start) return 0;
  if (now > end) return 100;

  const totalDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  const elapsedDays = (now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

  return Math.round((elapsedDays / totalDays) * 100);
}

/**
 * Get days remaining in rotation
 */
export function getDaysRemaining(rotation: WorkRotation): number {
  const end = new Date(rotation.endDate);
  const now = new Date();

  if (now > end) return 0;

  return Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}
