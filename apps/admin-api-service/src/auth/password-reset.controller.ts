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
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import { EmailSenderService } from '../settings/services/email-sender.service';
import { EmailTemplateService } from '../settings/services/email-template.service';

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

@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger(PasswordResetController.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly emailSenderService: EmailSenderService,
    private readonly emailTemplateService: EmailTemplateService,
  ) {}

  /**
   * Request password reset - sends email with reset link
   * Always returns success to prevent email enumeration
   */
  @Post('forgot-password')
  @Public()
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

        // Generate reset token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
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

        this.logger.log(`Password reset email sent to ${dto.email}`);
      } else {
        this.logger.debug(`Password reset requested for non-existent email: ${dto.email}`);
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
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ success: boolean; message: string }> {
    // Hash the incoming token to compare with stored hash
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');

    // Find user with valid (non-expired) token
    const users = await this.dataSource.query(
      `SELECT id, email FROM auth.users
       WHERE "passwordResetToken" = $1
       AND "passwordResetExpires" > NOW()`,
      [tokenHash],
    );

    if (!users || users.length === 0) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const user = users[0];

    // Hash new password
    const hashedPassword = await bcrypt.hash(dto.newPassword, 12);

    // Update password and clear reset token
    await this.dataSource.query(
      `UPDATE auth.users
       SET password = $1, "passwordResetToken" = NULL, "passwordResetExpires" = NULL, "updatedAt" = NOW()
       WHERE id = $2`,
      [hashedPassword, user.id],
    );

    this.logger.log(`Password reset successfully for user ${user.email}`);

    return {
      success: true,
      message: 'Password has been reset successfully.',
    };
  }
}
