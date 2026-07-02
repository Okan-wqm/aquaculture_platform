const mockRedisOn = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisSetex = jest.fn();
const mockRedisQuit = jest.fn();

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: mockRedisOn,
    quit: mockRedisQuit,
    set: mockRedisSet,
    setex: mockRedisSetex,
  })),
);

import { RedisService } from './redis.service';

describe('RedisService key prefixing', () => {
  beforeEach(() => {
    mockRedisOn.mockReset();
    mockRedisSet.mockReset();
    mockRedisSetex.mockReset();
    mockRedisQuit.mockReset();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisSetex.mockResolvedValue('OK');
  });

  it('preserves an explicit empty keyPrefix', async () => {
    const service = new RedisService({
      url: 'redis://redis:6379',
      keyPrefix: '',
    });

    await service.set('ai:tokens:tenant-1:2026-06', '42');
    await service.onModuleDestroy();

    expect(mockRedisSet).toHaveBeenCalledWith('ai:tokens:tenant-1:2026-06', '42');
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });

  it('uses the platform default prefix when keyPrefix is undefined', async () => {
    const service = new RedisService({
      url: 'redis://redis:6379',
    });

    await service.set('healthcheck', 'ok');
    await service.onModuleDestroy();

    expect(mockRedisSet).toHaveBeenCalledWith('aqua:healthcheck', 'ok');
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });
});
