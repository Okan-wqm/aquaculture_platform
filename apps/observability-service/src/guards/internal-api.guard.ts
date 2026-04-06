/**
 * Internal API Guard
 *
 * Protects internal endpoints from unauthenticated access.
 * All endpoints require the x-internal-api-key header except those
 * explicitly annotated with @Public() (e.g. liveness/readiness probes).
 *
 * Registered globally via APP_GUARD in AppModule so every controller is
 * protected without individual @UseGuards decorators.
 */

import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual, createHash } from 'crypto';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@Injectable()
export class InternalApiGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiGuard.name);
  private readonly apiKey: string;

  // WHY: Explicit @Inject() — design:paramtypes may not survive all build/runtime environments.
  constructor(
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.apiKey = this.configService.get<string>('INTERNAL_API_KEY', '');

    if (!this.apiKey && process.env['NODE_ENV'] === 'production') {
      this.logger.error(
        'INTERNAL_API_KEY is not configured in production! Internal endpoints are vulnerable.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    // Check for @Public() decorator
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();

    // Development mode: allow all if no API key configured
    if (!this.apiKey) {
      if (process.env['NODE_ENV'] === 'production') {
        throw new UnauthorizedException({
          code: 'INTERNAL_API_NOT_CONFIGURED',
          message: 'Internal API access is not configured',
        });
      }
      // In development, log warning but allow access
      this.logger.warn(
        `Internal API access without key from ${request.ip} - dev mode only`,
      );
      return true;
    }

    // Check for internal API key header
    const rawKey =
      request.headers['x-internal-api-key'] ||
      request.headers['authorization']?.replace('Bearer ', '');

    if (!rawKey) {
      throw new UnauthorizedException({
        code: 'MISSING_INTERNAL_API_KEY',
        message: 'Internal API key is required',
      });
    }

    // Handle array case (multiple headers)
    const providedKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;

    // Use timing-safe comparison to prevent timing attacks
    if (!providedKey || !this.constantTimeEqual(providedKey, this.apiKey)) {
      this.logger.warn(
        `Invalid internal API key attempt from ${request.ip}`,
      );
      throw new UnauthorizedException({
        code: 'INVALID_INTERNAL_API_KEY',
        message: 'Invalid internal API key',
      });
    }

    return true;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
}
