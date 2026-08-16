import { RedisService } from './redis.service';
import { TenantRedisService } from './tenant-redis.service';

describe('TenantRedisService', () => {
  let service: TenantRedisService;
  let mockRedis: jest.Mocked<
    Pick<
      RedisService,
      'get' | 'set' | 'del' | 'exists' | 'deletePattern' | 'hset' | 'hget' | 'hdel' | 'hgetall'
    >
  >;
  const validTenantId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      deletePattern: jest.fn(),
      hset: jest.fn(),
      hget: jest.fn(),
      hdel: jest.fn(),
      hgetall: jest.fn(),
    };
  });

  describe('constructor / forTenant', () => {
    it('should reject empty tenantId', () => {
      expect(() => TenantRedisService.forTenant(mockRedis as unknown as RedisService, '')).toThrow(
        'tenantId must be a valid UUID',
      );
    });

    it('should reject null/undefined tenantId', () => {
      expect(() =>
        TenantRedisService.forTenant(
          mockRedis as unknown as RedisService,
          null as unknown as string,
        ),
      ).toThrow('tenantId must be a valid UUID');
      expect(() =>
        TenantRedisService.forTenant(
          mockRedis as unknown as RedisService,
          undefined as unknown as string,
        ),
      ).toThrow('tenantId must be a valid UUID');
    });

    it('should reject invalid UUID format', () => {
      expect(() =>
        TenantRedisService.forTenant(mockRedis as unknown as RedisService, 'not-a-uuid'),
      ).toThrow('tenantId must be a valid UUID');
      expect(() =>
        TenantRedisService.forTenant(mockRedis as unknown as RedisService, '12345'),
      ).toThrow('tenantId must be a valid UUID');
      expect(() =>
        TenantRedisService.forTenant(mockRedis as unknown as RedisService, 'admin; DROP TABLE'),
      ).toThrow('tenantId must be a valid UUID');
    });

    it('should accept valid UUID tenantId', () => {
      expect(() =>
        TenantRedisService.forTenant(mockRedis as unknown as RedisService, validTenantId),
      ).not.toThrow();
    });

    it('should accept uppercase UUID tenantId', () => {
      expect(() =>
        TenantRedisService.forTenant(
          mockRedis as unknown as RedisService,
          validTenantId.toUpperCase(),
        ),
      ).not.toThrow();
    });
  });

  describe('key prefixing', () => {
    beforeEach(() => {
      service = TenantRedisService.forTenant(mockRedis as unknown as RedisService, validTenantId);
    });

    it('should prefix get calls with tenant:{tenantId}:', async () => {
      mockRedis.get.mockResolvedValue('value');
      await service.get('mykey');
      expect(mockRedis.get).toHaveBeenCalledWith(`tenant:${validTenantId}:mykey`);
    });

    it('should prefix set calls with tenant:{tenantId}:', async () => {
      mockRedis.set.mockResolvedValue(undefined);
      await service.set('mykey', 'myvalue', 300);
      expect(mockRedis.set).toHaveBeenCalledWith(`tenant:${validTenantId}:mykey`, 'myvalue', 300);
    });

    it('should prefix set calls without TTL', async () => {
      mockRedis.set.mockResolvedValue(undefined);
      await service.set('mykey', 'myvalue');
      expect(mockRedis.set).toHaveBeenCalledWith(
        `tenant:${validTenantId}:mykey`,
        'myvalue',
        undefined,
      );
    });

    it('should prefix del calls', async () => {
      mockRedis.del.mockResolvedValue(1);
      const result = await service.del('mykey');
      expect(mockRedis.del).toHaveBeenCalledWith(`tenant:${validTenantId}:mykey`);
      expect(result).toBe(1);
    });

    it('should prefix exists calls', async () => {
      mockRedis.exists.mockResolvedValue(true);
      const result = await service.exists('mykey');
      expect(mockRedis.exists).toHaveBeenCalledWith(`tenant:${validTenantId}:mykey`);
      expect(result).toBe(true);
    });

    it('should prefix deletePattern calls', async () => {
      mockRedis.deletePattern.mockResolvedValue(5);
      const result = await service.deletePattern('cache:*');
      expect(mockRedis.deletePattern).toHaveBeenCalledWith(`tenant:${validTenantId}:cache:*`);
      expect(result).toBe(5);
    });

    it('should prefix hset calls', async () => {
      mockRedis.hset.mockResolvedValue(1);
      const result = await service.hset('myhash', 'field1', 'value1');
      expect(mockRedis.hset).toHaveBeenCalledWith(
        `tenant:${validTenantId}:myhash`,
        'field1',
        'value1',
      );
      expect(result).toBe(1);
    });

    it('should prefix hget calls', async () => {
      mockRedis.hget.mockResolvedValue('value1');
      const result = await service.hget('myhash', 'field1');
      expect(mockRedis.hget).toHaveBeenCalledWith(`tenant:${validTenantId}:myhash`, 'field1');
      expect(result).toBe('value1');
    });

    it('should prefix hdel calls', async () => {
      mockRedis.hdel.mockResolvedValue(1);
      const result = await service.hdel('myhash', 'field1', 'field2');
      expect(mockRedis.hdel).toHaveBeenCalledWith(
        `tenant:${validTenantId}:myhash`,
        'field1',
        'field2',
      );
      expect(result).toBe(1);
    });

    it('should prefix hgetall calls', async () => {
      mockRedis.hgetall.mockResolvedValue({ a: '1', b: '2' });
      const result = await service.hgetall('myhash');
      expect(mockRedis.hgetall).toHaveBeenCalledWith(`tenant:${validTenantId}:myhash`);
      expect(result).toEqual({ a: '1', b: '2' });
    });
  });

  describe('return values', () => {
    beforeEach(() => {
      service = TenantRedisService.forTenant(mockRedis as unknown as RedisService, validTenantId);
    });

    it('get should return null when key does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await service.get('nonexistent');
      expect(result).toBeNull();
    });

    it('exists should return false when key does not exist', async () => {
      mockRedis.exists.mockResolvedValue(false);
      const result = await service.exists('nonexistent');
      expect(result).toBe(false);
    });

    it('hgetall should return empty object when hash does not exist', async () => {
      mockRedis.hgetall.mockResolvedValue({});
      const result = await service.hgetall('nonexistent');
      expect(result).toEqual({});
    });
  });

  describe('getTenantId', () => {
    it('should return the tenantId used for construction', () => {
      service = TenantRedisService.forTenant(mockRedis as unknown as RedisService, validTenantId);
      expect(service.getTenantId()).toBe(validTenantId);
    });
  });

  describe('getKeyPrefix', () => {
    it('should return the tenant key prefix', () => {
      service = TenantRedisService.forTenant(mockRedis as unknown as RedisService, validTenantId);
      expect(service.getKeyPrefix()).toBe(`tenant:${validTenantId}:`);
    });
  });
});
