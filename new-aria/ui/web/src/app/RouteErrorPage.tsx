import type { ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { toError } from '../api/errors.ts';
import { Callout } from '../design/Callout.tsx';
import { MonoPanel } from '../design/MonoPanel.tsx';
import { ROUTES } from './routes.ts';

/** Router-level error boundary: a render crash shows the reason instead of a blank page. */
export function RouteErrorPage(): ReactNode {
  const raw = useRouteError();
  const message = isRouteErrorResponse(raw) ? `${raw.status} ${raw.statusText}` : toError(raw).message;
  const stack = raw instanceof Error && raw.stack !== undefined ? raw.stack : '';
  return (
    <main className="content" id="main">
      <h1>Beklenmeyen hata</h1>
      <Callout tone="danger" role="alert">
        <p>{message}</p>
        <Link to={ROUTES.overview}>Genel bakışa dön</Link>
      </Callout>
      {stack !== '' ? <MonoPanel label="stack" text={stack} tone="error" /> : null}
    </main>
  );
}
