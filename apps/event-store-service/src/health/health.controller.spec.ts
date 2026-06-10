import type { ReadinessResponse } from '@aquaculture/backend-common/health';
import { HttpStatus } from '@nestjs/common';
import type { DataSource } from 'typeorm';

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
      query: jest.fn((sql: string) => {
        if (sql === 'SELECT 1') return Promise.resolve([{ ok: 1 }]);
        if (sql.includes('trg_assign_stored_event_global_position')) return Promise.resolve([]);
        return Promise.resolve([{ ok: 1 }]);
      }),
    };
    const controller = new HealthController(dataSource as unknown as DataSource);
    type TestResponse = {
      status: jest.Mock<TestResponse, [number]>;
      json: jest.Mock<undefined, [ReadinessResponse]>;
    };
    const response: TestResponse = {
      status: jest.fn<TestResponse, [number]>(),
      json: jest.fn<undefined, [ReadinessResponse]>(),
    };
    response.status.mockReturnValue(response);

    await controller.readiness(response as never);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const body = response.json.mock.calls[0]?.[0];
    expect(body?.status).toBe('not_ready');
    expect(body?.checks['ledger_position_trigger']).toBe('error');
  });
});
