import { TokenBlacklistService, type TokenBlacklistRedisStore } from './token-blacklist.service';

describe('TokenBlacklistService', () => {
  let redis: jest.Mocked<TokenBlacklistRedisStore>;
  let service: TokenBlacklistService;

  beforeEach(() => {
    redis = {
      setAuthorization: jest.fn().mockResolvedValue(undefined),
      getAuthorization: jest.fn().mockResolvedValue(null),
    };
    service = new TokenBlacklistService(redis);
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 1, 0, 0, 0));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes the JTI marker through the explicit authorization namespace', async () => {
    const expiresAt = new Date(Date.UTC(2026, 7, 1, 0, 1, 0));

    await service.add('jti-1', expiresAt, 'logout');

    expect(redis.setAuthorization).toHaveBeenCalledWith('token:blacklist:jti-1', '1', 60);
  });

  it('reads the JTI marker through the explicit authorization namespace', async () => {
    redis.getAuthorization.mockResolvedValueOnce('1');

    await expect(service.isBlacklisted('jti-1')).resolves.toBe(true);

    expect(redis.getAuthorization).toHaveBeenCalledWith('token:blacklist:jti-1');
  });

  it('does not persist markers that have already expired', async () => {
    await service.add('jti-1', new Date(Date.UTC(2026, 6, 31, 23, 59, 59)));

    expect(redis.setAuthorization).not.toHaveBeenCalled();
  });

  it('rejects missing JTIs and invalid expiry dates before touching Redis', async () => {
    await expect(service.add('', new Date(Date.UTC(2026, 7, 1, 0, 1, 0)))).rejects.toThrow(
      'Token JTI is required for revocation',
    );
    await expect(service.add('   ', new Date(Date.UTC(2026, 7, 1, 0, 1, 0)))).rejects.toThrow(
      'Token JTI is required for revocation',
    );
    await expect(service.add('jti-1', new Date(Number.NaN))).rejects.toThrow(
      'Token expiry must be a valid date',
    );
    await expect(service.isBlacklisted('')).rejects.toThrow(
      'Token JTI is required for revocation lookup',
    );
    await expect(service.isBlacklisted('   ')).rejects.toThrow(
      'Token JTI is required for revocation lookup',
    );
    expect(redis.setAuthorization).not.toHaveBeenCalled();
    expect(redis.getAuthorization).not.toHaveBeenCalled();
  });
});
