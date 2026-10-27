/**
 * Build skew: the decision whether an open console tab reloads (FE-MEDIUM-380, PKG-42).
 *
 * WHY: after a deploy the tab still runs the previous build of whatever was redeployed — the
 * shell, or one remote: frontend images are built per affected project, and each remote is served
 * by its own container. Its next lazily loaded page asks for a chunk the server no longer has,
 * and after a BREAKING GraphQL release the rebuilt part's old documents fail validation
 * everywhere (ADR-051 C1, C6). The only recovery was a manual reload.
 *
 * WHAT: the tab runs several builds, its parts: the shell (the id in its document) and every
 * remote it has loaded (the id its entry module exports). It compares each part's build with the
 * build the server serves for it (the part's build-manifest.json) and reloads when any differs,
 * at a moment no typed input is lost:
 *   - `navigation`: reload at once — the next page is about to load from an old build. A reload
 *     loads the URL the router has just moved to;
 *   - `validation-failure`: reload at once — the page is already failing; asked every time,
 *     inside the interval too, because the failure itself is the evidence;
 *   - `focus`: only learn of the new build. The next navigation reloads without asking again,
 *     so a form the worker left half-filled survives their return to the tab.
 * The server is asked at most once per BUILD_SKEW_CHECK_INTERVAL_MS on focus and navigation,
 * and never twice at once. A part whose build is unknown (the dev server, a remote built before
 * the id existed, an unreadable manifest) never reloads the tab.
 *
 * Once per target: the target of a reload is the served build of every part that differs.
 * Before reloading toward it the tab records it in sessionStorage; a tab that comes back still
 * differing toward the same target (an edge or proxy serving a stale document or entry) does
 * not reload toward it again — no reload loop. A later deploy names another target and reloads
 * as usual. Without sessionStorage the guard cannot hold, so the tab does not reload at all.
 *
 * Pure: every effect is a dependency, so `__tests__/buildSkew.spec.ts` drives it with doubles;
 * `browserBuildSkewDeps` binds it to the page.
 */
import {
  buildIdFromManifest,
  buildIdOfDocument,
  buildIdOfRemoteEntry,
  buildManifestUrlBeside,
} from '@aquaculture/shared-ui';

import { loadedRemoteEntries, type LoadedRemoteEntry } from './loadedRemoteEntries';

export type BuildSkewTrigger = 'focus' | 'navigation' | 'validation-failure';

/** How often focus and navigation may ask the server. */
export const BUILD_SKEW_CHECK_INTERVAL_MS = 30_000;

/** The sessionStorage key recording the target this tab last reloaded toward. */
export const BUILD_SKEW_RELOAD_MARKER = 'aqua.build-skew.reloaded-toward';

/** One build the tab runs: the shell or a loaded remote. */
export interface RunningBuildPart {
  /** Where the server names the build it serves for this part. */
  readonly manifestUrl: string;
  /** The build of this part the tab runs. */
  readonly buildId: string;
}

export interface BuildSkewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BuildSkewDeps {
  /** The parts this tab runs whose build it knows; none on the dev server. */
  readonly runningParts: () => readonly RunningBuildPart[];
  /** The build the server serves at a part's manifest; null when it cannot be read. */
  readonly fetchServedBuildId: (manifestUrl: string) => Promise<string | null>;
  readonly reload: () => void;
  readonly now: () => number;
  /** Where the once-per-target reload record lives; null when the browser refuses storage. */
  readonly storage: BuildSkewStorage | null;
}

export interface BuildSkewMonitor {
  check(trigger: BuildSkewTrigger): Promise<void>;
}

/** A part and the build the server serves for it (null: unknown). */
interface ServedPart {
  readonly part: RunningBuildPart;
  readonly servedBuildId: string | null;
}

/**
 * The served build of every part that differs from the running one, as one canonical string;
 * null when every part whose served build is known runs it.
 */
function reloadTarget(answers: readonly ServedPart[]): string | null {
  const differing = answers.flatMap(({ part, servedBuildId }) =>
    servedBuildId === null || servedBuildId === part.buildId
      ? []
      : [`${part.manifestUrl}=${servedBuildId}`],
  );
  return differing.length === 0 ? null : differing.sort().join('\n');
}

export function createBuildSkewMonitor(deps: BuildSkewDeps): BuildSkewMonitor {
  const { storage } = deps;

  /** A target learned on focus and not yet reloaded toward. */
  let pendingTarget: string | null = null;
  let lastAskedAt: number | null = null;
  let inFlight: Promise<string | null> | null = null;

  function askServer(parts: readonly RunningBuildPart[]): Promise<string | null> {
    if (inFlight !== null) return inFlight;
    lastAskedAt = deps.now();
    inFlight = Promise.all(
      parts.map(
        async (part): Promise<ServedPart> => ({
          part,
          servedBuildId: await deps.fetchServedBuildId(part.manifestUrl),
        }),
      ),
    )
      .then(reloadTarget)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function mayAsk(trigger: BuildSkewTrigger): boolean {
    if (trigger === 'validation-failure' || lastAskedAt === null) return true;
    return deps.now() - lastAskedAt >= BUILD_SKEW_CHECK_INTERVAL_MS;
  }

  function reloadToward(target: string): void {
    if (storage === null || storage.getItem(BUILD_SKEW_RELOAD_MARKER) === target) return;
    storage.setItem(BUILD_SKEW_RELOAD_MARKER, target);
    deps.reload();
  }

  return {
    async check(trigger: BuildSkewTrigger): Promise<void> {
      if (trigger === 'navigation' && pendingTarget !== null) {
        reloadToward(pendingTarget);
        return;
      }
      const parts = deps.runningParts();
      if (parts.length === 0 || !mayAsk(trigger)) return;
      const target = await askServer(parts);
      if (target === null) return;
      if (trigger === 'focus') {
        pendingTarget = target;
        return;
      }
      reloadToward(target);
    },
  };
}

/** The served manifest's build id; null when the request or its body is not a manifest. */
async function fetchServedBuildId(manifestUrl: string): Promise<string | null> {
  try {
    const response = await fetch(manifestUrl, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    return buildIdFromManifest(await response.json());
  } catch {
    // Offline, or the edge answered with HTML (not JSON): the served build is unknown, and an
    // unknown build never reloads.
    return null;
  }
}

/** The shell's part, when its document names its build. */
function shellPart(documentUrl: string): RunningBuildPart[] {
  const buildId = buildIdOfDocument(document);
  if (buildId === null) return [];
  return [{ manifestUrl: buildManifestUrlBeside(import.meta.env.BASE_URL, documentUrl), buildId }];
}

/** A loaded remote's part, when its entry module exports its build. */
function remotePart(entry: LoadedRemoteEntry, documentUrl: string): RunningBuildPart[] {
  const buildId = buildIdOfRemoteEntry(entry.exports);
  if (buildId === null) return [];
  return [{ manifestUrl: buildManifestUrlBeside(entry.entry, documentUrl), buildId }];
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
    runningParts: () => {
      const documentUrl = window.location.href;
      return [
        ...shellPart(documentUrl),
        ...loadedRemoteEntries().flatMap((entry) => remotePart(entry, documentUrl)),
      ];
    },
    fetchServedBuildId,
    reload: () => {
      window.location.reload();
    },
    now: () => Date.now(),
    storage: sessionStorageOrNull(),
  };
}
