/**
 * BackdatePolicyService Unit Tests
 *
 * Exercises every decision branch: future-date rejection, beyond-limit
 * rejection, per-context default resolution, per-call override, env
 * var override, invalid-input rejection.
 *
 * Uses a minimal in-memory ConfigService double rather than importing
 * the real NestJS ConfigService infra — the service only reads values,
 * so a plain object with a `get()` signature suffices.
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackdatePolicyService } from '../backdate-policy.service';

/**
 * Minimal ConfigService test double. The service only consumes .get(key)
 * and we never hit the other methods — implementing just the one gives
 * us a fully-typed double with no `any`.
 */
class StubConfigService {
  constructor(private readonly values: Record<string, string>) {}
  get<T = string>(key: string): T | undefined {
    const raw = this.values[key];
    return raw === undefined ? undefined : (raw as unknown as T);
  }
}

function mkService(env: Record<string, string> = {}): BackdatePolicyService {
  const stub = new StubConfigService(env);
  return new BackdatePolicyService(stub as unknown as ConfigService);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysAhead(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

describe('BackdatePolicyService', () => {
  describe('getLimitForContext', () => {
    it('returns the built-in default when no env var is set', () => {
      const service = mkService();
      expect(service.getLimitForContext('feeding')).toBe(7);
      expect(service.getLimitForContext('mortality')).toBe(14);
      expect(service.getLimitForContext('growth')).toBe(30);
      expect(service.getLimitForContext('harvest')).toBe(7);
    });

    it('prefers env var over default', () => {
      const service = mkService({ FEEDING_BACKDATE_LIMIT_DAYS: '21' });
      expect(service.getLimitForContext('feeding')).toBe(21);
    });

    it('prefers per-call override over env var', () => {
      const service = mkService({ FEEDING_BACKDATE_LIMIT_DAYS: '21' });
      expect(service.getLimitForContext('feeding', 3)).toBe(3);
    });

    it('ignores non-numeric env var and falls back to default', () => {
      const service = mkService({ FEEDING_BACKDATE_LIMIT_DAYS: 'abc' });
      expect(service.getLimitForContext('feeding')).toBe(7);
    });

    it('ignores negative env var and falls back to default', () => {
      const service = mkService({ FEEDING_BACKDATE_LIMIT_DAYS: '-5' });
      // Negative is a valid Number but non-numeric-safe check gates it via >=0.
      // Current impl accepts >=0, so -5 is rejected and default returned.
      expect(service.getLimitForContext('feeding')).toBe(7);
    });
  });

  describe('validate', () => {
    it('accepts a recent proposedDate and returns backdatedDays=0 for today', () => {
      const service = mkService();
      const decision = service.validate({
        context: 'feeding',
        proposedDate: new Date(),
      });
      expect(decision.backdatedDays).toBe(0);
      expect(decision.isBackdated).toBe(false);
      expect(decision.limitDays).toBe(7);
    });

    it('accepts proposedDate within the context limit', () => {
      const service = mkService();
      const decision = service.validate({
        context: 'growth',
        proposedDate: daysAgo(25),
      });
      expect(decision.backdatedDays).toBe(25);
      expect(decision.isBackdated).toBe(true);
      expect(decision.limitDays).toBe(30);
    });

    it('rejects proposedDate beyond the default context limit', () => {
      const service = mkService();
      expect(() =>
        service.validate({
          context: 'feeding',
          proposedDate: daysAgo(8),
        }),
      ).toThrow(BadRequestException);
    });

    it('respects env-driven extended limit', () => {
      const service = mkService({ FEEDING_BACKDATE_LIMIT_DAYS: '30' });
      const decision = service.validate({
        context: 'feeding',
        proposedDate: daysAgo(20),
      });
      expect(decision.isBackdated).toBe(true);
      expect(decision.limitDays).toBe(30);
    });

    it('rejects future proposedDate beyond the 60-second skew window', () => {
      const service = mkService();
      expect(() =>
        service.validate({
          context: 'feeding',
          proposedDate: daysAhead(1),
        }),
      ).toThrow(BadRequestException);
    });

    it('accepts proposedDate within the 60-second clock skew tolerance', () => {
      const service = mkService();
      const nearFuture = new Date(Date.now() + 30_000); // +30 s
      const decision = service.validate({
        context: 'feeding',
        proposedDate: nearFuture,
      });
      expect(decision.isBackdated).toBe(false);
    });

    it('rejects invalid Date inputs', () => {
      const service = mkService();
      expect(() =>
        service.validate({
          context: 'feeding',
          proposedDate: new Date('not-a-real-date'),
        }),
      ).toThrow(BadRequestException);
    });

    it('includes the subject label in the error message for operator clarity', () => {
      const service = mkService();
      expect.assertions(1);
      try {
        service.validate({
          context: 'mortality',
          proposedDate: daysAgo(90),
          subjectLabel: 'batch abc-123',
        });
      } catch (err) {
        expect((err as Error).message).toContain('batch abc-123');
      }
    });
  });
});
