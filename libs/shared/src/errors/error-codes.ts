/**
 * Standardized Error Codes for the Aquaculture Platform
 *
 * Error code format: <DOMAIN>_<CATEGORY>_<SPECIFIC>
 * Example: AUTH_VALIDATION_INVALID_EMAIL
 *
 * Categories:
 * - VALIDATION: Input validation errors
 * - NOT_FOUND: Resource not found errors
 * - CONFLICT: Resource conflict errors
 * - AUTH: Authentication/Authorization errors
 * - BUSINESS: Business logic errors
 * - EXTERNAL: External service errors
 * - INTERNAL: Internal system errors
 */

// ============================================================================
// Authentication & Authorization Errors (1000-1999)
// ============================================================================
export const AUTH_ERRORS = {
  // Authentication (1000-1099)
  AUTH_INVALID_CREDENTIALS: {
    code: 'AUTH_INVALID_CREDENTIALS',
    status: 401,
    message: 'Invalid email or password',
  },
  AUTH_TOKEN_EXPIRED: {
    code: 'AUTH_TOKEN_EXPIRED',
    status: 401,
    message: 'Authentication token has expired',
  },
  AUTH_TOKEN_INVALID: {
    code: 'AUTH_TOKEN_INVALID',
    status: 401,
    message: 'Authentication token is invalid',
  },
  AUTH_SESSION_EXPIRED: {
    code: 'AUTH_SESSION_EXPIRED',
    status: 401,
    message: 'Session has expired. Please log in again',
  },
  AUTH_MFA_REQUIRED: {
    code: 'AUTH_MFA_REQUIRED',
    status: 401,
    message: 'Multi-factor authentication is required',
  },
  AUTH_MFA_INVALID: {
    code: 'AUTH_MFA_INVALID',
    status: 401,
    message: 'Invalid multi-factor authentication code',
  },

  // Authorization (1100-1199)
  AUTH_FORBIDDEN: {
    code: 'AUTH_FORBIDDEN',
    status: 403,
    message: 'You do not have permission to perform this action',
  },
  AUTH_INSUFFICIENT_PERMISSIONS: {
    code: 'AUTH_INSUFFICIENT_PERMISSIONS',
    status: 403,
    message: 'Insufficient permissions for this operation',
  },
  AUTH_ROLE_REQUIRED: {
    code: 'AUTH_ROLE_REQUIRED',
    status: 403,
    message: 'Required role not assigned to user',
  },
  AUTH_TENANT_ACCESS_DENIED: {
    code: 'AUTH_TENANT_ACCESS_DENIED',
    status: 403,
    message: 'Access denied to this tenant',
  },
} as const;

// ============================================================================
// User Errors (2000-2999)
// ============================================================================
export const USER_ERRORS = {
  // Validation (2000-2099)
  USER_VALIDATION_INVALID_EMAIL: {
    code: 'USER_VALIDATION_INVALID_EMAIL',
    status: 400,
    message: 'Invalid email format',
  },
  USER_VALIDATION_WEAK_PASSWORD: {
    code: 'USER_VALIDATION_WEAK_PASSWORD',
    status: 400,
    message: 'Password does not meet security requirements',
  },
  USER_VALIDATION_INVALID_PHONE: {
    code: 'USER_VALIDATION_INVALID_PHONE',
    status: 400,
    message: 'Invalid phone number format',
  },

  // Not Found (2100-2199)
  USER_NOT_FOUND: {
    code: 'USER_NOT_FOUND',
    status: 404,
    message: 'User not found',
  },

  // Conflict (2200-2299)
  USER_EMAIL_EXISTS: {
    code: 'USER_EMAIL_EXISTS',
    status: 409,
    message: 'A user with this email already exists',
  },
  USER_USERNAME_EXISTS: {
    code: 'USER_USERNAME_EXISTS',
    status: 409,
    message: 'This username is already taken',
  },

  // Business Logic (2300-2399)
  USER_ACCOUNT_LOCKED: {
    code: 'USER_ACCOUNT_LOCKED',
    status: 403,
    message: 'User account has been locked',
  },
  USER_ACCOUNT_DISABLED: {
    code: 'USER_ACCOUNT_DISABLED',
    status: 403,
    message: 'User account has been disabled',
  },
  USER_EMAIL_NOT_VERIFIED: {
    code: 'USER_EMAIL_NOT_VERIFIED',
    status: 403,
    message: 'Email address has not been verified',
  },
} as const;

// ============================================================================
// Tenant Errors (3000-3999)
// ============================================================================
export const TENANT_ERRORS = {
  // Validation (3000-3099)
  TENANT_VALIDATION_INVALID_NAME: {
    code: 'TENANT_VALIDATION_INVALID_NAME',
    status: 400,
    message: 'Invalid tenant name',
  },
  TENANT_VALIDATION_INVALID_SLUG: {
    code: 'TENANT_VALIDATION_INVALID_SLUG',
    status: 400,
    message: 'Invalid tenant slug format',
  },

  // Not Found (3100-3199)
  TENANT_NOT_FOUND: {
    code: 'TENANT_NOT_FOUND',
    status: 404,
    message: 'Tenant not found',
  },

  // Conflict (3200-3299)
  TENANT_SLUG_EXISTS: {
    code: 'TENANT_SLUG_EXISTS',
    status: 409,
    message: 'A tenant with this slug already exists',
  },

  // Business Logic (3300-3399)
  TENANT_SUSPENDED: {
    code: 'TENANT_SUSPENDED',
    status: 403,
    message: 'Tenant account has been suspended',
  },
  TENANT_LIMIT_EXCEEDED: {
    code: 'TENANT_LIMIT_EXCEEDED',
    status: 403,
    message: 'Tenant resource limit has been exceeded',
  },
  TENANT_SUBSCRIPTION_REQUIRED: {
    code: 'TENANT_SUBSCRIPTION_REQUIRED',
    status: 403,
    message: 'Active subscription required for this operation',
  },
} as const;

// ============================================================================
// Subscription/Billing Errors (4000-4999)
// ============================================================================
export const BILLING_ERRORS = {
  // Validation (4000-4099)
  BILLING_INVALID_PLAN: {
    code: 'BILLING_INVALID_PLAN',
    status: 400,
    message: 'Invalid plan selected',
  },
  BILLING_INVALID_DISCOUNT_CODE: {
    code: 'BILLING_INVALID_DISCOUNT_CODE',
    status: 400,
    message: 'Invalid or expired discount code',
  },

  // Not Found (4100-4199)
  SUBSCRIPTION_NOT_FOUND: {
    code: 'SUBSCRIPTION_NOT_FOUND',
    status: 404,
    message: 'Subscription not found',
  },
  INVOICE_NOT_FOUND: {
    code: 'INVOICE_NOT_FOUND',
    status: 404,
    message: 'Invoice not found',
  },
  PLAN_NOT_FOUND: {
    code: 'PLAN_NOT_FOUND',
    status: 404,
    message: 'Plan not found',
  },

  // Conflict (4200-4299)
  SUBSCRIPTION_ALREADY_EXISTS: {
    code: 'SUBSCRIPTION_ALREADY_EXISTS',
    status: 409,
    message: 'Subscription already exists for this tenant',
  },

  // Business Logic (4300-4399)
  SUBSCRIPTION_CANCELLED: {
    code: 'SUBSCRIPTION_CANCELLED',
    status: 403,
    message: 'Subscription has been cancelled',
  },
  SUBSCRIPTION_EXPIRED: {
    code: 'SUBSCRIPTION_EXPIRED',
    status: 403,
    message: 'Subscription has expired',
  },
  SUBSCRIPTION_PAST_DUE: {
    code: 'SUBSCRIPTION_PAST_DUE',
    status: 403,
    message: 'Subscription payment is past due',
  },
  DOWNGRADE_NOT_ALLOWED: {
    code: 'DOWNGRADE_NOT_ALLOWED',
    status: 400,
    message: 'Cannot downgrade to a plan with lower limits than current usage',
  },

  // Payment (4400-4499)
  PAYMENT_FAILED: {
    code: 'PAYMENT_FAILED',
    status: 402,
    message: 'Payment processing failed',
  },
  PAYMENT_METHOD_REQUIRED: {
    code: 'PAYMENT_METHOD_REQUIRED',
    status: 402,
    message: 'Valid payment method is required',
  },
  PAYMENT_CARD_DECLINED: {
    code: 'PAYMENT_CARD_DECLINED',
    status: 402,
    message: 'Payment card was declined',
  },
} as const;

// ============================================================================
// Farm/Aquaculture Errors (5000-5999)
// ============================================================================
export const FARM_ERRORS = {
  // Not Found (5100-5199)
  FARM_NOT_FOUND: {
    code: 'FARM_NOT_FOUND',
    status: 404,
    message: 'Farm not found',
  },
  POND_NOT_FOUND: {
    code: 'POND_NOT_FOUND',
    status: 404,
    message: 'Pond not found',
  },
  TANK_NOT_FOUND: {
    code: 'TANK_NOT_FOUND',
    status: 404,
    message: 'Tank not found',
  },
  SPECIES_NOT_FOUND: {
    code: 'SPECIES_NOT_FOUND',
    status: 404,
    message: 'Species not found',
  },
  BATCH_NOT_FOUND: {
    code: 'BATCH_NOT_FOUND',
    status: 404,
    message: 'Batch not found',
  },

  // Business Logic (5300-5399)
  FARM_LIMIT_REACHED: {
    code: 'FARM_LIMIT_REACHED',
    status: 403,
    message: 'Maximum number of farms reached for your plan',
  },
  POND_LIMIT_REACHED: {
    code: 'POND_LIMIT_REACHED',
    status: 403,
    message: 'Maximum number of ponds reached for your plan',
  },
  BATCH_CLOSED: {
    code: 'BATCH_CLOSED',
    status: 400,
    message: 'Cannot modify a closed batch',
  },
} as const;

// ============================================================================
// Sensor/IoT Errors (6000-6999)
// ============================================================================
export const SENSOR_ERRORS = {
  // Not Found (6100-6199)
  SENSOR_NOT_FOUND: {
    code: 'SENSOR_NOT_FOUND',
    status: 404,
    message: 'Sensor not found',
  },
  DEVICE_NOT_FOUND: {
    code: 'DEVICE_NOT_FOUND',
    status: 404,
    message: 'Device not found',
  },

  // Business Logic (6300-6399)
  SENSOR_LIMIT_REACHED: {
    code: 'SENSOR_LIMIT_REACHED',
    status: 403,
    message: 'Maximum number of sensors reached for your plan',
  },
  SENSOR_OFFLINE: {
    code: 'SENSOR_OFFLINE',
    status: 503,
    message: 'Sensor is currently offline',
  },
  SENSOR_DATA_INVALID: {
    code: 'SENSOR_DATA_INVALID',
    status: 400,
    message: 'Invalid sensor data received',
  },
  DEVICE_NOT_REGISTERED: {
    code: 'DEVICE_NOT_REGISTERED',
    status: 400,
    message: 'Device is not registered',
  },
} as const;

// ============================================================================
// Validation Errors (7000-7999)
// ============================================================================
export const VALIDATION_ERRORS = {
  VALIDATION_FAILED: {
    code: 'VALIDATION_FAILED',
    status: 400,
    message: 'Validation failed',
  },
  REQUIRED_FIELD_MISSING: {
    code: 'REQUIRED_FIELD_MISSING',
    status: 400,
    message: 'Required field is missing',
  },
  INVALID_FORMAT: {
    code: 'INVALID_FORMAT',
    status: 400,
    message: 'Invalid data format',
  },
  INVALID_DATE_RANGE: {
    code: 'INVALID_DATE_RANGE',
    status: 400,
    message: 'Invalid date range specified',
  },
  VALUE_OUT_OF_RANGE: {
    code: 'VALUE_OUT_OF_RANGE',
    status: 400,
    message: 'Value is out of acceptable range',
  },
  INVALID_UUID: {
    code: 'INVALID_UUID',
    status: 400,
    message: 'Invalid UUID format',
  },
} as const;

// ============================================================================
// External Service Errors (8000-8999)
// ============================================================================
export const EXTERNAL_ERRORS = {
  EXTERNAL_SERVICE_UNAVAILABLE: {
    code: 'EXTERNAL_SERVICE_UNAVAILABLE',
    status: 503,
    message: 'External service is temporarily unavailable',
  },
  EXTERNAL_SERVICE_TIMEOUT: {
    code: 'EXTERNAL_SERVICE_TIMEOUT',
    status: 504,
    message: 'External service request timed out',
  },
  EMAIL_SERVICE_ERROR: {
    code: 'EMAIL_SERVICE_ERROR',
    status: 503,
    message: 'Email service encountered an error',
  },
  PAYMENT_GATEWAY_ERROR: {
    code: 'PAYMENT_GATEWAY_ERROR',
    status: 503,
    message: 'Payment gateway encountered an error',
  },
} as const;

// ============================================================================
// Internal Errors (9000-9999)
// ============================================================================
export const INTERNAL_ERRORS = {
  INTERNAL_SERVER_ERROR: {
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'An unexpected error occurred',
  },
  DATABASE_ERROR: {
    code: 'DATABASE_ERROR',
    status: 500,
    message: 'Database operation failed',
  },
  CONFIGURATION_ERROR: {
    code: 'CONFIGURATION_ERROR',
    status: 500,
    message: 'Service configuration error',
  },
} as const;

// ============================================================================
// Combined Error Codes
// ============================================================================
export const ERROR_CODES = {
  ...AUTH_ERRORS,
  ...USER_ERRORS,
  ...TENANT_ERRORS,
  ...BILLING_ERRORS,
  ...FARM_ERRORS,
  ...SENSOR_ERRORS,
  ...VALIDATION_ERRORS,
  ...EXTERNAL_ERRORS,
  ...INTERNAL_ERRORS,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export type ErrorDefinition = (typeof ERROR_CODES)[ErrorCode];
