/**
 * Security Headers Middleware
 *
 * Adds comprehensive security headers to all responses.
 * Implements OWASP security best practices.
 * Configurable for different security levels and environments.
 */

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * Security header configuration
 */
export interface SecurityHeadersConfig {
  contentSecurityPolicy?: string;
  strictTransportSecurity?: string;
  xContentTypeOptions?: string;
  xFrameOptions?: string;
  xXssProtection?: string;
  referrerPolicy?: string;
  permissionsPolicy?: string;
  crossOriginEmbedderPolicy?: string;
  crossOriginOpenerPolicy?: string;
  crossOriginResourcePolicy?: string;
}

/**
 * Security Headers Middleware
 * Implements comprehensive security headers for defense in depth
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SecurityHeadersMiddleware.name);
  private readonly isProduction: boolean;
  private readonly config: SecurityHeadersConfig;

  constructor(private readonly configService: ConfigService) {
    this.isProduction = this.configService.get('NODE_ENV') === 'production';
    this.config = this.buildSecurityConfig();

    this.logger.log(
      `SecurityHeadersMiddleware initialized (production: ${this.isProduction})`,
    );
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // Apply all security headers
    this.setContentSecurityPolicy(res);
    this.setStrictTransportSecurity(res);
    this.setXContentTypeOptions(res);
    this.setXFrameOptions(res);
    this.setXXssProtection(res);
    this.setReferrerPolicy(res);
    this.setPermissionsPolicy(res);
    this.setCrossOriginPolicies(res);
    this.removeUnsafeHeaders(res);

    next();
  }

  /**
   * Build security configuration based on environment
   */
  private buildSecurityConfig(): SecurityHeadersConfig {
    const customCsp = this.configService.get<string>('SECURITY_CSP');

    return {
      contentSecurityPolicy:
        customCsp ||
        this.buildDefaultCsp(),
      strictTransportSecurity:
        this.configService.get<string>(
          'SECURITY_HSTS',
          'max-age=31536000; includeSubDomains; preload',
        ),
      xContentTypeOptions: 'nosniff',
      xFrameOptions: this.configService.get<string>(
        'SECURITY_FRAME_OPTIONS',
        'DENY',
      ),
      xXssProtection: '1; mode=block',
      referrerPolicy: this.configService.get<string>(
        'SECURITY_REFERRER_POLICY',
        'strict-origin-when-cross-origin',
      ),
      permissionsPolicy: this.buildPermissionsPolicy(),
      crossOriginEmbedderPolicy: 'require-corp',
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-origin',
    };
  }

  /**
   * Build default Content Security Policy
   */
  private buildDefaultCsp(): string {
    const directives: string[] = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'", // May need adjustment for GraphQL Playground
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
    ];

    if (!this.isProduction) {
      // Allow WebSocket connections in development
      directives.push("connect-src 'self' ws: wss: https:");
    }

    return directives.join('; ');
  }

  /**
   * Build Permissions Policy
   */
  private buildPermissionsPolicy(): string {
    const permissions: string[] = [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'cross-origin-isolated=()',
      'display-capture=()',
      'encrypted-media=()',
      'fullscreen=(self)',
      'geolocation=()',
      'gyroscope=()',
      'keyboard-map=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=()',
      'xr-spatial-tracking=()',
    ];

    return permissions.join(', ');
  }

  /**
   * Set Content-Security-Policy header
   */
  private setContentSecurityPolicy(res: Response): void {
    if (this.config.contentSecurityPolicy) {
      res.setHeader('Content-Security-Policy', this.config.contentSecurityPolicy);
    }
  }

  /**
   * Set Strict-Transport-Security header
   */
  private setStrictTransportSecurity(res: Response): void {
    if (this.isProduction && this.config.strictTransportSecurity) {
      res.setHeader(
        'Strict-Transport-Security',
        this.config.strictTransportSecurity,
      );
    }
  }

  /**
   * Set X-Content-Type-Options header
   */
  private setXContentTypeOptions(res: Response): void {
    if (this.config.xContentTypeOptions) {
      res.setHeader('X-Content-Type-Options', this.config.xContentTypeOptions);
    }
  }

  /**
   * Set X-Frame-Options header
   */
  private setXFrameOptions(res: Response): void {
    if (this.config.xFrameOptions) {
      res.setHeader('X-Frame-Options', this.config.xFrameOptions);
    }
  }

  /**
   * Set X-XSS-Protection header
   */
  private setXXssProtection(res: Response): void {
    if (this.config.xXssProtection) {
      res.setHeader('X-XSS-Protection', this.config.xXssProtection);
    }
  }

  /**
   * Set Referrer-Policy header
   */
  private setReferrerPolicy(res: Response): void {
    if (this.config.referrerPolicy) {
      res.setHeader('Referrer-Policy', this.config.referrerPolicy);
    }
  }

  /**
   * Set Permissions-Policy header
   */
  private setPermissionsPolicy(res: Response): void {
    if (this.config.permissionsPolicy) {
      res.setHeader('Permissions-Policy', this.config.permissionsPolicy);
    }
  }

  /**
   * Set Cross-Origin policies
   */
  private setCrossOriginPolicies(res: Response): void {
    // These headers can break some functionality, only set in production
    if (this.isProduction) {
      if (this.config.crossOriginEmbedderPolicy) {
        res.setHeader(
          'Cross-Origin-Embedder-Policy',
          this.config.crossOriginEmbedderPolicy,
        );
      }
      if (this.config.crossOriginOpenerPolicy) {
        res.setHeader(
          'Cross-Origin-Opener-Policy',
          this.config.crossOriginOpenerPolicy,
        );
      }
      if (this.config.crossOriginResourcePolicy) {
        res.setHeader(
          'Cross-Origin-Resource-Policy',
          this.config.crossOriginResourcePolicy,
        );
      }
    }
  }

  /**
   * Remove headers that expose server information
   */
  private removeUnsafeHeaders(res: Response): void {
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
  }

  /**
   * Get current configuration (for testing/debugging)
   */
  getConfig(): SecurityHeadersConfig {
    return { ...this.config };
  }
}
