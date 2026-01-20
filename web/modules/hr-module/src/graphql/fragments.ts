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
    phone
    avatarUrl
    status
    employmentType
  }
`;

export const EMPLOYEE_FULL_FRAGMENT = gql`
  fragment EmployeeFull on Employee {
    ...EmployeeBasic
    dateOfBirth
    gender
    nationality
    nationalId
    address
    city
    country
    postalCode
    secondaryPhone
    departmentId
    department {
      id
      code
      name
      colorCode
    }
    positionId
    position {
      id
      code
      title
    }
    managerId
    manager {
      id
      firstName
      lastName
      email
    }
    hireDate
    terminationDate
    probationEndDate
    baseSalary
    currency
    personnelCategory
    assignedWorkAreas
    seaWorthy
    currentRotationId
    emergencyInfo
    createdAt
    updatedAt
    version
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Department & Position Fragments
// =====================

export const DEPARTMENT_FRAGMENT = gql`
  fragment DepartmentFull on Department {
    id
    tenantId
    code
    name
    description
    managerId
    manager {
      id
      firstName
      lastName
    }
    parentDepartmentId
    employeeCount
    colorCode
    isActive
  }
`;

export const POSITION_FRAGMENT = gql`
  fragment PositionFull on Position {
    id
    tenantId
    code
    title
    description
    departmentId
    minSalary
    maxSalary
    isActive
  }
`;

// =====================
// Leave Fragments
// =====================

export const LEAVE_TYPE_FRAGMENT = gql`
  fragment LeaveTypeFull on LeaveType {
    id
    code
    name
    description
    category
    defaultDaysPerYear
    maxCarryOverDays
    requiresApproval
    requiresDocumentation
    minNoticeDays
    maxConsecutiveDays
    allowsHalfDay
    isPaid
    requiresBalance
    colorCode
    displayOrder
    isActive
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
      colorCode
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
      colorCode
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
    approvalHistory
    approvedBy
    approvedAt
    rejectedBy
    rejectedAt
    rejectionReason
    cancelledBy
    cancelledAt
    cancellationReason
    attachments
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
    startTime
    endTime
    graceMinutes
    breakPeriods
    workDays
    isNightShift
    isOffshoreShift
    rotationDays
    colorCode
    isActive
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
    attendanceDate
    scheduleId
    shiftId
    shift {
      id
      code
      name
    }
    clockInTime
    clockOutTime
    clockInMethod
    clockOutMethod
    clockInLocation
    clockOutLocation
    status
    isLate
    lateMinutes
    isEarlyDeparture
    earlyDepartureMinutes
    workedMinutes
    overtimeMinutes
    isOffshoreWork
    workAreaId
    notes
    approvedBy
    approvedAt
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
    issuingAuthority
    validityMonths
    renewalReminderDays
    isMandatory
    requiredForOffshore
    requiredForDiving
    requiredForVessel
    prerequisiteCertificationIds
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
      validityMonths
    }
    certificateNumber
    issuedDate
    expiryDate
    issuedBy
    status
    verifiedBy
    verifiedAt
    verificationNotes
    attachmentUrl
    reminderSentAt
    revokedBy
    revokedAt
    revocationReason
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
    category
    deliveryMethod
    durationHours
    maxParticipants
    passingScore
    certificationTypeId
    prerequisiteCourseIds
    isMandatory
    refresherMonths
    isActive
  }
`;

export const TRAINING_ENROLLMENT_FRAGMENT = gql`
  fragment TrainingEnrollmentFull on TrainingEnrollment {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    courseId
    course {
      id
      code
      name
      category
      deliveryMethod
      durationHours
    }
    enrolledAt
    startedAt
    completedAt
    status
    score
    passed
    feedback
    instructorNotes
    certificateIssuedAt
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
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
    siteId
    siteName
    location
    maxCapacity
    currentOccupancy
    isOffshore
    requiresCertifications
    safetyEquipment
    emergencyProcedures
    displayOrder
    isActive
  }
`;

export const WORK_ROTATION_FRAGMENT = gql`
  fragment WorkRotationFull on WorkRotation {
    id
    tenantId
    employeeId
    employee {
      ...EmployeeBasic
    }
    workAreaId
    workArea {
      id
      code
      name
      workAreaType
      isOffshore
    }
    rotationType
    startDate
    endDate
    actualStartDate
    actualEndDate
    status
    daysOn
    daysOff
    transportToSite
    transportFromSite
    accommodationDetails
    notes
    approvedBy
    approvedAt
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
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
    keyResults
    alignedReviewId
    parentGoalId
    milestones
    createdAt
    updatedAt
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;
