/**
 * EmailTemplatesPage on the admin data layer (ADMIN-HIGH-121), and the toggle
 * that failed into the console (ADMIN-HIGH-130).
 *
 *     await settingsApi.updateEmailTemplate(template.id, { isActive: !template.isActive });
 *     setTemplates(templates.map((t) => t.id === template.id ? { ...t, isActive: !t.isActive } : t));
 *     // catch: console.error(...) and nothing else
 *
 * So an operator who disabled a template saw the row go inactive while the
 * server still had it enabled — and still sending that mail to customers. A
 * write that fails silently while the screen reports success is the worst
 * version of the stale-list class this migration exists to remove.
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import EmailTemplatesPage from '../EmailTemplatesPage';
import { settingsApi } from '../../services/adminApi';
import type { EmailTemplate } from '../../services/types';

vi.mock('../../services/adminApi', () => ({
  settingsApi: {
    getEmailTemplates: vi.fn(),
    updateEmailTemplate: vi.fn(),
    createEmailTemplate: vi.fn(),
  },
}));

const listMock = vi.mocked(settingsApi.getEmailTemplates);
const updateMock = vi.mocked(settingsApi.updateEmailTemplate);

function template(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: 'template-1',
    code: 'invoice_overdue',
    name: 'Invoice overdue reminder',
    category: 'billing',
    subject: 'Your invoice is overdue',
    bodyHtml: '<p>Hello {{name}}</p>',
    variables: [{ name: 'name', description: 'Recipient', defaultValue: 'there' }],
    isActive: true,
    isSystem: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides,
  } as EmailTemplate;
}

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EmailTemplatesPage />
    </QueryClientProvider>,
  );
}

describe('EmailTemplatesPage on the admin data layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([template()]);
    updateMock.mockResolvedValue(template({ isActive: false }));
  });

  it('forwards the abort signal to the read', async () => {
    renderPage();

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it('re-reads the list after a toggle rather than flipping the row locally', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Invoice overdue reminder');
    await user.click(screen.getByRole('button', { name: /Deactivate|Disable/i }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('template-1', { isActive: false }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('reports a refused toggle instead of swallowing it into the console', async () => {
    const user = userEvent.setup();
    updateMock.mockRejectedValue(new Error('template service unavailable'));
    renderPage();

    await screen.findByText('Invoice overdue reminder');
    await user.click(screen.getByRole('button', { name: /Deactivate|Disable/i }));

    // The regression: the row showed "inactive" while the server kept sending
    // the mail, and the only trace was a console line.
    expect(await screen.findByRole('alert')).toHaveTextContent('template service unavailable');
  });

  it('reports a failed read instead of an empty template list', async () => {
    listMock.mockRejectedValue(new Error('email templates unavailable'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('email templates unavailable');
  });
});
