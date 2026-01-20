/**
 * SecurityHeadersMiddleware Tests
 *
 * Comprehensive test suite for security headers middleware
 */

import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import { SecurityHeadersMiddleware } from '../security-headers.middleware';

describe('SecurityHeadersMiddleware', () => {
  let middleware: SecurityHeadersMiddleware;
  let configService: ConfigService;

  /**
   * Create mock request
   */
  const createMockRequest = (): Request => {
    return {
      headers: {},
      method: 'GET',
      url: '/api/v1/test',
    } as unknown as Request;
  };

  /**
   * Create mock response with header tracking
   */
  const createMockResponse = (): Response & { headers: Record<string, string> } => {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      removeHeader: jest.fn((name: string) => {
        delete headers[name];
      }),
      getHeader: jest.fn((name: string) => headers[name]),
    } as unknown as Response & { headers: Record<string, string> };
  };

  describe('Production Environment', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                const config: Record<string, unknown> = {
                  NODE_ENV: 'production',
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      middleware = module.get<SecurityHeadersMiddleware>(SecurityHeadersMiddleware);
      configService = module.get<ConfigService>(ConfigService);
    });

    describe('Content-Security-Policy', () => {
      it('should set CSP header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Content-Security-Policy',
          expect.any(String),
        );
      });

      it('should include default-src directive', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const csp = res.headers['Content-Security-Policy'];
        expect(csp).toContain("default-src 'self'");
      });

      it('should include script-src directive', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const csp = res.headers['Content-Security-Policy'];
        expect(csp).toContain('script-src');
      });

      it('should include frame-ancestors none', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const csp = res.headers['Content-Security-Policy'];
        expect(csp).toContain("frame-ancestors 'none'");
      });
    });

    describe('Strict-Transport-Security', () => {
      it('should set HSTS header in production', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Strict-Transport-Security',
          expect.stringContaining('max-age='),
        );
      });

      it('should include max-age directive', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const hsts = res.headers['Strict-Transport-Security'];
        expect(hsts).toMatch(/max-age=\d+/);
      });

      it('should include includeSubDomains directive', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const hsts = res.headers['Strict-Transport-Security'];
        expect(hsts).toContain('includeSubDomains');
      });

      it('should include preload directive', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const hsts = res.headers['Strict-Transport-Security'];
        expect(hsts).toContain('preload');
      });
    });

    describe('X-Content-Type-Options', () => {
      it('should set nosniff header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      });
    });

    describe('X-Frame-Options', () => {
      it('should set frame options header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
      });
    });

    describe('X-XSS-Protection', () => {
      it('should set XSS protection header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
      });
    });

    describe('Referrer-Policy', () => {
      it('should set referrer policy header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Referrer-Policy',
          'strict-origin-when-cross-origin',
        );
      });
    });

    describe('Permissions-Policy', () => {
      it('should set permissions policy header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Permissions-Policy',
          expect.any(String),
        );
      });

      it('should disable camera', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const permissions = res.headers['Permissions-Policy'];
        expect(permissions).toContain('camera=()');
      });

      it('should disable microphone', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const permissions = res.headers['Permissions-Policy'];
        expect(permissions).toContain('microphone=()');
      });

      it('should disable geolocation', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const permissions = res.headers['Permissions-Policy'];
        expect(permissions).toContain('geolocation=()');
      });
    });

    describe('Cross-Origin Policies (Production Only)', () => {
      it('should set Cross-Origin-Embedder-Policy in production', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Cross-Origin-Embedder-Policy',
          'require-corp',
        );
      });

      it('should set Cross-Origin-Opener-Policy in production', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Cross-Origin-Opener-Policy',
          'same-origin',
        );
      });

      it('should set Cross-Origin-Resource-Policy in production', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.setHeader).toHaveBeenCalledWith(
          'Cross-Origin-Resource-Policy',
          'same-origin',
        );
      });
    });

    describe('Header Removal', () => {
      it('should remove X-Powered-By header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.removeHeader).toHaveBeenCalledWith('X-Powered-By');
      });

      it('should remove Server header', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        expect(res.removeHeader).toHaveBeenCalledWith('Server');
      });
    });
  });

  describe('Development Environment', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                const config: Record<string, unknown> = {
                  NODE_ENV: 'development',
                };
                return config[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      middleware = module.get<SecurityHeadersMiddleware>(SecurityHeadersMiddleware);
    });

    it('should NOT set HSTS header in development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // HSTS should not be set in development
      expect(res.headers['Strict-Transport-Security']).toBeUndefined();
    });

    it('should NOT set Cross-Origin-Embedder-Policy in development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.headers['Cross-Origin-Embedder-Policy']).toBeUndefined();
    });

    it('should NOT set Cross-Origin-Opener-Policy in development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.headers['Cross-Origin-Opener-Policy']).toBeUndefined();
    });

    it('should still set X-Content-Type-Options in development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    });

    it('should still set X-Frame-Options in development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    });

    it('should include WebSocket in CSP connect-src for development', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const csp = res.headers['Content-Security-Policy'];
      expect(csp).toContain('ws:');
      expect(csp).toContain('wss:');
    });
  });

  describe('Custom Configuration', () => {
    it('should use custom CSP when provided', async () => {
      const customCsp = "default-src 'none'; script-src 'self'";

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'SECURITY_CSP') return customCsp;
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const customMiddleware = module.get<SecurityHeadersMiddleware>(
        SecurityHeadersMiddleware,
      );
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      customMiddleware.use(req, res, next);

      expect(res.headers['Content-Security-Policy']).toBe(customCsp);
    });

    it('should use custom frame options when provided', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'SECURITY_FRAME_OPTIONS') return 'SAMEORIGIN';
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const customMiddleware = module.get<SecurityHeadersMiddleware>(
        SecurityHeadersMiddleware,
      );
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      customMiddleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
    });

    it('should use custom referrer policy when provided', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'SECURITY_REFERRER_POLICY') return 'no-referrer';
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const customMiddleware = module.get<SecurityHeadersMiddleware>(
        SecurityHeadersMiddleware,
      );
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      customMiddleware.use(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
    });
  });

  describe('Middleware Flow', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      middleware = module.get<SecurityHeadersMiddleware>(SecurityHeadersMiddleware);
    });

    it('should call next function', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should set headers before calling next', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      let headersSetBeforeNext = false;

      const next = jest.fn(() => {
        headersSetBeforeNext = Object.keys(res.headers).length > 0;
      });

      middleware.use(req, res, next);

      expect(headersSetBeforeNext).toBe(true);
    });
  });

  describe('getConfig Method', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      middleware = module.get<SecurityHeadersMiddleware>(SecurityHeadersMiddleware);
    });

    it('should return current configuration', () => {
      const config = middleware.getConfig();

      expect(config).toBeDefined();
      expect(config.contentSecurityPolicy).toBeDefined();
      expect(config.strictTransportSecurity).toBeDefined();
      expect(config.xContentTypeOptions).toBe('nosniff');
      expect(config.xFrameOptions).toBeDefined();
    });

    it('should return a copy of the config (immutable)', () => {
      const config1 = middleware.getConfig();
      const config2 = middleware.getConfig();

      config1.xFrameOptions = 'modified';

      expect(config2.xFrameOptions).not.toBe('modified');
    });
  });

  describe('Performance', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SecurityHeadersMiddleware,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      middleware = module.get<SecurityHeadersMiddleware>(SecurityHeadersMiddleware);
    });

    it('should handle rapid requests efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 10000; i++) {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
