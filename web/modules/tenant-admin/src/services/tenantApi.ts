/**
 * Tenant Admin REST API (DEPRECATED)
 *
 * This file previously contained REST API clients for:
 * - messagingApi  (threads, messages)
 * - ticketsApi    (support tickets, comments)
 * - announcementsApi (platform announcements)
 *
 * All three have been migrated to GraphQL:
 * - Queries/mutations: src/graphql/communication-queries.ts
 * - Pages now use graphqlRequest() from tenant-api.service.ts
 *
 * This empty export keeps the barrel re-export in services/index.ts valid.
 * This file will be fully removed in the API layer consolidation (Task 4).
 */

// Intentional empty export to satisfy module system
export {};
