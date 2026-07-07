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
  TankContainerKind,
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
  @MaxLength(500)
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
  @Min(0)
  @Max(100)
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
  hasAeration!: boolean;

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
  name!: string;

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
  departmentId!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  systemId?: string;

  @Field(() => TankContainerKind, { nullable: true, defaultValue: TankContainerKind.TANK })
  @IsOptional()
  @IsEnum(TankContainerKind)
  containerKind?: TankContainerKind;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  equipmentTypeId?: string;

  /** Linked temperature sensor (sensor-service sensors.id) driving the feed rate. */
  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  temperatureSensorId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  equipmentTypeCode?: string;

  // -------------------------------------------------------------------------
  // TİP VE MALZEME
  // -------------------------------------------------------------------------

  // WHY: a GraphQL `defaultValue` on an enum input field breaks @nestjs/graphql's
  // enum key→value coercion (the raw uppercase KEY reaches @IsEnum, which validates
  // the lowercase VALUE) → every client-supplied tankType is rejected with a masked
  // "Bad Request". WHAT: drop the defaultValue, make the field optional, and apply
  // the default in CreateTankHandler instead (see tankType/material/waterType defaults).
  @Field(() => TankType, { nullable: true })
  @IsOptional()
  @IsEnum(TankType)
  tankType?: TankType;

  @Field(() => TankMaterial, { nullable: true })
  @IsOptional()
  @IsEnum(TankMaterial)
  material?: TankMaterial;

  @Field(() => WaterType, { nullable: true })
  @IsOptional()
  @IsEnum(WaterType)
  waterType?: WaterType;

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
  depth!: number;

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
  maxBiomass!: number;

  @Field(() => Float, {
    nullable: true,
    description: 'Manual volume for non-geometric pond/cage containers',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  volume?: number;

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

  // WHY: same enum `defaultValue` coercion bug as tankType/material/waterType — a
  // client-supplied status would reach @IsEnum as the uppercase KEY and be rejected.
  // WHAT: drop defaultValue; CreateTankHandler applies TankStatus.PREPARING when omitted.
  @Field(() => TankStatus, { nullable: true })
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
  @MaxLength(2000)
  notes?: string;
}
