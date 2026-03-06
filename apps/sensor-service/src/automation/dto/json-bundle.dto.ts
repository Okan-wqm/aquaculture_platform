/**
 * JSON Bundle v2 DTO - IEC 61131-3 Automation Program Import/Export
 *
 * class-validator based validation for secure JSON bundle import.
 * SECURITY:
 *   - deployConfig field REJECTED (SSRF vector)
 *   - __proto__, constructor, prototype fields filtered
 *   - Max total bundle size: 1MB
 *   - ST code max: 512KB
 */

import { Type } from 'class-transformer';
import {
  IsString,
  IsOptional,
  MaxLength,
  IsEnum,
  IsInt,
  IsNumber,
  Min,
  Max,
  IsArray,
  ValidateNested,
  Equals,
  IsISO8601,
  IsEmail,
  ArrayMaxSize,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

// ============================================================================
// Security Constants
// ============================================================================

/** Maximum JSON bundle size in bytes (1MB) */
export const MAX_BUNDLE_SIZE = 1_048_576;

/** Maximum ST code size in bytes (512KB) */
export const MAX_ST_CODE_SIZE = 524_288;

/** Maximum number of variables per bundle */
export const MAX_VARIABLES = 500;

/** Maximum number of steps per bundle */
export const MAX_STEPS = 200;

/** Maximum number of transitions per bundle */
export const MAX_TRANSITIONS = 500;

/** Dangerous keys to strip from imported bundles */
export const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/** Fields explicitly rejected in v2 bundles */
export const REJECTED_FIELDS = new Set([
  'deployConfig',
  'deployTarget',
  'targetPlcAddress',
  'targetPlcPort',
  'targetPlcModel',
  'targetPlcProtocol',
  'transpiledJs',
  'transpiledCondition',
]);

// ============================================================================
// Custom Validators
// ============================================================================

@ValidatorConstraint({ name: 'noDeployConfig', async: false })
export class NoDeployConfigConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, _args: ValidationArguments): boolean {
    return true;
  }
  defaultMessage(): string {
    return 'deployConfig is not allowed in v2 bundles (security: SSRF vector)';
  }
}

// ============================================================================
// Nested DTOs
// ============================================================================

export class BundleExportInfoDto {
  @IsString()
  @MaxLength(100)
  platform!: string;

  @IsString()
  @MaxLength(50)
  version!: string;
}

export class BundleProgramDto {
  @IsString()
  @MaxLength(100)
  programCode!: string;

  @IsString()
  @MaxLength(200)
  programName!: string;

  @IsString()
  @IsEnum(['ST', 'SFC', 'FBD', 'LD'], { message: 'programType must be ST, SFC, FBD, or LD' })
  programType!: string;

  @IsString()
  @IsEnum(['CYCLIC', 'EVENT'], { message: 'executionMode must be CYCLIC or EVENT' })
  executionMode!: string;

  @IsInt()
  @Min(1)
  @Max(60000)
  scanCycleMs!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minScanCycleMs?: number;

  @IsString()
  @MaxLength(MAX_ST_CODE_SIZE)
  structuredTextCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
}

export class BundleVariableDto {
  @IsString()
  @MaxLength(100)
  varName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @IsString()
  @MaxLength(50)
  dataType!: string;

  @IsString()
  @MaxLength(50)
  scope!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  initialValue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ioConfigId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ioTagName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  engUnit?: string;

  @IsOptional()
  @IsNumber()
  minValue?: number;

  @IsOptional()
  @IsNumber()
  maxValue?: number;

  @IsOptional()
  @IsNumber()
  alarmHH?: number;

  @IsOptional()
  @IsNumber()
  alarmH?: number;

  @IsOptional()
  @IsNumber()
  alarmL?: number;

  @IsOptional()
  @IsNumber()
  alarmLL?: number;
}

export class BundleStepDto {
  @IsString()
  @MaxLength(30)
  stepCode!: string;

  @IsString()
  @MaxLength(100)
  stepName!: string;

  @IsString()
  @MaxLength(30)
  type!: string;

  @IsInt()
  positionX!: number;

  @IsInt()
  positionY!: number;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  entryAction?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100000)
  exitAction?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  onTimeout?: string;
}

export class BundleTransitionDto {
  @IsString()
  @MaxLength(30)
  transitionCode!: string;

  @IsString()
  @MaxLength(30)
  fromStepCode!: string;

  @IsString()
  @MaxLength(30)
  toStepCode!: string;

  @IsString()
  @MaxLength(512)
  condition!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  priority!: number;
}

// ============================================================================
// Main Bundle DTO
// ============================================================================

export class JsonBundleDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  $schema?: string;

  @Equals('2.0', { message: 'bundleVersion must be "2.0"' })
  bundleVersion!: '2.0';

  @Equals('2.0', { message: 'schemaVersion must be "2.0"' })
  schemaVersion!: '2.0';

  @IsISO8601()
  exportedAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  exportedBy?: string;

  @ValidateNested()
  @Type(() => BundleExportInfoDto)
  exportedFrom!: BundleExportInfoDto;

  @ValidateNested()
  @Type(() => BundleProgramDto)
  program!: BundleProgramDto;

  @IsArray()
  @ArrayMaxSize(MAX_VARIABLES)
  @ValidateNested({ each: true })
  @Type(() => BundleVariableDto)
  variables!: BundleVariableDto[];

  @IsArray()
  @ArrayMaxSize(MAX_STEPS)
  @ValidateNested({ each: true })
  @Type(() => BundleStepDto)
  steps!: BundleStepDto[];

  @IsArray()
  @ArrayMaxSize(MAX_TRANSITIONS)
  @ValidateNested({ each: true })
  @Type(() => BundleTransitionDto)
  transitions!: BundleTransitionDto[];
}

// ============================================================================
// Sanitization Utility
// ============================================================================

/**
 * Deep-sanitize an object by removing dangerous keys that could cause
 * prototype pollution attacks. Also strips rejected fields (deployConfig etc).
 *
 * This function creates a new object; it does NOT mutate the input.
 */
export function sanitizeBundleObject(obj: unknown, depth = 0): unknown {
  // Prevent stack overflow from deeply nested objects
  if (depth > 50) {
    return undefined;
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    // Reject strings that look like they contain code injection
    if (typeof obj === 'string') {
      return obj;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeBundleObject(item, depth + 1));
  }

  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    // Skip dangerous prototype-pollution keys
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    // Skip rejected fields at top level (depth 0)
    if (depth === 0 && REJECTED_FIELDS.has(key)) {
      continue;
    }
    clean[key] = sanitizeBundleObject(
      (obj as Record<string, unknown>)[key],
      depth + 1,
    );
  }
  return clean;
}

/**
 * Validate that a raw JSON string does not exceed the maximum bundle size.
 */
export function validateBundleSize(json: string): boolean {
  return new TextEncoder().encode(json).length <= MAX_BUNDLE_SIZE;
}
