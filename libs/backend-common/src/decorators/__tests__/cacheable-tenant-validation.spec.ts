import { Logger } from '@nestjs/common';

import { Cacheable } from '../cacheable.decorator';

describe('Cacheable tenant key validation', () => {
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Spy on Logger.prototype.warn to capture warnings
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation((): void => undefined);
  });

  afterEach(() => {
    loggerWarnSpy.mockRestore();
  });

  describe('@Cacheable', () => {
    it('should not warn when key includes tenant namespace', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceTenant1 {
        redisService = mockRedis;

        @Cacheable('tenant:{0}:data', 3600)
        getData(_tenantId: string): Promise<string> {
          return Promise.resolve('result');
        }
      }

      const svc = new TestServiceTenant1();
      await svc.getData('550e8400-e29b-41d4-a716-446655440000');

      // Should not have warned about missing tenant namespace
      const tenantWarnings = loggerWarnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('missing tenant namespace'),
      );
      expect(tenantWarnings).toHaveLength(0);
    });

    it('should warn when cache key does not include tenant namespace', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceNoTenant2 {
        redisService = mockRedis;

        @Cacheable('user:{0}:profile', 3600)
        getProfile(_userId: string): Promise<string> {
          return Promise.resolve('profile');
        }
      }

      const svc = new TestServiceNoTenant2();
      await svc.getProfile('user-1');

      // Should have warned about missing tenant namespace
      const tenantWarnings = loggerWarnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('missing tenant namespace'),
      );
      expect(tenantWarnings.length).toBeGreaterThan(0);
    });

    it('should not warn for system: prefixed keys', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceSystem2 {
        redisService = mockRedis;

        @Cacheable('system:config:all', 3600)
        getSystemConfig(): Promise<string> {
          return Promise.resolve('config');
        }
      }

      const svc = new TestServiceSystem2();
      await svc.getSystemConfig();

      const tenantWarnings = loggerWarnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('missing tenant namespace'),
      );
      expect(tenantWarnings).toHaveLength(0);
    });

    it('should not warn for global: prefixed keys', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceGlobal2 {
        redisService = mockRedis;

        @Cacheable('global:features', 3600)
        getFeatures(): Promise<string> {
          return Promise.resolve('features');
        }
      }

      const svc = new TestServiceGlobal2();
      await svc.getFeatures();

      const tenantWarnings = loggerWarnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('missing tenant namespace'),
      );
      expect(tenantWarnings).toHaveLength(0);
    });

    it('should still execute the original method even when warning', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceExec2 {
        redisService = mockRedis;

        @Cacheable('unsafe-key:{0}', 3600)
        getData(id: string): Promise<string> {
          return Promise.resolve('result-' + id);
        }
      }

      const svc = new TestServiceExec2();
      const result = await svc.getData('123');
      // Existing functionality must not break
      expect(result).toBe('result-123');
    });

    it('should only warn once per class.method combination', async () => {
      const mockRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockResolvedValue(undefined),
        del: jest.fn().mockResolvedValue(1),
        deletePattern: jest.fn().mockResolvedValue(0),
      };

      class TestServiceDedupe {
        redisService = mockRedis;

        @Cacheable('unsafe:{0}', 3600)
        getData(id: string): Promise<string> {
          return Promise.resolve(id);
        }
      }

      const svc = new TestServiceDedupe();
      await svc.getData('a');
      await svc.getData('b');
      await svc.getData('c');

      // Should have warned exactly once (deduplication by class.method)
      const tenantWarnings = loggerWarnSpy.mock.calls.filter(
        (call: unknown[]) =>
          String(call[0]).includes('missing tenant namespace') &&
          String(call[0]).includes('TestServiceDedupe'),
      );
      expect(tenantWarnings).toHaveLength(1);
    });
  });
});
