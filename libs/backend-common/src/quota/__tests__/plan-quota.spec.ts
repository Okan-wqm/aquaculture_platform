import { assertWithinQuota, PlanLimitExceededError } from '../plan-quota';

describe('assertWithinQuota (SSOT-C-13)', () => {
  it('allows a create strictly under the limit', () => {
    expect(() => assertWithinQuota('sensors', 4, 5)).not.toThrow();
    expect(() => assertWithinQuota('farms', 0, 1)).not.toThrow();
  });

  it('rejects fail-closed once current >= limit (at the limit, no one more)', () => {
    expect(() => assertWithinQuota('sensors', 5, 5)).toThrow(PlanLimitExceededError);
    expect(() => assertWithinQuota('ponds', 31, 30)).toThrow(PlanLimitExceededError);
  });

  it('treats -1 as unlimited and never throws', () => {
    expect(() => assertWithinQuota('sensors', 1_000_000, -1)).not.toThrow();
  });

  it('carries a structured 403 payload for client upgrade prompts', () => {
    try {
      assertWithinQuota('sensors', 20, 20);
      throw new Error('expected PlanLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(PlanLimitExceededError);
      const e = err as PlanLimitExceededError;
      expect(e.getStatus()).toBe(403);
      expect(e.resource).toBe('sensors');
      expect(e.limit).toBe(20);
      expect(e.current).toBe(20);
      const body = e.getResponse() as Record<string, unknown>;
      expect(body['errorCode']).toBe('BILLING_PLAN_LIMIT_EXCEEDED');
      expect(body['resource']).toBe('sensors');
    }
  });
});
