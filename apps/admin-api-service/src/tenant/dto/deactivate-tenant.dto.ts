import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class DeactivateTenantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
