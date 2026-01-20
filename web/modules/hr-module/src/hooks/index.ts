/**
 * HR Module Hooks - Central Export
 */

// Core GraphQL client
export { useGraphQLClient, graphqlRequest } from './useGraphQL';

// Employee management hooks
export * from './useEmployees';

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
