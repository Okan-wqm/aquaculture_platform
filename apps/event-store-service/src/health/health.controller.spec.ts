import { HttpStatus } from '@nestjs/common';

import { HealthController } from './health.controller';

describe('EventStore HealthController', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('returns 503 when any event-store readiness check fails', async () => {
    process.env['NODE_ENV'] = 'test';
    const dataSource = {
      isInitialized: true,
      query: jest.fn(async (sql: string) => {
        if (sql === 'SELECT 1') return [{ ok: 1 }];
        if (sql.includes('trg_assign_stored_event_global_position')) return [];
        return [{ ok: 1 }];
      }),
    };
    const controller = new HealthController(dataSource as never);
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await controller.readiness(response as never);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'not_ready',
        checks: expect.objectContaining({
          ledger_position_trigger: 'error',
        }),
      }),
    );
  });
});
