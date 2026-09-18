/**
 * ToastProvider / useToast tests
 *
 * The provider owns the single app-wide toast surface (mounted once in the
 * shell); useToast() degrades to legacy per-component state without one.
 */
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ToastProvider, ToastContainer, useToast } from '../useToast';

const Trigger: React.FC<{
  options?: Partial<Parameters<ReturnType<typeof useToast>['toast']>[0]>;
}> = ({ options = {} }) => {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ title: 'Saved', ...options })}>
      fire
    </button>
  );
};

describe('ToastProvider + useToast', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders toasts fired from any descendant into the provider-owned container', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'fire' }));

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shares one toast list between sibling consumers under a single provider', async () => {
    const user = userEvent.setup();
    const Sibling: React.FC = () => {
      const { toasts } = useToast();
      return <span data-testid="count">{toasts.length}</span>;
    };
    render(
      <ToastProvider>
        <Trigger />
        <Sibling />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'fire' }));

    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('announces error toasts assertively (role=alert) and others politely', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger options={{ variant: 'error', title: 'Boom' }} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'fire' }));

    const alertRegion = screen.getByRole('alert');
    expect(alertRegion).toHaveTextContent('Boom');
  });

  it('renders the optional action button and dismisses the toast after invoking it', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ToastProvider>
        <Trigger options={{ action: { label: 'Retry', onClick: onRetry } }} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'fire' }));
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('auto-dismisses after the configured duration', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger options={{ duration: 1000 }} />
      </ToastProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'fire' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1100);
    });

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('degrades to legacy per-component state without a provider (caller renders the container)', async () => {
    const user = userEvent.setup();
    const Legacy: React.FC = () => {
      const { toast, toasts, dismiss } = useToast();
      return (
        <div>
          <button type="button" onClick={() => toast({ title: 'Local' })}>
            fire
          </button>
          <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </div>
      );
    };
    render(<Legacy />);

    await user.click(screen.getByRole('button', { name: 'fire' }));

    expect(screen.getByText('Local')).toBeInTheDocument();
  });
});
