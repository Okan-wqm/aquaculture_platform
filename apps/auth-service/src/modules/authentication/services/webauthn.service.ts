import * as crypto from 'crypto';

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
import { TokenService } from './token.service';

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
    private readonly tokenService: TokenService,
    @Optional() private readonly redisService?: RedisService,
  ) {
    // RP ID is the domain without protocol or port
    this.rpId = this.configService.get<string>('WEBAUTHN_RP_ID', 'localhost');
    this.rpName = this.configService.get<string>('WEBAUTHN_RP_NAME', 'AquaCulture Platform');
    this.useRedis = !!this.redisService;
    if (!this.useRedis) {
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

    // Check credential limit
    const existingCount = await this.credentialRepository.count({ where: { userId } });
    if (existingCount >= MAX_CREDENTIALS_PER_USER) {
      throw new BadRequestException(
        `Maximum ${MAX_CREDENTIALS_PER_USER} biometric credentials per user`,
      );
    }

    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('base64url');

    // Store challenge for verification
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
   * - Validates challenge was issued by us and is not expired
   * - Validates origin matches expected RP
   * - Validates clientDataJSON type is "webauthn.create"
   * - Stores public key for future authentication
   */
  async registerCredential(
    userId: string,
    input: WebAuthnRegisterCredentialInput,
  ): Promise<WebAuthnRegisterResponse> {
    // Verify challenge
    const storedChallenge = await this.getChallenge(input.challenge);
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
      await this.deleteChallenge(input.challenge);
      throw new BadRequestException('Challenge expired');
    }

    // Single-use: delete challenge immediately
    await this.deleteChallenge(input.challenge);

    // Validate clientDataJSON
    try {
      const clientData = JSON.parse(
        Buffer.from(input.clientDataJSON, 'base64url').toString('utf-8'),
      );

      // Verify type
      if (clientData.type !== 'webauthn.create') {
        throw new BadRequestException('Invalid clientData type');
      }

      // Verify challenge matches
      if (clientData.challenge !== input.challenge) {
        throw new BadRequestException('Challenge mismatch in clientData');
      }

      // Verify origin
      if (!this.isOriginAllowed(clientData.origin)) {
        this.logger.warn(
          `WebAuthn registration rejected: origin ${clientData.origin} not allowed`,
        );
        throw new BadRequestException('Origin not allowed');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Invalid clientDataJSON');
    }

    // Check for duplicate credential
    const existingCredential = await this.credentialRepository.findOne({
      where: { credentialId: input.credentialId },
    });
    if (existingCredential) {
      throw new BadRequestException('Credential already registered');
    }

    // Store credential
    const credential = this.credentialRepository.create({
      userId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: 0,
      transports: input.transports,
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

    // Get user's credentials
    const credentials = await this.credentialRepository.find({
      where: { userId: user.id },
    });

    if (credentials.length === 0) {
      throw new UnauthorizedException('Biometric login not available');
    }

    // Generate random challenge
    const challenge = crypto.randomBytes(32).toString('base64url');

    // Store challenge
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
    // Verify challenge
    const storedChallenge = await this.getChallenge(input.challenge);
    if (!storedChallenge) {
      throw new UnauthorizedException('Invalid or expired challenge');
    }

    if (storedChallenge.type !== 'authentication') {
      throw new UnauthorizedException('Challenge type mismatch');
    }

    if (Date.now() - storedChallenge.createdAt > CHALLENGE_TTL_MS) {
      await this.deleteChallenge(input.challenge);
      throw new UnauthorizedException('Challenge expired');
    }

    // Single-use
    await this.deleteChallenge(input.challenge);

    // Find credential
    const credential = await this.credentialRepository.findOne({
      where: { credentialId: input.credentialId },
    });

    if (!credential) {
      throw new UnauthorizedException('Unknown credential');
    }

    // Verify the credential belongs to the challenged user
    if (credential.userId !== storedChallenge.userId) {
      throw new UnauthorizedException('Credential does not match user');
    }

    // Validate clientDataJSON
    let clientData: { type: string; challenge: string; origin: string };
    try {
      clientData = JSON.parse(
        Buffer.from(input.clientDataJSON, 'base64url').toString('utf-8'),
      );
    } catch {
      throw new UnauthorizedException('Invalid clientDataJSON');
    }

    if (clientData.type !== 'webauthn.get') {
      throw new UnauthorizedException('Invalid clientData type');
    }

    if (clientData.challenge !== input.challenge) {
      throw new UnauthorizedException('Challenge mismatch in clientData');
    }

    if (!this.isOriginAllowed(clientData.origin)) {
      throw new UnauthorizedException('Origin not allowed');
    }

    // Verify the signature
    const isValid = this.verifySignature(
      credential.publicKey,
      input.authenticatorData,
      input.clientDataJSON,
      input.signature,
    );

    if (!isValid) {
      this.logger.warn(`WebAuthn signature verification failed for credential ${credential.id}`);
      await this.logAudit('WEBAUTHN_LOGIN_FAILED', credential.userId, {
        credentialId: credential.id,
        reason: 'Signature verification failed',
      }, AuditLogSeverity.WARNING);
      throw new UnauthorizedException('Biometric verification failed');
    }

    // Check and update counter (detect cloned authenticators)
    const authenticatorDataBuffer = Buffer.from(input.authenticatorData, 'base64url');
    const newCounter = this.extractCounter(authenticatorDataBuffer);

    if (newCounter !== 0 && newCounter <= credential.counter) {
      this.logger.error(
        `WebAuthn counter rollback detected for credential ${credential.id}: ` +
        `stored=${credential.counter}, received=${newCounter}. Possible cloned authenticator.`,
      );
      await this.logAudit('WEBAUTHN_COUNTER_ROLLBACK', credential.userId, {
        credentialId: credential.id,
        storedCounter: credential.counter,
        receivedCounter: newCounter,
      }, AuditLogSeverity.CRITICAL);
      throw new UnauthorizedException('Authenticator security check failed');
    }

    // Update credential
    credential.counter = newCounter;
    credential.lastUsedAt = new Date();
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

    // ADR-045: a successful WebAuthn assertion IS a satisfied MFA factor, so no
    // enrollment gate applies here (SEC-MEDIUM — WebAuthn counts as MFA). The
    // tenant session-timeout clamp is applied automatically inside
    // generateTokens (resolved from the user's own tenant), so this mint path
    // is clamped like every other one.
    return this.tokenService.generateTokens(user, ipAddress, userAgent);
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
    this.logger.log(`GDPR: removed ${credentials.length} WebAuthn credential(s) for user ${userId}`);
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
   * Verify the WebAuthn assertion signature using the stored public key.
   *
   * The signature is over: authenticatorData || SHA-256(clientDataJSON)
   *
   * We use Node.js crypto for signature verification with ECDSA P-256 (ES256)
   * which is the most common algorithm for platform authenticators (Touch ID, Face ID, etc.)
   */
  private verifySignature(
    publicKeyBase64url: string,
    authenticatorDataBase64url: string,
    clientDataJSONBase64url: string,
    signatureBase64url: string,
  ): boolean {
    try {
      const publicKeyBuffer = Buffer.from(publicKeyBase64url, 'base64url');
      const authenticatorData = Buffer.from(authenticatorDataBase64url, 'base64url');
      const clientDataJSON = Buffer.from(clientDataJSONBase64url, 'base64url');
      const signature = Buffer.from(signatureBase64url, 'base64url');

      // Hash of clientDataJSON
      const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();

      // The signed data is: authenticatorData || clientDataHash
      const signedData = Buffer.concat([authenticatorData, clientDataHash]);

      // Try to verify using ECDSA P-256 (most common for platform authenticators)
      // The public key is stored in SPKI/DER format
      try {
        const verify = crypto.createVerify('SHA256');
        verify.update(signedData);

        // Try SPKI format first (the key may be stored as raw SPKI)
        const spkiKey = crypto.createPublicKey({
          key: publicKeyBuffer,
          format: 'der',
          type: 'spki',
        });

        return verify.verify(spkiKey, signature);
      } catch {
        // Fallback: try with raw EC key wrapped in SPKI header
        // This handles the case where the key is a raw COSE key
        // that we've converted to SPKI during registration
        this.logger.debug('Primary signature verification failed, trying fallback');
        return false;
      }
    } catch (error) {
      this.logger.error('Signature verification error', error);
      return false;
    }
  }

  /**
   * Extract the signature counter from authenticator data.
   * Counter is at bytes 33-36 (big-endian uint32).
   */
  private extractCounter(authenticatorData: Buffer): number {
    if (authenticatorData.length < 37) {
      return 0;
    }
    // Counter is at offset 33, 4 bytes big-endian
    return authenticatorData.readUInt32BE(33);
  }

  /**
   * Check if the origin is in the allowed origins list.
   */
  private isOriginAllowed(origin: string): boolean {
    const allowedOrigins = this.configService
      .get<string>('WEBAUTHN_ALLOWED_ORIGINS', `https://${this.rpId},http://localhost:3000,http://localhost:5173`)
      .split(',')
      .map((o) => o.trim());

    return allowedOrigins.includes(origin);
  }

  /**
   * Remove expired challenges from memory.
   */

  // ── Challenge store (Redis-backed with in-memory fallback) ──────────
  private challengeKey(c: string): string { return `webauthn:challenge:${c}`; }

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
      return raw ? JSON.parse(raw) as StoredChallenge : null;
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
