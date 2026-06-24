import { InputType, Field } from '@nestjs/graphql';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Login Input DTO
 *
 * Email-only login (no tenant selection needed at login).
 * The system determines tenant from the user record.
 * SUPER_ADMIN users have no tenant.
 */
@InputType()
export class LoginInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255)
  email!: string;

  @Field()
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  @MaxLength(128, { message: 'Password too long' })
  password!: string;

  /**
   * "Remember me" / stay logged in. When true the server issues a PERSISTENT
   * refresh cookie (survives browser restart); when false/omitted it issues a
   * SESSION cookie. Defaults false so existing clients keep the safer behaviour.
   */
  @Field(() => Boolean, { defaultValue: false, nullable: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
