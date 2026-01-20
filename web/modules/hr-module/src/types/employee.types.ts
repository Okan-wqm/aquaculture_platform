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

export interface Employee extends BaseEntity {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  secondaryPhone?: string;
  dateOfBirth?: string;
  gender?: Gender;
  nationality?: string;
  nationalId?: string;
  address?: string;
  city?: string;
  country?: string;
  postalCode?: string;
  status: EmployeeStatus;
  employmentType: EmploymentType;
  departmentId?: string;
  department?: Department;
  positionId?: string;
  position?: Position;
  managerId?: string;
  manager?: Employee;
  hireDate: string;
  terminationDate?: string;
  probationEndDate?: string;
  baseSalary?: number;
  currency?: string;
  bankAccountNumber?: string;
  bankName?: string;
  taxId?: string;
  // Aquaculture-specific
  personnelCategory?: PersonnelCategory;
  assignedWorkAreas?: WorkAreaType[];
  seaWorthy: boolean;
  currentRotationId?: string;
  emergencyInfo?: EmergencyInfo;
  avatarUrl?: string;
}

export interface Department {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  description?: string;
  managerId?: string;
  manager?: Employee;
  parentDepartmentId?: string;
  parentDepartment?: Department;
  employeeCount?: number;
  colorCode?: string;
  isActive: boolean;
}

export interface Position {
  id: string;
  tenantId: string;
  code: string;
  title: string;
  description?: string;
  departmentId?: string;
  department?: Department;
  minSalary?: number;
  maxSalary?: number;
  isActive: boolean;
}

// =====================
// Input Types
// =====================

export interface CreateEmployeeInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: Gender;
  nationalId?: string;
  address?: string;
  city?: string;
  country?: string;
  employmentType: EmploymentType;
  departmentId?: string;
  positionId?: string;
  managerId?: string;
  hireDate: string;
  baseSalary?: number;
  currency?: string;
  personnelCategory?: PersonnelCategory;
  assignedWorkAreas?: WorkAreaType[];
  seaWorthy?: boolean;
}

export interface UpdateEmployeeInput extends Partial<CreateEmployeeInput> {
  id: string;
  status?: EmployeeStatus;
  terminationDate?: string;
}

export interface EmployeeFilterInput {
  search?: string;
  status?: EmployeeStatus;
  employmentType?: EmploymentType;
  departmentId?: string;
  positionId?: string;
  personnelCategory?: PersonnelCategory;
  seaWorthy?: boolean;
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
