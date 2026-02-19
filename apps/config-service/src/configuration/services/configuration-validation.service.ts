import { Injectable, BadRequestException } from '@nestjs/common';
import { ConfigValueType } from '../entities/configuration.entity';

interface ValidationRules {
  min?: number;
  max?: number;
  pattern?: string;
  allowedValues?: string[];
  required?: boolean;
}

@Injectable()
export class ConfigurationValidationService {
  /**
   * Validate a configuration value against its declared type
   */
  validateValue(value: string, valueType: ConfigValueType, rules?: ValidationRules): void {
    // Type-based validation
    switch (valueType) {
      case ConfigValueType.NUMBER: {
        const trimmed = value.trim();
        if (trimmed === '') {
          throw new BadRequestException('Value must be a valid number (empty string not allowed)');
        }
        const num = Number(trimmed);
        if (!Number.isFinite(num)) {
          throw new BadRequestException('Value must be a valid finite number');
        }
        // Apply numeric rules
        if (rules) {
          if (rules.min !== undefined && num < rules.min) {
            throw new BadRequestException(`Value must be >= ${rules.min}`);
          }
          if (rules.max !== undefined && num > rules.max) {
            throw new BadRequestException(`Value must be <= ${rules.max}`);
          }
        }
        break;
      }

      case ConfigValueType.BOOLEAN:
        if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
          throw new BadRequestException('Value must be true/false or 1/0');
        }
        break;

      case ConfigValueType.JSON:
        try {
          JSON.parse(value);
        } catch {
          throw new BadRequestException('Value must be valid JSON');
        }
        break;

      case ConfigValueType.SECRET:
        // Secrets are opaque strings - no type validation beyond non-empty
        if (!value || value.trim() === '') {
          throw new BadRequestException('Secret value cannot be empty');
        }
        break;

      case ConfigValueType.STRING:
      default:
        // String validation - apply pattern/allowedValues rules if present
        break;
    }

    // Apply general validation rules
    if (rules) {
      if (rules.pattern) {
        const regex = new RegExp(rules.pattern);
        if (!regex.test(value)) {
          throw new BadRequestException(`Value does not match pattern: ${rules.pattern}`);
        }
      }
      if (rules.allowedValues && rules.allowedValues.length > 0) {
        if (!rules.allowedValues.includes(value)) {
          throw new BadRequestException(
            `Value must be one of: ${rules.allowedValues.join(', ')}`,
          );
        }
      }
    }
  }
}
