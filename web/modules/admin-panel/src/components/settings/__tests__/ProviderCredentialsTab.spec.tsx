/**
 * ProviderCredentialsTab (ADMIN-HIGH-135): the operator enters the CDSE
 * credential's fields, the tab sends exactly those fields to the typed
 * config-service mutation, and reads back status without ever holding the
 * stored value.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import { ProviderCredentialsTab } from '../ProviderCredentialsTab';
import {
  MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY,
  SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION,
} from '../../../graphql/marine-provider-credential-operations';

/**
 * A plain vi.fn() stands in for graphqlClient.request. The real signature is
 * generic in its response type; a route table keyed by operation text cannot
 * satisfy that generic without a cast, and casts are banned — so the double is
 * declared untyped and the assertions below pin what actually crossed it.
 */
const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock('@aquaculture/shared-ui', async () => {
  const actual =
    await vi.importActual<typeof import('@aquaculture/shared-ui')>('@aquaculture/shared-ui');
  return {
    ...actual,
    graphqlClient: { request: requestMock },
  };
});

interface StatusRow {
  provider: 'CDSE';
  configured: boolean;
  version: number | null;
  updatedAt: string | null;
}

const NOT_CONFIGURED: StatusRow = {
  provider: 'CDSE',
  configured: false,
  version: null,
  updatedAt: null,
};
const CONFIGURED: StatusRow = {
  provider: 'CDSE',
  configured: true,
  version: 3,
  updatedAt: '2026-09-18T10:00:00.000Z',
};

/**
 * Route each GraphQL call by its operation text: the status query resolves
 * from `statuses` in call order (initial read, then the post-save refetch);
 * the mutation resolves with `saved`.
 */
function wireGraphql(statuses: StatusRow[], saved: StatusRow = CONFIGURED): void {
  const statusQueue = [...statuses];
  requestMock.mockImplementation(async (query: string) => {
    if (query === MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY) {
      const next = statusQueue.length > 1 ? statusQueue.shift() : statusQueue[0];
      return { marineProviderCredentialStatus: next };
    }
    if (query === SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION) {
      return { setMarineProviderCdseCredential: saved };
    }
    throw new Error(`unexpected operation: ${query}`);
  });
}

function renderTab(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProviderCredentialsTab />
    </QueryClientProvider>,
  );
}

interface MutationVariables {
  input: object;
}

function mutationCalls(): MutationVariables[] {
  const calls: unknown[][] = requestMock.mock.calls;
  return calls
    .filter(([query]) => query === SET_MARINE_PROVIDER_CDSE_CREDENTIAL_MUTATION)
    .map(([, variables]) => {
      if (typeof variables !== 'object' || variables === null || !('input' in variables)) {
        throw new Error('mutation call carried no input variables');
      }
      const { input } = variables;
      if (typeof input !== 'object' || input === null) {
        throw new Error('mutation input was not an object');
      }
      return { input };
    });
}

describe('ProviderCredentialsTab', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('reads the status through the typed query and shows "not stored" honestly', async () => {
    wireGraphql([NOT_CONFIGURED]);
    renderTab();

    expect(await screen.findByText('No credential stored')).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith(
      MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY,
      { provider: 'CDSE' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('button', { name: 'Save Credential' })).toBeDisabled();
  });

  it('shows the stored revision, never the value, and offers rotation', async () => {
    wireGraphql([CONFIGURED]);
    renderTab();

    expect(await screen.findByText('Credential stored')).toBeInTheDocument();
    expect(screen.getByTestId('cdse-status')).toHaveTextContent('revision 3');
    expect(screen.getByRole('button', { name: 'Rotate Credential' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Client Secret/)).toHaveValue('');
  });

  it('sends exactly the entered fields to the mutation and clears the form after saving', async () => {
    wireGraphql([NOT_CONFIGURED, CONFIGURED], { ...CONFIGURED, version: 1 });
    renderTab();
    await screen.findByText('No credential stored');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Client ID/), '  sh-client  ');
    await user.type(screen.getByLabelText(/Client Secret/), 's3cret');
    await user.click(screen.getByRole('button', { name: 'Save Credential' }));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    expect(mutationCalls()[0].input).toEqual({
      clientId: 'sh-client',
      clientSecret: 's3cret',
      reason: 'admin-panel provider credentials save',
    });
    expect(await screen.findByText('CDSE credential saved (revision 1)')).toBeInTheDocument();
    expect(screen.getByLabelText(/Client ID/)).toHaveValue('');
    expect(screen.getByLabelText(/Client Secret/)).toHaveValue('');
    // The post-save invalidation re-reads the status.
    expect(await screen.findByText('Credential stored')).toBeInTheDocument();
  });

  it('includes the instance id only when one is entered', async () => {
    wireGraphql([NOT_CONFIGURED, CONFIGURED]);
    renderTab();
    await screen.findByText('No credential stored');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Client ID/), 'sh-client');
    await user.type(screen.getByLabelText(/Client Secret/), 's3cret');
    await user.type(screen.getByLabelText(/Instance ID/), 'inst-42');
    await user.click(screen.getByRole('button', { name: 'Save Credential' }));

    await waitFor(() => expect(mutationCalls()).toHaveLength(1));
    expect(mutationCalls()[0].input).toMatchObject({ instanceId: 'inst-42' });
  });

  it('surfaces a refused write as the error and keeps the entered fields', async () => {
    wireGraphql([NOT_CONFIGURED]);
    renderTab();
    await screen.findByText('No credential stored');
    requestMock.mockImplementation(async (query: string) => {
      if (query === MARINE_PROVIDER_CREDENTIAL_STATUS_QUERY) {
        return { marineProviderCredentialStatus: NOT_CONFIGURED };
      }
      throw new Error('Provider credentials are managed only by tenantless SUPER_ADMIN operations');
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Client ID/), 'sh-client');
    await user.type(screen.getByLabelText(/Client Secret/), 's3cret');
    await user.click(screen.getByRole('button', { name: 'Save Credential' }));

    expect(
      await screen.findByText(
        'Provider credentials are managed only by tenantless SUPER_ADMIN operations',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Client ID/)).toHaveValue('sh-client');
  });
});
