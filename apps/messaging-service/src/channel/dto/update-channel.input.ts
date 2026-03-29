import { InputType, Field } from '@nestjs/graphql';
import {
  IsOptional,
  IsString,
  MaxLength,
  IsUrl,
} from 'class-validator';

/**
 * Input for updating channel metadata (name, description, avatar).
 * Only applicable to GROUP and AI channels.
 */
@InputType()
export class UpdateChannelInput {
  @Field(() => String, { nullable: true, description: 'Updated channel name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @Field(() => String, { nullable: true, description: 'Updated channel description' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @Field(() => String, { nullable: true, description: 'Updated channel avatar URL' })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }, { message: 'avatarUrl must be a valid http or https URL' })
  avatarUrl?: string;
}
