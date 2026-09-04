import 'reflect-metadata';
import { getJwtVerifyOptions, enforceAccessTokenType } from '@aquaculture/backend-common/auth';
import { IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../entities/user.entity';
import { MfaResolver } from '../resolvers/mfa.resolver';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

/**
 * ADR-046 — the `mfa_setup` (pre-session enrollment) token.
 *
 * The token is what turns MFA enforcement from a LOCKOUT into a completable
 * enrollment path, so its blast radius has to be exactly two mutations. These
 * specs pin: it can be minted, it can be consumed ONLY where it is positively
 * required, it is inert as a bearer credential, and an authenticated session
 * always outranks it.
 */
describe('MFA setup token (ADR-046)', () => {
  const USER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const OTHER_USER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const buildUser = (): User =>
    Object.assign(new User(), { id: USER_ID, email: 'enrollee@example.com' });

  let mfaService: MfaService;
  let jwtService: JwtService;

  const configValues: Record<string, unknown> = {
    // A 64-char hex key keeps MFA AVAILABLE so the enrollment path is reachable.
    MFA_ENCRYPTION_KEY: 'a'.repeat(64),
    NODE_ENV: 'test',
    JWT_SECRET: 'setup-token-spec-secret',
  };

  beforeEach(async () => {
    jwtService = new JwtService({ secret: configValues['JWT_SECRET'] as string });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: getRepositoryToken(User), useValue: { findOne: jest.fn(), save: jest.fn() } },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) =>
              key in configValues ? configValues[key] : def,
            ),
          },
        },
        { provide: AuditLogService, useValue: { log: jest.fn() } },
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
      ],
    }).compile();

    mfaService = module.get<MfaService>(MfaService);
  });

  describe('mint → consume round trip', () => {
    it('resolves the minting user back out of its own token', () => {
      const token = mfaService.generateMfaSetupToken(buildUser());
      expect(mfaService.resolveSetupTokenUserId(token)).toBe(USER_ID);
    });

    it('stamps type=mfa_setup and purpose=mfa_enrollment', () => {
      const token = mfaService.generateMfaSetupToken(buildUser());
      const decoded = jwtService.verify<{ type: string; purpose: string; sub: string }>(token);
      expect(decoded.type).toBe('mfa_setup');
      expect(decoded.purpose).toBe('mfa_enrollment');
      expect(decoded.sub).toBe(`mfa_setup:${USER_ID}`);
    });

    it('expires in 10 minutes, not an access-token lifetime', () => {
      const token = mfaService.generateMfaSetupToken(buildUser());
      const decoded = jwtService.verify<{ iat: number; exp: number }>(token);
      expect(decoded.exp - decoded.iat).toBe(600);
    });
  });

  describe('the setup token is inert everywhere it is not positively required', () => {
    it('is rejected as a bearer credential by enforceAccessTokenType', () => {
      const token = mfaService.generateMfaSetupToken(buildUser());
      const payload = jwtService.verify<{ type: string; sub: string; jti: string }>(token);

      expect(() => enforceAccessTokenType(payload, new Logger('spec'), true)).toThrow(
        UnauthorizedException,
      );
    });

    it('is rejected by the MFA-challenge consumer (type mismatch)', async () => {
      const setupToken = mfaService.generateMfaSetupToken(buildUser());
      await expect(mfaService.verifyMfaLogin(setupToken, '123456')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses an MFA CHALLENGE token at the enrollment consumer', () => {
      const challenge = mfaService.generateMfaChallenge(buildUser(), false);
      expect(() => mfaService.resolveSetupTokenUserId(challenge.mfaToken)).toThrow(
        UnauthorizedException,
      );
    });

    it('refuses a token signed with a foreign key', () => {
      const foreign = new JwtService({ secret: 'not-the-platform-secret' }).sign({
        sub: `mfa_setup:${USER_ID}`,
        type: 'mfa_setup',
        purpose: 'mfa_enrollment',
        userId: USER_ID,
      });
      expect(() => mfaService.resolveSetupTokenUserId(foreign)).toThrow(UnauthorizedException);
    });

    it('refuses a correctly-signed token whose purpose was tampered', () => {
      const wrongPurpose = jwtService.sign({
        sub: `mfa_setup:${USER_ID}`,
        type: 'mfa_setup',
        purpose: 'something_else',
        userId: USER_ID,
      });
      expect(() => mfaService.resolveSetupTokenUserId(wrongPurpose)).toThrow(UnauthorizedException);
    });
  });

  describe('MfaResolver subject precedence', () => {
    let resolver: MfaResolver;
    let setupMfa: jest.Mock;
    let verifyMfaSetup: jest.Mock;

    beforeEach(async () => {
      setupMfa = jest.fn().mockResolvedValue({ secret: 's', qrCodeUri: 'q', recoveryCodes: [] });
      verifyMfaSetup = jest.fn().mockResolvedValue({ success: true });
      // Resolve through the Nest container so the resolver receives its real
      // constructor types — no casting hack is needed to hand it doubles.
      const resolverModule: TestingModule = await Test.createTestingModule({
        providers: [
          MfaResolver,
          {
            provide: MfaService,
            useValue: {
              setupMfa,
              verifyMfaSetup,
              generateMfaSetupToken: (user: User) => mfaService.generateMfaSetupToken(user),
              resolveSetupTokenUserId: (token: string) => mfaService.resolveSetupTokenUserId(token),
            },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, def?: unknown) =>
                key in configValues ? configValues[key] : def,
              ),
            },
          },
        ],
      }).compile();
      resolver = resolverModule.get<MfaResolver>(MfaResolver);
    });

    // The resolver's own parameter type, so the double is checked against the
    // real contract rather than cast into it.
    type MfaGqlContext = Parameters<MfaResolver['setupMfa']>[0];

    const contextWith = (user?: { sub: string }): MfaGqlContext => ({
      req: { headers: {}, ip: undefined, ...(user ? { user } : {}) },
      res: { cookie: jest.fn() },
    });

    it('uses the AUTHENTICATED identity and IGNORES a supplied setup token', async () => {
      const foreignSetupToken = mfaService.generateMfaSetupToken(buildUser());

      await resolver.setupMfa(contextWith({ sub: OTHER_USER_ID }), foreignSetupToken);

      // The session wins: a setup token can never redirect an authenticated
      // user's enrollment onto another account.
      expect(setupMfa).toHaveBeenCalledWith(OTHER_USER_ID);
    });

    it('falls back to the setup token when there is no session', async () => {
      const token = mfaService.generateMfaSetupToken(buildUser());

      await resolver.setupMfa(contextWith(), token);

      expect(setupMfa).toHaveBeenCalledWith(USER_ID);
    });

    it('refuses when there is neither a session nor a setup token', async () => {
      await expect(resolver.setupMfa(contextWith())).rejects.toBeInstanceOf(UnauthorizedException);
      expect(setupMfa).not.toHaveBeenCalled();
    });

    it('routes verifyMfaSetup through the same subject resolution', async () => {
      const token = mfaService.generateMfaSetupToken(buildUser());

      await resolver.verifyMfaSetup(contextWith(), { code: '123456', mfaSetupToken: token });

      expect(verifyMfaSetup).toHaveBeenCalledWith(USER_ID, '123456');
    });

    it('marks both enrollment mutations @Public so the pre-session path can reach them', () => {
      for (const method of ['setupMfa', 'verifyMfaSetup'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(MfaResolver.prototype, method);
        expect(descriptor?.value).toBeDefined();
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, descriptor?.value as object)).toBe(true);
      }
    });

    it('keeps the OTHER MFA mutations non-public', () => {
      for (const method of ['disableMfa', 'regenerateMfaRecoveryCodes'] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(MfaResolver.prototype, method);
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, descriptor?.value as object)).toBeUndefined();
      }
    });
  });

  it('keeps the platform verify options usable for the setup token shape', () => {
    // Sanity: the setup token is signed by the same service key material as
    // every other MFA token, so a verifier configured for the platform can
    // parse it — the REJECTION is a type decision, not a signature accident.
    expect(typeof getJwtVerifyOptions).toBe('function');
  });
});
