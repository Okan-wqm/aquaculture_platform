import type { ReactNode } from 'react';
import type { RequestState } from '../api/use-request.ts';
import { isApiClientError } from '../api/errors.ts';
import { Callout } from './Callout.tsx';
import './AsyncState.css';

export interface AsyncStateProps<T> {
  readonly state: RequestState<T>;
  readonly onRetry?: (() => void) | undefined;
  readonly children: (data: T) => ReactNode;
  /** Keep showing the last successful data while reloading (tables) instead of a spinner. */
  readonly keepStale?: boolean | undefined;
}

export function LoadingBlock({ label = 'Yükleniyor…' }: { readonly label?: string | undefined }): ReactNode {
  return (
    <div className="async-block async-block--loading" role="status" aria-live="polite">
      <span className="async-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { readonly error: Error; readonly onRetry?: (() => void) | undefined }): ReactNode {
  const detail = isApiClientError(error) ? `${error.status} ${error.payload.error}${error.payload.detail !== undefined ? ` — ${error.payload.detail}` : ''}` : error.message;
  return (
    <Callout tone="danger" title="Veri alınamadı" role="alert">
      <p className="mono">{detail}</p>
      {onRetry !== undefined ? (
        <button type="button" className="button" onClick={onRetry}>
          Yeniden dene
        </button>
      ) : null}
    </Callout>
  );
}

export function EmptyBlock({ message }: { readonly message: string }): ReactNode {
  return <div className="async-block async-block--empty">{message}</div>;
}

/** Renders the closed loading/error/success union; the render-prop only ever sees real data. */
export function AsyncState<T>({ state, onRetry, children, keepStale = true }: AsyncStateProps<T>): ReactNode {
  if (state.status === 'success') {
    return children(state.data);
  }
  if (state.status === 'error') {
    return <ErrorBlock error={state.error} onRetry={onRetry} />;
  }
  if (keepStale && state.data !== null) {
    return (
      <div className="async-stale" aria-busy="true">
        {children(state.data)}
      </div>
    );
  }
  return <LoadingBlock />;
}
