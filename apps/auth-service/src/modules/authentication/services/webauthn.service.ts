import * as crypto from 'crypto';

import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { RedisService } from '@aquaculture/backend-common/redis';
import { isLoginAllowed } from '@platform/event-contracts';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { WebAuthnCredential } from '../entities/webauthn-credential.entity';
import { User } from '../entities/user.entity';
import {
  WebAuthnRegistrationChallengeResponse,
  WebAuthnRegisterCredentialInput,
  WebAuthnRegisterResponse,
  WebAuthnLoginChallengeResponse,
  WebAuthnVerifyLoginInput,
  WebAuthnCredentialInfo,
  WebAuthnRemoveResponse,
  WEBAUTHN_TRANSPORTS,
  type WebAuthnTransport,
} from '../dto/webauthn.dto';
import { AuthPayload } from '../dto/auth-response.dto';
import { TokenService, type OriginatingAccessSession } from './token.service';
import { snapshotCredentialProof, withLockedCredentialPrincipal } from './credential-state';

/**
 * WebAuthn ceremony implementation.
 *
 * SEC-CRITICAL-001/002 (2026-08-23 scan №37-№40): verification is delegated
 * to `@simplewebauthn/server`. The hand-rolled predecessor stored a
 * client-supplied public key with no attestation verification (no
 * proof-of-possession), never checked the authenticatorData UP/UV flags or
 * rpIdHash, and consumed challenges with a non-atomic GET/DEL pair.
 *
 * The library makes the wrong behaviour structurally impossible here:
 * - the COSE key is DERIVED from the attestation object, never accepted
 *   from the client;
 * - rpIdHash, origin, UP/UV flags and the challenge are verified inside
 *   `verifyRegistrationResponse` / `verifyAuthenticationResponse`
 *   (`requireUserVerification: true`);
 * - challenges are consumed atomically via Redis GETDEL (single-use under
 *   concurrency). Redis is a hard dependency in production (see app.module
 *   buildRedisOptions('required')) — the in-memory fallback that silently
 *   weakened single-use semantics on multi-instance deployments is gone.
 */
interface StoredChallenge {
  challenge: string;
  userId: string;
  type: 'registration' | 'authentication';
  createdAt: number;
}

const CHALLENGE_TTL_SECONDS = 300;
const MAX_CREDENTIALS_PER_USER = 10;

@Injectable()
export class WebAuthnService {
  private readonly logger = new Logger(WebAuthnService.name);
  private readonly rpId: string;
  private readonly rpName: string;
  private readonly allowedOrigins: string[];

  constructor(
    @InjectRepository(WebAuthnCredential)
    private readonly credentialRepository: Repository<WebAuthnCredential>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly tokenService: TokenService,
    private readonly redisService: RedisService,
    private readonly dataSource: DataSource,
  ) {
    // RP ID is the domain without protocol or port
    this.rpId = this.configService.get<string>('WEBAUTHN_RP_ID', 'localhost');
    this.rpName = this.configService.get<string>('WEBAUTHN_RP_NAME', 'AquaCulture Platform');
    this.allowedOrigins = this.configService
      .get<string>(
        'WEBAUTHN_ALLOWED_ORIGINS',
        `https://${this.rpId},http://localhost:3000,http://localhost:5173`,
      )
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }

  // ==========================================================================
  // Registration Flow
  // ==========================================================================

  /**
   * Step 1: Generate a registration challenge for an authenticated user.
   *
   * The client uses this to call navigator.credentials.create().
   */
  async generateRegistrationChallenge(
    userId: string,
    deviceName?: string,
  ): Promise<WebAuthnRegistrationChallengeResponse> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
      if (!tenant || !isLoginAllowed(tenant.status)) throw new UnauthorizedException('Account not available');
    }

    // Check credential limit
    const existingCount = await this.credentialRepository.count({ where: { userId } });
    if (existingCount >= MAX_CREDENTIALS_PER_USER) {
      throw new BadRequestException(
        `Maximum ${MAX_CREDENTIALS_PER_USER} biometric credentials per user`,
      );
    }

    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('base64url');

    await this.storeChallenge(challenge, {
      challenge,
      userId,
      type: 'registration',
      createdAt: Date.now(),
    });

    this.logger.debug(`WebAuthn registration challenge generated for user ${userId}`);

    return {
      challenge,
      rpId: this.rpId,
      rpName: this.rpName,
      userId: user.id,
      userName: user.getDisplayName(),
    };
  }

  /**
   * Step 2: Register a new credential after the client completes the
   * navigator.credentials.create() ceremony.
   *
   * SECURITY:
   * - SEC-CRITICAL-002: requires password re-authentication, so a stolen
   *   access token alone cannot plant a persistent biometric credential.
   * - The challenge is consumed atomically (GETDEL) and must belong to the
   *   calling user.
   * - `verifyRegistrationResponse` proves possession of the private key:
   *   the COSE public key is extracted from the attestation object, and
   *   origin/rpIdHash/challenge/UP-UV flags are all verified by the library.
   */
  async registerCredential(
    session: OriginatingAccessSession,
    input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    const userId = session.sub;
    // Step-up: verify the account password before touching the ceremony
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const proof = snapshotCredentialProof(user);
    const reAuth = await user.verifyPasswordAndSignalMigration(input.currentPassword);
    if (!reAuth.matched) {
      await this.logAudit(
        'WEBAUTHN_REGISTRATION_REAUTH_FAILED',
        user,
        {},
        AuditLogSeverity.WARNING,
      );
      throw new UnauthorizedException('Password verification failed');
    }

    // Atomic single-use challenge consumption
    const storedChallenge = await this.consumeChallenge(input.challenge);
    if (!storedChallenge || storedChallenge.type !== 'registration') {
      throw new BadRequestException('Invalid or expired challenge');
    }
    if (storedChallenge.userId !== userId) {
      throw new BadRequestException('Challenge does not match user');
    }

    const registrationResponse: RegistrationResponseJSON = {
      id: input.credentialId,
      rawId: input.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: input.clientDataJSON,
        attestationObject: input.attestationObject,
        transports: input.transports ?? [],
        publicKeyAlgorithm: input.publicKeyAlgorithm,
        ...(input.authenticatorData ? { authenticatorData: input.authenticatorData } : {}),
      },
    };

    let registrationInfo: Awaited<
      ReturnType<typeof verifyRegistrationResponse>
    >['registrationInfo'];
    try {
      const verification = await verifyRegistrationResponse({
        response: registrationResponse,
        expectedChallenge: input.challenge,
        expectedOrigin: this.allowedOrigins,
        expectedRPID: this.rpId,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new Error('verification not verified');
      }
      registrationInfo = verification.registrationInfo;
    } catch (error) {
      this.logger.warn(
        `WebAuthn registration rejected for user ${userId}: ${error instanceof Error ? error.message : 'verification failed'}`,
      );
      await this.logAudit(
        'WEBAUTHN_REGISTRATION_REJECTED',
        user,
        { credentialId: input.credentialId },
        AuditLogSeverity.WARNING,
      );
      throw new BadRequestException('Biometric credential verification failed');
    }

    // Library-derived credential — publicKey comes from the attestation,
    // never from client input.
    const derived = registrationInfo.credential;
    const publicKeyBase64url = Buffer.from(derived.publicKey).toString('base64url');

    return withLockedCredentialPrincipal(this.dataSource, proof, async (context) => {
      context.assertSessionAdmission();
      this.assertMfaUnlocked(context.user);
      await this.tokenService.assertOriginatingSessionInContext(context, session);
      const count = await context.manager.count(WebAuthnCredential, { where: { userId } });
      if (count >= MAX_CREDENTIALS_PER_USER) {
        throw new BadRequestException(`Maximum ${MAX_CREDENTIALS_PER_USER} biometric credentials per user`);
      }
      const existing = await context.manager.findOne(WebAuthnCredential, { where: { credentialId: derived.id } });
      if (existing) throw new BadRequestException('Credential already registered');
      const credential = {
        id: crypto.randomUUID(), userId, credentialId: derived.id, publicKey: publicKeyBase64url,
        counter: derived.counter, transports: derived.transports ?? input.transports,
        deviceName: input.deviceName || 'Biometric Device',
      };
      // INSERT only: unique credential ID and the User lock jointly own admission.
      await context.manager.insert(WebAuthnCredential, credential);
      await this.logAudit('WEBAUTHN_CREDENTIAL_REGISTERED', context.user, {
        credentialId: credential.id, deviceName: credential.deviceName,
      }, AuditLogSeverity.INFO, context.manager);
      return { success: true, message: 'Biometric credential registered successfully', credentialId: credential.credentialId };
    });
  }

  // ==========================================================================
  // Authentication Flow
  // ==========================================================================

  /**
   * Step 1: Generate an authentication challenge for a given email.
   *
   * SECURITY:
   * - Returns generic error if user has no credentials (prevents enumeration)
   */
  async generateLoginChallenge(email: string): Promise<WebAuthnLoginChallengeResponse> {
    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    if (!user || !user.isActive) {
      // SECURITY: identical message for unknown user and inactive account
      throw new UnauthorizedException('Biometric login not available');
    }

    const credentials = await this.credentialRepository.find({
      where: { userId: user.id },
    });

    if (credentials.length === 0) {
      throw new UnauthorizedException('Biometric login not available');
    }

    const challenge = crypto.randomBytes(32).toString('base64url');

    await this.storeChallenge(challenge, {
      challenge,
      userId: user.id,
      type: 'authentication',
      createdAt: Date.now(),
    });

    return {
      challenge,
      rpId: this.rpId,
      allowedCredentialIds: credentials.map((c) => c.credentialId),
    };
  }

  /**
   * Step 2: Verify the WebAuthn assertion and issue JWT tokens.
   *
   * SECURITY:
   * - Challenge consumed atomically (GETDEL), bound to the challenged user.
   * - `verifyAuthenticationResponse` verifies the signature over
   *   authenticatorData || SHA-256(clientDataJSON), the rpIdHash, the
   *   origin allowlist and the UP/UV flags (`requireUserVerification: true`).
   * - Counter rollback (cloned authenticator) rejects with a CRITICAL audit.
   * - SEC-CRITICAL-002: the SAME login gate as password login — account
   *   state AND tenant status must allow login. Biometric login must not
   *   become a side door around tenant suspension.
   */
  async verifyLogin(
    input: WebAuthnVerifyLoginInput,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    const storedChallenge = await this.consumeChallenge(input.challenge);
    if (!storedChallenge || storedChallenge.type !== 'authentication') {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    const credential = await this.credentialRepository.findOne({
      where: { credentialId: input.credentialId },
    });
    if (!credential) {
      throw new UnauthorizedException('Unknown credential');
    }
    if (credential.userId !== storedChallenge.userId) {
      throw new UnauthorizedException('Credential does not match user');
    }

    const observedUser = await this.userRepository.findOne({ where: { id: credential.userId } });
    if (!observedUser) throw new UnauthorizedException('Account not available');
    const proof = snapshotCredentialProof(observedUser);
    const verifiedCredential = {
      id: credential.id, userId: credential.userId, credentialId: credential.credentialId,
      publicKey: credential.publicKey, counter: credential.counter,
    };

    const authenticationResponse: AuthenticationResponseJSON = {
      id: input.credentialId,
      rawId: input.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: input.clientDataJSON,
        authenticatorData: input.authenticatorData,
        signature: input.signature,
        ...(input.userHandle ? { userHandle: input.userHandle } : {}),
      },
    };

    let newCounter: number;
    try {
      const verification = await verifyAuthenticationResponse({
        response: authenticationResponse,
        expectedChallenge: input.challenge,
        expectedOrigin: this.allowedOrigins,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          // COSE key stored at registration, base64url-encoded
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
          counter: credential.counter,
          transports: this.knownTransports(credential.transports),
        },
      });
      if (!verification.verified) {
        throw new Error('verification not verified');
      }
      newCounter = verification.authenticationInfo.newCounter;
    } catch (error) {
      this.logger.warn(
        `WebAuthn assertion rejected for credential ${credential.id}: ${error instanceof Error ? error.message : 'verification failed'}`,
      );
      await this.logAudit(
        'WEBAUTHN_LOGIN_FAILED',
        observedUser,
        { credentialId: credential.id, reason: 'Assertion verification failed' },
        AuditLogSeverity.WARNING,
      );
      throw new UnauthorizedException('Biometric verification failed');
    }

    const outcome = await withLockedCredentialPrincipal(this.dataSource, proof, async (context): Promise<{ value: AuthPayload } | { error: Error }> => {
      context.assertSessionAdmission();
      this.assertMfaUnlocked(context.user);
      const current = await context.manager.findOne(WebAuthnCredential, {
        where: { id: verifiedCredential.id, userId: context.user.id }, lock: { mode: 'pessimistic_write' },
      });
      if (!current || current.credentialId !== verifiedCredential.credentialId ||
          current.publicKey !== verifiedCredential.publicKey) {
        throw new UnauthorizedException('Credential changed during authentication');
      }
      // Counter-less authenticators legitimately keep both counters at zero.
      // Otherwise only a strictly greater signed counter can advance this row.
      if ((newCounter !== 0 || current.counter !== 0) && newCounter <= current.counter) {
        await this.logAudit('WEBAUTHN_COUNTER_ROLLBACK', context.user, {
          credentialId: current.id, storedCounter: current.counter, receivedCounter: newCounter,
        }, AuditLogSeverity.CRITICAL, context.manager);
        return { error: new UnauthorizedException('Authenticator security check failed') };
      }
      const update = await context.manager.update(WebAuthnCredential,
        { id: current.id, userId: context.user.id, publicKey: verifiedCredential.publicKey },
        { counter: newCounter, lastUsedAt: new Date() });
      if (update.affected !== 1) throw new UnauthorizedException('Credential changed during authentication');
      await context.manager.update(User, context.user.id, {
        lastLoginAt: new Date(), lastLoginIp: ipAddress ?? null, failedLoginAttempts: 0, lockedUntil: null,
      });
      const value = await this.tokenService.generateTokensInContext(context, ipAddress, userAgent, { mfaVerified: true });
      await this.logAudit('WEBAUTHN_LOGIN_SUCCESS', context.user, {
        credentialId: current.id, deviceName: current.deviceName, ipAddress,
      }, AuditLogSeverity.INFO, context.manager);
      return { value };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  // ==========================================================================
  // Credential Management
  // ==========================================================================

  /**
   * List all WebAuthn credentials for a user.
   */
  async getUserCredentials(userId: string): Promise<WebAuthnCredentialInfo[]> {
    const credentials = await this.credentialRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });

    return credentials.map((c) => ({
      credentialId: c.credentialId,
      deviceName: c.deviceName,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));
  }

  /**
   * Remove a WebAuthn credential.
   */
  async removeCredential(session: OriginatingAccessSession, credentialId: string): Promise<WebAuthnRemoveResponse> {
    const userId = session.sub;
    return withLockedCredentialPrincipal(this.dataSource, userId, async (context) => {
      context.assertSessionAdmission();
      await this.tokenService.assertOriginatingSessionInContext(context, session);
      const credential = await context.manager.findOne(WebAuthnCredential, {
        where: { credentialId, userId }, lock: { mode: 'pessimistic_write' },
      });
      if (!credential) throw new BadRequestException('Credential not found');
      await context.manager.delete(WebAuthnCredential, { id: credential.id, userId });
      await this.logAudit('WEBAUTHN_CREDENTIAL_REMOVED', context.user, {
        credentialId: credential.id, deviceName: credential.deviceName,
      }, AuditLogSeverity.INFO, context.manager);
      return { success: true, message: 'Credential removed successfully' };
    });
  }

  /**
   * Remove ALL WebAuthn credentials for a user.
   *
   * Called by GdprComplianceService.executeErasure() AND by
   * AuthenticationService.resetPassword() (SEC-CRITICAL-002 №38): a password
   * reset invalidates every second factor bound to the previous credential
   * set, so a biometric credential planted with a stolen token cannot
   * survive the victim rotating their password.
   */
  async removeAllCredentials(userId: string): Promise<number> {
    return withLockedCredentialPrincipal(this.dataSource, userId, async (context) => {
      const removed = await context.manager.delete(WebAuthnCredential, { userId });
      return removed.affected ?? 0;
    });
  }

  /**
   * Check if a user has any WebAuthn credentials registered.
   */
  async hasCredentials(userId: string): Promise<boolean> {
    const count = await this.credentialRepository.count({ where: { userId } });
    return count > 0;
  }

  // ==========================================================================
  // Internal Helpers
  // ==========================================================================

  /**
   * Narrow stored transport strings to the WebAuthn L3 vocabulary the
   * library accepts (historical rows may hold arbitrary strings).
   */
  private assertMfaUnlocked(user: User): void {
    if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Account locked');
    }
  }

  private knownTransports(transports: string[] | undefined): WebAuthnTransport[] {
    const known: readonly string[] = WEBAUTHN_TRANSPORTS;
    return (transports ?? []).filter((t): t is WebAuthnTransport => known.includes(t));
  }

  // ── Challenge store (Redis-backed, atomic single-use via GETDEL) ──────────

  private challengeKey(c: string): string {
    return `webauthn:challenge:${c}`;
  }

  private async storeChallenge(challenge: string, data: StoredChallenge): Promise<void> {
    await this.redisService.set(
      this.challengeKey(challenge),
      JSON.stringify(data),
      CHALLENGE_TTL_SECONDS,
    );
  }

  /**
   * Atomically consume a challenge: GETDEL returns the stored value and
   * deletes the key in one round-trip, so two concurrent ceremonies with
   * the same challenge cannot both succeed.
   */
  private async consumeChallenge(challenge: string): Promise<StoredChallenge | null> {
    const raw = await this.redisService.getdel(this.challengeKey(challenge));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredChallenge;
    } catch {
      return null;
    }
  }

  /**
   * Persist a WebAuthn audit row.
   *
   * # Why no try/catch wraps the write (AUDITTRAIL-HIGH-003 sibling)
   *
   * Same fail-closed posture as MfaService.logMfaEvent: WebAuthn is a
   * security gate; its audit rows carry SOC 2 CC6.1 step-up evidence.
   * A silent swallow on DB failure silently loses that evidence while
   * letting the WebAuthn flow proceed as if audit succeeded — the same
   * regression class the auditor flagged on mfa.service.ts.
   *
   * Tier-1 "make it impossible": no future maintainer can reintroduce
   * silent loss without deliberately re-adding the swallow.
   */
  private async logAudit(
    action: string,
    user: Pick<User, 'id' | 'tenantId'>,
    details: Record<string, unknown>,
    severity: AuditLogSeverity = AuditLogSeverity.INFO,
    manager?: EntityManager,
  ): Promise<void> {
    await this.auditLogService.log({
      performedBy: user.id,
      tenantId: user.tenantId ?? undefined,
      action,
      entityType: 'WebAuthnCredential',
      entityId: user.id,
      details: {
        ...details,
        timestamp: new Date().toISOString(),
      },
      severity,
    }, manager);
  }
}
