/**
 * @aquaculture/backend-common/auth
 *
 * JWT verification, password hashing, RS256 JwtModule for token-CONSUMER services.
 * Token-ISSUER (auth-service) keeps its own JwtModule block.
 */

export { getJwtVerifyOptions, enforceAccessTokenType, enforceTokenNotRevoked, getActiveSigningKid } from './jwt-verification.utils';
export type { JwtVerifyConfig, TokenRevocationStores } from './jwt-verification.utils';

export { PlatformJwtModule } from './platform-jwt.module';

export { hashPassword, verifyPassword, PEPPERED_PREFIX_V1 } from './password.util';
export type { VerifyPasswordResult } from './password.util';
