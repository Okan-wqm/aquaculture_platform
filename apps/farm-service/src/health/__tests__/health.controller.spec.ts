/**
 * Farm Service Health Controller Unit Tests
 *
 * Tests the standardized health check format:
 *   GET /health/live  -> { status: 'ok' }
 *   GET /health/ready -> { status, checks: { database } }
 *   GET /health       -> { status, timestamp, uptime, version }
 */

import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { HealthController } from '../health.controller';
import { TenantSchemaReadinessService } from '../tenant-schema-readiness.service';

// Mock response object for @Res() endpoints
const createMockResponse = () => {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('HealthController (Farm Service)', () => {
  let controller: HealthController;
  let queryMock: jest.Mock;
  let isInitialized: boolean;
  // The tenant-schema readiness slice is its own service with its own unit
  // spec (tenant-schema-readiness.service.spec.ts). Here we mock it so these
  // tests stay focused on the controller's standard probe behaviour; default
  // it to 'ok' so existing readiness assertions are unaffected.
  let tenantSchemaCheck: jest.Mock;

  const createMockDataSource = () => ({
    get isInitialized() {
      return isInitialized;
    },
    query: queryMock,
  });

  beforeEach(async () => {
    isInitialized = true;
    queryMock = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    tenantSchemaCheck = jest.fn().mockResolvedValue('ok');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: DataSource,
          useFactory: createMockDataSource,
        },
        {
          provide: TenantSchemaReadinessService,
          useValue: { checkTenantSchemaRouting: tenantSchemaCheck },
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
      queryMock.mockResolvedValue([{ '?column?': 1 }]);
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        checks: { database: 'ok', tenant_schema: 'ok' },
      });
    });

    it('should return 503 when database is not connected', async () => {
      isInitialized = false;
      // When the DB is unreachable the tenant-schema slice also fails closed.
      tenantSchemaCheck.mockResolvedValue('error');
      const res = createMockResponse();

      await controller.readiness(res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        status: 'not_ready',
        checks: { database: 'error', tenant_schema: 'error' },
      });
    });

    it('should report degraded (200) when tenant-schema routing is broken but DB is ok', async () => {
      isInitialized = true;
      tenantSchemaCheck.mockResolvedValue('error');
      const res = createMockResponse();

      await controller.readiness(res);

      // database ok + tenant_schema error => degraded, still 200 per the
      // StandardHealthController aggregation rules.
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        status: 'degraded',
        checks: { database: 'ok', tenant_schema: 'error' },
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

    it('should report actual process uptime', () => {
      const beforeUptime = process.uptime();
      const result = controller.health();
      const afterUptime = process.uptime();

      expect(result.uptime).toBeGreaterThanOrEqual(beforeUptime);
      expect(result.uptime).toBeLessThanOrEqual(afterUptime);
    });
  });

  describe('Controller Decorators', () => {
    it('should be decorated with @Controller("health")', () => {
      const controllerPath = Reflect.getMetadata('path', HealthController);
      expect(controllerPath).toBe('health');
    });
  });
});
