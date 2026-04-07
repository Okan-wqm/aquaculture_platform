import { Logger } from '@nestjs/common';
import { BypassRlsService } from './bypass-rls.service';
import {
  requestContextStorage,
  getRequestContext,
} from '../../logging/request-context';

/**
 * bypass-rls.service.spec.ts
 * ============================================================================
 *
 * Audit-critical test suite. BypassRlsService is the only legitimate way
 * to suspend tenant isolation for SUPER_ADMIN endpoints and background
 * workers. A bug in the scoping or the audit log is a privilege-
 * escalation vector.
 *
 * These tests cover:
 *   1. AsyncLocalStorage scoping — the bypass MUST be confined to the
 *      callback's async call tree and MUST restore the previous context
 *      on exit (success OR throw).
 *   2. Audit logging — every grant MUST emit a WARN line, and the
 *      operation label is MANDATORY (empty label → throw).
 *   3. Re-entrance — nested withBypass() calls must short-circuit
 *      (return the inner callback result directly) without double-
 *      logging or double-scoping.
 *   4. Exception safety — a throw inside the callback must NOT leave
 *      the bypass flag set on the enclosing context.
 */

describe('BypassRlsService', () => {
  let service: BypassRlsService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new BypassRlsService();
    // Intercept Logger.warn at the prototype level so we don't depend on
    // the service exposing its logger. This pattern is robust against
    // internal refactors of the service.
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('withBypass — audit label requirement', () => {
    it('refuses an empty operation label', async () => {
      await expect(
        service.withBypass('', async () => 'result'),
      ).rejects.toThrow(/requires a non-empty operation label/);
    });

    it('refuses a missing/undefined operation label', async () => {
      await expect(
        service.withBypass(undefined as unknown as string, async () => 'result'),
      ).rejects.toThrow(/requires a non-empty operation label/);
    });
  });

  describe('withBypass — AsyncLocalStorage scoping', () => {
    it('sets bypassRls=true inside the callback and clears after', async () => {
      // Pre-condition: no bypass flag set
      expect(getRequestContext().bypassRls).toBeUndefined();

      let flagDuringCallback: boolean | undefined;

      const result = await service.withBypass(
        'test:scope-check',
        async () => {
          flagDuringCallback = getRequestContext().bypassRls;
          return 'ok';
        },
      );

      expect(result).toBe('ok');
      expect(flagDuringCallback).toBe(true);
      // Post-condition: flag MUST be cleared (AsyncLocalStorage frame
      // unwound). If this assertion ever fails, the bypass leaked into
      // the enclosing execution context — a security bug.
      expect(getRequestContext().bypassRls).toBeUndefined();
    });

    it('preserves existing request context fields alongside bypassRls', async () => {
      const tenantId = '00000000-0000-4000-8000-000000000001';

      // Establish an outer context that carries tenantId + userId, then
      // verify those fields survive inside the bypass frame.
      await requestContextStorage.run(
        { tenantId, userId: 'user-123' },
        async () => {
          let capturedTenant: string | undefined;
          let capturedUser: string | undefined;
          let capturedBypass: boolean | undefined;

          await service.withBypass('test:merge', async () => {
            const ctx = getRequestContext();
            capturedTenant = ctx.tenantId;
            capturedUser = ctx.userId;
            capturedBypass = ctx.bypassRls;
          });

          expect(capturedTenant).toBe(tenantId);
          expect(capturedUser).toBe('user-123');
          expect(capturedBypass).toBe(true);
        },
      );
    });

    it('restores the exact previous context on exception', async () => {
      const outerContext = { tenantId: 'outer', userId: 'outer-user' };

      await requestContextStorage.run(outerContext, async () => {
        // Pre-condition: no bypass
        expect(getRequestContext().bypassRls).toBeUndefined();

        await expect(
          service.withBypass('test:throws', async () => {
            expect(getRequestContext().bypassRls).toBe(true);
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        // Post-condition: bypass flag CLEARED, other fields INTACT.
        // This is the safety guarantee — a crash inside the callback
        // cannot leave the enclosing request with elevated privileges.
        const ctx = getRequestContext();
        expect(ctx.bypassRls).toBeUndefined();
        expect(ctx.tenantId).toBe('outer');
        expect(ctx.userId).toBe('outer-user');
      });
    });
  });

  describe('withBypass — audit logging', () => {
    it('emits grant + release WARN logs with the operation label', async () => {
      await service.withBypass('admin-api:list-tenants', async () => 'done');

      const labels = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(labels.some((m) => m.includes('RLS BYPASS GRANTED'))).toBe(true);
      expect(labels.some((m) => m.includes('RLS BYPASS RELEASED'))).toBe(true);
      expect(labels.some((m) => m.includes('[admin-api:list-tenants]'))).toBe(
        true,
      );
    });

    it('emits the release log even when the callback throws', async () => {
      await expect(
        service.withBypass('admin-api:throws', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const labels = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        labels.some((m) =>
          m.includes('RLS BYPASS RELEASED [admin-api:throws]'),
        ),
      ).toBe(true);
    });
  });

  describe('withBypass — re-entrance', () => {
    it('short-circuits when already inside a bypass frame', async () => {
      let innerRan = false;

      await service.withBypass('outer', async () => {
        // Reset the warn spy after the outer grant so we can measure the
        // inner call's logging behaviour in isolation.
        warnSpy.mockClear();

        const result = await service.withBypass('inner', async () => {
          innerRan = true;
          // The bypass flag remains true (inherited from outer frame)
          expect(getRequestContext().bypassRls).toBe(true);
          return 'inner-result';
        });

        expect(result).toBe('inner-result');
      });

      expect(innerRan).toBe(true);

      // Inner call should NOT have fired a grant/release pair — the
      // outer frame is already in bypass mode. Double-logging would
      // pollute audit trails with nested noise.
      const innerLogs = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(innerLogs.some((m) => m.includes('[inner]'))).toBe(false);
    });

    it('returns the inner callback value unchanged during short-circuit', async () => {
      const result = await service.withBypass('outer', async () => {
        return service.withBypass('inner', async () => ({ nested: 'value' }));
      });

      expect(result).toEqual({ nested: 'value' });
    });
  });

  describe('withBypassSync', () => {
    it('scopes the bypass flag to the synchronous callback only', () => {
      expect(getRequestContext().bypassRls).toBeUndefined();

      const result = service.withBypassSync('cron:boot-check', () => {
        expect(getRequestContext().bypassRls).toBe(true);
        return 42;
      });

      expect(result).toBe(42);
      expect(getRequestContext().bypassRls).toBeUndefined();
    });

    it('refuses an empty operation label', () => {
      expect(() => service.withBypassSync('', () => 0)).toThrow(
        /requires a non-empty operation label/,
      );
    });

    it('restores previous context on synchronous throw', () => {
      requestContextStorage.run({ tenantId: 'outer' }, () => {
        expect(() =>
          service.withBypassSync('test:throws', () => {
            throw new Error('sync boom');
          }),
        ).toThrow('sync boom');

        const ctx = getRequestContext();
        expect(ctx.bypassRls).toBeUndefined();
        expect(ctx.tenantId).toBe('outer');
      });
    });
  });
});
