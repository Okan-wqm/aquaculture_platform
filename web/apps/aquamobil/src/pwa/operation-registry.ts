/**
 * @module operation-registry
 * @description React-free single source of truth for queued-operation replay:
 * the GraphQL mutation document per {@link OperationType}, the variable shaping
 * each document expects, and the createLeaveRequest → submitLeaveRequest chain.
 *
 * MOB-MEDIUM-002: these definitions used to live inside the React
 * OfflineProvider (useOfflineQueue.tsx). The service worker's injectManifest
 * sub-build cannot import a React module, which is the structural reason the
 * SW's "background sync" handler could not replay anything and only pinged open
 * windows. Extracting the registry into a dependency-free module lets BOTH
 * drain lanes — the foreground provider and the SW replay (sw-replay.ts) —
 * execute the exact same contract, so they cannot drift apart.
 *
 * Zero imports beyond types by design: this file must bundle cleanly into the
 * SW sub-build (tsconfig.sw.json: ES2020 + WebWorker libs, no DOM, no React).
 */

import type { OperationPayload, OperationType } from '@/types';

/**
 * GraphQL mutations for sync — tenantId/userId are extracted from the JWT by
 * backend decorators, never sent as variables.
 *
 * MSG-MEDIUM-055: 'uploadAndSendMessage' is excluded — it is NOT a single
 * GraphQL mutation. Its 3-step presign → PUT → send replay is handled by
 * replayUploadAndSendMessage in useOfflineQueue.tsx (foreground only) and is
 * listed in {@link SW_REPLAY_SKIP_TYPES} for the SW lane. Excluding it keeps
 * this record exhaustive over the single-mutation op types only.
 */
export const OPERATION_MUTATIONS: Record<
  Exclude<OperationType, 'uploadAndSendMessage'> | 'submitLeaveRequest',
  string
> = {
  recordMortality: `
    mutation RecordMortality($input: RecordMortalityInput!) {
      recordMortality(input: $input) {
        id
        currentQuantity
        totalMortality
      }
    }
  `,
  recordCull: `
    mutation RecordCull($input: RecordCullInput!) {
      recordCull(input: $input) {
        id
        currentQuantity
        cullCount
      }
    }
  `,
  createHarvestRecord: `
    mutation CreateHarvestRecord($input: CreateHarvestRecordInput!) {
      createHarvestRecord(input: $input) {
        id
        recordCode
        quantityHarvested
      }
    }
  `,
  recordFeeding: `
    mutation RecordDailyFeeding($input: RecordDailyFeedingInput!) {
      recordDailyFeeding(input: $input) {
        id
        actualFeedKg
        status
      }
    }
  `,
  clockIn: `
    mutation ClockIn($input: ClockInInput!) {
      clockIn(input: $input) {
        id
        date
        clockIn
        status
        workedMinutes
        remarks
      }
    }
  `,
  clockOut: `
    mutation ClockOut($input: ClockOutInput!) {
      clockOut(input: $input) {
        id
        date
        clockOut
        status
        workedMinutes
      }
    }
  `,
  createLeaveRequest: `
    mutation CreateLeaveRequest($input: CreateLeaveRequestInput!) {
      createLeaveRequest(input: $input) {
        id
        startDate
        endDate
        totalDays
        status
      }
    }
  `,
  submitLeaveRequest: `
    mutation SubmitLeaveRequest($id: ID!) {
      submitLeaveRequest(id: $id) {
        id
        status
      }
    }
  `,
  // FARM-HIGH-057: task lifecycle mutations take a single TaskLifecycleInput that
  // carries the task id PLUS the at-most-once command envelope. The server rejects
  // an envelope-less call, so the queued payload (envelope already stamped on
  // enqueue) is sent verbatim under `input`.
  completeTask: `
    mutation CompleteTask($input: TaskLifecycleInput!) {
      completeTask(input: $input) {
        id
        status
        completedAt
        completedBy
      }
    }
  `,
  startTask: `
    mutation StartTask($input: TaskLifecycleInput!) {
      startTask(input: $input) {
        id
        status
      }
    }
  `,
  // FARM-HIGH-057: idempotent checklist SET — the queued payload carries the
  // ABSOLUTE target isCompleted (taskId/itemId/isCompleted) plus the envelope, so
  // a replay after reconnect converges instead of reverting the item.
  setChecklistItem: `
    mutation SetChecklistItem($input: SetChecklistItemInput!) {
      setChecklistItem(input: $input) {
        id
        checklistItems
      }
    }
  `,
  recordTransfer: `
    mutation RecordTransfer($input: TransferBatchInput!) {
      transferBatch(input: $input) {
        id
      }
    }
  `,
  createWaterQuality: `
    mutation CreateWaterQualityMeasurement($input: CreateWaterQualityInput!) {
      createWaterQualityMeasurement(input: $input) {
        id
        overallStatus
        hasAlarm
      }
    }
  `,
  recordStockMovement: `
    mutation RecordStockMovement($input: RecordStockMovementInput!) {
      recordStockMovement(input: $input) {
        id
        movementType
        quantity
      }
    }
  `,
  transferStock: `
    mutation TransferStock($input: TransferStockInput!) {
      transferStock(input: $input) {
        id
        quantity
      }
    }
  `,
  // FARM-HIGH-214: regulatory field capture. The queued payload carries the
  // command envelope stamped on enqueue; the backend inputs extend
  // MobileCommandEnvelopeInput so it rides under `input` verbatim. Lice counts
  // are naturally idempotent (upsert per tank/date); welfare + escape dedup
  // through the farm_mobile_command_receipts ledger on replay.
  recordLiceCount: `
    mutation RecordLiceCount($input: RecordLiceCountInput!) {
      recordLiceCount(input: $input) {
        id
        reportingYear
        reportingWeek
      }
    }
  `,
  recordWelfareAssessment: `
    mutation RecordWelfareAssessment($input: RecordWelfareAssessmentInput!) {
      recordWelfareAssessment(input: $input) {
        id
        assessedAt
      }
    }
  `,
  recordEscapeIncident: `
    mutation RecordEscapeIncident($input: RecordEscapeIncidentInput!) {
      recordEscapeIncident(input: $input) {
        id
        status
      }
    }
  `,
  // MOB-HIGH-006: offline-capable alarm acknowledgement. AcknowledgeAlertInput
  // extends MobileCommandEnvelopeInput on the backend, so the enveloped payload
  // rides under `input` verbatim; the ack is naturally idempotent on replay.
  acknowledgeAlert: `
    mutation MobileAcknowledgeAlertQueued($input: AcknowledgeAlertInput!) {
      acknowledgeAlert(input: $input) {
        id
        acknowledged
        acknowledgedAt
      }
    }
  `,
  // Messaging mutations — ADR-012
  sendMessage: `
    mutation SendMessage($input: SendMessageInput!) {
      sendMessage(input: $input) {
        id
        channelId
        content
        contentType
        createdAt
      }
    }
  `,
  editMessage: `
    mutation EditMessage($id: ID!, $input: EditMessageInput!) {
      editMessage(id: $id, input: $input) {
        id
        content
        editedAt
      }
    }
  `,
  deleteMessage: `
    mutation DeleteMessage($id: ID!) {
      deleteMessage(id: $id)
    }
  `,
  markMessagesRead: `
    mutation MarkMessagesRead($input: MarkReadInput!) {
      markMessagesRead(input: $input)
    }
  `,
};

/**
 * Operation types the SW replay lane must leave untouched in the queue.
 * MSG-MEDIUM-055: the blob lane's presign → PUT → send sequence needs the
 * binary store + media plumbing that only the foreground app runs; the SW
 * skips these so they drain on the next foreground, with retryCount unchanged.
 */
export const SW_REPLAY_SKIP_TYPES: readonly OperationType[] = ['uploadAndSendMessage'];

/**
 * Shape a queued payload into the mutation document's variables.
 *
 * deleteMessage uses a flat { id } variable (no envelope: messaging deletes are
 * not at-most-once-enveloped here). editMessage uses { id, input: {...} } — the
 * payload splits into id + nested input. Everything else rides verbatim under
 * `input` (FARM-HIGH-057: including task lifecycle + checklist ops, whose
 * TaskLifecycleInput carries the id inside the enveloped payload).
 */
export function buildOperationVariables(
  type: Exclude<OperationType, 'uploadAndSendMessage'>,
  payload: OperationPayload,
): Record<string, unknown> {
  if (type === 'editMessage') {
    const { id, content, ...rest } = payload as unknown as Record<string, unknown>;
    return { id, input: { content, ...rest } };
  }
  if (type === 'deleteMessage') {
    return payload as unknown as Record<string, unknown>;
  }
  return { input: payload };
}

/**
 * The createLeaveRequest replay is a two-step chain: the created draft must be
 * submitted in the same drain pass (the mobile UX promises "requested", not
 * "drafted"). Given the first call's response data, return the follow-up
 * operation — or null when the type has no chain. A missing created id is a
 * contract violation and throws so the op is marked failed (visible in Sync
 * Status) instead of silently half-applying.
 */
export function getLeaveSubmitFollowUp(
  type: OperationType,
  resultData: unknown,
): { query: string; variables: Record<string, unknown> } | null {
  if (type !== 'createLeaveRequest') return null;
  const created = resultData as { createLeaveRequest?: { id?: string } } | undefined | null;
  const createdId = created?.createLeaveRequest?.id;
  if (!createdId) {
    throw new Error('Leave request was created without an id');
  }
  return { query: OPERATION_MUTATIONS.submitLeaveRequest, variables: { id: createdId } };
}
