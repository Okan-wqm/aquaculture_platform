/**
 * IP Whitelist Guard
 *
 * Provides IP-based access control for the gateway.
 * Supports CIDR ranges, individual IPs, and wildcard patterns.
 * Enterprise-grade with configurable whitelists per tenant.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Request } from 'express';

/**
 * Metadata key for bypassing IP whitelist
 */
export const BYPASS_IP_WHITELIST = 'bypassIpWhitelist';

/**
 * Decorator to bypass IP whitelist for specific endpoints
 */
export const BypassIpWhitelist = (): ReturnType<typeof SetMetadata> => SetMetadata(BYPASS_IP_WHITELIST, true);

/**
 * IP Range interface
 */
interface IpRange {
  start: number;
  end: number;
}

/**
 * User payload interface
 */
interface UserPayload {
  tenantId?: string;
}

/**
 * Extended request interface for IP whitelist
 */
interface IpWhitelistRequest extends Omit<Request, 'connection' | 'socket'> {
  tenantId?: string;
  user?: UserPayload;
  connection?: {
    remoteAddress?: string;
  };
  socket?: {
    remoteAddress?: string;
  };
}

/**
 * GraphQL context interface
 */
interface GqlContext {
  req?: IpWhitelistRequest;
}

/**
 * IP Whitelist Guard
 * Validates incoming requests against configured IP whitelists
 */
@Injectable()
export class IpWhitelistGuard implements CanActivate {
  private readonly logger = new Logger(IpWhitelistGuard.name);
  private readonly globalWhitelist: Set<string>;
  private readonly cidrRanges: IpRange[];
  private readonly tenantWhitelists: Map<string, Set<string>>;
  private readonly enabled: boolean;
  // SECURITY: Trusted proxies that are allowed to set X-Forwarded-For
  private readonly trustedProxies: Set<string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    this.enabled = this.configService.get<boolean>('IP_WHITELIST_ENABLED', false);
    this.globalWhitelist = this.parseWhitelist(
      this.configService.get<string>('IP_WHITELIST', ''),
    );
    this.cidrRanges = this.parseCidrRanges(
      this.configService.get<string>('IP_WHITELIST_CIDR', ''),
    );
    this.tenantWhitelists = new Map();

    // SECURITY: Only trust X-Forwarded-For from these proxy IPs
    // Set TRUSTED_PROXIES env var (comma-separated) for production
    const trustedProxiesStr = this.configService.get<string>('TRUSTED_PROXIES', '127.0.0.1,::1');
    this.trustedProxies = new Set(trustedProxiesStr.split(',').map(ip => ip.trim()).filter(Boolean));

    // Always allow localhost and private networks by default
    this.globalWhitelist.add('127.0.0.1');
    this.globalWhitelist.add('::1');
    this.globalWhitelist.add('localhost');

    this.logger.log(
      `IpWhitelistGuard initialized with ${this.globalWhitelist.size} whitelisted IPs, ${this.cidrRanges.length} CIDR ranges, and ${this.trustedProxies.size} trusted proxies`,
    );
  }

  canActivate(context: ExecutionContext): boolean {
    // Check if guard is disabled
    if (!this.enabled) {
      return true;
    }

    // Check if endpoint bypasses IP whitelist
    const bypass = this.reflector.getAllAndOverride<boolean>(BYPASS_IP_WHITELIST, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (bypass) {
      return true;
    }

    const request = this.getRequest(context);
    const clientIp = this.extractClientIp(request);

    if (!clientIp) {
      this.logger.warn('Could not extract client IP from request');
      throw new ForbiddenException('Unable to verify client IP');
    }

    // Check global whitelist
    if (this.isIpWhitelisted(clientIp)) {
      return true;
    }

    // Check CIDR ranges
    if (this.isIpInCidrRange(clientIp)) {
      return true;
    }

    // Check tenant-specific whitelist
    const tenantId = this.extractTenantId(request);
    if (tenantId && this.isTenantIpWhitelisted(tenantId, clientIp)) {
      return true;
    }

    this.logger.warn(
      `IP ${clientIp} not in whitelist${tenantId ? ` for tenant ${tenantId}` : ''}`,
    );

    throw new ForbiddenException('Access denied from this IP address');
  }

  /**
   * Get request from execution context (supports HTTP and GraphQL)
   */
  private getRequest(context: ExecutionContext): IpWhitelistRequest {
    const gqlContext = GqlExecutionContext.create(context);
    const ctx = gqlContext.getContext<GqlContext>();
    const gqlRequest = ctx?.req;

    if (gqlRequest) {
      return gqlRequest;
    }

    return context.switchToHttp().getRequest<IpWhitelistRequest>();
  }

  /**
   * Extract client IP from request
   * SECURITY: Only trusts X-Forwarded-For from configured trusted proxies
   */
  private extractClientIp(request: IpWhitelistRequest): string | null {
    // Get the direct connection IP first
    const directIp = this.normalizeIp(
      request.ip ||
      request.connection?.remoteAddress ||
      request.socket?.remoteAddress ||
      ''
    );

    // SECURITY: Only trust X-Forwarded-For if request comes from a trusted proxy
    if (directIp && this.trustedProxies.has(directIp)) {
      // Check X-Forwarded-For header (for proxied requests from trusted proxy)
      const forwardedFor = request.headers?.['x-forwarded-for'];
      if (typeof forwardedFor === 'string') {
        const ips = forwardedFor.split(',').map((ip: string) => ip.trim());
        if (ips[0]) {
          return ips[0];
        }
      }

      // Check X-Real-IP header (for proxied requests from trusted proxy)
      const realIp = request.headers?.['x-real-ip'];
      if (typeof realIp === 'string') {
        return realIp;
      }
    }

    // Fall back to direct connection IP (or if not from trusted proxy, ignore forwarded headers)
    return directIp || null;
  }

  /**
   * Extract tenant ID from request
   */
  private extractTenantId(request: IpWhitelistRequest): string | null {
    const tenantIdHeader = request.headers?.['x-tenant-id'];
    return (
      request.tenantId ||
      (typeof tenantIdHeader === 'string' ? tenantIdHeader : null) ||
      request.user?.tenantId ||
      null
    );
  }

  /**
   * Check if IP is in global whitelist
   */
  isIpWhitelisted(ip: string): boolean {
    // Normalize IPv6-mapped IPv4 addresses
    const normalizedIp = this.normalizeIp(ip);
    return this.globalWhitelist.has(normalizedIp);
  }

  /**
   * Check if IP is in tenant-specific whitelist
   */
  isTenantIpWhitelisted(tenantId: string, ip: string): boolean {
    const tenantWhitelist = this.tenantWhitelists.get(tenantId);
    if (!tenantWhitelist) {
      return false;
    }

    const normalizedIp = this.normalizeIp(ip);
    return tenantWhitelist.has(normalizedIp);
  }

  /**
   * Check if IP is within any CIDR range
   */
  isIpInCidrRange(ip: string): boolean {
    const ipNum = this.ipToNumber(this.normalizeIp(ip));
    if (ipNum === null) {
      return false;
    }

    return this.cidrRanges.some(
      (range) => ipNum >= range.start && ipNum <= range.end,
    );
  }

  /**
   * Parse whitelist string into Set
   */
  private parseWhitelist(whitelist: string): Set<string> {
    const set = new Set<string>();
    if (!whitelist) {
      return set;
    }

    whitelist.split(',').forEach((ip) => {
      const trimmed = ip.trim();
      if (trimmed) {
        set.add(this.normalizeIp(trimmed));
      }
    });

    return set;
  }

  /**
   * Parse CIDR ranges string
   */
  private parseCidrRanges(cidrString: string): IpRange[] {
    const ranges: IpRange[] = [];
    if (!cidrString) {
      return ranges;
    }

    cidrString.split(',').forEach((cidr) => {
      const trimmed = cidr.trim();
      if (trimmed) {
        const range = this.cidrToRange(trimmed);
        if (range) {
          ranges.push(range);
        }
      }
    });

    return ranges;
  }

  /**
   * Convert CIDR notation to IP range
   */
  cidrToRange(cidr: string): IpRange | null {
    const parts = cidr.split('/');
    if (parts.length !== 2) {
      this.logger.warn(`Invalid CIDR notation: ${cidr}`);
      return null;
    }

    const ip = parts[0];
    const prefixLength = parseInt(parts[1] || '32', 10);

    if (isNaN(prefixLength) || prefixLength < 0 || prefixLength > 32) {
      this.logger.warn(`Invalid CIDR prefix length: ${cidr}`);
      return null;
    }

    const ipNum = this.ipToNumber(ip || '');
    if (ipNum === null) {
      return null;
    }

    const mask = ~((1 << (32 - prefixLength)) - 1) >>> 0;
    const start = (ipNum & mask) >>> 0;
    const end = (start | ~mask) >>> 0;

    return { start, end };
  }

  /**
   * Convert IP address to number
   */
  ipToNumber(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) {
      return null;
    }

    let num = 0;
    for (const part of parts) {
      const octet = parseInt(part, 10);
      if (isNaN(octet) || octet < 0 || octet > 255) {
        return null;
      }
      num = (num << 8) + octet;
    }

    return num >>> 0;
  }

  /**
   * Normalize IP address (handle IPv6-mapped IPv4)
   */
  normalizeIp(ip: string): string {
    // Handle IPv6-mapped IPv4 addresses (e.g., ::ffff:192.168.1.1)
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }
    return ip;
  }

  /**
   * Add IP to tenant whitelist (for dynamic configuration)
   */
  addTenantWhitelistIp(tenantId: string, ip: string): void {
    let tenantWhitelist = this.tenantWhitelists.get(tenantId);
    if (!tenantWhitelist) {
      tenantWhitelist = new Set<string>();
      this.tenantWhitelists.set(tenantId, tenantWhitelist);
    }
    tenantWhitelist.add(this.normalizeIp(ip));
    this.logger.log(`Added IP ${ip} to whitelist for tenant ${tenantId}`);
  }

  /**
   * Remove IP from tenant whitelist
   */
  removeTenantWhitelistIp(tenantId: string, ip: string): void {
    const tenantWhitelist = this.tenantWhitelists.get(tenantId);
    if (tenantWhitelist) {
      tenantWhitelist.delete(this.normalizeIp(ip));
      this.logger.log(`Removed IP ${ip} from whitelist for tenant ${tenantId}`);
    }
  }

  /**
   * Check if an IP would be allowed
   */
  isIpAllowed(ip: string, tenantId?: string): boolean {
    if (!this.enabled) {
      return true;
    }

    if (this.isIpWhitelisted(ip) || this.isIpInCidrRange(ip)) {
      return true;
    }

    if (tenantId && this.isTenantIpWhitelisted(tenantId, ip)) {
      return true;
    }

    return false;
  }
}
