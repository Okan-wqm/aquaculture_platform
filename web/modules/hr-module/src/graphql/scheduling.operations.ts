/**
 * Scheduling GraphQL Operations
 * Weekly workforce planning queries and mutations
 */

import { gql } from 'graphql-tag';

// =====================
// Fragments
// =====================

export const WEEKLY_PLAN_ENTRY_FRAGMENT = gql`
  fragment WeeklyPlanEntryFull on WeeklyPlanEntry {
    id
    weeklyPlanId
    employeeId
    date
    dayOfWeek
    shiftId
    shift {
      id
      code
      name
      startTime
      endTime
      colorCode
    }
    isOffDay
    isLeaveDay
    leaveRequestId
    plannedStartTime
    plannedEndTime
    plannedMinutes
    entryType
    notes
  }
`;

export const WEEKLY_PLAN_FRAGMENT = gql`
  fragment WeeklyPlanFull on WeeklyPlan {
    id
    employeeId
    employee {
      id
      firstName
      lastName
      position
    }
    weekStartDate
    weekEndDate
    status
    plannedWorkDays
    plannedOffDays
    plannedTotalMinutes
    standardWeeklyMinutes
    plannedOvertimeMinutes
    actualOvertimeMinutes
    notifiedAt
    publishedAt
    notes
    createdAt
    updatedAt
    entries {
      ...WeeklyPlanEntryFull
    }
  }
  ${WEEKLY_PLAN_ENTRY_FRAGMENT}
`;

// =====================
// Queries
// =====================

export const GET_WEEKLY_PLANS = gql`
  query GetWeeklyPlans(
    $employeeId: ID
    $departmentId: ID
    $siteId: ID
    $weekStartDate: String
    $status: WeeklyPlanStatus
    $page: Int
    $limit: Int
  ) {
    weeklyPlans(
      employeeId: $employeeId
      departmentId: $departmentId
      siteId: $siteId
      weekStartDate: $weekStartDate
      status: $status
      page: $page
      limit: $limit
    ) {
      items {
        ...WeeklyPlanFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
  ${WEEKLY_PLAN_FRAGMENT}
`;

export const GET_WEEKLY_PLAN = gql`
  query GetWeeklyPlan($id: ID!) {
    weeklyPlan(id: $id) {
      ...WeeklyPlanFull
    }
  }
  ${WEEKLY_PLAN_FRAGMENT}
`;

export const GET_TEAM_WEEKLY_OVERVIEW = gql`
  query GetTeamWeeklyOverview(
    $weekStartDate: String!
    $departmentId: ID
    $siteId: ID
  ) {
    teamWeeklyOverview(
      weekStartDate: $weekStartDate
      departmentId: $departmentId
      siteId: $siteId
    ) {
      weekStartDate
      weekEndDate
      totalEmployees
      employeePlans {
        employeeId
        employeeName
        position
        weeklyPlanId
        planStatus
        days {
          dayOfWeek
          date
          entryType
          shiftCode
          shiftName
          startTime
          endTime
          plannedMinutes
        }
        totalWorkDays
        totalMinutes
        overtimeMinutes
      }
      daysSummary {
        dayOfWeek
        date
        workingCount
        offCount
        leaveCount
      }
    }
  }
`;

export const GET_SCHEDULING_SETTINGS = gql`
  query GetSchedulingSettings {
    schedulingSettings {
      tenantId
      standardWeeklyMinutes
      maxOvertimeMinutesPerWeek
      maxOvertimeMinutesPerMonth
      defaultShiftId
      workWeekStartDay
      autoNotifyEmployees
      notifyDaysBefore
      maxConsecutiveWorkDays
      minRestMinutesBetweenShifts
      allowOvertimeWithoutApproval
    }
  }
`;

export const GET_OVERTIME_SUMMARY = gql`
  query GetOvertimeSummary(
    $month: Int!
    $year: Int!
    $employeeId: ID
    $departmentId: ID
  ) {
    overtimeSummary(
      month: $month
      year: $year
      employeeId: $employeeId
      departmentId: $departmentId
    ) {
      month
      year
      totalPlannedOvertimeMinutes
      totalActualOvertimeMinutes
      employeeCount
      byEmployee {
        employeeId
        employeeName
        plannedOvertimeMinutes
        actualOvertimeMinutes
        weekCount
      }
    }
  }
`;

// =====================
// Mutations
// =====================

export const CREATE_WEEKLY_PLAN = gql`
  mutation CreateWeeklyPlan($input: CreateWeeklyPlanInput!) {
    createWeeklyPlan(input: $input) {
      ...WeeklyPlanFull
    }
  }
  ${WEEKLY_PLAN_FRAGMENT}
`;

export const UPDATE_PLAN_ENTRY = gql`
  mutation UpdatePlanEntry($input: UpdatePlanEntryInput!) {
    updatePlanEntry(input: $input) {
      ...WeeklyPlanEntryFull
    }
  }
  ${WEEKLY_PLAN_ENTRY_FRAGMENT}
`;

export const BULK_ASSIGN_SHIFTS = gql`
  mutation BulkAssignShifts($input: BulkAssignShiftsInput!) {
    bulkAssignShifts(input: $input) {
      success
      updatedCount
      errors
    }
  }
`;

export const COPY_WEEKLY_PLAN = gql`
  mutation CopyWeeklyPlan($sourceId: ID!, $targetWeekStartDate: String!) {
    copyWeeklyPlan(sourceId: $sourceId, targetWeekStartDate: $targetWeekStartDate) {
      ...WeeklyPlanFull
    }
  }
  ${WEEKLY_PLAN_FRAGMENT}
`;

export const PUBLISH_WEEKLY_PLAN = gql`
  mutation PublishWeeklyPlan($id: ID!) {
    publishWeeklyPlan(id: $id) {
      ...WeeklyPlanFull
    }
  }
  ${WEEKLY_PLAN_FRAGMENT}
`;

export const DELETE_WEEKLY_PLAN = gql`
  mutation DeleteWeeklyPlan($id: ID!) {
    deleteWeeklyPlan(id: $id)
  }
`;

export const UPDATE_SCHEDULING_SETTINGS = gql`
  mutation UpdateSchedulingSettings($input: UpdateSchedulingSettingsInput!) {
    updateSchedulingSettings(input: $input) {
      tenantId
      standardWeeklyMinutes
      maxOvertimeMinutesPerWeek
      maxOvertimeMinutesPerMonth
      defaultShiftId
      workWeekStartDay
      autoNotifyEmployees
      notifyDaysBefore
      maxConsecutiveWorkDays
      minRestMinutesBetweenShifts
      allowOvertimeWithoutApproval
    }
  }
`;
