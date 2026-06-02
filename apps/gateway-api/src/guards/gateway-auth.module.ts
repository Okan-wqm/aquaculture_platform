import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { SecurityModule } from '@aquaculture/backend-common/security';

import { GatewayTokenVerifierService } from './gateway-token-verifier.service';

@Global()
@Module({
  imports: [ConfigModule, JwtModule, SecurityModule],
  providers: [
    GatewayTokenVerifierService,
  ],
  exports: [GatewayTokenVerifierService],
})
export class GatewayAuthModule {}
