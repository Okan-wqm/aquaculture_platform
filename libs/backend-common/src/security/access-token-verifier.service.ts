import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { enforceAccessTokenType, getJwtVerifyOptions } from '../auth';
import { ITokenBlacklist, TOKEN_BLACKLIST } from './interfaces';

export interface AccessTokenVerifierOptions {
  context: string;
  requireTenantId?: boolean;
  allowSuperAdminNullTenant?: boolean;
}

export interface AccessTokenPayload {
  sub?: unknown;
  tenantId?: unknown;
  type?: unknown;
  jti?: unknown;
  iat?: unknown;
  exp?: unknown;
  role?: unknown;
  roles?: unknown;
}

@Injectable()
export class AccessTokenVerifierService {
  private readonly logger = new Logger(AccessTokenVerifierService.name);
  private readonly isProduction: boolean;

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(ConfigService) private readonly configService: ConfigService,
    @Optional()
    @Inject(TOKEN_BLACKLIST)
    private readonly tokenBlacklist?: ITokenBlacklist,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV', 'development') === 'production';
  }

  async verifyAccessToken<T extends AccessTokenPayload>(
    token: string,
    options: AccessTokenVerifierOptions,
  ): Promise<T | null> {
    try {
      const payload = await this.jwtService.verifyAsync<T>(
        token,
        getJwtVerifyOptions(this.configService),
      );

      if (!(await this.isPayloadAllowed(payload, options))) {
        return null;
      }

      return payload;
    } catch (error) {
      this.logger.debug(
        `JWT validation failed in ${options.context}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async isPayloadAllowed(
    payload: AccessTokenPayload,
    options: AccessTokenVerifierOptions,
  ): Promise<boolean> {
    try {
      if (!this.hasRequiredClaims(payload, options)) {
        this.logger.warn(`JWT rejected in ${options.context}: missing required claims`);
        return false;
      }

      enforceAccessTokenType(
        payload as { type?: string; sub: string; jti?: string },
        this.logger,
        this.isProduction,
      );

      if (!this.tokenBlacklist) {
        this.logger.error(`JWT rejected in ${options.context}: token blacklist unavailable`);
        return false;
      }

      const valid = await this.tokenBlacklist.isValidToken(
        payload.jti,
        payload.sub,
        new Date(payload.iat * 1000),
        typeof payload.tenantId === 'string' ? payload.tenantId : null,
      );
      if (!valid) {
        this.logger.warn(`JWT rejected in ${options.context}: revoked or invalidated token`);
      }
      return valid;
    } catch (error) {
      this.logger.warn(`JWT rejected in ${options.context}: ${(error as Error).message}`);
      return false;
    }
  }

  async blacklistToken(jti: string, expSeconds: number, reason = 'gateway_blacklist'): Promise<void> {
    if (!this.tokenBlacklist) {
      throw new Error('Token blacklist unavailable');
    }
    await this.tokenBlacklist.add(jti, new Date(expSeconds * 1000), reason);
  }

  private hasRequiredClaims(
    payload: AccessTokenPayload,
    options: AccessTokenVerifierOptions,
  ): payload is AccessTokenPayload & {
    sub: string;
    jti: string;
    iat: number;
    exp: number;
  } {
    if (!payload || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return false;
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      return false;
    }
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
      return false;
    }

    if (options.requireTenantId) {
      if (typeof payload.tenantId === 'string' && payload.tenantId.length > 0) {
        return true;
      }
      return options.allowSuperAdminNullTenant === true && this.hasSuperAdminRole(payload);
    }

    return true;
  }

  private hasSuperAdminRole(payload: AccessTokenPayload): boolean {
    if (payload.role === 'SUPER_ADMIN') {
      return true;
    }
    return Array.isArray(payload.roles) && payload.roles.includes('SUPER_ADMIN');
  }
}
