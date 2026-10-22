import { WorkforceScopeProvider } from '@aquaculture/shared-ui';
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ModuleScopeBadge } from '../ModuleScopeBadge';

function inWorkspace(moduleCode: HrModuleCode | null): void {
  render(
    <WorkforceScopeProvider moduleCode={moduleCode}>
      <ModuleScopeBadge />
    </WorkforceScopeProvider>,
  );
}

describe('ModuleScopeBadge', () => {
  it('names the module of the workspace the reader is in', () => {
    inWorkspace('HYDROPONICS');

    expect(screen.getByText('Greenhouse')).toBeInTheDocument();
  });

  it('says every module when the workspace has no module', () => {
    inWorkspace(null);

    expect(screen.getByText('All modules')).toBeInTheDocument();
  });
});
