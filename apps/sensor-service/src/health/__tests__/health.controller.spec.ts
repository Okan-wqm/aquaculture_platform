/**
 * Sensor Service Health Controller Unit Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { HealthController } from '../health.controller';

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
      queryMock.mockResolvedValue([{ extname: 'timescaledb' }]);

      const result = await controller.readiness();

      expect(result.status).toBe('ok');
      expect(result.database).toBe(true);
      expect(result.timescale).toBe(true);
    });

    it('should return not_ready when database is not connected', async () => {
      isInitialized = false;

      const result = await controller.readiness();

      expect(result).toEqual({
        status: 'not_ready',
        database: false,
        timescale: false,
      });
    });

    it('should return ok with timescale false when extension not installed', async () => {
      isInitialized = true;
      queryMock.mockResolvedValue([]);

      const result = await controller.readiness();

      expect(result.status).toBe('ok');
      expect(result.database).toBe(true);
      expect(result.timescale).toBe(false);
    });

    it('should handle timescale query error gracefully', async () => {
      isInitialized = true;
      queryMock.mockRejectedValue(new Error('Query failed'));

      const result = await controller.readiness();

      expect(result.status).toBe('ok');
      expect(result.database).toBe(true);
      expect(result.timescale).toBe(false);
    });
  });

  describe('health', () => {
    it('should return comprehensive health status with timescale', async () => {
      isInitialized = true;
      queryMock.mockResolvedValue([{ extname: 'timescaledb' }]);

      const result = await controller.health();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptime).toBe('number');
      expect(result.database).toBe(true);
      expect(result.timescale).toBe(true);
    });

    it('should include valid ISO timestamp', async () => {
      queryMock.mockResolvedValue([]);
      const result = await controller.health();

      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });

    it('should report timescale as false when extension missing', async () => {
      isInitialized = true;
      queryMock.mockResolvedValue([]);

      const result = await controller.health();

      expect(result.timescale).toBe(false);
    });

    it('should handle timescale query error in health check', async () => {
      isInitialized = true;
      queryMock.mockRejectedValue(new Error('Connection lost'));

      const result = await controller.health();

      expect(result.status).toBe('ok');
      expect(result.timescale).toBe(false);
    });

    it('should report actual process uptime', async () => {
      queryMock.mockResolvedValue([]);

      const beforeUptime = process.uptime();
      const result = await controller.health();
      const afterUptime = process.uptime();

      expect(result.uptime).toBeGreaterThanOrEqual(beforeUptime);
      expect(result.uptime).toBeLessThanOrEqual(afterUptime);
    });
  });

  describe('TimescaleDB integration', () => {
    it('should query for timescaledb extension', async () => {
      isInitialized = true;
      queryMock.mockResolvedValue([]);

      await controller.readiness();

      expect(queryMock).toHaveBeenCalledWith(
        "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
      );
    });

    it('should not query timescale when database not connected', async () => {
      isInitialized = false;

      await controller.readiness();

      expect(queryMock).not.toHaveBeenCalled();
    });
  });
});
