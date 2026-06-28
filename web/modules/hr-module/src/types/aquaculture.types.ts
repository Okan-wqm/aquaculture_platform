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
  OFFSHORE = 'OFFSHORE',
  ONSHORE = 'ONSHORE',
  FIELD = 'FIELD',
  VESSEL = 'VESSEL',
  MIXED = 'MIXED',
}

export enum RotationStatus {
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXTENDED = 'EXTENDED',
}

export enum TransportType {
  BOAT = 'BOAT',
  HELICOPTER = 'HELICOPTER',
  VEHICLE = 'VEHICLE',
  OTHER = 'OTHER',
}

// =====================
// Interfaces
// =====================

export interface WorkArea extends BaseEntity {
  code: string;
  name: string;
  description?: string;
  workAreaType: WorkAreaType;
  riskLevel?: string;
  siteId?: string;
  coordinates?: { latitude: number; longitude: number };
  maxCapacity?: number;
  isOffshore: boolean;
  requiredCertifications?: string[];
  requiredPPE?: string[];
  requiresDivingCertification?: boolean;
  requiresVesselCertification?: boolean;
  requiresSeaWorthy?: boolean;
  emergencyContact?: string;
  emergencyProcedure?: string;
  colorCode?: string;
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

// WHY: Backend CrewAssignment DTO is a flat structure with scalar fields only.
// It does NOT include nested workArea or assignedEmployees objects —
// those caused GraphQL 400 errors when requested. The UI must join
// work area data client-side using the workAreaId if needed.
export interface CrewAssignment {
  workAreaId: string;
  workAreaName: string;
  assignedEmployeeIds: string[];
  currentCount: number;
  maxCapacity: number;
  occupancyRate: number;
  // WHY: Optional enriched fields populated client-side by joining with workAreas data.
  // Not from the backend GraphQL response.
  workArea?: WorkArea;
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
  riskLevel?: string;
  siteId?: string;
  coordinates?: { latitude: number; longitude: number };
  maxCapacity?: number;
  isOffshore?: boolean;
  requiredCertifications?: string[];
  requiredPPE?: string[];
  requiresDivingCertification?: boolean;
  requiresVesselCertification?: boolean;
  requiresSeaWorthy?: boolean;
  emergencyContact?: string;
  emergencyProcedure?: string;
  colorCode?: string;
}

export interface UpdateWorkAreaInput {
  id: string;
  name?: string;
  description?: string;
  riskLevel?: string;
  maxCapacity?: number;
  isOffshore?: boolean;
  requiredCertifications?: string[];
  requiredPPE?: string[];
  requiresDivingCertification?: boolean;
  requiresVesselCertification?: boolean;
  requiresSeaWorthy?: boolean;
  emergencyContact?: string;
  emergencyProcedure?: string;
  colorCode?: string;
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
  [RotationStatus.EXTENDED]: { label: 'Extended', variant: 'warning' },
};

export const TRANSPORT_TYPE_LABELS: Record<TransportType, string> = {
  [TransportType.BOAT]: 'Boat',
  [TransportType.HELICOPTER]: 'Helicopter',
  [TransportType.VEHICLE]: 'Vehicle',
  [TransportType.OTHER]: 'Other',
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
