/**
 * Distributed access-token revocation SSoT.
 *
 * Auth-service owns every revocation write. JWT-consuming boundaries receive
 * one shared read-only capability. Writer and reader DI tokens are deliberately
 * different while their Redis namespace, typed keys, key builders, and
 * composite JTI/user/iat decision remain shared.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const PATHS = {
  redis: 'libs/backend-common/src/redis/redis.service.ts',
  writerInterface: 'libs/backend-common/src/security/interfaces/index.ts',
  jtiWriter: 'libs/backend-common/src/security/token-blacklist/token-blacklist.service.ts',
  userWriter:
    'libs/backend-common/src/security/user-token-revocation/user-token-revocation.service.ts',
  sharedReader:
    'libs/backend-common/src/security/token-revocation-reader/token-revocation-reader.service.ts',
  authApp: 'apps/auth-service/src/app.module.ts',
  authGuard: 'apps/auth-service/src/modules/authentication/guards/jwt-auth.guard.ts',
  adminApp: 'apps/admin-api-service/src/app.module.ts',
  adminGuard: 'apps/admin-api-service/src/guards/platform-admin.guard.ts',
  gatewayGuard: 'apps/gateway-api/src/guards/auth.guard.ts',
  gatewayMiddleware: 'apps/gateway-api/src/middleware/jwt.middleware.ts',
  gatewayApp: 'apps/gateway-api/src/app.module.ts',
} as const;

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function interfaceBody(source: string, name: string): string {
  const match = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match?.[1]) {
    throw new Error(`Unable to find interface ${name}`);
  }
  return match[1];
}

describe('distributed token revocation writer/read-enforcement SSoT', () => {
  it('owns both marker shapes in one typed authorization Redis namespace', () => {
    const redis = read(PATHS.redis);

    expect(redis).toContain("AUTHORIZATION_REDIS_KEY_PREFIX = 'auth:'");
    expect(redis).toMatch(/type RevokedTokenRedisKey = `token:blacklist:\$\{string\}`/);
    expect(redis).toMatch(/type UserInvalidationRedisKey = `user_blacklist:\$\{string\}`/);
    expect(redis).toContain(
      'type AuthorizationRedisKey = RevokedTokenRedisKey | UserInvalidationRedisKey',
    );
    expect(redis).toContain("{ scope: 'authorization'; key: AuthorizationRedisKey }");
  });

  it('keeps auth as the sole writer and exposes a read-only shared capability', () => {
    const writerInterface = interfaceBody(read(PATHS.writerInterface), 'ITokenBlacklist');
    const jtiWriter = read(PATHS.jtiWriter);
    const userWriter = read(PATHS.userWriter);
    const sharedReaderSource = read(PATHS.sharedReader);
    const sharedReader = interfaceBody(sharedReaderSource, 'ITokenRevocationReader');
    const readerRedis = interfaceBody(sharedReaderSource, 'TokenRevocationRedisReader');

    expect(writerInterface).toMatch(/add\(jti: string, expiresAt: Date/);
    expect(jtiWriter).toContain('this.redis.setAuthorization(');
    expect(userWriter).toContain('this.redis.setAuthorizationMaxSafeInteger(');

    expect(sharedReader).toContain('getStatus(');
    expect(readerRedis).toContain('mgetScoped(');
    expect(`${sharedReader}\n${readerRedis}`).not.toMatch(
      /\b(?:add|set|setAuthorization|setAuthorizationMaxSafeInteger|del|delete)\s*\(/,
    );
  });

  it('gives every JWT consumer one shared read-only composite capability', () => {
    const sharedReader = read(PATHS.sharedReader);
    const readerInterface = interfaceBody(sharedReader, 'ITokenRevocationReader');
    const readerRedis = interfaceBody(sharedReader, 'TokenRevocationRedisReader');
    const adminApp = read(PATHS.adminApp);
    const adminGuard = read(PATHS.adminGuard);
    const authGuard = read(PATHS.authGuard);
    const gatewayApp = read(PATHS.gatewayApp);
    const gatewayGuard = read(PATHS.gatewayGuard);
    const gatewayMiddleware = read(PATHS.gatewayMiddleware);

    expect(readerInterface).toContain('getStatus(');
    expect(readerRedis).toContain('mgetScoped(');
    expect(`${readerInterface}\n${readerRedis}`).not.toMatch(
      /\b(?:add|set|setAuthorization|setAuthorizationMaxSafeInteger|del|delete)\s*\(/,
    );
    expect(sharedReader).toContain("{ scope: 'authorization', key: tokenBlacklistKey(jti) }");
    expect(sharedReader).toContain("{ scope: 'authorization', key: userBlacklistKey(userId) }");

    expect(adminApp).toContain('TokenRevocationReaderModule');
    expect(adminApp).toContain('TOKEN_REVOCATION_READER');
    expect(adminApp).not.toContain('TokenBlacklistModule');
    expect(adminApp).not.toContain('UserTokenRevocationModule');
    expect(adminGuard).toContain('enforceTokenNotRevoked(');
    expect(gatewayApp).toContain('TokenRevocationReaderModule');
    expect(gatewayApp).toContain('TOKEN_REVOCATION_READER');
    expect(gatewayApp).not.toContain('TOKEN_BLACKLIST_STORE');
    for (const enforcementPoint of [authGuard, gatewayGuard, gatewayMiddleware]) {
      expect(enforcementPoint).toContain('enforceTokenNotRevoked(');
    }
  });

  it('wires mandatory distributed enforcement on both auth boundaries', () => {
    const authApp = read(PATHS.authApp);
    const gatewayApp = read(PATHS.gatewayApp);
    const gatewayGuard = read(PATHS.gatewayGuard);
    const gatewayMiddleware = read(PATHS.gatewayMiddleware);

    expect(authApp).toContain('TokenBlacklistModule,');
    expect(authApp).toContain('UserTokenRevocationModule,');
    expect(authApp).toContain('TokenRevocationReaderModule,');
    expect(authApp).toContain('TOKEN_REVOCATION_READER,');

    expect(gatewayApp).toContain('TokenRevocationReaderModule,');
    expect(gatewayApp).toContain('TOKEN_REVOCATION_READER,');
    expect(gatewayGuard).not.toContain('@Optional()');
    expect(gatewayMiddleware).not.toContain('@Optional()');
  });
});
