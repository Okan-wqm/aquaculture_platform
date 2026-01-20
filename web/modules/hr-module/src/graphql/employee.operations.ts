/**
 * Employee GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  EMPLOYEE_BASIC_FRAGMENT,
  EMPLOYEE_FULL_FRAGMENT,
  DEPARTMENT_FRAGMENT,
  POSITION_FRAGMENT,
} from './fragments';

// =====================
// Queries
// =====================

export const GET_EMPLOYEES = gql`
  query GetEmployees(
    $filter: EmployeeFilterInput
    $pagination: PaginationInput
  ) {
    employees(filter: $filter, pagination: $pagination) {
      items {
        ...EmployeeFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

export const GET_EMPLOYEE = gql`
  query GetEmployee($id: ID!) {
    employee(id: $id) {
      ...EmployeeFull
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

export const GET_EMPLOYEE_BY_NUMBER = gql`
  query GetEmployeeByNumber($employeeNumber: String!) {
    employeeByNumber(employeeNumber: $employeeNumber) {
      ...EmployeeFull
    }
  }
  ${EMPLOYEE_FULL_FRAGMENT}
`;

export const SEARCH_EMPLOYEES = gql`
  query SearchEmployees($search: String!, $limit: Int) {
    searchEmployees(search: $search, limit: $limit) {
      ...EmployeeBasic
      department {
        id
        name
      }
      position {
        id
        title
      }
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_DEPARTMENTS = gql`
  query GetDepartments($filter: DepartmentFilterInput) {
    departments(filter: $filter) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

export const GET_DEPARTMENT = gql`
  query GetDepartment($id: ID!) {
    department(id: $id) {
      ...DepartmentFull
      employees {
        ...EmployeeBasic
      }
    }
  }
  ${DEPARTMENT_FRAGMENT}
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_POSITIONS = gql`
  query GetPositions($filter: PositionFilterInput) {
    positions(filter: $filter) {
      ...PositionFull
    }
  }
  ${POSITION_FRAGMENT}
`;

export const GET_ORGANIZATION_TREE = gql`
  query GetOrganizationTree {
    organizationTree {
      departments {
        id
        name
        code
        managerId
        parentDepartmentId
        employeeCount
        colorCode
      }
      employees {
        id
        firstName
        lastName
        departmentId
        positionId
        managerId
        avatarUrl
      }
    }
  }
`;

export const GET_DIRECT_REPORTS = gql`
  query GetDirectReports($managerId: ID!) {
    directReports(managerId: $managerId) {
      ...EmployeeBasic
      department {
        id
        name
      }
      position {
        id
        title
      }
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

export const UPDATE_EMPLOYEE_STATUS = gql`
  mutation UpdateEmployeeStatus($id: ID!, $status: EmployeeStatus!, $reason: String) {
    updateEmployeeStatus(id: $id, status: $status, reason: $reason) {
      id
      status
      terminationDate
    }
  }
`;

export const ASSIGN_EMPLOYEE_TO_DEPARTMENT = gql`
  mutation AssignEmployeeToDepartment($employeeId: ID!, $departmentId: ID!) {
    assignEmployeeToDepartment(employeeId: $employeeId, departmentId: $departmentId) {
      id
      departmentId
      department {
        id
        name
      }
    }
  }
`;

export const ASSIGN_EMPLOYEE_TO_POSITION = gql`
  mutation AssignEmployeeToPosition($employeeId: ID!, $positionId: ID!) {
    assignEmployeeToPosition(employeeId: $employeeId, positionId: $positionId) {
      id
      positionId
      position {
        id
        title
      }
    }
  }
`;

export const ASSIGN_MANAGER = gql`
  mutation AssignManager($employeeId: ID!, $managerId: ID!) {
    assignManager(employeeId: $employeeId, managerId: $managerId) {
      id
      managerId
      manager {
        id
        firstName
        lastName
      }
    }
  }
`;

export const UPDATE_EMPLOYEE_AVATAR = gql`
  mutation UpdateEmployeeAvatar($employeeId: ID!, $avatarUrl: String!) {
    updateEmployeeAvatar(employeeId: $employeeId, avatarUrl: $avatarUrl) {
      id
      avatarUrl
    }
  }
`;

export const UPDATE_EMERGENCY_INFO = gql`
  mutation UpdateEmergencyInfo($employeeId: ID!, $emergencyInfo: EmergencyInfoInput!) {
    updateEmergencyInfo(employeeId: $employeeId, emergencyInfo: $emergencyInfo) {
      id
      emergencyInfo
    }
  }
`;

export const CREATE_DEPARTMENT = gql`
  mutation CreateDepartment($input: CreateDepartmentInput!) {
    createDepartment(input: $input) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

export const UPDATE_DEPARTMENT = gql`
  mutation UpdateDepartment($input: UpdateDepartmentInput!) {
    updateDepartment(input: $input) {
      ...DepartmentFull
    }
  }
  ${DEPARTMENT_FRAGMENT}
`;

export const CREATE_POSITION = gql`
  mutation CreatePosition($input: CreatePositionInput!) {
    createPosition(input: $input) {
      ...PositionFull
    }
  }
  ${POSITION_FRAGMENT}
`;

export const UPDATE_POSITION = gql`
  mutation UpdatePosition($input: UpdatePositionInput!) {
    updatePosition(input: $input) {
      ...PositionFull
    }
  }
  ${POSITION_FRAGMENT}
`;
