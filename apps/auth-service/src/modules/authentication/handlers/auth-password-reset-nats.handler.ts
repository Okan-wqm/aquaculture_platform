import { BadRequestException, Controller, Logger } from '@nestjs/common';
import { PASSWORD_POLICY_MESSAGE } from '@aquaculture/backend-common/security';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_PASSWORD_RESET_SUBJECTS,
  type AuthPasswordResetCompleteCommand,
  type AuthPasswordResetCompleteResult,
  type AuthPasswordResetRequestCommand,
  type AuthPasswordResetRequestResult,
} from '@platform/event-contracts';

import { AuthenticationService } from '../services/authentication.service';

@Controller()
export class AuthPasswordResetNatsHandler {
  private readonly logger = new Logger(AuthPasswordResetNatsHandler.name);

  constructor(private readonly authenticationService: AuthenticationService) {}

  @MessagePattern(AUTH_PASSWORD_RESET_SUBJECTS.REQUEST)
  async requestPasswordReset(
    @Payload() command: AuthPasswordResetRequestCommand,
  ): Promise<AuthPasswordResetRequestResult> {
    await this.authenticationService.initiatePasswordReset(command.email, command.ipAddress);
    return {
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent.',
    };
  }

  @MessagePattern(AUTH_PASSWORD_RESET_SUBJECTS.COMPLETE)
  async completePasswordReset(
    @Payload() command: AuthPasswordResetCompleteCommand,
  ): Promise<AuthPasswordResetCompleteResult> {
    try {
      await this.authenticationService.resetPassword(
        command.token,
        command.newPassword,
        command.ipAddress,
        command.userAgent,
      );
      return {
        success: true,
        message: 'Password has been reset successfully.',
      };
    } catch (err) {
      const errorCode =
        err instanceof BadRequestException
          ? err.message === PASSWORD_POLICY_MESSAGE
            ? 'PASSWORD_POLICY_VIOLATION'
            : 'INVALID_OR_EXPIRED_TOKEN'
          : 'INTERNAL_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`passwordResetComplete failed: code=${errorCode}, reason=${message}`);
      return {
        success: false,
        errorCode,
        error: message,
        message: 'Password reset failed.',
      };
    }
  }
}
