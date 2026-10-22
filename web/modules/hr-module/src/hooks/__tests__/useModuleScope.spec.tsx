import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { useModuleScope } from '../useModuleScope';

const inWorkspace =
  (moduleCode: HrModuleCode | null) =>
  ({ children }: { children: ReactNode }) => (
    <WorkforceScopeProvider moduleCode={moduleCode}>{children}</WorkforceScopeProvider>
  );

describe('useModuleScope', () => {
  it('is the workspace module when nothing narrower is asked for', () => {
    const { result } = renderHook(() => useModuleScope(), { wrapper: inWorkspace('FARM') });

    expect(result.current).toBe('FARM');
  });

  it('lets an explicit module win over the workspace', () => {
    const { result } = renderHook(() => useModuleScope('SENSOR'), { wrapper: inWorkspace(null) });

    expect(result.current).toBe('SENSOR');
  });

  it('is undefined — every module — in a workspace that spans modules', () => {
    const { result } = renderHook(() => useModuleScope(), { wrapper: inWorkspace(null) });

    expect(result.current).toBeUndefined();
  });
});
