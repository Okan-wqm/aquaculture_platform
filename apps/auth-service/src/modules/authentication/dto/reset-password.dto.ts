import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsEmail,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';

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
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,128}$/, {
    message:
      'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
  })
  newPassword!: string;
}
