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

/**
 * Yemleme programlarini listele
 * Filter destekli (pagination yok)
 *
 * SCHEMA-CONTRACT: Backend returns unpaginated [FeedingProgram]. Filter-only.
 * MED-06: List query uses FeedingProgramBasic to avoid over-fetching sensitive
 * feedAssignments / fcrTable / settings JSON blobs. Use FEEDING_PROGRAM_QUERY
 * (single-item) when the full detail view is needed.
 */
export const FEEDING_PROGRAMS_QUERY = gql`
  query FeedingPrograms($filter: FeedingProgramFilterInput) {
    feedingPrograms(filter: $filter) {
      ...FeedingProgramBasic
      tanks {
        ...FeedingProgramTankFull
      }
    }
  }
  ${FEEDING_PROGRAM_BASIC_FRAGMENT}
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

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

/**
 * Bugunun yemleme planini getir
 * Tum tanklar icin planlanan ve gerceklesen verilerle
 *
 * SCHEMA-CONTRACT: Backend returns flat [DailyFeedingExecution], not a wrapper type.
 * Summary stats (completedTanks, totalPlannedKg, etc.) computed client-side from execution data.
 */
export const TODAYS_FEEDING_PLAN_QUERY = gql`
  query TodaysFeedingPlan($programId: ID!) {
    todaysFeedingPlan(programId: $programId) {
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

/**
 * Program istatistiklerini getir
 *
 * DEAD-CODE: Backend resolver feedingProgramStats does NOT exist yet.
 * This query is pre-defined for a planned analytics feature. Do NOT call until backend implements it.
 */
export const FEEDING_PROGRAM_STATS_QUERY = gql`
  query FeedingProgramStats($programId: ID!, $startDate: DateTime, $endDate: DateTime) {
    feedingProgramStats(
      programId: $programId
      startDate: $startDate
      endDate: $endDate
    ) {
      programId
      programName
      dateRange {
        start
        end
      }
      totalFeedingDays
      totalFeedConsumedKg
      avgDailyFeedKg
      totalBiomassGrowthKg
      avgFCR
      feedTransitions
      completionRate
      varianceStats {
        avgVariancePercent
        daysUnderPlan
        daysOverPlan
      }
      byTank {
        tankId
        tankName
        feedConsumedKg
        avgFCR
        transitions
      }
      byFeed {
        feedId
        feedCode
        feedName
        totalKg
        daysUsed
      }
    }
  }
`;

/**
 * Program takvimini getir (ay bazli)
 *
 * DEAD-CODE: Backend resolver feedingProgramCalendar does NOT exist yet.
 * This query is pre-defined for a planned calendar feature. Do NOT call until backend implements it.
 */
export const FEEDING_PROGRAM_CALENDAR_QUERY = gql`
  query FeedingProgramCalendar($programId: ID!, $year: Int!, $month: Int!) {
    feedingProgramCalendar(programId: $programId, year: $year, month: $month) {
      programId
      year
      month
      days {
        date
        status
        totalPlannedKg
        totalActualKg
        completedTanks
        totalTanks
        hasWarnings
      }
    }
  }
`;

/**
 * Aktif programlari getir (dashboard icin)
 *
 * SCHEMA-CONTRACT: Backend returns [FeedingProgram], no todaysSummary sub-field.
 * Optional siteId filter available.
 */
export const ACTIVE_FEEDING_PROGRAMS_QUERY = gql`
  query ActiveFeedingPrograms($siteId: ID) {
    activeFeedingPrograms(siteId: $siteId) {
      ...FeedingProgramBasic
      tanks {
        id
        equipmentName
        equipmentCode
        currentFeedCode
        isActive
      }
    }
  }
  ${FEEDING_PROGRAM_BASIC_FRAGMENT}
`;

/**
 * Tank icin uygun programlari getir
 *
 * DEAD-CODE: Backend resolver availableProgramsForTank does NOT exist yet.
 * This query is pre-defined for a planned tank-program assignment feature.
 * Do NOT call until backend implements it.
 */
export const AVAILABLE_PROGRAMS_FOR_TANK_QUERY = gql`
  query AvailableProgramsForTank($equipmentId: ID!) {
    availableProgramsForTank(equipmentId: $equipmentId) {
      id
      name
      code
      status
      startDate
      endDate
      feedAssignments
    }
  }
`;
