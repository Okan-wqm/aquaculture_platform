import { TenantContextMiddleware } from '../tenant-context.middleware';
import { Response, NextFunction } from 'express';

describe('TenantContextMiddleware - subdomain hardening', () => {
  let middleware: TenantContextMiddleware;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    middleware = new TenantContextMiddleware();
    mockRes = {};
    mockNext = jest.fn();
  });

  function createRequest(overrides: Record<string, unknown> = {}): any {
    return {
      headers: {},
      query: {},
      hostname: 'localhost',
      ...overrides,
    };
  }

  describe('subdomain UUID validation', () => {
    it('should accept valid UUID subdomain', () => {
      const req = createRequest({
        hostname: `${validUuid}.api.example.com`,
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBe(validUuid);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject non-UUID subdomain', () => {
      const req = createRequest({
        hostname: 'company-name.api.example.com',
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject common prefixes', () => {
      for (const prefix of ['www', 'api', 'app', 'admin']) {
        const req = createRequest({
          hostname: `${prefix}.api.example.com`,
        });
        middleware.use(req, mockRes as Response, mockNext);
        expect(req.tenantId).toBeUndefined();
      }
    });
  });

  describe('ALLOWED_BASE_DOMAINS enforcement', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should only extract tenants from allowed domains in production', () => {
      process.env = {
        ...originalEnv,
        NODE_ENV: 'production',
        ALLOWED_BASE_DOMAINS: 'api.example.com,app.example.com',
      };

      // Re-create middleware to pick up env changes
      const prodMiddleware = new TenantContextMiddleware();

      // Allowed domain
      const req1 = createRequest({
        hostname: `${validUuid}.api.example.com`,
      });
      prodMiddleware.use(req1, mockRes as Response, mockNext);
      expect(req1.tenantId).toBe(validUuid);

      // Disallowed domain
      const req2 = createRequest({
        hostname: `${validUuid}.evil.com`,
      });
      prodMiddleware.use(req2, mockRes as Response, mockNext);
      expect(req2.tenantId).toBeUndefined();
    });

    /**
     * Renamed from "should allow any domain when ALLOWED_BASE_DOMAINS is not
     * set", which asserted the OPPOSITE of what production does — and of what
     * production should do.
     *
     * `isAllowedBaseDomain` documents the rule in its own docblock: "In
     * production: requires ALLOWED_BASE_DOMAINS env var to be set and the base
     * domain to be in the list. If env var is not set, rejects all
     * (fail-closed)." CLAUDE.md says the same: the request subdomain is a
     * tenant-ID source that must fail closed in prod.
     *
     * The old assertion was not merely stale, it pinned a vulnerability: with
     * the env var unset — the default for any deploy that forgets it — ANY host
     * that puts a UUID in front of a three-label domain would have been trusted
     * as that tenant. Nothing caught the disagreement because this suite lives
     * in libs/backend-common, which had no Nx project and so no CI test lane.
     */
    it('should reject every domain when ALLOWED_BASE_DOMAINS is not set (fail-closed)', () => {
      process.env = {
        ...originalEnv,
        NODE_ENV: 'production',
      };
      delete process.env['ALLOWED_BASE_DOMAINS'];

      const prodMiddleware = new TenantContextMiddleware();
      const req = createRequest({
        hostname: `${validUuid}.any-domain.example.com`,
      });
      prodMiddleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBeUndefined();
    });

    it('should always allow subdomain extraction in development', () => {
      process.env = {
        ...originalEnv,
        NODE_ENV: 'development',
        ALLOWED_BASE_DOMAINS: 'api.example.com',
      };

      const devMiddleware = new TenantContextMiddleware();
      const req = createRequest({
        hostname: `${validUuid}.other-domain.com`,
      });
      devMiddleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBe(validUuid);
    });
  });

  describe('header-based tenant extraction still works', () => {
    it('should extract tenant from x-tenant-id header', () => {
      const req = createRequest({
        headers: { 'x-tenant-id': validUuid },
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBe(validUuid);
    });
  });

  describe('JWT-based tenant extraction still works', () => {
    it('should extract tenant from user JWT', () => {
      const req = createRequest({
        user: { sub: 'user-1', tenantId: validUuid },
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBe(validUuid);
    });
  });

  describe('IP address handling', () => {
    it('should not extract tenant from IP addresses', () => {
      const req = createRequest({
        hostname: '192.168.1.1',
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBeUndefined();
    });

    it('should not extract tenant from localhost', () => {
      const req = createRequest({
        hostname: 'localhost',
      });
      middleware.use(req, mockRes as Response, mockNext);
      expect(req.tenantId).toBeUndefined();
    });
  });
});
