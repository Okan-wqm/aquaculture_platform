/**
 * The LIFE-SAFETY page that said hardcoded documentation was the tenant's live
 * PLC actuation policy (ADMIN-CRITICAL-154).
 *
 * Its own docblock stated the rule it broke — "It MUST show real backend
 * state, not hardcoded defaults" — and its red banner told the operator that
 * "the actuation policy and autonomous safety limits shown below are loaded
 * from the real backend TenantAgentConfig entity" and were "not display-only
 * values".
 *
 * Nothing on the page was ever loaded from `TenantAgentConfig`. The two
 * sections headed "(from TenantAgentConfig)" were a static glossary typed into
 * the file, `GET /messaging/personas` carries no policy or limits, and
 * admin-api has no route, no NATS call and no reference to that entity.
 *
 * These tests pin the fix in the only place it can be pinned: the page must
 * not claim to display a policy it cannot read, and must say so where an
 * operator looks for the answer.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import MessagingAiPersonasPage from '../MessagingAiPersonasPage';
import { messagingApi } from '../../../services/api/messaging';
import { tenantsApi } from '../../../services/adminApi';
import type { AiPersonaDefinition } from '../../../services/api/messaging';

vi.mock('../../../services/api/messaging', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/messaging')>(
    '../../../services/api/messaging',
  );
  return { ...actual, messagingApi: { getPersonas: vi.fn() } };
});

vi.mock('../../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof import('../../../services/adminApi')>(
    '../../../services/adminApi',
  );
  return { ...actual, tenantsApi: { list: vi.fn() } };
});

const personas = vi.mocked(messagingApi.getPersonas);
const tenantList = vi.mocked(tenantsApi.list);

const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Complete, as the contract declares it — `id` nullable, no `isActive`. */
function persona(overrides: Partial<AiPersonaDefinition> = {}): AiPersonaDefinition {
  return {
    id: 'scada-supervisor',
    name: 'SCADA Supervisor',
    description: 'Watches process values and proposes setpoint changes.',
    icon: 'Cpu',
    color: 'orange',
    capabilities: ['read sensors', 'propose setpoints', 'raise alarms', 'summarise shifts'],
    ...overrides,
  };
}

function tenantPage(): Awaited<ReturnType<typeof tenantsApi.list>> {
  return {
    data: [
      {
        id: TENANT_ID,
        name: 'Kuzey Su',
        slug: 'kuzey-su',
        status: 'active',
        tier: 'enterprise',
        userCount: 24,
        farmCount: 3,
        sensorCount: 48,
        isTrialActive: false,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    limit: 500,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessagingAiPersonasPage />
    </QueryClientProvider>,
  );
}

async function renderAndSelectTenant(): Promise<void> {
  renderPage();
  const actor = userEvent.setup();
  await actor.click(await screen.findByRole('button', { name: /Select a tenant/ }));
  await actor.click(await screen.findByRole('button', { name: /Kuzey Su enterprise/ }));
}

describe('MessagingAiPersonasPage life-safety honesty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    personas.mockResolvedValue([persona()]);
  });

  it('never claims the actuation policy shown is loaded from the backend', () => {
    renderPage();

    // The exact claim that made this CRITICAL.
    expect(
      screen.queryByText(/loaded from the real backend TenantAgentConfig entity/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/These are not display-only values/)).not.toBeInTheDocument();
  });

  it("says outright that it does not show a tenant's actuation policy", () => {
    renderPage();

    expect(
      screen.getByText(/this page does NOT show a tenant's actuation policy/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/admin-api cannot read that entity/)).toBeInTheDocument();
  });

  it('states the gap where an operator looks for the effective policy', () => {
    renderPage();

    expect(screen.getByText('Effective actuation policy for this tenant')).toBeInTheDocument();
    // Named in both the panel and the architecture note, so the operator meets
    // the tracked gap wherever they start reading.
    expect(screen.getAllByText(/tracked as ADMIN-HIGH-155/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/a default here reads as a policy/)).toBeInTheDocument();
  });

  it("labels the reference sections as documentation, not as this tenant's settings", () => {
    renderPage();

    expect(screen.getByText('What each actuation policy value means')).toBeInTheDocument();
    expect(
      screen.getByText('The fields that make up an autonomous safety limit'),
    ).toBeInTheDocument();
    // The old HEADINGS claimed provenance. Scoped to headings, because the
    // body copy is allowed to name the entity it is a glossary for.
    expect(
      screen.queryByRole('heading', { name: /from TenantAgentConfig/ }),
    ).not.toBeInTheDocument();
  });

  it('calls capability labels descriptive rather than permissive', async () => {
    await renderAndSelectTenant();

    expect(
      await screen.findByText('Capabilities (descriptive, not permissions)'),
    ).toBeInTheDocument();
  });
});

describe('MessagingAiPersonasPage reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantList.mockResolvedValue(tenantPage());
    personas.mockResolvedValue([persona()]);
  });

  it('reads nothing until a tenant is picked, and picks it rather than typing it', async () => {
    renderPage();

    await waitFor(() => expect(tenantList).toHaveBeenCalled());
    expect(personas).not.toHaveBeenCalled();
    expect(screen.queryByPlaceholderText(/550e8400/)).not.toBeInTheDocument();
  });

  it('sends the tenant id and an abort signal', async () => {
    await renderAndSelectTenant();

    await waitFor(() => expect(personas).toHaveBeenCalled());
    expect(personas.mock.calls[0]?.[0]).toBe(TENANT_ID);
    expect(personas.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('fills the Scope cell the table had a header but no cell for', async () => {
    await renderAndSelectTenant();

    const row = (await screen.findByText('SCADA Supervisor')).closest('tr');
    expect(row).not.toBeNull();
    // Four headers, four cells: this one was missing entirely.
    expect(row?.querySelectorAll('td')).toHaveLength(4);
    expect(row).toHaveTextContent('Platform persona');
  });

  it('marks the general assistant as applying to all tenants', async () => {
    personas.mockResolvedValue([persona({ id: null, name: 'General Assistant' })]);
    await renderAndSelectTenant();

    const row = (await screen.findByText('General Assistant')).closest('tr');
    expect(row).toHaveTextContent('All tenants');
    expect(row).toHaveTextContent('general');
  });

  it('names a failed read and draws no table', async () => {
    personas.mockRejectedValue(new Error('persona registry is unreachable'));
    await renderAndSelectTenant();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((el) => el.textContent?.includes('persona registry is unreachable'))).toBe(
      true,
    );
    expect(screen.queryByText('SCADA Supervisor')).not.toBeInTheDocument();
  });
});
