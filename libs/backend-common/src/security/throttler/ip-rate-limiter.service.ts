import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * IP-based Rate Limiter Service
 *
 * Provides specialized IP-based rate limiting with:
 * - Configurable limits per IP
 * - Automatic cleanup of expired entries
 * - Support for IP whitelisting
 * - Progressive penalty for repeated violations
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles IP-based rate limiting
 * - Open/Closed: Configurable via environment variables
 */
@Injectable()
export class IpRateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(IpRateLimiterService.name);

  // Rate limit tracking per IP
  private readonly ipRequests = new Map<string, { count: number; resetTime: number }>();

  // Violation tracking for progressive penalties
  private readonly violations = new Map<string, { count: number; lastViolation: number }>();

  // Whitelisted IPs (never rate limited)
  private readonly whitelist: Set<string>;

  // Configuration
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;
  private readonly maxViolations: number;
  private readonly penaltyMultiplier: number;
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(private readonly configService: ConfigService) {
    this.defaultLimit = this.configService.get<number>('IP_RATE_LIMIT', 100);
    this.defaultWindowMs = this.configService.get<number>('IP_RATE_WINDOW_MS', 60000);
    this.maxViolations = this.configService.get<number>('IP_MAX_VIOLATIONS', 10);
    this.penaltyMultiplier = this.configService.get<number>('IP_PENALTY_MULTIPLIER', 2);

    // Parse whitelisted IPs from environment
    const whitelistStr = this.configService.get<string>('IP_WHITELIST', '');
    this.whitelist = new Set(
      whitelistStr.split(',').map(ip => ip.trim()).filter(ip => ip.length > 0),
    );

    // Add common internal IPs
    this.whitelist.add('127.0.0.1');
    this.whitelist.add('::1');

    // Cleanup every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    this.logger.log(
      `IP Rate Limiter initialized: ${this.defaultLimit} requests per ${this.defaultWindowMs / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.ipRequests.clear();
    this.violations.clear();
  }

  /**
   * Check if IP should be rate limited
   * @returns Object with allowed status and retry-after seconds
   */
  checkLimit(ip: string): { allowed: boolean; remaining: number; retryAfter?: number } {
    // Skip whitelisted IPs
    if (this.whitelist.has(ip)) {
      return { allowed: true, remaining: this.defaultLimit };
    }

    const now = Date.now();
    const limit = this.getEffectiveLimit(ip);
    const entry = this.ipRequests.get(ip);

    // No existing entry or window expired
    if (!entry || now > entry.resetTime) {
      this.ipRequests.set(ip, {
        count: 1,
        resetTime: now + this.defaultWindowMs,
      });
      return { allowed: true, remaining: limit - 1 };
    }

    // Increment count
    entry.count++;

    // Check if limit exceeded
    if (entry.count > limit) {
      this.recordViolation(ip);
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    return { allowed: true, remaining: Math.max(0, limit - entry.count) };
  }

  /**
   * Get effective limit for IP (considering violations)
   */
  private getEffectiveLimit(ip: string): number {
    const violation = this.violations.get(ip);
    if (!violation || violation.count === 0) {
      return this.defaultLimit;
    }

    // Reduce limit based on violations
    const penaltyFactor = Math.pow(this.penaltyMultiplier, violation.count);
    return Math.max(1, Math.floor(this.defaultLimit / penaltyFactor));
  }

  /**
   * Record a rate limit violation
   */
  private recordViolation(ip: string): void {
    const existing = this.violations.get(ip) || { count: 0, lastViolation: 0 };

    // Reset violations if last one was more than an hour ago
    const hourAgo = Date.now() - 3600000;
    if (existing.lastViolation < hourAgo) {
      existing.count = 0;
    }

    existing.count = Math.min(existing.count + 1, this.maxViolations);
    existing.lastViolation = Date.now();

    this.violations.set(ip, existing);

    if (existing.count >= this.maxViolations) {
      this.logger.warn(`IP ${ip} has reached maximum violations (${this.maxViolations})`);
    }
  }

  /**
   * Reset rate limit for an IP
   */
  reset(ip: string): void {
    this.ipRequests.delete(ip);
  }

  /**
   * Reset violations for an IP
   */
  resetViolations(ip: string): void {
    this.violations.delete(ip);
  }

  /**
   * Block an IP temporarily
   */
  blockIp(ip: string, durationMs: number): void {
    this.ipRequests.set(ip, {
      count: this.defaultLimit + 1, // Exceed limit
      resetTime: Date.now() + durationMs,
    });
    this.logger.warn(`IP ${ip} blocked for ${durationMs / 1000}s`);
  }

  /**
   * Add IP to whitelist
   */
  addToWhitelist(ip: string): void {
    this.whitelist.add(ip);
    this.logger.log(`IP ${ip} added to whitelist`);
  }

  /**
   * Remove IP from whitelist
   */
  removeFromWhitelist(ip: string): void {
    this.whitelist.delete(ip);
    this.logger.log(`IP ${ip} removed from whitelist`);
  }

  /**
   * Check if IP is whitelisted
   */
  isWhitelisted(ip: string): boolean {
    return this.whitelist.has(ip);
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): {
    trackedIps: number;
    violatingIps: number;
    whitelistedIps: number;
  } {
    return {
      trackedIps: this.ipRequests.size,
      violatingIps: this.violations.size,
      whitelistedIps: this.whitelist.size,
    };
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = Date.now();
    let cleanedRequests = 0;
    let cleanedViolations = 0;

    // Clean expired request entries
    for (const [ip, entry] of this.ipRequests.entries()) {
      if (now > entry.resetTime) {
        this.ipRequests.delete(ip);
        cleanedRequests++;
      }
    }

    // Clean old violations (older than 24 hours)
    const dayAgo = now - 86400000;
    for (const [ip, violation] of this.violations.entries()) {
      if (violation.lastViolation < dayAgo) {
        this.violations.delete(ip);
        cleanedViolations++;
      }
    }

    if (cleanedRequests > 0 || cleanedViolations > 0) {
      this.logger.debug(
        `Cleaned up ${cleanedRequests} request entries and ${cleanedViolations} violation entries`,
      );
    }
  }
}
