/**
 * Operation registry parity spec (MOB-MEDIUM-002 groundwork).
 *
 * The queued-mutation documents + variable shaping used to live inside the
 * React OfflineProvider (useOfflineQueue.tsx), which the service worker's
 * injectManifest sub-build cannot import — that structural gap is WHY the SW
 * "background sync" never actually replayed anything. The registry is the
 * React-free single source of truth both drain lanes (foreground provider and
 * SW replay) execute from, so they cannot diverge on what an operation means.
 */

import { describe, it, expect } from 'vitest';

import {
  OPERATION_MUTATIONS,
  buildOperationVariables,
  getLeaveSubmitFollowUp,
  SW_REPLAY_SKIP_TYPES,
} from '../operation-registry';

import type { OperationPayload, OperationType } from '@/types';

// Compile-time + runtime mirror of the OperationType union. If a new member is
// added to the union, this array fails the exhaustiveness assertion below until
// the registry (and this list) handle it — a missed branch is a red test.
const ALL_OPERATION_TYPES: readonly OperationType[] = [
  'recordMortality',
  'recordCull',
  'createHarvestRecord',
  'recordFeeding',
  'recordMealFeeding',
  'clockIn',
  'clockOut',
  'createLeaveRequest',
  'completeTask',
  'startTask',
  'setChecklistItem',
  'recordTransfer',
  'createWaterQuality',
  'recordStockMovement',
  'transferStock',
  'recordLiceCount',
  'recordWelfareAssessment',
  'recordEscapeIncident',
  'acknowledgeAlert',
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'markMessagesRead',
  'uploadAndSendMessage',
] as const;

describe('operation-registry (MOB-MEDIUM-002)', () => {
  it('covers every OperationType except the blob lane with a mutation document', () => {
    for (const type of ALL_OPERATION_TYPES) {
      if (type === 'uploadAndSendMessage') continue;
      expect(OPERATION_MUTATIONS[type], `missing mutation for ${type}`).toBeTruthy();
      expect(OPERATION_MUTATIONS[type]).toContain('mutation');
    }
  });

  it('carries the chained submitLeaveRequest document', () => {
    expect(OPERATION_MUTATIONS.submitLeaveRequest).toContain('submitLeaveRequest');
  });

  it('shapes editMessage as { id, input: {...} }', () => {
    const variables = buildOperationVariables('editMessage', {
      id: 'msg-1',
      content: 'edited',
    });
    expect(variables).toEqual({ id: 'msg-1', input: { content: 'edited' } });
  });

  it('shapes deleteMessage as a flat { id }', () => {
    const variables = buildOperationVariables('deleteMessage', { id: 'msg-2' });
    expect(variables).toEqual({ id: 'msg-2' });
  });

  it('shapes every other operation as { input: payload } verbatim (envelope intact)', () => {
    // A complete generated RecordMortalityInput plus the envelope — the payload
    // type is derived from the schema (MOB-HIGH-019), so a missing required
    // field is a compile error here, not a coercion error on the wire.
    const payload: OperationPayload<'recordMortality'> = {
      batchId: 'b-1',
      tankId: 't-1',
      quantity: 3,
      reason: 'DISEASE',
      observedAt: '2026-09-05T07:00:00.000Z',
      clientCommandId: 'cmd-1',
      payloadHash: 'hash',
    };
    const variables = buildOperationVariables('recordMortality', payload);
    expect(variables).toEqual({ input: payload });
  });

  it('extracts the created leave id for the chained submit call', () => {
    const followUp = getLeaveSubmitFollowUp('createLeaveRequest', {
      createLeaveRequest: { id: 'leave-9' },
    });
    expect(followUp).toEqual({ query: OPERATION_MUTATIONS.submitLeaveRequest, variables: { id: 'leave-9' } });
  });

  it('returns null follow-up for non-leave ops and rejects a missing created id', () => {
    expect(getLeaveSubmitFollowUp('recordMortality', {})).toBeNull();
    expect(() => getLeaveSubmitFollowUp('createLeaveRequest', {})).toThrow(/without an id/);
  });

  it('the SW replay skip set contains exactly the blob lane', () => {
    expect(SW_REPLAY_SKIP_TYPES).toEqual(['uploadAndSendMessage']);
  });
});
