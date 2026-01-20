/**
 * Specification Validation Utility
 * Equipment type specificationSchema için client-side validation
 */

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface SpecificationFieldOption {
  value: string;
  label: string;
}

export interface SpecificationField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'boolean' | 'date' | 'textarea';
  required?: boolean;
  unit?: string;
  options?: SpecificationFieldOption[];
  min?: number;
  max?: number;
  defaultValue?: unknown;
  placeholder?: string;
  helpText?: string;
  group?: string;
}

export interface SpecificationSchema {
  fields: SpecificationField[];
  groups?: Array<{
    name: string;
    label: string;
    description?: string;
  }>;
}

// ============================================================================
// Validation Fonksiyonları
// ============================================================================

/**
 * Specification değerlerini schema'ya göre validate eder
 *
 * @param schema - Specification şeması
 * @param values - Validate edilecek değerler
 * @returns Alan adı -> hata mesajı eşlemesi
 *
 * @example
 * const errors = validateSpecifications(schema, values);
 * if (Object.keys(errors).length > 0) {
 *   // Hatalar var
 * }
 */
export function validateSpecifications(
  schema: SpecificationSchema | null | undefined,
  values: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!schema || !schema.fields) {
    return errors;
  }

  schema.fields.forEach((field) => {
    const value = values[field.name];

    // Required check
    if (field.required) {
      if (value === undefined || value === null || value === '') {
        errors[field.name] = `${field.label} is required`;
        return; // Skip other validations for this field
      }

      // Array için boş kontrolü
      if (Array.isArray(value) && value.length === 0) {
        errors[field.name] = `${field.label} is required`;
        return;
      }
    }

    // Skip further validation if value is empty and not required
    if (value === undefined || value === null || value === '') {
      return;
    }

    // Type-specific validations
    switch (field.type) {
      case 'number': {
        const numValue = Number(value);

        // NaN check
        if (isNaN(numValue)) {
          errors[field.name] = `${field.label} must be a valid number`;
          return;
        }

        // Min check
        if (field.min !== undefined && numValue < field.min) {
          errors[field.name] = `${field.label} must be at least ${field.min}${field.unit ? ' ' + field.unit : ''}`;
          return;
        }

        // Max check
        if (field.max !== undefined && numValue > field.max) {
          errors[field.name] = `${field.label} must be at most ${field.max}${field.unit ? ' ' + field.unit : ''}`;
          return;
        }
        break;
      }

      case 'select': {
        // Valid option check
        if (field.options && field.options.length > 0) {
          const validValues = field.options.map((opt) => opt.value);
          if (!validValues.includes(String(value))) {
            errors[field.name] = `${field.label} has an invalid selection`;
          }
        }
        break;
      }

      case 'multiselect': {
        // Array check
        if (!Array.isArray(value)) {
          errors[field.name] = `${field.label} must be an array`;
          return;
        }

        // Valid options check
        if (field.options && field.options.length > 0) {
          const validValues = field.options.map((opt) => opt.value);
          const invalidValues = (value as string[]).filter((v) => !validValues.includes(v));
          if (invalidValues.length > 0) {
            errors[field.name] = `${field.label} contains invalid selections`;
          }
        }
        break;
      }

      case 'date': {
        // Date format check
        const dateValue = new Date(value as string);
        if (isNaN(dateValue.getTime())) {
          errors[field.name] = `${field.label} must be a valid date`;
        }
        break;
      }

      case 'boolean': {
        // Boolean type check
        if (typeof value !== 'boolean') {
          errors[field.name] = `${field.label} must be true or false`;
        }
        break;
      }

      case 'text':
      case 'textarea':
      default: {
        // String type check
        if (typeof value !== 'string') {
          errors[field.name] = `${field.label} must be text`;
        }
        break;
      }
    }
  });

  return errors;
}

/**
 * Specification değerlerinin geçerli olup olmadığını kontrol eder
 *
 * @param schema - Specification şeması
 * @param values - Kontrol edilecek değerler
 * @returns Değerler geçerli mi
 */
export function isSpecificationValid(
  schema: SpecificationSchema | null | undefined,
  values: Record<string, unknown>
): boolean {
  const errors = validateSpecifications(schema, values);
  return Object.keys(errors).length === 0;
}

/**
 * Specification değerlerini varsayılan değerlerle initialize eder
 *
 * @param schema - Specification şeması
 * @returns Varsayılan değerler ile doldurulmuş obje
 */
export function getDefaultSpecificationValues(
  schema: SpecificationSchema | null | undefined
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  if (!schema || !schema.fields) {
    return defaults;
  }

  schema.fields.forEach((field) => {
    if (field.defaultValue !== undefined) {
      defaults[field.name] = field.defaultValue;
    } else {
      // Type-based defaults
      switch (field.type) {
        case 'number':
          defaults[field.name] = '';
          break;
        case 'boolean':
          defaults[field.name] = false;
          break;
        case 'multiselect':
          defaults[field.name] = [];
          break;
        case 'text':
        case 'textarea':
        case 'select':
        case 'date':
        default:
          defaults[field.name] = '';
          break;
      }
    }
  });

  return defaults;
}

/**
 * Mevcut değerleri schema'ya göre temizler (bilinmeyen alanları kaldırır)
 *
 * @param schema - Specification şeması
 * @param values - Temizlenecek değerler
 * @returns Temizlenmiş değerler
 */
export function cleanSpecificationValues(
  schema: SpecificationSchema | null | undefined,
  values: Record<string, unknown>
): Record<string, unknown> {
  if (!schema || !schema.fields) {
    return {};
  }

  const validFieldNames = new Set(schema.fields.map((f) => f.name));
  const cleaned: Record<string, unknown> = {};

  Object.entries(values).forEach(([key, value]) => {
    if (validFieldNames.has(key)) {
      cleaned[key] = value;
    }
  });

  return cleaned;
}
