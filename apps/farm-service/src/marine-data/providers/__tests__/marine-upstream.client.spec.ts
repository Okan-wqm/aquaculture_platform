import { BadGatewayException } from '@nestjs/common';

import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import { MarineUpstreamClient } from '../marine-upstream.client';

function res(status: number): Response {
  return { ok: status < 400, status } as Partial<Response> as Response;
}

describe('MarineUpstreamClient', () => {
  let client: MarineUpstreamClient;

  beforeEach(() => {
    // A fresh breaker per test keeps every test well under the volume threshold,
    // so the breaker stays CLOSED and admits the calls we are exercising.
    client = new MarineUpstreamClient(new CircuitBreakerService());
  });

  afterEach(() => jest.restoreAllMocks());

  it('retries a failed CMEMS GET once and returns the recovered response', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(res(200));

    const response = await client.fetchCmems('https://cmems.example/tile');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces a CMEMS 5xx unchanged after exhausting the retry', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(res(503));

    const response = await client.fetchCmems('https://cmems.example/tile');

    expect(response.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial + one retry
  });

  it('does not retry a Sentinel POST and maps a network error to 502', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(
      client.fetchSentinel('tenant-A', 'https://cdse.example/process', { method: 'POST' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns a successful Sentinel response as-is', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(res(200));

    const response = await client.fetchSentinel('tenant-A', 'https://cdse.example/process', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
  });
});
