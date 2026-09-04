import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../design/EmptyState.tsx';
import { PageHeader } from '../design/PageHeader.tsx';
import { ROUTES } from './routes.ts';

export function NotFoundPage(): ReactNode {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        title="No view is registered at this address"
        message="This console only renders the routes listed in the sidebar; the address you opened is not one of them."
        action={<Link to={ROUTES.overview}>Back to Overview</Link>}
      />
    </>
  );
}
