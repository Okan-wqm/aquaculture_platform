// ============================================================================
// VFD (variable-frequency drive) GraphQL operations — ORPHAN-MEDIUM-575
// ============================================================================
// The mobile client's FIRST documents against apps/sensor-service/src/vfd. The
// finding this closes said the drive surface did not exist; what was actually
// true is narrower and worth stating, because the wrong version sent people
// looking in the wrong place: the sensor subgraph has carried a rich VFD surface
// all along (devices, readings, bindings, commands, audit) and it is only THIS
// client that had no way to reach it. Nothing had to be built on the server.
//
// WHAT A FIELD WORKER GETS: which drives exist, what each one turns, whether it
// is running, whether it has faulted, and start/stop where their role allows it.
//
// TWO SHAPES, AND THE DIFFERENCE MATTERS:
//   • `vfdDevices` (the paginated fleet list) resolves to `VfdDeviceOutput`, a
//     projection with NO driveBinding, NO drivenUnit and NO latestReading. It
//     can say a drive exists and how it is configured; it cannot say what the
//     drive turns or whether the shaft is moving.
//   • `vfdDevice` / `vfdDevicesByTank` resolve to `VfdDevice`, which carries all
//     three as resolve-fields.
// So the fleet list is deliberately an INDEX, and every figure about what a
// drive is doing comes from one of the two full-shape queries. Rendering a run
// state on the index would mean inventing one.
//
// S1-CODEGEN: gql-tagged documents; codegen emits the TypedDocumentNode types
// from the composed supergraph, so a selection this client cannot have is a
// compile error rather than a runtime null.

import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { gql } from 'graphql-tag';

import type {
  MobileVfdFleetQuery,
  MobileVfdFleetQueryVariables,
  MobileVfdFleetSummaryQuery,
  MobileVfdFleetSummaryQueryVariables,
  MobileVfdDriveQuery,
  MobileVfdDriveQueryVariables,
  MobileUnitDrivesQuery,
  MobileUnitDrivesQueryVariables,
  MobileFeederSetupQuery,
  MobileFeederSetupQueryVariables,
  MobileStartVfdMutation,
  MobileStartVfdMutationVariables,
  MobileStopVfdMutation,
  MobileStopVfdMutationVariables,
} from '@/generated/graphql';

/**
 * Everything the mobile surfaces need about ONE drive, in the full `VfdDevice`
 * shape.
 *
 * `drivenUnit` is selected as the whole discriminated outcome rather than just
 * the derived `tankId`, because `tankId` is null for FOUR different reasons —
 * a pump serves no unit, the binding was never confirmed, the confirmation aged
 * out, or a feeder serves several units — and those call for four different
 * operator responses. Reading the nullable id alone would flatten them back into
 * the silence the server's union exists to prevent.
 *
 * `parameters` and `statusBits` arrive as the JSON scalar (the drive's decoded
 * register set is brand-shaped, so it has no fixed GraphQL type). They are read
 * through src/utils/vfd-drive.ts, which narrows each key it needs and returns
 * null for anything absent — never a zero.
 */
export const MOBILE_DRIVE_FIELDS = gql`
  fragment MobileDriveFields on VfdDevice {
    id
    name
    brand
    status
    location
    connectionStatus
    driveBinding {
      drivenEquipmentId
      state
      equipmentCategory
      equipmentCode
      equipmentName
      attestedAt
    }
    drivenUnit {
      outcome
      drivenEquipmentId
      equipmentCategory
      units {
        unitId
        unitCode
        unitType
        doseSharePercent
      }
    }
    latestReading {
      timestamp
      isValid
      errorMessage
      parameters
      statusBits
    }
  }
`;

/**
 * The drive index: fleet counts plus one page of drives.
 *
 * Both root fields ride in ONE document so the screen makes a single round trip
 * — the counts and the list are read together on the same screen and a second
 * request would let them disagree.
 */
export const MOBILE_VFD_FLEET: TypedDocumentNode<
  MobileVfdFleetQuery,
  MobileVfdFleetQueryVariables
> = gql`
  query MobileVfdFleet($pagination: VfdPaginationInput) {
    vfdStats {
      total
      active
      inactive
      faulted
      maintenance
    }
    vfdDevices(pagination: $pagination) {
      total
      page
      totalPages
      hasNextPage
      items {
        id
        name
        brand
        protocol
        status
        location
        connectionStatus {
          isConnected
          lastError
          lastSuccessAt
        }
      }
    }
  }
`;

/** Fleet counts on their own — the tablet board's strip needs the totals, not the page. */
export const MOBILE_VFD_FLEET_SUMMARY: TypedDocumentNode<
  MobileVfdFleetSummaryQuery,
  MobileVfdFleetSummaryQueryVariables
> = gql`
  query MobileVfdFleetSummary {
    vfdStats {
      total
      active
      inactive
      faulted
      maintenance
    }
  }
`;

/** One drive, in full — the detail screen's only read. */
export const MOBILE_VFD_DRIVE: TypedDocumentNode<
  MobileVfdDriveQuery,
  MobileVfdDriveQueryVariables
> = gql`
  query MobileVfdDrive($id: ID!) {
    vfdDevice(id: $id) {
      ...MobileDriveFields
    }
  }
  ${MOBILE_DRIVE_FIELDS}
`;

/**
 * The drives serving ONE unit, in full.
 *
 * This is the only query that answers "which drives feed this pen", and it
 * answers it through the attested binding rather than a hand-typed column: the
 * resolver walks VfdDriveBinding → the feeder's FeederAssignment, so a drive
 * appears here because the service that owns the equipment said so.
 */
export const MOBILE_UNIT_DRIVES: TypedDocumentNode<
  MobileUnitDrivesQuery,
  MobileUnitDrivesQueryVariables
> = gql`
  query MobileUnitDrives($tankId: ID!) {
    vfdDevicesByTank(tankId: $tankId) {
      ...MobileDriveFields
    }
  }
  ${MOBILE_DRIVE_FIELDS}
`;

/**
 * A feeder's setup, from farm-service — the machine's capability plus its
 * per-feed calibrations, fetched by the equipment id the drive binding names.
 *
 * `feederSetup` REPLACED the older `feederCalibrations` query and returns both
 * halves together, which is what makes them consistent: a calibration read
 * without the capability it belongs to cannot be interpreted (a grams-per-minute
 * figure means nothing without knowing the machine doses continuously).
 */
export const MOBILE_FEEDER_SETUP: TypedDocumentNode<
  MobileFeederSetupQuery,
  MobileFeederSetupQueryVariables
> = gql`
  query MobileFeederSetup($equipmentId: ID!) {
    feederSetup(equipmentId: $equipmentId) {
      capability {
        equipmentId
        dosingMode
        dispenseControl
        siloCapacityKg
        minSpeedHz
        maxSpeedHz
      }
      calibrations {
        id
        feedId
        dosingMode
        gramsPerDispensing
        gramsPerMinute
        referenceSpeedHz
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Commands. ONLINE ONLY — see src/pwa/actuation-commands.ts for the mechanism
// that makes queueing one a build failure rather than a rule to remember.
// ---------------------------------------------------------------------------
//
// The server refuses these outright for a drive that is unbound, unattested or
// stale (`VfdCommandService` → `assertActuable`), and that refusal arrives as a
// GraphQL error carrying the reason. A `success: false` result is the OTHER
// failure — the command reached the drive's gateway and the drive did not take
// it. src/hooks/useVfdCommand.ts keeps the two apart and shows both; neither is
// ever retried in the background, because a command nobody is watching is the
// thing this whole surface refuses to produce.
//
// `emergencyStopVfd` exists server-side and is open to every authenticated user.
// It is a distinct safety control with its own confirmation requirements and is
// NOT part of this surface; the two commands below are the ones the drive detail
// screen offers.

export const MOBILE_START_VFD: TypedDocumentNode<
  MobileStartVfdMutation,
  MobileStartVfdMutationVariables
> = gql`
  mutation MobileStartVfd($vfdDeviceId: ID!) {
    startVfd(vfdDeviceId: $vfdDeviceId) {
      success
      error
      acknowledgedAt
      commandSent
    }
  }
`;

export const MOBILE_STOP_VFD: TypedDocumentNode<
  MobileStopVfdMutation,
  MobileStopVfdMutationVariables
> = gql`
  mutation MobileStopVfd($vfdDeviceId: ID!) {
    stopVfd(vfdDeviceId: $vfdDeviceId) {
      success
      error
      acknowledgedAt
      commandSent
    }
  }
`;
