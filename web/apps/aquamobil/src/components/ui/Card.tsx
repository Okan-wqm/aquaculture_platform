/**
 * Card — the v4 surface primitive.
 *
 * "Content sits on rounded cards two tones above the ground, with real shadows.
 * Dividers survive only inside a card." That sentence is the whole layout system:
 * depth comes from the surface ramp plus a real shadow, not from an outline, and
 * a hairline is only ever a divider BETWEEN rows of one card — never a box drawn
 * around content.
 *
 * WHY a component rather than a class string: the pre-v4 app repeated a
 * six-class surface incantation — white/near-black background, a rounded corner,
 * a card shadow and a hairline border, each with its own theme variant — in
 * dozens of files, drifting a little every time. One import now owns elevation,
 * radius and the theme response.
 */
import { clsx } from 'clsx';
import { type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * `1` — the default content surface, one tone above the ground.
   * `2` — a card nested inside another card, or a control well (segmented
   *   controls, keypads) that must read as recessed rather than raised.
   */
  tone?: 1 | 2;
  /** Cards carry the theme shadow by default; drop it when nesting inside one. */
  elevated?: boolean;
  children: ReactNode;
}

export function Card({
  tone = 1,
  elevated = true,
  className,
  children,
  ...rest
}: CardProps): ReactElement {
  return (
    <div
      className={twMerge(
        clsx(
          'rounded-2xl border border-line',
          tone === 1 ? 'bg-surface-1' : 'bg-surface-2',
          elevated && 'shadow-token',
        ),
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The hairline between rows of a single card. Deliberately exported alongside
 * Card so the "dividers only inside a card" rule has an obvious implementation
 * and nobody reaches for a bare `border-t` on a page-level element.
 */
export function CardDivider(): ReactElement {
  return <div className="h-px bg-line" role="presentation" />;
}
