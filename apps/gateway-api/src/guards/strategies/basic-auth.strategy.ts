/**
 * Basic Authentication Strategy
 *
 * Validates Basic Auth credentials using bcrypt comparison.
 * Supports pre-hashed bcrypt passwords to avoid synchronous hashing at startup.
 *
 * SECURITY: Uses async bcrypt.compare() to avoid blocking the event loop.
 */

import * as bcrypt from 'bcryptjs';

import {
  Injectable,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthenticatedRequest } from '../../types/index';

/**
 * Basic Authentication Strategy
 * Handles validation of HTTP Basic Auth credentials
 *
 * NOTE: Explicit @Inject() decorators are required because Nx webpack (SWC loader)
 * strips TypeScript emitDecoratorMetadata (design:paramtypes) during bundling.
 * Without explicit @Inject(), NestJS cannot resolve constructor dependencies at runtime.
 */
@Injectable()
export class BasicAuthStrategy {
  private readonly logger = new Logger(BasicAuthStrategy.name);
  private readonly basicAuthCredentials: Map<string, string>;

  constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
    this.basicAuthCredentials = new Map();
    this.loadBasicAuthCredentials();
  }

  /**
   * Validate Basic Auth credentials from request
   *
   * SECURITY: Uses async bcrypt.compare() to avoid blocking the event loop
   *
   * @param request - The incoming HTTP request
   * @returns true if the credentials are valid
   * @throws {UnauthorizedException} If credentials are missing, malformed, or invalid
   */
  async validate(request: AuthenticatedRequest): Promise<boolean> {
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException({
        code: 'MISSING_AUTH_HEADER',
        message: 'Authorization header is required',
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'basic' || !parts[1]) {
      throw new UnauthorizedException({
        code: 'INVALID_AUTH_SCHEME',
        message: 'Authorization header must use Basic scheme',
      });
    }

    const credentials = Buffer.from(parts[1], 'base64').toString('utf8');
    const [username, password] = credentials.split(':') as [string | undefined, string | undefined];

    if (!username || !password) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS_FORMAT',
        message: 'Invalid credentials format',
      });
    }

    const storedPasswordHash = this.basicAuthCredentials.get(username);
    if (!storedPasswordHash || !(await bcrypt.compare(password, storedPasswordHash))) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
    }

    request.authMethod = 'basic';
    request.user = {
      sub: username,
      tenantId: 'system',
      roles: ['service'],
      type: 'access',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    return true;
  }

  /**
   * Load basic auth credentials from configuration
   *
   * SECURITY: Accepts pre-hashed bcrypt values to avoid synchronous hashing at startup.
   * If a value starts with '$2a$' or '$2b$', it is treated as already hashed.
   * Otherwise it is hashed asynchronously.
   */
  private loadBasicAuthCredentials(): void {
    const credentialsConfig = this.configService.get<string>('BASIC_AUTH_CREDENTIALS', '');
    if (!credentialsConfig) return;

    try {
      const credentials = JSON.parse(credentialsConfig) as Record<string, string>;
      for (const [username, password] of Object.entries(credentials)) {
        // Accept pre-hashed bcrypt passwords to avoid blocking hashSync at startup
        if (password.startsWith('$2a$') || password.startsWith('$2b$')) {
          this.basicAuthCredentials.set(username, password);
        } else {
          // Fallback: hash asynchronously for backwards compatibility
          void bcrypt.hash(password, 10).then((hashed) => {
            this.basicAuthCredentials.set(username, hashed);
          });
        }
      }
    } catch {
      this.logger.warn('Failed to parse basic auth credentials');
    }
  }
}
