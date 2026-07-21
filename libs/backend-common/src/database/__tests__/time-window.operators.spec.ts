import { withinLast, olderThan } from '../time-window.operators';

/**
 * APA-319: the helpers must encode the predicate DIRECTION. `withinLast` is a
 * recency window (`moreThanOrEqual now-ms`); `olderThan` is a retention window
 * (`lessThan now-ms`). These assertions pin the operator type so a future
 * inversion of either helper fails RED.
 */
describe('time-window FindOperator helpers (APA-319)', () => {
  const HOUR_MS = 60 * 60 * 1000;

  describe('withinLast', () => {
    it('yields a moreThanOrEqual operator (recency, not retention)', () => {
      const op = withinLast(HOUR_MS);
      expect(op.type).toBe('moreThanOrEqual');
    });

    it('anchors the boundary at now - windowMs', () => {
      const before = Date.now();
      const op = withinLast(HOUR_MS);
      const after = Date.now();
      const boundary = op.value.getTime();
      expect(boundary).toBeGreaterThanOrEqual(before - HOUR_MS);
      expect(boundary).toBeLessThanOrEqual(after - HOUR_MS);
    });
  });

  describe('olderThan', () => {
    it('yields a lessThan operator (retention/staleness, not recency)', () => {
      const op = olderThan(HOUR_MS);
      expect(op.type).toBe('lessThan');
    });

    it('anchors the boundary at now - windowMs', () => {
      const before = Date.now();
      const op = olderThan(HOUR_MS);
      const after = Date.now();
      const boundary = op.value.getTime();
      expect(boundary).toBeGreaterThanOrEqual(before - HOUR_MS);
      expect(boundary).toBeLessThanOrEqual(after - HOUR_MS);
    });
  });

  it('the two helpers are mirror opposites for the same window', () => {
    expect(withinLast(HOUR_MS).type).toBe('moreThanOrEqual');
    expect(olderThan(HOUR_MS).type).toBe('lessThan');
  });
});
