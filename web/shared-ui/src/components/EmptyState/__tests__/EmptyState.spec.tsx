import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EmptyState, ErrorState } from '../EmptyState';

describe('EmptyState', () => {
  it('renders title, description and both actions', () => {
    const add = vi.fn();
    const clear = vi.fn();
    render(
      <EmptyState
        title="No feeds found"
        description="Get started by adding a new feed."
        action={{ label: 'Add feed', onClick: add }}
        secondaryAction={{ label: 'Clear filters', onClick: clear }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No feeds found' })).toBeTruthy();
    expect(screen.getByText('Get started by adding a new feed.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('is announced as an alert and offers one retry', () => {
    const retry = vi.fn();
    render(<ErrorState description="The list could not be loaded." onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain('The list could not be loaded.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
