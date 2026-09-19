/**
 * useFeedbackMutation — a mutation that tells the user how it went.
 *
 * WHY: hr, tenant-admin, hydroponics and dashboard used `useToast` zero
 * times — payroll approval, leave approval and clock-in succeeded or failed
 * silently — while farm re-implemented the same two toasts in 45 pages
 * (FE-HIGH-086). Feedback belongs to the hook layer: a mutation declares its
 * outcome messages once, and every caller gets them without wiring a toast.
 *
 * `feedback.success` is required (a mutation with nothing to say is the
 * defect this hook exists to remove); `feedback.error` defaults to a fixed
 * title with the parsed error message as its description. Bookkeeping
 * mutations the user never asked for (mark-as-viewed) pass `quiet: true`.
 * Caller callbacks still run after the toast, so invalidation, cache writes
 * and rollbacks stay where they were.
 */
import { useMutation, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';

import { formatErrorForToast } from './useErrorMessage';
import { useToast } from './useToast';

export interface MutationFeedback<TData, TError, TVariables> {
  /**
   * Success toast title — a string, or a function of the result and the
   * variables. `null` says the outcome is visible where the user is looking
   * (a sent chat message, an added comment): no success toast, errors still
   * speak.
   */
  success: string | ((data: TData, variables: TVariables) => string) | null;
  /** Error toast title; the parsed error message becomes the description. */
  error?: string | ((error: TError, variables: TVariables) => string);
  /** No toasts at all — for background bookkeeping the user never initiated. */
  quiet?: boolean;
}

export type FeedbackMutationOptions<TData, TError, TVariables, TContext> = UseMutationOptions<
  TData,
  TError,
  TVariables,
  TContext
> & {
  feedback: MutationFeedback<TData, TError, TVariables>;
};

export const DEFAULT_MUTATION_ERROR_TITLE = 'The change was not saved';

function resolve<TArgs extends unknown[]>(
  message: string | ((...args: TArgs) => string) | null | undefined,
  ...args: TArgs
): string | undefined {
  if (message === null || message === undefined) return undefined;
  return typeof message === 'function' ? message(...args) : message;
}

export function useFeedbackMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: FeedbackMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const { toast } = useToast();
  const { feedback, onSuccess, onError, ...rest } = options;

  return useMutation<TData, TError, TVariables, TContext>({
    ...rest,
    onSuccess: (...args) => {
      const [data, variables] = args;
      const title = feedback.quiet ? undefined : resolve(feedback.success, data, variables);
      if (title !== undefined) toast({ title, variant: 'success' });
      return onSuccess?.(...args);
    },
    onError: (...args) => {
      const [error, variables] = args;
      if (!feedback.quiet) {
        toast({
          title: resolve(feedback.error, error, variables) ?? DEFAULT_MUTATION_ERROR_TITLE,
          description: formatErrorForToast(error),
          variant: 'error',
        });
      }
      return onError?.(...args);
    },
  });
}
