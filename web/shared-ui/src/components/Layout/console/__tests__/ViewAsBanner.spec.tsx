/**
 * ViewAsBanner — the band at the top of the page while an admin previews the
 * console as another role (README §8, decision D19): it names the role, says
 * that changes still run with the admin's own role, and offers the way back.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../../i18n';
import { ViewAsBanner } from '../ViewAsBanner';

describe('ViewAsBanner', () => {
  it('announces the role being viewed as a status', () => {
    render(<ViewAsBanner roleLabel="Farm operator" onExit={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(within(status).getByText('Viewing as Farm operator')).toBeInTheDocument();
    expect(
      within(status).getByText(
        'The menu and pages follow this role; changes still run with your own.',
      ),
    ).toBeInTheDocument();
    expect(status.parentElement).toHaveClass('bg-sd-accent-100', 'border-sd-accent');
  });

  // Screen readers announce a change inside a live region that is already in
  // the document, not a region inserted with its content, so the first switch
  // into a role view was usually silent. The region is mounted, empty, while
  // the user's own role shows, and the same node takes the message.
  it('keeps an empty status mounted in the user’s own view and fills that same node on a switch', () => {
    const { rerender } = render(<ViewAsBanner roleLabel={null} onExit={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    expect(status.parentElement).not.toHaveClass('bg-sd-accent-100');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<ViewAsBanner roleLabel="Farm operator" onExit={vi.fn()} />);
    expect(screen.getByRole('status')).toBe(status);
    expect(status).toHaveTextContent('Viewing as Farm operator');
  });

  it('keeps the exit button out of the announcement', () => {
    render(<ViewAsBanner roleLabel="Farm operator" onExit={vi.fn()} />);
    const exit = screen.getByRole('button', { name: 'Exit role view' });
    expect(screen.getByRole('status')).not.toContainElement(exit);
  });

  it('exits the role view', async () => {
    const onExit = vi.fn();
    render(<ViewAsBanner roleLabel="Farm operator" onExit={onExit} />);
    await userEvent.click(screen.getByRole('button', { name: 'Exit role view' }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('speaks Turkish under the Turkish locale', () => {
    render(
      <I18nProvider locale="tr">
        <ViewAsBanner roleLabel="Çiftlik operatörü" onExit={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText('Çiftlik operatörü rolüyle görüntülüyorsunuz')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rol görünümünden çık' })).toBeInTheDocument();
  });
});
