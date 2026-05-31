import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../../audit/audit.module';
import { Tenant } from '../tenant/entities/tenant.entity';

import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { User } from './entities/user.entity';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { AuthPasswordResetNatsHandler } from './handlers/auth-password-reset-nats.handler';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountResolver } from './resolvers/account.resolver';
import { AuthResolver } from './resolvers/auth.resolver';
import { MfaResolver } from './resolvers/mfa.resolver';
import { NotificationPreferencesResolver } from './resolvers/notification-preferences.resolver';
import { WebAuthnResolver } from './resolvers/webauthn.resolver';
import { AccountService } from './services/account.service';
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
  controllers: [AuthPasswordResetNatsHandler],
  providers: [
    AccountService,
    TokenService,
    MfaService,
    WebAuthnService,
    AuthenticationService,
    AccountResolver,
    AuthResolver,
    MfaResolver,
    NotificationPreferencesResolver,
    WebAuthnResolver,
    JwtAuthGuard,
  ],
  exports: [AccountService, AuthenticationService, TokenService, MfaService, WebAuthnService, JwtAuthGuard, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthenticationModule {}
