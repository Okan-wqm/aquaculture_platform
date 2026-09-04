import type { ReactNode } from 'react';

export interface ToolbarProps {
  readonly children: ReactNode;
  /** `center` aligns mixed controls on one baseline; `end` is for label-over-field rows. */
  readonly align?: 'center' | 'end' | undefined;
  readonly className?: string | undefined;
}

/** Control strip above a table or inside a card header. Styles live in base.css. */
export function Toolbar({ children, align = 'center', className }: ToolbarProps): ReactNode {
  const classes = ['toolbar', align === 'center' ? 'toolbar--center' : '', className ?? ''].filter((entry) => entry !== '').join(' ');
  return <div className={classes}>{children}</div>;
}

/** Pushes everything after it to the right edge of a Toolbar. */
export function ToolbarSpacer(): ReactNode {
  return <span className="toolbar__spacer" />;
}
