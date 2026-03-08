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
    $limit: Int
    $offset: Int
  ) {
    payrolls(
      employeeId: $employeeId
      status: $status
      limit: $limit
      offset: $offset
    ) {
      items {
        ...PayrollFields
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${PAYROLL_FRAGMENT}
`;

export const GET_PENDING_PAYROLLS = gql`
  query GetPendingPayrolls($limit: Int, $offset: Int) {
    pendingPayrolls(limit: $limit, offset: $offset) {
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
