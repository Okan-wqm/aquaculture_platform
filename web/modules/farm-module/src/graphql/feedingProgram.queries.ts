/**
 * Feeding Program GraphQL Queries
 *
 * Yemleme programi sorgu operasyonlari.
 * Tank bazli yemleme programi yonetimi icin GraphQL query'leri.
 *
 * @module FarmModule/GraphQL
 */

import { gql } from 'graphql-tag';

// ============================================================================
// FRAGMENTS
// ============================================================================

export const FEEDING_PROGRAM_BASIC_FRAGMENT = gql`
  fragment FeedingProgramBasic on FeedingProgram {
    id
    tenantId
    name
    code
    description
    status
    startDate
    endDate
    totalTanks
    totalFeedTransitions
    totalFeedConsumed
    createdBy
    createdAt
    updatedAt
  }
`;

export const FEEDING_PROGRAM_FULL_FRAGMENT = gql`
  fragment FeedingProgramFull on FeedingProgram {
    ...FeedingProgramBasic
    feedAssignments
    fcrTable
    settings
    lastModifiedBy
  }
  ${FEEDING_PROGRAM_BASIC_FRAGMENT}
`;

export const FEEDING_PROGRAM_TANK_FRAGMENT = gql`
  fragment FeedingProgramTankFull on FeedingProgramTank {
    id
    tenantId
    feedingProgramId
    equipmentId
    equipmentType
    equipmentName
    equipmentCode
    currentFeedId
    currentFeedCode
    currentWeightRangeIndex
    lastFeedTransitionAt
    totalFeedTransitions
    temperatureSensorId
    temperatureSensorCode
    isActive
    addedAt
    removedAt
    notes
    createdAt
    updatedAt
  }
`;

export const DAILY_FEEDING_EXECUTION_FRAGMENT = gql`
  fragment DailyFeedingExecutionFull on DailyFeedingExecution {
    id
    tenantId
    feedingProgramId
    feedingProgramTankId
    executionDate
    equipmentId
    equipmentType
    equipmentName
    equipmentCode
    calculations
    actualResults
    status
    completedAt
    completedBy
    notes
    skipReason
    plannedFeedKg
    actualFeedKg
    varianceKg
    variancePercent
    hasTransitionWarning
    feedTransitioned
    createdAt
    updatedAt
  }
`;

// ============================================================================
// QUERIES
// ============================================================================

// NOTE: FEEDING_PROGRAMS_QUERY, TODAYS_FEEDING_PLAN_QUERY and
// ACTIVE_FEEDING_PROGRAMS_QUERY were deleted under FARM-MEDIUM-116 —
// defined but referenced nowhere (frozen in
// dead-contract-fe-operations.baseline.json). Re-adding one requires an
// actual call site or the dead-contract gate fails.

/**
 * Tek bir yemleme programini getir
 * Tum detaylari ve bagli tanklari ile birlikte
 */
export const FEEDING_PROGRAM_QUERY = gql`
  query FeedingProgram($id: ID!) {
    feedingProgram(id: $id) {
      ...FeedingProgramFull
      tanks {
        ...FeedingProgramTankFull
      }
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Gunluk yemleme calistirmalarini listele
 * Belirli bir tarih icin
 *
 * SCHEMA-CONTRACT: Backend returns flat array, no pagination. Date is required.
 */
export const DAILY_FEEDING_EXECUTIONS_QUERY = gql`
  query DailyFeedingExecutions($date: DateTime!, $siteId: ID) {
    dailyFeedingExecutions(date: $date, siteId: $siteId) {
      ...DailyFeedingExecutionFull
      feedingProgram {
        id
        name
        code
      }
      feedingProgramTank {
        id
        equipmentName
        equipmentCode
        currentFeedCode
      }
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;
