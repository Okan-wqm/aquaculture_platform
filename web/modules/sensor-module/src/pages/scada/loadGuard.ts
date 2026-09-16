/**
 * ID-based load guard for ScadaPackageBuilderPage (critical data-loss fix).
 *
 * The page refetches packages as the route changes. Writing whatever arrived
 * into the store unconditionally let package B's fetch overwrite a dirty
 * in-progress edit of package A (or A's data land in B's editor when the
 * user navigated A → B faster than the fetch resolved). This helper makes
 * the load decision explicit and unit-testable:
 *
 *  - same package id + dirty store  → SKIP (never clobber unsaved edits)
 *  - different package id           → RESET first (fresh baseline + clear
 *                                     history), then load
 *  - same package id + clean store  → RELOAD (idempotent refresh)
 */

export type LoadGuardDecision = 'load' | 'reset-and-load' | 'skip';

export interface LoadGuardInput {
  /** Package id from the route (never 'new' — caller checks that already). */
  routePackageId: string;
  /** Id of the fetched entity (scadaPackage.id). */
  fetchedPackageId: string;
  /** packageId currently held by the store (may be null for a fresh store). */
  storePackageId: string | null;
  /** Whether the store has unsaved edits. */
  isDirty: boolean;
}

export function decidePackageLoad(input: LoadGuardInput): LoadGuardDecision {
  const { routePackageId, fetchedPackageId, storePackageId, isDirty } = input;

  // The fetch must belong to the route — a stale late response for a
  // different package must never be written.
  if (fetchedPackageId !== routePackageId) return 'skip';

  // Same package already in the store with unsaved edits: loading would
  // silently destroy the user's work.
  if (storePackageId === fetchedPackageId && isDirty) return 'skip';

  // Store holds a different package (A→B navigation, or /new → existing):
  // reset to a clean baseline before loading so A's screens/history can
  // never leak into B.
  if (storePackageId !== null && storePackageId !== fetchedPackageId) {
    return 'reset-and-load';
  }

  return 'load';
}

/**
 * Guard for the auto-add-screen effect: only auto-create "Screen 1" when the
 * empty store actually belongs to this route (fresh/new package). Without
 * this, the effect races a pending package load and injects a phantom
 * screen into a store that is about to be replaced.
 */
export function shouldAutoAddScreen(args: {
  storePackageId: string | null;
  routePackageId: string | null;
  isLoading: boolean;
}): boolean {
  if (args.isLoading) return false;
  // Fresh store (new package): auto-create is the intended bootstrap.
  if (args.storePackageId === null) return true;
  // Store already bound to an entity: only auto-create when it matches the
  // route — otherwise a load is pending and would clobber the phantom screen.
  if (args.routePackageId === null || args.routePackageId === 'new') return true;
  return args.storePackageId === args.routePackageId;
}
