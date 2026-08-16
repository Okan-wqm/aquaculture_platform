import {
  TokenRevocationAuthorityStateError,
  TokenRevocationReaderService,
  type TokenRevocationRedisReader,
} from '../token-revocation-reader.service';

describe('TokenRevocationReaderService', () => {
  let mgetScoped: jest.Mock;
  let service: TokenRevocationReaderService;

  beforeEach(() => {
    mgetScoped = jest.fn().mockResolvedValue([null, null]);
    const redis: TokenRevocationRedisReader = { mgetScoped };
    service = new TokenRevocationReaderService(redis);
  });

  it('reads both auth-owned markers in one explicitly scoped round trip', async () => {
    await expect(service.getStatus('jti-1', 'user-1', 1_000_001)).resolves.toEqual({
      jtiRevoked: false,
      userEpochRevoked: false,
    });
    expect(mgetScoped).toHaveBeenCalledTimes(1);
    expect(mgetScoped).toHaveBeenCalledWith(
      { scope: 'authorization', key: 'token:blacklist:jti-1' },
      { scope: 'authorization', key: 'user_blacklist:user-1' },
    );
  });

  it('reports both independent revocation reasons', async () => {
    mgetScoped.mockResolvedValueOnce(['1', '1000001']);
    await expect(service.getStatus('jti-1', 'user-1', 1_000_001)).resolves.toEqual({
      jtiRevoked: true,
      userEpochRevoked: true,
    });
  });

  it('accepts only a token issued strictly after the user invalidation epoch', async () => {
    mgetScoped.mockResolvedValueOnce([null, '1000000']);
    await expect(service.getStatus('jti-1', 'user-1', 1_000_001)).resolves.toEqual({
      jtiRevoked: false,
      userEpochRevoked: false,
    });
  });

  it.each([[[null]], [[null, 'not-an-epoch']], [[null, '9007199254740992']]])(
    'fails closed for malformed authority tuple %p',
    async (tuple) => {
      mgetScoped.mockResolvedValueOnce(tuple);
      await expect(service.getStatus('jti-1', 'user-1', 1_000_001)).rejects.toBeInstanceOf(
        TokenRevocationAuthorityStateError,
      );
    },
  );

  it('propagates Redis outages for the caller to surface as unavailable', async () => {
    mgetScoped.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.getStatus('jti-1', 'user-1', 1_000_001)).rejects.toThrow(
      'redis unavailable',
    );
  });

  it('rejects missing or non-canonical token coordinates before Redis', async () => {
    await expect(service.getStatus('', 'user-1', 1_000_001)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getStatus('jti-1', '', 1_000_001)).rejects.toBeInstanceOf(RangeError);
    await expect(service.getStatus('jti-1', 'user-1', 0)).rejects.toBeInstanceOf(RangeError);
    expect(mgetScoped).not.toHaveBeenCalled();
  });
});
