import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../../audit/audit.module';
import { Tenant } from '../tenant/entities/tenant.entity';
import { TenantModule } from '../tenant/tenant.module';

import { AuthCredentialNatsHandler } from './controllers/auth-credential-nats.handler';
import { AuthPublicNatsHandler } from './controllers/auth-public-nats.handler';
import { InternalAuthController } from './controllers/internal-auth.controller';
import { ActionToken } from './entities/action-token.entity';
import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { UserSiteAssignment } from './entities/user-site-assignment.entity';
import { User } from './entities/user.entity';
import { WebAuthnCredential } from './entities/webauthn-credential.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AccountResolver } from './resolvers/account.resolver';
import { AuthResolver } from './resolvers/auth.resolver';
import { MfaResolver } from './resolvers/mfa.resolver';
import { NotificationPreferencesResolver } from './resolvers/notification-preferences.resolver';
import { WebAuthnResolver } from './resolvers/webauthn.resolver';
import { PublicUserProfileFederationResolver } from './resolvers/user-federation.resolver';
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
      UserSiteAssignment,
      Tenant,
      WebAuthnCredential,
    ]),
    AuditModule,
    // SEC-HIGH-052: TenantModule exports MobileSettingsService (the single
    // mobile-feature read path) so TokenService can fold it into the JWT mint.
    TenantModule,
  ],
  controllers: [InternalAuthController, AuthPublicNatsHandler, AuthCredentialNatsHandler],
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
    PublicUserProfileFederationResolver,
    JwtAuthGuard,
  ],
  exports: [AccountService, AuthenticationService, TokenService, MfaService, WebAuthnService, JwtAuthGuard, TypeOrmModule],
})
export class AuthenticationModule {
  private readonly moduleClass = AuthenticationModule.name;
}
