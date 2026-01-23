/**
 * Device Fingerprint Middleware
 *
 * Generates and validates device fingerprints for security and analytics.
 * Helps detect suspicious activities and account sharing.
 * Uses a combination of request characteristics for fingerprinting.
 */

import { createHash } from 'crypto';

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Device fingerprint data
 */
export interface DeviceFingerprint {
  hash: string;
  userAgent: string;
  acceptLanguage: string;
  acceptEncoding: string;
  screenResolution?: string;
  timezone?: string;
  platform?: string;
  ip: string;
  timestamp: Date;
}

/**
 * Extended request with device fingerprint
 */
export interface FingerprintedRequest extends Request {
  deviceFingerprint?: DeviceFingerprint;
  deviceFingerprintHash?: string;
}

/**
 * Device Fingerprint Middleware
 * Generates consistent device fingerprints for tracking and security
 */
@Injectable()
export class DeviceFingerprintMiddleware implements NestMiddleware {
  private readonly logger = new Logger(DeviceFingerprintMiddleware.name);
  private readonly headerName = 'x-device-fingerprint';
  private readonly clientFingerprintHeader = 'x-client-fingerprint';

  use(req: Request, res: Response, next: NextFunction): void {
    const fingerprintedReq = req as FingerprintedRequest;

    // Extract device characteristics
    const characteristics = this.extractCharacteristics(req);

    // Generate fingerprint hash
    const fingerprintHash = this.generateFingerprintHash(characteristics);

    // Check for client-provided fingerprint
    const clientFingerprint = req.headers[this.clientFingerprintHeader];
    if (clientFingerprint && typeof clientFingerprint === 'string') {
      // Combine server and client fingerprints
      const combinedHash = this.combineFingerprints(
        fingerprintHash,
        clientFingerprint,
      );
      fingerprintedReq.deviceFingerprintHash = combinedHash;
    } else {
      fingerprintedReq.deviceFingerprintHash = fingerprintHash;
    }

    // Build full fingerprint object
    fingerprintedReq.deviceFingerprint = {
      hash: fingerprintedReq.deviceFingerprintHash,
      userAgent: characteristics.userAgent,
      acceptLanguage: characteristics.acceptLanguage,
      acceptEncoding: characteristics.acceptEncoding,
      screenResolution: characteristics.screenResolution,
      timezone: characteristics.timezone,
      platform: characteristics.platform,
      ip: characteristics.ip,
      timestamp: new Date(),
    };

    // Set fingerprint header in response
    res.setHeader(this.headerName, fingerprintedReq.deviceFingerprintHash);

    next();
  }

  /**
   * Extract device characteristics from request
   */
  private extractCharacteristics(req: Request): {
    userAgent: string;
    acceptLanguage: string;
    acceptEncoding: string;
    screenResolution?: string;
    timezone?: string;
    platform?: string;
    ip: string;
  } {
    const userAgent = (req.headers['user-agent'] as string) || 'unknown';
    const acceptLanguage = (req.headers['accept-language'] as string) || 'unknown';
    const acceptEncoding = (req.headers['accept-encoding'] as string) || 'unknown';

    // Extract from custom headers (if client provides them)
    const screenResolution = req.headers['x-screen-resolution'] as string;
    const timezone = req.headers['x-timezone'] as string;
    const platform = req.headers['sec-ch-ua-platform'] as string;

    // Get IP address
    const ip = this.extractIp(req);

    return {
      userAgent,
      acceptLanguage,
      acceptEncoding,
      screenResolution,
      timezone,
      platform,
      ip,
    };
  }

  /**
   * Extract IP address from request
   */
  private extractIp(req: Request): string {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ips =
        typeof forwardedFor === 'string'
          ? forwardedFor.split(',')
          : forwardedFor;
      return ips[0]?.trim() || 'unknown';
    }

    const realIp = req.headers['x-real-ip'];
    if (realIp && typeof realIp === 'string') {
      return realIp;
    }

    return (
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Generate fingerprint hash from characteristics
   */
  private generateFingerprintHash(characteristics: {
    userAgent: string;
    acceptLanguage: string;
    acceptEncoding: string;
    screenResolution?: string;
    timezone?: string;
    platform?: string;
    ip: string;
  }): string {
    // Build fingerprint string
    const fingerprintParts = [
      characteristics.userAgent,
      characteristics.acceptLanguage,
      characteristics.acceptEncoding,
      characteristics.platform || '',
    ];

    // Note: We intentionally exclude IP for privacy
    // IP is stored in the fingerprint object but not in the hash
    // This allows the same device to have the same fingerprint across IPs

    const fingerprintString = fingerprintParts.join('|');

    // Generate SHA-256 hash
    const hash = createHash('sha256')
      .update(fingerprintString)
      .digest('hex')
      .substring(0, 32); // Use first 32 chars for shorter fingerprint

    return `fp_${hash}`;
  }

  /**
   * Combine server and client fingerprints
   */
  private combineFingerprints(
    serverFingerprint: string,
    clientFingerprint: string,
  ): string {
    const combined = `${serverFingerprint}:${clientFingerprint}`;
    const hash = createHash('sha256')
      .update(combined)
      .digest('hex')
      .substring(0, 32);

    return `fpc_${hash}`;
  }

  /**
   * Compare two fingerprints for similarity
   */
  static compareFingerprints(fp1: DeviceFingerprint, fp2: DeviceFingerprint): {
    isSame: boolean;
    similarity: number;
    differences: string[];
  } {
    const differences: string[] = [];
    let matches = 0;
    const totalFields = 5;

    if (fp1.userAgent === fp2.userAgent) matches++;
    else differences.push('userAgent');

    if (fp1.acceptLanguage === fp2.acceptLanguage) matches++;
    else differences.push('acceptLanguage');

    if (fp1.platform === fp2.platform) matches++;
    else differences.push('platform');

    if (fp1.timezone === fp2.timezone) matches++;
    else differences.push('timezone');

    if (fp1.screenResolution === fp2.screenResolution) matches++;
    else differences.push('screenResolution');

    const similarity = matches / totalFields;

    return {
      isSame: fp1.hash === fp2.hash,
      similarity,
      differences,
    };
  }

  /**
   * Check if fingerprint matches stored fingerprint
   */
  static isKnownDevice(
    currentFingerprint: DeviceFingerprint,
    storedFingerprints: DeviceFingerprint[],
  ): boolean {
    return storedFingerprints.some((fp) => fp.hash === currentFingerprint.hash);
  }
}

/**
 * Helper to get device fingerprint from request
 */
export function getDeviceFingerprint(req: Request): DeviceFingerprint | undefined {
  return (req as FingerprintedRequest).deviceFingerprint;
}

/**
 * Helper to get device fingerprint hash from request
 */
export function getDeviceFingerprintHash(req: Request): string | undefined {
  return (req as FingerprintedRequest).deviceFingerprintHash;
}
