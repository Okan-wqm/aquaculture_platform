/**
 * GraphQL Fragments for HR Module
 * Reusable field selections for queries and mutations
 */

import { gql } from 'graphql-tag';

// =====================
// Employee Fragments
// =====================

/**
 * The department an employee is placed in — the one selection every employee
 * view spreads, so "which department, which module" is asked for in one way.
 * `moduleCode` is null for a company-wide department.
 */
export const EMPLOYEE_DEPARTMENT_FRAGMENT = gql`
  fragment EmployeeDepartment on DepartmentHR {
    id
    name
    code
    moduleCode
  }
`;

export const EMPLOYEE_BASIC_FRAGMENT = gql`
  fragment EmployeeBasic on Employee {
    id
    tenantId
    employeeNumber
    firstName
    lastName
    email
    status
    employmentType
  }
`;

/**
 * Minimal fragment for list views — contains only display fields.
 * Does NOT include PII (nationalId, dateOfBirth, address, bankAccountNumber, etc.).
 * Use EMPLOYEE_FULL_FRAGMENT only for detail views and payroll-scoped queries
 * available to authorised roles. (SEC-002)
 */
export const EMPLOYEE_LIST_FRAGMENT = gql`
  fragment EmployeeList on Employee {
    id
    tenantId
    employeeNumber
    firstName
    lastName
    email
    status
    employmentType
    position
    departmentHrId
    departmentHr {
      ...EmployeeDepartment
    }
    positionId
    hireDate
    personnelCategory
    seaWorthy
  }
  ${EMPLOYEE_DEPARTMENT_FRAGMENT}
`;

export const EMPLOYEE_FULL_FRAGMENT = gql`
  fragment EmployeeFull on Employee {
    ...EmployeeBasic
    contactInfo {
      email
      phone
      emergencyContact
      emergencyPhone
    }
    address {
      street
      city
      state
      postalCode
      country
    }
    position
    departmentHrId
    departmentHr {
      ...EmployeeDepartment
    }
    positionId
    supervisorId
    farmId
    userId
    hireDate
    terminationDate
    currency
    certifications
    skills
    personnelCategory
    assignedWorkAreas
    seaWorthy
    currentRotationId
    timezone
    createdAt
    updatedAt
    createdBy
    updatedBy
    version
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
  ${EMPLOYEE_DEPARTMENT_FRAGMENT}
`;

// =====================
// Department & Position Fragments
// =====================

/**
 * A department as the Departments page edits it — the list query and both
 * mutations return exactly this, so a created or edited card needs no refetch
 * to look like the listed one.
 */
export const DEPARTMENT_FRAGMENT = gql`
  fragment DepartmentFull on DepartmentHR {
    id
    name
    code
    description
    siteId
    parentDepartmentId
    managerId
    budgetCode
    costCenter
    moduleCode
    isActive
    sortOrder
  }
`;

/**
 * A department as the organization chart reads it: the editable fields plus the
 * two the server derives — its head count and its manager's name. The chart
 * pays for the derived fields; the Departments page, which does not show them,
 * does not.
 */
export const DEPARTMENT_ORGANIZATION_FRAGMENT = gql`
  fragment DepartmentOrganization on DepartmentHR {
    ...DepartmentFull
    headCount
    managerName
  }
  ${DEPARTMENT_FRAGMENT}
`;

// =====================
// Leave Fragments
// =====================

export const LEAVE_TYPE_FRAGMENT = gql`
  fragment LeaveTypeFull on LeaveType {
    id
    tenantId
    code
    name
    description
    category
    isPaid
    isAccrued
    defaultDaysPerYear
    maxCarryOverDays
    maxConsecutiveDays
    minDaysNotice
    accrualRate
    requiresApproval
    approvalLevels
    isAquacultureSpecific
    applicableForOffshore
    color
    sortOrder
    isActive
    createdAt
    updatedAt
  }
`;

export const LEAVE_BALANCE_FRAGMENT = gql`
  fragment LeaveBalanceFull on LeaveBalance {
    id
    tenantId
    employeeId
    leaveTypeId
    leaveType {
      id
      code
      name
      category
      color
    }
    year
    openingBalance
    accrued
    used
    pending
    adjustment
    carriedOver
    currentBalance
    availableBalance
    lastAccrualDate
  }
`;

export const LEAVE_REQUEST_FRAGMENT = gql`
  fragment LeaveRequestFull on LeaveRequest {
    id
    tenantId
    requestNumber
    employeeId
    employee {
      ...EmployeeBasic
    }
    leaveTypeId
    leaveType {
      id
      code
      name
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
    contactDuringLeave
    status
    currentApprovalLevel
    approvalHistory {
      action
      actorId
      timestamp
      notes
    }
    approvedBy
    approvedAt
    rejectedBy
    rejectedAt
    rejectionReason
    cancelledBy
    cancelledAt
    cancellationReason
    attachments {
      documentId
      fileName
      uploadedAt
    }
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Attendance Fragments
// =====================

export const SHIFT_FRAGMENT = gql`
  fragment ShiftFull on Shift {
    id
    tenantId
    code
    name
    description
    shiftType
    startTime
    endTime
    totalMinutes
    breakMinutes
    graceMinutes
    breakPeriods {
      startTime
      endTime
      isPaid
    }
    workDays
    crossesMidnight
    colorCode
    isActive
    displayOrder
  }
`;

export const ATTENDANCE_RECORD_FRAGMENT = gql`
  fragment AttendanceRecordFull on AttendanceRecord {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    date
    shiftId
    clockIn
    clockOut
    clockInMethod
    clockOutMethod
    clockInLocation {
      latitude
      longitude
      address
      accuracy
    }
    clockOutLocation {
      latitude
      longitude
      address
      accuracy
    }
    timezone
    status
    lateMinutes
    earlyLeaveMinutes
    workedMinutes
    overtimeMinutes
    breakMinutes
    isOffshore
    workAreaId
    approvalStatus
    approvedBy
    approvedAt
    remarks
    isManualEntry
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Certification Fragments
// =====================

export const CERTIFICATION_TYPE_FRAGMENT = gql`
  fragment CertificationTypeFull on CertificationType {
    id
    tenantId
    code
    name
    description
    category
    requirement
    issuingAuthority
    validityMonths
    renewalReminderDays
    requiresRenewal
    requiresPhysicalAssessment
    isOffshoreRequired
    isDivingRequired
    applicableWorkAreas
    prerequisiteCertifications
    colorCode
    displayOrder
    isActive
  }
`;

export const EMPLOYEE_CERTIFICATION_FRAGMENT = gql`
  fragment EmployeeCertificationFull on EmployeeCertification {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    certificationTypeId
    certificationType {
      id
      code
      name
      category
      requirement
    }
    certificationNumber
    issueDate
    expiryDate
    status
    verificationStatus
    verifiedBy
    verifiedAt
    issuingAuthority
    externalCertificationId
    notes
    documents {
      documentId
      fileName
      uploadedAt
      documentType
    }
    revokedBy
    revokedAt
    revocationReason
    previousCertificationId
    isRenewal
    reminderSent
    reminderSentAt
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const TRAINING_COURSE_FRAGMENT = gql`
  fragment TrainingCourseFull on TrainingCourse {
    id
    tenantId
    code
    name
    description
    trainingType
    level
    durationMinutes
    maxAttempts
    passingScore
    certificationTypeId
    prerequisites
    isMandatory
    validityMonths
    isActive
  }
`;

export const TRAINING_ENROLLMENT_FRAGMENT = gql`
  fragment TrainingEnrollmentFull on TrainingEnrollment {
    id
    tenantId
    employeeId
    trainingCourseId
    status
    enrollmentDate
    dueDate
    startedAt
    completedAt
    progressPercent
    finalScore
    attemptCount
    assessmentAttempts {
      attemptNumber
      score
      passed
      attemptedAt
      durationMinutes
    }
    certificateId
    sessionId
    instructor
    location
    feedback
    feedbackRating
    notes
    createdAt
    updatedAt
  }
`;

// =====================
// Aquaculture Fragments
// =====================

export const WORK_AREA_FRAGMENT = gql`
  fragment WorkAreaFull on WorkArea {
    id
    tenantId
    code
    name
    description
    workAreaType
    riskLevel
    siteId
    coordinates {
      latitude
      longitude
    }
    isOffshore
    maxCapacity
    requiredCertifications
    requiredPPE
    requiresDivingCertification
    requiresVesselCertification
    requiresSeaWorthy
    emergencyContact
    emergencyProcedure
    colorCode
    displayOrder
    isActive
    createdAt
    updatedAt
  }
`;

export const WORK_ROTATION_FRAGMENT = gql`
  fragment WorkRotationFull on WorkRotation {
    id
    tenantId
    employeeId
    workAreaId
    rotationType
    status
    startDate
    endDate
    daysOn
    daysOff
    actualStartTime
    actualEndTime
    outboundTransport {
      method
      vehicleId
      departurePoint
      arrivalPoint
      scheduledTime
      actualTime
      notes
    }
    inboundTransport {
      method
      vehicleId
      departurePoint
      arrivalPoint
      scheduledTime
      actualTime
      notes
    }
    accommodationInfo
    supervisorId
    reliefEmployeeId
    notes
    isExtended
    extensionDays
    extensionReason
    lastCheckInTime
    createdAt
    updatedAt
  }
`;

// =====================
// Performance Fragments
// =====================

export const PERFORMANCE_REVIEW_FRAGMENT = gql`
  fragment PerformanceReviewFull on PerformanceReview {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    reviewerId
    reviewer {
      id
      firstName
      lastName
    }
    periodType
    periodStart
    periodEnd
    status
    selfAssessment
    selfRating
    managerAssessment
    managerRating
    finalRating
    competencyRatings {
      competencyId
      competencyName
      selfRating
      managerRating
      finalRating
      comments
    }
    strengths
    areasForImprovement
    developmentPlan
    employeeComments
    reviewerComments
    calibrationNotes
    acknowledgedBy
    acknowledgedAt
    finalizedBy
    finalizedAt
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GOAL_FRAGMENT = gql`
  fragment GoalFull on Goal {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    title
    description
    category
    priority
    status
    startDate
    targetDate
    completedDate
    progressPercent
    keyResults {
      id
      description
      targetValue
      currentValue
      unit
      isCompleted
    }
    alignedReviewId
    parentGoalId
    milestones {
      id
      title
      targetDate
      completedDate
      isCompleted
    }
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Payroll Fragments
// =====================

export const PAYROLL_FRAGMENT = gql`
  fragment PayrollFields on Payroll {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    payrollNumber
    payPeriodType
    payPeriodStart
    payPeriodEnd
    paymentDate
    workHours {
      regularHours
      overtimeHours
      holidayHours
      sickLeaveHours
      vacationHours
    }
    earningsGrossPay
    earningsGrossPayDecimal
    deductionsTotal
    deductionsTotalDecimal
    netPay
    netPayDecimal
    currency
    status
    approvedBy
    approvedAt
    notes
    paymentReference
    createdAt
    updatedAt
    createdBy
    updatedBy
    version
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;
