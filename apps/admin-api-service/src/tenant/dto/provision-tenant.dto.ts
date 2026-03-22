import { IsOptional, IsBoolean, IsEmail, IsArray, IsString, ArrayMaxSize } from 'class-validator';

export class ProvisionTenantDto {
  @IsOptional()
  @IsBoolean()
  createAdmin?: boolean;

  @IsOptional()
  @IsEmail()
  adminEmail?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  modules?: string[];
}
