import 'reflect-metadata';
import { NEVER, of, throwError } from 'rxjs';
import type { ToolExecutionContext } from '../../core/tool.interface';
import { GetTankWaterQualityStatsTool } from '../water-health/get-tank-water-quality-stats.tool';

const CTX: ToolExecutionContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  schemaName: 'tenant_1111111111111111',
  userId: 'u-1',
  userRoles: ['operator'],
  correlationId: 'corr-1',
  persona: 'operator',
  actuationPolicy: 'allowed',
};

const TANK = '22222222-2222-4222-8222-222222222222';

const VALID_STATS = {
  windowDays: 7,
  avgTemperatureC: 18.5,
  avgDissolvedOxygenMgL: 7.2,
  avgPh: 7.8,
  avgAmmoniaMgL: 0.02,
  avgNitriteMgL: null,
  measurementCount: 42,
  criticalCount: 1,
  warningCount: 3,
  lastMeasurement: null,
};

describe('FarmAiQueryTool base behavior (via GetTankWaterQualityStatsTool)', () => {
  let send: jest.Mock;
  let tool: GetTankWaterQualityStatsTool;

  beforeEach(() => {
    send = jest.fn();
    tool = new GetTankWaterQualityStatsTool({ send });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('carries PR-3 read-tool metadata', () => {
    const meta = tool.getMetadata();
    expect(meta.name).toBe('get_tank_water_quality_stats');
    expect(meta.category).toBe('farm_query');
    expect(meta.requiresModule).toBe('farm');
    expect(meta.requiresConfirmation).toBe(false);
  });

  it('pins the request tenantId to ctx.tenantId — a model-supplied tenantId is ignored', async () => {
    send.mockReturnValue(of({ ok: true, data: VALID_STATS }));

    const result = await tool.execute(
      {
        tankId: TANK,
        days: 7,
        // The model tries to steer the tenant — the base class must drop it.
        tenantId: '99999999-9999-4999-8999-999999999999',
      } as never,
      CTX,
    );

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [subject, request] = send.mock.calls[0] as [string, Record<string, unknown>];
    expect(subject).toBe('request.farm.ai.getTankWaterQualityStats');
    expect(request.tenantId).toBe(CTX.tenantId);
    expect(request.tenantId).not.toBe('99999999-9999-4999-8999-999999999999');
    expect(request.tankId).toBe(TANK);
    expect(request.days).toBe(7);
  });

  it('ok:false reply → tool result is success:false with the error code', async () => {
    send.mockReturnValue(of({ ok: false, error: 'INVALID_REQUEST' }));

    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('farm query failed: INVALID_REQUEST');
  });

  it('malformed envelope (no ok flag) → success:false, never raw data', async () => {
    send.mockReturnValue(of(VALID_STATS as unknown)); // bare payload, no envelope

    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('malformed reply envelope');
  });

  it('ok:true but data failing the reply guard → success:false', async () => {
    send.mockReturnValue(of({ ok: true, data: { windowDays: 'seven' } }));

    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('unexpected data shape');
  });

  it('transport error before the envelope → success:false', async () => {
    send.mockReturnValue(throwError(() => new Error('NATS: permissions violation')));

    const result = await tool.execute({ tankId: TANK }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('permissions violation');
  });

  it('a hung farm-service is cut off by the timeout', async () => {
    jest.useFakeTimers();
    send.mockReturnValue(NEVER); // no reply ever arrives

    const pending = tool.execute({ tankId: TANK }, CTX);
    const assertion = expect(pending).resolves.toMatchObject({ success: false });
    await jest.advanceTimersByTimeAsync(8000);
    await assertion;
  });
});
