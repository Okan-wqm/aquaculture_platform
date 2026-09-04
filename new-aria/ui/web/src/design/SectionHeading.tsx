import type { ReactNode } from 'react';
import './SectionHeading.css';

export interface SectionHeadingProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  /** Heading level for the document outline. The page title is the only h1. */
  readonly level?: 2 | 3 | undefined;
  readonly id?: string | undefined;
  /** Drop the hairline rule when the section is already inside a bordered card. */
  readonly plain?: boolean | undefined;
}

/** Small uppercase section label with an optional description and action cluster. */
export function SectionHeading({ title, description, actions, level = 2, id, plain = false }: SectionHeadingProps): ReactNode {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={plain ? 'section-heading section-heading--plain' : 'section-heading'}>
      <div className="section-heading__text">
        <Heading className="section-heading__title" id={id}>
          {title}
        </Heading>
        {description !== undefined ? <span className="section-heading__description">{description}</span> : null}
      </div>
      {actions !== undefined ? <div className="section-heading__actions">{actions}</div> : null}
    </div>
  );
}
