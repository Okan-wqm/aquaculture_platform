/**
 * useVfdCommand — the one place this client moves a machine.
 *
 * Three rules carry these tests, and all three are safety rules rather than UX
 * preferences:
 *
 *   1. OFFLINE MEANS NOTHING IS SENT AND NOTHING IS STORED. Not a queued command,
 *      not a retry, not a silent no-op. The network is never touched and the
 *      refusal says both halves out loud, because a worker who has watched
 *      mortality entries queue all shift will otherwise assume this queued too.
 *   2. A SERVER REFUSAL KEEPS ITS REASON. `assertActuable` declines an unbound,
 *      unattested or stale drive with a sentence that tells an operator what has
 *      to happen next; flattening that into "something went wrong" costs them the
 *      only actionable part.
 *   3. A ROLE THAT CANNOT COMMAND SEES NO BUTTONS. The floor mirrors the
 *      resolver's @Roles(TENANT_ADMIN, MODULE_MANAGER) through the same rank
 *      SSoT every other role-floored control uses.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OFFLINE_REFUSAL_MESSAGE, useVfdCommand } from '../useVfdCommand';

import type { Role } from '@/types';

const mockGraphqlRequest = vi.fn();
vi.mock('@/services/authenticated-fetch', () => ({
  graphqlRequest: (...args: unknown[]): unknown => mockGraphqlRequest(...args),
}));

let isOnline = true;
vi.mock('../useNetworkStatus', () => ({
  useNetworkStatus: (): boolean => isOnline,
}));

let role: Role | undefined = 'MODULE_MANAGER';
vi.mock('../useAuth', () => ({
  useAuth: (): { user: { role: Role } | null } =>
    role === undefined ? { user: null } : { user: { role } },
}));

beforeEach(() => {
  mockGraphqlRequest.mockReset();
  isOnline = true;
  role = 'MODULE_MANAGER';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useVfdCommand', () => {
  it('refuses offline WITHOUT touching the network, and says the command was not queued', async () => {
    isOnline = false;
    const { result } = renderHook(() => useVfdCommand('vfd-1'));

    let outcome;
    await act(async () => {
      outcome = await result.current.send('start');
    });

    // The whole safety property, asserted directly: no request was made, so
    // nothing could have been stored to replay later either.
    expect(mockGraphqlRequest).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'refused', message: OFFLINE_REFUSAL_MESSAGE });

    // …and it is VISIBLE rather than swallowed — the screen renders this.
    await waitFor(() => {
      expect(result.current.outcome?.status).toBe('refused');
    });
    expect(result.current.outcome?.message).toContain('never queued');
    expect(result.current.outcome?.message).toContain('Not sent');
  });

  it('carries a server refusal through with its reason intact', async () => {
    // What assertActuable raises for a drive whose binding was never confirmed.
    const serverReason =
      'VFD vfd-1 drives equipment eq-9, which the owning service has not confirmed (PENDING). Command refused.';
    mockGraphqlRequest.mockRejectedValueOnce(new Error(serverReason));

    const { result } = renderHook(() => useVfdCommand('vfd-1'));

    let outcome;
    await act(async () => {
      outcome = await result.current.send('stop');
    });

    expect(outcome).toEqual({ status: 'refused', message: `Not sent: ${serverReason}` });
    // The operator learns WHICH equipment and WHY — not "try again".
    expect(result.current.outcome?.message).toContain('has not confirmed');
  });

  it('reports a drive that took the command and one that did not, differently', async () => {
    mockGraphqlRequest.mockResolvedValueOnce({
      startVfd: {
        success: true,
        error: null,
        acknowledgedAt: '2026-08-07T10:00:00Z',
        commandSent: 'start',
      },
    });
    const { result } = renderHook(() => useVfdCommand('vfd-1'));

    await act(async () => {
      await result.current.send('start');
    });
    expect(result.current.outcome?.status).toBe('sent');

    // `success: false` is the OTHER failure: the command reached the gateway and
    // the drive declined it. It is not a refusal — something may have moved.
    mockGraphqlRequest.mockResolvedValueOnce({
      stopVfd: {
        success: false,
        error: 'Edge gateway timeout',
        acknowledgedAt: null,
        commandSent: 'stop',
      },
    });
    await act(async () => {
      await result.current.send('stop');
    });
    expect(result.current.outcome).toEqual({ status: 'failed', message: 'Edge gateway timeout' });
  });

  it('re-reads the drive after any command that could have changed it', async () => {
    const settled = vi.fn();
    mockGraphqlRequest.mockResolvedValueOnce({
      startVfd: { success: true, error: null, acknowledgedAt: null, commandSent: 'start' },
    });
    const { result } = renderHook(() => useVfdCommand('vfd-1', settled));

    await act(async () => {
      await result.current.send('start');
    });

    // The client never writes an optimistic "Running": only the drive can say
    // what the shaft is doing, so the screen asks it again.
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('mirrors the server role floor, and fails closed with no user', () => {
    const manager = renderHook(() => useVfdCommand('vfd-1'));
    expect(manager.result.current.canCommand).toBe(true);

    role = 'MODULE_USER';
    const user = renderHook(() => useVfdCommand('vfd-1'));
    expect(user.result.current.canCommand).toBe(false);

    role = undefined;
    const anonymous = renderHook(() => useVfdCommand('vfd-1'));
    expect(anonymous.result.current.canCommand).toBe(false);
  });
});
