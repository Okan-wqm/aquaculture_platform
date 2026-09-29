import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  FARM_AI_QUERY_SUBJECTS,
  isFishHealthStatsReply,
  type FishHealthStatsReply,
} from '@platform/event-contracts';
import { Tool } from '../../core/tool.decorator';
import { FarmAiQueryTool } from '../farm-ai-query.tool';
import { ALL_TIERS } from '../farm-ai-query.schema';
import {
  TENANT_A,
  TENANT_B,
  boundFailure,
  boundReply,
  humanToolContext,
  silentViolationReporter,
  tenantBoundClient,
} from '../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { TenantBoundaryViolation } from '../../../tenant-boundary/tenant-boundary-violation';

const CTX = humanToolContext({
  persona: 'operator-farm-water-health-v1',
  personaTier: 'operator',
});

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
  let reporter: ReturnType<typeof silentViolationReporter>;
  let reportSpy: jest.SpyInstance;

  beforeEach(() => {
    send = jest.fn();
    reporter = silentViolationReporter();
    reportSpy = jest.spyOn(reporter, 'report');
    tool = new ProbeTool(tenantBoundClient({ send }, reporter));
  });

  it('sends the subject with the bound tenant and returns the envelope data', async () => {
    send.mockReturnValue(of(boundReply(STATS)));

    const result = await tool.execute({}, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FH_STATS, { tenantId: TENANT_A });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(STATS);
  });

  it('ignores a model-supplied tenantId — the bound tenant wins', async () => {
    // SCENARIO: the tool input carries a tenantId (the executor refuses this earlier; the tool must not rely on it).
    // EXPECTS: the request names only the bound tenant.
    send.mockReturnValue(of(boundReply(STATS)));

    await tool.execute({ tenantId: TENANT_B }, CTX);

    expect(send).toHaveBeenCalledWith(expect.anything(), { tenantId: TENANT_A });
  });

  it('stops the run when the reply was served for another tenant — the data never reaches the model', async () => {
    // SCENARIO: the reply carries tenant B's stats and names tenant B.
    // EXPECTS: TenantBoundaryViolation escapes BaseTool (no ToolResult with data) and the violation is reported.
    send.mockReturnValue(of(boundReply({ ...STATS, total: 999 }, TENANT_B)));

    await expect(tool.execute({}, CTX)).rejects.toBeInstanceOf(TenantBoundaryViolation);
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedTenantId: TENANT_A, servedTenantId: TENANT_B }),
    );
  });

  it('turns a same-tenant NOT_FOUND into a tool error that tells the model the id is unknown here', async () => {
    send.mockReturnValue(of(boundFailure('NOT_FOUND')));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No record with that id exists/);
  });

  it('turns an INTERNAL_ERROR envelope into a tool error the model can act on', async () => {
    send.mockReturnValue(of(boundFailure('INTERNAL_ERROR')));

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/temporarily unavailable/);
  });

  it('rejects a legacy bare-array reply and a payload that fails the contract guard', async () => {
    // A bare array names no tenant: a boundary violation that ends the run.
    send.mockReturnValue(of([]));
    await expect(tool.execute({}, CTX)).rejects.toMatchObject({ reason: 'reply_without_tenant' });

    send.mockReturnValue(of(boundReply({ total: 'three' })));
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
