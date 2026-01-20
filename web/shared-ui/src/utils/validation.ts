/**
 * Validation Utilities
 * Form ve veri doğrulama için yardımcı fonksiyonlar
 * Türkçe hata mesajları
 */

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

/**
 * Doğrulama sonucu
 */
export interface ValidationResult {
  /** Geçerli mi */
  valid: boolean;
  /** Hata mesajı (geçersizse) */
  error?: string;
}

/**
 * Doğrulama kuralı
 */
export type ValidationRule<T = unknown> = (value: T) => ValidationResult;

/**
 * Şema doğrulama tanımı
 */
export type ValidationSchema<T> = {
  [K in keyof T]?: ValidationRule<T[K]>[];
};

/**
 * Şema doğrulama sonucu
 */
export type ValidationErrors<T> = {
  [K in keyof T]?: string;
};

// ============================================================================
// Temel Doğrulayıcılar
// ============================================================================

/**
 * Zorunlu alan kontrolü
 */
export function required(message: string = 'Bu alan zorunludur'): ValidationRule {
  return (value: unknown): ValidationResult => {
    if (value === null || value === undefined) {
      return { valid: false, error: message };
    }

    if (typeof value === 'string' && value.trim() === '') {
      return { valid: false, error: message };
    }

    if (Array.isArray(value) && value.length === 0) {
      return { valid: false, error: message };
    }

    return { valid: true };
  };
}

/**
 * Minimum uzunluk kontrolü
 */
export function minLength(min: number, message?: string): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value || value.length < min) {
      return {
        valid: false,
        error: message || `En az ${min} karakter olmalıdır`,
      };
    }
    return { valid: true };
  };
}

/**
 * Maksimum uzunluk kontrolü
 */
export function maxLength(max: number, message?: string): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (value && value.length > max) {
      return {
        valid: false,
        error: message || `En fazla ${max} karakter olabilir`,
      };
    }
    return { valid: true };
  };
}

/**
 * Uzunluk aralığı kontrolü
 */
export function lengthBetween(min: number, max: number, message?: string): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value || value.length < min || value.length > max) {
      return {
        valid: false,
        error: message || `${min} ile ${max} karakter arasında olmalıdır`,
      };
    }
    return { valid: true };
  };
}

/**
 * Minimum değer kontrolü
 */
export function min(minValue: number, message?: string): ValidationRule<number> {
  return (value: number): ValidationResult => {
    if (value < minValue) {
      return {
        valid: false,
        error: message || `Değer en az ${minValue} olmalıdır`,
      };
    }
    return { valid: true };
  };
}

/**
 * Maksimum değer kontrolü
 */
export function max(maxValue: number, message?: string): ValidationRule<number> {
  return (value: number): ValidationResult => {
    if (value > maxValue) {
      return {
        valid: false,
        error: message || `Değer en fazla ${maxValue} olabilir`,
      };
    }
    return { valid: true };
  };
}

/**
 * Değer aralığı kontrolü
 */
export function between(minValue: number, maxValue: number, message?: string): ValidationRule<number> {
  return (value: number): ValidationResult => {
    if (value < minValue || value > maxValue) {
      return {
        valid: false,
        error: message || `Değer ${minValue} ile ${maxValue} arasında olmalıdır`,
      };
    }
    return { valid: true };
  };
}

// ============================================================================
// Format Doğrulayıcıları
// ============================================================================

/**
 * Email format kontrolü
 */
export function email(message: string = 'Geçerli bir e-posta adresi giriniz'): ValidationRule<string> {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  return (value: string): ValidationResult => {
    if (value && !emailRegex.test(value)) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * URL format kontrolü
 */
export function url(message: string = 'Geçerli bir URL giriniz'): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    try {
      new URL(value);
      return { valid: true };
    } catch {
      return { valid: false, error: message };
    }
  };
}

/**
 * Telefon numarası kontrolü (Türkiye formatı)
 */
export function phone(message: string = 'Geçerli bir telefon numarası giriniz'): ValidationRule<string> {
  // Türkiye telefon formatları: +90 5XX XXX XX XX veya 05XX XXX XX XX
  const phoneRegex = /^(\+90|0)?[5][0-9]{9}$/;

  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    // Boşluk ve tireleri temizle
    const cleaned = value.replace(/[\s-]/g, '');

    if (!phoneRegex.test(cleaned)) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * TC Kimlik numarası kontrolü
 */
export function tcKimlik(message: string = 'Geçerli bir TC Kimlik numarası giriniz'): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    // 11 haneli ve rakamlardan oluşmalı
    if (!/^[0-9]{11}$/.test(value)) {
      return { valid: false, error: message };
    }

    // İlk rakam 0 olamaz
    if (value[0] === '0') {
      return { valid: false, error: message };
    }

    // TC Kimlik algoritma kontrolü
    const digits = value.split('').map(Number);

    // 1-9. hanelerin toplamının mod 10'u 10. hane
    const sum1 = digits.slice(0, 9).reduce((acc, d) => acc + d, 0);
    if (sum1 % 10 !== digits[9]) {
      return { valid: false, error: message };
    }

    // 1-10. hanelerin toplamının mod 10'u 11. hane
    const sum2 = digits.slice(0, 10).reduce((acc, d) => acc + d, 0);
    if (sum2 % 10 !== digits[10]) {
      return { valid: false, error: message };
    }

    return { valid: true };
  };
}

/**
 * Vergi numarası kontrolü
 */
export function vergiNo(message: string = 'Geçerli bir vergi numarası giriniz'): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    // 10 haneli ve rakamlardan oluşmalı
    if (!/^[0-9]{10}$/.test(value)) {
      return { valid: false, error: message };
    }

    return { valid: true };
  };
}

/**
 * IBAN kontrolü (Türkiye formatı)
 */
export function iban(message: string = 'Geçerli bir IBAN giriniz'): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    // Boşlukları temizle ve büyük harfe çevir
    const cleaned = value.replace(/\s/g, '').toUpperCase();

    // TR ile başlamalı ve 26 karakter olmalı
    if (!/^TR[0-9]{24}$/.test(cleaned)) {
      return { valid: false, error: message };
    }

    return { valid: true };
  };
}

/**
 * Regex pattern kontrolü
 */
export function pattern(regex: RegExp, message: string): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (value && !regex.test(value)) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

// ============================================================================
// Şifre Doğrulayıcıları
// ============================================================================

/**
 * Güçlü şifre kontrolü
 */
export function strongPassword(message?: string): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (!value) return { valid: true };

    const errors: string[] = [];

    if (value.length < 8) {
      errors.push('en az 8 karakter');
    }
    if (!/[a-z]/.test(value)) {
      errors.push('küçük harf');
    }
    if (!/[A-Z]/.test(value)) {
      errors.push('büyük harf');
    }
    if (!/[0-9]/.test(value)) {
      errors.push('rakam');
    }
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) {
      errors.push('özel karakter');
    }

    if (errors.length > 0) {
      return {
        valid: false,
        error: message || `Şifre şunları içermelidir: ${errors.join(', ')}`,
      };
    }

    return { valid: true };
  };
}

/**
 * Şifre eşleşme kontrolü
 */
export function passwordMatch(
  password: string,
  message: string = 'Şifreler eşleşmiyor'
): ValidationRule<string> {
  return (value: string): ValidationResult => {
    if (value !== password) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

// ============================================================================
// Tarih Doğrulayıcıları
// ============================================================================

/**
 * Tarih kontrolü
 */
export function date(message: string = 'Geçerli bir tarih giriniz'): ValidationRule<string | Date> {
  return (value: string | Date): ValidationResult => {
    if (!value) return { valid: true };

    const dateObj = typeof value === 'string' ? new Date(value) : value;

    if (isNaN(dateObj.getTime())) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * Gelecek tarih kontrolü
 */
export function futureDate(message: string = 'Gelecekteki bir tarih seçiniz'): ValidationRule<string | Date> {
  return (value: string | Date): ValidationResult => {
    if (!value) return { valid: true };

    const dateObj = typeof value === 'string' ? new Date(value) : value;

    if (dateObj <= new Date()) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * Geçmiş tarih kontrolü
 */
export function pastDate(message: string = 'Geçmişteki bir tarih seçiniz'): ValidationRule<string | Date> {
  return (value: string | Date): ValidationResult => {
    if (!value) return { valid: true };

    const dateObj = typeof value === 'string' ? new Date(value) : value;

    if (dateObj >= new Date()) {
      return { valid: false, error: message };
    }
    return { valid: true };
  };
}

/**
 * Yaş kontrolü (minimum)
 */
export function minAge(age: number, message?: string): ValidationRule<string | Date> {
  return (value: string | Date): ValidationResult => {
    if (!value) return { valid: true };

    const birthDate = typeof value === 'string' ? new Date(value) : value;
    const today = new Date();

    let calculatedAge = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      calculatedAge--;
    }

    if (calculatedAge < age) {
      return {
        valid: false,
        error: message || `En az ${age} yaşında olmalısınız`,
      };
    }
    return { valid: true };
  };
}

// ============================================================================
// Özel Doğrulayıcılar
// ============================================================================

/**
 * Liste içinde olma kontrolü
 */
export function oneOf<T>(options: T[], message?: string): ValidationRule<T> {
  return (value: T): ValidationResult => {
    if (!options.includes(value)) {
      return {
        valid: false,
        error: message || `Geçerli bir seçenek seçiniz`,
      };
    }
    return { valid: true };
  };
}

/**
 * Eşit olma kontrolü
 */
export function equals<T>(expected: T, message?: string): ValidationRule<T> {
  return (value: T): ValidationResult => {
    if (value !== expected) {
      return {
        valid: false,
        error: message || `Beklenen değerle eşleşmiyor`,
      };
    }
    return { valid: true };
  };
}

/**
 * Koşullu doğrulama
 */
export function when<T>(
  condition: boolean | (() => boolean),
  rules: ValidationRule<T>[]
): ValidationRule<T> {
  return (value: T): ValidationResult => {
    const shouldValidate = typeof condition === 'function' ? condition() : condition;

    if (!shouldValidate) {
      return { valid: true };
    }

    for (const rule of rules) {
      const result = rule(value);
      if (!result.valid) {
        return result;
      }
    }

    return { valid: true };
  };
}

// ============================================================================
// Şema Doğrulama
// ============================================================================

/**
 * Tek alan doğrulama
 */
export function validateField<T>(value: T, rules: ValidationRule<T>[]): ValidationResult {
  for (const rule of rules) {
    const result = rule(value);
    if (!result.valid) {
      return result;
    }
  }
  return { valid: true };
}

/**
 * Şema doğrulama
 *
 * @example
 * const schema = {
 *   email: [required(), email()],
 *   password: [required(), strongPassword()],
 * };
 *
 * const errors = validateSchema(formData, schema);
 */
export function validateSchema<T extends Record<string, unknown>>(
  data: T,
  schema: ValidationSchema<T>
): ValidationErrors<T> {
  const errors: ValidationErrors<T> = {};

  for (const [field, rules] of Object.entries(schema)) {
    if (!rules) continue;

    const value = data[field as keyof T];
    const result = validateField(value, rules as ValidationRule<unknown>[]);

    if (!result.valid && result.error) {
      errors[field as keyof T] = result.error;
    }
  }

  return errors;
}

/**
 * Hata olup olmadığını kontrol et
 */
export function hasErrors<T>(errors: ValidationErrors<T>): boolean {
  return Object.keys(errors).length > 0;
}

// ============================================================================
// Yardımcı Fonksiyonlar
// ============================================================================

/**
 * Değeri temizle (trim, normalize)
 */
export function sanitize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * HTML etiketlerini temizle
 */
export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

/**
 * Sadece rakam al
 */
export function onlyDigits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/**
 * Sadece harf al (Türkçe karakterler dahil)
 */
export function onlyLetters(value: string): string {
  return value.replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ]/g, '');
}

/**
 * Alfanumerik karakterler al
 */
export function alphanumeric(value: string): string {
  return value.replace(/[^a-zA-Z0-9çÇğĞıİöÖşŞüÜ]/g, '');
}
