import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: null as string | null,
  tenantId: null as string | null,
  epoch: 0,
  state: 'INITIALIZING' as string,
}));
vi.mock('./api-client', () => ({
  getAccessToken: () => mocks.token,
  getTenantId: () => mocks.tenantId,
}));
vi.mock('./session-epoch', () => ({ getSessionEpoch: () => mocks.epoch }));
vi.mock('./token-lifecycle', () => ({ tokenLifecycle: { getState: () => mocks.state } }));

import { getSessionSnapshot } from './session-snapshot';

describe('getSessionSnapshot', () => {
  beforeEach(() => {
    mocks.token = null;
    mocks.tenantId = null;
    mocks.epoch = 0;
    mocks.state = 'INITIALIZING';
  });

  it('ready is false unless BOTH a token and a tenant are present', () => {
    expect(getSessionSnapshot().ready).toBe(false);

    mocks.token = 'tok';
    expect(getSessionSnapshot().ready).toBe(false); // tenant missing

    mocks.token = null;
    mocks.tenantId = 'tenant-A';
    expect(getSessionSnapshot().ready).toBe(false); // token missing
  });

  it('composes all fields fresh; ready is true with token + tenant', () => {
    mocks.token = 'tok';
    mocks.tenantId = 'tenant-A';
    mocks.epoch = 3;
    mocks.state = 'READY';
    expect(getSessionSnapshot()).toEqual({
      accessToken: 'tok',
      effectiveTenantId: 'tenant-A',
      sessionEpoch: 3,
      tokenState: 'READY',
      ready: true,
    });
  });

  it('is a read-model — reflects a later authority change on the next call', () => {
    mocks.token = 'tok';
    mocks.tenantId = 'tenant-A';
    expect(getSessionSnapshot().ready).toBe(true);

    mocks.tenantId = null; // tenant cleared by some authority
    expect(getSessionSnapshot().ready).toBe(false);
  });
});
