/**
 * RailLink — a rail row that is a real link (digest §3.5).
 *
 * WHY an anchor and not a button: a destination the browser can see is one a
 * middle click, Ctrl/⌘-click or "open in new tab" can take, and one assistive
 * technology announces as a link. The host stays the router: a plain primary
 * click is handed to `onNavigate` (client-side navigation, no reload), the
 * same test react-router's Link applies; every other click is the browser's.
 *
 * Hover reports the destination (`onHover`) so the shell can preload the
 * route's chunk before the click lands (E2E-FLAKE, routePreload.ts).
 */
import type { MouseEvent, ReactElement, ReactNode } from 'react';

export interface RailLinkProps {
  readonly href: string;
  readonly onNavigate: (path: string) => void;
  readonly onHover?: (path: string) => void;
  readonly className: string;
  readonly 'aria-current'?: 'page' | 'true';
  readonly children: ReactNode;
}

/** A click the browser should handle itself: modified, non-primary, or already handled. */
function isBrowserClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function RailLink({
  href,
  onNavigate,
  onHover,
  className,
  'aria-current': ariaCurrent,
  children,
}: RailLinkProps): ReactElement {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (isBrowserClick(event)) return;
    event.preventDefault();
    onNavigate(href);
  };

  return (
    <a
      href={href}
      aria-current={ariaCurrent}
      onClick={handleClick}
      onMouseEnter={onHover === undefined ? undefined : () => onHover(href)}
      className={className}
    >
      {children}
    </a>
  );
}
