/**
 * Validation Utilities Tests
 *
 * Comprehensive tests for all validator factory functions:
 * - required: null, undefined, empty string, empty array
 * - email: valid/invalid email formats
 * - minLength / maxLength: boundary values
 * - pattern: regex validation
 * - compose via validateField: multiple validators
 * - hasErrors: empty/non-empty check
 * - Additional validators: url, phone, tcKimlik, between, strongPassword, etc.
 * - Schema validation: validateSchema
 * - Sanitization helpers: sanitize, stripHtml, onlyDigits, onlyLetters, alphanumeric
 */

import { describe, it, expect } from 'vitest';
import {
  required,
  email,
  minLength,
  maxLength,
  lengthBetween,
  min,
  max,
  between,
  url,
  phone,
  tcKimlik,
  vergiNo,
  iban,
  pattern,
  strongPassword,
  passwordMatch,
  date,
  oneOf,
  equals,
  when,
  validateField,
  validateSchema,
  hasErrors,
  sanitize,
  stripHtml,
  onlyDigits,
  onlyLetters,
  alphanumeric,
  type ValidationErrors,
} from '../validation';

// ============================================================================
// required()
// ============================================================================

describe('required', () => {
  const rule = required();

  it('should fail for null', () => {
    expect(rule(null).valid).toBe(false);
  });

  it('should fail for undefined', () => {
    expect(rule(undefined).valid).toBe(false);
  });

  it('should fail for empty string', () => {
    expect(rule('').valid).toBe(false);
  });

  it('should fail for whitespace-only string', () => {
    expect(rule('   ').valid).toBe(false);
  });

  it('should fail for empty array', () => {
    expect(rule([]).valid).toBe(false);
  });

  it('should pass for non-empty string', () => {
    expect(rule('hello').valid).toBe(true);
  });

  it('should pass for number 0', () => {
    expect(rule(0).valid).toBe(true);
  });

  it('should pass for boolean false', () => {
    expect(rule(false).valid).toBe(true);
  });

  it('should pass for non-empty array', () => {
    expect(rule([1]).valid).toBe(true);
  });

  it('should use custom error message', () => {
    const customRule = required('Name is required');
    const result = customRule('');
    expect(result.error).toBe('Name is required');
  });

  it('should use default Turkish error message', () => {
    const result = rule(null);
    expect(result.error).toBe('Bu alan zorunludur');
  });
});

// ============================================================================
// email()
// ============================================================================

describe('email', () => {
  const rule = email();

  it('should pass for valid email', () => {
    expect(rule('user@example.com').valid).toBe(true);
  });

  it('should pass for email with subdomain', () => {
    expect(rule('user@mail.example.com').valid).toBe(true);
  });

  it('should pass for email with plus tag', () => {
    expect(rule('user+tag@example.com').valid).toBe(true);
  });

  it('should fail for missing @ symbol', () => {
    expect(rule('userexample.com').valid).toBe(false);
  });

  it('should fail for missing domain', () => {
    expect(rule('user@').valid).toBe(false);
  });

  it('should fail for missing TLD', () => {
    expect(rule('user@example').valid).toBe(false);
  });

  it('should fail for spaces in email', () => {
    expect(rule('user @example.com').valid).toBe(false);
  });

  it('should pass for empty string (not required)', () => {
    expect(rule('').valid).toBe(true);
  });

  it('should use custom error message', () => {
    const customRule = email('Invalid email format');
    const result = customRule('invalid');
    expect(result.error).toBe('Invalid email format');
  });
});

// ============================================================================
// minLength()
// ============================================================================

describe('minLength', () => {
  const rule = minLength(3);

  it('should fail for string shorter than min', () => {
    expect(rule('ab').valid).toBe(false);
  });

  it('should pass for string at exact min length', () => {
    expect(rule('abc').valid).toBe(true);
  });

  it('should pass for string longer than min', () => {
    expect(rule('abcdef').valid).toBe(true);
  });

  it('should fail for empty string', () => {
    expect(rule('').valid).toBe(false);
  });

  it('should use custom error message', () => {
    const customRule = minLength(5, 'Too short');
    const result = customRule('abc');
    expect(result.error).toBe('Too short');
  });

  it('should use default Turkish error message', () => {
    const result = rule('a');
    expect(result.error).toContain('3');
  });
});

// ============================================================================
// maxLength()
// ============================================================================

describe('maxLength', () => {
  const rule = maxLength(5);

  it('should pass for string shorter than max', () => {
    expect(rule('abc').valid).toBe(true);
  });

  it('should pass for string at exact max length', () => {
    expect(rule('abcde').valid).toBe(true);
  });

  it('should fail for string longer than max', () => {
    expect(rule('abcdef').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });

  it('should use custom error message', () => {
    const customRule = maxLength(3, 'Too long');
    const result = customRule('abcd');
    expect(result.error).toBe('Too long');
  });

  it('should handle very long strings', () => {
    const longString = 'a'.repeat(10000);
    expect(rule(longString).valid).toBe(false);
  });
});

// ============================================================================
// lengthBetween()
// ============================================================================

describe('lengthBetween', () => {
  const rule = lengthBetween(2, 5);

  it('should fail for string shorter than min', () => {
    expect(rule('a').valid).toBe(false);
  });

  it('should pass at min boundary', () => {
    expect(rule('ab').valid).toBe(true);
  });

  it('should pass at max boundary', () => {
    expect(rule('abcde').valid).toBe(true);
  });

  it('should fail for string longer than max', () => {
    expect(rule('abcdef').valid).toBe(false);
  });

  it('should fail for empty string', () => {
    expect(rule('').valid).toBe(false);
  });
});

// ============================================================================
// min() / max() / between() (numeric)
// ============================================================================

describe('min (numeric)', () => {
  const rule = min(10);

  it('should fail for value below minimum', () => {
    expect(rule(5).valid).toBe(false);
  });

  it('should pass at exact minimum', () => {
    expect(rule(10).valid).toBe(true);
  });

  it('should pass above minimum', () => {
    expect(rule(15).valid).toBe(true);
  });

  it('should handle negative numbers', () => {
    const negRule = min(-5);
    expect(negRule(-10).valid).toBe(false);
    expect(negRule(-5).valid).toBe(true);
    expect(negRule(0).valid).toBe(true);
  });
});

describe('max (numeric)', () => {
  const rule = max(100);

  it('should pass for value below maximum', () => {
    expect(rule(50).valid).toBe(true);
  });

  it('should pass at exact maximum', () => {
    expect(rule(100).valid).toBe(true);
  });

  it('should fail above maximum', () => {
    expect(rule(101).valid).toBe(false);
  });
});

describe('between (numeric)', () => {
  const rule = between(1, 10);

  it('should fail below range', () => {
    expect(rule(0).valid).toBe(false);
  });

  it('should pass at min boundary', () => {
    expect(rule(1).valid).toBe(true);
  });

  it('should pass within range', () => {
    expect(rule(5).valid).toBe(true);
  });

  it('should pass at max boundary', () => {
    expect(rule(10).valid).toBe(true);
  });

  it('should fail above range', () => {
    expect(rule(11).valid).toBe(false);
  });
});

// ============================================================================
// pattern()
// ============================================================================

describe('pattern', () => {
  it('should pass when value matches regex', () => {
    const rule = pattern(/^[A-Z]{3}$/, 'Must be 3 uppercase letters');
    expect(rule('ABC').valid).toBe(true);
  });

  it('should fail when value does not match regex', () => {
    const rule = pattern(/^[A-Z]{3}$/, 'Must be 3 uppercase letters');
    const result = rule('abc');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Must be 3 uppercase letters');
  });

  it('should pass for empty string (not required)', () => {
    const rule = pattern(/^\d+$/, 'Numbers only');
    expect(rule('').valid).toBe(true);
  });

  it('should work with complex regex patterns', () => {
    const hexColor = pattern(/^#[0-9A-Fa-f]{6}$/, 'Invalid color');
    expect(hexColor('#FF00AA').valid).toBe(true);
    expect(hexColor('#GGHHII').valid).toBe(false);
  });
});

// ============================================================================
// url()
// ============================================================================

describe('url', () => {
  const rule = url();

  it('should pass for valid http URL', () => {
    expect(rule('https://example.com').valid).toBe(true);
  });

  it('should pass for URL with path', () => {
    expect(rule('https://example.com/path/to/resource').valid).toBe(true);
  });

  it('should fail for invalid URL', () => {
    expect(rule('not-a-url').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// phone()
// ============================================================================

describe('phone (Turkish format)', () => {
  const rule = phone();

  it('should pass for +90 format', () => {
    expect(rule('+905321234567').valid).toBe(true);
  });

  it('should pass for 0 prefix format', () => {
    expect(rule('05321234567').valid).toBe(true);
  });

  it('should pass with spaces', () => {
    expect(rule('+90 532 123 45 67').valid).toBe(true);
  });

  it('should pass with dashes', () => {
    expect(rule('0532-123-45-67').valid).toBe(true);
  });

  it('should fail for non-mobile number', () => {
    expect(rule('02121234567').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// tcKimlik()
// ============================================================================

describe('tcKimlik', () => {
  const rule = tcKimlik();

  it('should fail for non-11-digit value', () => {
    expect(rule('12345').valid).toBe(false);
  });

  it('should fail when first digit is 0', () => {
    expect(rule('01234567890').valid).toBe(false);
  });

  it('should fail for non-numeric characters', () => {
    expect(rule('1234567890a').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });

  it('should validate checksum algorithm', () => {
    // A valid TC number: 10000000146
    // Digits: 1,0,0,0,0,0,0,0,1,4,6
    // Sum of 1-9: 1+0+0+0+0+0+0+0+1 = 2, 2 % 10 = 2, but digit 10 = 4 -> fail
    // This is a synthetic check - the algorithm should catch invalid checksums
    expect(rule('10000000146').valid).toBe(false);
  });
});

// ============================================================================
// vergiNo()
// ============================================================================

describe('vergiNo', () => {
  const rule = vergiNo();

  it('should pass for valid 10-digit tax number', () => {
    expect(rule('1234567890').valid).toBe(true);
  });

  it('should fail for 9-digit number', () => {
    expect(rule('123456789').valid).toBe(false);
  });

  it('should fail for 11-digit number', () => {
    expect(rule('12345678901').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// iban()
// ============================================================================

describe('iban (Turkish)', () => {
  const rule = iban();

  it('should pass for valid TR IBAN format', () => {
    expect(rule('TR' + '0'.repeat(24)).valid).toBe(true);
  });

  it('should pass with spaces', () => {
    expect(rule('TR00 0000 0000 0000 0000 0000 00').valid).toBe(true);
  });

  it('should pass for lowercase tr', () => {
    expect(rule('tr' + '0'.repeat(24)).valid).toBe(true);
  });

  it('should fail for non-TR IBAN', () => {
    expect(rule('DE' + '0'.repeat(24)).valid).toBe(false);
  });

  it('should fail for short IBAN', () => {
    expect(rule('TR123').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// strongPassword()
// ============================================================================

describe('strongPassword', () => {
  const rule = strongPassword();

  it('should pass for strong password', () => {
    expect(rule('Str0ng!Pass').valid).toBe(true);
  });

  it('should fail for short password', () => {
    const result = rule('Ab1!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('8 karakter');
  });

  it('should fail without lowercase', () => {
    const result = rule('ABCDEFGH1!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('küçük harf');
  });

  it('should fail without uppercase', () => {
    const result = rule('abcdefgh1!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('büyük harf');
  });

  it('should fail without digit', () => {
    const result = rule('Abcdefgh!');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('rakam');
  });

  it('should fail without special character', () => {
    const result = rule('Abcdefgh1');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('özel karakter');
  });

  it('should pass for empty string (not required)', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// passwordMatch()
// ============================================================================

describe('passwordMatch', () => {
  it('should pass when passwords match', () => {
    const rule = passwordMatch('secret123');
    expect(rule('secret123').valid).toBe(true);
  });

  it('should fail when passwords differ', () => {
    const rule = passwordMatch('secret123');
    const result = rule('different');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('eşleşmiyor');
  });
});

// ============================================================================
// date()
// ============================================================================

describe('date', () => {
  const rule = date();

  it('should pass for valid date string', () => {
    expect(rule('2024-01-15').valid).toBe(true);
  });

  it('should pass for Date object', () => {
    expect(rule(new Date()).valid).toBe(true);
  });

  it('should fail for invalid date string', () => {
    expect(rule('not-a-date').valid).toBe(false);
  });

  it('should pass for empty string', () => {
    expect(rule('').valid).toBe(true);
  });
});

// ============================================================================
// oneOf()
// ============================================================================

describe('oneOf', () => {
  const rule = oneOf(['red', 'green', 'blue']);

  it('should pass for value in list', () => {
    expect(rule('red').valid).toBe(true);
  });

  it('should fail for value not in list', () => {
    expect(rule('yellow').valid).toBe(false);
  });
});

// ============================================================================
// equals()
// ============================================================================

describe('equals', () => {
  it('should pass for matching value', () => {
    const rule = equals('expected');
    expect(rule('expected').valid).toBe(true);
  });

  it('should fail for non-matching value', () => {
    const rule = equals(42);
    expect(rule(43).valid).toBe(false);
  });
});

// ============================================================================
// when() (conditional validation)
// ============================================================================

describe('when', () => {
  it('should apply rules when condition is true', () => {
    const rule = when<string>(true, [required(), minLength(3)]);
    expect(rule('ab').valid).toBe(false);
  });

  it('should skip rules when condition is false', () => {
    const rule = when<string>(false, [required()]);
    expect(rule('').valid).toBe(true);
  });

  it('should accept function as condition', () => {
    let flag = false;
    const rule = when<string>(() => flag, [required()]);

    expect(rule('').valid).toBe(true);

    flag = true;
    expect(rule('').valid).toBe(false);
  });
});

// ============================================================================
// validateField (compose multiple validators)
// ============================================================================

describe('validateField (compose)', () => {
  it('should return first error from composed rules', () => {
    const result = validateField('', [required(), minLength(3)]);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Bu alan zorunludur'); // First rule fails
  });

  it('should pass when all rules pass', () => {
    const result = validateField('hello@example.com', [
      required(),
      email(),
      minLength(5),
    ]);
    expect(result.valid).toBe(true);
  });

  it('should return second rule error when first passes', () => {
    const result = validateField('ab', [required(), minLength(5)]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('5');
  });

  it('should handle empty rules array', () => {
    const result = validateField('anything', []);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// validateSchema
// ============================================================================

describe('validateSchema', () => {
  it('should validate all fields and return errors', () => {
    const data = { name: '', email: 'invalid' };
    const schema = {
      name: [required()],
      email: [required(), email()],
    };

    const errors = validateSchema(data, schema);
    expect(errors.name).toBe('Bu alan zorunludur');
    expect(errors.email).toBeDefined(); // email passes required but fails email()
  });

  it('should return empty errors for valid data', () => {
    const data = { name: 'John', email: 'john@example.com' };
    const schema = {
      name: [required()],
      email: [required(), email()],
    };

    const errors = validateSchema(data, schema);
    expect(hasErrors(errors)).toBe(false);
  });

  it('should skip fields without rules', () => {
    const data = { name: 'John', extra: '' };
    const schema = {
      name: [required()],
    };

    const errors = validateSchema(data, schema as any);
    expect(errors.name).toBeUndefined();
  });
});

// ============================================================================
// hasErrors
// ============================================================================

describe('hasErrors', () => {
  it('should return false for empty object', () => {
    expect(hasErrors({})).toBe(false);
  });

  it('should return false when all values are undefined', () => {
    const errors: ValidationErrors<{ a: string; b: string }> = {
      a: undefined,
      b: undefined,
    };
    expect(hasErrors(errors)).toBe(false);
  });

  it('should return false when all values are empty strings', () => {
    // BUG-018: empty strings should not be treated as errors
    const errors: ValidationErrors<{ a: string }> = {
      a: '',
    };
    expect(hasErrors(errors)).toBe(false);
  });

  it('should return true when at least one error exists', () => {
    const errors: ValidationErrors<{ a: string; b: string }> = {
      a: undefined,
      b: 'This field is required',
    };
    expect(hasErrors(errors)).toBe(true);
  });

  it('should return true for multiple errors', () => {
    const errors: ValidationErrors<{ name: string; email: string }> = {
      name: 'Required',
      email: 'Invalid email',
    };
    expect(hasErrors(errors)).toBe(true);
  });
});

// ============================================================================
// Sanitization Helpers
// ============================================================================

describe('sanitize', () => {
  it('should trim whitespace', () => {
    expect(sanitize('  hello  ')).toBe('hello');
  });

  it('should normalize multiple spaces', () => {
    expect(sanitize('hello   world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(sanitize('')).toBe('');
  });

  it('should handle tabs and newlines', () => {
    expect(sanitize('hello\t\n  world')).toBe('hello world');
  });
});

describe('stripHtml', () => {
  it('should strip HTML tags', () => {
    const result = stripHtml('<p>Hello <b>World</b></p>');
    expect(result).toBe('Hello World');
  });

  it('should handle empty string', () => {
    expect(stripHtml('')).toBe('');
  });

  it('should handle string without HTML', () => {
    expect(stripHtml('Plain text')).toBe('Plain text');
  });
});

describe('onlyDigits', () => {
  it('should extract only digits', () => {
    expect(onlyDigits('abc123def456')).toBe('123456');
  });

  it('should return empty for no digits', () => {
    expect(onlyDigits('abcdef')).toBe('');
  });

  it('should handle empty string', () => {
    expect(onlyDigits('')).toBe('');
  });

  it('should handle phone number format', () => {
    expect(onlyDigits('+90 532 123 45 67')).toBe('905321234567');
  });
});

describe('onlyLetters', () => {
  it('should extract only letters', () => {
    expect(onlyLetters('abc123')).toBe('abc');
  });

  it('should keep Turkish characters', () => {
    expect(onlyLetters('çğıöşü123')).toBe('çğıöşü');
  });

  it('should handle empty string', () => {
    expect(onlyLetters('')).toBe('');
  });
});

describe('alphanumeric', () => {
  it('should keep letters and digits', () => {
    expect(alphanumeric('abc-123_def')).toBe('abc123def');
  });

  it('should keep Turkish characters', () => {
    expect(alphanumeric('Ömer 123!')).toBe('Ömer123');
  });

  it('should handle empty string', () => {
    expect(alphanumeric('')).toBe('');
  });
});
