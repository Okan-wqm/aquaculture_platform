/**
 * Auth Service Health Controller Unit Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { HealthController } from '../health.controller';

describe('HealthController (Auth Service)', () => {
  let controller: HealthController;
  let isInitialized: boolean;

  const createMockDataSource = () => ({
    get isInitialized() {
      return isInitialized;
    },
  });

  beforeEach(async () => {
    isInitialized = true;

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
    it('should return ok when database is connected', async () => {
      isInitialized = true;
      const result = await controller.readiness();
      expect(result).toEqual({ status: 'ok', database: true });
    });

    it('should return not_ready when database is not connected', async () => {
      isInitialized = false;
      const result = await controller.readiness();
      expect(result).toEqual({ status: 'not_ready', database: false });
    });
  });

  describe('health', () => {
    it('should return comprehensive health status', async () => {
      isInitialized = true;
      const result = await controller.health();

      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(typeof result.uptime).toBe('number');
      expect(result.uptime).toBeGreaterThanOrEqual(0);
      expect(result.database).toBe(true);
    });

    it('should include valid ISO timestamp', async () => {
      const result = await controller.health();
      const timestamp = new Date(result.timestamp);
      expect(timestamp.toISOString()).toBe(result.timestamp);
    });
  });
});
