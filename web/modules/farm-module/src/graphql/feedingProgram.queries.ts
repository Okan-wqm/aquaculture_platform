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
 * Filter ve pagination destekli
 */
export const FEEDING_PROGRAMS_QUERY = gql`
  query FeedingPrograms(
    $filter: FeedingProgramFilterInput
    $pagination: PaginationInput
  ) {
    feedingPrograms(filter: $filter, pagination: $pagination) {
      items {
        ...FeedingProgramFull
        tanks {
          ...FeedingProgramTankFull
        }
      }
      total
      page
      limit
      hasMore
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
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
 * Belirli bir tarih veya tarih araligi icin
 */
export const DAILY_FEEDING_EXECUTIONS_QUERY = gql`
  query DailyFeedingExecutions(
    $filter: DailyFeedingExecutionFilterInput
    $pagination: PaginationInput
  ) {
    dailyFeedingExecutions(filter: $filter, pagination: $pagination) {
      items {
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
      total
      page
      limit
      hasMore
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

/**
 * Bugunun yemleme planini getir
 * Tum tanklar icin planlanan ve gerceklesen verilerle
 */
export const TODAYS_FEEDING_PLAN_QUERY = gql`
  query TodaysFeedingPlan(
    $date: Date
    $feedingProgramId: ID
    $equipmentId: ID
  ) {
    todaysFeedingPlan(
      date: $date
      feedingProgramId: $feedingProgramId
      equipmentId: $equipmentId
    ) {
      date
      executions {
        ...DailyFeedingExecutionFull
        feedingProgram {
          id
          name
          code
          settings
        }
        feedingProgramTank {
          id
          equipmentName
          equipmentCode
          currentFeedId
          currentFeedCode
          temperatureSensorId
        }
      }
      summary {
        totalTanks
        completedTanks
        pendingTanks
        skippedTanks
        totalPlannedFeedKg
        totalActualFeedKg
        completionPercent
        transitionWarnings
      }
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

/**
 * Program istatistiklerini getir
 */
export const FEEDING_PROGRAM_STATS_QUERY = gql`
  query FeedingProgramStats($programId: ID!, $startDate: Date, $endDate: Date) {
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
 */
export const ACTIVE_FEEDING_PROGRAMS_QUERY = gql`
  query ActiveFeedingPrograms {
    activeFeedingPrograms {
      ...FeedingProgramBasic
      tanks {
        id
        equipmentName
        equipmentCode
        currentFeedCode
        isActive
      }
      todaysSummary {
        completedTanks
        totalTanks
        totalPlannedKg
        totalActualKg
      }
    }
  }
  ${FEEDING_PROGRAM_BASIC_FRAGMENT}
`;

/**
 * Tank icin uygun programlari getir
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
