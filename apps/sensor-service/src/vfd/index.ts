/**
 * VFD Module Public API
 *
 * This is the main entry point for the VFD (Variable Frequency Drive) module.
 * It provides comprehensive VFD device management for industrial automation.
 */

// Module
export { VfdModule } from './vfd.module';

// Entities
export * from './entities';

// Services
export * from './services';

// Resolvers
export * from './resolvers';

// Protocol configuration SSoT (classification, schema, defaults, validation)
export * from './protocol-config';

// Brand Configurations
export * from './brand-configs';
