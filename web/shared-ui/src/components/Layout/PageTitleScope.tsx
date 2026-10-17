/**
 * PageTitleScope — who owns the page's h1 (FE-HIGH-334, design handoff README
 * §4: "the h1 in the top bar is the page title").
 *
 * WHY a scope and not a prop: a page has one h1. Outside the tenant console
 * PageHeader's title is that h1, as it always was. Inside the console the
 * header names the page (ConsoleHeading's h1, from the active nav entry), so
 * a PageHeader there must not add a second one — and the same federated page
 * renders under both shells, so no page can be asked to know which one hosts
 * it. The shell says it once, around its `<main>`, and every PageHeader below
 * follows.
 *
 * WHAT: the three ways a page title renders — PageHeader's, and PageTitle's
 * for a page whose title is one control in its own toolbar —
 *  - `heading` (the default, no scope): the title is the page's h1;
 *  - `hidden`: the console's h1 already says it (the location is the nav
 *    entry's own destination) — kept for assistive technology, never drawn;
 *  - `subtitle`: the console's h1 names the parent entry while the page shows
 *    a record under it (a detail or create route) — the record's own name, an
 *    h2 under the console's h1. A plain line left the record (a tank, a
 *    device) with no heading at all, so heading navigation, the main way a
 *    screen-reader user moves through a page, could not find it; the console
 *    h1 stays the only h1.
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

export type PageTitleMode = 'heading' | 'hidden' | 'subtitle';

const PageTitleModeContext = createContext<PageTitleMode>('heading');

export interface PageTitleScopeProps {
  readonly mode: PageTitleMode;
  readonly children: ReactNode;
}

export function PageTitleScope({ mode, children }: PageTitleScopeProps): ReactElement {
  return <PageTitleModeContext.Provider value={mode}>{children}</PageTitleModeContext.Provider>;
}

/** How a PageHeader at this point of the tree renders its title. */
export function usePageTitleMode(): PageTitleMode {
  return useContext(PageTitleModeContext);
}

export interface PageTitleProps {
  readonly children: ReactNode;
  /** The title's face; kept on the visible line in the `subtitle` mode. */
  readonly className?: string;
}

/**
 * The page's title as the enclosing scope says: the h1 outside the console;
 * inside it, read-only text where the console's h1 already says it, and an
 * h2 under that h1 where the page names a record. PageHeader renders its
 * title through it; a page with its own title row (a full-screen tool's
 * toolbar) uses it in place of a bare `<h1>`, so it never adds a second one.
 */
export function PageTitle({ children, className }: PageTitleProps): ReactElement {
  const mode = usePageTitleMode();
  if (mode === 'hidden') return <p className="sr-only">{children}</p>;
  if (mode === 'subtitle') return <h2 className={className}>{children}</h2>;
  return <h1 className={className}>{children}</h1>;
}
