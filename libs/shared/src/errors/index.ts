/**
 * Standardized Error Handling Module
 *
 * This module provides a consistent error handling system across the platform:
 *
 * - ERROR_CODES: Predefined error codes with status and messages
 * - ApplicationException: Standard exception class using error codes
 * - ValidationException: Specialized exception for validation errors
 * - BusinessRuleException: Exception for business logic violations
 * - ExternalServiceException: Exception for external service failures
 * - GlobalExceptionFilter: Filter to transform all exceptions to standard format
 *
 * Usage:
 * ```typescript
 * // Throw a standard exception
 * throw new ApplicationException('USER_NOT_FOUND', { userId: '123' });
 *
 * // Throw a validation exception
 * throw ValidationException.fromField('email', 'Invalid email format');
 *
 * // Throw a business rule exception
 * throw new BusinessRuleException('SUBSCRIPTION_CANCELLED');
 *
 * // Use the global filter in main.ts
 * app.useGlobalFilters(new GlobalExceptionFilter());
 * ```
 */

export * from './error-codes';
export * from './application-exception';
export * from './global-exception.filter';
