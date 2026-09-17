/**
 * A1 regression (Plan 2): the AUTH handshake must actually set the operator
 * role. The backend emits { status: 'authenticated', userId, tenantId, role }
 * with role being the raw JWT Role enum value (SUPER_ADMIN / TENANT_ADMIN /
 * MODULE_MANAGER / MODULE_USER) — NOT an `authenticated: boolean` flag and
 * NOT lowercase HmiRole words. Both halves regressed before: the handler
 * gated on a nonexistent field and the mapper missed underscore roles.
 *
 * Drives the REAL OperatorBootstrap listener registration through a mocked
 * socket service, then fires the AUTH event with the exact wire shape.
 */

import React, { type ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { ScadaSocketEvent, type HmiRole } from '../../../types/scada-runtime.types';
import { useScadaPackageStore } from '../../../store/scada/createScadaStore';

// ── Mock the socket service module BEFORE importing the component ──────────
type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();
const serviceMock = {
  connect: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  on: vi.fn((event: string, cb: Handler) => handlers.set(event, cb)),
  off: vi.fn((event: string) => handlers.delete(event)),
};
vi.mock('../../../services/ScadaSocketService', () => ({
  getScadaSocketService: () => serviceMock,
}));

import { OperatorBootstrap } from '../OperatorBootstrap';

function fire(event: string, payload: unknown): void {
  handlers.get(event)?.(payload);
}

describe('A1 AUTH role wiring (server-authoritative role)', () => {
  beforeEach(() => {
    useScadaPackageStore.getState().reset();
    handlers.clear();
    serviceMock.connect.mockClear();
    serviceMock.acquire.mockClear();
    serviceMock.release.mockClear();
  });

  function boot(): void {
    render(
      <OperatorBootstrap packageId="pkg-a1" dataProviderType="live">
        <div>operator-tree</div>
      </OperatorBootstrap>,
    );
  }

  it.each<[string, HmiRole]>([
    ['TENANT_ADMIN', 'admin'],
    ['SUPER_ADMIN', 'admin'],
    ['MODULE_MANAGER', 'supervisor'],
    ['MODULE_USER', 'operator'],
    ['operator', 'operator'], // HmiRole passthrough
    ['some-future-role', 'viewer'], // unknown → least privilege
  ])('AUTH wire payload with role=%s sets currentUserRole=%s', async (wireRole, expected) => {
    boot();
    await waitFor(() => expect(handlers.has(ScadaSocketEvent.AUTH)).toBe(true));

    // Exact wire shape from scada-runtime.gateway handleConnection.
    fire(ScadaSocketEvent.AUTH, {
      status: 'authenticated',
      userId: 'u-1',
      tenantId: 't-1',
      role: wireRole,
    });

    expect(useScadaPackageStore.getState().currentUserRole).toBe(expected);
  });

  it('the OLD buggy payload shape (authenticated flag) is inert — role untouched', async () => {
    useScadaPackageStore.getState().setCurrentUserRole('viewer');
    boot();
    await waitFor(() => expect(handlers.has(ScadaSocketEvent.AUTH)).toBe(true));

    fire(ScadaSocketEvent.AUTH, { authenticated: true, role: 'TENANT_ADMIN' });

    expect(useScadaPackageStore.getState().currentUserRole).toBe('viewer');
  });

  it('AUTH without authenticated status never touches the role', async () => {
    useScadaPackageStore.getState().setCurrentUserRole('operator');
    boot();
    await waitFor(() => expect(handlers.has(ScadaSocketEvent.AUTH)).toBe(true));

    fire(ScadaSocketEvent.AUTH, { status: 'denied', role: 'TENANT_ADMIN' });

    expect(useScadaPackageStore.getState().currentUserRole).toBe('operator');
  });
});
