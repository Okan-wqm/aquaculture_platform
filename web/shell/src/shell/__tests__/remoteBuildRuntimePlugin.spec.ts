/**
 * The federation runtime tells the shell which remote builds the tab runs (FE-MEDIUM-380,
 * PKG-42): when the runtime has imported a remote's entry module, the plugin records the remote's
 * name, entry URL and the module, from which the build-skew check reads the remote's build id.
 * A failed load records nothing, so it can never stand for a build the tab runs.
 */
import { describe, expect, it } from 'vitest';

import { loadedRemoteEntries } from '../loadedRemoteEntries';
import remoteBuildRuntimePlugin, {
  REMOTE_BUILD_RUNTIME_PLUGIN,
  recordAfterLoadEntry,
} from '../remoteBuildRuntimePlugin';

describe('remoteBuildRuntimePlugin', () => {
  it('is a runtime plugin that records on afterLoadEntry, under its own name', () => {
    const plugin = remoteBuildRuntimePlugin();
    expect(plugin.name).toBe(REMOTE_BUILD_RUNTIME_PLUGIN);
    expect(plugin.afterLoadEntry).toBe(recordAfterLoadEntry);
  });

  it('records each remote entry the runtime loaded, with the module it loaded', () => {
    const farmEntry = Object.freeze({ aquaBuildId: 'a'.repeat(64) });
    recordAfterLoadEntry({
      remoteInfo: { name: 'farmModule', entry: '/remotes/farm-module/remoteEntry.js' },
      remoteEntryExports: farmEntry,
    });

    expect(loadedRemoteEntries()).toContainEqual({
      name: 'farmModule',
      entry: '/remotes/farm-module/remoteEntry.js',
      exports: farmEntry,
    });
  });

  it('records nothing for an entry that failed to load', () => {
    recordAfterLoadEntry({
      remoteInfo: { name: 'hrModule', entry: '/remotes/hr-module/remoteEntry.js' },
      remoteEntryExports: undefined,
    });

    expect(loadedRemoteEntries().map(({ name }) => name)).not.toContain('hrModule');
  });
});
