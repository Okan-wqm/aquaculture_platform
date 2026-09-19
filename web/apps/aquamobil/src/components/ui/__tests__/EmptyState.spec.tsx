/**
 * EmptyState / ErrorState (FE-MEDIUM-091) — an empty list and a failed load
 * are different things: the error block is an alert and offers a retry.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { Fish } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

import { EmptyState, ErrorState } from '../EmptyState';

afterEach(cleanup);

describe('EmptyState', () => {
  it('renders the title, description and action', () => {
    render(
      <EmptyState
        icon={Fish}
        title="No tanks found"
        description="Offline"
        action={<button type="button">Add</button>}
      />,
    );
    expect(screen.getByText('No tanks found')).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('is an alert with a Retry button that calls back', () => {
    const onRetry = vi.fn();
    render(
      <ErrorState title="Tanks could not be loaded" description="Try again" onRetry={onRetry} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tanks could not be loaded');
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows no Retry button without a handler and is busy while retrying', () => {
    const { rerender } = render(<ErrorState />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<ErrorState onRetry={() => undefined} retrying />);
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveAttribute('aria-busy', 'true');
  });
});
