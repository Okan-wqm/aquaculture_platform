import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Invitation } from './entities/invitation.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { User } from './entities/user.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuthResolver } from './resolvers/auth.resolver';
import { AuthenticationService } from './services/authentication.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      RefreshToken,
      Invitation,
      UserModuleAssignment,
    ]),
  ],
  providers: [AuthenticationService, AuthResolver, JwtAuthGuard],
  exports: [AuthenticationService, JwtAuthGuard, TypeOrmModule],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class AuthenticationModule {}
