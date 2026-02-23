/**
 * Employee domain types
 */

import type { BaseEntity, GeoLocation } from './common.types';

// =====================
// Enums
// =====================

export enum EmployeeStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ON_LEAVE = 'on_leave',
  SUSPENDED = 'suspended',
  TERMINATED = 'terminated',
  PROBATION = 'probation',
}

export enum EmploymentType {
  FULL_TIME = 'full_time',
  PART_TIME = 'part_time',
  CONTRACT = 'contract',
  SEASONAL = 'seasonal',
  INTERN = 'intern',
}

export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
  PREFER_NOT_TO_SAY = 'prefer_not_to_say',
}

export enum PersonnelCategory {
  OFFSHORE = 'offshore',
  ONSHORE = 'onshore',
  HYBRID = 'hybrid',
}

export enum WorkAreaType {
  SHORE_FACILITY = 'shore_facility',
  SEA_CAGE = 'sea_cage',
  FLOATING_PLATFORM = 'floating_platform',
  VESSEL = 'vessel',
  FEED_BARGE = 'feed_barge',
  PROCESSING_PLANT = 'processing_plant',
  HATCHERY = 'hatchery',
  WAREHOUSE = 'warehouse',
  OFFICE = 'office',
  LABORATORY = 'laboratory',
}

// =====================
// Interfaces
// =====================

export interface NextOfKin {
  name: string;
  relationship: string;
  phone: string;
  email?: string;
  address?: string;
}

export interface EmergencyInfo {
  bloodType?: string;
  medicalConditions?: string[];
  allergies?: string[];
  nextOfKin?: NextOfKin;
}

export interface ContactInfo {
  email: string;
  phone: string;
  emergencyContact?: string;
  emergencyPhone?: string;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface Employee extends BaseEntity {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  contactInfo?: ContactInfo;
  address?: Address;
  status: EmployeeStatus;
  employmentType: EmploymentType;
  // Department is an enum string in backend (e.g., 'operations', 'maintenance')
  department?: string;
  // Position is a plain string in backend
  position?: string;
  departmentHrId?: string;
  positionId?: string;
  supervisorId?: string;
  farmId?: string;
  userId?: string;
  hireDate: string;
  terminationDate?: string;
  currency?: string;
  certifications?: string[];
  skills?: string[];
  // Aquaculture-specific
  personnelCategory?: PersonnelCategory;
  assignedWorkAreas?: WorkAreaType[];
  seaWorthy: boolean;
  currentRotationId?: string;
  timezone?: string;
  isFarmWorker?: boolean;
  createdBy?: string;
  updatedBy?: string;
  version?: number;
}

// NOTE: Department is an enum in the backend, not a separate entity.
// This interface is kept for backward compatibility with UI components.
export interface Department {
  id?: string;
  tenantId?: string;
  code?: string;
  name: string;
  description?: string;
  colorCode?: string;
  isActive?: boolean;
}

// NOTE: Position is a string field in the backend, not a separate entity.
// This interface is kept for backward compatibility with UI components.
export interface Position {
  id?: string;
  tenantId?: string;
  code?: string;
  title: string;
  description?: string;
  isActive?: boolean;
}

// =====================
// Input Types
// =====================

export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  email: string;
  contactInfo?: ContactInfo;
  address?: Address;
  employmentType: EmploymentType;
  department?: string;
  position?: string;
  supervisorId?: string;
  farmId?: string;
  hireDate: string;
  currency?: string;
  personnelCategory?: PersonnelCategory;
  assignedWorkAreas?: WorkAreaType[];
  seaWorthy?: boolean;
}

export interface UpdateEmployeeInput extends Partial<CreateEmployeeInput> {
  id: string;
  status?: EmployeeStatus;
  terminationDate?: string;
  isFarmWorker?: boolean;
}

export interface EmployeeFilterInput {
  status?: EmployeeStatus;
  employmentType?: EmploymentType;
  department?: string;
  farmId?: string;
  supervisorId?: string;
  personnelCategory?: PersonnelCategory;
  seaWorthy?: boolean;
  limit?: number;
  offset?: number;
}

// =====================
// Display Helpers
// =====================

export const EMPLOYEE_STATUS_CONFIG: Record<EmployeeStatus, { label: string; variant: string }> = {
  [EmployeeStatus.ACTIVE]: { label: 'Active', variant: 'success' },
  [EmployeeStatus.INACTIVE]: { label: 'Inactive', variant: 'default' },
  [EmployeeStatus.ON_LEAVE]: { label: 'On Leave', variant: 'warning' },
  [EmployeeStatus.SUSPENDED]: { label: 'Suspended', variant: 'error' },
  [EmployeeStatus.TERMINATED]: { label: 'Terminated', variant: 'error' },
  [EmployeeStatus.PROBATION]: { label: 'Probation', variant: 'info' },
};

export const PERSONNEL_CATEGORY_CONFIG: Record<PersonnelCategory, { label: string; variant: string }> = {
  [PersonnelCategory.OFFSHORE]: { label: 'Offshore', variant: 'primary' },
  [PersonnelCategory.ONSHORE]: { label: 'Onshore', variant: 'info' },
  [PersonnelCategory.HYBRID]: { label: 'Hybrid', variant: 'warning' },
};

export const WORK_AREA_TYPE_LABELS: Record<WorkAreaType, string> = {
  [WorkAreaType.SHORE_FACILITY]: 'Shore Facility',
  [WorkAreaType.SEA_CAGE]: 'Sea Cage',
  [WorkAreaType.FLOATING_PLATFORM]: 'Floating Platform',
  [WorkAreaType.VESSEL]: 'Vessel',
  [WorkAreaType.FEED_BARGE]: 'Feed Barge',
  [WorkAreaType.PROCESSING_PLANT]: 'Processing Plant',
  [WorkAreaType.HATCHERY]: 'Hatchery',
  [WorkAreaType.WAREHOUSE]: 'Warehouse',
  [WorkAreaType.OFFICE]: 'Office',
  [WorkAreaType.LABORATORY]: 'Laboratory',
};
