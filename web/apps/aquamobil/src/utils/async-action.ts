import { logger } from './logger';

export function runAsyncAction(action: () => Promise<void>, context: string): void {
  action().catch((error: unknown) => {
    logger.error(`[${context}] async action failed`, error);
  });
}

export function createAsyncActionHandler<TEvent>(
  action: (event: TEvent) => Promise<void>,
  context: string,
): (event: TEvent) => void {
  return (event: TEvent): void => {
    runAsyncAction(() => action(event), context);
  };
}
