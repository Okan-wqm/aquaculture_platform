/**
 * Request bodies for `performance.controller.ts` (CONTRACT-CRITICAL-003).
 *
 * DTO classes live in a `*.dto.ts` file, never inside the controller: the
 * `@nestjs/swagger` plugin visits a file EITHER as a controller (typing the
 * responses) or as a model (typing the DTOs), never as both, so a DTO declared
 * beside its routes costs the whole file's response schemas.
 */
import {
  IsString,
  IsOptional,
  IsNumber,
  IsObject,
  IsArray,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { MetricType } from '../../entities/performance-metric.entity';
import { MetricThreshold } from '../../services/performance-monitoring.service';

// ============================================================================
// DTOs
// ============================================================================

export class RecordMetricDto {
  @IsString()
  metricType!: MetricType;

  @IsString()
  name!: string;

  @IsNumber()
  value!: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsObject()
  dimensions?: Record<string, string | undefined>;

  @IsOptional()
  @IsObject()
  percentiles?: { p50?: number; p90?: number; p95?: number; p99?: number };

  @IsOptional()
  @IsNumber()
  sampleCount?: number;
}

export class RecordRequestMetricDto {
  @IsString()
  @MaxLength(255)
  service!: string;

  @IsString()
  @MaxLength(255)
  endpoint!: string;

  @IsString()
  @MaxLength(10)
  method!: string;

  @IsNumber()
  durationMs!: number;

  @IsBoolean()
  isError!: boolean;
}

export class UpdateThresholdsDto {
  @IsArray()
  thresholds!: MetricThreshold[];
}
