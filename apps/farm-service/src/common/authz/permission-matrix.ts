/**
 * Backend projection of the browser-safe farm operation authorization contract.
 * The contract is generated from resolver decorators with the TypeScript AST;
 * this module contains no independently maintained role lists.
 */
import {
  FARM_MUTATION_AUTHORIZATION,
  FARM_QUERY_AUTHORIZATION,
} from '@platform/event-contracts';
import type { Role } from '@platform/identity';

export const MUTATION_ROLES = FARM_MUTATION_AUTHORIZATION;
export const QUERY_ROLES = FARM_QUERY_AUTHORIZATION;

export function resolveAllowedRoles(operation: string): readonly Role[] | undefined {
  const mutation = Object.entries(MUTATION_ROLES).find(([name]) => name === operation);
  if (mutation !== undefined) return mutation[1];
  return Object.entries(QUERY_ROLES).find(([name]) => name === operation)?.[1];
}
