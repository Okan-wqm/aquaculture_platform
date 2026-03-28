/**
 * ValidateDynamicParameters Decorator
 *
 * Custom class-validator decorator for JSONB dynamicParameters field.
 * Ensures the value is a flat object with max 100 keys, primitive values only.
 *
 * Key format: starts with letter, alphanumeric + underscores, max 64 chars.
 * Value types: number (finite only), string (max 1000 chars), boolean.
 * No nested objects, arrays, null, or undefined values allowed.
 *
 * @module WaterQuality/Validators
 */
import { registerDecorator, ValidationOptions, ValidatorConstraintInterface, ValidatorConstraint } from 'class-validator';

@ValidatorConstraint({ name: 'validateDynamicParameters', async: false })
export class DynamicParametersConstraint implements ValidatorConstraintInterface {
  private static readonly KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
  private static readonly MAX_KEYS = 100;
  private static readonly MAX_STRING_LENGTH = 1000;

  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true; // optional field

    if (typeof value !== 'object' || Array.isArray(value)) return false;

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    // Max 100 keys
    if (keys.length > DynamicParametersConstraint.MAX_KEYS) return false;

    for (const key of keys) {
      // Key format: starts with letter, alphanumeric + underscores, max 64 chars
      if (!DynamicParametersConstraint.KEY_PATTERN.test(key)) return false;

      const val = obj[key];
      // Only primitives: number, string, boolean
      if (typeof val === 'number') {
        if (!isFinite(val)) return false; // reject NaN, Infinity
      } else if (typeof val === 'string') {
        if (val.length > DynamicParametersConstraint.MAX_STRING_LENGTH) return false;
      } else if (typeof val === 'boolean') {
        // ok
      } else {
        return false; // nested objects, arrays, null not allowed
      }
    }
    return true;
  }

  defaultMessage(): string {
    return 'dynamicParameters must be a flat object with max 100 keys, primitive values only';
  }
}

export function ValidateDynamicParameters(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'validateDynamicParameters',
      target: object.constructor,
      propertyName,
      options: {
        message: 'dynamicParameters must be a flat object with max 100 keys, primitive values only',
        ...validationOptions,
      },
      validator: DynamicParametersConstraint,
    });
  };
}
