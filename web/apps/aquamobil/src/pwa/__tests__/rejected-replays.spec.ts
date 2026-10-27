/**
 * Offline replays the server rejected are listed for re-entry (PKG-42; ADR-051 C6).
 *
 * A queued write recorded offline and replayed after the worker's access changed — a revoked
 * module grant answers FORBIDDEN from R4 — or after a release changed the contract
 * (GRAPHQL_VALIDATION_FAILED, BAD_USER_INPUT) will never succeed on retry. The queue already
 * stops retrying it (graphql-replay-error.ts); what the worker lacked was what they had entered,
 * and why it was refused, so they can enter it again where it still belongs. Every code in
 * PERMANENT_GRAPHQL_ERROR_CODES counts, not only FORBIDDEN.
 */
import { en } from '@aquaculture/shared-ui/i18n';
import { describe, expect, it } from 'vitest';

import { PERMANENT_GRAPHQL_ERROR_CODES } from '../graphql-replay-error';
import { isRejectedReplay, recordedValues, rejectedReplayReason } from '../rejected-replays';

describe('isRejectedReplay', () => {
  it.each(PERMANENT_GRAPHQL_ERROR_CODES)('lists a replay the server rejected with %s', (code) => {
    expect(isRejectedReplay({ status: 'failed', lastErrorCode: code })).toBe(true);
  });

  it('does not list a replay that failed on a transient code (it will be retried)', () => {
    expect(isRejectedReplay({ status: 'failed', lastErrorCode: 'INTERNAL_SERVER_ERROR' })).toBe(
      false,
    );
  });

  it('does not list a transport failure, which carries no code', () => {
    expect(isRejectedReplay({ status: 'failed', lastErrorCode: undefined })).toBe(false);
  });

  it('does not list an operation that is still pending or syncing', () => {
    expect(isRejectedReplay({ status: 'pending', lastErrorCode: 'FORBIDDEN' })).toBe(false);
    expect(isRejectedReplay({ status: 'syncing', lastErrorCode: 'FORBIDDEN' })).toBe(false);
  });
});

describe('rejectedReplayReason', () => {
  it('names a reason in the message catalogue for every permanent code', () => {
    for (const code of PERMANENT_GRAPHQL_ERROR_CODES) {
      expect(en[rejectedReplayReason(code)]).toEqual(expect.any(String));
    }
  });

  it('tells a refused caller apart from an entry the server did not accept', () => {
    expect(rejectedReplayReason('FORBIDDEN')).not.toBe(rejectedReplayReason('BAD_USER_INPUT'));
    expect(rejectedReplayReason('GRAPHQL_VALIDATION_FAILED')).not.toBe(
      rejectedReplayReason('FORBIDDEN'),
    );
  });
});

describe('recordedValues', () => {
  it('lists what the worker entered, without the command envelope the queue stamped on it', () => {
    expect(
      recordedValues({
        batchId: 'batch-7',
        count: 12,
        observedAt: '2026-10-27T06:30:00.000Z',
        clientCommandId: 'cmd-1',
        clientCreatedAt: '2026-10-27T06:31:00.000Z',
        deviceId: 'device-1',
        operationType: 'recordMortality',
        payloadHash: 'abc',
        schemaVersion: 'mobile-command-v1',
      }),
    ).toEqual([
      { field: 'batchId', value: 'batch-7' },
      { field: 'count', value: '12' },
      { field: 'observedAt', value: '2026-10-27T06:30:00.000Z' },
    ]);
  });

  it('flattens nested inputs and lists, and leaves out empty fields', () => {
    expect(
      recordedValues({
        id: 'message-1',
        input: {
          content: 'tank 3 aerator restarted',
          attachmentKeys: ['a.jpg', 'b.jpg'],
          parentId: null,
        },
        notes: undefined,
        acknowledged: false,
      }),
    ).toEqual([
      { field: 'id', value: 'message-1' },
      { field: 'input.content', value: 'tank 3 aerator restarted' },
      { field: 'input.attachmentKeys', value: 'a.jpg, b.jpg' },
      { field: 'acknowledged', value: 'false' },
    ]);
  });
});
