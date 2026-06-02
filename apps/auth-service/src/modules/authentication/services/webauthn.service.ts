import {
  Injectable,
  Optional,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { RedisService } from '@aquaculture/backend-common/redis';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential as SimpleWebAuthnCredential,
} from '@simplewebauthn/server';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
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
} from '../dto/webauthn.dto';
import { AuthPayload } from '../dto/auth-response.dto';
import { TokenIssuerService } from './token.service';

/**
 * In-memory challenge store with TTL.
 * Challenges expire after 5 minutes.
 *
 * SECURITY: Challenges are single-use and time-limited to prevent replay attacks.
 * In a multi-instance deployment, this should be replaced with Redis.
 */
interface StoredChallenge {
  challenge: string;
  userId: string;
  type: 'registration' | 'authentication';
  createdAt: number;
  webAuthnUserId?: string;
  deviceName?: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CREDENTIALS_PER_USER = 10;

@Injectable()
export class WebAuthnService {
  private readonly logger = new Logger(WebAuthnService.name);
  private readonly rpId: string;
  private readonly rpName: string;
  /** In-memory fallback when Redis unavailable */
  private readonly localChallenges = new Map<string, StoredChallenge>();
  private readonly useRedis: boolean;

  constructor(
    @InjectRepository(WebAuthnCredential)
    private readonly credentialRepository: Repository<WebAuthnCredential>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly tokenIssuer: TokenIssuerService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    // RP ID is the domain without protocol or port
    this.rpId = this.configService.get<string>('WEBAUTHN_RP_ID', 'localhost');
    this.rpName = this.configService.get<string>('WEBAUTHN_RP_NAME', 'AquaCulture Platform');
    this.useRedis = !!this.redisService;
    if (!this.useRedis) {
      if (this.configService.get<string>('NODE_ENV', 'development') === 'production') {
        throw new Error('WebAuthn requires Redis-backed challenge storage in production.');
      }
      this.logger.warn('WebAuthn challenge store: in-memory only (no Redis). Not distributed.');
      setInterval(() => this.cleanExpiredChallenges(), 60_000);
    }
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

    // Count and exclude every credential row. Version 1 rows are legacy
    // hand-rolled credentials, but login can upgrade compatible rows after
    // successful SimpleWebAuthn verification; they still occupy real devices.
    const existingCount = await this.credentialRepository.count({ where: { userId } });
    if (existingCount >= MAX_CREDENTIALS_PER_USER) {
      throw new BadRequestException(
        `Maximum ${MAX_CREDENTIALS_PER_USER} biometric credentials per user`,
      );
    }

    const existingCredentials = await this.credentialRepository.find({
      where: { userId },
    });

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: Buffer.from(user.id, 'utf8'),
      userName: user.email,
      userDisplayName: user.getDisplayName(),
      attestationType: 'none',
      excludeCredentials: existingCredentials.map((credential) => ({
        id: credential.credentialId,
        transports: this.toAuthenticatorTransports(credential.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge for verification
    await this.storeChallenge(options.challenge, {
      challenge: options.challenge,
      userId,
      type: 'registration',
      createdAt: Date.now(),
      webAuthnUserId: options.user.id,
      deviceName,
    });

    this.logger.debug(`WebAuthn registration challenge generated for user ${userId}`);

    return {
      challenge: options.challenge,
      rpId: this.rpId,
      rpName: this.rpName,
      userId: user.id,
      userName: user.getDisplayName(),
      options,
    };
  }

  /**
   * Step 2: Register a new credential after the client completes the
   * navigator.credentials.create() ceremony.
   *
   * SECURITY:
   * - Validates challenge was issued by us and is not expired
   * - Validates origin matches expected RP
   * - Validates clientDataJSON type is "webauthn.create"
   * - Stores public key for future authentication
   */
  async registerCredential(
    userId: string,
    input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    const challenge = this.extractChallengeFromResponse(input.response);
    // Verify challenge
    const storedChallenge = await this.getChallenge(challenge);
    if (!storedChallenge) {
      throw new BadRequestException('Invalid or expired challenge');
    }

    if (storedChallenge.type !== 'registration') {
      throw new BadRequestException('Challenge type mismatch');
    }

    if (storedChallenge.userId !== userId) {
      throw new BadRequestException('Challenge does not match user');
    }

    if (Date.now() - storedChallenge.createdAt > CHALLENGE_TTL_MS) {
      await this.deleteChallenge(challenge);
      throw new BadRequestException('Challenge expired');
    }

    // Single-use: delete challenge immediately
    await this.deleteChallenge(challenge);

    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: this.allowedOrigins(),
      expectedRPID: this.rpId,
      requireUserVerification: false,
    });

    if (!verification.verified) {
      throw new BadRequestException('Biometric credential registration failed');
    }
    const registrationInfo = verification.registrationInfo;
    const verifiedCredential = registrationInfo.credential;

    // Check for duplicate credential
    const existingCredential = await this.credentialRepository.findOne({
      where: { credentialId: verifiedCredential.id },
    });
    if (existingCredential) {
      throw new BadRequestException('Credential already registered');
    }

    // Store credential
    const credential = this.credentialRepository.create({
      userId,
      credentialId: verifiedCredential.id,
      publicKey: Buffer.from(verifiedCredential.publicKey).toString('base64url'),
      counter: verifiedCredential.counter,
      webAuthnUserId: storedChallenge.webAuthnUserId ?? null,
      transports: this.toStringTransports(
        input.transports ?? input.response.response.transports ?? verifiedCredential.transports,
      ),
      version: 2,
      deviceType: registrationInfo.credentialDeviceType,
      backedUp: registrationInfo.credentialBackedUp,
      aaguid: registrationInfo.aaguid,
      deviceName: input.deviceName || storedChallenge.deviceName || 'Biometric Device',
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
   * - Does not reveal whether the user exists
   */
  async generateLoginChallenge(email: string): Promise<WebAuthnLoginChallengeResponse> {
    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      // SECURITY: Return generic error to prevent user enumeration
      throw new UnauthorizedException('Biometric login not available');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Biometric login not available');
    }

    // Include v1 rows in the login allow-list. They were created by the
    // pre-SimpleWebAuthn path; verification below attempts a one-time
    // compatible decode and upgrades the row to v2 only after a successful
    // audited-library assertion.
    const credentials = await this.credentialRepository.find({
      where: { userId: user.id },
    });

    if (credentials.length === 0) {
      throw new UnauthorizedException('Biometric login not available');
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: this.toAuthenticatorTransports(credential.transports),
      })),
      userVerification: 'preferred',
    });

    // Store challenge
    await this.storeChallenge(options.challenge, {
      challenge: options.challenge,
      userId: user.id,
      type: 'authentication',
      createdAt: Date.now(),
    });

    return {
      challenge: options.challenge,
      rpId: this.rpId,
      allowedCredentialIds: credentials.map((c) => c.credentialId),
      options,
    };
  }

  /**
   * Step 2: Verify the WebAuthn assertion and issue JWT tokens.
   *
   * SECURITY:
   * - Validates challenge, origin, clientDataJSON type
   * - Verifies signature using stored public key
   * - Checks and increments counter to detect cloned authenticators
   * - Returns full auth tokens on success
   */
  async verifyLogin(
    input: WebAuthnVerifyLoginInput,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    const challenge = this.extractChallengeFromResponse(input.response);
    // Verify challenge
    const storedChallenge = await this.getChallenge(challenge);
    if (!storedChallenge) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    if (storedChallenge.type !== 'authentication') {
      throw new UnauthorizedException('Challenge type mismatch');
    }

    if (Date.now() - storedChallenge.createdAt > CHALLENGE_TTL_MS) {
      await this.deleteChallenge(challenge);
      throw new UnauthorizedException('Challenge expired');
    }

    // Single-use
    await this.deleteChallenge(challenge);

    // Find credential
    const credential = await this.credentialRepository.findOne({
      where: { credentialId: input.response.rawId || input.response.id },
    });

    if (!credential) {
      throw new UnauthorizedException('Unknown credential');
    }

    // Verify the credential belongs to the challenged user
    if (credential.userId !== storedChallenge.userId) {
      throw new UnauthorizedException('Credential does not match user');
    }

    const verificationCredential: SimpleWebAuthnCredential = {
      id: credential.credentialId,
      publicKey: Buffer.from(credential.publicKey, 'base64url'),
      counter: credential.counter,
      transports: this.toAuthenticatorTransports(credential.transports),
    };

    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: this.allowedOrigins(),
      expectedRPID: this.rpId,
      credential: verificationCredential,
      requireUserVerification: false,
    });

    if (!verification.verified) {
      this.logger.warn(`WebAuthn signature verification failed for credential ${credential.id}`);
      await this.logAudit(
        'WEBAUTHN_LOGIN_FAILED',
        credential.userId,
        {
          credentialId: credential.id,
          reason: 'Signature verification failed',
        },
        AuditLogSeverity.WARNING,
      );
      throw new UnauthorizedException('Biometric verification failed');
    }

    // Update credential
    credential.counter = verification.authenticationInfo.newCounter;
    credential.lastUsedAt = new Date();
    credential.deviceType = verification.authenticationInfo.credentialDeviceType;
    credential.backedUp = verification.authenticationInfo.credentialBackedUp;
    if (credential.version !== 2) {
      await this.logAudit('WEBAUTHN_LEGACY_CREDENTIAL_UPGRADED', credential.userId, {
        credentialId: credential.id,
        previousVersion: credential.version,
      });
      credential.version = 2;
    }
    await this.credentialRepository.save(credential);

    // Get user and generate tokens
    const user = await this.userRepository.findOne({ where: { id: credential.userId } });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Account not available');
    }

    if (user.isLocked()) {
      throw new UnauthorizedException('Account locked');
    }

    // Update user login info
    user.lastLoginAt = new Date();
    user.lastLoginIp = ipAddress ?? null;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.userRepository.save(user);

    this.logger.log(`WebAuthn login successful for user ${user.email}`);

    await this.logAudit('WEBAUTHN_LOGIN_SUCCESS', user.id, {
      credentialId: credential.id,
      deviceName: credential.deviceName,
      ipAddress,
    });

    return this.tokenIssuer.generateTokens(user, ipAddress, userAgent);
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
   * Remove ALL WebAuthn credentials for a user (GDPR erasure).
   *
   * Called by GdprComplianceService.executeErasure() to ensure passkey/security
   * key records (credentialPublicKey linked to a physical device) are deleted
   * as part of right-to-erasure. Without this, WebAuthn credentials persist
   * after account anonymisation.
   */
  async removeAllCredentials(userId: string): Promise<number> {
    const credentials = await this.credentialRepository.find({
      where: { userId },
    });
    if (credentials.length === 0) return 0;

    await this.credentialRepository.remove(credentials);
    this.logger.log(
      `GDPR: removed ${credentials.length} WebAuthn credential(s) for user ${userId}`,
    );
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

  private allowedOrigins(): string[] {
    return this.configService
      .get<string>(
        'WEBAUTHN_ALLOWED_ORIGINS',
        `https://${this.rpId},http://localhost:3000,http://localhost:5173`,
      )
      .split(',')
      .map((o) => o.trim())
      .filter((origin) => origin.length > 0);
  }

  private extractChallengeFromResponse(
    response: RegistrationResponseJSON | AuthenticationResponseJSON,
  ): string {
    try {
      const clientData = JSON.parse(
        Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
      ) as { challenge?: unknown };
      if (typeof clientData.challenge !== 'string' || clientData.challenge.length === 0) {
        throw new Error('missing challenge');
      }
      return clientData.challenge;
    } catch {
      throw new BadRequestException('Invalid WebAuthn clientDataJSON');
    }
  }

  private toAuthenticatorTransports(
    transports?: string[] | null,
  ): AuthenticatorTransportFuture[] | undefined {
    if (!transports?.length) return undefined;
    const allowed = new Set<AuthenticatorTransportFuture>([
      'ble',
      'cable',
      'hybrid',
      'internal',
      'nfc',
      'smart-card',
      'usb',
    ]);
    const normalized = transports.filter((transport): transport is AuthenticatorTransportFuture =>
      allowed.has(transport as AuthenticatorTransportFuture),
    );
    return normalized.length > 0 ? normalized : undefined;
  }

  private toStringTransports(
    transports?: string[] | AuthenticatorTransportFuture[] | null,
  ): string[] | undefined {
    return transports && transports.length > 0 ? [...transports] : undefined;
  }

  /**
   * Remove expired challenges from memory.
   */

  // ── Challenge store (Redis-backed with in-memory fallback) ──────────
  private challengeKey(c: string): string {
    return `webauthn:challenge:${c}`;
  }

  private async storeChallenge(challenge: string, data: StoredChallenge): Promise<void> {
    if (this.useRedis) {
      await this.redisService!.set(this.challengeKey(challenge), JSON.stringify(data), 300);
    } else {
      this.localChallenges.set(challenge, data);
    }
  }

  private async getChallenge(challenge: string): Promise<StoredChallenge | null> {
    if (this.useRedis) {
      const raw = await this.redisService!.get(this.challengeKey(challenge));
      return raw ? (JSON.parse(raw) as StoredChallenge) : null;
    }
    return this.localChallenges.get(challenge) ?? null;
  }

  private async deleteChallenge(challenge: string): Promise<void> {
    if (this.useRedis) {
      await this.redisService!.del(this.challengeKey(challenge));
    } else {
      this.localChallenges.delete(challenge);
    }
  }

  private cleanExpiredChallenges(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, value] of this.localChallenges.entries()) {
      if (now - value.createdAt > CHALLENGE_TTL_MS) {
        this.localChallenges.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} expired WebAuthn challenges`);
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
   * The cure is removing the try/catch and letting the failure bubble
   * to the caller, who already `await`s this helper. AuditLogService.log
   * propagates DB errors (apps/auth-service/src/audit/audit-log.service.ts:36),
   * so the chain is end-to-end fail-closed.
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
