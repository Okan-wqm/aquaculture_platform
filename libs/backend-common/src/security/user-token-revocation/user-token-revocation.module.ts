import { Global, Module } from '@nestjs/common';

import { USER_TOKEN_REVOCATION, UserTokenRevocationService } from './user-token-revocation.service';

/**
 * Provides the canonical user-token-revocation primitive (RBAC-HIGH-001).
 *
 * @Global so any writer (auth-service RBAC mutation paths) can inject
 * USER_TOKEN_REVOCATION once the module is imported. Depends on the @Global
 * RedisModule being present for cross-instance correctness; falls back to
 * in-memory when Redis is absent (dev/test).
 */
@Global()
@Module({
  providers: [
    UserTokenRevocationService,
    { provide: USER_TOKEN_REVOCATION, useExisting: UserTokenRevocationService },
  ],
  exports: [UserTokenRevocationService, USER_TOKEN_REVOCATION],
})
export class UserTokenRevocationModule {}
