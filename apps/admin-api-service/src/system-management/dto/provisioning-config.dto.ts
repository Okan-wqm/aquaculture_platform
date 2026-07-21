import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body for `PUT /system/settings/provisioning-config` and the shape returned by
 * the matching GET (APA-045).
 *
 * Replaces the untyped `@Body() Record<string, string>` that erased to metatype
 * Object and bypassed the global ValidationPipe. camelCase mirrors the GET
 * response exactly, so read and write share one contract and the admin panel no
 * longer round-trips through dotted snake_case keys + an unsafe cast. Fields are
 * optional (partial update); `mqttBrokerPort` is a real integer, not a string.
 */
export class ProvisioningConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  provisioningApiUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  mqttBrokerHost?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  mqttBrokerPort?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  githubReleaseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  agentDefaultVersion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  githubRepo?: string;
}
