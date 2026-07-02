// Fire-and-forget async wrapper — logs failures via the app logger instead
// of letting them become silent unhandled rejections (the pattern this
// replaced: `somePromise.catch(() => undefined)`).

import { describe, it, expect, vi, afterEach } from 'vitest';

import { runAsyncAction, createAsyncActionHandler } from '../async-action';
import { logger } from '../logger';

describe('runAsyncAction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns void synchronously (does not block the caller)', () => {
    const result = runAsyncAction(() => new Promise<void>(() => undefined), 'ctx');
    expect(result).toBeUndefined();
  });

  it('logs via logger.error when the action rejects, tagged with the context', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failure = new Error('network down');

    runAsyncAction(() => Promise.reject(failure), 'my-context');
    await Promise.resolve(); // let the microtask queue flush the rejection handler

    expect(errorSpy).toHaveBeenCalledWith('[my-context] async action failed', failure);
  });

  it('does not log when the action resolves', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    runAsyncAction(() => Promise.resolve(), 'ctx');
    await Promise.resolve();

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('createAsyncActionHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a sync event handler that invokes the async action with the event', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const handler = createAsyncActionHandler<string>(action, 'ctx');

    const result = handler('payload');

    expect(result).toBeUndefined();
    expect(action).toHaveBeenCalledWith('payload');
    await Promise.resolve();
  });

  it('logs failures from the wrapped handler via the context tag', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failure = new Error('mutation failed');
    const action = vi.fn().mockRejectedValue(failure);
    const handler = createAsyncActionHandler<{ id: string }>(action, 'submit-form');

    handler({ id: '1' });
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith('[submit-form] async action failed', failure);
  });
});
