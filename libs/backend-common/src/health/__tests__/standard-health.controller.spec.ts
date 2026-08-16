/**
 * StandardHealthController Unit Tests
 *
 * Validates the standardized health check format used across all microservices:
 *   GET /health/live  -> { status: 'ok' }                           (always 200)
 *   GET /health/ready -> { status, checks: { database } }           (200 or 503)
 *   GET /health       -> { status, timestamp, uptime, version }     (always 200)
 */

import { Controller } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { DataSource } from 'typeorm';

import { StandardHealthController } from '../standard-health.controller';

interface MockHealthResponse {
  readonly response: Response;
  readonly status: jest.Mock<Response, [statusCode: number]>;
  readonly json: jest.Mock<Response, [body: unknown]>;
}

// Typed adapter for the two @Res() methods exercised by this controller.
function createMockResponse(): MockHealthResponse {
  const status = jest.fn<Response, [statusCode: number]>();
  const json = jest.fn<Response, [body: unknown]>();
  const response = { status, json } as unknown as Response;
  status.mockReturnValue(response);
  json.mockReturnValue(response);
  return { response, status, json };
}

describe('StandardHealthController', () => {
  let controller: StandardHealthController;
  let queryMock: jest.Mock<Promise<unknown>, [query: string]>;
  let isInitialized: boolean;

  function createMockDataSource(): DataSource {
    return {
      get isInitialized() {
        return isInitialized;
      },
      query: queryMock,
    } as unknown as DataSource;
  }

  beforeEach(async () => {
    isInitialized = true;
    queryMock = jest.fn<Promise<unknown>, [query: string]>().mockResolvedValue([{ '?column?': 1 }]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [StandardHealthController],
      providers: [
        {
          provide: DataSource,
          useFactory: createMockDataSource,
        },
      ],
    }).compile();

    controller = module.get<StandardHealthController>(StandardHealthController);
  });

  describe('GET /health/live (liveness)', () => {
    it('should return { status: "ok" }', () => {
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
    });

    it('should always succeed regardless of database state', () => {
      isInitialized = false;
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('should return 200 with database ok when DB is healthy', async () => {
      const res = createMockResponse();
      queryMock.mockResolvedValue([{ '?column?': 1 }]);

      await controller.readiness(res.response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok' },
      });
    });

    it('should return 503 when database is not initialized', async () => {
      isInitialized = false;
      const res = createMockResponse();

      await controller.readiness(res.response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'error' },
      });
    });

    it('should return 503 when database query fails', async () => {
      queryMock.mockRejectedValue(new Error('Connection refused'));
      const res = createMockResponse();

      await controller.readiness(res.response);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'error' },
      });
    });

    it('should use real SELECT 1 query, not just isInitialized', async () => {
      const res = createMockResponse();
      await controller.readiness(res.response);

      expect(queryMock).toHaveBeenCalledWith('SELECT 1');
    });
  });

  describe('GET /health (general health)', () => {
    it('should return standardized health response', () => {
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

    it('should report actual process uptime', () => {
      const beforeUptime = process.uptime();
      const result = controller.health();
      const afterUptime = process.uptime();

      expect(result.uptime).toBeGreaterThanOrEqual(beforeUptime);
      expect(result.uptime).toBeLessThanOrEqual(afterUptime);
    });

    it('should not expose sensitive data', () => {
      const result = controller.health() as unknown as Record<string, unknown>;
      expect(result).not.toHaveProperty('database');
      expect(result).not.toHaveProperty('memory');
      expect(result).not.toHaveProperty('connections');
    });

    it('should include service name (ADR-013 Section 8.4)', () => {
      const result = controller.health();
      expect(result.service).toBeDefined();
      expect(typeof result.service).toBe('string');
    });

    it('should include framework version info for NestJS v10/v11 identification (ADR-013 Section 8.4)', () => {
      const result = controller.health();

      expect(result.framework).toBeDefined();
      expect(typeof result.framework.nestjs).toBe('string');
      expect(typeof result.framework.express).toBe('string');
      expect(typeof result.framework.node).toBe('string');

      // NestJS and Express versions should be semver-like or 'unknown'
      expect(result.framework.nestjs).toMatch(/^\d+\.\d+\.\d+|unknown$/);
      expect(result.framework.express).toMatch(/^\d+\.\d+\.\d+|unknown$/);

      // Node version starts with 'v' (e.g. 'v20.11.0')
      expect(result.framework.node).toMatch(/^v\d+\.\d+\.\d+/);
    });
  });

  describe('extensibility via getAdditionalChecks()', () => {
    @Controller('health')
    class ExtendedHealthController extends StandardHealthController {
      constructor(dataSource: DataSource) {
        super(dataSource);
        this.serviceName = 'test-service';
      }

      protected override getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
        return Promise.resolve({ custom: 'ok' });
      }
    }

    let extController: ExtendedHealthController;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [ExtendedHealthController],
        providers: [
          {
            provide: DataSource,
            useFactory: createMockDataSource,
          },
        ],
      }).compile();

      extController = module.get<ExtendedHealthController>(ExtendedHealthController);
    });

    it('should include additional checks in readiness', async () => {
      const res = createMockResponse();
      await extController.readiness(res.response);

      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok', custom: 'ok' },
      });
    });

    it('should report degraded when additional check fails but database is ok', async () => {
      @Controller('health')
      class DegradedController extends StandardHealthController {
        protected override getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
          return Promise.resolve({ custom: 'error' });
        }
      }

      const module: TestingModule = await Test.createTestingModule({
        controllers: [DegradedController],
        providers: [
          {
            provide: DataSource,
            useFactory: createMockDataSource,
          },
        ],
      }).compile();

      const degradedController = module.get<DegradedController>(DegradedController);
      const res = createMockResponse();
      await degradedController.readiness(res.response);

      expect(res.status).toHaveBeenCalledWith(200); // degraded is still 200
      expect(res.json).toHaveBeenCalledWith({
        status: 'degraded',
        checks: { database: 'ok', custom: 'error' },
      });
    });
  });

  describe('Controller Decorators', () => {
    it('should be decorated with @Controller("health")', () => {
      const controllerPath: unknown = Reflect.getMetadata('path', StandardHealthController);
      expect(controllerPath).toBe('health');
    });
  });
});
