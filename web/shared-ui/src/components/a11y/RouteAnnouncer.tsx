/**
 * RouteAnnouncer — the page's identity: the document title and the
 * announcement of every navigation (FE-HIGH-017; WCAG 2.4.2 Page Titled,
 * 4.1.3 Status Messages).
 *
 * WHY the frames name the page: only the frame that draws a page knows its
 * name — the tenant console from its nav entry (page, tab, workspace, all
 * localized), the admin console from its navigation, an auth form from its
 * heading — never the router. The announcer this replaces built an English
 * sentence from the path segments ("Navigated to Sites Environment") whatever
 * the locale, stayed silent on a change of the query alone (`?tab=`, the
 * annunciator's `?priority=`), and nothing set the document title, so every
 * page was the index.html "Aquaculture Platform".
 *
 * WHAT: wrap the routes once and pass the router's location (path + query;
 * the primitive takes it as a value, so it binds to no router instance). A
 * frame calls usePageTitle(name). The provider sets `document.title` to
 * "name · app name" (the app name is the title index.html gave the document)
 * and, on each navigation — path or query — announces the name in a polite
 * status region that is in the page from the start (a region inserted with
 * its text is not read). The first page is not announced: the screen reader
 * reads a newly loaded document's title itself. A location no frame names
 * announces nothing and shows the app name alone.
 *
 * @example
 * const { pathname, search } = useLocation();
 * <RouteAnnouncer location={`${pathname}${search}`}>
 *   <Routes>…</Routes>
 * </RouteAnnouncer>
 * // in a frame: usePageTitle(t('nav.feeding'));
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface RouteAnnouncerProps {
  /** The current path and query; a change is a navigation, and is announced. */
  readonly location: string;
  /** The routes whose frames name their pages. */
  readonly children: ReactNode;
}

interface PageIdentity {
  /** The page's localized name; '' when the frame names none. */
  readonly setTitle: (title: string) => void;
}

const PageIdentityContext = createContext<PageIdentity | null>(null);

interface Announcement {
  readonly text: string;
  /** A new node per announcement, so the same name on a new page is read again. */
  readonly id: number;
}

export function RouteAnnouncer({ location, children }: RouteAnnouncerProps): ReactElement {
  const [appName] = useState(() => document.title);
  const title = useRef('');
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  const identity = useMemo(
    (): PageIdentity => ({
      setTitle: (next: string): void => {
        title.current = next;
        document.title = next === '' ? appName : `${next} · ${appName}`;
      },
    }),
    [appName],
  );

  // A parent's effects run after its children's in the same commit, so the
  // frame below has already named the page this location shows.
  const announcedAt = useRef<string | null>(null);
  useEffect(() => {
    if (announcedAt.current === location) return;
    const firstPage = announcedAt.current === null;
    announcedAt.current = location;
    if (firstPage || title.current === '') return;
    const text = title.current;
    setAnnouncement((previous) => ({ text, id: previous === null ? 1 : previous.id + 1 }));
  }, [location]);

  useEffect(
    () => () => {
      document.title = appName;
    },
    [appName],
  );

  return (
    <PageIdentityContext.Provider value={identity}>
      <div role="status" className="sr-only">
        {announcement !== null && <span key={announcement.id}>{announcement.text}</span>}
      </div>
      {children}
    </PageIdentityContext.Provider>
  );
}

/**
 * Names the page the calling frame draws: the document title, and what the
 * next navigation announces. Pass the localized name; '' names none. Outside
 * a RouteAnnouncer it does nothing.
 */
export function usePageTitle(title: string): void {
  const identity = useContext(PageIdentityContext);
  useEffect(() => {
    if (identity === null) return undefined;
    identity.setTitle(title);
    return () => identity.setTitle('');
  }, [identity, title]);
}
