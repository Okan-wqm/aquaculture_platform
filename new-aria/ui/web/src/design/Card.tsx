import type { ReactNode } from 'react';
import './Card.css';

export interface CardProps {
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Removes body padding so a DataTable can bleed to the card edge. */
  readonly flush?: boolean | undefined;
  /** Border accent. Reserved for state, never for emphasis. */
  readonly tone?: 'default' | 'danger' | 'warning' | 'accent' | undefined;
  readonly footer?: ReactNode;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
}

/** Surface container: hairline border, optional header rule, optional footer rule. */
export function Card({ title, subtitle, actions, children, flush = false, tone = 'default', footer, className, id }: CardProps): ReactNode {
  const classes = ['card', flush ? 'card--flush' : '', tone === 'default' ? '' : `card--${tone}`, className ?? '']
    .filter((entry) => entry !== '')
    .join(' ');
  return (
    <section className={classes} id={id}>
      {title !== undefined || actions !== undefined ? (
        <header className="card__header">
          <div className="card__heading">
            {title !== undefined ? <h2 className="card__title">{title}</h2> : null}
            {subtitle !== undefined ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions !== undefined ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
      {footer !== undefined ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}
