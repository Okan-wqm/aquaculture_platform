/**
 * Payroll GraphQL Operations
 */

import { gql } from 'graphql-tag';
import { PAYROLL_FRAGMENT } from './fragments';

// =====================
// Queries
// =====================

export const GET_PAYROLLS = gql`
  query GetPayrolls(
    $employeeId: ID
    $status: PayrollStatus
    $page: Int
    $limit: Int
  ) {
    payrolls(
      employeeId: $employeeId
      status: $status
      page: $page
      limit: $limit
    ) {
      items {
        ...PayrollFields
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${PAYROLL_FRAGMENT}
`;

// WHY: Backend pendingPayrolls resolver accepts (limit: Int, page: Int), not offset.
// Sending an unknown `offset` variable causes a GraphQL validation 400 error.
// Match the backend resolver signature exactly.
export const GET_PENDING_PAYROLLS = gql`
  query GetPendingPayrolls($limit: Int, $page: Int) {
    pendingPayrolls(limit: $limit, page: $page) {
      ...PayrollFields
    }
  }
  ${PAYROLL_FRAGMENT}
`;

// =====================
// Mutations
// =====================

export const CREATE_PAYROLL = gql`
  mutation CreatePayroll($input: CreatePayrollInput!) {
    createPayroll(input: $input) {
      ...PayrollFields
    }
  }
  ${PAYROLL_FRAGMENT}
`;

export const APPROVE_PAYROLL = gql`
  mutation ApprovePayroll($id: ID!) {
    approvePayroll(id: $id) {
      ...PayrollFields
    }
  }
  ${PAYROLL_FRAGMENT}
`;
