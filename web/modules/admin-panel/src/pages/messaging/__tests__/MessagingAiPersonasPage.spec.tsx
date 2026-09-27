/**
 * MessagingAiPersonasPage — the inventory renders what `getPersonas` returns
 * (the shared catalogue, AISAFETY-MEDIUM-024) and derives each row's tier /
 * specialty from the persona id grammar (FE-MEDIUM-065).
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessagingAiPersonasPage from '../MessagingAiPersonasPage';
import { messagingApi } from '../../../services/adminApi';
import type { AiPersonaDefinition } from '../../../services/api/messaging';

vi.mock('../../../services/adminApi', () => ({
  messagingApi: {
    getPersonas: vi.fn(),
    updatePersona: vi.fn(),
  },
}));

const PERSONAS: AiPersonaDefinition[] = [
  {
    id: 'expert-v1',
    name: 'Aquaculture Expert (General)',
    description: 'Advanced water chemistry',
    icon: 'fish',
    color: 'blue',
    capabilities: ['Growth analytics'],
  },
  {
    id: 'manager-farm-operations-v1',
    name: 'Farm Operations Specialist (Manager)',
    description: "Today's tasks, overdue work orders",
    icon: 'wrench',
    color: 'orange',
    capabilities: ['Tasks & work orders', 'Maintenance alerts'],
  },
];

describe('MessagingAiPersonasPage', () => {
  beforeEach(() => {
    vi.mocked(messagingApi.getPersonas).mockResolvedValue(PERSONAS);
  });

  it('lists the catalogue inventory with a tier / specialty column derived from the id', async () => {
    render(
      <BrowserRouter>
        <MessagingAiPersonasPage />
      </BrowserRouter>,
    );

    await userEvent.type(
      screen.getByLabelText(/tenant id/i),
      '550e8400-e29b-41d4-a716-446655440000',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Load Personas' }));

    await waitFor(() =>
      expect(screen.getByText('Farm Operations Specialist (Manager)')).toBeVisible(),
    );
    expect(messagingApi.getPersonas).toHaveBeenCalledWith('550e8400-e29b-41d4-a716-446655440000');

    // The page also renders the LIFE-SAFETY limits reference table, so rows
    // are addressed by their persona name rather than by position.
    const rowOf = (name: string): HTMLElement => {
      const row = screen.getByText(name).closest('tr');
      if (!row) throw new Error(`no row for ${name}`);
      return row;
    };
    expect(rowOf('Aquaculture Expert (General)')).toHaveTextContent('Expert');
    expect(rowOf('Aquaculture Expert (General)')).toHaveTextContent('general');
    expect(rowOf('Farm Operations Specialist (Manager)')).toHaveTextContent('Manager');
    expect(rowOf('Farm Operations Specialist (Manager)')).toHaveTextContent('farm-operations');
  });
});
