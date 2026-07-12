import type { ConfigService } from '@nestjs/config';

import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';

import {
  MattilsynetApiService,
  type MattilsynetBasePayload,
} from '../mattilsynet-api.service';
import type { MaskinportenService } from '../maskinporten.service';
import type { RegulatorySettingsService } from '../regulatory-settings.service';
import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import type { ValidatedPayload } from '../schemas';

/**
 * FARM-MEDIUM-172 — the submit breaker must count HTTP 5xx failures. `fetch`
 * resolves normally on a 5xx (it only rejects on transport errors), so the
 * service throws from INSIDE the breaker fn on a 5xx and returns the response on
 * a 4xx. Here the breaker is mocked to run the fn and record whether it threw —
 * exactly the signal the real breaker's failure counter uses — proving a 5xx
 * trips it and a 4xx validation rejection does not.
 */

function buildHarness(fetchStatus: number, body: Record<string, unknown>): {
  service: MattilsynetApiService;
  fnThrewCount: () => number;
} {
  let threw = 0;
  const circuitBreaker = {
    execute: jest.fn(async (opts: { fn: () => Promise<unknown> }) => {
      try {
        return await opts.fn();
      } catch (err) {
        threw += 1;
        throw err;
      }
    }),
  } as Partial<CircuitBreakerService> as CircuitBreakerService;

  const maskinporten = {
    getAccessToken: jest.fn().mockResolvedValue('tok'),
  } as Partial<MaskinportenService> as MaskinportenService;
  const settings = {
    getDecryptedClientId: jest.fn().mockResolvedValue('client'),
  } as Partial<RegulatorySettingsService> as RegulatorySettingsService;
  const config = { get: jest.fn().mockReturnValue('TEST') } as Partial<ConfigService> as ConfigService;

  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: fetchStatus < 400,
    status: fetchStatus,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Partial<Response> as Response);

  const service = new MattilsynetApiService(config, maskinporten, settings, circuitBreaker);
  return { service, fnThrewCount: () => threw };
}

// The brand is a compile-time gate; the breaker path never inspects the shape,
// so a minimal branded base payload is sufficient for this transport test.
const PAYLOAD = { klientReferanse: 'ref-1' } as Partial<MattilsynetBasePayload> as ValidatedPayload<MattilsynetBasePayload>;

describe('MattilsynetApiService submit breaker (FARM-MEDIUM-172)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('THROWS inside the breaker fn on a 5xx so the breaker counts it', async () => {
    const { service, fnThrewCount } = buildHarness(503, { message: 'upstream down' });
    const result = await service.submitByType(
      'tenant-A',
      RegulatoryReportType.SEA_LICE,
      PAYLOAD,
    );

    // The breaker's fn threw → the real breaker would record a failure.
    expect(fnThrewCount()).toBe(1);
    // The outer catch classifies it as a transient network-class failure (replayed).
    expect(result.success).toBe(false);
    expect(result.isNetworkError).toBe(true);
    expect(result.feilmelding).toContain('503');
  });

  it('does NOT throw on a 4xx validation rejection (breaker untouched)', async () => {
    const { service, fnThrewCount } = buildHarness(400, {
      message: 'validation failed',
      errors: [{ felt: 'x', melding: 'bad' }],
    });
    const result = await service.submitByType(
      'tenant-A',
      RegulatoryReportType.SEA_LICE,
      PAYLOAD,
    );

    // A 4xx is the server working and rejecting — the fn returns the response,
    // so the breaker records NO failure.
    expect(fnThrewCount()).toBe(0);
    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(400);
    expect(result.valideringsfeil).toBeDefined();
  });
});
