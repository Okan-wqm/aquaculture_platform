import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isFishHealthStatsReply,
  type FishHealthStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import type { ToolExecutionContext } from '../../core/tool.interface';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'operator-farm-water-health-v1',
  personaTier: 'operator',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
};

const STATS: FishHealthStatsReply = {
  total: 3,
  active: 1,
  critical: 0,
  underTreatment: 1,
  quarantined: 0,
  resolved: 2,
  byEventType: { disease_outbreak: 1 },
  bySeverity: { moderate: 1 },
};

/** Minimal concrete tool so the base class is exercised through the real decorator + BaseTool path. */
@Injectable()
@Tool({
  name: 'probe_farm_read',
  description: 'probe',
  category: 'farm_query',
  runtime: 'cloud',
  requiredPermissions: ALL_TIERS,
  requiresModule: 'farm',
  inputSchema: { type: 'object', properties: {} },
  requiresConfirmation: false,
})
class ProbeTool extends FarmAiQueryTool<
  { tenantId?: string },
  Record<string, never>,
  FishHealthStatsReply
> {
  protected readonly subject = FARM_AI_QUERY_SUBJECTS.FH_STATS;
  protected readonly isData = isFishHealthStatsReply;
  protected toRequestFields(): Record<string, never> {
    return {};
  }
}

/**
 * FarmAiQueryTool base (FARM-MEDIUM-328): the NATS round trip every farm read
 * tool shares. The tenant id comes from the execution context and ONLY from
 * there; the envelope and the contract guard decide what the model sees.
 */
describe('FarmAiQueryTool', () => {
  let send: jest.Mock;
  let tool: ProbeTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new ProbeTool({ send });
  });

  it('sends the subject with the context tenant and returns the envelope data', async () => {
    send.mockReturnValue(of({ ok: true, data: STATS }));

    const result = await tool.execute({}, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_STATS, { tenantId: CTX.tenantId });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(STATS);
  });

  it('ignores a model-supplied tenantId — the context wins', async () => {
    send.mockReturnValue(of({ ok: true, data: STATS }));

    await tool.execute({ tenantId: '99999999-9999-4999-8999-999999999999' }, CTX);

    expect(send).toHaveBeenCalledWith(expect.anything(), { tenantId: CTX.tenantId });
  });

  it('turns an { ok: false } envelope into a tool error the model can act on', async () => {
    send.mockReturnValue(of({ ok: false, error: 'INTERNAL_ERROR' }));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/);
  });

  it('rejects a legacy bare-array reply and a payload that fails the contract guard', async () => {
    send.mockReturnValue(of([]));
    const bare = await tool.execute({}, CTX);
    expect(bare.success).toBe(false);
    expect(bare.error).toMatch(/unrecognised reply/);

    send.mockReturnValue(of({ ok: true, data: { total: 'three' } }));
    const malformed = await tool.execute({}, CTX);
    expect(malformed.success).toBe(false);
    expect(malformed.error).toMatch(/contract guard/);
  });

  it('surfaces a transport failure as a tool error instead of throwing into the turn', async () => {
    send.mockReturnValue(throwError(() => new Error('nats down')));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toBe('nats down');
  });
});
