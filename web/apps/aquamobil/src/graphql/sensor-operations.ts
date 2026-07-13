// ============================================================================
// Sensor GraphQL Operations — MOB-MEDIUM-008 (live readings on tank screens)
// ============================================================================
// Field workers see the LIVE water values (temperature / DO / pH …) for the
// tank they are standing at, joined at the resolver level by the farm
// container UUID (`sensorRawList(tankId:)` filters on the indexed
// sensor.tank_id column — no client-side heuristics over free-form fields).
//
// S1-CODEGEN: gql-tagged documents; codegen emits TypedDocumentNode types.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';


import type {
  MobileTankSensorsQuery,
  MobileTankSensorsQueryVariables,
  MobileLatestReadingsBatchQuery,
  MobileLatestReadingsBatchQueryVariables,
} from '@/generated/graphql';

/** Sensors registered against a farm tank (container UUID). */
export const MOBILE_TANK_SENSORS: TypedDocumentNode<
  MobileTankSensorsQuery,
  MobileTankSensorsQueryVariables
> = gql`
  query MobileTankSensors($tankId: ID!) {
    sensorRawList(tankId: $tankId, limit: 50) {
      id
      name
      type
      status
      unit
      lastSeenAt
    }
  }
`;

/** Latest reading per sensor — one DISTINCT ON round-trip, not N+1. */
export const MOBILE_LATEST_READINGS_BATCH: TypedDocumentNode<
  MobileLatestReadingsBatchQuery,
  MobileLatestReadingsBatchQueryVariables
> = gql`
  query MobileLatestReadingsBatch($sensorIds: [ID!]!) {
    latestReadingsBatch(sensorIds: $sensorIds) {
      id
      sensorId
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
        nitrate
        turbidity
        waterLevel
      }
    }
  }
`;
