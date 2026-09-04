import type { ReactNode } from 'react';
import './PageHeader.css';

export interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly breadcrumb?: ReactNode;
  /**
   * Sticks to the top of the content column while the page scrolls (default).
   * Set false on a page whose body is one long table with its own sticky header
   * and no `maxHeight`, so the two sticky layers cannot overlap.
   */
  readonly sticky?: boolean | undefined;
}

/** The single h1 of a page, plus its breadcrumb, subtitle and action cluster. */
export function PageHeader({ title, subtitle, actions, breadcrumb, sticky = true }: PageHeaderProps): ReactNode {
  return (
    <header className={sticky ? 'page-header page-header--sticky' : 'page-header'}>
      <div className="page-header__text">
        {breadcrumb !== undefined ? (
          <nav className="page-header__crumb" aria-label="Breadcrumb">
            {breadcrumb}
          </nav>
        ) : null}
        <h1>{title}</h1>
        {subtitle !== undefined ? <div className="page-header__subtitle">{subtitle}</div> : null}
      </div>
      {actions !== undefined ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
