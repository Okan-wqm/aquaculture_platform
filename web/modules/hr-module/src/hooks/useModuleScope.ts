/**
 * useModuleScope — the one place an HR query learns which module it is about.
 *
 * Every module-aware HR hook calls this and puts the result into BOTH its
 * request filter and its query key, so the scoping rule has a single
 * definition and two workspaces can never share a cache entry.
 *
 * An explicit module (a Company reader narrowing to one module) wins; else the
 * workspace's scope (`useWorkforceScope`); else `undefined` — everyone.
 *
 * The key carries `{ moduleCode }` even when it is `undefined` (Company), so a
 * Company read and a module read are different entries. Invalidation is by
 * domain prefix and is unaffected; nothing may seed or read an exact key without
 * the scope part.
 */
import { useWorkforceScope } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';

export function useModuleScope(explicit?: HrModuleCode): HrModuleCode | undefined {
  const workspaceScope = useWorkforceScope();
  return explicit ?? workspaceScope ?? undefined;
}
