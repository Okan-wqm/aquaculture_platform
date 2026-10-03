/**
 * PageHeader is the header every AquaMobil screen opens with (FE-MEDIUM-071):
 * the back arrow (or the brand mark on a top-level screen), the context line,
 * the title, the icon tile, the right-hand actions and the slot under the row.
 * v4 is flat and token-only — no feature-toned gradient band.
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

  it('renders the title as the page heading with its context line and a named back arrow', () => {
    render(
      <MemoryRouter>
        <PageHeader icon={Bell} title="Notifications" subtitle="3 unread" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy();
    expect(screen.getByText('3 unread')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
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

  it('leads a top-level screen with the brand mark instead of a back arrow', () => {
    const { container } = render(
      <MemoryRouter>
        <PageHeader title="Today" back={false} brand size="display" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(container.querySelector('img')).toBeTruthy();
    expect(classes(screen.getByRole('heading', { level: 1 }))).toContain('text-display');
  });

  it('places actions on the title row and the slot under it, on the token surface', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Storage" actions={<button type="button">Save</button>}>
          <div data-testid="kpi">kpi</div>
        </PageHeader>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.getByTestId('kpi')).toBeTruthy();
    const banner = classes(screen.getByRole('banner'));
    expect(banner.some((name) => name.startsWith('bg-gradient'))).toBe(false);
    expect(classes(screen.getByRole('heading', { level: 1 }))).toContain('text-ink-1');
  });
});
