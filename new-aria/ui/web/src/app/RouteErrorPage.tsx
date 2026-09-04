import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { toError } from '../api/errors.ts';
import { Callout } from '../design/Callout.tsx';
import { MonoPanel } from '../design/MonoPanel.tsx';
import { PageHeader } from '../design/PageHeader.tsx';
import { ROUTES } from './routes.ts';

/** Router-level error boundary: a render crash shows its reason instead of a blank page. */
export function RouteErrorPage(): ReactNode {
  const raw = useRouteError();
  const message = isRouteErrorResponse(raw) ? `${raw.status} ${raw.statusText}` : toError(raw).message;
  const stack = raw instanceof Error && raw.stack !== undefined ? raw.stack : '';
  return (
    <main className="content" id="main">
      <div className="content__column stack">
        <PageHeader title="Unexpected error" sticky={false} />
        <Callout tone="danger" title="This view stopped rendering" role="alert">
          <p className="mono">{message}</p>
          <p>
            The console state is not lost. <Link to={ROUTES.overview}>Back to Overview</Link>, and reload the page if the
            same view fails again.
          </p>
        </Callout>
        {stack !== '' ? <MonoPanel label="stack" text={stack} tone="error" maxHeight="lg" /> : null}
      </div>
    </main>
  );
}
