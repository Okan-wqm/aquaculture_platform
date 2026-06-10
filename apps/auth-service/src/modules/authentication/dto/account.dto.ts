import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import { PASSWORD_POLICY_MESSAGE, PASSWORD_POLICY_REGEX } from './password-policy';

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
