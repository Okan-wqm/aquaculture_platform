/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * DeviceFingerprintMiddleware Tests
 *
 * Comprehensive test suite for device fingerprinting
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  DeviceFingerprintMiddleware,
  FingerprintedRequest,
  DeviceFingerprint,
  getDeviceFingerprint,
  getDeviceFingerprintHash,
} from '../device-fingerprint.middleware';

describe('DeviceFingerprintMiddleware', () => {
  let middleware: DeviceFingerprintMiddleware;

  /**
   * Create mock request
   */
  const createMockRequest = (
    headers: Record<string, string> = {},
    socket: { remoteAddress?: string } = {},
  ): Request => {
    return {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
        ...headers,
      },
      ip: '192.168.1.100',
      socket: {
        remoteAddress: socket.remoteAddress || '192.168.1.100',
      },
    } as unknown as Request;
  };

  /**
   * Create mock response
   */
  const createMockResponse = (): Response => {
    const headers: Record<string, string> = {};
    return {
      setHeader: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
      getHeader: jest.fn((name: string) => headers[name]),
    } as unknown as Response;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeviceFingerprintMiddleware],
    }).compile();

    middleware = module.get<DeviceFingerprintMiddleware>(DeviceFingerprintMiddleware);
  });

  describe('Fingerprint Generation', () => {
    it('should generate device fingerprint hash', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprintHash).toBeDefined();
      expect(fingerprintedReq.deviceFingerprintHash).toMatch(/^fp_[a-f0-9]{32}$/);
    });

    it('should generate consistent fingerprint for same device', () => {
      const headers = {
        'user-agent': 'Mozilla/5.0 Chrome/91.0',
        'accept-language': 'en-US',
        'accept-encoding': 'gzip',
      };

      const req1 = createMockRequest(headers);
      const req2 = createMockRequest(headers);
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      const next = jest.fn();

      middleware.use(req1, res1, next);
      middleware.use(req2, res2, next);

      const fp1 = (req1 as FingerprintedRequest).deviceFingerprintHash;
      const fp2 = (req2 as FingerprintedRequest).deviceFingerprintHash;

      expect(fp1).toBe(fp2);
    });

    it('should generate different fingerprint for different user agents', () => {
      const req1 = createMockRequest({
        'user-agent': 'Mozilla/5.0 Chrome/91.0',
      });
      const req2 = createMockRequest({
        'user-agent': 'Mozilla/5.0 Firefox/89.0',
      });
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      const next = jest.fn();

      middleware.use(req1, res1, next);
      middleware.use(req2, res2, next);

      const fp1 = (req1 as FingerprintedRequest).deviceFingerprintHash;
      const fp2 = (req2 as FingerprintedRequest).deviceFingerprintHash;

      expect(fp1).not.toBe(fp2);
    });

    it('should generate different fingerprint for different accept-language', () => {
      const req1 = createMockRequest({
        'accept-language': 'en-US',
      });
      const req2 = createMockRequest({
        'accept-language': 'de-DE',
      });
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      const next = jest.fn();

      middleware.use(req1, res1, next);
      middleware.use(req2, res2, next);

      const fp1 = (req1 as FingerprintedRequest).deviceFingerprintHash;
      const fp2 = (req2 as FingerprintedRequest).deviceFingerprintHash;

      expect(fp1).not.toBe(fp2);
    });
  });

  describe('Device Fingerprint Object', () => {
    it('should create full device fingerprint object', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.hash).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.userAgent).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.acceptLanguage).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.acceptEncoding).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.ip).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.timestamp).toBeInstanceOf(Date);
    });

    it('should capture user agent', () => {
      const userAgent = 'Test User Agent/1.0';
      const req = createMockRequest({
        'user-agent': userAgent,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.userAgent).toBe(userAgent);
    });

    it('should capture accept-language', () => {
      const acceptLanguage = 'ja-JP,ja;q=0.9';
      const req = createMockRequest({
        'accept-language': acceptLanguage,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.acceptLanguage).toBe(acceptLanguage);
    });

    it('should capture optional screen resolution', () => {
      const screenRes = '1920x1080';
      const req = createMockRequest({
        'x-screen-resolution': screenRes,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.screenResolution).toBe(screenRes);
    });

    it('should capture optional timezone', () => {
      const timezone = 'America/New_York';
      const req = createMockRequest({
        'x-timezone': timezone,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.timezone).toBe(timezone);
    });

    it('should capture platform from sec-ch-ua-platform', () => {
      const platform = '"Windows"';
      const req = createMockRequest({
        'sec-ch-ua-platform': platform,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.platform).toBe(platform);
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for header', () => {
      const req = createMockRequest({
        'x-forwarded-for': '10.0.0.1, 10.0.0.2',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.ip).toBe('10.0.0.1');
    });

    it('should extract IP from x-real-ip header', () => {
      const req = createMockRequest({
        'x-real-ip': '10.0.0.5',
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.ip).toBe('10.0.0.5');
    });

    it('should fallback to req.ip', () => {
      const req = createMockRequest();
      req.ip = '192.168.1.50';
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.ip).toBe('192.168.1.50');
    });

    it('should fallback to socket.remoteAddress', () => {
      const req = createMockRequest({}, { remoteAddress: '172.16.0.1' });
      req.ip = undefined as unknown as string;
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.ip).toBeDefined();
    });
  });

  describe('Client Fingerprint Combination', () => {
    it('should combine server and client fingerprints', () => {
      const clientFingerprint = 'client-fingerprint-abc123';
      const req = createMockRequest({
        'x-client-fingerprint': clientFingerprint,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      // Combined fingerprint should have different prefix
      expect(fingerprintedReq.deviceFingerprintHash).toMatch(/^fpc_[a-f0-9]{32}$/);
    });

    it('should not combine when no client fingerprint provided', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      // Server-only fingerprint should have fp_ prefix
      expect(fingerprintedReq.deviceFingerprintHash).toMatch(/^fp_[a-f0-9]{32}$/);
    });
  });

  describe('Response Headers', () => {
    it('should set fingerprint header in response', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setHeaderMock = res.setHeader as jest.Mock;
      const fingerprintCall = setHeaderMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'x-device-fingerprint',
      );
      expect(fingerprintCall).toBeDefined();
      expect(fingerprintCall[1]).toMatch(/^fp_[a-f0-9]{32}$/);
    });
  });

  describe('Static Methods', () => {
    describe('compareFingerprints', () => {
      it('should detect same fingerprints', () => {
        const fp1: DeviceFingerprint = {
          hash: 'fp_abc123',
          userAgent: 'Mozilla/5.0',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          screenResolution: '1920x1080',
          timezone: 'UTC',
          platform: 'Windows',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const fp2: DeviceFingerprint = { ...fp1 };

        const result = DeviceFingerprintMiddleware.compareFingerprints(fp1, fp2);

        expect(result.isSame).toBe(true);
        expect(result.similarity).toBe(1);
        expect(result.differences).toHaveLength(0);
      });

      it('should detect different fingerprints', () => {
        const fp1: DeviceFingerprint = {
          hash: 'fp_abc123',
          userAgent: 'Mozilla/5.0 Chrome',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          screenResolution: '1920x1080',
          timezone: 'UTC',
          platform: 'Windows',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const fp2: DeviceFingerprint = {
          hash: 'fp_xyz789',
          userAgent: 'Mozilla/5.0 Firefox',
          acceptLanguage: 'de-DE',
          acceptEncoding: 'gzip',
          screenResolution: '2560x1440',
          timezone: 'CET',
          platform: 'macOS',
          ip: '192.168.1.2',
          timestamp: new Date(),
        };

        const result = DeviceFingerprintMiddleware.compareFingerprints(fp1, fp2);

        expect(result.isSame).toBe(false);
        expect(result.similarity).toBeLessThan(1);
        expect(result.differences.length).toBeGreaterThan(0);
      });

      it('should calculate correct similarity score', () => {
        const fp1: DeviceFingerprint = {
          hash: 'fp_different1',
          userAgent: 'Mozilla/5.0',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          screenResolution: '1920x1080',
          timezone: 'UTC',
          platform: 'Windows',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const fp2: DeviceFingerprint = {
          hash: 'fp_different2',
          userAgent: 'Mozilla/5.0', // Same
          acceptLanguage: 'de-DE', // Different
          acceptEncoding: 'gzip', // Not counted
          screenResolution: '1920x1080', // Same
          timezone: 'CET', // Different
          platform: 'Windows', // Same
          ip: '192.168.1.2',
          timestamp: new Date(),
        };

        const result = DeviceFingerprintMiddleware.compareFingerprints(fp1, fp2);

        expect(result.differences).toContain('acceptLanguage');
        expect(result.differences).toContain('timezone');
      });

      it('should list all differences', () => {
        const fp1: DeviceFingerprint = {
          hash: 'fp_1',
          userAgent: 'A',
          acceptLanguage: 'A',
          acceptEncoding: 'A',
          screenResolution: 'A',
          timezone: 'A',
          platform: 'A',
          ip: 'A',
          timestamp: new Date(),
        };

        const fp2: DeviceFingerprint = {
          hash: 'fp_2',
          userAgent: 'B',
          acceptLanguage: 'B',
          acceptEncoding: 'B',
          screenResolution: 'B',
          timezone: 'B',
          platform: 'B',
          ip: 'B',
          timestamp: new Date(),
        };

        const result = DeviceFingerprintMiddleware.compareFingerprints(fp1, fp2);

        expect(result.differences).toContain('userAgent');
        expect(result.differences).toContain('acceptLanguage');
        expect(result.differences).toContain('platform');
        expect(result.differences).toContain('timezone');
        expect(result.differences).toContain('screenResolution');
      });
    });

    describe('isKnownDevice', () => {
      it('should detect known device', () => {
        const currentFingerprint: DeviceFingerprint = {
          hash: 'fp_known',
          userAgent: 'Mozilla/5.0',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const storedFingerprints: DeviceFingerprint[] = [
          { ...currentFingerprint, hash: 'fp_other1' },
          { ...currentFingerprint, hash: 'fp_known' },
          { ...currentFingerprint, hash: 'fp_other2' },
        ];

        const result = DeviceFingerprintMiddleware.isKnownDevice(
          currentFingerprint,
          storedFingerprints,
        );

        expect(result).toBe(true);
      });

      it('should detect unknown device', () => {
        const currentFingerprint: DeviceFingerprint = {
          hash: 'fp_new',
          userAgent: 'Mozilla/5.0',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const storedFingerprints: DeviceFingerprint[] = [
          { ...currentFingerprint, hash: 'fp_other1' },
          { ...currentFingerprint, hash: 'fp_other2' },
        ];

        const result = DeviceFingerprintMiddleware.isKnownDevice(
          currentFingerprint,
          storedFingerprints,
        );

        expect(result).toBe(false);
      });

      it('should handle empty stored fingerprints', () => {
        const currentFingerprint: DeviceFingerprint = {
          hash: 'fp_new',
          userAgent: 'Mozilla/5.0',
          acceptLanguage: 'en-US',
          acceptEncoding: 'gzip',
          ip: '192.168.1.1',
          timestamp: new Date(),
        };

        const result = DeviceFingerprintMiddleware.isKnownDevice(
          currentFingerprint,
          [],
        );

        expect(result).toBe(false);
      });
    });
  });

  describe('Helper Functions', () => {
    describe('getDeviceFingerprint', () => {
      it('should return device fingerprint from request', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const fingerprint = getDeviceFingerprint(req);
        expect(fingerprint).toBeDefined();
        expect(fingerprint?.hash).toBeDefined();
      });

      it('should return undefined for non-processed request', () => {
        const req = createMockRequest();
        const fingerprint = getDeviceFingerprint(req);
        expect(fingerprint).toBeUndefined();
      });
    });

    describe('getDeviceFingerprintHash', () => {
      it('should return fingerprint hash from request', () => {
        const req = createMockRequest();
        const res = createMockResponse();
        const next = jest.fn();

        middleware.use(req, res, next);

        const hash = getDeviceFingerprintHash(req);
        expect(hash).toBeDefined();
        expect(hash).toMatch(/^fp_[a-f0-9]{32}$/);
      });

      it('should return undefined for non-processed request', () => {
        const req = createMockRequest();
        const hash = getDeviceFingerprintHash(req);
        expect(hash).toBeUndefined();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing headers gracefully', () => {
      const req = {
        headers: {},
        ip: undefined,
        socket: {},
      } as unknown as Request;
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprintHash).toBeDefined();
      expect(fingerprintedReq.deviceFingerprint?.userAgent).toBe('unknown');
      expect(fingerprintedReq.deviceFingerprint?.acceptLanguage).toBe('unknown');
    });

    it('should call next function', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should handle very long user agents', () => {
      const longUserAgent = 'Mozilla/5.0 ' + 'x'.repeat(1000);
      const req = createMockRequest({
        'user-agent': longUserAgent,
      });
      const res = createMockResponse();
      const next = jest.fn();

      middleware.use(req, res, next);

      const fingerprintedReq = req as FingerprintedRequest;
      expect(fingerprintedReq.deviceFingerprint?.userAgent).toBe(longUserAgent);
      expect(fingerprintedReq.deviceFingerprintHash).toBeDefined();
    });
  });

  describe('Performance', () => {
    it('should handle rapid fingerprinting efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 10000; i++) {
        const req = createMockRequest({
          'user-agent': `Mozilla/5.0 Test/${i}`,
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
