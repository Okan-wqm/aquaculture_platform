/**
 * Request bodies for `explorer.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import { Type, Transform } from 'class-transformer';
import { IsOptional, IsNumber, IsString, IsIn, IsObject, Matches } from 'class-validator';

// ============================================================================
// DTOs
// ============================================================================

export class TableQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'orderBy must be a valid SQL identifier' })
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';

  // H-S2-01: Dead `filter` field removed. It was declared in the DTO but never
  // used in the query builder, creating a latent SQL injection vector if a future
  // developer adds WHERE interpolation following the DTO field name convention.

  // Fix: C12 -- includeSensitive kaldırıldı, sensitive data her zaman maskelenir
}

export class ExportQueryDto {
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'orderBy must be a valid SQL identifier' })
  orderBy?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  orderDirection?: 'ASC' | 'DESC';
}

export class InsertRowDto {
  @IsObject()
  data!: Record<string, unknown>;
}

export class UpdateRowDto {
  @IsObject()
  data!: Record<string, unknown>;
}

/**
 * SECURITY: DTO for raw SQL query execution
 * Only for SUPER_ADMIN in development/staging environments
 */
export class ExecuteQueryDto {
  @IsString()
  @Transform(({ value }) => value?.trim())
  sql!: string;

  @IsOptional()
  params?: unknown[];
}
