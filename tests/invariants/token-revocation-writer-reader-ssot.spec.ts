/**
 * Distributed access-token revocation SSoT.
 *
 * Auth-service owns every revocation write. Gateway-api is an enforcement
 * point and therefore exposes only reads. The two DI tokens are deliberately
 * different capability boundaries, while their Redis namespace, typed keys,
 * key builders, and composite JTI/user/iat decision remain shared.
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
  authApp: 'apps/auth-service/src/app.module.ts',
  gatewayStore: 'apps/gateway-api/src/guards/redis-token-blacklist.store.ts',
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

  it('keeps auth as the sole writer and gateway as a read-only capability', () => {
    const writerInterface = interfaceBody(read(PATHS.writerInterface), 'ITokenBlacklist');
    const jtiWriter = read(PATHS.jtiWriter);
    const userWriter = read(PATHS.userWriter);
    const gatewayStoreSource = read(PATHS.gatewayStore);
    const gatewayStore = interfaceBody(gatewayStoreSource, 'TokenBlacklistStore');
    const gatewayRedis = interfaceBody(gatewayStoreSource, 'GatewayAuthorizationRedisClient');

    expect(writerInterface).toMatch(/add\(jti: string, expiresAt: Date/);
    expect(jtiWriter).toContain('this.redis.setAuthorization(');
    expect(userWriter).toContain('this.redis.setAuthorizationMaxSafeInteger(');

    expect(gatewayStore).toMatch(/isBlacklisted\(jti: string\)/);
    expect(gatewayStore).toMatch(/isValidToken\(jti: string, userId: string, issuedAt: number\)/);
    expect(gatewayRedis).toContain('getAuthorization(');
    expect(gatewayRedis).toContain('mgetScoped(');
    expect(`${gatewayStore}\n${gatewayRedis}`).not.toMatch(
      /\b(?:add|set|setAuthorization|setAuthorizationMaxSafeInteger|del|delete)\s*\(/,
    );
  });

  it('forces gateway composite checks through the shared key builders', () => {
    const store = read(PATHS.gatewayStore);
    const guard = read(PATHS.gatewayGuard);
    const middleware = read(PATHS.gatewayMiddleware);

    expect(store).toMatch(
      /import\s*\{\s*tokenBlacklistKey,\s*userBlacklistKey\s*\}\s*from '@aquaculture\/backend-common\/security'/,
    );
    expect(store).toContain("{ scope: 'authorization', key: tokenBlacklistKey(jti) }");
    expect(store).toContain("{ scope: 'authorization', key: userBlacklistKey(userId) }");
    expect(store).toContain('return issuedAt > invalidatedAt;');

    for (const enforcementPoint of [guard, middleware]) {
      expect(enforcementPoint).toContain('this.tokenBlacklist.isValidToken(');
    }
  });

  it('wires mandatory distributed enforcement on both auth boundaries', () => {
    const authApp = read(PATHS.authApp);
    const gatewayApp = read(PATHS.gatewayApp);
    const gatewayGuard = read(PATHS.gatewayGuard);
    const gatewayMiddleware = read(PATHS.gatewayMiddleware);

    expect(authApp).toContain('TokenBlacklistModule,');
    expect(authApp).toContain('UserTokenRevocationModule,');
    expect(authApp).toContain('TOKEN_BLACKLIST,');
    expect(authApp).toContain('USER_TOKEN_REVOCATION,');

    expect(gatewayApp).toContain('buildGatewayTokenBlacklistStore(');
    expect(gatewayApp).toContain('TOKEN_BLACKLIST_STORE,');
    expect(gatewayApp).not.toMatch(/\{\s*token:\s*TOKEN_BLACKLIST_STORE,\s*optional:\s*true\s*\}/);
    expect(gatewayGuard).not.toContain('@Optional()');
    expect(gatewayMiddleware).not.toContain('@Optional()');
  });
});
