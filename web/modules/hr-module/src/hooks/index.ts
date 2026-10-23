/**
 * HR Module Hooks - Central Export
 */

// Core GraphQL client
export { useGraphQLClient, graphqlRequest } from './useGraphQL';

// Employee management hooks
export * from './useEmployees';
export { useIsWorkforceManager } from './useIsWorkforceManager';

// Leave management hooks
export * from './useLeaves';

// Attendance management hooks
export * from './useAttendance';

// Certification & training hooks
export * from './useCertifications';

// Aquaculture-specific hooks (work areas, rotations, crew)
export * from './useAquaculture';

// Performance management hooks
export * from './usePerformance';

// Payroll management hooks
export * from './usePayroll';

// Scheduling hooks
export * from './useScheduling';

// Cross-service: farm-service site responsibility (Today page)
export * from './useSiteResponsibility';
