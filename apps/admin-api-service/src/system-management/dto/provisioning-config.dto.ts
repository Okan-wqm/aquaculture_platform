import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class UpdateProvisioningConfigDto {
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\//)
  @MaxLength(2048)
  'provisioning.api_url'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  'provisioning.mqtt_broker_host'?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(?:[1-9]|[1-9]\d{1,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/)
  'provisioning.mqtt_broker_port'?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\//)
  @MaxLength(2048)
  'provisioning.github_release_url'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  'provisioning.github_repo'?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  'provisioning.agent_default_version'?: string;
}
