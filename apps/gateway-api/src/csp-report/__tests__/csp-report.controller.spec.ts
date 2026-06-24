 
 

import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';

import { CspReportController } from '../csp-report.controller';

describe('CspReportController', () => {
  let controller: CspReportController;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CspReportController],
    }).compile();

    controller = module.get<CspReportController>(CspReportController);

    // Spy on the logger to verify structured output
    warnSpy = jest.spyOn(controller['logger'], 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const createMockRequest = (overrides?: Partial<Request>): Request =>
    ({
      ip: '192.168.1.1',
      headers: {
        'user-agent': 'Mozilla/5.0 Test Browser',
      },
      ...overrides,
    }) as unknown as Request;

  describe('POST /api/csp-report', () => {
    it('should handle standard CSP report format (csp-report wrapper)', () => {
      const body = {
        'csp-report': {
          'document-uri': 'https://app.suderra.com/dashboard',
          'violated-directive': 'script-src',
          'effective-directive': 'script-src',
          'blocked-uri': 'https://evil.example.com/malicious.js',
          disposition: 'report',
          'source-file': 'https://app.suderra.com/dashboard',
          'line-number': 42,
          'column-number': 10,
          'status-code': 200,
          referrer: 'https://app.suderra.com/',
        },
      };

      const req = createMockRequest();
      controller.cspReport(body, req);

      expect(warnSpy).toHaveBeenCalledWith('CSP Violation Report', {
        report: {
          documentUri: 'https://app.suderra.com/dashboard',
          violatedDirective: 'script-src',
          effectiveDirective: 'script-src',
          blockedUri: 'https://evil.example.com/malicious.js',
          disposition: 'report',
          sourceFile: 'https://app.suderra.com/dashboard',
          lineNumber: 42,
          columnNumber: 10,
          statusCode: 200,
          referrer: 'https://app.suderra.com/',
        },
        clientIp: '192.168.1.1',
        userAgent: 'Mozilla/5.0 Test Browser',
      });
    });

    it('should handle flat report format (Reporting API v1)', () => {
      const body = {
        'document-uri': 'https://app.suderra.com/settings',
        'violated-directive': 'style-src',
        'blocked-uri': 'inline',
        disposition: 'report',
      };

      const req = createMockRequest();
      controller.cspReport(body, req);

      expect(warnSpy).toHaveBeenCalledWith('CSP Violation Report', {
        report: expect.objectContaining({
          documentUri: 'https://app.suderra.com/settings',
          violatedDirective: 'style-src',
          blockedUri: 'inline',
          disposition: 'report',
        }),
        clientIp: '192.168.1.1',
        userAgent: 'Mozilla/5.0 Test Browser',
      });
    });

    it('should handle empty report body gracefully', () => {
      const body = {};
      const req = createMockRequest();

      // Should not throw
      expect(() => controller.cspReport(body, req)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    });

    it('should include client IP and user agent in log', () => {
      const body = {
        'csp-report': {
          'document-uri': 'https://app.suderra.com/',
          'violated-directive': 'img-src',
          'blocked-uri': 'https://tracker.example.com/pixel.gif',
        },
      };

      const req = createMockRequest({
        ip: '10.0.0.42',
        headers: { 'user-agent': 'Chrome/120' },
      } as Partial<Request>);

      controller.cspReport(body, req);

      expect(warnSpy).toHaveBeenCalledWith(
        'CSP Violation Report',
        expect.objectContaining({
          clientIp: '10.0.0.42',
          userAgent: 'Chrome/120',
        }),
      );
    });

    it('should return void (204 is handled by @HttpCode decorator)', () => {
      const body = { 'csp-report': { 'document-uri': 'https://example.com' } };
      const req = createMockRequest();

      const result = controller.cspReport(body, req);
      expect(result).toBeUndefined();
    });
  });
});
