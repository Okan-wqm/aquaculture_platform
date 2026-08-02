import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const MARINE_RENDER_LAYER_ID_MAX_LENGTH = 100;
export const MARINE_RENDER_SCENE_ID_MAX_LENGTH = 512;
export const MARINE_RENDER_MIN_DIMENSION = 64;
export const MARINE_RENDER_MAX_DIMENSION = 2_048;
export const MARINE_RENDER_DEFAULT_DIMENSION = 1_024;

export class MarineRenderDto {
  @IsString()
  @MaxLength(MARINE_RENDER_LAYER_ID_MAX_LENGTH)
  layerId!: string;

  @IsString()
  @MaxLength(MARINE_RENDER_SCENE_ID_MAX_LENGTH)
  sceneId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARINE_RENDER_MIN_DIMENSION)
  @Max(MARINE_RENDER_MAX_DIMENSION)
  width: number = MARINE_RENDER_DEFAULT_DIMENSION;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MARINE_RENDER_MIN_DIMENSION)
  @Max(MARINE_RENDER_MAX_DIMENSION)
  height: number = MARINE_RENDER_DEFAULT_DIMENSION;
}
