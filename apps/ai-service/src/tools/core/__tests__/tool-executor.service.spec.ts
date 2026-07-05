import 'reflect-metadata';
import { ToolExecutorService } from '../tool-executor.service';
import {
  ActuationPolicy,
  ITool,
  ToolExecutionContext,
  ToolMetadata,
  ToolResult,
} from '../tool.interface';

/**
 * AISAFETY-MEDIUM-017: actuation fail-closed enforcement + real audit persistence.
 *
 * The executor previously (a) logged "requires confirmation" and executed the
 * tool anyway, and (b) never wrote to the audit table (a TODO). These specs pin
 * that an actuation tool runs autonomously ONLY under 'allowed', and that every
 * outcome — success, denial, held-for-confirmation — is persisted via AuditService.
 */
describe('ToolExecutorService (AISAFETY-MEDIUM-017)', () => {
  const execute = jest.fn();
  const logToolExecution = jest.fn().mockResolvedValue(undefined);

  const makeTool = (over: Partial<ToolMetadata>): ITool => {
    const metadata: ToolMetadata = {
      name: 'dose_reagent',
      description: 'Dose a reagent',
      category: 'actuation',
      runtime: 'cloud',
      requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
      inputSchema: { type: 'object' },
      requiresModule: null,
      requiresConfirmation: true,
      ...over,
    };
    return {
      getMetadata: () => metadata,
      validate: jest.fn(),
      execute,
    };
  };

  const registry = { getTool: jest.fn() };
  const service = new ToolExecutorService(
    registry as never,
    { logToolExecution } as never,
  );

  const ctx = (policy: ActuationPolicy): ToolExecutionContext => ({
    tenantId: 't1',
    schemaName: 'tenant_t1',
    userId: 'u1',
    userRoles: ['operator'],
    correlationId: 'corr-1',
    persona: 'operator-v1',
    actuationPolicy: policy,
  });

  const okResult: ToolResult = {
    success: true,
    data: { done: true },
    durationMs: 5,
    cacheable: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue(okResult);
  });

  it("does NOT execute an actuation tool under 'confirm_required' (held for confirmation)", async () => {
    registry.getTool.mockReturnValue(makeTool({ requiresConfirmation: true }));

    const result = await service.executeTool('dose_reagent', { kg: 5 }, ctx('confirm_required'));

    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.requiresConfirmation).toBe(true);
    // The denial is audited too.
    expect(logToolExecution).toHaveBeenCalledWith(
      'dose_reagent',
      { kg: 5 },
      expect.objectContaining({ requiresConfirmation: true }),
      expect.objectContaining({ tenantId: 't1' }),
    );
  });

  it("does NOT execute and does NOT mark confirmable under 'blocked'", async () => {
    registry.getTool.mockReturnValue(makeTool({ requiresConfirmation: true }));

    const result = await service.executeTool('dose_reagent', {}, ctx('blocked'));

    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    // A hard block is not confirmable — must not offer a confirmation path.
    expect(result.requiresConfirmation).not.toBe(true);
    expect(result.error).toMatch(/blocked/i);
  });

  it("executes an actuation tool under 'allowed' (autonomous supervisor)", async () => {
    registry.getTool.mockReturnValue(makeTool({ requiresConfirmation: true }));

    const result = await service.executeTool('dose_reagent', {}, ctx('allowed'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(logToolExecution).toHaveBeenCalledWith(
      'dose_reagent',
      expect.any(Object),
      okResult,
      expect.objectContaining({ actuationPolicy: 'allowed' }),
    );
  });

  it('executes a read-only tool (no confirmation) regardless of policy, and audits it', async () => {
    registry.getTool.mockReturnValue(
      makeTool({ name: 'read_ph', requiresConfirmation: false }),
    );

    const result = await service.executeTool('read_ph', {}, ctx('confirm_required'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(logToolExecution).toHaveBeenCalledTimes(1);
  });

  it('denies on missing permission and audits the denial without executing', async () => {
    registry.getTool.mockReturnValue(
      makeTool({ requiredPermissions: ['supervisor'], requiresConfirmation: false }),
    );

    const result = await service.executeTool('dose_reagent', {}, ctx('allowed'));

    expect(execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission denied/i);
    expect(logToolExecution).toHaveBeenCalledTimes(1);
  });

  it('returns an error for an unknown tool (no audit, nothing ran)', async () => {
    registry.getTool.mockReturnValue(undefined);

    const result = await service.executeTool('nope', {}, ctx('allowed'));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
    expect(logToolExecution).not.toHaveBeenCalled();
  });
});
