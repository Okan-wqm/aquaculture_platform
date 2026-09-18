/**
 * Request bodies for `monitoring.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

// ============================================================================
// DTOs
// ============================================================================

export class AnalyzeQueryDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsString()
  schemaName?: string;
}
