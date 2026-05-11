/**
 * Security Headers Middleware
 *
 * Adds comprehensive security headers to all responses.
 * Implements OWASP security best practices.
 * Configurable for different security levels and environments.
 */

import { randomBytes } from 'node:crypto';

import { Injectable, NestMiddleware, Logger, Inject } from '@nestjs/common';
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
  /**
   * SECREV-LOW-002 cure: feature-flag-driven CSP nonce mode.
   *
   * When `SECURITY_CSP_NONCE_MODE=true`, every request gets a fresh
   * 128-bit nonce attached to `res.locals.cspNonce` and the CSP's
   * `style-src` (and optionally `script-src`) directives swap
   * `'unsafe-inline'` for `'nonce-${nonce}'`. View renderers that
   * need to emit `<style nonce="..."` use the same nonce from
   * `res.locals.cspNonce`.
   *
   * The flag is OFF by default to preserve current rendering
   * (the platform's mixed inline-style surface needs an audit
   * before we can flip the flag globally — tracked as the
   * SECREV-LOW-002 follow-on for the CSS-architecture refactor).
   * Operators can enable it per-deployment to validate without
   * breaking the rendering path.
   */
  private readonly nonceMode: boolean;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.isProduction = this.configService.get('NODE_ENV') === 'production';
    this.nonceMode =
      this.configService.get<string>('SECURITY_CSP_NONCE_MODE') === 'true';
    this.config = this.buildSecurityConfig();

    this.logger.log(
      `SecurityHeadersMiddleware initialized (production: ${this.isProduction}, nonceMode: ${this.nonceMode})`,
    );
  }

  use(req: Request, res: Response, next: NextFunction): void {
    // SECREV-LOW-002 cure: per-request nonce generation. Only fires
    // when nonceMode is on. The nonce is base64-encoded random
    // bytes per OWASP CSP nonce guidance — at least 128 bits of
    // entropy so brute-force prediction is computationally
    // impossible within a request lifetime.
    if (this.nonceMode) {
      res.locals.cspNonce = randomBytes(16).toString('base64');
    }

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
        // SECREV-LOW-002 cure: when nonceMode is on, the CSP is
        // built per-request (the nonce is request-scoped). When
        // off, the static default applies. setContentSecurityPolicy
        // routes to the right path at request time.
        (this.nonceMode ? '' : this.buildDefaultCsp()),
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
   * SECURITY: Do NOT use 'unsafe-inline' for script-src in production.
   * If this middleware is ever activated alongside or instead of Helmet,
   * it must not silently weaken the CSP.
   */
  private buildDefaultCsp(nonce?: string): string {
    // SECREV-LOW-002 cure: when nonce is provided, replace
    // 'unsafe-inline' with 'nonce-...' on style-src (production)
    // and on both style-src + script-src (dev — matches the
    // 'GraphQL Playground needs this in dev' rationale by
    // letting the playground emit nonce-tagged inline scripts).
    const styleSrc = nonce
      ? `style-src 'self' 'nonce-${nonce}'`
      : "style-src 'self' 'unsafe-inline'";
    const directives: string[] = this.isProduction
      ? [
          "default-src 'self'",
          "script-src 'self'",
          styleSrc,
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "base-uri 'self'",
          "object-src 'none'",
        ]
      : [
          "default-src 'self'",
          // GraphQL Playground needs inline scripts in dev. With
          // nonce mode on, a nonce-tagged inline script works;
          // without, fall back to 'unsafe-inline'.
          nonce
            ? `script-src 'self' 'nonce-${nonce}'`
            : "script-src 'self' 'unsafe-inline'",
          styleSrc,
          "img-src 'self' data: https:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss: https:",
          "frame-ancestors 'none'",
          "form-action 'self'",
          "base-uri 'self'",
          "object-src 'none'",
        ];

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
    // SECREV-LOW-002 cure: when nonce mode is active, build CSP
    // per-request so the directive carries the request-scoped
    // nonce. Otherwise use the cached static CSP.
    const csp = this.nonceMode
      ? this.buildDefaultCsp(res.locals.cspNonce as string | undefined)
      : this.config.contentSecurityPolicy;
    if (csp) {
      res.setHeader('Content-Security-Policy', csp);
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
