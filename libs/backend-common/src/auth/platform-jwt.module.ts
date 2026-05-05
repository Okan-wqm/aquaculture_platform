import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { getJwtVerifyOptions } from './jwt-verification.utils';

/**
 * PlatformJwtModule
 * ============================================================================
 *
 * Canonical RS256 JWT verification wiring for every NestJS backend service
 * that consumes (verifies, but does not issue) access tokens.
 *
 * All services other than `auth-service` are TOKEN CONSUMERS. They verify
 * tokens using the RSA public key minted by auth-service. The shared helper
 * `getJwtVerifyOptions` extracts the public key + issuer + audience from the
 * service's ConfigService, and this module wires them into a global NestJS
 * JwtModule with algorithms restricted to ['RS256'].
 *
 * # Why this module exists (Tier-1 architectural prevention)
 * ----------------------------------------------------------------------------
 * Before 2026-04-14, every consumer service hand-rolled its own
 * `JwtModule.registerAsync({ useFactory: ... })` block — 10 services with
 * identical 15-line wiring. That copy-paste drift surface was load-bearing:
 *
 *   - The HS256 → RS256 migration (commit 7c076361) had to update each
 *     block by hand. `hydroponics-service` was missed and stayed on the
 *     deprecated `configService.getOrThrow('JWT_SECRET')` shared-secret
 *     path. When `JWT_SECRET` stopped being provisioned, the service
 *     crashed at boot with `Configuration key "JWT_SECRET" does not exist`
 *     — the 2026-04-14 outage.
 *
 *   - `notification-service` and `config-service` carried the same legacy
 *     HS256 code; they would have crashed identically the next time their
 *     deploy lane caught up to the env-var teardown.
 *
 * The architectural answer (per CLAUDE.md tier hierarchy):
 *
 *   1. **Make it impossible** (this module): the shared module is the only
 *      way services can wire JWT verification. New services that import it
 *      get RS256-correct configuration for free.
 *   2. **Make it detectable** (the paired ESLint rule
 *      `no-restricted-syntax` ban on `JWT_SECRET` reads): if a service
 *      tries to reintroduce the HS256 code path, lint rejects it before
 *      merge.
 *
 * # Usage
 * ----------------------------------------------------------------------------
 *
 * ```typescript
 * import { PlatformJwtModule } from '@aquaculture/backend-common';
 *
 * @Module({
 *   imports: [
 *     ConfigModule.forRoot({ isGlobal: true }),
 *     PlatformJwtModule,
 *     // ... rest
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The module is `@Global()` — downstream feature modules can `@Inject(JwtService)`
 * directly without re-importing.
 *
 * # NOT for auth-service
 * ----------------------------------------------------------------------------
 * `auth-service` is the SOLE token issuer — it signs tokens with the RSA
 * private key (`JWT_PRIVATE_KEY`) and also handles a development-only
 * fallback (`ALLOW_DEV_JWT_SECRET=true` + `DEV_JWT_SECRET`). Its JwtModule
 * wiring requires `signOptions` and a private key, which this module does
 * not provide. `auth-service/src/app.module.ts` keeps its own
 * `JwtModule.registerAsync` block and is exempt from this migration.
 *
 * @see jwt-verification.utils.ts (the shared helper this module wraps)
 * @see ADR-016 Phase B / WS2 (deploy resilience architecture)
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const verifyOpts = getJwtVerifyOptions(configService);
        return {
          publicKey: verifyOpts.publicKey,
          verifyOptions: {
            // SECURITY: RS256 only — prevents algorithm confusion attacks
            // (RS256 → HS256 confusion via shared key material). No HS256
            // fallback exists; if the public key is unavailable, the helper
            // throws at startup rather than silently downgrading.
            algorithms: ['RS256'],
            issuer: verifyOpts.issuer,
            audience: verifyOpts.audience,
          },
        };
      },
    }),
  ],
  exports: [JwtModule],
})
export class PlatformJwtModule {}
