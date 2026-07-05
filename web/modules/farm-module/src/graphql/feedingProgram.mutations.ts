/**
 * Feeding Program GraphQL Mutations
 *
 * Yemleme programi mutasyon operasyonlari.
 * Program olusturma, guncelleme ve gunluk yemleme kaydi.
 *
 * NOTE: 20 orphaned mutations (activate/pause/complete/cancel, tank
 * add/remove/reactivate, sensor assignment, feed transitions, daily-plan
 * generate/skip/bulk/recalculate, feed-assignment CRUD, FCR table, clone,
 * settings) were deleted under FARM-MEDIUM-116 — they were defined here
 * but referenced nowhere (frozen in dead-contract-fe-operations.baseline.json).
 * Re-adding one requires an actual call site or the dead-contract gate fails.
 *
 * @module FarmModule/GraphQL
 */

import { gql } from 'graphql-tag';
import {
  FEEDING_PROGRAM_FULL_FRAGMENT,
  FEEDING_PROGRAM_TANK_FRAGMENT,
  DAILY_FEEDING_EXECUTION_FRAGMENT,
} from './feedingProgram.queries';

// ============================================================================
// PROGRAM MUTATIONS
// ============================================================================

/**
 * Yeni yemleme programi olustur
 * Yem atamalari ve FCR tablosu ile birlikte
 */
export const CREATE_FEEDING_PROGRAM = gql`
  mutation CreateFeedingProgram($input: CreateFeedingProgramInput!) {
    createFeedingProgram(input: $input) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yemleme programini guncelle
 * Taslak veya duraklatilmis programlar icin
 */
export const UPDATE_FEEDING_PROGRAM = gql`
  mutation UpdateFeedingProgram($id: ID!, $input: UpdateFeedingProgramInput!) {
    updateFeedingProgram(id: $id, input: $input) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

// ============================================================================
// DAILY PLAN MUTATIONS
// ============================================================================

/**
 * Gunluk yemlemeyi kaydet
 * Gerceklesen yem miktari ve sonuclari kaydeder
 */
export const RECORD_DAILY_FEEDING = gql`
  mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
    recordDailyFeeding(input: $input) {
      ...DailyFeedingExecutionFull
      feedingProgramTank {
        ...FeedingProgramTankFull
      }
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;
