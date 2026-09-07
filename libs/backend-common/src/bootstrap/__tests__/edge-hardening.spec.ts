import express from 'express';
import request from 'supertest';

import { AccessLogService } from '../../audit/access-log.service';
import {
  mountEdgeHardening,
  resolveTrustProxy,
  type EdgeHardeningHost,
  type EdgeRequestHandler,
  type TrustProxyResolutionInput,
} from '../edge-hardening';

const publicProd: Omit<TrustProxyResolutionInput, 'rawValue'> = {
  serviceName: 'admin-api-service',
  visibility: 'public',
  isProduction: true,
};

describe('resolveTrustProxy', () => {
  it('refuses a public production service without TRUST_PROXY — an unset proxy is AUTH-010', () => {
    expect(() => resolveTrustProxy({ ...publicProd, rawValue: undefined })).toThrow(
      /admin-api-service is internet-reachable .* TRUST_PROXY is not set/,
    );
    expect(() => resolveTrustProxy({ ...publicProd, rawValue: '   ' })).toThrow(
      /TRUST_PROXY is not set/,
    );
  });

  it('refuses a public production service that explicitly trusts no proxy', () => {
    expect(() => resolveTrustProxy({ ...publicProd, rawValue: 'false' })).toThrow(
      /trusts no proxy/,
    );
    expect(() => resolveTrustProxy({ ...publicProd, rawValue: '0' })).toThrow(/trusts no proxy/);
  });

  it('trusts the first hop for true and 1', () => {
    expect(resolveTrustProxy({ ...publicProd, rawValue: 'true' })).toBe(1);
    expect(resolveTrustProxy({ ...publicProd, rawValue: '1' })).toBe(1);
  });

  it('turns a hop count into a number, never an address list', () => {
    expect(resolveTrustProxy({ ...publicProd, rawValue: '2' })).toBe(2);
  });

  it('forwards address lists verbatim', () => {
    expect(resolveTrustProxy({ ...publicProd, rawValue: 'loopback, 10.0.0.0/8' })).toBe(
      'loopback, 10.0.0.0/8',
    );
  });

  it('lets an internal service, or any non-production process, run without a proxy', () => {
    expect(
      resolveTrustProxy({
        serviceName: 'farm-service',
        visibility: 'internal',
        isProduction: true,
        rawValue: undefined,
      }),
    ).toBe(false);
    expect(resolveTrustProxy({ ...publicProd, isProduction: false, rawValue: undefined })).toBe(
      false,
    );
    expect(resolveTrustProxy({ ...publicProd, isProduction: false, rawValue: 'false' })).toBe(
      false,
    );
  });
});

/**
 * A host backed by a bare Express app: the handler the bundle installs runs
 * against real Request/Response objects, so the test proves delegation end to
 * end instead of asserting on a mock's call list.
 */
class ExpressHost implements EdgeHardeningHost {
  readonly app = express();
  readonly mounted: EdgeRequestHandler[] = [];

  constructor(private readonly resolveService: () => AccessLogService) {}

  get(): AccessLogService {
    return this.resolveService();
  }

  use(handler: EdgeRequestHandler): unknown {
    this.mounted.push(handler);
    this.app.use(handler);
    return this;
  }
}

describe('mountEdgeHardening', () => {
  const logger = { log: jest.fn() };

  it('mounts the access log ahead of every route and records the finished response', async () => {
    const service = new AccessLogService();
    const record = jest.spyOn(service, 'record').mockImplementation(() => undefined);
    const host = new ExpressHost(() => service);

    mountEdgeHardening(host, 'gateway-api', logger);
    host.app.get('/api/v1/tenants', (_req, res) => {
      res.status(204).end();
    });

    await request(host.app).get('/api/v1/tenants').expect(204);

    expect(host.mounted).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: '/api/v1/tenants', status: 204 }),
    );
  });

  it('records requests Nest would never route (404s), which is the point of an edge log', async () => {
    const service = new AccessLogService();
    const record = jest.spyOn(service, 'record').mockImplementation(() => undefined);
    const host = new ExpressHost(() => service);

    mountEdgeHardening(host, 'admin-api-service', logger);
    await request(host.app).post('/no-such-route').expect(404);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/no-such-route', status: 404 }),
    );
  });

  it('refuses to boot a public service whose module does not provide AccessLogService', () => {
    const host = new ExpressHost(() => {
      throw new Error('Nest could not find AccessLogService element');
    });
    expect(() => mountEdgeHardening(host, 'billing-service', logger)).toThrow(
      /billing-service is internet-reachable .* does not import AccessLogModule\.forRoot\(\)/,
    );
    expect(host.mounted).toHaveLength(0);
  });
});
