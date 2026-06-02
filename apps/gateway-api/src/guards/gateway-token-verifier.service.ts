import { AccessTokenVerifierService } from '@aquaculture/backend-common/security';
import { Injectable, Inject } from '@nestjs/common';

import type { JwtPayload } from '../types';

export interface VerifyAccessTokenOptions {
  context: string;
  requireTenantId?: boolean;
  allowSuperAdminNullTenant?: boolean;
}

@Injectable()
export class GatewayTokenVerifierService {
  constructor(
    @Inject(AccessTokenVerifierService)
    private readonly accessTokenVerifier: AccessTokenVerifierService,
  ) {}

  async verifyAccessToken(
    token: string,
    options: VerifyAccessTokenOptions,
  ): Promise<JwtPayload | null> {
    return this.accessTokenVerifier.verifyAccessToken<JwtPayload>(token, options);
  }

  async isPayloadAllowed(payload: JwtPayload, context: string): Promise<boolean> {
    return this.accessTokenVerifier.isPayloadAllowed(payload, { context });
  }

  async blacklistToken(jti: string, expSeconds: number): Promise<void> {
    await this.accessTokenVerifier.blacklistToken(jti, expSeconds);
  }
}
