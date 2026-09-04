// Declarative data-fetching hook used by every page.
//
// WHY: loading / error / success must be modelled as a closed union so a page
// cannot accidentally render `undefined` data; stale responses from a previous
// dependency set must be ignored (request race); and a 401 must clear the token
// so the router guard sends the operator back to login from ANY page.
// WHAT: useRequest(fetcher, deps) → { state, reload }. The fetcher receives an
// AbortSignal that is aborted on unmount / dependency change.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiClientError, toError } from './errors.ts';
import { clearToken } from './token-store.ts';

export type RequestState<T> =
  | { readonly status: 'loading'; readonly data: T | null }
  | { readonly status: 'error'; readonly error: Error; readonly data: T | null }
  | { readonly status: 'success'; readonly data: T };

export interface UseRequestResult<T> {
  readonly state: RequestState<T>;
  readonly reload: () => void;
}

export function useRequest<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: ReadonlyArray<unknown>): UseRequestResult<T> {
  const [state, setState] = useState<RequestState<T>>({ status: 'loading', data: null });
  const [version, setVersion] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState((previous) => ({ status: 'loading', data: previous.data }));
    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (active) {
          setState({ status: 'success', data });
        }
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }
        const error = toError(reason);
        if (isApiClientError(error) && error.isUnauthorized) {
          clearToken();
        }
        setState((previous) => ({ status: 'error', error, data: previous.data }));
      });
    return () => {
      active = false;
      controller.abort();
    };
    // The dependency list is supplied by the caller; `version` forces a reload.
  }, [...deps, version]);

  const reload = useCallback(() => {
    setVersion((current) => current + 1);
  }, []);

  return { state, reload };
}
