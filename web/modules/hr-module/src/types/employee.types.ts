/**
 * Employee domain types
 */

import type { BaseEntity, GeoLocation } from './common.types';

// =====================
// Enums
// =====================

export enum EmployeeStatus {
  ACTIVE = 'ACTIVE',
  ON_LEAVE = 'ON_LEAVE',
  SUSPENDED = 'SUSPENDED',
  TERMINATED = 'TERMINATED',
}

export enum EmploymentType {
  FULL_TIME = 'FULL_TIME',
  PART_TIME = 'PART_TIME',
  CONTRACT = 'CONTRACT',
  SEASONAL = 'SEASONAL',
}

export enum Gender {
  MALE = 'male',
  FEMALE = 'female',
  OTHER = 'other',
  PREFER_NOT_TO_SAY = 'prefer_not_to_say',
}

export enum PersonnelCategory {
  OFFSHORE = 'OFFSHORE',
  ONSHORE = 'ONSHORE',
  HYBRID = 'HYBRID',
}

export enum WorkAreaType {
  SHORE_FACILITY = 'SHORE_FACILITY',
  SEA_CAGE = 'SEA_CAGE',
  FLOATING_PLATFORM = 'FLOATING_PLATFORM',
  VESSEL = 'VESSEL',
  FEED_BARGE = 'FEED_BARGE',
  PROCESSING_PLANT = 'PROCESSING_PLANT',
  HATCHERY = 'HATCHERY',
  WAREHOUSE = 'WAREHOUSE',
  OFFICE = 'OFFICE',
  LABORATORY = 'LABORATORY',
  WORKSHOP = 'WORKSHOP',
  OTHER = 'OTHER',
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

export enum DepartmentType {
  OPERATIONS = 'operations',
  MAINTENANCE = 'maintenance',
  FEEDING = 'feeding',
  QUALITY_CONTROL = 'quality_control',
  ADMINISTRATION = 'administration',
  MANAGEMENT = 'management',
  LOGISTICS = 'logistics',
  SECURITY = 'security',
  HATCHERY = 'hatchery',
  GROW_OUT = 'grow_out',
  PROCESSING = 'processing',
  LABORATORY = 'laboratory',
  GENERAL = 'general',
}

export interface Department {
  id: string;
  tenantId?: string;
  siteId?: string;
  parentDepartmentId?: string;
  name: string;
  code: string;
  type: DepartmentType;
  description?: string;
  managerId?: string;
  budgetCode?: string;
  costCenter?: string;
  isActive: boolean;
  sortOrder: number;
  colorCode?: string; // kept for backward compat in UI (not from backend)
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateDepartmentInput {
  name: string;
  code: string;
  type?: DepartmentType;
  description?: string;
  siteId?: string;
  parentDepartmentId?: string;
  managerId?: string;
  budgetCode?: string;
  costCenter?: string;
}

export interface UpdateDepartmentInput {
  id: string;
  name?: string;
  code?: string;
  type?: DepartmentType;
  description?: string;
  siteId?: string;
  parentDepartmentId?: string;
  managerId?: string;
  budgetCode?: string;
  costCenter?: string;
  isActive?: boolean;
  isDeleted?: boolean;
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
  dateOfBirth: string;
  nationalId: string;
  contactInfo: ContactInfo;
  address: Address;
  employmentType: EmploymentType;
  department?: string;
  position?: string;
  departmentHrId?: string;
  supervisorId?: string;
  farmId?: string;
  hireDate: string;
  baseSalary: number;
  currency?: string;
  personnelCategory?: PersonnelCategory;
  assignedWorkAreas?: WorkAreaType[];
  seaWorthy?: boolean;
  isFarmWorker?: boolean;
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
  [EmployeeStatus.ON_LEAVE]: { label: 'On Leave', variant: 'warning' },
  [EmployeeStatus.SUSPENDED]: { label: 'Suspended', variant: 'error' },
  [EmployeeStatus.TERMINATED]: { label: 'Terminated', variant: 'error' },
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
  [WorkAreaType.WORKSHOP]: 'Workshop',
  [WorkAreaType.OTHER]: 'Other',
};
