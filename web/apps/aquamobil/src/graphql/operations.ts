// ============================================================================
// AquaMobil GraphQL Operations
// ============================================================================
// Note: tenantId/userId come from @Tenant() and @CurrentUser() decorators on backend,
// NOT from GraphQL variables. They are extracted from JWT token.

// Queries - tenantId comes from X-Tenant-Id header (set from JWT)
export const GET_TANKS_WITH_BATCHES = `
  query GetTanksWithBatches {
    tanks {
      items {
        id
        name
        code
        volume
        status
        currentBiomass
        maxBiomass
        batchMetrics {
          batchId
          batchNumber
          pieces
          avgWeight
          biomass
          density
          capacityUsedPercent
          isOverCapacity
          daysSinceStocking
        }
      }
      total
    }
  }
`;

// Mutations - tenantId/userId extracted from JWT by backend decorators
export const RECORD_MORTALITY = `
  mutation RecordMortality($input: RecordMortalityInput!) {
    recordMortality(input: $input) {
      id
      batchNumber
      currentQuantity
      totalMortality
      retentionRate
      mortalityRate
    }
  }
`;

export const RECORD_CULL = `
  mutation RecordCull($input: RecordCullInput!) {
    recordCull(input: $input) {
      id
      batchNumber
      currentQuantity
      cullCount
      retentionRate
    }
  }
`;

export const CREATE_HARVEST_RECORD = `
  mutation CreateHarvestRecord($input: CreateHarvestRecordInput!) {
    createHarvestRecord(input: $input) {
      id
      recordCode
      lotNumber
      quantityHarvested
      totalBiomass
      averageWeight
      qualityGrade
      status
    }
  }
`;

// Feeding queries and mutations
export const GET_TODAYS_FEEDING_PLAN = `
  query TodaysFeedingPlan($date: Date!) {
    dailyFeedingExecutions(date: $date) {
      id
      equipmentId
      equipmentName
      equipmentCode
      calculations
      plannedFeedKg
      actualFeedKg
      status
      hasTransitionWarning
    }
  }
`;

export const RECORD_DAILY_FEEDING = `
  mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
    recordDailyFeeding(input: $input) {
      id
      actualFeedKg
      status
      feedingMethod
      feederName
    }
  }
`;

// Attendance queries and mutations
export const GET_MY_ATTENDANCE_RECORDS = `
  query MyAttendanceRecords($startDate: String, $endDate: String, $limit: Int) {
    myAttendanceRecords(startDate: $startDate, endDate: $endDate, limit: $limit) {
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
  }
`;

export const GET_MY_ATTENDANCE_SUMMARY = `
  query MyAttendanceSummary($month: Int!, $year: Int!) {
    myAttendanceSummary(month: $month, year: $year) {
      totalWorkingDays
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

export const GET_TODAYS_ATTENDANCE = `
  query TodaysAttendance($employeeId: ID) {
    todaysAttendance(employeeId: $employeeId) {
      id
      employeeId
      date
      clockIn
      clockOut
      status
      workedMinutes
      overtimeMinutes
      remarks
    }
  }
`;

export const CLOCK_IN = `
  mutation ClockIn($input: ClockInInput!) {
    clockIn(input: $input) {
      id
      date
      clockIn
      status
      workedMinutes
      remarks
    }
  }
`;

export const CLOCK_OUT = `
  mutation ClockOut($input: ClockOutInput!) {
    clockOut(input: $input) {
      id
      date
      clockOut
      status
      workedMinutes
    }
  }
`;

// Leave queries and mutations
export const GET_MY_LEAVE_REQUESTS = `
  query MyLeaveRequests($status: LeaveRequestStatus, $limit: Int, $offset: Int) {
    myLeaveRequests(status: $status, limit: $limit, offset: $offset) {
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
      isHalfDay
      reason
      status
      createdAt
    }
  }
`;

export const GET_MY_LEAVE_BALANCES = `
  query MyLeaveBalances($year: Int!) {
    myLeaveBalances(year: $year) {
      id
      leaveTypeId
      leaveType {
        id
        name
        code
        category
        isPaid
        color
      }
      totalEntitlement
      usedDays
      pendingDays
      remainingDays
      year
    }
  }
`;

export const GET_LEAVE_TYPES = `
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

export const CREATE_LEAVE_REQUEST = `
  mutation CreateLeaveRequest($input: CreateLeaveRequestInput!) {
    createLeaveRequest(input: $input) {
      id
      startDate
      endDate
      totalDays
      status
    }
  }
`;

export const SUBMIT_LEAVE_REQUEST = `
  mutation SubmitLeaveRequest($id: ID!) {
    submitLeaveRequest(id: $id) {
      id
      status
    }
  }
`;

export const CANCEL_LEAVE_REQUEST = `
  mutation CancelLeaveRequest($id: ID!) {
    cancelLeaveRequest(id: $id) {
      id
      status
    }
  }
`;

// QUAL-01: AUTH mutations (LOGIN, REFRESH_TOKEN) are intentionally defined inline
// in hooks/useAuth.tsx where they are used. The duplicate exports previously in this
// file have been removed to avoid maintenance drift between two copies.
