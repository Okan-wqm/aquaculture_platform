import type { ReactNode } from 'react';
import type { RequestState } from '../api/use-request.ts';
import { isApiClientError } from '../api/errors.ts';
import { Callout } from './Callout.tsx';
import { EmptyState } from './EmptyState.tsx';
import { Skeleton } from './Skeleton.tsx';
import './AsyncState.css';

/** The shape the loading placeholder should imitate. */
export type SkeletonShape = 'text' | 'table' | 'stats' | 'cards' | 'detail';

export interface AsyncStateProps<T> {
  readonly state: RequestState<T>;
  readonly onRetry?: (() => void) | undefined;
  readonly children: (data: T) => ReactNode;
  /** Keep showing the last successful data while reloading instead of a skeleton. */
  readonly keepStale?: boolean | undefined;
  /** Placeholder shape while the first response is in flight. Default `text`. */
  readonly skeleton?: SkeletonShape | undefined;
  /** Row / tile count for the placeholder. Default 6. */
  readonly skeletonRows?: number | undefined;
  /** Overrides the failure headline, e.g. "Could not load cycles". */
  readonly errorTitle?: string | undefined;
}

const CELL_WIDTHS = ['22%', '14%', '18%', '12%', '16%'];

function TableSkeleton({ rows }: { readonly rows: number }): ReactNode {
  return (
    <div className="async-skeleton__table">
      <div className="async-skeleton__head">
        {CELL_WIDTHS.map((width) => (
          <span key={width} className="async-skeleton__cell">
            <Skeleton height="8px" width={width} />
          </span>
        ))}
      </div>
      {Array.from({ length: rows }, (_unused, rowIndex) => (
        <div className="async-skeleton__row" key={rowIndex}>
          {CELL_WIDTHS.map((width, cellIndex) => (
            <span key={width} className="async-skeleton__cell">
              <Skeleton height="10px" width={cellIndex === 0 ? '86%' : width} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function ShapeSkeleton({ shape, rows }: { readonly shape: SkeletonShape; readonly rows: number }): ReactNode {
  if (shape === 'table') {
    return <TableSkeleton rows={rows} />;
  }
  if (shape === 'stats') {
    return (
      <div className="async-skeleton__stats">
        {Array.from({ length: Math.max(2, Math.min(rows, 8)) }, (_unused, index) => (
          <div className="async-skeleton__tile" key={index}>
            <Skeleton height="8px" width="52%" />
            <Skeleton height="20px" width="64%" />
          </div>
        ))}
      </div>
    );
  }
  if (shape === 'cards') {
    return (
      <div className="async-skeleton__cards">
        {Array.from({ length: Math.max(1, Math.min(rows, 4)) }, (_unused, index) => (
          <div className="async-skeleton__card" key={index}>
            <Skeleton height="12px" width="38%" />
            <Skeleton height="10px" width="88%" />
            <Skeleton height="10px" width="72%" />
          </div>
        ))}
      </div>
    );
  }
  if (shape === 'detail') {
    return (
      <div className="async-skeleton__detail">
        {Array.from({ length: rows }, (_unused, index) => (
          <span key={index} style={{ display: 'contents' }}>
            <Skeleton height="8px" width="70%" />
            <Skeleton height="10px" width={index % 2 === 0 ? '48%' : '64%'} />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="async-skeleton__text">
      {Array.from({ length: rows }, (_unused, index) => (
        <Skeleton key={index} height="10px" width={index === rows - 1 ? '54%' : '100%'} />
      ))}
    </div>
  );
}

export interface LoadingBlockProps {
  /** Screen-reader announcement while the placeholder is on screen. */
  readonly label?: string | undefined;
  readonly shape?: SkeletonShape | undefined;
  readonly rows?: number | undefined;
}

/** Skeleton placeholder shaped like the content that is coming. */
export function LoadingBlock({ label = 'Loading…', shape = 'text', rows = 6 }: LoadingBlockProps): ReactNode {
  return (
    <div className="async-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      <ShapeSkeleton shape={shape} rows={Math.max(1, rows)} />
    </div>
  );
}

export interface ErrorBlockProps {
  readonly error: Error;
  readonly onRetry?: (() => void) | undefined;
  /** What failed, in the caller's words: "Could not load findings". */
  readonly title?: string | undefined;
}

/** Failure state: what failed, the server's own words, and what to try next. */
export function ErrorBlock({ error, onRetry, title = 'Could not load this view' }: ErrorBlockProps): ReactNode {
  const detail = isApiClientError(error)
    ? `${error.status} ${error.payload.error}${error.payload.detail !== undefined ? ` — ${error.payload.detail}` : ''}`
    : error.message;
  const advice = isApiClientError(error)
    ? 'The projection server answered, but not with data. Check that ARIA_TOOLS_DIR points at the ledgers this view reads.'
    : 'The projection server could not be reached. Check that it is running, then try again.';
  return (
    <Callout tone="danger" title={title} role="alert">
      <p className="mono">{detail}</p>
      <p>{advice}</p>
      {onRetry !== undefined ? (
        <p>
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </Callout>
  );
}

export interface EmptyBlockProps {
  /** One sentence: what would appear here, and why it is empty. */
  readonly message: string;
  readonly title?: string | undefined;
  readonly action?: ReactNode;
  readonly flush?: boolean | undefined;
}

/** Empty state used inside tables and cards. */
export function EmptyBlock({ message, title, action, flush }: EmptyBlockProps): ReactNode {
  return <EmptyState message={message} title={title} action={action} flush={flush} />;
}

/**
 * Renders the closed loading / error / success union.
 *
 * WHY: the render-prop only ever sees real data, so no page can reach into a
 * half-loaded response; and every page gets the same three states without
 * re-inventing them.
 */
export function AsyncState<T>({
  state,
  onRetry,
  children,
  keepStale = true,
  skeleton = 'text',
  skeletonRows = 6,
  errorTitle,
}: AsyncStateProps<T>): ReactNode {
  if (state.status === 'success') {
    return children(state.data);
  }
  if (state.status === 'error') {
    return <ErrorBlock error={state.error} onRetry={onRetry} title={errorTitle} />;
  }
  if (keepStale && state.data !== null) {
    return (
      <div className="async-stale" aria-busy="true">
        {children(state.data)}
      </div>
    );
  }
  return <LoadingBlock shape={skeleton} rows={skeletonRows} />;
}
