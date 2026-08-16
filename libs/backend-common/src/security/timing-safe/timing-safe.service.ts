import * as crypto from 'crypto';

import { Injectable } from '@nestjs/common';

/**
 * Timing Safe Service
 *
 * Provides utilities to prevent timing attacks:
 * - Constant-time string comparison
 * - Constant-time password verification
 * - Constant-time token validation
 * - Jitter for response times
 *
 * Timing attacks exploit the time difference in operations to infer information.
 * For example, a naive string comparison that returns early on first mismatch
 * can reveal how many characters match.
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles timing-safe operations
 */
@Injectable()
export class TimingSafeService {
  /**
   * Constant-time string comparison
   * Compares two strings in constant time to prevent timing attacks.
   *
   * @param a - First string
   * @param b - Second string
   * @returns true if strings are equal
   *
   * @example
   * // Use for comparing tokens, signatures, etc.
   * const isValid = timingSafe.compare(providedToken, storedToken);
   */
  compare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    // Convert to buffers
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');

    // If lengths differ, we still need constant-time comparison
    // to prevent length oracle attacks
    if (bufA.length !== bufB.length) {
      // Compare against itself to maintain constant time
      // but always return false
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Constant-time buffer comparison
   *
   * @param a - First buffer
   * @param b - Second buffer
   * @returns true if buffers are equal
   */
  compareBuffers(a: Buffer, b: Buffer): boolean {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      return false;
    }

    if (a.length !== b.length) {
      crypto.timingSafeEqual(a, a);
      return false;
    }

    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Compare hex-encoded strings in constant time
   *
   * @param a - First hex string
   * @param b - Second hex string
   * @returns true if hex strings are equal
   */
  compareHex(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a, 'hex');
      const bufB = Buffer.from(b, 'hex');
      return this.compareBuffers(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Add random jitter to response time
   * Helps prevent timing attacks by making response times less predictable.
   *
   * @param minMs - Minimum delay in milliseconds
   * @param maxMs - Maximum delay in milliseconds
   *
   * @example
   * // Add 50-150ms jitter to login response
   * await timingSafe.addJitter(50, 150);
   */
  async addJitter(minMs = 0, maxMs = 100): Promise<void> {
    const jitter = this.secureRandomInRange(minMs, maxMs);
    await this.sleep(jitter);
  }

  /**
   * Ensure minimum response time
   * Useful for making failed/successful operations take the same time.
   *
   * @param startTime - Start time from Date.now()
   * @param minDurationMs - Minimum duration in milliseconds
   *
   * @example
   * const startTime = Date.now();
   * // Do operation (may be fast or slow)
   * await timingSafe.ensureMinDuration(startTime, 200);
   */
  async ensureMinDuration(startTime: number, minDurationMs: number): Promise<void> {
    const elapsed = Date.now() - startTime;
    const remaining = minDurationMs - elapsed;

    if (remaining > 0) {
      // Add some jitter to the remaining time
      const jitter = this.secureRandomInRange(0, 50);
      await this.sleep(remaining + jitter);
    }
  }

  /**
   * Constant-time validation with uniform response time
   * Executes validation and ensures minimum response time regardless of result.
   *
   * @param validator - Async validation function
   * @param minDurationMs - Minimum duration for the entire operation
   * @returns Validation result
   *
   * @example
   * const isValid = await timingSafe.validateWithUniformTime(
   *   async () => this.verifyPassword(password, hash),
   *   200, // Always takes at least 200ms
   * );
   */
  async validateWithUniformTime<T>(validator: () => Promise<T>, minDurationMs = 200): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await validator();
      await this.ensureMinDuration(startTime, minDurationMs);
      return result;
    } catch (error) {
      await this.ensureMinDuration(startTime, minDurationMs);
      throw error;
    }
  }

  /**
   * Hash-based message authentication code comparison
   * Compares two HMACs in constant time.
   *
   * @param hmac1 - First HMAC (hex string)
   * @param hmac2 - Second HMAC (hex string)
   * @returns true if HMACs are equal
   */
  compareHmac(hmac1: string, hmac2: string): boolean {
    return this.compareHex(hmac1, hmac2);
  }

  /**
   * Generate cryptographically secure random number in range
   *
   * @param min - Minimum value (inclusive)
   * @param max - Maximum value (exclusive)
   * @returns Random number in range
   */
  secureRandomInRange(min: number, max: number): number {
    const range = max - min;
    if (range <= 0) return min;

    // Use crypto.randomInt for secure random generation
    return crypto.randomInt(min, max);
  }

  /**
   * Generate secure random bytes
   *
   * @param length - Number of bytes
   * @returns Random bytes as Buffer
   */
  randomBytes(length: number): Buffer {
    return crypto.randomBytes(length);
  }

  /**
   * Generate secure random hex string
   *
   * @param length - Number of bytes (hex string will be 2x length)
   * @returns Random hex string
   */
  randomHex(length: number): string {
    return crypto.randomBytes(length).toString('hex');
  }

  /**
   * Sleep for specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
