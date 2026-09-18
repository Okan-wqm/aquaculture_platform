import { ConfigService } from '@nestjs/config';

import { parseFrontendUrl } from './frontend-url';

function config(values: Record<string, unknown>): ConfigService {
  return new ConfigService(values);
}

describe('parseFrontendUrl (DEPLOY-HIGH-016)', () => {
  it.each(['production', 'staging'])('requires the key in %s', (environment) => {
    expect(() => parseFrontendUrl(config({ NODE_ENV: environment }))).toThrow(
      `FRONTEND_URL is required in ${environment}`,
    );
    expect(() => parseFrontendUrl(config({ NODE_ENV: environment, FRONTEND_URL: '' }))).toThrow(
      `FRONTEND_URL is required in ${environment}`,
    );
  });

  it.each([undefined, 'development', 'test'])(
    'falls back to the local dev origin only outside deployed environments (%p)',
    (environment) => {
      expect(parseFrontendUrl(config({ NODE_ENV: environment }))).toBe('http://localhost:8080');
    },
  );

  it('trims the trailing slash and keeps a base path', () => {
    expect(parseFrontendUrl(config({ FRONTEND_URL: 'https://app.example.com/' }))).toBe(
      'https://app.example.com',
    );
    expect(parseFrontendUrl(config({ FRONTEND_URL: 'https://app.example.com/portal/' }))).toBe(
      'https://app.example.com/portal',
    );
  });

  it.each(['app.example.com', 'ftp://app.example.com', 'not a url', 42, null])(
    'rejects a value that is not an absolute http(s) URL (%p)',
    (raw) => {
      expect(() => parseFrontendUrl(config({ FRONTEND_URL: raw }))).toThrow(
        'FRONTEND_URL must be an absolute http(s) URL',
      );
    },
  );

  it.each([
    'https://app.example.com/?next=x',
    'https://app.example.com/#frag',
    'https://user:pw@app.example.com',
  ])('rejects query, fragment or credentials (%s)', (raw) => {
    expect(() => parseFrontendUrl(config({ FRONTEND_URL: raw }))).toThrow(
      'FRONTEND_URL must not carry a query, fragment or credentials',
    );
  });

  it.each(['production', 'staging'])('requires https in %s', (environment) => {
    expect(() =>
      parseFrontendUrl(config({ NODE_ENV: environment, FRONTEND_URL: 'http://app.example.com' })),
    ).toThrow(`FRONTEND_URL must use https in ${environment}`);
  });

  it.each([
    ['production', 'https://localhost'],
    ['staging', 'https://127.0.0.1:8080'],
    ['production', 'https://0.0.0.0'],
  ])('rejects a loopback host in %s (%s)', (environment, raw) => {
    expect(() => parseFrontendUrl(config({ NODE_ENV: environment, FRONTEND_URL: raw }))).toThrow(
      `FRONTEND_URL must not point at a loopback host in ${environment}`,
    );
  });

  it('allows a plain http loopback origin in development', () => {
    expect(parseFrontendUrl(config({ FRONTEND_URL: 'http://localhost:5173/' }))).toBe(
      'http://localhost:5173',
    );
  });
});
