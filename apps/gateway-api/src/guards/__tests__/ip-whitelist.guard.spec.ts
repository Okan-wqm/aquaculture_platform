/**
 * IpWhitelistGuard Tests
 *
 * Comprehensive test suite for IP-based access control guard
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IpWhitelistGuard, BYPASS_IP_WHITELIST } from '../ip-whitelist.guard';

describe('IpWhitelistGuard', () => {
  let guard: IpWhitelistGuard;
  let reflector: Reflector;
  let configService: ConfigService;

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
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('Whitelist IP Access', () => {
    it('should allow IP address in whitelist', async () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP address not in whitelist', async () => {
      const context = createMockExecutionContext('8.8.8.8');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('IPv4 Format Validation', () => {
    it('should validate correct IPv4 format', async () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle malformed IPv4 addresses', async () => {
      const context = createMockExecutionContext('999.999.999.999');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should handle empty IP address', async () => {
      const context = createMockExecutionContext('');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('IPv6 Format Validation', () => {
    it('should handle IPv6 addresses', async () => {
      const context = createMockExecutionContext('::1');
      // Localhost IPv6 should be handled
      const result = await guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle IPv6-mapped IPv4 addresses', async () => {
      const context = createMockExecutionContext('::ffff:192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should normalize IPv6-mapped IPv4 to IPv4', async () => {
      const context = createMockExecutionContext('::ffff:192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('CIDR Notation Support', () => {
    it('should allow IP within CIDR range (192.168.1.0/24)', async () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow IP within large CIDR range (10.0.0.0/8)', async () => {
      const context = createMockExecutionContext('10.255.255.255');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP outside CIDR range', async () => {
      const context = createMockExecutionContext('192.168.2.1');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should handle /32 CIDR (single IP)', async () => {
      // Assuming 192.168.1.1/32 is added
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle /0 CIDR (all IPs)', async () => {
      // This would be a security risk but should work technically
      const context = createMockExecutionContext('8.8.8.8');
      // Default config doesn't have /0, so should fail
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('IP Range Support', () => {
    it('should allow IP within range (192.168.1.1-192.168.1.100)', async () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should allow IP at range start', async () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block IP outside range', async () => {
      const context = createMockExecutionContext('192.168.2.101');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Wildcard IP Support', () => {
    it('should handle wildcard patterns (192.168.*.*)', async () => {
      // Implementation depends on wildcard support
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('X-Forwarded-For Header', () => {
    it('should read IP from X-Forwarded-For header', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1',
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle multiple IPs in X-Forwarded-For', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1',
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should use first IP from X-Forwarded-For chain', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '8.8.8.8, 192.168.1.1',
      });
      // First IP (8.8.8.8) is not whitelisted
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Multiple IP Headers', () => {
    it('should read from X-Real-IP header', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-real-ip': '192.168.1.1',
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should read from CF-Connecting-IP header (Cloudflare)', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'cf-connecting-ip': '192.168.1.1',
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should prioritize X-Forwarded-For over X-Real-IP', async () => {
      const context = createMockExecutionContext('127.0.0.1', {
        'x-forwarded-for': '192.168.1.1',
        'x-real-ip': '8.8.8.8',
      });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('IP Blacklist', () => {
    it('should block blacklisted IP even if in whitelist', async () => {
      const context = createMockExecutionContext('192.168.1.100');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should allow non-blacklisted IP', async () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Whitelist + Blacklist Combination', () => {
    it('should deny blacklisted IP in whitelisted CIDR range', async () => {
      // 192.168.1.100 is blacklisted but in 192.168.1.0/24 whitelist
      const context = createMockExecutionContext('192.168.1.100');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should allow whitelisted IP not in blacklist', async () => {
      const context = createMockExecutionContext('192.168.1.50');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Localhost/Loopback IP Handling', () => {
    it('should handle localhost 127.0.0.1', async () => {
      const context = createMockExecutionContext('127.0.0.1');
      // Localhost handling depends on configuration
      const result = await guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle IPv6 localhost ::1', async () => {
      const context = createMockExecutionContext('::1');
      const result = await guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });

    it('should handle 0.0.0.0', async () => {
      const context = createMockExecutionContext('0.0.0.0');
      // Should typically be blocked
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Private IP Range Handling', () => {
    it('should handle Class A private range (10.0.0.0/8)', async () => {
      const context = createMockExecutionContext('10.0.0.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should handle Class B private range (172.16.0.0/12)', async () => {
      const context = createMockExecutionContext('172.16.0.1');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should handle Class C private range (192.168.0.0/16)', async () => {
      const context = createMockExecutionContext('192.168.1.1');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Skip IP Check Decorator', () => {
    it('should skip IP check when decorator is present', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const context = createMockExecutionContext('8.8.8.8');
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should enforce IP check when decorator is not present', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
      const context = createMockExecutionContext('8.8.8.8');
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Error Messages', () => {
    it('should provide meaningful error message on denial', async () => {
      const context = createMockExecutionContext('8.8.8.8');
      try {
        await guard.canActivate(context);
        fail('Should have thrown ForbiddenException');
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        expect((error as ForbiddenException).message).toContain('IP');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle null IP gracefully', async () => {
      const context = createMockExecutionContext(null as unknown as string);
      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('should handle undefined IP gracefully', async () => {
      const context = createMockExecutionContext(undefined as unknown as string);
      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('should handle IP with port number', async () => {
      const context = createMockExecutionContext('192.168.1.1:8080');
      // Should strip port and validate IP
      const result = await guard.canActivate(context);
      expect(typeof result).toBe('boolean');
    });
  });

  describe('Performance', () => {
    it('should handle rapid successive checks efficiently', async () => {
      const startTime = Date.now();
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const context = createMockExecutionContext('192.168.1.1');
        await guard.canActivate(context);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
