import { IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Validated body for POST /marine/point-query. Replacing the former plain interface
 * lets the global ValidationPipe (whitelist + forbidNonWhitelisted + transform) reject
 * unexpected fields and out-of-range coordinates before the handler runs.
 */
export class MarinePointQueryDto {
  @IsString()
  layerId!: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5000)
  depth?: number;

  @IsOptional()
  @IsNumber()
  zoom?: number;
}

/** Validated body for POST /marine/aoi-analysis. */
export class MarineAoiAnalysisDto {
  @IsString()
  layerId!: string;

  @IsOptional()
  bbox?: number[] | string;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;
}
