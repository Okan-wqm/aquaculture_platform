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
  query GetWorkAreas(
    $workAreaType: WorkAreaType
    $isOffshore: Boolean
    $isActive: Boolean
    $page: Int
    $limit: Int
  ) {
    workAreas(
      workAreaType: $workAreaType
      isOffshore: $isOffshore
      isActive: $isActive
      page: $page
      limit: $limit
    ) {
      items {
        ...WorkAreaFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
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
    $employeeId: ID
    $workAreaId: ID
    $status: RotationStatus
    $startDate: String
    $endDate: String
    $page: Int
    $limit: Int
  ) {
    workRotations(
      employeeId: $employeeId
      workAreaId: $workAreaId
      status: $status
      startDate: $startDate
      endDate: $endDate
      page: $page
      limit: $limit
    ) {
      items {
        ...WorkRotationFull
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
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

// WHY: Backend myWorkRotations resolver accepts (limit: Int, page: Int), not offset.
export const GET_MY_ROTATIONS = gql`
  query GetMyRotations($status: RotationStatus, $limit: Int, $page: Int) {
    myWorkRotations(status: $status, limit: $limit, page: $page) {
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
      ...EmployeeBasic
      personnelCategory
      seaWorthy
      currentRotationId
      farmId
    }
  }
  ${EMPLOYEE_BASIC_FRAGMENT}
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

// WHY: Backend CrewAssignment DTO only exposes flat scalar fields
// (workAreaId, workAreaName, assignedEmployeeIds, currentCount, maxCapacity, occupancyRate).
// Requesting nested `workArea { ... }` or `assignedEmployees { ... }` objects that do not exist
// in the backend schema causes GraphQL validation 400 errors.
// Query only the fields the backend actually provides.
export const GET_CREW_ASSIGNMENTS = gql`
  query GetCrewAssignments {
    crewAssignments {
      workAreaId
      workAreaName
      assignedEmployeeIds
      currentCount
      maxCapacity
      occupancyRate
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
