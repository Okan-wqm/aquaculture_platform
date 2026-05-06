import * as crypto from 'crypto';

import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { AuditLogSeverity } from '../../../audit/audit-log.entity';
import { User } from '../entities/user.entity';
import {
  SetupMfaResponse,
  VerifyMfaSetupResponse,
  DisableMfaResponse,
  RegenerateMfaRecoveryCodesResponse,
} from '../dto/mfa.dto';
import { AuthPayload } from '../dto/auth-response.dto';
import { TokenService } from './token.service';

// ============================================================================
// Constants
// ============================================================================

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_PREFIX = 'ENC_V1:';

/** TOTP time step in seconds (RFC 6238 default) */
const TOTP_PERIOD = 30;

/** Number of periods to check before/after current (±1 = 30s tolerance) */
const TOTP_WINDOW = 1;

/** Number of TOTP digits (RFC 4226 default) */
const TOTP_DIGITS = 6;

/** Number of recovery codes to generate */
const RECOVERY_CODE_COUNT = 8;

/** Recovery code length (characters) */
const RECOVERY_CODE_LENGTH = 10;

/** MFA token (intermediate JWT) TTL in seconds */
const MFA_TOKEN_TTL_SECONDS = 300; // 5 minutes

/** Max failed MFA attempts before lockout */
const MFA_MAX_FAILED_ATTEMPTS = 5;

/** MFA lockout duration in minutes */
const MFA_LOCKOUT_DURATION_MINUTES = 15;

/** MFA token JWT subject prefix to distinguish from regular tokens */
const MFA_TOKEN_PREFIX = 'mfa:';

/** Base32 alphabet for TOTP secret encoding */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ============================================================================
// TOTP Implementation (RFC 6238 / RFC 4226)
// ============================================================================

/**
 * Encode a buffer as base32 (RFC 4648)
 */
function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]!;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Decode a base32 string to a Buffer (RFC 4648)
 */
function base32Decode(encoded: string): Buffer {
  const cleanInput = encoded.replace(/[=\s]/g, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < cleanInput.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleanInput[i]!);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${cleanInput[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate HOTP code (RFC 4226)
 *
 * @param secret - The shared secret key
 * @param counter - The counter value (8-byte big-endian)
 * @param digits - Number of digits in the OTP (default 6)
 */
function generateHOTP(secret: Buffer, counter: bigint, digits: number = TOTP_DIGITS): string {
  // Step 1: Generate HMAC-SHA1
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  // Step 2: Dynamic truncation (RFC 4226 Section 5.3)
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);

  // Step 3: Compute HOTP value
  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Generate TOTP code (RFC 6238)
 *
 * @param secret - The shared secret key (raw bytes)
 * @param time - Unix timestamp in seconds (default: current time)
 * @param period - Time step in seconds (default: 30)
 */
function generateTOTP(
  secret: Buffer,
  time: number = Math.floor(Date.now() / 1000),
  period: number = TOTP_PERIOD,
): string {
  const counter = BigInt(Math.floor(time / period));
  return generateHOTP(secret, counter);
}

/**
 * Verify a TOTP code with a time window tolerance.
 *
 * @param secret - The shared secret key (raw bytes)
 * @param code - The code to verify
 * @param window - Number of periods before/after to check (default: 1)
 * @returns true if the code matches any period in the window
 */
function verifyTOTP(
  secret: Buffer,
  code: string,
  window: number = TOTP_WINDOW,
): boolean {
  const now = Math.floor(Date.now() / 1000);

  for (let i = -window; i <= window; i++) {
    const time = now + i * TOTP_PERIOD;
    const expected = generateTOTP(secret, time);

    // SECURITY: Use timing-safe comparison to prevent timing attacks
    if (
      code.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))
    ) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// MFA Service
// ============================================================================

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private encryptionKey: Buffer | null = null;
  private mfaDisabled = false;
  private readonly issuerName: string;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly tokenService: TokenService,
  ) {
    this.issuerName = this.configService.get<string>(
      'MFA_ISSUER_NAME',
      'AquaculturePlatform',
    );

    /**
     * SECURITY (H-17): MFA encryption key validation with graceful degradation.
     *
     * MFA is an optional security feature — its absence should NOT prevent the
     * entire auth-service from starting. An auth service without MFA (password-only)
     * is strictly better than no auth service at all.
     *
     * Architecture decision: Infrastructure requirements (JWT_SECRET, DATABASE_PASSWORD)
     * cause hard crash because the service literally cannot function without them.
     * Feature availability (MFA, WebAuthn) degrades gracefully — the feature is
     * disabled and a prominent error is logged so operators can configure it.
     *
     * When MFA_ENCRYPTION_KEY is not configured:
     * - All MFA enrollment/verification endpoints return 503 with clear message
     * - Existing MFA-enrolled users fall back to password-only until key is set
     * - Security audit logs capture the degraded state for compliance visibility
     */
    const masterKey = this.configService.get<string>('MFA_ENCRYPTION_KEY');
    if (!masterKey) {
      const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
      const logLevel = nodeEnv === 'production' ? 'error' : 'warn';

      this.logger[logLevel](
        'SECURITY: MFA_ENCRYPTION_KEY not configured — MFA features DISABLED. ' +
        'Users cannot enable or use multi-factor authentication until this env var is set. ' +
        'Generate a 64-character hex key: openssl rand -hex 32',
      );
      this.mfaDisabled = true;
      return;
    }

    // Parse encryption key: support 64-char hex or derive via scrypt
    if (masterKey.length === 64 && /^[0-9a-fA-F]+$/.test(masterKey)) {
      this.encryptionKey = Buffer.from(masterKey, 'hex');
    } else {
      const salt = crypto.createHash('sha256').update(masterKey).digest().subarray(0, 16);
      this.encryptionKey = crypto.scryptSync(masterKey, salt, 32);
    }

    this.logger.log('MFA encryption initialized');
  }

  /**
   * Check if MFA feature is available (encryption key is configured).
   * Used by AuthenticationService to decide whether to trigger MFA flow.
   */
  isMfaAvailable(): boolean {
    return !this.mfaDisabled;
  }

  // ==========================================================================
  // MFA Setup Flow
  // ==========================================================================

  /**
   * Step 1: Generate TOTP secret and recovery codes for the user.
   * Does NOT enable MFA yet — user must verify with a valid TOTP code first.
   *
   * The secret is stored encrypted but mfaEnabled remains false until verification.
   */
  async setupMfa(userId: string): Promise<SetupMfaResponse> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }
    const user = await this.findUserOrFail(userId);

    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled for this account');
    }

    // Generate a 20-byte (160-bit) random secret (RFC 4226 recommended minimum)
    const secretBuffer = crypto.randomBytes(20);
    const secretBase32 = base32Encode(secretBuffer);

    // Generate recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodeHashes = recoveryCodes
      .map((code) => crypto.createHash('sha256').update(code).digest('hex'))
      .join(',');

    // Encrypt secret before storage
    const encryptedSecret = this.encrypt(secretBase32);

    // Store encrypted secret and hashed recovery codes (but keep mfaEnabled=false)
    user.mfaSecret = encryptedSecret;
    user.mfaRecoveryCodes = recoveryCodeHashes;
    user.mfaFailedAttempts = 0;
    user.mfaLockedUntil = null;
    await this.userRepository.save(user);

    // Build otpauth URI for QR code
    const qrCodeUri = this.buildOtpauthUri(user.email, secretBase32);

    await this.logMfaEvent('MFA_SETUP_INITIATED', user, true);

    return {
      secret: secretBase32,
      qrCodeUri,
      recoveryCodes,
    };
  }

  /**
   * Step 2: Verify the first TOTP code to complete MFA setup.
   * Sets mfaEnabled=true on success.
   */
  async verifyMfaSetup(userId: string, code: string): Promise<VerifyMfaSetupResponse> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }
    const user = await this.findUserOrFail(userId);

    if (user.mfaEnabled) {
      throw new BadRequestException('MFA is already enabled');
    }

    if (!user.mfaSecret) {
      throw new BadRequestException('MFA setup has not been initiated. Call setupMfa first.');
    }

    // Decrypt the stored secret
    const secretBase32 = this.decrypt(user.mfaSecret);
    const secretBuffer = base32Decode(secretBase32);

    // Verify the TOTP code
    if (!verifyTOTP(secretBuffer, code)) {
      await this.logMfaEvent('MFA_SETUP_VERIFY_FAILED', user, false, 'Invalid TOTP code');
      throw new BadRequestException('Invalid TOTP code. Please try again with a new code from your authenticator app.');
    }

    // Enable MFA
    user.mfaEnabled = true;
    user.mfaFailedAttempts = 0;
    user.mfaLockedUntil = null;
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_ENABLED', user, true);

    return {
      success: true,
      message: 'MFA has been successfully enabled',
    };
  }

  /**
   * Disable MFA after verifying password and TOTP code.
   */
  async disableMfa(userId: string, password: string, code: string): Promise<DisableMfaResponse> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }
    const user = await this.findUserOrFail(userId);

    if (!user.mfaEnabled) {
      throw new BadRequestException('MFA is not enabled for this account');
    }

    // Verify password
    const isPasswordValid = await user.validatePassword(password);
    if (!isPasswordValid) {
      await this.logMfaEvent('MFA_DISABLE_FAILED', user, false, 'Invalid password');
      throw new UnauthorizedException('Invalid password');
    }

    // Verify TOTP code
    if (!user.mfaSecret) {
      throw new BadRequestException('MFA configuration is corrupted. Contact support.');
    }

    const secretBase32 = this.decrypt(user.mfaSecret);
    const secretBuffer = base32Decode(secretBase32);

    if (!verifyTOTP(secretBuffer, code)) {
      await this.logMfaEvent('MFA_DISABLE_FAILED', user, false, 'Invalid TOTP code');
      throw new BadRequestException('Invalid TOTP code');
    }

    // Disable MFA and clear all MFA data
    user.mfaEnabled = false;
    user.mfaSecret = null;
    user.mfaRecoveryCodes = null;
    user.mfaFailedAttempts = 0;
    user.mfaLockedUntil = null;
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_DISABLED', user, true);

    return {
      success: true,
      message: 'MFA has been successfully disabled',
    };
  }

  /**
   * Regenerate recovery codes (requires authentication + TOTP verification).
   */
  async regenerateRecoveryCodes(userId: string, code: string): Promise<RegenerateMfaRecoveryCodesResponse> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }
    const user = await this.findUserOrFail(userId);

    if (!user.mfaEnabled || !user.mfaSecret) {
      throw new BadRequestException('MFA is not enabled for this account');
    }

    // Verify TOTP code
    const secretBase32 = this.decrypt(user.mfaSecret);
    const secretBuffer = base32Decode(secretBase32);

    if (!verifyTOTP(secretBuffer, code)) {
      throw new BadRequestException('Invalid TOTP code');
    }

    // Generate new recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const recoveryCodeHashes = recoveryCodes
      .map((c) => crypto.createHash('sha256').update(c).digest('hex'))
      .join(',');

    user.mfaRecoveryCodes = recoveryCodeHashes;
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_RECOVERY_CODES_REGENERATED', user, true);

    return { recoveryCodes };
  }

  // ==========================================================================
  // Login MFA Flow
  // ==========================================================================

  /**
   * Check if a user requires MFA during login.
   * If yes, generate a short-lived mfaToken instead of full auth tokens.
   *
   * Called from AuthenticationService.login() after successful password validation.
   */
  generateMfaChallenge(user: User): { mfaRequired: true; mfaToken: string } {
    // Generate a short-lived JWT specifically for MFA verification
    const mfaPayload = {
      sub: `${MFA_TOKEN_PREFIX}${user.id}`,
      purpose: 'mfa_verification',
      userId: user.id,
      jti: crypto.randomUUID(),
    };

    const mfaToken = this.jwtService.sign(mfaPayload, {
      expiresIn: MFA_TOKEN_TTL_SECONDS,
    });

    return {
      mfaRequired: true,
      mfaToken,
    };
  }

  /**
   * Verify MFA code during login flow.
   *
   * Accepts either a 6-digit TOTP code or a recovery code.
   * On success, returns full auth tokens via AuthenticationService.
   */
  async verifyMfaLogin(
    mfaToken: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }
    // Validate the MFA token
    let mfaPayload: { sub: string; userId: string; purpose: string; jti: string };
    try {
      mfaPayload = this.jwtService.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('MFA token is invalid or expired. Please login again.');
    }

    // Validate token purpose
    if (
      mfaPayload.purpose !== 'mfa_verification' ||
      !mfaPayload.sub?.startsWith(MFA_TOKEN_PREFIX)
    ) {
      throw new UnauthorizedException('Invalid MFA token');
    }

    const userId = mfaPayload.userId;
    const user = await this.findUserOrFail(userId);

    // Check MFA lockout
    if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) {
      const remainingMs = user.mfaLockedUntil.getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      await this.logMfaEvent('MFA_VERIFY_BLOCKED_LOCKOUT', user, false, 'MFA locked out');
      throw new ForbiddenException(
        `Too many failed MFA attempts. Try again in ${remainingMin} minute(s).`,
      );
    }

    if (!user.mfaEnabled || !user.mfaSecret) {
      throw new BadRequestException('MFA is not enabled for this account');
    }

    // Try TOTP code first (6 digits)
    const isTotpCode = /^\d{6}$/.test(code);
    let verified = false;

    if (isTotpCode) {
      const secretBase32 = this.decrypt(user.mfaSecret);
      const secretBuffer = base32Decode(secretBase32);
      verified = verifyTOTP(secretBuffer, code);
    }

    // If TOTP didn't match, try recovery code
    if (!verified) {
      verified = await this.verifyAndConsumeRecoveryCode(user, code);
    }

    if (!verified) {
      // Increment failed attempts
      user.mfaFailedAttempts = (user.mfaFailedAttempts || 0) + 1;

      if (user.mfaFailedAttempts >= MFA_MAX_FAILED_ATTEMPTS) {
        user.mfaLockedUntil = new Date(Date.now() + MFA_LOCKOUT_DURATION_MINUTES * 60 * 1000);
        await this.userRepository.save(user);
        await this.logMfaEvent('MFA_LOCKOUT', user, false, `Locked after ${MFA_MAX_FAILED_ATTEMPTS} failed attempts`);
        throw new ForbiddenException(
          `Too many failed MFA attempts. Account locked for ${MFA_LOCKOUT_DURATION_MINUTES} minutes.`,
        );
      }

      await this.userRepository.save(user);
      await this.logMfaEvent('MFA_VERIFY_FAILED', user, false, `Attempt ${user.mfaFailedAttempts}`);
      throw new UnauthorizedException('Invalid MFA code');
    }

    // Success — reset failed attempts
    user.mfaFailedAttempts = 0;
    user.mfaLockedUntil = null;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_VERIFY_SUCCESS', user, true);

    // IP-2: MFA login verification → set mfaVerified claim in JWT
    return this.tokenService.generateTokens(user, ipAddress, userAgent, { mfaVerified: true });
  }

  // ==========================================================================
  // Step-Up Authentication
  // ==========================================================================

  /**
   * IP-2: MFA step-up authentication for elevated operations.
   *
   * Called when a user with an existing session needs to re-verify their
   * identity for sensitive operations (e.g., impersonation, billing changes).
   * Returns a new access token with `mfaVerified: true` claim.
   *
   * SECURITY: The caller must already be authenticated (valid access token).
   * This endpoint only elevates the session — it does not create one.
   *
   * WHY: Separate from login MFA because:
   *   - Login MFA uses a short-lived mfaToken (5 min) as credential
   *   - Step-up uses the existing access token as credential
   *   - Step-up tokens have a shorter TTL (5 min) to limit blast radius
   *
   * @param userId    - From the existing JWT (not user-supplied)
   * @param code      - 6-digit TOTP code or recovery code
   * @param ipAddress - Client IP for audit logging
   * @param userAgent - Client user agent for audit logging
   * @returns New auth tokens with mfaVerified=true claim
   */
  async verifyStepUp(
    userId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<AuthPayload> {
    if (this.mfaDisabled) {
      throw new BadRequestException('MFA is not available. MFA_ENCRYPTION_KEY must be configured.');
    }

    const user = await this.findUserOrFail(userId);

    if (!user.mfaEnabled || !user.mfaSecret) {
      throw new BadRequestException(
        'MFA is not enabled for this account. Enable MFA first via setupMfa mutation.',
      );
    }

    // ── Lockout check ───────────────────────────────────────────────────────
    if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) {
      const remainingMin = Math.ceil((user.mfaLockedUntil.getTime() - Date.now()) / 60000);
      await this.logMfaEvent('MFA_STEPUP_BLOCKED_LOCKOUT', user, false, 'MFA locked out');
      throw new ForbiddenException(
        `Too many failed MFA attempts. Try again in ${remainingMin} minute(s).`,
      );
    }

    // ── TOTP verification ───────────────────────────────────────────────────
    const isTotpCode = /^\d{6}$/.test(code);
    let verified = false;

    if (isTotpCode) {
      const secretBase32 = this.decrypt(user.mfaSecret);
      const secretBuffer = base32Decode(secretBase32);
      verified = verifyTOTP(secretBuffer, code);
    }

    // ── Recovery code fallback ──────────────────────────────────────────────
    if (!verified) {
      verified = await this.verifyAndConsumeRecoveryCode(user, code);
    }

    if (!verified) {
      user.mfaFailedAttempts = (user.mfaFailedAttempts || 0) + 1;
      if (user.mfaFailedAttempts >= MFA_MAX_FAILED_ATTEMPTS) {
        user.mfaLockedUntil = new Date(Date.now() + MFA_LOCKOUT_DURATION_MINUTES * 60 * 1000);
        await this.userRepository.save(user);
        await this.logMfaEvent('MFA_STEPUP_LOCKOUT', user, false,
          `Locked after ${MFA_MAX_FAILED_ATTEMPTS} failed attempts`);
        throw new ForbiddenException(
          `Too many failed MFA attempts. Account locked for ${MFA_LOCKOUT_DURATION_MINUTES} minutes.`,
        );
      }
      await this.userRepository.save(user);
      await this.logMfaEvent('MFA_STEPUP_FAILED', user, false, `Attempt ${user.mfaFailedAttempts}`);
      throw new UnauthorizedException('Invalid MFA code');
    }

    // ── Success: reset failures, issue elevated token ───────────────────────
    user.mfaFailedAttempts = 0;
    user.mfaLockedUntil = null;
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_STEPUP_SUCCESS', user, true);

    return this.tokenService.generateTokens(user, ipAddress, userAgent, { mfaVerified: true });
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private async findUserOrFail(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  /**
   * Generate cryptographically secure recovery codes.
   * Format: XXXXX-XXXXX (alphanumeric, case-insensitive)
   */
  private generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes I, O, 0, 1 for readability

    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
      let code = '';
      for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
        code += charset[bytes[j]! % charset.length];
      }
      // Format as XXXXX-XXXXX
      codes.push(`${code.substring(0, 5)}-${code.substring(5)}`);
    }

    return codes;
  }

  /**
   * Verify a recovery code and consume it (remove from stored hashes).
   * Returns true if a matching code was found and consumed.
   */
  private async verifyAndConsumeRecoveryCode(user: User, code: string): Promise<boolean> {
    if (!user.mfaRecoveryCodes) {
      return false;
    }

    // Normalize code: uppercase, remove dashes
    const normalizedCode = code.toUpperCase().replace(/-/g, '');
    // Re-add the dash for hashing (codes are stored as hashes of XXXXX-XXXXX format)
    const formattedCode = normalizedCode.length === 10
      ? `${normalizedCode.substring(0, 5)}-${normalizedCode.substring(5)}`
      : code.toUpperCase();

    const codeHash = crypto.createHash('sha256').update(formattedCode).digest('hex');
    const storedHashes = user.mfaRecoveryCodes.split(',');

    const matchIndex = storedHashes.findIndex((hash) =>
      crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(codeHash, 'hex')),
    );

    if (matchIndex === -1) {
      return false;
    }

    // Remove the consumed recovery code
    storedHashes.splice(matchIndex, 1);
    user.mfaRecoveryCodes = storedHashes.length > 0 ? storedHashes.join(',') : null;
    await this.userRepository.save(user);

    await this.logMfaEvent('MFA_RECOVERY_CODE_USED', user, true, `Remaining codes: ${storedHashes.length}`);

    return true;
  }

  /**
   * Build an otpauth:// URI for QR code generation (RFC 6238 / Google Authenticator compatible)
   */
  private buildOtpauthUri(email: string, secretBase32: string): string {
    const issuer = encodeURIComponent(this.issuerName);
    const account = encodeURIComponent(email);
    return `otpauth://totp/${issuer}:${account}?secret=${secretBase32}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
  }

  // ==========================================================================
  // Encryption (AES-256-GCM)
  // ==========================================================================

  private encrypt(plaintext: string): string {
    if (!this.encryptionKey) {
      // In development without key, store in plaintext with a warning prefix
      this.logger.warn('MFA secret stored without encryption (MFA_ENCRYPTION_KEY not set)');
      return plaintext;
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const payload = JSON.stringify({
      iv: iv.toString('hex'),
      tag: authTag.toString('hex'),
      data: encrypted,
    });

    return ENCRYPTION_PREFIX + Buffer.from(payload).toString('base64');
  }

  private decrypt(encryptedValue: string): string {
    // If not encrypted (dev mode), return as-is
    if (!encryptedValue.startsWith(ENCRYPTION_PREFIX)) {
      return encryptedValue;
    }

    if (!this.encryptionKey) {
      throw new Error('MFA_ENCRYPTION_KEY not configured — cannot decrypt MFA secret');
    }

    try {
      const payloadBase64 = encryptedValue.slice(ENCRYPTION_PREFIX.length);
      const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));

      const decipher = crypto.createDecipheriv(
        ENCRYPTION_ALGORITHM,
        this.encryptionKey,
        Buffer.from(payload.iv, 'hex'),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

      let decrypted = decipher.update(payload.data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(
        `MFA secret decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // ==========================================================================
  // Audit Logging
  // ==========================================================================

  /**
   * Persist an MFA audit row.
   *
   * # Why no try/catch wraps the write (AUDITTRAIL-HIGH-003)
   *
   * Pre-fix this method wrapped `auditLogService.log(...)` in a
   * try/catch and on DB failure logged the error and returned. Every
   * MFA gate (verify, step-up, lockout, disable) called this and then
   * proceeded as if audit had succeeded. Combined with the gates being
   * security boundaries — `MFA_VERIFY_FAILED`, `MFA_LOCKOUT`,
   * `MFA_STEPUP_FAILED`, `MFA_STEPUP_LOCKOUT`, `MFA_STEPUP_SUCCESS` are
   * all SOC 2 CC6.1 evidence-bearing rows — a single DB blip silently
   * lost evidence the platform is contractually required to keep.
   *
   * The architectural cure is fail-closed: the MFA gate succeeds only
   * if its audit row succeeds. If audit can't be written, the gate
   * fails, the user retries, and the platform stays auditable. This is
   * the right posture for a security gate — better to fail an MFA
   * verify than to silently drop the evidence row.
   *
   * Callers that already `await` this method (every callsite in this
   * file does — see lines 312, 345, 355, 379, 392, 404, 442, 514, 546,
   * 553, 563, 615, 641, 648, 657, 727) will surface the failure to
   * the request handler as the throw-bubble convention. The
   * AuditLogService.log() implementation in
   * apps/auth-service/src/audit/audit-log.service.ts:36 already
   * propagates DB errors; removing the swallow here completes the
   * fail-closed chain end-to-end.
   *
   * Tier-1 "make it impossible" rationale: with the try/catch removed,
   * no future maintainer can reintroduce silent loss without
   * deliberately re-adding the swallow — a code review would catch it
   * because the swallow has no purpose when the contract is "audit
   * failure = MFA failure."
   */
  private async logMfaEvent(
    action: string,
    user: User,
    success: boolean,
    reason?: string,
  ): Promise<void> {
    await this.auditLogService.log({
      tenantId: user.tenantId || undefined,
      performedBy: user.id,
      performedByEmail: user.email,
      action,
      entityType: 'User',
      entityId: user.id,
      details: {
        success,
        reason,
        timestamp: new Date().toISOString(),
      },
      severity: success ? AuditLogSeverity.INFO : AuditLogSeverity.WARNING,
    });
  }
}
