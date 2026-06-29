/**
 * Sentinel-hub read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 * The boundary + credential masking live in SentinelHubService (its settings
 * reads now run in runInTenantRead/runInTenantTransaction); these prove the CQRS
 * reads delegate to that SSoT unchanged.
 */
import { GetSentinelHubStatusHandler } from '../handlers/get-sentinel-hub-status.handler';
import { GetSentinelHubStatusQuery } from '../queries/get-sentinel-hub-status.query';
import { GetSentinelHubCredentialsHandler } from '../handlers/get-sentinel-hub-credentials.handler';
import { GetSentinelHubCredentialsQuery } from '../queries/get-sentinel-hub-credentials.query';
import { IsSentinelHubConfiguredHandler } from '../handlers/is-sentinel-hub-configured.handler';
import { IsSentinelHubConfiguredQuery } from '../queries/is-sentinel-hub-configured.query';
import { SentinelHubService } from '../sentinel-hub.service';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Sentinel-hub read handlers (fail-closed tenant boundary)', () => {
  it('GetSentinelHubStatusHandler delegates to the service SSoT', async () => {
    const status = { isConfigured: true, usageCount: 3 };
    const getStatus = jest.fn().mockResolvedValue(status);
    const service: Pick<SentinelHubService, 'getStatus'> = { getStatus };

    const result = await new GetSentinelHubStatusHandler(service as SentinelHubService).execute(
      new GetSentinelHubStatusQuery(tenantId),
    );

    expect(result).toBe(status);
    expect(getStatus).toHaveBeenCalledWith(tenantId);
  });

  it('GetSentinelHubCredentialsHandler delegates (masked credentials)', async () => {
    const creds = { clientId: 'ab****', hasClientSecret: true, isConfigured: true };
    const getCredentials = jest.fn().mockResolvedValue(creds);
    const service: Pick<SentinelHubService, 'getCredentials'> = { getCredentials };

    const result = await new GetSentinelHubCredentialsHandler(
      service as SentinelHubService,
    ).execute(new GetSentinelHubCredentialsQuery(tenantId));

    expect(result).toBe(creds);
    expect(getCredentials).toHaveBeenCalledWith(tenantId);
  });

  it('IsSentinelHubConfiguredHandler delegates', async () => {
    const isConfigured = jest.fn().mockResolvedValue(false);
    const service: Pick<SentinelHubService, 'isConfigured'> = { isConfigured };

    const result = await new IsSentinelHubConfiguredHandler(service as SentinelHubService).execute(
      new IsSentinelHubConfiguredQuery(tenantId),
    );

    expect(result).toBe(false);
    expect(isConfigured).toHaveBeenCalledWith(tenantId);
  });
});
