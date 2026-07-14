/**
 * SVD-CRIT-001 / SVD-HIGH-001 — SSRF validator coverage.
 *
 * validateHost is the guard the sensor/VFD socket adapters call before
 * opening a connection to an operator-supplied host. It must reject
 * loopback / RFC-1918 / link-local / CGNAT / cloud-metadata targets while
 * allowing legitimate public endpoints on arbitrary (industrial) ports.
 */
import { promises as dns } from 'dns';
import * as http from 'http';

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

/**
 * SENSOR-CRITICAL-002 residual — safeFetch pins the connection to the validated
 * IP so the connected IP cannot diverge from the validated IP (DNS-rebinding
 * TOCTOU). It is the single outbound-HTTP path for operator-controlled URLs.
 */
describe('SsrfValidatorService.safeFetch', () => {
  let service: SsrfValidatorService;

  beforeEach(() => {
    service = new SsrfValidatorService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
    const server = http.createServer(handler);
    return new Promise((resolveListen) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          throw new Error('safeFetch test server has no port');
        }
        resolveListen({ server, port: address.port });
      });
    });
  }

  it('rejects a cloud-metadata target before connecting', async () => {
    await expect(service.safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /Blocked unsafe request target/,
    );
  });

  it('rejects a non-http(s) protocol', async () => {
    await expect(service.safeFetch('ftp://vendor.example.com/x')).rejects.toThrow(
      /protocol .* not allowed/,
    );
  });

  it("enforces the 80/443 port allowlist under portPolicy 'standard'", async () => {
    await expect(
      service.safeFetch('https://vendor.example.com:8443/x', undefined, {
        portPolicy: 'standard',
      }),
    ).rejects.toThrow(/port 8443 not allowed/);
  });

  it('pins the socket to the validated IP (DNS-rebinding proof) and returns the body', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pinned: true }));
    });
    try {
      // The host "validates" to a safe verdict whose pinned IP is our loopback
      // test server. safeFetch MUST connect to resolvedIp (not re-resolve the
      // hostname) — that is the closed rebinding window.
      jest.spyOn(service, 'validateHost').mockResolvedValue({ safe: true, resolvedIp: '127.0.0.1' });
      const response = await service.safeFetch(`http://vendor.example.com:${port}/data`, undefined, {
        timeoutMs: 5000,
      });
      expect(response.ok).toBe(true);
      expect(await response.json()).toEqual({ pinned: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('does not follow redirects (a 3xx surfaces as a non-ok response)', async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/' });
      res.end();
    });
    try {
      jest.spyOn(service, 'validateHost').mockResolvedValue({ safe: true, resolvedIp: '127.0.0.1' });
      const response = await service.safeFetch(`http://vendor.example.com:${port}/redirect`);
      expect(response.status).toBe(302);
      expect(response.ok).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('POSTs a body to the pinned target', async () => {
    const received: string[] = [];
    const { server, port } = await listen((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200);
        res.end('ok');
      });
    });
    try {
      jest.spyOn(service, 'validateHost').mockResolvedValue({ safe: true, resolvedIp: '127.0.0.1' });
      const response = await service.safeFetch(
        `http://vendor.example.com:${port}/token`,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'grant=x' },
        { timeoutMs: 5000 },
      );
      expect(response.ok).toBe(true);
      expect(received).toEqual(['grant=x']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
