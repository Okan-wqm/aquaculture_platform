import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

/**
 * Guard that verifies an internal API key for service-to-service authentication.
 * Health check endpoints are excluded from authentication.
 *
 * Set the INTERNAL_API_KEY environment variable to enable enforcement.
 * When the variable is not set (development), the guard logs a warning and allows all requests.
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalApiKeyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Allow health check endpoints without authentication
    if (request.path.includes('/health')) {
      return true;
    }

    const apiKey = process.env['INTERNAL_API_KEY'];

    // In development without a configured key, warn but allow
    if (!apiKey) {
      if (process.env['NODE_ENV'] === 'production') {
        this.logger.error(
          'INTERNAL_API_KEY is not configured in production — rejecting request',
        );
        throw new UnauthorizedException('Service authentication required');
      }
      return true;
    }

    const requestKey = request.headers['x-internal-api-key'] as string | undefined;

    if (!requestKey || requestKey !== apiKey) {
      throw new UnauthorizedException('Invalid or missing internal API key');
    }

    return true;
  }
}
