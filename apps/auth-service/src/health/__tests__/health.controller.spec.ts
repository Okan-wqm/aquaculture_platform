/**
 * Auth Service Health Controller Unit Tests
 *
 * Tests the standardized health check format:
 *   GET /health/live  -> { status: 'ok' }
 *   GET /health/ready -> { status, checks: { database } }
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

const restoreEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

describe('HealthController (Auth Service)', () => {
  let controller: HealthController;
  let queryMock: jest.Mock;
  let isInitialized: boolean;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAquaEnv = process.env.AQUA_ENV;
  const originalDeployEnv = process.env.DEPLOY_ENV;
  const originalMfaKey = process.env.MFA_ENCRYPTION_KEY;

  const createMockDataSource = () => ({
    get isInitialized() {
      return isInitialized;
    },
    query: queryMock,
  });

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.AQUA_ENV;
    delete process.env.DEPLOY_ENV;
    delete process.env.MFA_ENCRYPTION_KEY;
    isInitialized = true;
    queryMock = jest.fn().mockResolvedValue([{ '?column?': 1 }]);

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

  afterEach(() => {
    restoreEnv('NODE_ENV', originalNodeEnv);
    restoreEnv('AQUA_ENV', originalAquaEnv);
    restoreEnv('DEPLOY_ENV', originalDeployEnv);
    restoreEnv('MFA_ENCRYPTION_KEY', originalMfaKey);
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
      queryMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok' },
      });
    });

    it('should return 503 when database is not connected', async () => {
      isInitialized = false;
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'error' },
      });
    });

    it('should return 503 when database query fails', async () => {
      isInitialized = true;
      queryMock.mockRejectedValue(new Error('Connection refused'));
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'error' },
      });
    });

    it('should return 503 when production MFA encryption key is missing', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.MFA_ENCRYPTION_KEY;
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'ok', mfaEncryptionKey: 'error' },
      });
    });

    it('should return 503 when production MFA encryption key is malformed', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MFA_ENCRYPTION_KEY = 'not-a-hex-key';
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'ok', mfaEncryptionKey: 'error' },
      });
    });

    it('should return ok when production MFA encryption key is valid', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(64);
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok', mfaEncryptionKey: 'ok' },
      });
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

    it('should not expose database status in public health endpoint', () => {
      const result = controller.health() as unknown as Record<string, unknown>;
      expect(result).not.toHaveProperty('database');
    });
  });
});
