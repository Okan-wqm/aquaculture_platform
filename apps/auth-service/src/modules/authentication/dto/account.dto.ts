import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_POLICY_MESSAGE, PASSWORD_POLICY_REGEX } from './password-policy';

/** UI locales the web clients ship; the SSoT the profile mutation validates against. */
export const SUPPORTED_UI_LOCALES = ['tr', 'en'] as const;
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

@InputType()
export class UpdateMyProfileInput {
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  /**
   * The UI language the user chose (FE-HIGH-089). Persisted on the account so
   * it follows the user across devices; the shell applies it on sign-in and
   * the settings page writes it here. Only the locales the web clients ship.
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsIn(SUPPORTED_UI_LOCALES)
  preferredLanguage?: SupportedUiLocale;
}

@InputType()
export class UpdateProfileInput extends UpdateMyProfileInput {
  @Field(() => String, { nullable: true, deprecationReason: 'Email changes require a verified-email workflow.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}

@InputType()
export class ChangeMyPasswordInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @Field()
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_POLICY_REGEX, { message: PASSWORD_POLICY_MESSAGE })
  newPassword!: string;
}

@InputType()
export class ChangePasswordInput extends ChangeMyPasswordInput {}

@ObjectType()
export class ChangeMyPasswordResponse {
  @Field()
  success!: boolean;

  @Field()
  message!: string;
}

@ObjectType()
export class MySecuritySettings {
  @Field()
  mfaEnabled!: boolean;

  @Field()
  mfaAvailable!: boolean;

  @Field(() => String, { nullable: true })
  mfaUnavailableReason?: string | null;
}
