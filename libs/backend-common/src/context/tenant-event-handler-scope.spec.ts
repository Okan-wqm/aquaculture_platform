import type { IEvent } from '@platform/event-bus';

import { getRequestContext } from '../logging/request-context';

import { TenantEventHandlerScope } from './tenant-event-handler-scope';

/**
 * PLAT-HIGH-936 — the scope a tenant-scoped service binds on the event bus:
 * the event's tenant is the session's tenant for as long as its handler runs.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function event(tenantId: unknown): IEvent {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'TaskOverdue',
    timestamp: '2026-10-27T12:00:00.000Z',
    tenantId: tenantId as string,
    version: 2,
  };
}

describe('TenantEventHandlerScope', () => {
  const scope = new TenantEventHandlerScope();

  it('binds the event tenant (and its schema) for the duration of the work', async () => {
    const seen = await scope.run(event(TENANT), () => {
      const context = getRequestContext();
      return Promise.resolve({ tenantId: context.tenantId, schemaName: context.schemaName });
    });

    expect(seen.tenantId).toBe(TENANT);
    expect(seen.schemaName).toMatch(/^tenant_[0-9a-f]{16}$/);
  });

  it('never grants RLS bypass: the event tenant is the only tenant the work can see', async () => {
    const bypass = await scope.run(event(TENANT), () =>
      Promise.resolve(getRequestContext().bypassRls),
    );

    expect(bypass).toBeFalsy();
  });

  it('keeps two concurrent events apart', async () => {
    const [first, second] = await Promise.all([
      scope.run(event(TENANT), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestContext().tenantId;
      }),
      scope.run(event(OTHER), () => Promise.resolve(getRequestContext().tenantId)),
    ]);

    expect(first).toBe(TENANT);
    expect(second).toBe(OTHER);
  });

  it('leaves no tenant bound once the work is done', async () => {
    await scope.run(event(TENANT), () => Promise.resolve());

    expect(getRequestContext().tenantId).toBeUndefined();
  });

  it('propagates the work result and its failure unchanged', async () => {
    await expect(scope.run(event(TENANT), () => Promise.resolve(42))).resolves.toBe(42);
    await expect(scope.run(event(TENANT), () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
  });

  it.each([undefined, '', 'not-a-uuid', 7])(
    'runs the work unscoped when the event carries no valid tenant (%p): the handler terminates it itself',
    async (tenantId) => {
      const seen = await scope.run(event(tenantId), () =>
        Promise.resolve(getRequestContext().tenantId),
      );

      expect(seen).toBeUndefined();
    },
  );
});
