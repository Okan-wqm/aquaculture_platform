import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsOptional } from 'class-validator';

@InputType()
export class RefreshTokenInput {
  @Field({ nullable: true, description: 'Optional: refresh token is now read from httpOnly cookie. This field is kept for backward compatibility.' })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}
