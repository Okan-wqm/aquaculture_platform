import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { WorkforceScopeProvider, useWorkforceScope } from '../WorkforceScopeContext';

describe('WorkforceScope', () => {
  it('is "no scope" (every module) where no provider is mounted', () => {
    const { result } = renderHook(() => useWorkforceScope());

    expect(result.current).toBeNull();
  });

  it('hands the provided module to every reader below it', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkforceScopeProvider moduleCode="HYDROPONICS">{children}</WorkforceScopeProvider>
    );

    const { result } = renderHook(() => useWorkforceScope(), { wrapper });

    expect(result.current).toBe('HYDROPONICS');
  });

  it('lets a workspace that spans modules provide no scope explicitly', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <WorkforceScopeProvider moduleCode={null}>{children}</WorkforceScopeProvider>
    );

    const { result } = renderHook(() => useWorkforceScope(), { wrapper });

    expect(result.current).toBeNull();
  });
});
