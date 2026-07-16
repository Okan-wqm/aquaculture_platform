/**
 * FeedingProtocolV2 GraphQL Operations (feeding-protocol SSoT — Faz 3)
 *
 * Birleşik yemleme protokolü (v2) CRUD + ünite atama operasyonları.
 * v1 `feedingProtocol.operations.ts` cutover'a (Faz 8) kadar yaşar; bu dosya
 * yeni ProtocolBuilderTab / AssignmentsTab yüzeylerinin tek kontratıdır.
 *
 * @module FarmModule/GraphQL
 */

/** Liste + detay için ortak protokol alan seti (jsonb alanlar tipli JSON döner). */
const FEEDING_PROTOCOL_V2_FIELDS = `
  id
  name
  description
  speciesId
  speciesName
  status
  bands
  temperatureAdjustments
  defaultMealSchedule
  fcrMatrix
  settings
  isDefault
  migrationNote
  createdAt
  updatedAt
  version
`;

const PROTOCOL_ASSIGNMENT_FIELDS = `
  id
  unitId
  unitType
  unitName
  unitCode
  siteId
  protocolId
  status
  effectiveFrom
  endedAt
  overrides
  suspensions
  currentFeedId
  currentBandIndex
  lastTransitionAt
  totalTransitions
  createdAt
  updatedAt
`;

export const FEEDING_PROTOCOLS_V2_QUERY = `
  query FeedingProtocolsV2(
    $status: FeedingProtocolStatus
    $speciesId: ID
    $pagination: StandardPaginationInput
  ) {
    feedingProtocolsV2(status: $status, speciesId: $speciesId, pagination: $pagination) {
      items {
        ${FEEDING_PROTOCOL_V2_FIELDS}
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

export const FEEDING_PROTOCOL_V2_QUERY = `
  query FeedingProtocolV2($id: ID!) {
    feedingProtocolV2(id: $id) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const PROTOCOL_ASSIGNMENTS_QUERY = `
  query ProtocolAssignments(
    $siteId: ID
    $unitId: ID
    $protocolId: ID
    $status: ProtocolAssignmentStatus
    $pagination: StandardPaginationInput
  ) {
    protocolAssignments(
      siteId: $siteId
      unitId: $unitId
      protocolId: $protocolId
      status: $status
      pagination: $pagination
    ) {
      items {
        ${PROTOCOL_ASSIGNMENT_FIELDS}
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

export const CREATE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation CreateFeedingProtocolV2($input: CreateFeedingProtocolV2Input!) {
    createFeedingProtocolV2(input: $input) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const UPDATE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation UpdateFeedingProtocolV2($input: UpdateFeedingProtocolV2Input!) {
    updateFeedingProtocolV2(input: $input) {
      ${FEEDING_PROTOCOL_V2_FIELDS}
    }
  }
`;

export const ARCHIVE_FEEDING_PROTOCOL_V2_MUTATION = `
  mutation ArchiveFeedingProtocolV2($id: ID!) {
    archiveFeedingProtocolV2(id: $id) {
      id
      status
    }
  }
`;

export const ASSIGN_PROTOCOL_TO_UNIT_MUTATION = `
  mutation AssignProtocolToUnit($input: AssignProtocolToUnitInput!) {
    assignProtocolToUnit(input: $input) {
      ${PROTOCOL_ASSIGNMENT_FIELDS}
    }
  }
`;

export const UPDATE_PROTOCOL_ASSIGNMENT_MUTATION = `
  mutation UpdateProtocolAssignment($input: UpdateProtocolAssignmentInput!) {
    updateProtocolAssignment(input: $input) {
      ${PROTOCOL_ASSIGNMENT_FIELDS}
    }
  }
`;

export const UNASSIGN_PROTOCOL_FROM_UNIT_MUTATION = `
  mutation UnassignProtocolFromUnit($assignmentId: ID!) {
    unassignProtocolFromUnit(assignmentId: $assignmentId) {
      id
      status
      endedAt
    }
  }
`;

/**
 * Ünitelerin etkin su sıcaklığı + kaynak provenansı (sensör ≤6s → manuel ≤24s
 * → none). AssignmentsTab sıcaklık rozetleri bu tek toplu sorguyu okur —
 * ünite başına istek YOK (K-11 toplu okuma disiplini).
 */
export const EFFECTIVE_UNIT_TEMPERATURES_QUERY = `
  query EffectiveUnitTemperatures($unitIds: [ID!]!) {
    effectiveUnitTemperatures(unitIds: $unitIds) {
      unitId
      celsius
      source
      measuredAt
      sensorId
    }
  }
`;
