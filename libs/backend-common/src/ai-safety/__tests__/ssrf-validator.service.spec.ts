/**
 * SVD-CRIT-001 / SVD-HIGH-001 — SSRF validator coverage.
 *
 * validateHost is the guard the sensor/VFD socket adapters call before
 * opening a connection to an operator-supplied host. It must reject
 * loopback / RFC-1918 / link-local / CGNAT / cloud-metadata targets while
 * allowing legitimate public endpoints on arbitrary (industrial) ports.
 */
import { promises as dns } from 'dns';

import { SsrfValidatorService } from '../ssrf-validator.service';

describe('SsrfValidatorService.validateHost', () => {
  let service: SsrfValidatorService;

  beforeEach(() => {
    service = new SsrfValidatorService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects the AWS/GCP link-local metadata IP', async () => {
    const result = await service.validateHost('169.254.169.254', 80);
    expect(result.safe).toBe(false);
  });

  it('rejects loopback', async () => {
    expect((await service.validateHost('127.0.0.1', 502)).safe).toBe(false);
    expect((await service.validateHost('localhost', 502)).safe).toBe(false);
  });

  it('rejects RFC-1918 private ranges', async () => {
    for (const ip of ['10.0.0.5', '172.16.4.4', '192.168.1.1']) {
      expect((await service.validateHost(ip, 502)).safe).toBe(false);
    }
  });

  it('rejects CGNAT (100.64.0.0/10)', async () => {
    expect((await service.validateHost('100.64.1.1', 502)).safe).toBe(false);
  });

  it('rejects an out-of-range port', async () => {
    expect((await service.validateHost('8.8.8.8', 0)).safe).toBe(false);
    expect((await service.validateHost('8.8.8.8', 70000)).safe).toBe(false);
  });

  it('allows a public IP literal on a non-standard industrial port', async () => {
    const result = await service.validateHost('8.8.8.8', 502);
    expect(result.safe).toBe(true);
    expect(result.resolvedIp).toBe('8.8.8.8');
  });

  it('resolves a hostname pre-connect and pins the public IP', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
    const result = await service.validateHost('vendor.example.com', 8443);
    expect(result.safe).toBe(true);
    expect(result.resolvedIp).toBe('93.184.216.34');
  });

  it('blocks DNS-rebinding: a hostname that resolves to a private IP', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['10.0.0.7']);
    const result = await service.validateHost('rebind.attacker.test', 502);
    expect(result.safe).toBe(false);
    expect(result.resolvedIp).toBe('10.0.0.7');
  });

  it('blocks when ANY resolved A record is private (mixed answer)', async () => {
    jest.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34', '169.254.169.254']);
    const result = await service.validateHost('mixed.attacker.test', 443);
    expect(result.safe).toBe(false);
  });

  it('rejects an empty host', async () => {
    expect((await service.validateHost('', 80)).safe).toBe(false);
  });
});
