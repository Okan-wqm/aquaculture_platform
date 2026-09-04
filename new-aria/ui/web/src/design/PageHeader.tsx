import type { ReactNode } from 'react';
import './PageHeader.css';

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly breadcrumb?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: PageHeaderProps): ReactNode {
  return (
    <header className="page-header">
      <div className="page-header__text">
        {breadcrumb !== undefined ? <nav className="page-header__crumb" aria-label="Konum">{breadcrumb}</nav> : null}
        <h1>{title}</h1>
        {subtitle !== undefined ? <div className="page-header__subtitle">{subtitle}</div> : null}
      </div>
      {actions !== undefined ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
