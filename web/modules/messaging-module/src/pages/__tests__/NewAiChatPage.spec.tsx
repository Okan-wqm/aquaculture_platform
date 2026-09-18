/**
 * NewAiChatPage specs (FE-MEDIUM-065) — the AI room creation flow renders the
 * SERVER-filtered persona list as given, gates creation on the dual consent
 * the bridge enforces, and creates the room with the chosen catalogue id
 * (omitted for the tenant default).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { routeGraphql } from '../../test-utils/mockGraphqlClient';
import { requestMock } from '../../test-utils/sharedUiMock';
import type { AiPersona } from '../../types/messaging';
import NewAiChatPage from '../NewAiChatPage';

const { session } = vi.hoisted(() => ({
  session: { hasPermission: (_permission: string): boolean => true },
}));

vi.mock('@aquaculture/shared-ui', async () =>
  (await import('../../test-utils/sharedUiMock')).createSharedUiMock({
    hasPermission: (permission) => session.hasPermission(permission),
  }),
);

const PERSONAS: AiPersona[] = [
  {
    id: null,
    name: 'General AI Assistant',
    description: 'Ask anything about your aquaculture operations',
    icon: 'bot',
    color: 'purple',
    capabilities: ['General questions'],
  },
  {
    id: 'expert-farm-production-v1',
    name: 'Production Specialist (Expert)',
    description: 'Growth, FCR/SGR, feeding plans',
    icon: 'fish',
    color: 'blue',
    capabilities: ['Batch performance & growth', 'Finance summaries'],
  },
];

const NEW_CHANNEL_ID = 'dddddddd-4444-4555-8666-777777777777';

function route(aiSettings: { tenantAiEnabled: boolean; userAiConsent: boolean }): void {
  routeGraphql([
    { match: 'query AvailableAiPersonas', result: { availableAiPersonas: PERSONAS } },
    { match: 'query AiSettings', result: { aiSettings } },
    { match: 'mutation UpdateUserAiConsent', result: { updateUserAiConsent: true } },
    {
      match: 'mutation CreateAiChannel',
      result: (variables) => ({
        createChannel: {
          id: NEW_CHANNEL_ID,
          type: 'AI',
          name: (variables?.input as { name: string }).name,
        },
      }),
    },
  ]);
}

function renderPage(): void {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/messaging/new-ai']}>
        <Routes>
          <Route path="/messaging/new-ai" element={<NewAiChatPage />} />
          <Route path="/messaging/:channelId" element={<div>room {NEW_CHANNEL_ID}</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  requestMock.mockReset();
  session.hasPermission = () => true;
});

describe('NewAiChatPage', () => {
  it('renders the server-filtered personas verbatim and defaults to the tenant entry', async () => {
    route({ tenantAiEnabled: true, userAiConsent: true });
    renderPage();

    expect(await screen.findByRole('radio', { name: 'General AI Assistant' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Production Specialist (Expert)' })).not.toBeChecked();
    expect(screen.getByText('Batch performance & growth · Finance summaries')).toBeVisible();
  });

  it('keeps creation disabled until the user has consented, then creates with the chosen id', async () => {
    route({ tenantAiEnabled: true, userAiConsent: false });
    renderPage();

    const create = await screen.findByRole('button', { name: 'Start conversation' });
    await screen.findByRole('radio', { name: 'General AI Assistant' });
    expect(create).toBeDisabled();

    // Opt in — the switch sends the mutation and the settings are re-read.
    route({ tenantAiEnabled: true, userAiConsent: true });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('mutation UpdateUserAiConsent'),
        { consent: true },
      ),
    );
    await waitFor(() => expect(create).toBeEnabled());

    fireEvent.click(screen.getByRole('radio', { name: 'Production Specialist (Expert)' }));
    fireEvent.click(create);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('mutation CreateAiChannel'),
        {
          input: {
            type: 'AI',
            name: 'Production Specialist (Expert)',
            memberIds: [],
            aiPersona: 'expert-farm-production-v1',
          },
        },
      ),
    );
    expect(await screen.findByText(`room ${NEW_CHANNEL_ID}`)).toBeVisible();
  });

  it('omits aiPersona for the tenant-default entry', async () => {
    route({ tenantAiEnabled: true, userAiConsent: true });
    renderPage();

    const create = await screen.findByRole('button', { name: 'Start conversation' });
    await screen.findByRole('radio', { name: 'General AI Assistant' });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining('mutation CreateAiChannel'),
        {
          input: { type: 'AI', name: 'General AI Assistant', memberIds: [] },
        },
      ),
    );
  });

  it('without ai_assistant:use shows the no-access banner and fires no AI query', async () => {
    session.hasPermission = (permission) => permission !== 'ai_assistant:use';
    route({ tenantAiEnabled: true, userAiConsent: true });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have access to the AI assistant.',
    );
    expect(screen.queryByRole('button', { name: 'Start conversation' })).not.toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('blocks creation and explains when the tenant master switch is off', async () => {
    route({ tenantAiEnabled: false, userAiConsent: true });
    renderPage();

    expect(await screen.findByText(/AI is disabled for this workspace/)).toBeVisible();
    await screen.findByRole('radio', { name: 'General AI Assistant' });
    expect(screen.getByRole('button', { name: 'Start conversation' })).toBeDisabled();
  });
});
