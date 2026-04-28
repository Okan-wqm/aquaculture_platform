import * as crypto from 'crypto';

import { ThrottlePasswordReset } from '@aquaculture/backend-common/security';
import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { DataSource } from 'typeorm';

import { EmailSenderService } from '../settings/services/email-sender.service';
import { EmailTemplateService } from '../settings/services/email-template.service';

// ============================================================================
// Token Hashing Utility
// ============================================================================

/**
 * SECURITY (NEW-04): Hash a password reset token using HMAC-SHA256 with a server-side secret.
 *
 * When TOKEN_HMAC_SECRET is configured, produces an HMAC-SHA256 hash prefixed with "hmac:"
 * to distinguish from legacy SHA-256 hashes. This binds the hash to a server secret,
 * providing defense-in-depth even though the 32-byte random token already makes
 * rainbow tables impractical.
 *
 * When TOKEN_HMAC_SECRET is NOT set, falls back to plain SHA-256 for backward compatibility
 * during migration. Once all existing tokens have expired (max 1 hour), the legacy path
 * can be removed and TOKEN_HMAC_SECRET made mandatory.
 *
 * @param rawToken - The plaintext token to hash (typically 32 random bytes as hex)
 * @param hmacSecret - Optional server-side HMAC secret. When present, uses HMAC-SHA256.
 * @returns The hashed token string, prefixed with "hmac:" when HMAC is used.
 */
function hashResetToken(rawToken: string, hmacSecret?: string): string {
  if (hmacSecret) {
    return 'hmac:' + crypto.createHmac('sha256', hmacSecret).update(rawToken).digest('hex');
  }
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * SECURITY (NEW-04): Compute all possible hash variants for a given token.
 *
 * During the migration period, a verification request may arrive for a token
 * that was stored with either the HMAC or the legacy SHA-256 hash. This function
 * returns both variants so the DB lookup can match either one.
 *
 * Once TOKEN_HMAC_SECRET is mandated and all legacy tokens have expired,
 * remove the legacy hash from this list.
 *
 * @param rawToken - The plaintext token from the user's reset link
 * @param hmacSecret - Optional server-side HMAC secret
 * @returns Array of possible hash strings to match against the database
 */
function computeVerificationHashes(rawToken: string, hmacSecret?: string): string[] {
  const hashes: string[] = [];
  // Prefer HMAC hash (primary)
  if (hmacSecret) {
    hashes.push('hmac:' + crypto.createHmac('sha256', hmacSecret).update(rawToken).digest('hex'));
  }
  // Legacy SHA-256 fallback (remove once migration period ends)
  hashes.push(crypto.createHash('sha256').update(rawToken).digest('hex'));
  return hashes;
}

// DTOs
export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Valid email address is required' })
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  newPassword!: string;
}

// Mark endpoints as public (bypass auth guard)
const IS_PUBLIC_KEY = 'isPublic';
const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@ApiTags('Authentication')
@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger(PasswordResetController.name);

  /**
   * SECURITY (NEW-04): TOKEN_HMAC_SECRET is read once at construction time via ConfigService.
   * When set, all new password reset tokens are hashed with HMAC-SHA256.
   * When absent, falls back to legacy SHA-256 (backward compatible during migration).
   */
  private readonly tokenHmacSecret?: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly emailSenderService: EmailSenderService,
    private readonly emailTemplateService: EmailTemplateService,
    private readonly configService: ConfigService,
  ) {
    this.tokenHmacSecret = this.configService.get<string>('TOKEN_HMAC_SECRET');
    if (!this.tokenHmacSecret) {
      this.logger.warn(
        'TOKEN_HMAC_SECRET is not configured. Password reset tokens will use legacy SHA-256 hashing. ' +
        'Set TOKEN_HMAC_SECRET to enable HMAC-SHA256 defense-in-depth.',
      );
    }
  }

  /**
   * Request password reset - sends email with reset link
   * Always returns success to prevent email enumeration
   */
  @Post('forgot-password')
  @Public()
  @ThrottlePasswordReset()
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Look up user by email (auth.users columns are camelCase - no naming strategy)
      const users = await this.dataSource.query(
        `SELECT id, email, "firstName", "lastName" FROM auth.users WHERE email = $1 AND "isActive" = true`,
        [dto.email.toLowerCase()],
      );

      if (users && users.length > 0) {
        const user = users[0];

        // Generate reset token with HMAC-SHA256 (NEW-04)
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashResetToken(rawToken, this.tokenHmacSecret);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Store hashed token in DB
        await this.dataSource.query(
          `UPDATE auth.users SET "passwordResetToken" = $1, "passwordResetExpires" = $2 WHERE id = $3`,
          [tokenHash, expiresAt, user.id],
        );

        // Build reset link
        const baseUrl = process.env['FRONTEND_URL'] || 'http://localhost:8080';
        const resetLink = `${baseUrl}/reset-password/${rawToken}`;
        const userName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User';

        // Try to render the password_reset template
        try {
          const rendered = await this.emailTemplateService.renderTemplate({
            templateCode: 'password_reset',
            variables: {
              user_name: userName,
              reset_link: resetLink,
              expiry_hours: '1',
              platform_name: 'Aquaculture Platform',
              year: new Date().getFullYear().toString(),
            },
          });

          await this.emailSenderService.sendEmail(
            user.email,
            rendered.subject,
            rendered.bodyHtml,
            rendered.bodyText,
          );
        } catch (templateError) {
          // Fallback: send a simple email if template rendering fails
          this.logger.warn(`Template rendering failed, using fallback: ${(templateError as Error).message}`);
          await this.emailSenderService.sendEmail(
            user.email,
            'Reset Your Password - Aquaculture Platform',
            `<p>Hello ${userName},</p>
            <p>Click the link below to reset your password:</p>
            <p><a href="${resetLink}">${resetLink}</a></p>
            <p>This link expires in 1 hour.</p>
            <p>If you didn't request this, please ignore this email.</p>`,
          );
        }

        // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
        this.logger.log(`Password reset email sent for userId=${user.id}`);
      } else {
        // SECURITY: Do not log email -- prevents enumeration data in logs (H-14)
        this.logger.debug('Password reset requested for non-existent account');
      }
    } catch (error) {
      // Log error but don't reveal it to the user
      this.logger.error(
        `Error during forgot-password: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }

    // Always return success to prevent email enumeration
    return {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    };
  }

  /**
   * Reset password using token from email
   */
  @Post('reset-password')
  @Public()
  @ThrottlePasswordReset()
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ success: boolean; message: string }> {
    // SECURITY (NEW-04): Compute both HMAC and legacy hash variants for verification.
    // During migration, tokens may have been stored with either hash algorithm.
    // Try HMAC first (preferred), then fall back to legacy SHA-256.
    const candidateHashes = computeVerificationHashes(dto.token, this.tokenHmacSecret);

    // Find user with valid (non-expired) token, matching any candidate hash
    const users = await this.dataSource.query(
      `SELECT id, email FROM auth.users
       WHERE "passwordResetToken" = ANY($1)
       AND "passwordResetExpires" > NOW()`,
      [candidateHashes],
    );

    if (!users || users.length === 0) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const user = users[0];

    // Hash new password
    const hashedPassword = await bcrypt.hash(dto.newPassword, 12);

    // HIGH-001 fix: Update password, clear reset token, AND invalidate all refresh tokens
    // to terminate any existing sessions (session invalidation on password reset).
    await this.dataSource.query(
      `UPDATE auth.users
       SET password = $1, "passwordResetToken" = NULL, "passwordResetExpires" = NULL, "updatedAt" = NOW()
       WHERE id = $2`,
      [hashedPassword, user.id],
    );

    // HIGH-001 fix: Invalidate all existing refresh tokens so active sessions are terminated.
    await this.dataSource.query(
      `UPDATE auth.refresh_tokens
       SET "isRevoked" = true, "revokedAt" = NOW(), "revokedReason" = 'password_reset'
       WHERE "userId" = $1 AND "isRevoked" = false`,
      [user.id],
    );

    // SECURITY: Log user ID instead of email to prevent PII exposure in logs (H-14)
    this.logger.log(`Password reset successfully for userId=${user.id}`);

    return {
      success: true,
      message: 'Password has been reset successfully.',
    };
  }
}
