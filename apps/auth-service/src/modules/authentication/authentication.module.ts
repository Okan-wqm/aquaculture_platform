import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../../audit/audit.module';
import { Tenant } from '../tenant/entities/tenant.entity';

import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { User } from './entities/user.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthResolver } from './resolvers/auth.resolver';
import { MfaResolver } from './resolvers/mfa.resolver';
import { AuthenticationService } from './services/authentication.service';
import { MfaService } from './services/mfa.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      RefreshToken,
      Invitation,
      UserModuleAssignment,
      Tenant,
    ]),
    AuditModule,
  ],
  providers: [
    AuthenticationService,
    MfaService,
    // Token-based providers to break circular dependency between
    // AuthenticationService <-> MfaService
    {
      provide: 'MFA_SERVICE',
      useExisting: MfaService,
    },
    {
      provide: 'AUTH_SERVICE',
      useExisting: AuthenticationService,
    },
    AuthResolver,
    MfaResolver,
    JwtAuthGuard,
  ],
  exports: [AuthenticationService, MfaService, JwtAuthGuard, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthenticationModule {}
