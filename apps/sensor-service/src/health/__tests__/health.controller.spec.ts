/**
 * Sensor Service Health Controller Unit Tests
 *
 * Tests the standardized health check format with TimescaleDB extension:
 *   GET /health/live  -> { status: 'ok' }
 *   GET /health/ready -> { status, checks: { database, timescale } }
 *   GET /health       -> { status, timestamp, uptime, version }
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { HealthController } from '../health.controller';

// Mock response object for @Res() endpoints
const createMockResponse = () => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('HealthController (Sensor Service)', () => {
  let controller: HealthController;
  let isInitialized: boolean;
  let queryMock: jest.Mock;

  const createMockDataSource = () => ({
    get isInitialized() {
      return isInitialized;
    },
    query: queryMock,
  });

  beforeEach(async () => {
    isInitialized = true;
    queryMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DataSource,
          useFactory: createMockDataSource,
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  describe('liveness', () => {
    it('should return ok status', () => {
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
    });

    it('should always succeed regardless of database state', () => {
      isInitialized = false;
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('readiness', () => {
    it('should return ok when database and timescale are connected', async () => {
      isInitialized = true;
      // First call: SELECT 1 (database check), Second call: timescale check
      queryMock
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([{ extname: 'timescaledb' }]);

      const res = createMockResponse();
      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok', timescale: 'ok' },
      });
    });

    it('should return 503 when database is not connected', async () => {
      isInitialized = false;
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.checks.database).toBe('error');
    });

    it('should return degraded when timescale is not installed', async () => {
      isInitialized = true;
      queryMock
        .mockResolvedValueOnce([{ '?column?': 1 }]) // SELECT 1
        .mockResolvedValueOnce([]); // empty timescale result

      const res = createMockResponse();
      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200); // still OK overall
      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.checks.database).toBe('ok');
      expect(jsonCall.checks.timescale).toBe('error');
      expect(jsonCall.status).toBe('degraded');
    });

    it('should handle timescale query error gracefully', async () => {
      isInitialized = true;
      queryMock
        .mockResolvedValueOnce([{ '?column?': 1 }]) // SELECT 1
        .mockRejectedValueOnce(new Error('Query failed')); // timescale error

      const res = createMockResponse();
      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200);
      const jsonCall = res.json.mock.calls[0][0];
      expect(jsonCall.checks.database).toBe('ok');
      expect(jsonCall.checks.timescale).toBe('error');
    });
  });

  describe('health', () => {
    it('should return standardized health status', () => {
      const result = controller.health();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.version).toBeDefined();
    });

    it('should include valid ISO timestamp', () => {
      const result = controller.health();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('should not expose database or timescale status in public health endpoint', () => {
      const result = controller.health() as unknown as Record<string, unknown>;
      expect(result).not.toHaveProperty('database');
      expect(result).not.toHaveProperty('timescale');
    });

    it('should report actual process uptime', () => {
      const beforeUptime = process.uptime();
      const result = controller.health();
      const afterUptime = process.uptime();

      expect(result.uptime).toBeGreaterThanOrEqual(beforeUptime);
      expect(result.uptime).toBeLessThanOrEqual(afterUptime);
    });
  });

  describe('TimescaleDB integration', () => {
    it('should query for timescaledb extension in readiness check', async () => {
      isInitialized = true;
      queryMock
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockResolvedValueOnce([]);

      const res = createMockResponse();
      await controller.readiness(res);

      expect(queryMock).toHaveBeenCalledWith(
        "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
      );
    });

    it('should not query timescale when database not connected', async () => {
      isInitialized = false;
      const res = createMockResponse();

      await controller.readiness(res);

      // Only the SELECT 1 check should have been attempted (and failed due to isInitialized)
      // TimescaleDB check should also detect isInitialized = false
      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});
