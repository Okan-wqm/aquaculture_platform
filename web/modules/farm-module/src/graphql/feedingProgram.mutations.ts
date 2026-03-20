/**
 * Feeding Program GraphQL Mutations
 *
 * Yemleme programi mutasyon operasyonlari.
 * Program olusturma, guncelleme, tank ekleme ve gunluk yemleme kaydi.
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

/**
 * Yemleme programini aktif et
 * Gunluk plan olusturmaya baslar
 */
export const ACTIVATE_FEEDING_PROGRAM = gql`
  mutation ActivateFeedingProgram($id: ID!) {
    activateFeedingProgram(id: $id) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yemleme programini duraklat
 * Gunluk plan olusturmayi durdurur
 */
export const PAUSE_FEEDING_PROGRAM = gql`
  mutation PauseFeedingProgram($id: ID!, $reason: String) {
    pauseFeedingProgram(id: $id, reason: $reason) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yemleme programini tamamla
 * Program artik duzenlenemez
 */
export const COMPLETE_FEEDING_PROGRAM = gql`
  mutation CompleteFeedingProgram($id: ID!, $notes: String) {
    completeFeedingProgram(id: $id, notes: $notes) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yemleme programini iptal et
 */
export const CANCEL_FEEDING_PROGRAM = gql`
  mutation CancelFeedingProgram($id: ID!, $reason: String!) {
    cancelFeedingProgram(id: $id, reason: $reason) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

// ============================================================================
// TANK MUTATIONS
// ============================================================================

/**
 * Programa tank ekle
 * Tank/pond/cage programa dahil edilir
 */
export const ADD_TANK_TO_PROGRAM = gql`
  mutation AddTankToProgram($input: AddTankToProgramInput!) {
    addTankToProgram(input: $input) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Programa birden fazla tank ekle
 */
export const ADD_TANKS_TO_PROGRAM = gql`
  mutation AddTanksToProgram(
    $feedingProgramId: ID!
    $tanks: [AddTankInput!]!
  ) {
    addTanksToProgram(feedingProgramId: $feedingProgramId, tanks: $tanks) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Programdan tank cikar
 * Tank programdan kaldirilir (soft delete)
 */
export const REMOVE_TANK_FROM_PROGRAM = gql`
  mutation RemoveTankFromProgram($feedingProgramTankId: ID!, $reason: String) {
    removeTankFromProgram(
      feedingProgramTankId: $feedingProgramTankId
      reason: $reason
    ) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Tank'i programa tekrar dahil et
 */
export const REACTIVATE_TANK_IN_PROGRAM = gql`
  mutation ReactivateTankInProgram($feedingProgramTankId: ID!) {
    reactivateTankInProgram(feedingProgramTankId: $feedingProgramTankId) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Tank'a sicaklik sensoru bagla
 */
export const ASSIGN_TEMPERATURE_SENSOR = gql`
  mutation AssignTemperatureSensor(
    $feedingProgramTankId: ID!
    $sensorId: ID!
    $sensorCode: String
  ) {
    assignTemperatureSensor(
      feedingProgramTankId: $feedingProgramTankId
      sensorId: $sensorId
      sensorCode: $sensorCode
    ) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

/**
 * Tank'in yem gecisini manuel yap
 */
export const TRANSITION_TANK_FEED = gql`
  mutation TransitionTankFeed(
    $feedingProgramTankId: ID!
    $newFeedId: ID!
    $newFeedCode: String!
    $rangeIndex: Int!
    $notes: String
  ) {
    transitionTankFeed(
      feedingProgramTankId: $feedingProgramTankId
      newFeedId: $newFeedId
      newFeedCode: $newFeedCode
      rangeIndex: $rangeIndex
      notes: $notes
    ) {
      ...FeedingProgramTankFull
    }
  }
  ${FEEDING_PROGRAM_TANK_FRAGMENT}
`;

// ============================================================================
// DAILY PLAN MUTATIONS
// ============================================================================

/**
 * Gunluk yemleme plani olustur
 * Belirli bir tarih icin tum aktif tanklar icin plan olusturur
 */
export const GENERATE_DAILY_PLAN = gql`
  mutation GenerateDailyPlan($input: GenerateDailyPlanInput!) {
    generateDailyPlan(input: $input) {
      date
      generatedCount
      executions {
        ...DailyFeedingExecutionFull
      }
      warnings
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

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

/**
 * Gunluk yemlemeyi atla
 * Belirli bir gun icin yemleme atlanir
 *
 * SCHEMA-CONTRACT: Backend takes SkipDailyFeedingInput object, field name is skipReason (not reason)
 */
export const SKIP_DAILY_FEEDING = gql`
  mutation SkipDailyFeeding($input: SkipDailyFeedingInput!) {
    skipDailyFeeding(input: $input) {
      ...DailyFeedingExecutionFull
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

/**
 * Toplu yemleme kaydi
 * Birden fazla tank icin ayni anda kayit yapar
 */
export const RECORD_BULK_FEEDING = gql`
  mutation RecordBulkFeeding($inputs: [RecordDailyFeedingInput!]!) {
    recordBulkFeeding(inputs: $inputs) {
      successful {
        ...DailyFeedingExecutionFull
      }
      failed {
        executionId
        error
      }
      totalSuccessful
      totalFailed
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

/**
 * Gunluk plani yeniden hesapla
 * Biomass veya sicaklik degisikliklerinde kullanilir
 *
 * SCHEMA-CONTRACT: Returns plain DailyFeedingExecution. No previousCalculations/changeReason fields.
 */
export const RECALCULATE_DAILY_PLAN = gql`
  mutation RecalculateDailyPlan($executionId: ID!, $newParameters: RecalculateParametersInput) {
    recalculateDailyPlan(executionId: $executionId, newParameters: $newParameters) {
      ...DailyFeedingExecutionFull
    }
  }
  ${DAILY_FEEDING_EXECUTION_FRAGMENT}
`;

// ============================================================================
// FEED ASSIGNMENT MUTATIONS
// ============================================================================

/**
 * Programa yem atamasi ekle
 */
export const ADD_FEED_ASSIGNMENT = gql`
  mutation AddFeedAssignment(
    $feedingProgramId: ID!
    $assignment: FeedAssignmentInput!
  ) {
    addFeedAssignment(
      feedingProgramId: $feedingProgramId
      assignment: $assignment
    ) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yem atamasini guncelle
 */
export const UPDATE_FEED_ASSIGNMENT = gql`
  mutation UpdateFeedAssignment(
    $feedingProgramId: ID!
    $feedId: ID!
    $assignment: FeedAssignmentInput!
  ) {
    updateFeedAssignment(
      feedingProgramId: $feedingProgramId
      feedId: $feedId
      assignment: $assignment
    ) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Yem atamasini kaldir
 */
export const REMOVE_FEED_ASSIGNMENT = gql`
  mutation RemoveFeedAssignment($feedingProgramId: ID!, $feedId: ID!) {
    removeFeedAssignment(feedingProgramId: $feedingProgramId, feedId: $feedId) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * FCR tablosunu guncelle
 */
export const UPDATE_FCR_TABLE = gql`
  mutation UpdateFCRTable($feedingProgramId: ID!, $fcrTable: FCRTableInput!) {
    updateFCRTable(feedingProgramId: $feedingProgramId, fcrTable: $fcrTable) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

// ============================================================================
// UTILITY MUTATIONS
// ============================================================================

/**
 * Programi kopyala (sablondan yeni program olustur)
 *
 * SCHEMA-CONTRACT: Backend declares startDate as plain string, not Date/DateTime
 */
export const CLONE_FEEDING_PROGRAM = gql`
  mutation CloneFeedingProgram(
    $sourceId: ID!
    $newName: String!
    $newCode: String!
    $startDate: String!
  ) {
    cloneFeedingProgram(
      sourceId: $sourceId
      newName: $newName
      newCode: $newCode
      startDate: $startDate
    ) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;

/**
 * Program ayarlarini guncelle
 */
export const UPDATE_PROGRAM_SETTINGS = gql`
  mutation UpdateProgramSettings(
    $feedingProgramId: ID!
    $settings: ProgramSettingsInput!
  ) {
    updateProgramSettings(
      feedingProgramId: $feedingProgramId
      settings: $settings
    ) {
      ...FeedingProgramFull
    }
  }
  ${FEEDING_PROGRAM_FULL_FRAGMENT}
`;
