// ============================================================================
// AquaMobil GraphQL Operations — S1-CODEGEN
// ============================================================================
// Note: tenantId/userId come from @Tenant() and @CurrentUser() decorators on backend,
// NOT from GraphQL variables. They are extracted from JWT token.
//
// S1-CODEGEN: every operation is a `gql`-tagged document so graphql-codegen can
// pluck it and generate a TypedDocumentNode + result types into
// ../generated/graphql.ts. No JS string interpolation here — each document is
// standalone.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';


import type {
  FeedingDayPlansQuery,
  FeedingDayPlansQueryVariables,
  MyAttendanceRecordsQuery,
  MyAttendanceRecordsQueryVariables,
  MyAttendanceSummaryQuery,
  MyAttendanceSummaryQueryVariables,
  MyTodaysAttendanceQuery,
  MyTodaysAttendanceQueryVariables,
  MyLeaveRequestsQuery,
  MyLeaveRequestsQueryVariables,
  MyLeaveBalancesQuery,
  MyLeaveBalancesQueryVariables,
  LeaveTypesQuery,
  LeaveTypesQueryVariables,
  CancelLeaveRequestMutation,
  CancelLeaveRequestMutationVariables,
  GetMyTasksQuery,
  GetMyTasksQueryVariables,
  GetTodaysTasksQuery,
  GetTodaysTasksQueryVariables,
  GetTaskDetailQuery,
  GetTaskDetailQueryVariables,
  GetTaskStatsQuery,
  GetTaskStatsQueryVariables,
  AddTaskNoteMutation,
  AddTaskNoteMutationVariables,
  GetMyNotificationsQuery,
  GetMyNotificationsQueryVariables,
  GetUnreadNotificationCountQuery,
  GetUnreadNotificationCountQueryVariables,
  MarkNotificationAsReadMutation,
  MarkNotificationAsReadMutationVariables,
  MarkAllNotificationsAsReadMutation,
  MarkAllNotificationsAsReadMutationVariables,
  RegisterDeviceTokenMutation,
  RegisterDeviceTokenMutationVariables,
  GetTodaysDailyOpsCountsQuery,
  GetTodaysDailyOpsCountsQueryVariables,
  GetStockEventsSummaryQuery,
  GetStockEventsSummaryQueryVariables,
  GetWarehouseSummaryQuery,
  GetWarehouseSummaryQueryVariables,
  MobileReportDeadlinesQuery,
  MobileReportDeadlinesQueryVariables,
  MobileReportDraftsQuery,
  MobileReportDraftsQueryVariables,
  MobileApproveAndSubmitReportDraftMutation,
  MobileApproveAndSubmitReportDraftMutationVariables,
} from '@/generated/graphql';
import {
  CompleteTaskDocument,
  SetChecklistItemDocument,
  StartTaskDocument,
  SubmitLeaveRequestDocument,
} from '@/generated/graphql';

// S1-CODEGEN: each operation is annotated with its generated
// `TypedDocumentNode<XQuery, XQueryVariables>` (no cast — gql DocumentNode is
// structurally assignable). The gql template stays the codegen pluck source.
//
// P-23 / MOB-HIGH-019: a mutation the offline queue replays is declared ONCE, in
// pwa/operation-registry.ts, and codegen emits its `<Name>Document` from that
// text. The online path re-exports the generated document under the name the
// hooks already import, so the two lanes cannot drift apart.

// FARM-LOW-217: the legacy GetTanksWithBatches document was deleted — the live
// tank source is FARM_STOCK_INVENTORY_QUERY (hooks/useTanks.ts); the dead doc
// had no importer and silently desynced from the Tank type's newer fields.

// Mutations - tenantId/userId extracted from JWT by backend decorators
// Feeding queries — Faz 6 öğün cutover'ı (P-25).
// Tipli alan alt kümesi okunur; `snapshot` jsonb'si mobil tele ÇIKMAZ (eski
// motorun opak `calculations` blob deseni v2'ye taşınmadı). Enum alanları tel
// üzerinde AD taşır ('SCHEDULED', 'FED', ... — GraphQL enum serileştirmesi).
// P-23 kuralı: kuyruklu mutation dokümanları YALNIZ pwa/operation-registry.ts
// içinde yaşar — bu dosyada feeding mutation dokümanı YOKTUR
// (pwa/__tests__/queued-mutation-ssot.spec.ts).
export const GET_FEEDING_DAY_PLANS: TypedDocumentNode<FeedingDayPlansQuery, FeedingDayPlansQueryVariables> = gql`
  query FeedingDayPlans($planDate: String!, $siteId: ID) {
    feedingDayPlans(planDate: $planDate, siteId: $siteId) {
      id
      unitId
      unitName
      unitCode
      planDate
      status
      plannedTotalKg
      unplannedActualKg
      mealsPlanned
      avgWeightG
      fishCount
      biomassKg
      waterTempC
      temperatureSource
      usingDefaultTemperature
      feedId
      feedCode
      feedName
      effectiveRatePercent
      expectedFcr
      meals {
        id
        mealIndex
        scheduledAt
        percentOfDaily
        plannedKg
        status
        actualKg
        varianceKg
        variancePercent
        feedId
        fedAt
        feedingMethod
        notes
      }
    }
  }
`;

// Attendance queries and mutations
// MOB-HIGH-019: ONE selection for both attendance reads, so the derived
// AttendanceRecord view type is the same shape whichever document produced it.
export const ATTENDANCE_RECORD_FIELDS = gql`
  fragment AttendanceRecordFields on AttendanceRecord {
    id
    employeeId
    date
    clockIn
    clockOut
    clockInMethod
    clockOutMethod
    status
    workedMinutes
    overtimeMinutes
    lateMinutes
    isOffshore
    remarks
    shiftId
  }
`;

export const GET_MY_ATTENDANCE_RECORDS: TypedDocumentNode<MyAttendanceRecordsQuery, MyAttendanceRecordsQueryVariables> = gql`
  ${ATTENDANCE_RECORD_FIELDS}
  query MyAttendanceRecords($startDate: String, $endDate: String, $limit: Int) {
    myAttendanceRecords(startDate: $startDate, endDate: $endDate, limit: $limit) {
      ...AttendanceRecordFields
    }
  }
`;

export const GET_MY_ATTENDANCE_SUMMARY: TypedDocumentNode<MyAttendanceSummaryQuery, MyAttendanceSummaryQueryVariables> = gql`
  query MyAttendanceSummary($month: Int!, $year: Int!) {
    myAttendanceSummary(month: $month, year: $year) {
      totalWorkingDays: totalWorkDays
      presentDays
      absentDays
      lateDays
      leaveDays
      totalWorkedMinutes
      totalOvertimeMinutes
      attendanceRate
    }
  }
`;

export const GET_TODAYS_ATTENDANCE: TypedDocumentNode<MyTodaysAttendanceQuery, MyTodaysAttendanceQueryVariables> = gql`
  ${ATTENDANCE_RECORD_FIELDS}
  query MyTodaysAttendance {
    myTodaysAttendance {
      ...AttendanceRecordFields
    }
  }
`;

// Leave queries and mutations
// Backend accepts "page" not "offset" — fix parameter name to match resolver signature
export const GET_MY_LEAVE_REQUESTS: TypedDocumentNode<MyLeaveRequestsQuery, MyLeaveRequestsQueryVariables> = gql`
  query MyLeaveRequests($status: LeaveRequestStatus, $limit: Int, $page: Int) {
    myLeaveRequests(status: $status, limit: $limit, page: $page) {
      id
      employeeId
      leaveTypeId
      leaveType {
        id
        name
        code
        category
        color
      }
      startDate
      endDate
      totalDays
      isHalfDayStart
      isHalfDayEnd
      halfDayPeriod
      reason
      status
      createdAt
    }
  }
`;

// S1-CODEGEN: the HR `LeaveBalance` GraphQL type has NO nested `leaveType`
// field (only `leaveTypeId`) — the previous `leaveType { … }` selection asked
// for a field the schema does not expose, so it returned nothing at runtime and
// the codegen client-contract gate now rejects it. The UI resolves the display
// type by joining `leaveTypeId` against the separately-fetched `leaveTypes`
// list; MyLeavesPage already falls back to a generic label when the join is
// absent. (Enrichment gap tracked as orphan finding S1-ORPHAN-LEAVE-TYPE.)
export const GET_MY_LEAVE_BALANCES: TypedDocumentNode<MyLeaveBalancesQuery, MyLeaveBalancesQueryVariables> = gql`
  query MyLeaveBalances($year: Int!) {
    myLeaveBalances(year: $year) {
      id
      leaveTypeId
      totalEntitlement: currentBalance
      usedDays: used
      pendingDays: pending
      remainingDays: availableBalance
      year
    }
  }
`;

export const GET_LEAVE_TYPES: TypedDocumentNode<LeaveTypesQuery, LeaveTypesQueryVariables> = gql`
  query LeaveTypes {
    leaveTypes {
      id
      name
      code
      category
      isPaid
      defaultDaysPerYear
      color
    }
  }
`;

export const SUBMIT_LEAVE_REQUEST = SubmitLeaveRequestDocument;

export const CANCEL_LEAVE_REQUEST: TypedDocumentNode<CancelLeaveRequestMutation, CancelLeaveRequestMutationVariables> = gql`
  mutation CancelLeaveRequest($id: ID!) {
    cancelLeaveRequest(id: $id) {
      id
      status
    }
  }
`;

// ============================================================================
// Task queries and mutations
// ============================================================================

// MOB-HIGH-019: ONE selection for the task list and the task detail, so the
// derived Task view type is the same shape on both pages. (The detail used to
// select recurringTemplateId/isAutoGenerated/updatedAt too; no page reads them.)
export const TASK_FIELDS = gql`
  fragment TaskFields on Task {
    id
    title
    description
    category
    priority
    status
    assignedTo
    assignedToName
    dueDate
    dueTime
    location
    estimatedMinutes
    checklistItems {
      id
      text
      isCompleted
      completedAt
      completedBy
    }
    notes {
      id
      text
      createdBy
      createdAt
    }
    tags
    isRecurring
    completedAt
    completedBy
    createdAt
  }
`;

export const GET_MY_TASKS: TypedDocumentNode<GetMyTasksQuery, GetMyTasksQueryVariables> = gql`
  ${TASK_FIELDS}
  query GetMyTasks($status: [TaskStatus!]) {
    myTasks(status: $status) {
      ...TaskFields
    }
  }
`;

export const GET_TODAYS_TASKS: TypedDocumentNode<GetTodaysTasksQuery, GetTodaysTasksQueryVariables> = gql`
  query GetTodaysTasks {
    todaysTasks {
      id
      title
      category
      priority
      status
      dueTime
      checklistItems {
        id
        text
        isCompleted
        completedAt
        completedBy
      }
      assignedToName
    }
  }
`;

export const GET_TASK_DETAIL: TypedDocumentNode<GetTaskDetailQuery, GetTaskDetailQueryVariables> = gql`
  ${TASK_FIELDS}
  query GetTaskDetail($id: ID!) {
    task(id: $id) {
      ...TaskFields
    }
  }
`;

export const GET_TASK_STATS: TypedDocumentNode<GetTaskStatsQuery, GetTaskStatsQueryVariables> = gql`
  query GetTaskStats {
    taskStats {
      totalToday
      completedToday
      overdueCount
      upcomingCount
      completionRate
      avgCompletionMinutes
    }
  }
`;

// FARM-HIGH-057 BREAKING CHANGE: completeTask/startTask now take a single
// `TaskLifecycleInput` that carries the task `id` PLUS the at-most-once command
// envelope (clientCommandId + payloadHash). The server REJECTS an envelope-less
// call for these three task mutations, so the envelope is mandatory on EVERY
// call — online and offline — not only offline-queued replays.
export const COMPLETE_TASK = CompleteTaskDocument;

export const START_TASK = StartTaskDocument;

// FARM-HIGH-057 BREAKING CHANGE: `toggleChecklistItem` (a server-side FLIP that a
// replayed offline command would REVERT) is replaced by `setChecklistItem`, which
// carries the ABSOLUTE target `isCompleted` plus the command envelope. SET (not
// flip) means any number of replays converge to the same state instead of
// ping-ponging the item.
export const SET_CHECKLIST_ITEM = SetChecklistItemDocument;

export const ADD_TASK_NOTE: TypedDocumentNode<AddTaskNoteMutation, AddTaskNoteMutationVariables> = gql`
  mutation AddTaskNote($taskId: ID!, $text: String!) {
    addTaskNote(taskId: $taskId, text: $text) {
      id
      notes {
        id
        text
        createdBy
        createdAt
      }
    }
  }
`;

// ============================================================================
// Notification queries and mutations
// ============================================================================

export const GET_MY_NOTIFICATIONS: TypedDocumentNode<GetMyNotificationsQuery, GetMyNotificationsQueryVariables> = gql`
  query GetMyNotifications($unreadOnly: Boolean, $limit: Int) {
    myNotifications(unreadOnly: $unreadOnly, limit: $limit) {
      id
      title
      body
      isRead
      readAt
      data
      createdAt
    }
  }
`;

export const GET_UNREAD_COUNT: TypedDocumentNode<GetUnreadNotificationCountQuery, GetUnreadNotificationCountQueryVariables> = gql`
  query GetUnreadNotificationCount {
    unreadNotificationCount
  }
`;

export const MARK_NOTIFICATION_READ: TypedDocumentNode<MarkNotificationAsReadMutation, MarkNotificationAsReadMutationVariables> = gql`
  mutation MarkNotificationAsRead($id: ID!) {
    markNotificationAsRead(id: $id)
  }
`;

export const MARK_ALL_READ: TypedDocumentNode<MarkAllNotificationsAsReadMutation, MarkAllNotificationsAsReadMutationVariables> = gql`
  mutation MarkAllNotificationsAsRead {
    markAllNotificationsAsRead
  }
`;

export const REGISTER_DEVICE_TOKEN: TypedDocumentNode<RegisterDeviceTokenMutation, RegisterDeviceTokenMutationVariables> = gql`
  mutation RegisterDeviceToken($token: String!, $platform: String!) {
    registerDeviceToken(token: $token, platform: $platform)
  }
`;

// ============================================================================
// Transfer mutation
// ============================================================================

// QUAL-01: AUTH mutations (LOGIN, REFRESH_TOKEN) are intentionally defined inline
// in hooks/useAuth.tsx where they are used. The duplicate exports previously in this
// file have been removed to avoid maintenance drift between two copies.

// ============================================================================
// Operations Hub Aggregate Queries — ADR-011
// ============================================================================
// WHY separate aggregate queries: hub pages need lightweight KPI counts, not
// the full entity lists. These queries minimize payload size and network time
// for the hub page initial render. Graceful fallback: if the backend resolver
// is not yet deployed, the hooks handle the error and default to zero values.

// FARM-MEDIUM-056: $clientDate threads the device-local calendar day
// (YYYY-MM-DD) to the backend so the dashboard counts and the phone agree on one
// named "today". Optional — when omitted the server uses FARM_DASHBOARD_TIME_ZONE.
export const GET_TODAYS_DAILY_OPS_COUNTS: TypedDocumentNode<GetTodaysDailyOpsCountsQuery, GetTodaysDailyOpsCountsQueryVariables> = gql`
  query GetTodaysDailyOpsCounts($clientDate: String) {
    todaysDailyOpsCounts(clientDate: $clientDate) {
      mortalityCount
      wqReadingsCount
      feedingCompletedCount
      feedingTotalCount
    }
  }
`;

export const GET_STOCK_EVENTS_SUMMARY: TypedDocumentNode<GetStockEventsSummaryQuery, GetStockEventsSummaryQueryVariables> = gql`
  query GetStockEventsSummary($daysBack: Int) {
    stockEventsSummary(daysBack: $daysBack) {
      thisWeekEventsCount
      recentEvents {
        id
        type
        tankName
        quantity
        createdAt
        note
      }
    }
  }
`;

// ============================================================================
// Regulatory report surface (FARM-HIGH-214 / RPT-019) — ONLINE-ONLY
// ============================================================================
// WHY online-only: a regulator submission must never sit in a device queue —
// the approve mutation is called live or not at all (the page gates the CTA on
// network status). Operation names carry a Mobile prefix so the aquamobil
// document set stays disjoint from farm-module's identically-named desktop
// operations at the codegen layer.

export const MOBILE_REPORT_DEADLINES: TypedDocumentNode<MobileReportDeadlinesQuery, MobileReportDeadlinesQueryVariables> = gql`
  query MobileReportDeadlines {
    reportDeadlines {
      id
      reportType
      siteId
      periodYear
      periodWeek
      periodMonth
      status
      dueAt
      overdue
      daysUntilDue
    }
  }
`;

export const MOBILE_REPORT_DRAFTS: TypedDocumentNode<MobileReportDraftsQuery, MobileReportDraftsQueryVariables> = gql`
  query MobileReportDrafts($filter: ReportDraftFilterInput) {
    reportDrafts(filter: $filter) {
      id
      reportType
      siteId
      periodYear
      periodWeek
      periodMonth
      status
      schemaValid
      dueAt
      assembledPayload
      fieldMeta
      manualOverrides
    }
  }
`;

export const MOBILE_APPROVE_AND_SUBMIT_REPORT_DRAFT: TypedDocumentNode<MobileApproveAndSubmitReportDraftMutation, MobileApproveAndSubmitReportDraftMutationVariables> = gql`
  mutation MobileApproveAndSubmitReportDraft($draftId: ID!) {
    approveAndSubmitReportDraft(draftId: $draftId) {
      success
      reportId
      referanse
      klientReferanse
      feilmelding
      valideringsfeil {
        felt
        melding
      }
    }
  }
`;

export const GET_WAREHOUSE_SUMMARY: TypedDocumentNode<GetWarehouseSummaryQuery, GetWarehouseSummaryQueryVariables> = gql`
  query GetWarehouseSummary {
    warehouseSummary {
      totalItems
      lowStockAlertCount
      todaysMovementCount
      lowStockItems {
        id
        name
        itemType
        currentQty
        minQty
        unit
      }
      recentMovements {
        id
        movementType
        itemName
        quantity
        unit
        createdAt
      }
      feedCoverage {
        feedId
        feedCode
        feedName
        daysOfCover
        stockoutDate
        coverageStatus
      }
    }
  }
`;
