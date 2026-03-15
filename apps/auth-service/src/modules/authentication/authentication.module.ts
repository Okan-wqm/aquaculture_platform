import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../../audit/audit.module';
import { Tenant } from '../tenant/entities/tenant.entity';

import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { User } from './entities/user.entity';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthResolver } from './resolvers/auth.resolver';
import { MfaResolver } from './resolvers/mfa.resolver';
import { WebAuthnResolver } from './resolvers/webauthn.resolver';
import { AuthenticationService } from './services/authentication.service';
import { MfaService } from './services/mfa.service';
import { TokenService } from './services/token.service';
import { WebAuthnService } from './services/webauthn.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      RefreshToken,
      Invitation,
      UserModuleAssignment,
      Tenant,
      WebAuthnCredential,
    ]),
    AuditModule,
  ],
  providers: [
    TokenService,
    MfaService,
    WebAuthnService,
    AuthenticationService,
    AuthResolver,
    MfaResolver,
    WebAuthnResolver,
    JwtAuthGuard,
  ],
  exports: [AuthenticationService, TokenService, MfaService, WebAuthnService, JwtAuthGuard, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthenticationModule {}
