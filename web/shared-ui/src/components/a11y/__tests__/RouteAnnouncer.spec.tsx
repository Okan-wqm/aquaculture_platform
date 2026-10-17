/**
 * RouteAnnouncer + usePageTitle — the page's identity (FE-HIGH-017, WCAG
 * 2.4.2 Page Titled, 4.1.3 Status Messages).
 *
 * The frame that draws a page names it (the console from its nav entry, an
 * auth form from its heading); the provider turns that name into the
 * document title and announces it on every navigation — path or query — in
 * the reader's language, never an English sentence built from the URL.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, type ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RouteAnnouncer, usePageTitle } from '../RouteAnnouncer';

const APP_NAME = 'Aquaculture Platform';

/** A frame that names each page the way the console does: from its location. */
function Frame({ titles }: { titles: Readonly<Record<string, string>> }): ReactElement {
  const { pathname, search } = useLocation();
  usePageTitle(titles[`${pathname}${search}`] ?? '');
  return <p>page</p>;
}

let navigate: NavigateFunction = () => undefined;
function Navigator(): null {
  const go = useNavigate();
  useEffect(() => {
    navigate = go;
  }, [go]);
  return null;
}

/** What the shell does: the router's path and query, handed to the announcer. */
function Announced({ titles }: { titles: Readonly<Record<string, string>> }): ReactElement {
  const { pathname, search } = useLocation();
  return (
    <RouteAnnouncer location={`${pathname}${search}`}>
      <Navigator />
      <Frame titles={titles} />
    </RouteAnnouncer>
  );
}

function renderApp(titles: Readonly<Record<string, string>>, at = '/sites/feeding'): void {
  render(
    <MemoryRouter initialEntries={[at]}>
      <Announced titles={titles} />
    </MemoryRouter>,
  );
}

function go(to: string): void {
  act(() => {
    void navigate(to);
  });
}

function region(): HTMLElement {
  return screen.getByRole('status');
}

const TITLES = {
  '/sites/feeding': 'Feeding · Production',
  '/sites/feeding?tab=records': 'Records · Feeding · Production',
  '/sites/tanks': 'Tanks & ponds · Production',
  '/sites/tanks/t-1': 'Tanks & ponds · Production',
};

beforeEach(() => {
  document.title = APP_NAME;
});
afterEach(cleanup);

describe('RouteAnnouncer — the document title', () => {
  it('names the document after the page, then the app', () => {
    renderApp(TITLES);
    expect(document.title).toBe(`Feeding · Production · ${APP_NAME}`);
    go('/sites/tanks');
    expect(document.title).toBe(`Tanks & ponds · Production · ${APP_NAME}`);
  });

  it('falls back to the app name where no frame names the page, and on unmount', () => {
    renderApp(TITLES, '/nowhere');
    expect(document.title).toBe(APP_NAME);
    go('/sites/feeding');
    expect(document.title).toBe(`Feeding · Production · ${APP_NAME}`);
    cleanup();
    expect(document.title).toBe(APP_NAME);
  });
});

describe('RouteAnnouncer — the announcement', () => {
  it('is a polite status region in the page from the start, silent on the first page', () => {
    renderApp(TITLES);
    expect(region()).not.toHaveAttribute('aria-live', 'assertive');
    expect(region()).toHaveClass('sr-only');
    expect(region()).toHaveTextContent('');
  });

  it('announces the page the frame names when the path changes', () => {
    renderApp(TITLES);
    go('/sites/tanks');
    expect(region()).toHaveTextContent('Tanks & ponds · Production');
  });

  // Rail tabs, palette tab entries and annunciator filters only change the query.
  it('announces a change of the query alone, such as a tab', () => {
    renderApp(TITLES);
    go('/sites/feeding?tab=records');
    expect(region()).toHaveTextContent('Records · Feeding · Production');
  });

  it('announces again when a new location carries the same name', () => {
    renderApp(TITLES, '/sites/tanks');
    go('/sites/feeding');
    go('/sites/tanks');
    const first = region().firstElementChild;
    go('/sites/tanks/t-1');
    expect(region()).toHaveTextContent('Tanks & ponds · Production');
    // A new node: a screen reader reads an addition, not an unchanged text.
    expect(region().firstElementChild).not.toBe(first);
  });

  it('builds no sentence from the URL: an unnamed page announces nothing', () => {
    renderApp(TITLES);
    go('/sites/water-chemistry');
    expect(region()).toHaveTextContent('');
    expect(region().textContent).not.toMatch(/Navigated/);
  });
});

describe('usePageTitle — without the provider', () => {
  it('does nothing (a frame rendered alone in a test or a story)', () => {
    function Alone(): ReactElement {
      usePageTitle('Feeding');
      return <p>alone</p>;
    }
    render(<Alone />);
    expect(document.title).toBe(APP_NAME);
  });
});
