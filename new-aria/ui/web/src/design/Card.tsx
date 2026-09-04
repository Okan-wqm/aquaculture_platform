import type { ReactNode } from 'react';
import './Card.css';

export interface CardProps {
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly flush?: boolean | undefined;
  readonly className?: string | undefined;
}

/** Surface container. `flush` removes body padding so tables can bleed to the edge. */
export function Card({ title, subtitle, actions, children, flush = false, className }: CardProps): ReactNode {
  const classes = ['card', flush ? 'card--flush' : '', className ?? ''].filter((entry) => entry !== '').join(' ');
  return (
    <section className={classes}>
      {title !== undefined || actions !== undefined ? (
        <header className="card__header">
          <div>
            {title !== undefined ? <h2 className="card__title">{title}</h2> : null}
            {subtitle !== undefined ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions !== undefined ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}
