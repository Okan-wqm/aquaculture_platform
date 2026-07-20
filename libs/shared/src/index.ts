/**
 * @platform/shared — Public API
 *
 * Cross-cutting error handling and Swagger documentation helpers.
 * Import from this barrel instead of from sub-paths.
 */
export * from './errors/error-codes';
export * from './errors/error-envelope';
export * from './errors/application-exception';
export * from './errors/global-exception.filter';
export * from './decorators/api-response.decorators';
