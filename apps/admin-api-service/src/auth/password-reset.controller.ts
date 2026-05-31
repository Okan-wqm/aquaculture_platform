import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  SetMetadata,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlePasswordReset } from '@aquaculture/backend-common/security';
import {
  AUTH_PASSWORD_RESET_SUBJECTS,
  type AuthPasswordResetCompleteCommand,
  type AuthPasswordResetCompleteResult,
  type AuthPasswordResetRequestCommand,
  type AuthPasswordResetRequestResult,
} from '@platform/event-contracts';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

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

const IS_PUBLIC_KEY = 'isPublic';
const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

@ApiTags('Authentication')
@Controller('auth')
export class PasswordResetController {
  private readonly authNatsTimeoutMs: number;

  constructor(
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.authNatsTimeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AUTH_NATS_TIMEOUT_MS;
  }

  @Post('forgot-password')
  @Public()
  @ThrottlePasswordReset()
  @HttpCode(HttpStatus.OK)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const command: AuthPasswordResetRequestCommand = {
      email: dto.email,
      ipAddress: req.ip,
    };
    return this.sendAuthRequest<AuthPasswordResetRequestCommand, AuthPasswordResetRequestResult>(
      AUTH_PASSWORD_RESET_SUBJECTS.REQUEST,
      command,
    );
  }

  @Post('reset-password')
  @Public()
  @ThrottlePasswordReset()
  @HttpCode(HttpStatus.OK)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() req: Request,
  ): Promise<{ success: boolean; message: string }> {
    const userAgentHeader = req.headers['user-agent'];
    const command: AuthPasswordResetCompleteCommand = {
      token: dto.token,
      newPassword: dto.newPassword,
      ipAddress: req.ip,
      userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
    };
    const result = await this.sendAuthRequest<
      AuthPasswordResetCompleteCommand,
      AuthPasswordResetCompleteResult
    >(AUTH_PASSWORD_RESET_SUBJECTS.COMPLETE, command);

    if (!result.success) {
      if (result.errorCode === 'INVALID_OR_EXPIRED_TOKEN') {
        throw new BadRequestException('Invalid or expired reset token');
      }
      throw new ServiceUnavailableException('Password reset is temporarily unavailable');
    }
    return { success: true, message: result.message };
  }

  private async sendAuthRequest<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    return firstValueFrom(
      this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
        timeout(this.authNatsTimeoutMs),
        catchError((err: Error) =>
          throwError(() =>
            new ServiceUnavailableException(
              `auth-service request failed: ${err.message}`,
            ),
          ),
        ),
      ),
    );
  }
}
