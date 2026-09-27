/**
 * PageHeader is the band every AquaMobil page opens with (FE-MEDIUM-071):
 * the feature tone, the back arrow, the title and its icon, the right-hand
 * action, and the hub variant's glass box.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Bell } from 'lucide-react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PageHeader } from '../PageHeader';

function classes(element: Element | null): string[] {
  if (!element) throw new Error('element expected');
  return Array.from(element.classList);
}

describe('PageHeader', () => {
  afterEach(cleanup);

  it('renders the title as the page heading on the feature tone with a back arrow', () => {
    render(
      <MemoryRouter>
        <PageHeader tone="amber" icon={Bell} title="Notifications" subtitle="3 unread" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy();
    expect(screen.getByText('3 unread').tagName).toBe('P');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
    expect(classes(screen.getByRole('banner'))).toEqual(
      expect.arrayContaining(['bg-gradient-to-r', 'from-amber-600', 'to-amber-500']),
    );
  });

  it('runs the caller’s back handler instead of popping history', () => {
    const back = vi.fn();
    render(
      <MemoryRouter>
        <PageHeader title="Stock In" back={back} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('hides the arrow on a hub band and draws the glass box and the curve', () => {
    const { container } = render(
      <MemoryRouter>
        <PageHeader variant="hub" tone="teal" icon={Bell} title="Storage">
          <div data-testid="kpi">kpi</div>
        </PageHeader>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(classes(screen.getByRole('banner'))).toEqual(
      expect.arrayContaining(['bg-gradient-to-br', 'via-teal-600']),
    );
    expect(container.querySelector('svg path')).toBeTruthy();
    expect(screen.getByTestId('kpi')).toBeTruthy();
  });

  it('places actions on the title row and keeps the plain tone on a light surface', () => {
    render(
      <MemoryRouter>
        <PageHeader
          tone="plain"
          title="Channel Info"
          actions={<button type="button">Save</button>}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(classes(screen.getByRole('banner'))).toContain('bg-white');
  });
});
