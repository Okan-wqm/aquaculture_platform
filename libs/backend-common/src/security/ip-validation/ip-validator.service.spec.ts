import { ConfigService } from '@nestjs/config';

import { IpValidatorService } from './ip-validator.service';

describe('IpValidatorService (SEC-MEDIUM-069/070 — 2026-08-23 scan №14/№15/№32)', () => {
  let validator: IpValidatorService;

  beforeEach(() => {
    validator = new IpValidatorService(new ConfigService({ TRUSTED_PROXIES: '' }));
  });

  it('NEVER trusts client-supplied CDN identity headers (CF-Connecting-IP, True-Client-IP)', () => {
    const ip = validator.extractClientIp({
      headers: {
        'cf-connecting-ip': '6.6.6.6',
        'true-client-ip': '7.7.7.7',
        'x-real-ip': '203.0.113.10',
      },
      ip: undefined,
    });
    expect(ip).toBe('203.0.113.10');
  });

  it('a spoofed CDN header alone cannot invent an identity', () => {
    const ip = validator.extractClientIp({
      headers: { 'cf-connecting-ip': '6.6.6.6' },
      ip: '198.51.100.5',
    });
    expect(ip).toBe('198.51.100.5');
  });

  it('prefers the proxy-set X-Real-IP over req.ip and XFF', () => {
    const ip = validator.extractClientIp({
      headers: {
        'x-real-ip': '203.0.113.10',
        'x-forwarded-for': '1.2.3.4, 203.0.113.10',
      },
      ip: '10.0.0.2',
    });
    expect(ip).toBe('203.0.113.10');
  });
});
