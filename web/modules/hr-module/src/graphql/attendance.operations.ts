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
  query GetShifts($filter: ShiftFilterInput) {
    shifts(filter: $filter) {
      ...ShiftFull
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
    $filter: AttendanceFilterInput
    $pagination: PaginationInput
  ) {
    attendanceRecords(filter: $filter, pagination: $pagination) {
      items {
        ...AttendanceRecordFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const GET_ATTENDANCE_RECORD = gql`
  query GetAttendanceRecord($id: ID!) {
    attendanceRecord(id: $id) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const GET_MY_ATTENDANCE_RECORDS = gql`
  query GetMyAttendanceRecords(
    $filter: AttendanceFilterInput
    $pagination: PaginationInput
  ) {
    myAttendanceRecords(filter: $filter, pagination: $pagination) {
      items {
        ...AttendanceRecordFull
      }
      total
      limit
      offset
      hasMore
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
      totalWorkingDays
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
  query GetDailyAttendanceOverview($date: String!, $departmentId: ID) {
    dailyAttendanceOverview(date: $date, departmentId: $departmentId) {
      date
      totalEmployees
      presentCount
      absentCount
      onLeaveCount
      offshoreCount
      lateCount
      attendanceRate
    }
  }
`;

export const GET_TODAYS_ATTENDANCE = gql`
  query GetTodaysAttendance($departmentId: ID) {
    todaysAttendance(departmentId: $departmentId) {
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

export const CREATE_ATTENDANCE_RECORD = gql`
  mutation CreateAttendanceRecord($input: CreateAttendanceRecordInput!) {
    createAttendanceRecord(input: $input) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const UPDATE_ATTENDANCE_RECORD = gql`
  mutation UpdateAttendanceRecord($input: UpdateAttendanceRecordInput!) {
    updateAttendanceRecord(input: $input) {
      ...AttendanceRecordFull
    }
  }
  ${ATTENDANCE_RECORD_FRAGMENT}
`;

export const APPROVE_ATTENDANCE_RECORDS = gql`
  mutation ApproveAttendanceRecords($ids: [ID!]!) {
    approveAttendanceRecords(ids: $ids) {
      approved
      failed
      errors
    }
  }
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
