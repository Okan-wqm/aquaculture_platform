import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../../audit/audit.module';
import { Tenant } from '../tenant/entities/tenant.entity';

import { AuthPublicNatsHandler } from './controllers/auth-public-nats.handler';
import { InternalAuthController } from './controllers/internal-auth.controller';
import { ActionToken } from './entities/action-token.entity';
import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { User } from './entities/user.entity';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountResolver } from './resolvers/account.resolver';
import { AuthResolver } from './resolvers/auth.resolver';
import { MfaResolver } from './resolvers/mfa.resolver';
import { NotificationPreferencesResolver } from './resolvers/notification-preferences.resolver';
import { WebAuthnResolver } from './resolvers/webauthn.resolver';
import { UserFederationResolver } from './resolvers/user-federation.resolver';
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
      ActionToken,
      Invitation,
      UserModuleAssignment,
      Tenant,
      WebAuthnCredential,
    ]),
    AuditModule,
  ],
  controllers: [InternalAuthController, AuthPublicNatsHandler],
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
    UserFederationResolver,
    JwtAuthGuard,
  ],
  exports: [AccountService, AuthenticationService, TokenService, MfaService, WebAuthnService, JwtAuthGuard, TypeOrmModule],
})
export class AuthenticationModule {
  private readonly moduleClass = AuthenticationModule.name;
}
