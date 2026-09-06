import { parseNatsRequestTimeout } from '@aquaculture/backend-common/nats';
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
  SetMetadata,
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

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

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

/** Loose non-empty IP shape for the proxy-header fast path in getIpAddress. */
const NONEMPTY_IP = /^[0-9a-fA-F:.]+$/;

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
    this.timeoutMs = parseNatsRequestTimeout(
      process.env['AUTH_NATS_TIMEOUT_MS'],
      DEFAULT_AUTH_NATS_TIMEOUT_MS,
      'AUTH_NATS_TIMEOUT_MS',
    );
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
  ): Promise<{ success: boolean; message: string }> {
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
  ): Promise<{ success: boolean; message: string }> {
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
            this.logger.error(`NATS request failed: subject=${subject}, error=${err.message}`);
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
    // SEC-LOW-085 (2026-08-23 scan №32): the audit IP must resolve the same
    // way everywhere — proxy-set X-Real-IP (nginx) first, then Express
    // req.ip (TRUST_PROXY), and the spoofable client-prepended XFF value
    // only as a last resort (nginx appends the real client after it).
    const realIp = this.getHeader(request, 'x-real-ip');
    if (realIp && NONEMPTY_IP.test(realIp)) {
      return realIp;
    }
    if (request.ip) {
      return request.ip;
    }
    return this.getHeader(request, 'x-forwarded-for')?.split(',')[0]?.trim();
  }

  private getCorrelationId(request: MinimalRequest): string | undefined {
    return this.getHeader(request, 'x-correlation-id') ?? this.getHeader(request, 'x-request-id');
  }

  private getHeader(request: MinimalRequest, name: string): string | undefined {
    const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }
}
