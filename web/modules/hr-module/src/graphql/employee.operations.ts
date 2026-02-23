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
export const GET_EMPLOYEES = gql`
  query GetEmployees($filter: EmployeeFilterInput) {
    employees(filter: $filter) {
      items {
        ...EmployeeList
      }
      total
      limit
      offset
      hasMore
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
      onLeaveCount
      offshoreCount
      onshoreCount
      seaWorthyCount
      departmentCount
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
export const SEARCH_EMPLOYEES = gql`
  query SearchEmployees($limit: Int, $offset: Int) {
    activeEmployees(limit: $limit, offset: $offset) {
      ...EmployeeBasic
      department
      position
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// NOTE: Department is an enum in the backend. Use employeesByDepartment query instead.
export const GET_DEPARTMENTS = gql`
  query GetDepartments {
    employees(filter: { limit: 0 }) {
      total
    }
  }
`;

// NOTE: No separate department entity. Use employeesByDepartment to get employees by department enum.
export const GET_DEPARTMENT = gql`
  query GetDepartment($department: Department!, $limit: Int, $offset: Int) {
    employeesByDepartment(department: $department, limit: $limit, offset: $offset) {
      ...EmployeeBasic
      department
      position
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// NOTE: Position is a string field in the backend. No separate Position entity.
export const GET_POSITIONS = gql`
  query GetPositions {
    employees(filter: { limit: 0 }) {
      total
    }
  }
`;

// NOTE: organizationTree query not yet implemented in backend.
// Using employees query as a workaround.
export const GET_ORGANIZATION_TREE = gql`
  query GetOrganizationTree {
    employees(filter: { limit: 100 }) {
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
export const GET_DIRECT_REPORTS = gql`
  query GetDirectReports($limit: Int, $offset: Int) {
    activeEmployees(limit: $limit, offset: $offset) {
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

// NOTE: Department is an enum in backend, not a separate entity.
// These mutations are kept as stubs for API compatibility.
export const CREATE_DEPARTMENT = gql`
  mutation CreateDepartment($input: CreateEmployeeInput!) {
    createEmployee(input: $input) {
      id
      department
    }
  }
`;

export const UPDATE_DEPARTMENT = gql`
  mutation UpdateDepartment($input: UpdateEmployeeInput!) {
    updateEmployee(input: $input) {
      id
      department
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
