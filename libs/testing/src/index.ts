/**
 * IP-3: Shared test utilities for the aquaculture platform.
 *
 * Centralizes mock factories that were duplicated across 15+ service test files.
 * Import from '@aquaculture/testing' in any service's test files.
 */
export * from './factories/mock-datasource.factory';
export * from './factories/mock-repository.factory';
export * from './factories/mock-event-bus.factory';
export * from './doubles/typed-double';
export * from './constants';
