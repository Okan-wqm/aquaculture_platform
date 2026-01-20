/**
 * Utils Exports
 * Tüm utility fonksiyonlarının merkezi export noktası
 */

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function for merging Tailwind CSS classes
 * Combines clsx for conditional classes with tailwind-merge for deduplication
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// API İstemcileri
export {
  graphqlClient,
  restClient,
  setTokens,
  clearTokens,
  loadTokensFromStorage,
  getAccessToken,
  setTenantId,
  getTenantId,
  GraphQLClientError,
  RestClientError,
} from './api-client';
export type {
  ApiConfig,
  GraphQLRequestOptions,
  GraphQLErrorResponse,
} from './api-client';

// Tarih Yardımcıları
export {
  toDate,
  isValidDate,
  formatDate,
  formatTime,
  formatDateTime,
  toISOString,
  toISODateString,
  formatRelativeTime,
  getDaysFromNow,
  compareDates,
  isToday,
  isYesterday,
  isTomorrow,
  isPast,
  isFuture,
  isWithinRange,
  addDays,
  addWeeks,
  addMonths,
  addYears,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  getMonthName,
  getDayName,
  getDifference,
  getDateRange,
} from './date-utils';

// Format Yardımcıları
export {
  formatNumber,
  formatCurrency,
  formatPercent,
  formatFileSize,
  formatCompact,
  numberToWords,
  capitalize,
  titleCase,
  truncate,
  truncateWords,
  slugify,
  getInitials,
  pluralize,
  formatPhone,
  maskTcKimlik,
  formatIBAN,
  maskCreditCard,
  formatCoordinates,
  formatDistance,
  formatArea,
  formatTemperature,
  formatPH,
  formatDissolvedOxygen,
  formatSalinity,
  formatTurbidity,
  formatSensorValue,
} from './format';

// Doğrulama Yardımcıları
export {
  required,
  minLength,
  maxLength,
  lengthBetween,
  min,
  max,
  between,
  email,
  url,
  phone,
  tcKimlik,
  vergiNo,
  iban,
  pattern,
  strongPassword,
  passwordMatch,
  date,
  futureDate,
  pastDate,
  minAge,
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
} from './validation';
export type {
  ValidationResult,
  ValidationRule,
  ValidationSchema,
  ValidationErrors,
} from './validation';

// Specification Validation - Equipment type specification validation
export {
  validateSpecifications,
  isSpecificationValid,
  getDefaultSpecificationValues,
  cleanSpecificationValues,
} from './specificationValidation';
export type {
  SpecificationField as SpecValidationField,
  SpecificationSchema as SpecValidationSchema,
  SpecificationFieldOption as SpecValidationFieldOption,
} from './specificationValidation';
