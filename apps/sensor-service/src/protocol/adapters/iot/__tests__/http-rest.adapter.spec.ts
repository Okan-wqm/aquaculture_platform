/**
 * HttpRestAdapter response parsing (SENSOR-HIGH-082).
 *
 * readData used to return an empty values object forever (placeholder
 * parseResponse + config dropped). These tests pin that a real read now parses the
 * body per responseFormat/dataPath/dataMapping into channel values.
 */
import { HttpRestAdapter, HttpRestConfiguration } from '../http-rest.adapter';

function makeAdapter(bodyFactory: () => string): HttpRestAdapter {
  const circuitBreaker = {
    // Bypass the SSRF fetch: return a fresh Response per call so both the
    // connect-time test read and the subsequent data read get an unconsumed body.
    execute: jest.fn().mockImplementation(async () => new Response(bodyFactory(), { status: 200 })),
  };
  return new HttpRestAdapter(circuitBreaker as never);
}

const baseConfig: HttpRestConfiguration = {
  baseUrl: 'https://api.example.com',
  endpoint: '/data',
  method: 'GET',
  headers: {},
  authType: 'none',
  pollingEnabled: false,
  pollingInterval: 5000,
  connectTimeout: 10000,
  readTimeout: 30000,
  verifySsl: true,
  responseFormat: 'json',
  sensorId: 's1',
  tenantId: 't1',
};

describe('HttpRestAdapter (SENSOR-HIGH-082)', () => {
  it('reads and parses JSON values under a dataPath instead of returning empty', async () => {
    const adapter = makeAdapter(() =>
      JSON.stringify({ data: { temperature: 25.5, humidity: 60, timestamp: '2026' } }),
    );
    const handle = await adapter.connect({ ...baseConfig, dataPath: 'data' });

    const reading = await adapter.readData(handle);

    expect(reading.values).toEqual({ temperature: 25.5, humidity: 60 });
    expect(reading.source).toBe('http_rest');
    expect(reading.timestamp).toBeInstanceOf(Date);
  });

  it('honors an explicit dataMapping', async () => {
    const adapter = makeAdapter(() => JSON.stringify({ payload: { t: 24.1 } }));
    const handle = await adapter.connect({
      ...baseConfig,
      dataMapping: { water_temp: 'payload.t' },
    });

    const reading = await adapter.readData(handle);

    expect(reading.values).toEqual({ water_temp: 24.1 });
  });

  it('parses a CSV body', async () => {
    const adapter = makeAdapter(() => 'temp,ph\n25.5,7.2');
    const handle = await adapter.connect({ ...baseConfig, responseFormat: 'csv' });

    const reading = await adapter.readData(handle);

    expect(reading.values).toEqual({ temp: 25.5, ph: 7.2 });
  });

  it('warns honestly that verifySsl cannot be disabled rather than silently ignoring it', () => {
    const adapter = makeAdapter(() => '{}');
    const result = adapter.validateConfiguration({ ...baseConfig, verifySsl: false });
    expect(result.isValid).toBe(true);
    expect(result.warnings?.some((w) => w.field === 'verifySsl')).toBe(true);
  });
});
