import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  /** What would appear here, named as a thing: "No cycles yet". */
  readonly title?: string | undefined;
  /** One sentence saying why it is empty and what would fill it. */
  readonly message: string;
  readonly action?: ReactNode;
  /** Drop the dashed frame when the state already sits inside a bordered card. */
  readonly flush?: boolean | undefined;
}

/**
 * The empty answer.
 *
 * WHY: "No rows" tells an operator nothing. Every empty state in this console
 * names the thing that is missing and the condition that would produce it, so an
 * empty ledger view is distinguishable from a broken one.
 */
export function EmptyState({ title, message, action, flush = false }: EmptyStateProps): ReactNode {
  return (
    <div className={flush ? 'empty-state empty-state--flush' : 'empty-state'}>
      {title !== undefined ? <span className="empty-state__title">{title}</span> : null}
      <p className="empty-state__message">{message}</p>
      {action !== undefined ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
