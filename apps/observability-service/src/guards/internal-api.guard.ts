/**
 * Internal API Guard
 *
 * Bu guard, internal endpoint'leri korumak için kullanılır.
 * Prometheus /metrics endpoint'i hariç, diğer tüm endpoint'ler
 * INTERNAL_API_KEY header'ı ile korunur.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class InternalApiGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiGuard.name);
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>('INTERNAL_API_KEY', '');

    if (!this.apiKey && process.env['NODE_ENV'] === 'production') {
      this.logger.error(
        'INTERNAL_API_KEY is not configured in production! Internal endpoints are vulnerable.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
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
    const providedKey =
      request.headers['x-internal-api-key'] ||
      request.headers['authorization']?.replace('Bearer ', '');

    if (!providedKey) {
      throw new UnauthorizedException({
        code: 'MISSING_INTERNAL_API_KEY',
        message: 'Internal API key is required',
      });
    }

    // Use timing-safe comparison to prevent timing attacks
    if (!this.timingSafeEqual(providedKey, this.apiKey)) {
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

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }

    return result === 0;
  }
}
