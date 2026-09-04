import type { ReactNode } from 'react';
import './Callout.css';

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface CalloutProps {
  readonly tone?: CalloutTone | undefined;
  readonly title?: string | undefined;
  readonly children: ReactNode;
  readonly role?: 'status' | 'alert' | undefined;
}

export function Callout({ tone = 'info', title, children, role }: CalloutProps): ReactNode {
  return (
    <div className={`callout callout--${tone}`} role={role}>
      {title !== undefined ? <strong className="callout__title">{title}</strong> : null}
      <div className="callout__body">{children}</div>
    </div>
  );
}
