/**
 * Employee GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  DEPARTMENT_FRAGMENT,
  DEPARTMENT_ORGANIZATION_FRAGMENT,
  EMPLOYEE_DEPARTMENT_FRAGMENT,
  EMPLOYEE_LIST_FRAGMENT,
  EMPLOYEE_FULL_FRAGMENT,
} from './fragments';

// =====================
// Queries
// =====================

/**
 * List query uses EMPLOYEE_LIST_FRAGMENT (no PII fields).
 * SEC-002: prevents bulk PII transmission on every list load.
 */
// WHY: Backend employees resolver accepts (filter: EmployeeFilterInput, pagination: EmployeePaginationInput)
// as two separate arguments. Sending limit/page inside the filter object causes GraphQL validation
// errors because EmployeeFilterInput does not define those fields. Pass pagination separately.
export const GET_EMPLOYEES = gql`
  query GetEmployees($filter: EmployeeFilterInput, $pagination: EmployeePaginationInput) {
    employees(filter: $filter, pagination: $pagination) {
      items {
        ...EmployeeList
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${EMPLOYEE_LIST_FRAGMENT}
`;

/**
 * Dashboard stats query — returns pre-aggregated counters without raw employee data.
 * CRIT-3 / PERF-001: replaces the limit:1000 full-PII fetch on the dashboard.
 */
export const GET_HR_DASHBOARD_STATS = gql`
  query GetHRDashboardStats {
    hrDashboardStats {
      totalEmployees
      activeEmployees
      onLeaveEmployees
      terminatedEmployees
      newHiresThisMonth
      offshoreEmployees
      onshoreEmployees
      attendanceRate
      pendingLeaveRequests
      totalDepartments
      unplacedEmployees
    }
  }
`;

export const GET_EMPLOYEE = gql`
  query GetEmployee($id: ID!) {
    employee(id: $id) {
      ...EmployeeFull
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

// NOTE: employeeByNumber query not yet implemented in backend.
// Use employee(id) or employees(filter) as workaround.
export const GET_EMPLOYEE_BY_NUMBER = gql`
  query GetEmployeeByNumber($filter: EmployeeFilterInput) {
    employees(filter: $filter) {
      items {
        ...EmployeeFull
      }
      total
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

// WHY: `$moduleCode` is the module scope of the reader (see useModuleScope) — absent means
// every module. Departments are a real entity (departments_hr); the employees of one
// department are `employees(filter: { departmentHrId })`, not a separate query.
export const GET_DEPARTMENTS = gql`
  query GetDepartments($siteId: ID, $isDeleted: Boolean, $moduleCode: HRModuleCode) {
    hrDepartments(siteId: $siteId, isDeleted: $isDeleted, moduleCode: $moduleCode) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

/** The departments of a workspace with the head count and manager name the chart draws. */
export const GET_ORGANIZATION_DEPARTMENTS = gql`
  query GetOrganizationDepartments($moduleCode: HRModuleCode) {
    hrDepartments(moduleCode: $moduleCode) {
      ...DepartmentOrganization
    }
  }
  ${DEPARTMENT_ORGANIZATION_FRAGMENT}
`;

// NOTE: Position is a string field in the backend. No separate Position entity.
// WHY: pagination is a separate argument, not part of filter.
export const GET_POSITIONS = gql`
  query GetPositions {
    employees(pagination: { limit: 1 }) {
      total
    }
  }
`;

// =====================
// Mutations
// =====================

export const CREATE_EMPLOYEE = gql`
  mutation CreateEmployee($input: CreateEmployeeInput!) {
    createEmployee(input: $input) {
      ...EmployeeFull
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

export const UPDATE_EMPLOYEE = gql`
  mutation UpdateEmployee($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      ...EmployeeFull
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

// NOTE: Using updateEmployee mutation for status changes (no separate updateEmployeeStatus)
export const UPDATE_EMPLOYEE_STATUS = gql`
  mutation UpdateEmployeeStatus($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      status
      terminationDate
    }
  }
`;

// NOTE: A department is placed through updateEmployee({ departmentHrId }); null unassigns.
export const ASSIGN_EMPLOYEE_TO_DEPARTMENT = gql`
  mutation AssignEmployeeToDepartment($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      departmentHrId
      departmentHr {
        ...EmployeeDepartment
      }
    }
  }
  ${EMPLOYEE_DEPARTMENT_FRAGMENT}
`;

// NOTE: Position is a string, use updateEmployee to change it
export const ASSIGN_EMPLOYEE_TO_POSITION = gql`
  mutation AssignEmployeeToPosition($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      position
      positionId
    }
  }
`;

// NOTE: No manager relation, use updateEmployee to change supervisorId
export const ASSIGN_MANAGER = gql`
  mutation AssignManager($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      supervisorId
    }
  }
`;

// NOTE: avatarUrl field does not exist on Employee entity
export const UPDATE_EMPLOYEE_AVATAR = gql`
  mutation UpdateEmployeeAvatar($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
    }
  }
`;

// NOTE: emergencyInfo is @HideField in backend, not accessible via GraphQL
export const UPDATE_EMERGENCY_INFO = gql`
  mutation UpdateEmergencyInfo($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
    }
  }
`;

export const CREATE_DEPARTMENT = gql`
  mutation CreateDepartment($input: CreateHRDepartmentInput!) {
    createHRDepartment(input: $input) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

export const UPDATE_DEPARTMENT = gql`
  mutation UpdateDepartment($input: UpdateHRDepartmentInput!) {
    updateHRDepartment(input: $input) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

// NOTE: Position is a string in backend, not a separate entity.
export const CREATE_POSITION = gql`
  mutation CreatePosition($input: CreateEmployeeInput!) {
    createEmployee(input: $input) {
      id
      position
    }
  }
`;

export const UPDATE_POSITION = gql`
  mutation UpdatePosition($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      position
    }
  }
`;
