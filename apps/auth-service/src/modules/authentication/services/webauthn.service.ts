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
import { CredentialProof } from './credential-proof';
import { TokenService } from './token.service';
import { UserAccountStore } from './user-account.store';

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

/**
 * Advance a passkey's signature counter by compare-and-set on the counter the
 * assertion was verified against; `false` when no row matched — the passkey
 * was deleted (a password reset revokes every passkey, SEC-CRITICAL-002) or a
 * concurrent login advanced it first. An UPDATE, never a `save()`: `save()` of
 * a credential a reset had deleted re-INSERTed it and undid the revocation.
 * One definition, so the real-Postgres spec exercises the exact statement the
 * login runs.
 */
export async function advanceCredentialCounter(
  manager: EntityManager,
  credential: Pick<WebAuthnCredential, 'id' | 'counter'>,
  newCounter: number,
): Promise<boolean> {
  const result = await manager
    .createQueryBuilder()
    .update(WebAuthnCredential)
    .set({ counter: newCounter, lastUsedAt: () => 'CURRENT_TIMESTAMP' })
    .where({ id: credential.id, counter: credential.counter })
    .execute();
  return result.affected === 1;
}

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
    // ORPHAN-HIGH-812: login bookkeeping is a column-scoped write, never a
    // whole-User save of the row read before the assertion was verified.
    private readonly userAccountStore: UserAccountStore,
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
    userId: string,
    input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    // Step-up: verify the account password before touching the ceremony
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    const reAuth = await user.verifyPasswordAndSignalMigration(input.currentPassword);
    if (!reAuth.matched) {
      await this.logAudit(
        'WEBAUTHN_REGISTRATION_REAUTH_FAILED',
        userId,
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
        userId,
        { credentialId: input.credentialId },
        AuditLogSeverity.WARNING,
      );
      throw new BadRequestException('Biometric credential verification failed');
    }

    // Library-derived credential — publicKey comes from the attestation,
    // never from client input.
    const derived = registrationInfo.credential;
    const publicKeyBase64url = Buffer.from(derived.publicKey).toString('base64url');

    // Check for duplicate credential
    const existingCredential = await this.credentialRepository.findOne({
      where: { credentialId: derived.id },
    });
    if (existingCredential) {
      throw new BadRequestException('Credential already registered');
    }

    const credential = this.credentialRepository.create({
      userId,
      credentialId: derived.id,
      publicKey: publicKeyBase64url,
      counter: derived.counter ?? 0,
      transports: derived.transports ?? input.transports,
      deviceName: input.deviceName || 'Biometric Device',
    });

    await this.credentialRepository.save(credential);

    this.logger.log(`WebAuthn credential registered for user ${userId}: ${credential.id}`);

    await this.logAudit('WEBAUTHN_CREDENTIAL_REGISTERED', userId, {
      credentialId: credential.id,
      deviceName: credential.deviceName,
    });

    return {
      success: true,
      message: 'Biometric credential registered successfully',
      credentialId: credential.credentialId,
    };
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

    // The principal is read BEFORE the assertion is verified, so the version
    // the mint is fenced on is the one the passkey was checked against
    // (ORPHAN-HIGH-811). A password reset that commits during verification —
    // it deletes every passkey and advances the version (SEC-CRITICAL-002) —
    // then refuses this mint instead of becoming its anchor. Account-state
    // checks still run only after the assertion, so a caller without the key
    // learns nothing about the account.
    const user = await this.userRepository.findOne({ where: { id: credential.userId } });

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
        credential.userId,
        { credentialId: credential.id, reason: 'Assertion verification failed' },
        AuditLogSeverity.WARNING,
      );
      throw new UnauthorizedException('Biometric verification failed');
    }

    if (newCounter !== 0 && newCounter <= credential.counter) {
      this.logger.error(
        `WebAuthn counter rollback detected for credential ${credential.id}: ` +
          `stored=${credential.counter}, received=${newCounter}. Possible cloned authenticator.`,
      );
      await this.logAudit(
        'WEBAUTHN_COUNTER_ROLLBACK',
        credential.userId,
        {
          credentialId: credential.id,
          storedCounter: credential.counter,
          receivedCounter: newCounter,
        },
        AuditLogSeverity.CRITICAL,
      );
      throw new UnauthorizedException('Authenticator security check failed');
    }

    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account not available');
    }
    if (user.isLocked()) {
      throw new UnauthorizedException('Account locked');
    }

    // Tenant gate — the same status machine as password login
    // (isLoginAllowed — ACTIVE only). Password login enforces this before
    // token mint (authentication.service.login); refresh enforces it in
    // assertTenantOperationalForRefresh. Biometric login is held to the
    // identical standard.
    if (user.tenantId) {
      const tenant = await this.tenantRepository.findOne({ where: { id: user.tenantId } });
      if (tenant && !isLoginAllowed(tenant.status)) {
        this.logger.debug(`WebAuthn login blocked: tenant ${user.tenantId} is ${tenant.status}`);
        await this.logAudit(
          'WEBAUTHN_LOGIN_TENANT_BLOCKED',
          user.id,
          { tenantId: user.tenantId, tenantStatus: tenant.status },
          AuditLogSeverity.WARNING,
        );
        throw new UnauthorizedException('Biometric login not available');
      }
    }

    // The passkey authenticated the row read before the assertion; the mint is
    // fenced on that credential (ORPHAN-HIGH-811) and commits with the login
    // bookkeeping and the counter advance, and success is recorded only for a
    // session that exists (ORPHAN-MEDIUM-813).
    //
    // Lock order is the canonical User -> credential one (the reset takes the
    // same): the bookkeeping UPDATE locks the user row, then the counter
    // advance is a compare-and-set on the counter the assertion was verified
    // against (advanceCredentialCounter). If the passkey is gone, or another
    // login advanced its counter first (a replayed or cloned assertion),
    // nothing is minted and nothing commits.
    const proof = CredentialProof.ofAuthenticatedPrincipal(user);
    const issued = await this.dataSource.transaction(async (manager) => {
      await this.userAccountStore.recordSignInCompleted(manager, user.id, ipAddress ?? null);
      if (!(await advanceCredentialCounter(manager, credential, newCounter))) {
        throw new UnauthorizedException('Biometric verification failed');
      }
      return this.tokenService.generateTokens(proof, ipAddress, userAgent, { manager });
    });

    this.logger.log(`WebAuthn login successful for user ${user.id}`);

    await this.logAudit('WEBAUTHN_LOGIN_SUCCESS', user.id, {
      credentialId: credential.id,
      deviceName: credential.deviceName,
      ipAddress,
    });

    return issued;
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
  async removeCredential(userId: string, credentialId: string): Promise<WebAuthnRemoveResponse> {
    const credential = await this.credentialRepository.findOne({
      where: { credentialId, userId },
    });

    if (!credential) {
      throw new BadRequestException('Credential not found');
    }

    await this.credentialRepository.remove(credential);

    this.logger.log(`WebAuthn credential removed for user ${userId}: ${credentialId}`);

    await this.logAudit('WEBAUTHN_CREDENTIAL_REMOVED', userId, {
      credentialId: credential.id,
      deviceName: credential.deviceName,
    });

    return {
      success: true,
      message: 'Credential removed successfully',
    };
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
    const credentials = await this.credentialRepository.find({
      where: { userId },
    });
    if (credentials.length === 0) return 0;

    await this.credentialRepository.remove(credentials);
    this.logger.log(`Removed ${credentials.length} WebAuthn credential(s) for user ${userId}`);
    return credentials.length;
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
    userId: string,
    details: Record<string, unknown>,
    severity: AuditLogSeverity = AuditLogSeverity.INFO,
  ): Promise<void> {
    await this.auditLogService.log({
      performedBy: userId,
      action,
      entityType: 'WebAuthnCredential',
      entityId: userId,
      details: {
        ...details,
        timestamp: new Date().toISOString(),
      },
      severity,
    });
  }
}
