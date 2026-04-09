/**
 * @module ToolSchemaValidatorService
 * @description Validates AI tool call parameters against registered JSON Schema
 * and logs all tool invocations to the compliance audit trail.
 *
 * SECURITY: Prevents malformed tool call responses from the LLM from causing
 * runtime errors or injecting unexpected data into downstream operations.
 *
 * @see MSG-HIGH-033 (JSON schema validation on AI tool calls)
 * @see MSG-HIGH-034 (tool invocations not logged to audit trail)
 */
import { Injectable, Logger } from '@nestjs/common';

/** Result of validating tool call parameters. */
export interface ToolValidationResult {
  /** Whether the parameters pass schema validation. */
  valid: boolean;
  /** List of validation error messages. */
  errors: string[];
}

/** Minimal JSON Schema property type for tool input validation. */
interface JsonSchemaProperty {
  type?: string | string[];
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

/**
 * Audit entry for a tool invocation.
 * @see MSG-HIGH-034 (tool audit trail)
 */
export interface ToolAuditEntry {
  toolName: string;
  tenantId: string;
  userId: string;
  params: Record<string, unknown>;
  validationResult: ToolValidationResult;
  timestamp: Date;
}

@Injectable()
export class ToolSchemaValidatorService {
  private readonly logger = new Logger(ToolSchemaValidatorService.name);

  /**
   * Validate tool call parameters against the tool's input schema.
   *
   * @param toolName - Name of the tool
   * @param params - Parameters from the LLM tool call
   * @param schema - The tool's registered input JSON Schema
   * @returns ToolValidationResult
   */
  validate(
    toolName: string,
    params: unknown,
    schema: Record<string, unknown>,
  ): ToolValidationResult {
    const errors: string[] = [];

    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      return {
        valid: false,
        errors: [`Tool "${toolName}": parameters must be a JSON object, got ${typeof params}`],
      };
    }

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

    // ── Validate each property ──
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
   * Log a tool invocation for audit trail.
   * @see MSG-HIGH-034 (tool audit trail)
   *
   * @param entry - Tool audit entry to log
   */
  logToolInvocation(entry: ToolAuditEntry): void {
    // SECURITY: Log tool calls with sanitized params (no PII).
    // Full params are available in structured logging for forensic review.
    this.logger.log(
      JSON.stringify({
        event: 'tool_invocation',
        toolName: entry.toolName,
        tenantId: entry.tenantId,
        userId: entry.userId,
        valid: entry.validationResult.valid,
        errorCount: entry.validationResult.errors.length,
        timestamp: entry.timestamp.toISOString(),
      }),
    );
  }

  /**
   * Validate a single property value against its schema definition.
   */
  private validateProperty(
    path: string,
    value: unknown,
    schema: JsonSchemaProperty,
  ): string[] {
    const errors: string[] = [];

    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = this.getJsonType(value);
      if (!types.includes(actualType)) {
        errors.push(`"${path}": expected type ${types.join('|')}, got ${actualType}`);
        return errors;
      }
    }

    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`"${path}": value must be one of [${schema.enum.map(String).join(', ')}]`);
    }

    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`"${path}": value ${value} is below minimum ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`"${path}": value ${value} exceeds maximum ${schema.maximum}`);
      }
    }

    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`"${path}": string length ${value.length} is below minimum ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`"${path}": string length ${value.length} exceeds maximum ${schema.maxLength}`);
      }
    }

    if (Array.isArray(value) && schema.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...this.validateProperty(`${path}[${i}]`, value[i], schema.items));
      }
    }

    return errors;
  }

  /**
   * Map JavaScript typeof to JSON Schema type names.
   */
  private getJsonType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    }
    return typeof value;
  }
}
