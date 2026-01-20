/**
 * Aquaculture-specific HR GraphQL Operations
 * Work areas, rotations, offshore crew management
 */

import { gql } from 'graphql-tag';
import {
  WORK_AREA_FRAGMENT,
  WORK_ROTATION_FRAGMENT,
  EMPLOYEE_BASIC_FRAGMENT,
} from './fragments';

// =====================
// Work Area Queries
// =====================

export const GET_WORK_AREAS = gql`
  query GetWorkAreas($filter: WorkAreaFilterInput) {
    workAreas(filter: $filter) {
      ...WorkAreaFull
    }
  }
  ${WORK_AREA_FRAGMENT}
`;

export const GET_WORK_AREA = gql`
  query GetWorkArea($id: ID!) {
    workArea(id: $id) {
      ...WorkAreaFull
      requiredCertifications {
        id
        code
        name
        category
      }
      currentAssignments {
        id
        firstName
        lastName
        avatarUrl
      }
    }
  }
  ${WORK_AREA_FRAGMENT}
`;

export const GET_OFFSHORE_WORK_AREAS = gql`
  query GetOffshoreWorkAreas {
    offshoreWorkAreas {
      ...WorkAreaFull
    }
  }
  ${WORK_AREA_FRAGMENT}
`;

export const GET_WORK_AREA_OCCUPANCY = gql`
  query GetWorkAreaOccupancy($workAreaId: ID!, $date: String!) {
    workAreaOccupancy(workAreaId: $workAreaId, date: $date) {
      workArea {
        id
        code
        name
        maxCapacity
      }
      date
      scheduledCount
      actualCount
      occupancyRate
      employees {
        id
        name
        rotationStatus
      }
    }
  }
`;

export const GET_ALL_WORK_AREA_OCCUPANCIES = gql`
  query GetAllWorkAreaOccupancies($date: String!) {
    allWorkAreaOccupancies(date: $date) {
      workArea {
        id
        code
        name
        workAreaType
        maxCapacity
        isOffshore
      }
      date
      scheduledCount
      actualCount
      occupancyRate
    }
  }
`;

// =====================
// Work Rotation Queries
// =====================

export const GET_WORK_ROTATIONS = gql`
  query GetWorkRotations(
    $filter: WorkRotationFilterInput
    $pagination: PaginationInput
  ) {
    workRotations(filter: $filter, pagination: $pagination) {
      items {
        ...WorkRotationFull
      }
      total
      limit
      offset
      hasMore
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const GET_WORK_ROTATION = gql`
  query GetWorkRotation($id: ID!) {
    workRotation(id: $id) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const GET_MY_ROTATIONS = gql`
  query GetMyRotations($filter: WorkRotationFilterInput) {
    myRotations(filter: $filter) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const GET_CURRENT_ROTATION = gql`
  query GetCurrentRotation($employeeId: ID!) {
    currentRotation(employeeId: $employeeId) {
      ...WorkRotationFull
      daysRemaining
      progressPercent
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const GET_UPCOMING_ROTATIONS = gql`
  query GetUpcomingRotations($employeeId: ID!, $limit: Int) {
    upcomingRotations(employeeId: $employeeId, limit: $limit) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const GET_ROTATION_CALENDAR = gql`
  query GetRotationCalendar(
    $workAreaId: ID
    $startDate: String!
    $endDate: String!
  ) {
    rotationCalendar(
      workAreaId: $workAreaId
      startDate: $startDate
      endDate: $endDate
    ) {
      id
      employeeId
      employeeName
      workAreaName
      rotationType
      startDate
      endDate
      status
      isOffshore
      daysOn
      daysOff
    }
  }
`;

// =====================
// Offshore Status Queries
// =====================

export const GET_CURRENTLY_OFFSHORE = gql`
  query GetCurrentlyOffshore($workAreaId: ID) {
    currentlyOffshore(workAreaId: $workAreaId) {
      employee {
        ...EmployeeBasic
      }
      workArea {
        id
        code
        name
        workAreaType
      }
      rotation {
        id
        startDate
        endDate
        daysOn
        daysOff
      }
      dayOnRotation
      totalDaysOnRotation
      estimatedReturnDate
      transportMethod
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_OFFSHORE_HEADCOUNT = gql`
  query GetOffshoreHeadcount {
    offshoreHeadcount {
      totalOffshore
      byWorkArea {
        workAreaId
        workAreaName
        count
        maxCapacity
      }
      byRotationType {
        rotationType
        count
      }
    }
  }
`;

export const GET_ROTATION_CHANGEOVERS = gql`
  query GetRotationChangeovers(
    $startDate: String!
    $endDate: String!
  ) {
    rotationChangeovers(startDate: $startDate, endDate: $endDate) {
      date
      goingOffshore {
        employeeId
        employeeName
        workAreaName
        transportMethod
        rotationId
      }
      returningOnshore {
        employeeId
        employeeName
        workAreaName
        transportMethod
        rotationId
      }
    }
  }
`;

// =====================
// Crew Assignment Queries
// =====================

export const GET_CREW_ASSIGNMENTS = gql`
  query GetCrewAssignments {
    crewAssignments {
      workAreaId
      workArea {
        id
        code
        name
        workAreaType
        isOffshore
        maxCapacity
      }
      assignedEmployees {
        ...EmployeeBasic
        personnelCategory
        seaWorthy
      }
      currentCount
      maxCapacity
      occupancyRate
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

export const GET_SEA_LAND_SPLIT = gql`
  query GetSeaLandSplit($departmentId: ID) {
    seaLandSplit(departmentId: $departmentId) {
      offshore {
        count
        employees {
          ...EmployeeBasic
          currentWorkArea
        }
      }
      onshore {
        count
        employees {
          ...EmployeeBasic
        }
      }
      inTransit {
        count
        employees {
          ...EmployeeBasic
          destination
        }
      }
      onLeave {
        count
        employees {
          ...EmployeeBasic
        }
      }
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
`;

// =====================
// Safety Training Queries
// =====================

export const GET_SAFETY_TRAINING_RECORDS = gql`
  query GetSafetyTrainingRecords(
    $employeeId: ID
    $workAreaId: ID
    $filter: SafetyTrainingFilterInput
  ) {
    safetyTrainingRecords(
      employeeId: $employeeId
      workAreaId: $workAreaId
      filter: $filter
    ) {
      id
      employeeId
      employee {
        id
        firstName
        lastName
      }
      workAreaId
      workArea {
        id
        code
        name
      }
      trainingType
      conductedBy
      conductedAt
      validUntil
      topics
      attendanceConfirmed
      notes
    }
  }
`;

export const GET_SAFETY_COMPLIANCE = gql`
  query GetSafetyCompliance($workAreaId: ID!) {
    safetyCompliance(workAreaId: $workAreaId) {
      workArea {
        id
        name
      }
      totalAssigned
      fullyCompliant
      partiallyCompliant
      nonCompliant
      complianceRate
      overdueSafetyTraining {
        employeeId
        employeeName
        trainingType
        daysOverdue
      }
    }
  }
`;

// =====================
// Work Area Mutations
// =====================

export const CREATE_WORK_AREA = gql`
  mutation CreateWorkArea($input: CreateWorkAreaInput!) {
    createWorkArea(input: $input) {
      ...WorkAreaFull
    }
  }
  ${WORK_AREA_FRAGMENT}
`;

export const UPDATE_WORK_AREA = gql`
  mutation UpdateWorkArea($input: UpdateWorkAreaInput!) {
    updateWorkArea(input: $input) {
      ...WorkAreaFull
    }
  }
  ${WORK_AREA_FRAGMENT}
`;

export const DEACTIVATE_WORK_AREA = gql`
  mutation DeactivateWorkArea($id: ID!) {
    deactivateWorkArea(id: $id) {
      id
      isActive
    }
  }
`;

// =====================
// Work Rotation Mutations
// =====================

export const CREATE_WORK_ROTATION = gql`
  mutation CreateWorkRotation($input: CreateWorkRotationInput!) {
    createWorkRotation(input: $input) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const UPDATE_WORK_ROTATION = gql`
  mutation UpdateWorkRotation($input: UpdateWorkRotationInput!) {
    updateWorkRotation(input: $input) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const START_ROTATION = gql`
  mutation StartRotation($rotationId: ID!, $actualStartDate: String) {
    startRotation(rotationId: $rotationId, actualStartDate: $actualStartDate) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const END_ROTATION = gql`
  mutation EndRotation($rotationId: ID!, $actualEndDate: String, $notes: String) {
    endRotation(
      rotationId: $rotationId
      actualEndDate: $actualEndDate
      notes: $notes
    ) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const CANCEL_ROTATION = gql`
  mutation CancelRotation($rotationId: ID!, $reason: String!) {
    cancelRotation(rotationId: $rotationId, reason: $reason) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const APPROVE_ROTATION = gql`
  mutation ApproveRotation($rotationId: ID!, $notes: String) {
    approveRotation(rotationId: $rotationId, notes: $notes) {
      ...WorkRotationFull
    }
  }
  ${WORK_ROTATION_FRAGMENT}
`;

export const BULK_CREATE_ROTATIONS = gql`
  mutation BulkCreateRotations($input: BulkRotationInput!) {
    bulkCreateRotations(input: $input) {
      created
      failed
      errors
      rotations {
        id
        employeeId
        workAreaId
        startDate
        endDate
      }
    }
  }
`;

// =====================
// Safety Training Mutations
// =====================

export const CREATE_SAFETY_TRAINING_RECORD = gql`
  mutation CreateSafetyTrainingRecord($input: CreateSafetyTrainingRecordInput!) {
    createSafetyTrainingRecord(input: $input) {
      id
      employeeId
      workAreaId
      trainingType
      conductedBy
      conductedAt
      validUntil
      topics
      attendanceConfirmed
    }
  }
`;

export const CONFIRM_SAFETY_TRAINING_ATTENDANCE = gql`
  mutation ConfirmSafetyTrainingAttendance($recordId: ID!) {
    confirmSafetyTrainingAttendance(recordId: $recordId) {
      id
      attendanceConfirmed
    }
  }
`;

export const BULK_CREATE_SAFETY_TRAINING = gql`
  mutation BulkCreateSafetyTraining($input: BulkSafetyTrainingInput!) {
    bulkCreateSafetyTraining(input: $input) {
      created
      failed
      errors
    }
  }
`;
