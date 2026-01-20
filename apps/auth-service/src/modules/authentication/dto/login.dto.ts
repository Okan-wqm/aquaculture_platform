import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, IsString, MaxLength } from 'class-validator';

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
  email: string;

  @Field()
  @IsString()
  password: string;
}
