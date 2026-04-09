/**
 * @module ToolSchemaValidatorService
 * @description Validates tool call parameters against the tool's registered
 * JSON Schema before execution.
 *
 * This prevents:
 * - Malformed parameters from crashing tool implementations
 * - Type confusion attacks (string where number expected)
 * - Extra properties that could be used for injection
 * - Missing required fields that would cause downstream errors
 *
 * Uses a lightweight JSON Schema Draft-7 subset validator (no $ref, no
 * remote schemas) to avoid adding a heavy dependency like Ajv.
 *
 * @see MSG-HIGH-033 (JSON schema validation finding)
 */
import { Injectable, Logger } from '@nestjs/common';

// ── Result Types ──

/** Result of validating tool call parameters. */
export interface ToolValidationResult {
  /** Whether the parameters pass schema validation. */
  valid: boolean;
  /** List of validation error messages. */
  errors: string[];
}

// ── JSON Schema subset types ──

/** Minimal JSON Schema type for tool input validation. */
interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

@Injectable()
export class ToolSchemaValidatorService {
  private readonly logger = new Logger(ToolSchemaValidatorService.name);

  /**
   * Validate tool call parameters against the tool's input schema.
   *
   * @param toolName - Name of the tool (for error messages)
   * @param params - The parameters from the LLM tool call
   * @param schema - The tool's registered input JSON Schema
   * @returns ToolValidationResult with validation verdict and errors
   */
  validate(
    toolName: string,
    params: unknown,
    schema: Record<string, unknown>,
  ): ToolValidationResult {
    const errors: string[] = [];

    // ── Guard: params must be an object ──
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return {
        valid: false,
        errors: [`Tool "${toolName}": parameters must be a JSON object, got ${typeof params}`],
      };
    }

    // WHY: Runtime type guard instead of `as` cast — schema comes from external
    // tool registrations and may not conform to ToolInputSchema.
    const schemaType = schema['type'];
    if (schemaType !== 'object') {
      return {
        valid: false,
        errors: [`Tool "${toolName}": input schema type must be "object", got "${String(schemaType)}"`],
      };
    }

    const schemaProperties = schema['properties'] as Record<string, JsonSchemaProperty> | undefined;
    const schemaRequired = schema['required'] as string[] | undefined;
    const schemaAdditionalProperties = schema['additionalProperties'] as boolean | undefined;
    const paramObj = params as Record<string, unknown>;

    // ── Validate required fields ──
    if (schemaRequired) {
      for (const field of schemaRequired) {
        if (!(field in paramObj) || paramObj[field] === undefined) {
          errors.push(`Tool "${toolName}": missing required field "${field}"`);
        }
      }
    }

    // ── Validate each property against its schema ──
    if (schemaProperties) {
      for (const [key, propSchema] of Object.entries(schemaProperties)) {
        if (key in paramObj && paramObj[key] !== undefined) {
          const propErrors = this.validateProperty(
            `${toolName}.${key}`,
            paramObj[key],
            propSchema,
          );
          errors.push(...propErrors);
        }
      }

      // ── Check for additional properties ──
      if (schemaAdditionalProperties === false) {
        const allowedKeys = new Set(Object.keys(schemaProperties));
        for (const key of Object.keys(paramObj)) {
          if (!allowedKeys.has(key)) {
            errors.push(
              `Tool "${toolName}": unexpected additional property "${key}"`,
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      this.logger.warn(
        `SECURITY: Tool schema validation failed for "${toolName}": ${JSON.stringify(errors)}`,
      );
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a single property value against its schema definition.
   *
   * @param path - Dot-separated path for error messages (e.g., "toolName.param")
   * @param value - The actual value to validate
   * @param schema - The property's JSON Schema
   * @returns Array of error messages (empty if valid)
   */
  private validateProperty(
    path: string,
    value: unknown,
    schema: JsonSchemaProperty,
  ): string[] {
    const errors: string[] = [];

    // ── Type check ──
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = this.getJsonType(value);

      if (!types.includes(actualType)) {
        errors.push(
          `"${path}": expected type ${types.join('|')}, got ${actualType}`,
        );
        // If type is wrong, skip further checks (they'd produce confusing errors)
        return errors;
      }
    }

    // ── Enum check ──
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(
        `"${path}": value must be one of [${schema.enum.map(String).join(', ')}]`,
      );
    }

    // ── Number constraints ──
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`"${path}": value ${value} is below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`"${path}": value ${value} exceeds maximum ${schema.maximum}`);
      }
    }

    // ── String constraints ──
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(
          `"${path}": string length ${value.length} is below minimum ${schema.minLength}`,
        );
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(
          `"${path}": string length ${value.length} exceeds maximum ${schema.maxLength}`,
        );
      }
      if (schema.pattern) {
        // SECURITY: Wrap in try-catch in case the schema contains an invalid regex
        try {
          const regex = new RegExp(schema.pattern);
          if (!regex.test(value)) {
            errors.push(`"${path}": value does not match pattern "${schema.pattern}"`);
          }
        } catch {
          this.logger.warn(`Invalid regex pattern in schema for "${path}": ${schema.pattern}`);
        }
      }
    }

    // ── Array constraints ──
    if (Array.isArray(value) && schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = this.validateProperty(
          `${path}[${i}]`,
          value[i],
          schema.items,
        );
        errors.push(...itemErrors);
      }
    }

    // ── Nested object constraints ──
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      schema.properties
    ) {
      const obj = value as Record<string, unknown>;

      if (schema.required) {
        for (const field of schema.required) {
          if (!(field in obj) || obj[field] === undefined) {
            errors.push(`"${path}": missing required field "${field}"`);
          }
        }
      }

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj && obj[key] !== undefined) {
          const propErrors = this.validateProperty(
            `${path}.${key}`,
            obj[key],
            propSchema,
          );
          errors.push(...propErrors);
        }
      }
    }

    return errors;
  }

  /**
   * Map JavaScript typeof to JSON Schema type names.
   *
   * @param value - Any value
   * @returns JSON Schema type string
   */
  private getJsonType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    }
    return typeof value; // string, boolean, object
  }
}
