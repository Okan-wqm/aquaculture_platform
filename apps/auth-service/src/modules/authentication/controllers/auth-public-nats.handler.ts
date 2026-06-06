import { BadRequestException, Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_PUBLIC_COMMAND_SUBJECTS,
  type PublicRequestPasswordResetCommand,
  type PublicRequestPasswordResetResult,
  type PublicResetPasswordCommand,
  type PublicResetPasswordResult,
} from '@platform/event-contracts';

import { AuthenticationService } from '../services/authentication.service';

@Controller()
export class AuthPublicNatsHandler {
  private readonly logger = new Logger(AuthPublicNatsHandler.name);

  constructor(private readonly authService: AuthenticationService) {}

  @MessagePattern(AUTH_PUBLIC_COMMAND_SUBJECTS.REQUEST_PASSWORD_RESET)
  async requestPasswordReset(
    @Payload() command: PublicRequestPasswordResetCommand,
  ): Promise<PublicRequestPasswordResetResult> {
    try {
      await this.authService.initiatePasswordReset(command.email, command.ipAddress);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`requestPasswordReset failed: reason=${message}`);
      return { success: false, errorCode: 'INTERNAL_ERROR', error: message };
    }
  }

  @MessagePattern(AUTH_PUBLIC_COMMAND_SUBJECTS.RESET_PASSWORD)
  async resetPassword(
    @Payload() command: PublicResetPasswordCommand,
  ): Promise<PublicResetPasswordResult> {
    try {
      await this.authService.resetPassword(
        command.token,
        command.newPassword,
        command.ipAddress,
        command.userAgent,
      );
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof BadRequestException
        ? 'INVALID_OR_EXPIRED_TOKEN'
        : 'INTERNAL_ERROR';
      this.logger.warn(`resetPassword failed: code=${errorCode}, reason=${message}`);
      return { success: false, errorCode, error: message };
    }
  }
}
