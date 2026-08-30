import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { TokenBlacklistService } from './token-blacklist.service';
import { TOKEN_BLACKLIST } from '../interfaces';

/**
 * Token Blacklist Module
 *
 * Provides token blacklisting capabilities for access token invalidation.
 *
 * Usage:
 * ```typescript
 * // Import in app.module.ts
 * @Module({
 *   imports: [TokenBlacklistModule],
 * })
 * export class AppModule {}
 *
 * // Use in services
 * @Injectable()
 * export class AuthService {
 *   constructor(
 *     @Inject(TOKEN_BLACKLIST) private readonly blacklist: ITokenBlacklist,
 *   ) {}
 *
 *   async logout(jti: string, expiresAt: Date) {
 *     await this.blacklist.add(jti, expiresAt, 'user_logout');
 *   }
 * }
 * ```
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    TokenBlacklistService,
    {
      provide: TOKEN_BLACKLIST,
      useExisting: TokenBlacklistService,
    },
  ],
  exports: [TokenBlacklistService, TOKEN_BLACKLIST],
})
export class TokenBlacklistModule {}
