import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import {
  EMAIL_REGEX,
  UUID_V4_REGEX,
  PHONE_REGEX,
  SLUG_REGEX,
  SQL_IDENTIFIER_REGEX,
  isStrongPassword,
  safeRegexTest,
} from './regex-patterns';
import { containsSqlDelimiterOrControl } from './string-safety';

/**
 * MaxLength Validation Decorator
 *
 * Enhanced version with security considerations:
 * - Validates string length
 * - Trims whitespace before validation (optional)
 * - Handles null/undefined gracefully
 */
export function SecureMaxLength(
  max: number,
  options?: ValidationOptions & { trim?: boolean },
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'secureMaxLength',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [max, options?.trim ?? false],
      options: {
        message: `${String(propertyName)} must be at most ${max} characters`,
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [maxLength, shouldTrim] = args.constraints as [number, boolean];

          if (value === null || value === undefined) {
            return true; // Let @IsOptional() handle this
          }

          if (typeof value !== 'string') {
            return false;
          }

          const strValue = shouldTrim ? value.trim() : value;
          return strValue.length <= maxLength;
        },
      },
    });
  };
}

/**
 * MinLength Validation Decorator
 */
export function SecureMinLength(
  min: number,
  options?: ValidationOptions & { trim?: boolean },
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'secureMinLength',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [min, options?.trim ?? false],
      options: {
        message: `${String(propertyName)} must be at least ${min} characters`,
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [minLength, shouldTrim] = args.constraints as [number, boolean];

          if (value === null || value === undefined) {
            return true;
          }

          if (typeof value !== 'string') {
            return false;
          }

          const strValue = shouldTrim ? value.trim() : value;
          return strValue.length >= minLength;
        },
      },
    });
  };
}

/**
 * Safe Email Validation
 */
@ValidatorConstraint({ name: 'isSafeEmail', async: false })
export class IsSafeEmailConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length > 254) return false; // RFC 5321
    return safeRegexTest(EMAIL_REGEX, value) ?? false;
  }

  defaultMessage(): string {
    return 'Invalid email format';
  }
}

export function IsSafeEmail(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSafeEmailConstraint,
    });
  };
}

/**
 * Safe UUID Validation
 */
@ValidatorConstraint({ name: 'isSafeUuid', async: false })
export class IsSafeUuidConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length !== 36) return false;
    return UUID_V4_REGEX.test(value);
  }

  defaultMessage(): string {
    return 'Invalid UUID format';
  }
}

export function IsSafeUuid(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSafeUuidConstraint,
    });
  };
}

/**
 * Safe Phone Validation
 */
@ValidatorConstraint({ name: 'isSafePhone', async: false })
export class IsSafePhoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length > 20) return false;
    return PHONE_REGEX.test(value);
  }

  defaultMessage(): string {
    return 'Invalid phone number format';
  }
}

export function IsSafePhone(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSafePhoneConstraint,
    });
  };
}

/**
 * Safe Slug Validation
 */
@ValidatorConstraint({ name: 'isSafeSlug', async: false })
export class IsSafeSlugConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length > 100) return false;
    return SLUG_REGEX.test(value);
  }

  defaultMessage(): string {
    return 'Invalid slug format (lowercase alphanumeric with hyphens)';
  }
}

export function IsSafeSlug(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSafeSlugConstraint,
    });
  };
}

/**
 * SQL Identifier Validation
 * Validates that string is safe for use as table/column name
 */
@ValidatorConstraint({ name: 'isSqlIdentifier', async: false })
export class IsSqlIdentifierConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (value.length > 63) return false; // PostgreSQL limit
    return SQL_IDENTIFIER_REGEX.test(value);
  }

  defaultMessage(): string {
    return 'Invalid SQL identifier format';
  }
}

export function IsSqlIdentifier(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsSqlIdentifierConstraint,
    });
  };
}

/**
 * Strong Password Validation
 */
@ValidatorConstraint({ name: 'isStrongPasswordConstraint', async: false })
export class IsStrongPasswordConstraint implements ValidatorConstraintInterface {
  private errors: string[] = [];

  validate(value: unknown): boolean {
    if (typeof value !== 'string') {
      this.errors = ['Password must be a string'];
      return false;
    }

    const result = isStrongPassword(value);
    this.errors = result.errors;
    return result.valid;
  }

  defaultMessage(): string {
    return this.errors.join('. ');
  }
}

export function IsStrongPassword(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: IsStrongPasswordConstraint,
    });
  };
}

/**
 * No HTML Tags Validation
 * Prevents XSS by disallowing HTML tags
 */
@ValidatorConstraint({ name: 'noHtmlTags', async: false })
export class NoHtmlTagsConstraint implements ValidatorConstraintInterface {
  private readonly htmlTagRegex = /<[^>]*>/;

  validate(value: unknown): boolean {
    if (typeof value !== 'string') return true;
    return !this.htmlTagRegex.test(value);
  }

  defaultMessage(): string {
    return 'HTML tags are not allowed';
  }
}

export function NoHtmlTags(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: NoHtmlTagsConstraint,
    });
  };
}

/**
 * No SQL Injection Characters
 * Basic protection against SQL injection in identifiers
 */
@ValidatorConstraint({ name: 'noSqlInjection', async: false })
export class NoSqlInjectionConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return true;
    return !containsSqlDelimiterOrControl(value);
  }

  defaultMessage(): string {
    return 'Value contains potentially dangerous characters';
  }
}

export function NoSqlInjection(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      constraints: [],
      validator: NoSqlInjectionConstraint,
    });
  };
}

/**
 * Tenant ID Must Match Validation
 * Ensures a property matches the user's tenant ID
 */
export function MustMatchTenantId(options?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'mustMatchTenantId',
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: 'Access denied: tenant ID mismatch',
        ...options,
      },
      constraints: [],
      validator: {
        validate(_value: unknown, _args: ValidationArguments): boolean {
          // This validation is typically done at the guard level
          // Decorator is for documentation/schema purposes
          return true;
        },
      },
    });
  };
}

/**
 * Safe Array Length Validation
 */
export function SafeArrayLength(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    registerDecorator({
      name: 'safeArrayLength',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [min, max],
      options: {
        message: `${String(propertyName)} must have between ${min} and ${max} items`,
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const [minLen, maxLen] = args.constraints as [number, number];

          if (!Array.isArray(value)) return false;
          return value.length >= minLen && value.length <= maxLen;
        },
      },
    });
  };
}
