/**
 * Leave Management GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  LEAVE_TYPE_FRAGMENT,
  LEAVE_BALANCE_FRAGMENT,
  LEAVE_REQUEST_FRAGMENT,
} from './fragments';

// =====================
// Queries
// =====================

export const GET_LEAVE_TYPES = gql`
  query GetLeaveTypes($filter: LeaveTypeFilterInput) {
    leaveTypes(filter: $filter) {
      ...LeaveTypeFull
    }
  }
  ${LEAVE_TYPE_FRAGMENT}
`;

export const GET_LEAVE_TYPE = gql`
  query GetLeaveType($id: ID!) {
    leaveType(id: $id) {
      ...LeaveTypeFull
    }
  }
  ${LEAVE_TYPE_FRAGMENT}
`;

export const GET_LEAVE_BALANCES = gql`
  query GetLeaveBalances($employeeId: ID!, $year: Int!) {
    leaveBalances(employeeId: $employeeId, year: $year) {
      ...LeaveBalanceFull
    }
  }
  ${LEAVE_BALANCE_FRAGMENT}
`;

export const GET_LEAVE_BALANCE_SUMMARY = gql`
  query GetLeaveBalanceSummary($employeeId: ID!, $year: Int!) {
    leaveBalanceSummary(employeeId: $employeeId, year: $year) {
      totalEntitled
      totalUsed
      totalPending
      totalAvailable
      balances {
        leaveTypeId
        leaveTypeName
        leaveTypeColor
        entitled
        used
        pending
        available
      }
    }
  }
`;

export const GET_LEAVE_REQUESTS = gql`
  query GetLeaveRequests(
    $filter: LeaveRequestFilterInput
    $pagination: PaginationInput
  ) {
    leaveRequests(filter: $filter, pagination: $pagination) {
      items {
        ...LeaveRequestFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const GET_LEAVE_REQUEST = gql`
  query GetLeaveRequest($id: ID!) {
    leaveRequest(id: $id) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const GET_MY_LEAVE_REQUESTS = gql`
  query GetMyLeaveRequests(
    $filter: LeaveRequestFilterInput
    $pagination: PaginationInput
  ) {
    myLeaveRequests(filter: $filter, pagination: $pagination) {
      items {
        ...LeaveRequestFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const GET_PENDING_LEAVE_APPROVALS = gql`
  query GetPendingLeaveApprovals($approverId: ID!) {
    pendingLeaveApprovals(approverId: $approverId) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const GET_TEAM_LEAVE_CALENDAR = gql`
  query GetTeamLeaveCalendar(
    $departmentId: ID
    $startDate: String!
    $endDate: String!
  ) {
    teamLeaveCalendar(
      departmentId: $departmentId
      startDate: $startDate
      endDate: $endDate
    ) {
      id
      employeeId
      employeeName
      leaveTypeName
      leaveTypeColor
      startDate
      endDate
      totalDays
      status
      isHalfDayStart
      isHalfDayEnd
    }
  }
`;

export const CHECK_LEAVE_OVERLAP = gql`
  query CheckLeaveOverlap(
    $employeeId: ID!
    $startDate: String!
    $endDate: String!
    $excludeRequestId: ID
  ) {
    checkLeaveOverlap(
      employeeId: $employeeId
      startDate: $startDate
      endDate: $endDate
      excludeRequestId: $excludeRequestId
    ) {
      hasOverlap
      overlappingRequests {
        id
        requestNumber
        startDate
        endDate
        status
      }
    }
  }
`;

export const CALCULATE_LEAVE_DAYS = gql`
  query CalculateLeaveDays(
    $leaveTypeId: ID!
    $startDate: String!
    $endDate: String!
    $isHalfDayStart: Boolean
    $isHalfDayEnd: Boolean
  ) {
    calculateLeaveDays(
      leaveTypeId: $leaveTypeId
      startDate: $startDate
      endDate: $endDate
      isHalfDayStart: $isHalfDayStart
      isHalfDayEnd: $isHalfDayEnd
    ) {
      totalDays
      workingDays
      weekends
      holidays
    }
  }
`;

// =====================
// Mutations
// =====================

export const CREATE_LEAVE_TYPE = gql`
  mutation CreateLeaveType($input: CreateLeaveTypeInput!) {
    createLeaveType(input: $input) {
      ...LeaveTypeFull
    }
  }
  ${LEAVE_TYPE_FRAGMENT}
`;

export const UPDATE_LEAVE_TYPE = gql`
  mutation UpdateLeaveType($input: UpdateLeaveTypeInput!) {
    updateLeaveType(input: $input) {
      ...LeaveTypeFull
    }
  }
  ${LEAVE_TYPE_FRAGMENT}
`;

export const INITIALIZE_LEAVE_BALANCES = gql`
  mutation InitializeLeaveBalances($employeeId: ID!, $year: Int!) {
    initializeLeaveBalances(employeeId: $employeeId, year: $year) {
      ...LeaveBalanceFull
    }
  }
  ${LEAVE_BALANCE_FRAGMENT}
`;

export const ADJUST_LEAVE_BALANCE = gql`
  mutation AdjustLeaveBalance(
    $employeeId: ID!
    $leaveTypeId: ID!
    $year: Int!
    $adjustment: Float!
    $reason: String!
  ) {
    adjustLeaveBalance(
      employeeId: $employeeId
      leaveTypeId: $leaveTypeId
      year: $year
      adjustment: $adjustment
      reason: $reason
    ) {
      ...LeaveBalanceFull
    }
  }
  ${LEAVE_BALANCE_FRAGMENT}
`;

export const CREATE_LEAVE_REQUEST = gql`
  mutation CreateLeaveRequest($input: CreateLeaveRequestInput!) {
    createLeaveRequest(input: $input) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const UPDATE_LEAVE_REQUEST = gql`
  mutation UpdateLeaveRequest($input: UpdateLeaveRequestInput!) {
    updateLeaveRequest(input: $input) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const SUBMIT_LEAVE_REQUEST = gql`
  mutation SubmitLeaveRequest($id: ID!) {
    submitLeaveRequest(id: $id) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const APPROVE_LEAVE_REQUEST = gql`
  mutation ApproveLeaveRequest($id: ID!, $notes: String) {
    approveLeaveRequest(id: $id, notes: $notes) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const REJECT_LEAVE_REQUEST = gql`
  mutation RejectLeaveRequest($id: ID!, $reason: String!) {
    rejectLeaveRequest(id: $id, reason: $reason) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const CANCEL_LEAVE_REQUEST = gql`
  mutation CancelLeaveRequest($id: ID!, $reason: String) {
    cancelLeaveRequest(id: $id, reason: $reason) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const WITHDRAW_LEAVE_REQUEST = gql`
  mutation WithdrawLeaveRequest($id: ID!) {
    withdrawLeaveRequest(id: $id) {
      ...LeaveRequestFull
    }
  }
  ${LEAVE_REQUEST_FRAGMENT}
`;

export const CARRY_OVER_LEAVE_BALANCES = gql`
  mutation CarryOverLeaveBalances($fromYear: Int!, $toYear: Int!) {
    carryOverLeaveBalances(fromYear: $fromYear, toYear: $toYear) {
      processed
      successful
      failed
      errors
    }
  }
`;
