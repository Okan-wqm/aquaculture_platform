import { ACTIVE_OWNER_MODULE_CODES, deriveServiceGrants } from '@aquaculture/shared-contracts';

import {
  MODULE_ACTIVITY_QUERY_ACCESS,
  MODULE_ACTIVITY_QUERY_SUBJECTS,
  RECENT_WRITER_QUERY_LIMITS,
  admitRecentWriterIdsRequest,
  isRecentWriterIdsReply,
  isRecentWriterIdsRequest,
  recentWriterIdsRequest,
} from '../module-activity-queries';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER_A = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';

function uuidOf(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

const wellFormed = {
  caller: { kind: 'service', service: 'auth_service' },
  tenantId: TENANT,
  userIds: [USER_A, USER_B],
  windowDays: 90,
} as const;

/**
 * PKG-06 readiness (ADR-051 §3, Plan amendments): auth asks each owner module how many of the
 * members it names wrote to the module recently. The subjects are service subjects born
 * requiring the sender's ServiceCaller (C5: no older caller exists), the guards read exact keys,
 * and the reply carries a count, never ids.
 */
describe('module activity queries (request.{farm,hr,sensor}.recentWriterIds)', () => {
  it('names one subject per active owner module, under that module', () => {
    expect(MODULE_ACTIVITY_QUERY_SUBJECTS).toEqual({
      farm: 'request.farm.recentWriterIds',
      hr: 'request.hr.recentWriterIds',
      sensor: 'request.sensor.recentWriterIds',
    });
    expect(Object.keys(MODULE_ACTIVITY_QUERY_SUBJECTS).sort()).toEqual(
      [...ACTIVE_OWNER_MODULE_CODES].sort(),
    );
  });

  it('declares each subject a read-only service subject that only auth_service sends', () => {
    for (const subject of Object.values(MODULE_ACTIVITY_QUERY_SUBJECTS)) {
      expect(MODULE_ACTIVITY_QUERY_ACCESS[subject]).toEqual({
        caller: 'service',
        intent: 'read',
        senders: ['auth_service'],
      });
    }
    expect(deriveServiceGrants(MODULE_ACTIVITY_QUERY_ACCESS)).toEqual({
      auth_service: {
        'request.farm.recentWriterIds': 'read',
        'request.hr.recentWriterIds': 'read',
        'request.sensor.recentWriterIds': 'read',
      },
    });
  });

  it("builds the request in auth_service's own name", () => {
    expect(recentWriterIdsRequest(TENANT, [USER_A], 90)).toEqual({
      caller: { kind: 'service', service: 'auth_service' },
      tenantId: TENANT,
      userIds: [USER_A],
      windowDays: 90,
    });
  });

  describe('isRecentWriterIdsRequest', () => {
    it('accepts exactly the request shape', () => {
      expect(isRecentWriterIdsRequest(wellFormed)).toBe(true);
      expect(isRecentWriterIdsRequest({ ...wellFormed, windowDays: 1 })).toBe(true);
    });

    it.each([
      ['an extra key', { ...wellFormed, extra: 1 }],
      ['no caller', { tenantId: TENANT, userIds: [USER_A], windowDays: 90 }],
      ['a member-shaped caller', { ...wellFormed, caller: { kind: 'user', userId: USER_A } }],
      ['an unknown service', { ...wellFormed, caller: { kind: 'service', service: 'mallory' } }],
      [
        'a caller with an extra key',
        { ...wellFormed, caller: { kind: 'service', service: 'auth_service', as: 'farm' } },
      ],
      ['a tenant that is no uuid', { ...wellFormed, tenantId: 'tenant-1' }],
      ['no user ids', { ...wellFormed, userIds: [] }],
      ['a user id that is no uuid', { ...wellFormed, userIds: ['user-1'] }],
      ['a repeated user id', { ...wellFormed, userIds: [USER_A, USER_A] }],
      [
        'more user ids than the cap',
        {
          ...wellFormed,
          userIds: Array.from({ length: RECENT_WRITER_QUERY_LIMITS.MAX_USER_IDS + 1 }, (_, i) =>
            uuidOf(i),
          ),
        },
      ],
      ['a zero window', { ...wellFormed, windowDays: 0 }],
      ['a window past the cap', { ...wellFormed, windowDays: 91 }],
      ['a fractional window', { ...wellFormed, windowDays: 1.5 }],
      ['an array', [wellFormed]],
    ])('refuses %s', (_label, value) => {
      expect(isRecentWriterIdsRequest(value)).toBe(false);
    });

    it('takes the cap itself', () => {
      const userIds = Array.from({ length: RECENT_WRITER_QUERY_LIMITS.MAX_USER_IDS }, (_, i) =>
        uuidOf(i),
      );
      expect(isRecentWriterIdsRequest({ ...wellFormed, userIds })).toBe(true);
    });
  });

  describe('admitRecentWriterIdsRequest (the responder chokepoint)', () => {
    it('admits a well-formed request from a declared sender', () => {
      expect(admitRecentWriterIdsRequest('farm', wellFormed)).toEqual({
        admitted: true,
        request: wellFormed,
      });
    });

    it('answers a malformed request INVALID_REQUEST', () => {
      expect(admitRecentWriterIdsRequest('hr', { ...wellFormed, windowDays: 365 })).toEqual({
        admitted: false,
        reply: { ok: false, error: 'INVALID_REQUEST' },
      });
    });

    it('answers a service that is no declared sender FORBIDDEN', () => {
      expect(
        admitRecentWriterIdsRequest('sensor', {
          ...wellFormed,
          caller: { kind: 'service', service: 'farm_service' },
        }),
      ).toEqual({ admitted: false, reply: { ok: false, error: 'FORBIDDEN' } });
    });
  });

  describe('isRecentWriterIdsReply', () => {
    it('accepts a count and the three error codes', () => {
      expect(isRecentWriterIdsReply({ ok: true, data: { recentWriterCount: 0 } })).toBe(true);
      expect(isRecentWriterIdsReply({ ok: true, data: { recentWriterCount: 12 } })).toBe(true);
      for (const error of ['INVALID_REQUEST', 'FORBIDDEN', 'INTERNAL_ERROR']) {
        expect(isRecentWriterIdsReply({ ok: false, error })).toBe(true);
      }
    });

    it.each([
      ['a negative count', { ok: true, data: { recentWriterCount: -1 } }],
      ['a fractional count', { ok: true, data: { recentWriterCount: 1.5 } }],
      ['ids beside the count', { ok: true, data: { recentWriterCount: 1, userIds: [USER_A] } }],
      ['no data', { ok: true }],
      ['an unknown error', { ok: false, error: 'NOPE' }],
      ['a string', 'ok'],
    ])('refuses %s', (_label, value) => {
      expect(isRecentWriterIdsReply(value)).toBe(false);
    });
  });
});
