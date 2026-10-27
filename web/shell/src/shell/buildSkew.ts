/**
 * Build skew: the decision whether an open console tab reloads (FE-MEDIUM-380, PKG-42).
 *
 * WHY: after a deploy the tab still runs the previous build. Its next lazily loaded page asks
 * for a chunk the server no longer has (the edge answers with index.html), and after a BREAKING
 * GraphQL release its documents fail validation everywhere (ADR-051 C1, C6). The only recovery
 * was a manual reload.
 *
 * WHAT: the tab compares the build it runs (the id in its document) with the build the server
 * serves (build-manifest.json) and reloads when they differ, at a moment no typed input is lost:
 *   - `navigation`: reload at once — the next page is about to load from the old build. A
 *     reload loads the URL the router has just moved to;
 *   - `validation-failure`: reload at once — the page is already failing; asked every time,
 *     inside the interval too, because the failure itself is the evidence;
 *   - `focus`: only learn of the new build. The next navigation reloads without asking again,
 *     so a form the worker left half-filled survives their return to the tab.
 * The server is asked at most once per BUILD_SKEW_CHECK_INTERVAL_MS on focus and navigation,
 * and never twice at once. An unknown build (the dev server's document, an unreadable
 * manifest) never reloads.
 *
 * Once per tab: before reloading toward a build the tab records it in sessionStorage. A tab
 * that comes back still running the old build (an edge or proxy serving a stale document)
 * finds the record and does not reload toward that build again — no reload loop. A tab that
 * arrives on the build clears the record. Without sessionStorage the guard cannot hold, so the
 * tab does not reload at all.
 *
 * Pure: every effect is a dependency, so `__tests__/buildSkew.spec.ts` drives it with doubles;
 * `browserBuildSkewDeps` binds it to the page.
 */
import { BUILD_MANIFEST_FILE, buildIdFromManifest, buildIdOfDocument } from './buildManifest';

export type BuildSkewTrigger = 'focus' | 'navigation' | 'validation-failure';

/** How often focus and navigation may ask the server. */
export const BUILD_SKEW_CHECK_INTERVAL_MS = 30_000;

/** The sessionStorage key recording the build this tab last reloaded toward. */
export const BUILD_SKEW_RELOAD_MARKER = 'aqua.build-skew.reloaded-toward';

export interface BuildSkewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BuildSkewDeps {
  /** The build this tab runs; null when its document names none (the dev server). */
  readonly runningBuildId: string | null;
  /** The build the server serves now; null when it cannot be read. */
  readonly fetchServedBuildId: () => Promise<string | null>;
  readonly reload: () => void;
  readonly now: () => number;
  /** Where the once-per-tab reload record lives; null when the browser refuses storage. */
  readonly storage: BuildSkewStorage | null;
}

export interface BuildSkewMonitor {
  check(trigger: BuildSkewTrigger): Promise<void>;
}

export function createBuildSkewMonitor(deps: BuildSkewDeps): BuildSkewMonitor {
  const { runningBuildId, storage } = deps;
  if (runningBuildId !== null && storage !== null) {
    if (storage.getItem(BUILD_SKEW_RELOAD_MARKER) === runningBuildId) {
      storage.removeItem(BUILD_SKEW_RELOAD_MARKER);
    }
  }

  /** A served build other than the running one, learned on focus and not yet reloaded to. */
  let pendingBuildId: string | null = null;
  let lastAskedAt: number | null = null;
  let inFlight: Promise<string | null> | null = null;

  function askServer(): Promise<string | null> {
    if (inFlight !== null) return inFlight;
    lastAskedAt = deps.now();
    inFlight = deps.fetchServedBuildId().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function mayAsk(trigger: BuildSkewTrigger): boolean {
    if (trigger === 'validation-failure' || lastAskedAt === null) return true;
    return deps.now() - lastAskedAt >= BUILD_SKEW_CHECK_INTERVAL_MS;
  }

  function reloadToward(buildId: string): void {
    if (storage === null || storage.getItem(BUILD_SKEW_RELOAD_MARKER) === buildId) return;
    storage.setItem(BUILD_SKEW_RELOAD_MARKER, buildId);
    deps.reload();
  }

  return {
    async check(trigger: BuildSkewTrigger): Promise<void> {
      if (runningBuildId === null) return;
      if (trigger === 'navigation' && pendingBuildId !== null) {
        reloadToward(pendingBuildId);
        return;
      }
      if (!mayAsk(trigger)) return;
      const servedBuildId = await askServer();
      if (servedBuildId === null || servedBuildId === runningBuildId) return;
      if (trigger === 'focus') {
        pendingBuildId = servedBuildId;
        return;
      }
      reloadToward(servedBuildId);
    },
  };
}

/** The served manifest's build id; null when the request or its body is not a manifest. */
async function fetchServedBuildId(): Promise<string | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}${BUILD_MANIFEST_FILE}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    return buildIdFromManifest(await response.json());
  } catch {
    // Offline, or the edge answered with index.html (not JSON): the served build is unknown,
    // and an unknown build never reloads.
    return null;
  }
}

/** sessionStorage, or null where the browser refuses it (a blocked-storage profile). */
function sessionStorageOrNull(): BuildSkewStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The monitor's dependencies bound to this page. */
export function browserBuildSkewDeps(): BuildSkewDeps {
  return {
    runningBuildId: buildIdOfDocument(document),
    fetchServedBuildId,
    reload: () => {
      window.location.reload();
    },
    now: () => Date.now(),
    storage: sessionStorageOrNull(),
  };
}
