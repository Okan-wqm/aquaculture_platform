/**
 * Request Validator Middleware
 *
 * Validates incoming requests for security and data integrity.
 * Performs schema validation, sanitization, and threat detection.
 * Protects against common attack vectors like injection attacks.
 */

import { Injectable, NestMiddleware, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';

/**
 * Validation result interface
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  sanitizedData?: Record<string, unknown>;
}

/**
 * Validation error details
 */
export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: unknown;
}

/**
 * Request validation configuration
 */
export interface RequestValidatorConfig {
  maxBodySize: number;
  maxUrlLength: number;
  maxHeaderSize: number;
  maxQueryParams: number;
  maxArrayLength: number;
  maxObjectDepth: number;
  allowedContentTypes: string[];
  enableSqlInjectionCheck: boolean;
  enableXssCheck: boolean;
  enablePathTraversalCheck: boolean;
  enableCommandInjectionCheck: boolean;
}

/**
 * Extended request with validation data
 */
export interface ValidatedRequest extends Request {
  validationResult?: ValidationResult;
  sanitizedBody?: Record<string, unknown>;
  sanitizedQuery?: Record<string, unknown>;
}

/**
 * Request Validator Middleware
 * Comprehensive request validation and sanitization
 */
@Injectable()
export class RequestValidatorMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestValidatorMiddleware.name);
  private readonly config: RequestValidatorConfig;

  // SQL injection patterns
  private readonly sqlInjectionPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE)\b)/i,
    /(\b(OR|AND)\b\s+[\d\w]+\s*[=<>])/i,
    /(--|#|\/\*|\*\/)/,
    /(\bOR\b\s+['"]?\d+['"]?\s*[=]\s*['"]?\d+['"]?)/i,
    /(['"];\s*(DROP|DELETE|UPDATE|INSERT))/i,
    /(\bUNION\b\s+\bSELECT\b)/i,
    /(SLEEP\s*\(\d+\))/i,
    /(BENCHMARK\s*\()/i,
    /(\bWAITFOR\b\s+\bDELAY\b)/i,
  ];

  // XSS patterns
  private readonly xssPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /javascript:/gi,
    /on\w+\s*=/gi,
    /<\s*img[^>]+onerror\s*=/gi,
    /<\s*svg[^>]+onload\s*=/gi,
    /expression\s*\(/gi,
    /data:\s*text\/html/gi,
    /vbscript:/gi,
  ];

  // Path traversal patterns
  private readonly pathTraversalPatterns = [
    /\.\.\//g,
    /\.\.\\/,
    /%2e%2e%2f/gi,
    /%2e%2e\//gi,
    /\.%2e\//gi,
    /%2e\.\//gi,
    /\.\.%2f/gi,
    /%252e%252e%252f/gi,
    /\.\.\\/g,
    /%5c/gi,
  ];

  // Command injection patterns
  private readonly commandInjectionPatterns = [
    /[;&|`$]/,
    /\$\(/,
    /`[^`]*`/,
    /\|\|/,
    /&&/,
    /\$\{[^}]*\}/,
    />\s*\/dev\/null/,
    /\bnc\b.*-e/i,
    /\bwget\b/i,
    /\bcurl\b/i,
    /\bchmod\b/i,
    /\brm\b\s+-rf/i,
  ];

  constructor(private readonly configService: ConfigService) {
    this.config = {
      maxBodySize: this.configService.get<number>('VALIDATOR_MAX_BODY_SIZE', 1048576), // 1MB
      maxUrlLength: this.configService.get<number>('VALIDATOR_MAX_URL_LENGTH', 2048),
      maxHeaderSize: this.configService.get<number>('VALIDATOR_MAX_HEADER_SIZE', 8192),
      maxQueryParams: this.configService.get<number>('VALIDATOR_MAX_QUERY_PARAMS', 50),
      maxArrayLength: this.configService.get<number>('VALIDATOR_MAX_ARRAY_LENGTH', 1000),
      maxObjectDepth: this.configService.get<number>('VALIDATOR_MAX_OBJECT_DEPTH', 10),
      allowedContentTypes: this.configService
        .get<string>('VALIDATOR_ALLOWED_CONTENT_TYPES', 'application/json,application/x-www-form-urlencoded,multipart/form-data')
        .split(','),
      enableSqlInjectionCheck: this.configService.get<boolean>('VALIDATOR_SQL_INJECTION_CHECK', true),
      enableXssCheck: this.configService.get<boolean>('VALIDATOR_XSS_CHECK', true),
      enablePathTraversalCheck: this.configService.get<boolean>('VALIDATOR_PATH_TRAVERSAL_CHECK', true),
      enableCommandInjectionCheck: this.configService.get<boolean>('VALIDATOR_COMMAND_INJECTION_CHECK', true),
    };
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const validatedReq = req as ValidatedRequest;
    const errors: ValidationError[] = [];

    try {
      // Validate URL length
      if (req.originalUrl.length > this.config.maxUrlLength) {
        errors.push({
          field: 'url',
          message: `URL length exceeds maximum of ${this.config.maxUrlLength} characters`,
          code: 'URL_TOO_LONG',
        });
      }

      // Validate query parameters count
      const queryParamCount = Object.keys(req.query).length;
      if (queryParamCount > this.config.maxQueryParams) {
        errors.push({
          field: 'query',
          message: `Query parameter count exceeds maximum of ${this.config.maxQueryParams}`,
          code: 'TOO_MANY_QUERY_PARAMS',
        });
      }

      // Validate content type for requests with body
      if (this.hasBody(req) && !this.isValidContentType(req)) {
        errors.push({
          field: 'content-type',
          message: 'Invalid or unsupported content type',
          code: 'INVALID_CONTENT_TYPE',
        });
      }

      // Validate and sanitize body
      if (req.body && typeof req.body === 'object') {
        const bodyValidation = this.validateObject(req.body, 'body', 0);
        errors.push(...bodyValidation.errors);
        validatedReq.sanitizedBody = bodyValidation.sanitizedData as Record<string, unknown>;
      }

      // Validate and sanitize query parameters
      if (req.query && typeof req.query === 'object') {
        const queryValidation = this.validateObject(req.query as Record<string, unknown>, 'query', 0);
        errors.push(...queryValidation.errors);
        validatedReq.sanitizedQuery = queryValidation.sanitizedData as Record<string, unknown>;
      }

      // Validate URL path for security threats
      const pathErrors = this.validatePath(req.path);
      errors.push(...pathErrors);

      // Check headers for suspicious content
      const headerErrors = this.validateHeaders(req.headers as Record<string, string>);
      errors.push(...headerErrors);

      // Set validation result
      validatedReq.validationResult = {
        isValid: errors.length === 0,
        errors,
        sanitizedData: validatedReq.sanitizedBody,
      };

      // Log validation issues
      if (errors.length > 0) {
        this.logger.warn('Request validation issues detected', {
          path: req.path,
          method: req.method,
          ip: req.ip,
          errorCount: errors.length,
          errors: errors.map((e) => ({ field: e.field, code: e.code })),
        });

        // For critical security threats, reject the request
        const criticalErrors = errors.filter((e) =>
          ['SQL_INJECTION', 'XSS_DETECTED', 'PATH_TRAVERSAL', 'COMMAND_INJECTION'].includes(e.code),
        );

        if (criticalErrors.length > 0) {
          throw new BadRequestException({
            message: 'Request validation failed due to security concerns',
            errors: criticalErrors.map((e) => ({
              field: e.field,
              message: 'Invalid input detected',
              code: e.code,
            })),
          });
        }
      }

      next();
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error('Request validation error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });

      next();
    }
  }

  /**
   * Check if request has a body
   */
  private hasBody(req: Request): boolean {
    return ['POST', 'PUT', 'PATCH'].includes(req.method);
  }

  /**
   * Validate content type header
   */
  private isValidContentType(req: Request): boolean {
    const contentType = req.headers['content-type'];
    if (!contentType) {
      return false;
    }

    return this.config.allowedContentTypes.some((allowed) =>
      contentType.toLowerCase().includes(allowed.toLowerCase()),
    );
  }

  /**
   * Validate object recursively
   */
  private validateObject(
    obj: Record<string, unknown>,
    path: string,
    depth: number,
  ): ValidationResult {
    const errors: ValidationError[] = [];
    const sanitizedData: Record<string, unknown> = {};

    if (depth > this.config.maxObjectDepth) {
      errors.push({
        field: path,
        message: `Object nesting exceeds maximum depth of ${this.config.maxObjectDepth}`,
        code: 'OBJECT_TOO_DEEP',
      });
      return { isValid: false, errors, sanitizedData: obj };
    }

    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = `${path}.${key}`;

      // Validate key
      const keyErrors = this.validateString(key, `${fieldPath}[key]`);
      errors.push(...keyErrors);

      if (Array.isArray(value)) {
        // Validate array
        if (value.length > this.config.maxArrayLength) {
          errors.push({
            field: fieldPath,
            message: `Array length exceeds maximum of ${this.config.maxArrayLength}`,
            code: 'ARRAY_TOO_LONG',
          });
        }

        const sanitizedArray: unknown[] = [];
        for (let i = 0; i < Math.min(value.length, this.config.maxArrayLength); i++) {
          const item = value[i];
          if (typeof item === 'string') {
            const itemErrors = this.validateString(item, `${fieldPath}[${i}]`);
            errors.push(...itemErrors);
            sanitizedArray.push(this.sanitizeString(item));
          } else if (typeof item === 'object' && item !== null) {
            const itemResult = this.validateObject(
              item as Record<string, unknown>,
              `${fieldPath}[${i}]`,
              depth + 1,
            );
            errors.push(...itemResult.errors);
            sanitizedArray.push(itemResult.sanitizedData);
          } else {
            sanitizedArray.push(item);
          }
        }
        sanitizedData[key] = sanitizedArray;
      } else if (typeof value === 'object' && value !== null) {
        // Validate nested object
        const nestedResult = this.validateObject(
          value as Record<string, unknown>,
          fieldPath,
          depth + 1,
        );
        errors.push(...nestedResult.errors);
        sanitizedData[key] = nestedResult.sanitizedData;
      } else if (typeof value === 'string') {
        // Validate string value
        const stringErrors = this.validateString(value, fieldPath);
        errors.push(...stringErrors);
        sanitizedData[key] = this.sanitizeString(value);
      } else {
        // Pass through other types
        sanitizedData[key] = value;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      sanitizedData,
    };
  }

  /**
   * Validate string for security threats
   */
  private validateString(value: string, fieldPath: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // SQL Injection check
    if (this.config.enableSqlInjectionCheck) {
      for (const pattern of this.sqlInjectionPatterns) {
        if (pattern.test(value)) {
          errors.push({
            field: fieldPath,
            message: 'Potential SQL injection detected',
            code: 'SQL_INJECTION',
          });
          break;
        }
      }
    }

    // XSS check
    if (this.config.enableXssCheck) {
      for (const pattern of this.xssPatterns) {
        if (pattern.test(value)) {
          errors.push({
            field: fieldPath,
            message: 'Potential XSS attack detected',
            code: 'XSS_DETECTED',
          });
          break;
        }
      }
    }

    // Command injection check
    if (this.config.enableCommandInjectionCheck) {
      for (const pattern of this.commandInjectionPatterns) {
        if (pattern.test(value)) {
          errors.push({
            field: fieldPath,
            message: 'Potential command injection detected',
            code: 'COMMAND_INJECTION',
          });
          break;
        }
      }
    }

    return errors;
  }

  /**
   * Validate URL path
   */
  private validatePath(path: string): ValidationError[] {
    const errors: ValidationError[] = [];

    if (this.config.enablePathTraversalCheck) {
      for (const pattern of this.pathTraversalPatterns) {
        if (pattern.test(path)) {
          errors.push({
            field: 'path',
            message: 'Potential path traversal detected',
            code: 'PATH_TRAVERSAL',
          });
          break;
        }
      }
    }

    // Check for null bytes
    if (path.includes('\0') || path.includes('%00')) {
      errors.push({
        field: 'path',
        message: 'Null byte detected in path',
        code: 'NULL_BYTE_INJECTION',
      });
    }

    return errors;
  }

  /**
   * Validate request headers
   */
  private validateHeaders(headers: Record<string, string>): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check for suspicious headers
    const suspiciousHeaders = [
      'x-forwarded-host',
      'x-original-url',
      'x-rewrite-url',
    ];

    for (const header of suspiciousHeaders) {
      if (headers[header]) {
        const value = headers[header];
        if (typeof value === 'string') {
          // Check for header injection
          if (value.includes('\r') || value.includes('\n')) {
            errors.push({
              field: `header.${header}`,
              message: 'HTTP header injection detected',
              code: 'HEADER_INJECTION',
            });
          }
        }
      }
    }

    // Validate Host header
    const host = headers['host'];
    if (host && typeof host === 'string') {
      // Check for host header attacks
      if (host.includes('\r') || host.includes('\n') || host.includes('\0')) {
        errors.push({
          field: 'header.host',
          message: 'Invalid Host header detected',
          code: 'INVALID_HOST_HEADER',
        });
      }
    }

    return errors;
  }

  /**
   * Sanitize string by escaping dangerous characters
   */
  private sanitizeString(value: string): string {
    return value
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;')
      .replace(/\\/g, '&#x5C;')
      .replace(/`/g, '&#x60;');
  }

  /**
   * Check if a value contains potential threats
   */
  static containsThreats(value: string): boolean {
    const threatPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /\bSELECT\b.*\bFROM\b/i,
      /\bUNION\b.*\bSELECT\b/i,
      /\.\.\//,
      /[;&|`$]/,
    ];

    return threatPatterns.some((pattern) => pattern.test(value));
  }
}

/**
 * Helper to get validation result from request
 */
export function getValidationResult(req: Request): ValidationResult | undefined {
  return (req as ValidatedRequest).validationResult;
}

/**
 * Helper to get sanitized body from request
 */
export function getSanitizedBody(req: Request): Record<string, unknown> | undefined {
  return (req as ValidatedRequest).sanitizedBody;
}

/**
 * Helper to get sanitized query from request
 */
export function getSanitizedQuery(req: Request): Record<string, unknown> | undefined {
  return (req as ValidatedRequest).sanitizedQuery;
}
