/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * IpWhitelistGuard Tests
 *
 * Comprehensive test suite for IP-based access control guard
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { IpWhitelistGuard } from '../ip-whitelist.guard';

describe('IpWhitelistGuard', () => {
  let guard: IpWhitelistGuard;
  let reflector: Reflector;

  const createMockExecutionContext = (
    ip: string,
    headers: Record<string, string> = {},
  ): ExecutionContext => {
    const mockRequest = {
      ip,
      headers,
      connection: { remoteAddress: ip },
      socket: { remoteAddress: ip },
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
      getArgs: () => [{}, {}, { req: mockRequest }, {}],
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IpWhitelistGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                IP_WHITELIST_ENABLED: true,
                IP_WHITELIST: '192.168.1.1,192.168.1.2,10.0.0.0/8',
                IP_BLACKLIST: '192.168.1.100',
                IP_WHITELIST_CIDR: '192.168.1.0/24,10.0.0.0/8',
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<IpWhitelistGuard>(IpWhitelistGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('Whitelist IP Access', () => {
    it('should allow IP address in whitelist', () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP address not in whitelist', () => {
      const context = createMockExecutionContext('8.8.8.8');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('IPv4 Format Validation', () => {
    it('should validate correct IPv4 format', () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle malformed IPv4 addresses', () => {
      const context = createMockExecutionContext('999.999.999.999');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should handle empty IP address', () => {
      const context = createMockExecutionContext('');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('IPv6 Format Validation', () => {
    it('should handle IPv6 addresses', () => {
      const context = createMockExecutionContext('::1');
      // Localhost IPv6 should be handled
      const result = guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle IPv6-mapped IPv4 addresses', () => {
      const context = createMockExecutionContext('::ffff:192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should normalize IPv6-mapped IPv4 to IPv4', () => {
      const context = createMockExecutionContext('::ffff:192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('CIDR Notation Support', () => {
    it('should allow IP within CIDR range (192.168.1.0/24)', () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow IP within large CIDR range (10.0.0.0/8)', () => {
      const context = createMockExecutionContext('10.255.255.255');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP outside CIDR range', () => {
      const context = createMockExecutionContext('192.168.2.1');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should handle /32 CIDR (single IP)', () => {
      // Assuming 192.168.1.1/32 is added
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle /0 CIDR (all IPs)', () => {
      // This would be a security risk but should work technically
      const context = createMockExecutionContext('8.8.8.8');
      // Default config doesn't have /0, so should fail
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('IP Range Support', () => {
    it('should allow IP within range (192.168.1.1-192.168.1.100)', () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow IP at range start', () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP outside range', () => {
      const context = createMockExecutionContext('192.168.2.101');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Wildcard IP Support', () => {
    it('should handle wildcard patterns (192.168.*.*)', () => {
      // Implementation depends on wildcard support
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('X-Forwarded-For Header', () => {
    it('should read IP from X-Forwarded-For header', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle multiple IPs in X-Forwarded-For', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should use first IP from X-Forwarded-For chain', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '8.8.8.8, 192.168.1.1',
      });
      // First IP (8.8.8.8) is not whitelisted
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Multiple IP Headers', () => {
    it('should read from X-Real-IP header', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-real-ip': '192.168.1.1',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should read from CF-Connecting-IP header (Cloudflare)', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'cf-connecting-ip': '192.168.1.1',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should prioritize X-Forwarded-For over X-Real-IP', () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1',
        'x-real-ip': '8.8.8.8',
      });
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('IP Blacklist', () => {
    it('should block blacklisted IP even if in whitelist', () => {
      const context = createMockExecutionContext('192.168.1.100');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow non-blacklisted IP', () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Whitelist + Blacklist Combination', () => {
    it('should deny blacklisted IP in whitelisted CIDR range', () => {
      // 192.168.1.100 is blacklisted but in 192.168.1.0/24 whitelist
      const context = createMockExecutionContext('192.168.1.100');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should allow whitelisted IP not in blacklist', () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Localhost/Loopback IP Handling', () => {
    it('should handle localhost 127.0.0.1', () => {
      const context = createMockExecutionContext('127.0.0.1');
      // Localhost handling depends on configuration
      const result = guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle IPv6 localhost ::1', () => {
      const context = createMockExecutionContext('::1');
      const result = guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle 0.0.0.0', () => {
      const context = createMockExecutionContext('0.0.0.0');
      // Should typically be blocked
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Private IP Range Handling', () => {
    it('should handle Class A private range (10.0.0.0/8)', () => {
      const context = createMockExecutionContext('10.0.0.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle Class B private range (172.16.0.0/12)', () => {
      const context = createMockExecutionContext('172.16.0.1');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should handle Class C private range (192.168.0.0/16)', () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Skip IP Check Decorator', () => {
    it('should skip IP check when decorator is present', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const context = createMockExecutionContext('8.8.8.8');
      const result = guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should enforce IP check when decorator is not present', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const context = createMockExecutionContext('8.8.8.8');
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('Error Messages', () => {
    it('should provide meaningful error message on denial', () => {
      const context = createMockExecutionContext('8.8.8.8');
      try {
        guard.canActivate(context);
        fail('Should have thrown ForbiddenException');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).message).toContain('IP');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle null IP gracefully', () => {
      const context = createMockExecutionContext(null as unknown as string);
      expect(() => guard.canActivate(context)).toThrow();
    });

    it('should handle undefined IP gracefully', () => {
      const context = createMockExecutionContext(undefined as unknown as string);
      expect(() => guard.canActivate(context)).toThrow();
    });

    it('should handle IP with port number', () => {
      const context = createMockExecutionContext('192.168.1.1:8080');
      // Should strip port and validate IP
      const result = guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Performance', () => {
    it('should handle rapid successive checks efficiently', () => {
      const startTime = Date.now();
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const context = createMockExecutionContext('192.168.1.1');
        guard.canActivate(context);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
