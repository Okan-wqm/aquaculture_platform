/**
 * Create Tank DTO
 * @module Tank/DTO
 */
import { InputType, Field, Float, Int } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsUUID,
  IsBoolean,
  IsDateString,
  ValidateNested,
  Min,
  Max,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import GraphQLJSON from 'graphql-type-json';
import {
  TankType,
  TankMaterial,
  WaterType,
  TankStatus,
  TankLocation,
  WaterFlowProperties,
  AerationInfo,
} from '../entities/tank.entity';

// ============================================================================
// NESTED INPUT TYPES
// ============================================================================

@InputType()
export class TankLocationInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  building?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  section?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  row?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  column?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  floor?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}

@InputType()
export class WaterFlowInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  flowRate?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  flowRateUnit?: 'L/min' | 'm3/h';

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  exchangeRate?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  inletCount?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  outletCount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  inletDiameter?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  outletDiameter?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  drainType?: 'center' | 'side' | 'dual' | 'other';
}

@InputType()
export class AerationInput {
  @Field()
  @IsBoolean()
  hasAeration: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  aerationType?: 'diffuser' | 'paddle_wheel' | 'venturi' | 'blower' | 'other';

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsNumber()
  aeratorCount?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  airFlowRate?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  targetDO?: number;
}

// ============================================================================
// MAIN CREATE DTO
// ============================================================================

@InputType()
export class CreateTankInput {
  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @Field()
  @IsNotEmpty()
  @IsUUID()
  departmentId: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  // -------------------------------------------------------------------------
  // TİP VE MALZEME
  // -------------------------------------------------------------------------

  @Field(() => TankType, { defaultValue: TankType.CIRCULAR })
  @IsEnum(TankType)
  tankType: TankType;

  @Field(() => TankMaterial, { defaultValue: TankMaterial.FIBERGLASS })
  @IsEnum(TankMaterial)
  material: TankMaterial;

  @Field(() => WaterType, { defaultValue: WaterType.SALTWATER })
  @IsEnum(WaterType)
  waterType: WaterType;

  // -------------------------------------------------------------------------
  // BOYUTLAR
  // -------------------------------------------------------------------------

  /**
   * Çap - CIRCULAR, OVAL tanklar için zorunlu
   */
  @Field(() => Float, { nullable: true })
  @ValidateIf((o) => [TankType.CIRCULAR, TankType.OVAL].includes(o.tankType))
  @IsNotEmpty({ message: 'Diameter is required for circular/oval tanks' })
  @IsNumber()
  @Min(0.1)
  @Max(100)
  diameter?: number;

  /**
   * Uzunluk - RECTANGULAR, RACEWAY, D_END, SQUARE tanklar için zorunlu
   */
  @Field(() => Float, { nullable: true })
  @ValidateIf((o) =>
    [TankType.RECTANGULAR, TankType.RACEWAY, TankType.D_END, TankType.SQUARE].includes(o.tankType),
  )
  @IsNotEmpty({ message: 'Length is required for rectangular/raceway tanks' })
  @IsNumber()
  @Min(0.1)
  @Max(500)
  length?: number;

  /**
   * Genişlik - RECTANGULAR, RACEWAY, D_END, SQUARE tanklar için zorunlu
   */
  @Field(() => Float, { nullable: true })
  @ValidateIf((o) =>
    [TankType.RECTANGULAR, TankType.RACEWAY, TankType.D_END, TankType.SQUARE].includes(o.tankType),
  )
  @IsNotEmpty({ message: 'Width is required for rectangular/raceway tanks' })
  @IsNumber()
  @Min(0.1)
  @Max(100)
  width?: number;

  /**
   * Derinlik - Tüm tanklar için zorunlu (m)
   */
  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0.1)
  @Max(20)
  depth: number;

  /**
   * Su derinliği (m)
   */
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  waterDepth?: number;

  /**
   * Freeboard (m)
   */
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  freeboard?: number;

  // -------------------------------------------------------------------------
  // KAPASİTE
  // -------------------------------------------------------------------------

  @Field(() => Float)
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  maxBiomass: number;

  @Field(() => Float, { defaultValue: 30 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  maxDensity?: number;

  // -------------------------------------------------------------------------
  // SU AKIŞ VE HAVALANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => WaterFlowInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => WaterFlowInput)
  waterFlow?: WaterFlowInput;

  @Field(() => AerationInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => AerationInput)
  aeration?: AerationInput;

  // -------------------------------------------------------------------------
  // KONUM
  // -------------------------------------------------------------------------

  @Field(() => TankLocationInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => TankLocationInput)
  location?: TankLocationInput;

  // -------------------------------------------------------------------------
  // DURUM VE EK BİLGİLER
  // -------------------------------------------------------------------------

  @Field(() => TankStatus, { defaultValue: TankStatus.PREPARING })
  @IsOptional()
  @IsEnum(TankStatus)
  status?: TankStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  installationDate?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
