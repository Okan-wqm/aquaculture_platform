import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsNotEmpty } from 'class-validator';

@InputType()
export class RefreshTokenInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}
