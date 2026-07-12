/**
 * AuditService — strict vs best-effort tool-execution audit (DB-PEOPLE-MEDIUM-003).
 *
 * Read-only tool audits are best-effort (a broken write must not break the chat
 * flow → swallow). Actuation-class tool audits are safety-load-bearing and pass
 * strict=true → the write failure re-throws so the executor can surface it.
 */
import { AuditService } from '../audit.service';
import type { ToolExecutionContext, ToolResult } from '../../tools/core/tool.interface';

const ctx: ToolExecutionContext = {
  tenantId: 't1',
  schemaName: 'tenant_t1',
  userId: 'u1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator-v1',
  actuationPolicy: 'allowed',
};

const result: ToolResult = { success: true, data: { ok: true }, durationMs: 3, cacheable: false };

function makeService(save: jest.Mock) {
  const repo = { create: jest.fn((x: unknown) => x), save };
  return new AuditService(repo as never);
}

describe('AuditService — audit durability mode', () => {
  it('swallows a write failure in best-effort (non-strict) mode', async () => {
    const service = makeService(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(
      service.logToolExecution('read_ph', {}, result, ctx),
    ).resolves.toBeUndefined();
  });

  it('re-throws a write failure in strict mode (actuation)', async () => {
    const service = makeService(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(
      service.logToolExecution('dose_reagent', {}, result, ctx, undefined, true),
    ).rejects.toThrow(/db down/);
  });

  it('persists normally when the write succeeds (strict)', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const service = makeService(save);
    await service.logToolExecution('dose_reagent', {}, result, ctx, undefined, true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
