/**
 * The federation runtime plugin that tells the shell which remote builds this tab runs
 * (FE-MEDIUM-380, PKG-42).
 *
 * WHY: every remote is loaded by the federation runtime, whoever imports it (App's lazy routes,
 * routePreload), and only the runtime holds the entry module it loaded. A wrapper around each
 * import would miss the next one written without it; a runtime plugin sees every load.
 *
 * WHAT: web/shell/vite.config.ts lists this file in `runtimePlugins`; @module-federation/vite
 * imports it into the host's runtime init and calls the default export. On `afterLoadEntry` — the
 * runtime has imported a remote's entry module — it records the remote's name, entry URL and the
 * module (loadedRemoteEntries.ts). A failed load records nothing.
 *
 * Imports only types and loadedRemoteEntries.ts, which imports nothing: the runtime imports this
 * file while it initialises, before any shared module can load
 * (tests/invariants/federation-build-manifest-contract.spec.ts).
 */
import type { ModuleFederationRuntimePlugin } from '@module-federation/runtime';

import { recordLoadedRemoteEntry } from './loadedRemoteEntries';

/** The plugin's name among the runtime's plugins. */
export const REMOTE_BUILD_RUNTIME_PLUGIN = 'aquaculture:remote-build-ids';

/** What the runtime's `afterLoadEntry` hands a plugin, as far as this plugin reads it. */
export interface LoadedEntryEvent {
  readonly remoteInfo: { readonly name: string; readonly entry: string };
  /** The loaded entry module; absent when the load failed. */
  readonly remoteEntryExports?: unknown;
}

/** The plugin's `afterLoadEntry`: records the entry the runtime loaded; a failed load, nothing. */
export function recordAfterLoadEntry({ remoteInfo, remoteEntryExports }: LoadedEntryEvent): void {
  if (!remoteEntryExports) return;
  recordLoadedRemoteEntry({
    name: remoteInfo.name,
    entry: remoteInfo.entry,
    exports: remoteEntryExports,
  });
}

export default function remoteBuildRuntimePlugin(): ModuleFederationRuntimePlugin {
  return { name: REMOTE_BUILD_RUNTIME_PLUGIN, afterLoadEntry: recordAfterLoadEntry };
}
