import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IIpValidator, IpExtractionRequest } from '../interfaces';

/**
 * IP Validator Service
 *
 * Provides secure IP address extraction and validation:
 * - Validates IP address formats (IPv4 and IPv6)
 * - Extracts client IP from proxied requests
 * - Validates X-Forwarded-For header chain
 * - Supports trusted proxy configuration
 *
 * SECURITY CONSIDERATIONS:
 * - X-Forwarded-For can be spoofed by clients
 * - Only trust proxies that are under your control
 * - Configure TRUSTED_PROXIES environment variable
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles IP validation/extraction
 * - Interface Segregation: Implements IIpValidator interface
 */
@Injectable()
export class IpValidatorService implements IIpValidator {
  private readonly logger = new Logger(IpValidatorService.name);

  // Trusted proxy IP ranges (CIDR notation supported)
  private readonly trustedProxies: Set<string>;

  // Common private IP ranges
  private readonly privateRanges = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
  ];

  // ReDoS-safe regex patterns
  private readonly ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
  private readonly ipv6Regex =
    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^:(?::[0-9a-fA-F]{1,4}){1,7}$|^::$/;

  constructor(private readonly configService: ConfigService) {
    // Parse trusted proxies from environment
    const trustedProxiesStr = this.configService.get<string>('TRUSTED_PROXIES', '');
    this.trustedProxies = new Set(
      trustedProxiesStr
        .split(',')
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0),
    );

    // Always trust loopback addresses
    this.trustedProxies.add('127.0.0.1');
    this.trustedProxies.add('::1');

    // Log configuration
    if (this.trustedProxies.size > 2) {
      this.logger.log(
        `IP Validator initialized with ${this.trustedProxies.size - 2} custom trusted proxies`,
      );
    }
  }

  /**
   * Extract client IP from request with proxy support
   *
   * Priority order:
   * 1. X-Real-IP (nginx)
   * 2. X-Forwarded-For (first non-trusted IP from right)
   * 3. req.ip (Express with trust proxy)
   * 4. Socket remote address
   *
   * SEC-MEDIUM-069/070 (2026-08-23 scan №14/№15/№32): the CDN headers
   * CF-Connecting-IP / True-Client-IP are CLIENT-SUPPLIABLE on any
   * deployment where that CDN does not terminate in front of nginx —
   * trusting them let one spoofed header rotate throttle/audit identities.
   * A CDN fronting this platform must map its header onto X-Real-IP via
   * nginx's real_ip module; the application trusts proxy-set headers only.
   */
  extractClientIp(request: IpExtractionRequest): string {
    // 1. X-Real-IP (nginx)
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && this.isValidIp(realIp)) {
      return realIp;
    }

    // 2. X-Forwarded-For (most complex, requires validation)
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      const validatedIp = this.validateForwardedFor(
        typeof forwardedFor === 'string' ? forwardedFor : forwardedFor[0] || '',
        Array.from(this.trustedProxies),
      );
      if (validatedIp) {
        return validatedIp;
      }
    }

    // 3. Express req.ip (trust proxy configured)
    if (request.ip && this.isValidIp(request.ip)) {
      const cleanIp = this.cleanIp(request.ip);
      if (!this.isTrustedProxy(cleanIp)) {
        return cleanIp;
      }
    }

    // 4. Socket remote address
    const socketIp = request.socket?.remoteAddress || request.connection?.remoteAddress;
    if (socketIp && this.isValidIp(socketIp)) {
      return this.cleanIp(socketIp);
    }

    // Fallback - should not normally reach here
    this.logger.warn('Could not determine client IP, using fallback');
    return 'unknown';
  }

  /**
   * Validate IP address format
   */
  isValidIp(ip: string): boolean {
    if (!ip || typeof ip !== 'string') return false;

    // Clean IP address
    const cleanedIp = this.cleanIp(ip);

    // Check IPv4
    if (this.ipv4Regex.test(cleanedIp)) {
      return true;
    }

    // Check IPv6
    if (this.ipv6Regex.test(cleanedIp)) {
      return true;
    }

    return false;
  }

  /**
   * Check if IP is in trusted proxy list
   */
  isTrustedProxy(ip: string): boolean {
    const cleanedIp = this.cleanIp(ip);

    // Check exact match
    if (this.trustedProxies.has(cleanedIp)) {
      return true;
    }

    // Check private ranges (usually proxies are on private networks)
    if (this.isPrivateIp(cleanedIp)) {
      // Only trust private IPs if explicitly configured or loopback
      return cleanedIp === '127.0.0.1' || cleanedIp === '::1';
    }

    return false;
  }

  /**
   * Validate X-Forwarded-For header chain
   * Returns the first non-trusted IP from the right side of the chain.
   *
   * X-Forwarded-For format: client, proxy1, proxy2
   * We traverse from right to left, skipping trusted proxies.
   */
  validateForwardedFor(header: string, trustedProxies: string[]): string | null {
    if (!header || typeof header !== 'string') return null;

    // Limit header length to prevent DoS
    if (header.length > 1000) {
      this.logger.warn('X-Forwarded-For header too long, ignoring');
      return null;
    }

    // Split and clean IPs
    const ips = header
      .split(',')
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0);

    // Limit number of IPs to prevent DoS
    if (ips.length > 20) {
      this.logger.warn('X-Forwarded-For has too many IPs, limiting to last 20');
      ips.splice(0, ips.length - 20);
    }

    const trustedSet = new Set(trustedProxies);

    // Traverse from right to left
    for (let i = ips.length - 1; i >= 0; i--) {
      const ip = ips[i];
      if (!ip) continue;

      // Validate IP format
      if (!this.isValidIp(ip)) {
        this.logger.warn(`Invalid IP in X-Forwarded-For: ${ip}`);
        continue;
      }

      const cleanedIp = this.cleanIp(ip);

      // If not a trusted proxy, this is our client IP
      if (!trustedSet.has(cleanedIp) && !this.isPrivateIp(cleanedIp)) {
        return cleanedIp;
      }
    }

    // If all IPs are trusted/private, return the leftmost (original client)
    const firstIp = ips[0];
    if (firstIp && this.isValidIp(firstIp)) {
      return this.cleanIp(firstIp);
    }

    return null;
  }

  /**
   * Check if IP is in private range
   */
  isPrivateIp(ip: string): boolean {
    const cleanedIp = this.cleanIp(ip);

    // IPv4 private ranges
    if (this.ipv4Regex.test(cleanedIp)) {
      const parts = cleanedIp.split('.').map(Number);

      // 10.0.0.0/8
      if (parts[0] === 10) return true;

      // 172.16.0.0/12
      if (parts[0] === 172 && parts[1] !== undefined && parts[1] >= 16 && parts[1] <= 31)
        return true;

      // 192.168.0.0/16
      if (parts[0] === 192 && parts[1] === 168) return true;

      // 127.0.0.0/8 (loopback)
      if (parts[0] === 127) return true;

      // 169.254.0.0/16 (link-local)
      if (parts[0] === 169 && parts[1] === 254) return true;
    }

    // IPv6 private ranges
    if (cleanedIp === '::1') return true;
    if (cleanedIp.toLowerCase().startsWith('fc') || cleanedIp.toLowerCase().startsWith('fd'))
      return true;
    if (cleanedIp.toLowerCase().startsWith('fe80')) return true;

    return false;
  }

  /**
   * Clean IP address (remove IPv6 prefix, trim, lowercase)
   */
  private cleanIp(ip: string): string {
    let cleaned = ip.trim();

    // Remove IPv4-mapped IPv6 prefix
    if (cleaned.startsWith('::ffff:')) {
      cleaned = cleaned.substring(7);
    }

    return cleaned;
  }

  /**
   * Get configured trusted proxies
   */
  getTrustedProxies(): string[] {
    return Array.from(this.trustedProxies);
  }

  /**
   * Add a trusted proxy at runtime
   */
  addTrustedProxy(ip: string): void {
    if (this.isValidIp(ip)) {
      this.trustedProxies.add(this.cleanIp(ip));
      this.logger.log(`Added trusted proxy: ${ip}`);
    }
  }

  /**
   * Remove a trusted proxy at runtime
   */
  removeTrustedProxy(ip: string): void {
    const cleanedIp = this.cleanIp(ip);
    if (cleanedIp !== '127.0.0.1' && cleanedIp !== '::1') {
      this.trustedProxies.delete(cleanedIp);
      this.logger.log(`Removed trusted proxy: ${ip}`);
    }
  }
}
