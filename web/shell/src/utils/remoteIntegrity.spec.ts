import { describe, expect, it } from 'vitest';

import { remoteIntegrityPolicy } from './remoteIntegrity';

describe('remote integrity guard', () => {
  it('classifies same-origin federation scripts as guarded', () => {
    expect(
      remoteIntegrityPolicy.isFederationScript('/remotes/admin-panel/remoteEntry.js'),
    ).toBe(true);
    expect(
      remoteIntegrityPolicy.isAllowedRemoteUrl('/remotes/admin-panel/remoteEntry.js'),
    ).toBe(true);
  });

  it('leaves non-federation scripts outside the remote guard', () => {
    expect(remoteIntegrityPolicy.isFederationScript('/assets/app.js')).toBe(false);
  });
});
