/**
 * useFeedbackMutation (FE-HIGH-086) — a mutation reports its outcome through
 * the app toast surface by itself; callers' own callbacks still run; a quiet
 * mutation says nothing.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { DEFAULT_MUTATION_ERROR_TITLE, useFeedbackMutation, type FeedbackMutationOptions } from '../useFeedbackMutation';
import { ToastProvider } from '../useToast';

type Options = FeedbackMutationOptions<{ id: string }, Error, { name: string }, unknown>;
type Mutate = (variables: { name: string }) => void;

function Harness({ options, onReady }: { options: Options; onReady: (mutate: Mutate) => void }): ReactElement {
  const mutation = useFeedbackMutation(options);
  onReady(mutation.mutate);
  return <span data-testid="state">{mutation.status}</span>;
}

function mount(options: Options): Mutate {
  let mutate: Mutate = () => undefined;
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Harness options={options} onReady={(m) => { mutate = m; }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return (variables) => mutate(variables);
}

describe('useFeedbackMutation', () => {
  it('toasts the success message built from the result and still runs the caller onSuccess', async () => {
    const onSuccess = vi.fn();
    const mutate = mount({
      mutationFn: async ({ name }) => ({ id: `id-${name}` }),
      feedback: { success: (data, vars) => `${vars.name} saved as ${data.id}` },
      onSuccess,
    });
    act(() => mutate({ name: 'Ada' }));
    await waitFor(() => expect(screen.getByText('Ada saved as id-Ada')).toBeTruthy());
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('toasts an error with the default title and the parsed message, and still runs the caller onError', async () => {
    const onError = vi.fn();
    const mutate = mount({
      mutationFn: async () => { throw new Error('Payroll period is locked'); },
      feedback: { success: 'Payroll approved' },
      onError,
    });
    act(() => mutate({ name: 'x' }));
    await waitFor(() => expect(screen.getByText(DEFAULT_MUTATION_ERROR_TITLE)).toBeTruthy());
    expect(screen.getByText('Payroll period is locked')).toBeTruthy();
    expect(screen.queryByText('Payroll approved')).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('uses a custom error title and says nothing when quiet', async () => {
    const mutate = mount({
      mutationFn: async () => { throw new Error('boom'); },
      feedback: { success: 'Done', error: 'Could not approve' },
    });
    act(() => mutate({ name: 'x' }));
    await waitFor(() => expect(screen.getByText('Could not approve')).toBeTruthy());

    const quiet = mount({
      mutationFn: async () => ({ id: 'q' }),
      feedback: { success: 'Viewed', quiet: true },
    });
    act(() => quiet({ name: 'x' }));
    await waitFor(() => expect(screen.getAllByTestId('state').at(-1)?.textContent).toBe('success'));
    expect(screen.queryByText('Viewed')).toBeNull();
  });

  it('a null success message means the outcome is visible in place: no success toast, errors still speak', async () => {
    const sent = mount({ mutationFn: async () => ({ id: 'm1' }), feedback: { success: null } });
    act(() => sent({ name: 'hello' }));
    await waitFor(() => expect(screen.getAllByTestId('state').at(-1)?.textContent).toBe('success'));
    // Every toast card carries a dismiss control; none rendered means no toast.
    expect(screen.queryByLabelText('Dismiss notification')).toBeNull();

    const failed = mount({ mutationFn: async () => { throw new Error('offline'); }, feedback: { success: null } });
    act(() => failed({ name: 'hello' }));
    await waitFor(() => expect(screen.getByText(DEFAULT_MUTATION_ERROR_TITLE)).toBeTruthy());
  });
});
