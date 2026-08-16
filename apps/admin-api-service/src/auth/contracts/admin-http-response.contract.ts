import { adminResponse, type AdminResponseProjection } from '@platform/admin-http-contracts';

export const passwordResetForgotPasswordResponseContract = adminResponse.object({
  success: adminResponse.literal(true),
  message: adminResponse.string(),
});

export type PasswordResetForgotPasswordResponseDto = AdminResponseProjection<
  typeof passwordResetForgotPasswordResponseContract
>;

export const passwordResetResetPasswordResponseContract = adminResponse.object({
  success: adminResponse.literal(true),
  message: adminResponse.string(),
});

export type PasswordResetResetPasswordResponseDto = AdminResponseProjection<
  typeof passwordResetResetPasswordResponseContract
>;
