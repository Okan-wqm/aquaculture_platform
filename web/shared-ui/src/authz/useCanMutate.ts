/**
 * useCanMutate(name)
 * ================================================================
 *
 * Returns `true` when the current user's role allows the named
 * mutation to run, per the generated canonical-contract projection.
 *
 *   const canEdit = useCanMutate('updateBatch');
 *   {canEdit && <Button>Düzenle</Button>}
 *
 * Rules:
 *   1. No authenticated user → always `false`.
 *   2. User role = `SUPER_ADMIN` → always `true` (matches backend
 *      god-mode short-circuit in the `@Roles(...)` guard).
 *   3. Otherwise look up `FRONTEND_MUTATION_ROLES[name]` and return
 *      whether the user's role is in the list.
 *
 * This hook is a pure function of the already-known user role plus
 * the static matrix — no GraphQL round-trip, no API client, no
 * re-render cascades. The matrix-to-backend parity is locked by
 * `codegen:farm-authorization:check` rejects a stale projection.
 */
import { useAuth } from '../hooks/useAuth';
import type { UserRole } from '../types';
import { FRONTEND_MUTATION_ROLES, type FrontendMutationName } from './permission-matrix';

export function useCanMutate(name: FrontendMutationName): boolean {
  const { user, isAuthenticated } = useAuth();

  if (!isAuthenticated || !user) return false;

  // SUPER_ADMIN short-circuit mirrors the backend guard — a super-
  // admin can run any mutation regardless of matrix entries.
  if (user.role === 'SUPER_ADMIN') return true;

  const allowedRoles: readonly UserRole[] = FRONTEND_MUTATION_ROLES[name] ?? [];

  return allowedRoles.includes(user.role);
}
