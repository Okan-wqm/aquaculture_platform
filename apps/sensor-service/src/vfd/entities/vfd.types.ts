/**
 * VFD Types - Separate from entity to avoid circular dependencies
 * NOTE: Uses string types instead of importing enums to prevent circular dependencies
 */

/**
 * Bit definitions for control/status words
 */
export interface BitDefinition {
  bit: number;
  name: string;
  description?: string;
}

/**
 * Input type for creating register mappings (used in brand configs)
 * Uses string types to match enum values without importing the enums
 */
export interface VfdRegisterMappingInput {
  brand: string; // VfdBrand enum value
  modelSeries?: string;
  parameterName: string;
  displayName: string;
  description?: string;
  category: string; // VfdParameterCategory enum value
  registerAddress: number;
  registerCount?: number;
  functionCode?: number;
  dataType?: string; // VfdDataType enum value
  scalingFactor?: number;
  offset?: number;
  unit?: string;
  byteOrder?: string; // ByteOrder enum value
  wordOrder?: string; // ByteOrder enum value
  isBitField?: boolean;
  bitDefinitions?: BitDefinition[];
  isReadable?: boolean;
  isWritable?: boolean;
  recommendedPollIntervalMs?: number;
  displayOrder?: number;
  isCritical?: boolean;
  minValue?: number;
  maxValue?: number;
}

/**
 * Extended input type for configuration registers (used in VFD remote programming)
 * Adds group, risk, and motor-stop metadata on top of standard register mappings
 */
export interface VfdConfigRegisterInput extends VfdRegisterMappingInput {
  group: string;
  defaultValue?: number;
  step?: number;
  riskLevel: string;
  requiresMotorStop: boolean;
  metadata?: Record<string, unknown>;
}
