import { DataSource } from 'typeorm';

import { TelemetryRetentionOrchestratorService } from '../telemetry-retention-orchestrator.service';

/**
 * Task 4 Step 4.1 (SENSOR-HIGH-094): verify-before-drop. The ledger gate is
 * the ONLY path to drop_chunks, and it refuses ANY boundary carrying an
 * operation whose newest transition is not VERIFIED.
 */
const TENANT = '11111111-1111-4111-8111-111111111111';

function makeService(states: Array<{ operationId: string; state: string }>): {
  service: TelemetryRetentionOrchestratorService;
} {
  const createQueryBuilder = jest.fn(() => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(
        states.map((s) => ({
          operationId: s.operationId,
          state: s.state,
          rangeStart: new Date('2026-01-01T00:00:00Z'),
          rangeEnd: new Date('2026-01-02T00:00:00Z'),
        })),
      ),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    return qb;
  });
  const dataSource: Partial<DataSource> = { createQueryBuilder: createQueryBuilder as never };
  const service = new TelemetryRetentionOrchestratorService(dataSource as DataSource);
  return { service };
}

describe('TelemetryRetentionOrchestrator — verify-before-drop (Task 4.1)', () => {
  const OLD_BOUNDARY = new Date('2026-01-03T00:00:00Z');
  const dropChunks = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['TELEMETRY_RETENTION_ENABLED'] = 'true';
    // Push "now" far past the boundary so the hot-floor check passes.
    jest.useFakeTimers().setSystemTime(new Date('2026-12-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env['TELEMETRY_RETENTION_ENABLED'];
  });

  it('refuses a drop boundary containing an unverified tenant-day', async () => {
    const { service } = makeService([
      { operationId: 'op-1', state: 'VERIFIED' },
      { operationId: 'op-2', state: 'EXPORTED' },
    ]);

    await expect(service.dropBefore(TENANT, OLD_BOUNDARY, dropChunks)).rejects.toThrow(
      /Unverified archive range.*op-2@EXPORTED/,
    );
    expect(dropChunks).not.toHaveBeenCalled();
  });

  it('refuses when the kill-switch is off — the gate is never bypassed', async () => {
    delete process.env['TELEMETRY_RETENTION_ENABLED'];
    const { service } = makeService([{ operationId: 'op-1', state: 'VERIFIED' }]);

    await expect(service.dropBefore(TENANT, OLD_BOUNDARY, dropChunks)).rejects.toThrow(
      /TELEMETRY_RETENTION_ENABLED/,
    );
    expect(dropChunks).not.toHaveBeenCalled();
  });

  it('refuses a boundary inside the hot floor', async () => {
    const { service } = makeService([{ operationId: 'op-1', state: 'VERIFIED' }]);
    const recent = new Date('2026-11-01T00:00:00Z'); // 30 days before fake now

    await expect(service.dropBefore(TENANT, recent, dropChunks)).rejects.toThrow(
      /hot floor/,
    );
    expect(dropChunks).not.toHaveBeenCalled();
  });

  it('executes the drop only when every intersecting operation is VERIFIED', async () => {
    const { service } = makeService([
      { operationId: 'op-1', state: 'VERIFIED' },
      { operationId: 'op-2', state: 'VERIFIED' },
    ]);

    await expect(service.dropBefore(TENANT, OLD_BOUNDARY, dropChunks)).resolves.toBeUndefined();
    expect(dropChunks).toHaveBeenCalledTimes(1);
  });
});
