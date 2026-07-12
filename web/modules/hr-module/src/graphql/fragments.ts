/**
 * GraphQL Fragments for HR Module
 * Reusable field selections for queries and mutations
 */

import { gql } from 'graphql-tag';

// =====================
// Employee Fragments
// =====================

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
    department
    position
    departmentHrId
    positionId
    hireDate
    personnelCategory
    seaWorthy
    isFarmWorker
  }
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
    department
    position
    departmentHrId
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
    isFarmWorker
    createdAt
    updatedAt
    createdBy
    updatedBy
    version
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Department & Position Fragments
// =====================

// NOTE: Department is an enum in the backend (not a separate entity).
// These fragments are kept as placeholders for future department/position entity support.
export const DEPARTMENT_FRAGMENT = gql`
  fragment DepartmentFull on Employee {
    id
    department
    departmentHrId
  }
`;

export const POSITION_FRAGMENT = gql`
  fragment PositionFull on Employee {
    id
    position
    positionId
  }
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
    competencyRatings
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
    earnings {
      baseSalary
      overtime
      bonus
      commission
      allowances
      grossPay
    }
    deductions {
      tax
      socialSecurity
      healthInsurance
      retirement
      otherDeductions
      totalDeductions
    }
    netPay
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
