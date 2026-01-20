import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Invitation } from './entities/invitation.entity';
import { UserModuleAssignment } from './entities/user-module-assignment.entity';
import { AuthenticationService } from './services/authentication.service';
import { AuthResolver } from './resolvers/auth.resolver';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

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
export class AuthenticationModule {}
