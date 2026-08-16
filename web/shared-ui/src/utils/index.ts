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
  publicGraphqlClient,
  restClient,
  setTokens,
  clearTokens,
  clearSession,
  loadTokensFromStorage,
  getAccessToken,
  setTenantId,
  getTenantId,
  graphQLOperationIdentity,
  onTenantChange,
  silentRefresh,
  GraphQLClientError,
  RestClientError,
} from './api-client';
export type {
  ApiConfig,
  GraphQLRequestOptions,
  GraphQLOperationIdentity,
  GraphQLErrorResponse,
} from './api-client';

// Token Lifecycle Manager
export { tokenLifecycle } from './token-lifecycle';
export type { TokenLifecycleManager, TokenState } from './token-lifecycle';
export {
  backendHealthCircuit,
  refetchWhenBackendHealthy,
} from './backend-health-circuit';

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
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  formatNumber,
  formatCurrency,
  formatCompactCurrency,
  parseMoney,
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

// Tenant-Scoped Query Keys (SECURITY: prevents cross-tenant cache leak)
// createTenantQueryKey -> full useQuery key (epoch'd); createTenantInvalidationKey
// -> epoch-less prefix for invalidateQueries/removeQueries (see the factory docs).
export {
  createTenantQueryKey,
  createTenantInvalidationKey,
  hasSameTenantSessionBoundary,
} from './tenant-query-keys';
// SessionSnapshot (A1) — SSoT read-model for "is there an authenticated tenant session".
export { getSessionSnapshot } from './session-snapshot';
export type { SessionSnapshot } from './session-snapshot';

// Logout Cleanup (SECURITY: FE-HIGH-005 — clears all browser storage layers)
export { logoutCleanup, registerLogoutCleanup } from './logout-cleanup';
export type { LogoutCleanupOptions } from './logout-cleanup';

// Visibility-Aware Token Refresh (SECURITY: FE-HIGH-006)
export { installVisibilityTokenRefresh, uninstallVisibilityTokenRefresh } from './visibility-token-refresh';

// URL Allowlist Validation (SECURITY: FE-HIGH-009 — prevents open redirect)
export { validateNavigationUrl } from './url-allowlist';

// HTML Sanitization (SECURITY: FE-HIGH-031 — prevents XSS via custom HTML)
export { sanitizeHtml } from './sanitize-html';

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

// Tenant-RBAC capability SSoT (panel access + resource-permission checks)
export {
  hasResourcePermission,
  hasTenantPanelAccess,
  TENANT_PANEL_CAPABILITIES,
} from './tenant-capabilities';
export type { CapabilityUser } from './tenant-capabilities';
