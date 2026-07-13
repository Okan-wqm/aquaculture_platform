import { InputType, Field, ObjectType } from '@nestjs/graphql';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

// ============================================================================
// Input DTOs
// ============================================================================

@InputType()
export class VerifyMfaSetupInput {
  @Field()
  @IsString()
  @Length(6, 6, { message: 'TOTP code must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'TOTP code must be exactly 6 digits' })
  code!: string;

  /**
   * ADR-045: pre-session enrollment credential from login
   * (mfaSetupRequired=true). Identifies the user when no authenticated
   * session exists; ignored when the caller is authenticated.
   */
  @Field(() => String, {
    nullable: true,
    description:
      'MFA setup token from login (mfaSetupRequired=true) — identifies the user when no authenticated session exists',
  })
  @IsOptional()
  @IsString()
  mfaSetupToken?: string;
}

@InputType()
export class DisableMfaInput {
  @Field()
  @IsString()
  password!: string;

  @Field()
  @IsString()
  @Length(6, 6, { message: 'TOTP code must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'TOTP code must be exactly 6 digits' })
  code!: string;
}

@InputType()
export class VerifyMfaLoginInput {
  @Field({ description: 'Short-lived MFA token received from login' })
  @IsString()
  mfaToken!: string;

  @Field({ description: 'TOTP code or recovery code' })
  @IsString()
  @Length(6, 12, { message: 'Code must be between 6 and 12 characters' })
  code!: string;
}

/**
 * IP-2: MFA step-up input — user is already authenticated, just needs
 * to re-verify identity with a TOTP code for elevated operations.
 */
@InputType()
export class MfaStepUpInput {
  @Field({ description: 'TOTP code or recovery code' })
  @IsString()
  @Length(6, 12, { message: 'Code must be between 6 and 12 characters' })
  code!: string;
}

// ============================================================================
// Response DTOs
// ============================================================================

@ObjectType()
export class SetupMfaResponse {
  @Field({ description: 'Base32-encoded TOTP secret for manual entry' })
  secret!: string;

  @Field({ description: 'otpauth:// URI for QR code generation' })
  qrCodeUri!: string;

  @Field(() => [String], { description: 'One-time recovery codes (store securely)' })
  recoveryCodes!: string[];
}

@ObjectType()
export class VerifyMfaSetupResponse {
  @Field()
  success!: boolean;

  @Field(() => String, { nullable: true })
  message?: string;
}

@ObjectType()
export class DisableMfaResponse {
  @Field()
  success!: boolean;

  @Field(() => String, { nullable: true })
  message?: string;
}

@ObjectType()
export class MfaLoginResponse {
  @Field()
  mfaRequired!: boolean;

  @Field(() => String, { nullable: true, description: 'Short-lived JWT for MFA verification (5 min)' })
  mfaToken?: string;
}

@ObjectType()
export class RegenerateMfaRecoveryCodesResponse {
  @Field(() => [String], { description: 'New one-time recovery codes (previous codes are invalidated)' })
  recoveryCodes!: string[];
}
