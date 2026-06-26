/**
 * Attendance Management GraphQL Operations
 */

import { gql } from 'graphql-tag';
import {
  SHIFT_FRAGMENT,
  ATTENDANCE_RECORD_FRAGMENT,
} from './fragments';

// =====================
// Queries
// =====================

export const GET_SHIFTS = gql`
  query GetShifts($isActive: Boolean, $shiftType: ShiftType, $page: Int, $limit: Int) {
    shifts(isActive: $isActive, shiftType: $shiftType, page: $page, limit: $limit) {
      items {
        ...ShiftFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${SHIFT_FRAGMENT}
`;

export const GET_SHIFT = gql`
  query GetShift($id: ID!) {
    shift(id: $id) {
      ...ShiftFull
    }
  }
  ${SHIFT_FRAGMENT}
`;

export const GET_ATTENDANCE_RECORDS = gql`
  query GetAttendanceRecords(
    $employeeId: ID
    $departmentId: ID
    $status: AttendanceStatus
    $approvalStatus: ApprovalStatus
    $startDate: String
    $endDate: String
    $page: Int
    $limit: Int
  ) {
    attendanceRecords(
      employeeId: $employeeId
      departmentId: $departmentId
      status: $status
      approvalStatus: $approvalStatus
      startDate: $startDate
      endDate: $endDate
      page: $page
      limit: $limit
    ) {
      items {
        ...AttendanceRecordFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

// NOTE: Single attendanceRecord(id) query not implemented. Use attendanceRecords with filters.
export const GET_ATTENDANCE_RECORD = gql`
  query GetAttendanceRecord($employeeId: ID, $startDate: String, $endDate: String) {
    attendanceRecords(employeeId: $employeeId, startDate: $startDate, endDate: $endDate, limit: 1) {
      items {
        ...AttendanceRecordFull
      }
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const GET_MY_ATTENDANCE_RECORDS = gql`
  query GetMyAttendanceRecords(
    $startDate: String
    $endDate: String
    $limit: Int
  ) {
    myAttendanceRecords(startDate: $startDate, endDate: $endDate, limit: $limit) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const GET_ATTENDANCE_SUMMARY = gql`
  query GetAttendanceSummary($employeeId: ID!, $month: Int!, $year: Int!) {
    attendanceSummary(employeeId: $employeeId, month: $month, year: $year) {
      employeeId
      month
      year
      totalWorkDays
      presentDays
      absentDays
      lateDays
      leaveDays
      offshoreDays
      holidayDays
      totalWorkedMinutes
      totalOvertimeMinutes
      attendanceRate
    }
  }
`;

export const GET_DAILY_ATTENDANCE_OVERVIEW = gql`
  query GetDailyAttendanceOverview($date: String) {
    dailyAttendanceOverview(date: $date) {
      totalEmployees
      present
      absent
      late
      onLeave
      offshore
      attendanceRate
    }
  }
`;

export const GET_TODAYS_ATTENDANCE = gql`
  query GetTodaysAttendance($employeeId: ID) {
    todaysAttendance(employeeId: $employeeId) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const GET_EMPLOYEE_SCHEDULE = gql`
  query GetEmployeeSchedule(
    $employeeId: ID!
    $startDate: String!
    $endDate: String!
  ) {
    employeeSchedule(
      employeeId: $employeeId
      startDate: $startDate
      endDate: $endDate
    ) {
      date
      shiftId
      shiftName
      startTime
      endTime
      isOffshore
      workAreaId
      workAreaName
    }
  }
`;

export const GET_SCHEDULES = gql`
  query GetSchedules($filter: ScheduleFilterInput) {
    schedules(filter: $filter) {
      id
      code
      name
      description
      defaultShiftId
      defaultShift {
        id
        code
        name
      }
      status
      effectiveFrom
      effectiveTo
      isDefault
    }
  }
`;

export const GET_SCHEDULE_ENTRIES = gql`
  query GetScheduleEntries(
    $scheduleId: ID!
    $startDate: String!
    $endDate: String!
  ) {
    scheduleEntries(
      scheduleId: $scheduleId
      startDate: $startDate
      endDate: $endDate
    ) {
      id
      scheduleId
      employeeId
      employee {
        id
        firstName
        lastName
      }
      shiftId
      shift {
        id
        code
        name
        startTime
        endTime
      }
      effectiveDate
      notes
    }
  }
`;

// =====================
// Mutations
// =====================

export const CREATE_SHIFT = gql`
  mutation CreateShift($input: CreateShiftInput!) {
    createShift(input: $input) {
      ...ShiftFull
    }
  }
  ${SHIFT_FRAGMENT}
`;

export const UPDATE_SHIFT = gql`
  mutation UpdateShift($input: UpdateShiftInput!) {
    updateShift(input: $input) {
      ...ShiftFull
    }
  }
  ${SHIFT_FRAGMENT}
`;

export const CLOCK_IN = gql`
  mutation ClockIn($input: ClockInInput!) {
    clockIn(input: $input) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const CLOCK_OUT = gql`
  mutation ClockOut($input: ClockOutInput!) {
    clockOut(input: $input) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const CREATE_MANUAL_ATTENDANCE = gql`
  mutation CreateManualAttendance($input: ManualAttendanceInput!) {
    createManualAttendance(input: $input) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

// NOTE: updateAttendanceRecord does not exist in backend.
// Use createManualAttendance for corrections or approveAttendance for approval.

export const APPROVE_ATTENDANCE = gql`
  mutation ApproveAttendance($id: ID!, $notes: String) {
    approveAttendance(id: $id, notes: $notes) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const CREATE_SCHEDULE = gql`
  mutation CreateSchedule($input: CreateScheduleInput!) {
    createSchedule(input: $input) {
      id
      code
      name
      status
    }
  }
`;

export const UPDATE_SCHEDULE = gql`
  mutation UpdateSchedule($input: UpdateScheduleInput!) {
    updateSchedule(input: $input) {
      id
      code
      name
      status
    }
  }
`;

export const CREATE_SCHEDULE_ENTRY = gql`
  mutation CreateScheduleEntry($input: CreateScheduleEntryInput!) {
    createScheduleEntry(input: $input) {
      id
      scheduleId
      employeeId
      shiftId
      effectiveDate
    }
  }
`;

export const BULK_CREATE_SCHEDULE_ENTRIES = gql`
  mutation BulkCreateScheduleEntries($input: BulkScheduleEntryInput!) {
    bulkCreateScheduleEntries(input: $input) {
      created
      failed
      errors
    }
  }
`;

export const DELETE_SCHEDULE_ENTRY = gql`
  mutation DeleteScheduleEntry($id: ID!) {
    deleteScheduleEntry(id: $id) {
      success
    }
  }
`;
