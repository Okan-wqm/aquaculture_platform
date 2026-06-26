/**
 * Employee GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  EMPLOYEE_BASIC_FRAGMENT,
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

// NOTE: searchEmployees query not yet implemented in backend.
// Using activeEmployees as a workaround for search functionality.
// WHY: Backend activeEmployees resolver accepts (limit: Int, page: Int), not offset.
export const SEARCH_EMPLOYEES = gql`
  query SearchEmployees($limit: Int, $page: Int) {
    activeEmployees(limit: $limit, page: $page) {
      ...EmployeeBasic
      department
      position
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_DEPARTMENTS = gql`
  query GetDepartments($siteId: ID, $isDeleted: Boolean) {
    hrDepartments(siteId: $siteId, isDeleted: $isDeleted) {
      id
      name
      code
      description
      siteId
      parentDepartmentId
      managerId
      budgetCode
      costCenter
      isActive
      sortOrder
    }
  }
`;

// NOTE: No separate department entity. Use employeesByDepartment to get employees by department enum.
// WHY: Backend employeesByDepartment resolver accepts (limit: Int, page: Int), not offset.
// WHY: The Department TS enum is registered in the GraphQL schema under the SDL name
// `HRDepartment` (employee.entity.ts: registerEnumType(Department, { name: 'HRDepartment' })),
// so the operation variable must reference `HRDepartment`, not the (non-existent) `Department`.
export const GET_DEPARTMENT = gql`
  query GetDepartment($department: HRDepartment!, $limit: Int, $page: Int) {
    employeesByDepartment(department: $department, limit: $limit, page: $page) {
      ...EmployeeBasic
      department
      position
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
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

// NOTE: organizationTree query not yet implemented in backend.
// Using employees query as a workaround.
// WHY: pagination is a separate argument, not part of filter.
export const GET_ORGANIZATION_TREE = gql`
  query GetOrganizationTree {
    employees(pagination: { limit: 100 }) {
      items {
        id
        firstName
        lastName
        department
        departmentHrId
        positionId
        supervisorId
        position
      }
      total
    }
  }
`;

// NOTE: directReports query not yet implemented in backend.
// Filter employees by supervisorId on the client side.
// WHY: Backend activeEmployees resolver accepts (limit: Int, page: Int), not offset.
export const GET_DIRECT_REPORTS = gql`
  query GetDirectReports($limit: Int, $page: Int) {
    activeEmployees(limit: $limit, page: $page) {
      ...EmployeeBasic
      department
      position
      supervisorId
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
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

// NOTE: Department is an enum, use updateEmployee to change it
export const ASSIGN_EMPLOYEE_TO_DEPARTMENT = gql`
  mutation AssignEmployeeToDepartment($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      department
      departmentHrId
    }
  }
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

export const TOGGLE_FARM_WORKER = gql`
  mutation ToggleFarmWorker($id: ID!, $isFarmWorker: Boolean!) {
    toggleFarmWorker(id: $id, isFarmWorker: $isFarmWorker) {
      id
      isFarmWorker
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
      id
      name
      code
      description
      siteId
      parentDepartmentId
      managerId
      budgetCode
      costCenter
      isActive
      sortOrder
    }
  }
`;

export const UPDATE_DEPARTMENT = gql`
  mutation UpdateDepartment($input: UpdateHRDepartmentInput!) {
    updateHRDepartment(input: $input) {
      id
      name
      code
      description
      siteId
      parentDepartmentId
      managerId
      budgetCode
      costCenter
      isActive
      sortOrder
    }
  }
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
