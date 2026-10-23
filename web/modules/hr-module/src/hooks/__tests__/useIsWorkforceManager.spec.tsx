/**
 * useIsWorkforceManager — the one answer to "may this reader hire, edit and run payroll?"
 */
import type { UserRole } from '@aquaculture/shared-ui';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useIsWorkforceManager } from '../useIsWorkforceManager';

const session = vi.hoisted(() => ({ user: null as { role: UserRole } | null }));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return { ...actual, useAuth: () => ({ user: session.user }) };
});

describe('useIsWorkforceManager', () => {
  beforeEach(() => {
    session.user = null;
  });

  it.each<UserRole>(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'])('is true for %s', (role) => {
    session.user = { role };

    expect(renderHook(() => useIsWorkforceManager()).result.current).toBe(true);
  });

  it('is false for an ordinary module user', () => {
    session.user = { role: 'MODULE_USER' };

    expect(renderHook(() => useIsWorkforceManager()).result.current).toBe(false);
  });

  it('is false with no signed-in user', () => {
    expect(renderHook(() => useIsWorkforceManager()).result.current).toBe(false);
  });
});
