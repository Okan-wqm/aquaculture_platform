import { ConfigService } from '@nestjs/config';

import { parseFrontendUrl } from '../frontend-url';

/**
 * DEPLOY-HIGH-016. The development default is the whole defect: it is correct
 * where it applies and silently wrong everywhere else, so the tests pin both
 * halves — it is returned in development, and refused in production.
 */
function configWith(values: Record<string, string | undefined>): ConfigService {
  const service = new ConfigService();
  jest
    .spyOn(service, 'get')
    .mockImplementation((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    );
  return service;
}

describe('parseFrontendUrl', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the development default when the key is unset in development', () => {
    expect(parseFrontendUrl(configWith({ NODE_ENV: 'development' }))).toBe('http://localhost:8080');
  });

  it.each(['production', 'staging'])('refuses an unset key in %s', (environment) => {
    expect(() => parseFrontendUrl(configWith({ NODE_ENV: environment }))).toThrow(
      /FRONTEND_URL is required/,
    );
  });

  it('refuses the development default itself in production', () => {
    expect(() =>
      parseFrontendUrl(
        configWith({ NODE_ENV: 'production', FRONTEND_URL: 'http://localhost:8080' }),
      ),
    ).toThrow(/https/);
  });

  it('refuses a loopback host over https in production', () => {
    expect(() =>
      parseFrontendUrl(configWith({ NODE_ENV: 'production', FRONTEND_URL: 'https://127.0.0.1' })),
    ).toThrow(/loopback/);
  });

  it('accepts a real https origin and trims the trailing slash', () => {
    expect(
      parseFrontendUrl(
        configWith({ NODE_ENV: 'production', FRONTEND_URL: 'https://app.suderra.com/' }),
      ),
    ).toBe('https://app.suderra.com');
  });

  it('refuses a URL carrying a query, fragment or credentials', () => {
    for (const value of [
      'https://app.suderra.com/?next=1',
      'https://app.suderra.com/#x',
      'https://user:pw@app.suderra.com',
    ]) {
      expect(() =>
        parseFrontendUrl(configWith({ NODE_ENV: 'production', FRONTEND_URL: value })),
      ).toThrow();
    }
  });

  it('refuses a non-http scheme and a non-URL string', () => {
    expect(() =>
      parseFrontendUrl(configWith({ NODE_ENV: 'development', FRONTEND_URL: 'ftp://x.example' })),
    ).toThrow(/absolute http/);
    expect(() =>
      parseFrontendUrl(configWith({ NODE_ENV: 'development', FRONTEND_URL: 'app.suderra.com' })),
    ).toThrow(/absolute http/);
  });
});
