import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsEmail,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

import { PASSWORD_POLICY_MESSAGE, PASSWORD_POLICY_REGEX } from './password-policy';

@InputType()
export class ForgotPasswordInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email address' })
  @MaxLength(255)
  email!: string;
}

@InputType()
export class ResetPasswordInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token!: string;

  @Field()
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(PASSWORD_POLICY_REGEX, { message: PASSWORD_POLICY_MESSAGE })
  newPassword!: string;
}
