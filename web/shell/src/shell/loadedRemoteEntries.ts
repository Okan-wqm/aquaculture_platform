/**
 * The federated remotes this tab has loaded, as the federation runtime loaded them
 * (FE-MEDIUM-380, PKG-42).
 *
 * WHY: a release can rebuild only a remote. The tab's copy of that remote then asks its container
 * for chunks the new build no longer has, and only the remote's own build id — exported by the
 * entry module the tab actually runs (federation/buildManifest.ts in shared-ui) — can tell the
 * build-skew check (buildSkew.ts) so.
 *
 * WHAT: a record, filled by remoteBuildRuntimePlugin.ts when the runtime has loaded an entry and
 * read by buildSkew.ts, of each remote's entry URL and the entry module itself. It keeps the
 * module untouched: buildSkew.ts reads the id out of it through the shared-ui contract.
 *
 * Imports NOTHING: the federation runtime imports this file through the runtime plugin while it
 * initialises, before any shared module (shared-ui, React) can load; an import of one here would
 * make the runtime's start wait on itself
 * (tests/invariants/federation-build-manifest-contract.spec.ts).
 */

/** One remote entry the runtime has loaded. */
export interface LoadedRemoteEntry {
  /** The remote's name in the shell's federation config. */
  readonly name: string;
  /** The entry URL the runtime loaded it from. */
  readonly entry: string;
  /** The loaded entry module (its namespace object). */
  readonly exports: unknown;
}

const loaded = new Map<string, LoadedRemoteEntry>();

/** Records an entry the runtime has loaded; a remote loads its entry once per page. */
export function recordLoadedRemoteEntry(entry: LoadedRemoteEntry): void {
  loaded.set(entry.name, entry);
}

/** Every remote entry this tab has loaded, in load order. */
export function loadedRemoteEntries(): readonly LoadedRemoteEntry[] {
  return [...loaded.values()];
}
