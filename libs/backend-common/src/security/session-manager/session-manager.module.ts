import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SESSION_MANAGER } from '../interfaces';

import { SessionManagerService } from './session-manager.service';

/**
 * Session Manager Module
 *
 * Provides session management with concurrent session limits.
 *
 * Usage:
 * ```typescript
 * // Import in app.module.ts
 * @Module({
 *   imports: [SessionManagerModule],
 * })
 * export class AppModule {}
 *
 * // Use in services
 * @Injectable()
 * export class AuthService {
 *   constructor(
 *     @Inject(SESSION_MANAGER) private readonly sessionManager: ISessionManager,
 *   ) {}
 *
 *   async login(userId: string, metadata: SessionMetadata) {
 *     // This will auto-revoke oldest sessions if limit exceeded
 *     const sessionId = await this.sessionManager.createSession(userId, metadata);
 *     return sessionId;
 *   }
 * }
 * ```
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    SessionManagerService,
    {
      provide: SESSION_MANAGER,
      useExisting: SessionManagerService,
    },
  ],
  exports: [SessionManagerService, SESSION_MANAGER],
})
export class SessionManagerModule {}
