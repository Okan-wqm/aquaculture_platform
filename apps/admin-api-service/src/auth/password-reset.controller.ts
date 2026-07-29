import { ThrottlePasswordReset } from '@aquaculture/backend-common/security';
import {
  BadGatewayException,
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  Inject,
  Req,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiTags } from '@nestjs/swagger';
import {
  AUTH_PUBLIC_COMMAND_SUBJECTS,
  type PublicRequestPasswordResetCommand,
  type PublicRequestPasswordResetResult,
  type PublicResetPasswordCommand,
  type PublicResetPasswordResult,
} from '@platform/event-contracts';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

// APA-371: use the canonical @Public() (re-exported from the platform SSoT) so
// the public password-reset routes and the guard agree on ONE bypass symbol,
// instead of a private local re-implementation that only worked by string luck.
import { Public } from '../decorators/public.decorator';

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

// DTOs
/**
 * What both password-reset routes answer.
 *
 * `success` is the literal `true`: `forgotPassword` ALWAYS reports success —
 * deliberately, to prevent email enumeration — and `resetPassword` throws on
 * every failure path. A `boolean` here would have invited the panel to branch on
 * a `false` that cannot arrive.
 */
export interface PasswordResetAcknowledgement {
  success: true;
  message: string;
}

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

type MinimalRequest = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

@ApiTags('Authentication')
@Controller('auth')
export class PasswordResetController {
  private readonly logger = new Logger(PasswordResetController.name);
  private readonly timeoutMs: number;

  constructor(
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AUTH_NATS_TIMEOUT_MS;
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
    @Req() request: MinimalRequest,
  ): Promise<PasswordResetAcknowledgement> {
    try {
      await this.sendAuthCommand<
        PublicRequestPasswordResetCommand,
        PublicRequestPasswordResetResult
      >(AUTH_PUBLIC_COMMAND_SUBJECTS.REQUEST_PASSWORD_RESET, {
        email: dto.email.toLowerCase(),
        ipAddress: this.getIpAddress(request),
        correlationId: this.getCorrelationId(request),
      });
    } catch (error) {
      // Log error but don't reveal it to the user
      this.logger.error(
        `Auth-service password reset request failed: ${(error as Error).message}`,
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
    @Req() request: MinimalRequest,
  ): Promise<PasswordResetAcknowledgement> {
    const result = await this.sendAuthCommand<
      PublicResetPasswordCommand,
      PublicResetPasswordResult
    >(AUTH_PUBLIC_COMMAND_SUBJECTS.RESET_PASSWORD, {
      token: dto.token,
      newPassword: dto.newPassword,
      ipAddress: this.getIpAddress(request),
      userAgent: this.getHeader(request, 'user-agent'),
      correlationId: this.getCorrelationId(request),
    });

    if (!result.success && result.errorCode === 'INVALID_OR_EXPIRED_TOKEN') {
      throw new BadRequestException('Invalid or expired reset token');
    }
    if (!result.success) {
      throw new BadGatewayException(result.error ?? 'Auth-service password reset failed');
    }

    return {
      success: true,
      message: 'Password has been reset successfully.',
    };
  }

  private async sendAuthCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
          timeout(this.timeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new BadGatewayException(`Auth service error: ${message}`);
    }
  }

  private getIpAddress(request: MinimalRequest): string | undefined {
    const forwarded = this.getHeader(request, 'x-forwarded-for');
    return forwarded?.split(',')[0]?.trim() || request.ip;
  }

  private getCorrelationId(request: MinimalRequest): string | undefined {
    return this.getHeader(request, 'x-correlation-id') ?? this.getHeader(request, 'x-request-id');
  }

  private getHeader(request: MinimalRequest, name: string): string | undefined {
    const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
}
