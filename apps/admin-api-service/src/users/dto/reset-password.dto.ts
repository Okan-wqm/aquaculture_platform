import { IsString, MinLength, MaxLength } from 'class-validator';

export class ResetPasswordByAdminDto {
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  newPassword!: string;
}
