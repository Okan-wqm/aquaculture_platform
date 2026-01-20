/**
 * Validation Exception Filter
 *
 * Handles validation errors from class-validator and custom validation.
 * Provides structured, field-level error messages for API consumers.
 * Supports nested object validation and array validation errors.
 */

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  BadRequestException,
  Logger,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';

/**
 * Validation error structure
 */
export interface ValidationErrorItem {
  field: string;
  message: string;
  code: string;
  value?: unknown;
  constraints?: Record<string, string>;
  children?: ValidationErrorItem[];
}

/**
 * Validation error response
 */
export interface ValidationErrorResponse {
  success: false;
  error: {
    code: 'VALIDATION_ERROR';
    message: string;
    validationErrors: ValidationErrorItem[];
  };
  meta: {
    timestamp: string;
    path: string;
    method: string;
    statusCode: number;
    correlationId?: string;
  };
}

/**
 * Class-validator constraint names to user-friendly messages
 */
const CONSTRAINT_MESSAGES: Record<string, (field: string, args?: unknown[]) => string> = {
  isNotEmpty: (field) => `${field} should not be empty`,
  isEmail: (field) => `${field} must be a valid email address`,
  isString: (field) => `${field} must be a string`,
  isNumber: (field) => `${field} must be a number`,
  isInt: (field) => `${field} must be an integer`,
  isPositive: (field) => `${field} must be a positive number`,
  isNegative: (field) => `${field} must be a negative number`,
  min: (field, args) => `${field} must be at least ${args?.[0]}`,
  max: (field, args) => `${field} must be at most ${args?.[0]}`,
  minLength: (field, args) => `${field} must be at least ${args?.[0]} characters`,
  maxLength: (field, args) => `${field} must be at most ${args?.[0]} characters`,
  isArray: (field) => `${field} must be an array`,
  arrayMinSize: (field, args) => `${field} must contain at least ${args?.[0]} items`,
  arrayMaxSize: (field, args) => `${field} must contain at most ${args?.[0]} items`,
  isDate: (field) => `${field} must be a valid date`,
  isDateString: (field) => `${field} must be a valid ISO 8601 date string`,
  isBoolean: (field) => `${field} must be a boolean`,
  isEnum: (field) => `${field} has an invalid value`,
  isUUID: (field) => `${field} must be a valid UUID`,
  isUrl: (field) => `${field} must be a valid URL`,
  isPhoneNumber: (field) => `${field} must be a valid phone number`,
  matches: (field) => `${field} has an invalid format`,
  isIn: (field, args) => `${field} must be one of: ${Array.isArray(args?.[0]) ? args[0].join(', ') : args?.[0]}`,
  isNotIn: (field, args) => `${field} must not be one of: ${Array.isArray(args?.[0]) ? args[0].join(', ') : args?.[0]}`,
  equals: (field, args) => `${field} must equal ${args?.[0]}`,
  notEquals: (field, args) => `${field} must not equal ${args?.[0]}`,
  contains: (field, args) => `${field} must contain "${args?.[0]}"`,
  notContains: (field, args) => `${field} must not contain "${args?.[0]}"`,
  isAlpha: (field) => `${field} must contain only letters`,
  isAlphanumeric: (field) => `${field} must contain only letters and numbers`,
  isDefined: (field) => `${field} is required`,
  isObject: (field) => `${field} must be an object`,
  isOptional: () => '', // No message needed
  validateNested: (field) => `${field} contains invalid nested data`,
};

/**
 * Validation Exception Filter
 * Catches and formats validation errors
 */
@Catch(BadRequestException)
export class ValidationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ValidationExceptionFilter.name);

  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const contextType = host.getType<GqlContextType>();

    if (contextType === 'graphql') {
      this.handleGraphQLException(exception, host);
    } else {
      this.handleHttpException(exception, host);
    }
  }

  /**
   * Handle HTTP context exception
   */
  private handleHttpException(exception: BadRequestException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const exceptionResponse = exception.getResponse();

    // Check if this is a validation error
    if (!this.isValidationError(exceptionResponse)) {
      // Not a validation error, let it pass through
      response.status(HttpStatus.BAD_REQUEST).json(exceptionResponse);
      return;
    }

    const validationErrors = this.parseValidationErrors(exceptionResponse);
    const errorResponse = this.buildErrorResponse(validationErrors, request);

    this.logValidationError(validationErrors, request);

    response.status(HttpStatus.UNPROCESSABLE_ENTITY).json(errorResponse);
  }

  /**
   * Handle GraphQL context exception
   */
  private handleGraphQLException(exception: BadRequestException, host: ArgumentsHost): void {
    const gqlHost = GqlArgumentsHost.create(host);
    const ctx = gqlHost.getContext();
    const request = ctx.req as Request;

    const exceptionResponse = exception.getResponse();

    if (!this.isValidationError(exceptionResponse)) {
      throw exception;
    }

    const validationErrors = this.parseValidationErrors(exceptionResponse);
    this.logValidationError(validationErrors, request);

    // For GraphQL, throw with formatted message
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      validationErrors,
    });
  }

  /**
   * Check if exception response is a validation error
   */
  private isValidationError(response: unknown): boolean {
    if (typeof response !== 'object' || response === null) {
      return false;
    }

    const obj = response as Record<string, unknown>;

    // Check for class-validator format
    if (Array.isArray(obj['message'])) {
      return true;
    }

    // Check for custom validation format
    if (obj['validationErrors']) {
      return true;
    }

    return false;
  }

  /**
   * Parse validation errors from exception response
   */
  private parseValidationErrors(response: unknown): ValidationErrorItem[] {
    const obj = response as Record<string, unknown>;

    // Handle custom validation format
    if (Array.isArray(obj['validationErrors'])) {
      return obj['validationErrors'] as ValidationErrorItem[];
    }

    // Handle class-validator format
    if (Array.isArray(obj['message'])) {
      return this.parseClassValidatorErrors(obj['message']);
    }

    // Handle string message
    if (typeof obj['message'] === 'string') {
      return [
        {
          field: 'unknown',
          message: obj['message'],
          code: 'VALIDATION_ERROR',
        },
      ];
    }

    return [];
  }

  /**
   * Parse class-validator errors
   */
  private parseClassValidatorErrors(errors: unknown[]): ValidationErrorItem[] {
    const result: ValidationErrorItem[] = [];

    for (const error of errors) {
      if (typeof error === 'string') {
        // Simple string error
        const parsed = this.parseStringError(error);
        result.push(parsed);
      } else if (typeof error === 'object' && error !== null) {
        // Object error from class-validator
        const parsed = this.parseObjectError(error as ClassValidatorError);
        result.push(parsed);
      }
    }

    return result;
  }

  /**
   * Parse string error message
   */
  private parseStringError(message: string): ValidationErrorItem {
    // Try to extract field name from message
    const match = message.match(/^(\w+)\s+(.+)$/);
    if (match && match[1] && match[2]) {
      return {
        field: this.camelToSnake(match[1]),
        message: match[2],
        code: this.inferErrorCode(match[2]),
      };
    }

    return {
      field: 'unknown',
      message,
      code: 'VALIDATION_ERROR',
    };
  }

  /**
   * Parse object error from class-validator
   */
  private parseObjectError(error: ClassValidatorError): ValidationErrorItem {
    const field = this.camelToSnake(error.property || 'unknown');
    const constraints = error.constraints || {};
    const constraintKeys = Object.keys(constraints);

    // Get first constraint message or generate one
    let message = '';
    let code = 'VALIDATION_ERROR';

    if (constraintKeys.length > 0) {
      const firstConstraint = constraintKeys[0] as string;
      message = constraints[firstConstraint] || this.generateMessage(field, firstConstraint);
      code = this.constraintToCode(firstConstraint);
    }

    const result: ValidationErrorItem = {
      field,
      message,
      code,
      constraints,
    };

    // Add value if present (but sanitize)
    if (error.value !== undefined) {
      result.value = this.sanitizeValue(error.value);
    }

    // Parse children for nested validation
    if (error.children && error.children.length > 0) {
      result.children = error.children.map((child) =>
        this.parseObjectError(child as ClassValidatorError),
      );
    }

    return result;
  }

  /**
   * Generate user-friendly message from constraint name
   */
  private generateMessage(field: string, constraint: string): string {
    const generator = CONSTRAINT_MESSAGES[constraint];
    if (generator) {
      return generator(field);
    }
    return `${field} is invalid`;
  }

  /**
   * Convert constraint name to error code
   */
  private constraintToCode(constraint: string): string {
    const codeMap: Record<string, string> = {
      isNotEmpty: 'REQUIRED',
      isDefined: 'REQUIRED',
      isEmail: 'INVALID_EMAIL',
      isString: 'INVALID_TYPE',
      isNumber: 'INVALID_TYPE',
      isInt: 'INVALID_TYPE',
      isBoolean: 'INVALID_TYPE',
      isArray: 'INVALID_TYPE',
      isObject: 'INVALID_TYPE',
      min: 'VALUE_TOO_SMALL',
      max: 'VALUE_TOO_LARGE',
      minLength: 'TOO_SHORT',
      maxLength: 'TOO_LONG',
      isUUID: 'INVALID_UUID',
      isUrl: 'INVALID_URL',
      isDate: 'INVALID_DATE',
      isEnum: 'INVALID_ENUM',
      matches: 'INVALID_FORMAT',
    };

    return codeMap[constraint] || 'VALIDATION_ERROR';
  }

  /**
   * Infer error code from message
   */
  private inferErrorCode(message: string): string {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.includes('required') || lowerMessage.includes('empty')) {
      return 'REQUIRED';
    }
    if (lowerMessage.includes('email')) {
      return 'INVALID_EMAIL';
    }
    if (lowerMessage.includes('type')) {
      return 'INVALID_TYPE';
    }
    if (lowerMessage.includes('format')) {
      return 'INVALID_FORMAT';
    }

    return 'VALIDATION_ERROR';
  }

  /**
   * Convert camelCase to snake_case
   */
  private camelToSnake(str: string): string {
    return str.replace(/([A-Z])/g, '_$1').toLowerCase();
  }

  /**
   * Sanitize value for logging/response
   */
  private sanitizeValue(value: unknown): unknown {
    if (typeof value === 'string' && value.length > 100) {
      return value.substring(0, 100) + '...';
    }
    if (typeof value === 'object' && value !== null) {
      return '[Object]';
    }
    return value;
  }

  /**
   * Build error response
   */
  private buildErrorResponse(
    validationErrors: ValidationErrorItem[],
    request: Request,
  ): ValidationErrorResponse {
    const errorCount = this.countErrors(validationErrors);
    const message =
      errorCount === 1
        ? 'Validation failed: 1 error'
        : `Validation failed: ${errorCount} errors`;

    return {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message,
        validationErrors,
      },
      meta: {
        timestamp: new Date().toISOString(),
        path: request.originalUrl || request.url,
        method: request.method,
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        correlationId: request.headers['x-correlation-id'] as string,
      },
    };
  }

  /**
   * Count total errors including nested
   */
  private countErrors(errors: ValidationErrorItem[]): number {
    let count = errors.length;
    for (const error of errors) {
      if (error.children) {
        count += this.countErrors(error.children);
      }
    }
    return count;
  }

  /**
   * Log validation error
   */
  private logValidationError(errors: ValidationErrorItem[], request: Request): void {
    this.logger.warn('Validation error', {
      path: request.path,
      method: request.method,
      errorCount: this.countErrors(errors),
      fields: errors.map((e) => e.field),
      ip: request.ip,
    });
  }
}

/**
 * Class-validator error structure
 */
interface ClassValidatorError {
  property?: string;
  value?: unknown;
  constraints?: Record<string, string>;
  children?: unknown[];
}

/**
 * Create a validation error
 */
export function createValidationError(
  field: string,
  message: string,
  code = 'VALIDATION_ERROR',
): ValidationErrorItem {
  return { field, message, code };
}

/**
 * Throw a validation exception with errors
 */
export function throwValidationError(errors: ValidationErrorItem[]): never {
  throw new BadRequestException({
    message: 'Validation failed',
    validationErrors: errors,
  });
}
