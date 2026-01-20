import { Injectable } from '@nestjs/common';
import Ajv, { ValidateFunction, ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { ProtocolRegistryService } from './protocol-registry.service';
import { ValidationResult, ValidationError } from '../adapters/base-protocol.adapter';

export interface SchemaValidationResult {
  isValid: boolean;
  errors: SchemaValidationError[];
}

export interface SchemaValidationError {
  field: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

@Injectable()
export class ProtocolValidatorService {
  private ajv: Ajv;
  private validatorCache: Map<string, ValidateFunction> = new Map();

  constructor(private protocolRegistry: ProtocolRegistryService) {
    this.ajv = new Ajv({
      allErrors: true,
      coerceTypes: true,
      useDefaults: true,
      removeAdditional: 'all',
      strict: false,
    });
    addFormats(this.ajv);
  }

  /**
   * Validate configuration against protocol's JSON Schema
   */
  validateSchema(protocolCode: string, config: unknown): SchemaValidationResult {
    const validator = this.getOrCreateValidator(protocolCode);
    if (!validator) {
      return {
        isValid: false,
        errors: [
          {
            field: 'protocol',
            message: `Unknown protocol: ${protocolCode}`,
            keyword: 'unknown',
            params: { protocolCode },
          },
        ],
      };
    }

    const valid = validator(config);
    if (valid) {
      return { isValid: true, errors: [] };
    }

    return {
      isValid: false,
      errors: this.formatAjvErrors(validator.errors || []),
    };
  }

  /**
   * Validate configuration using adapter's custom validation
   */
  validateAdapter(protocolCode: string, config: unknown): ValidationResult {
    const adapter = this.protocolRegistry.getAdapter(protocolCode);
    if (!adapter) {
      return {
        isValid: false,
        errors: [
          {
            field: 'protocol',
            message: `Unknown protocol: ${protocolCode}`,
          },
        ],
      };
    }

    return adapter.validateConfiguration(config);
  }

  /**
   * Full validation: schema + adapter custom validation
   */
  validate(protocolCode: string, config: unknown): ValidationResult {
    // First, validate against JSON Schema
    const schemaResult = this.validateSchema(protocolCode, config);
    if (!schemaResult.isValid) {
      return {
        isValid: false,
        errors: schemaResult.errors.map((e) => ({
          field: e.field,
          message: e.message,
        })),
      };
    }

    // Then, run adapter-specific validation
    return this.validateAdapter(protocolCode, config);
  }

  /**
   * Validate required fields only
   */
  validateRequired(protocolCode: string, config: Record<string, unknown>): ValidationResult {
    const schema = this.protocolRegistry.getConfigurationSchema(protocolCode);
    if (!schema) {
      return {
        isValid: false,
        errors: [{ field: 'protocol', message: `Unknown protocol: ${protocolCode}` }],
      };
    }

    const required = (schema as any).required || [];
    const errors: ValidationError[] = [];

    for (const field of required) {
      if (config[field] === undefined || config[field] === null || config[field] === '') {
        errors.push({
          field,
          message: `${field} is required`,
        });
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get or create JSON Schema validator for protocol
   */
  private getOrCreateValidator(protocolCode: string): ValidateFunction | null {
    if (this.validatorCache.has(protocolCode)) {
      return this.validatorCache.get(protocolCode)!;
    }

    const schema = this.protocolRegistry.getConfigurationSchema(protocolCode);
    if (!schema) {
      return null;
    }

    try {
      const validator = this.ajv.compile(schema);
      this.validatorCache.set(protocolCode, validator);
      return validator;
    } catch (error) {
      console.error(`Failed to compile schema for ${protocolCode}:`, error);
      return null;
    }
  }

  /**
   * Format AJV errors to our format
   */
  private formatAjvErrors(errors: ErrorObject[]): SchemaValidationError[] {
    return errors.map((error) => {
      let field = error.instancePath.replace(/^\//, '').replace(/\//g, '.');
      if (!field && error.params?.missingProperty) {
        field = error.params.missingProperty as string;
      }

      let message = error.message || 'Validation error';
      if (error.keyword === 'required') {
        message = `${field || error.params?.missingProperty} is required`;
      } else if (error.keyword === 'type') {
        message = `${field} must be ${error.params?.type}`;
      } else if (error.keyword === 'minimum') {
        message = `${field} must be >= ${error.params?.limit}`;
      } else if (error.keyword === 'maximum') {
        message = `${field} must be <= ${error.params?.limit}`;
      } else if (error.keyword === 'enum') {
        message = `${field} must be one of: ${(error.params?.allowedValues as string[])?.join(', ')}`;
      } else if (error.keyword === 'pattern') {
        message = `${field} has invalid format`;
      } else if (error.keyword === 'format') {
        message = `${field} must be a valid ${error.params?.format}`;
      }

      return {
        field,
        message,
        keyword: error.keyword,
        params: error.params || {},
      };
    });
  }

  /**
   * Clear validator cache (useful after schema updates)
   */
  clearCache(): void {
    this.validatorCache.clear();
  }

  /**
   * Clear cache for specific protocol
   */
  clearCacheFor(protocolCode: string): void {
    this.validatorCache.delete(protocolCode);
  }

  /**
   * Apply default values to config
   */
  applyDefaults(protocolCode: string, config: Record<string, unknown>): Record<string, unknown> {
    const defaults = this.protocolRegistry.getDefaultConfiguration(protocolCode);
    if (!defaults) {
      return config;
    }

    return { ...defaults, ...config };
  }

  /**
   * Sanitize configuration by removing unknown fields
   */
  sanitize(protocolCode: string, config: Record<string, unknown>): Record<string, unknown> {
    const schema = this.protocolRegistry.getConfigurationSchema(protocolCode) as any;
    if (!schema?.properties) {
      return config;
    }

    const allowedFields = Object.keys(schema.properties);
    const sanitized: Record<string, unknown> = {};

    for (const field of allowedFields) {
      if (config[field] !== undefined) {
        sanitized[field] = config[field];
      }
    }

    return sanitized;
  }
}
