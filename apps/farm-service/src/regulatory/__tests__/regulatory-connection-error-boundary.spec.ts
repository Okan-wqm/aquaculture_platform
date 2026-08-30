import { Logger } from '@nestjs/common';

import { RegulatoryResolver } from '../regulatory.resolver';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('RegulatoryResolver Maskinporten connection error boundary', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('never reflects provider, OAuth, token, or key diagnostics into GraphQL or logs', async () => {
    const canary = [
      'Bearer provider-token-canary',
      'client_secret=provider-client-secret-canary',
      '-----BEGIN PRIVATE KEY----- provider-key-canary',
      'https://provider.invalid/token?issuer=provider-issuer-canary',
      '{"error_description":"provider-body-canary"}',
    ].join(' ');
    const settingsService = {
      isConfigured: jest.fn().mockResolvedValue(true),
    };
    const maskinporten = {
      getAccessToken: jest.fn().mockRejectedValue(new Error(canary)),
    };
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const resolver = new RegulatoryResolver(
      {} as never,
      maskinporten as never,
      settingsService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      resolver.testMaskinportenConnection({ req: { user: { tenantId: TENANT_ID } } }),
    ).resolves.toEqual({
      success: false,
      error: 'Maskinporten connection test failed',
    });

    expect(maskinporten.getAccessToken).toHaveBeenCalledWith(TENANT_ID, [expect.any(String)]);
    expect(errorLog).toHaveBeenCalledWith({
      message: 'Maskinporten connection test failed',
      phase: 'connection_test',
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('provider-');
  });
});
