/**
 * Route-chunk preloading for the microfrontend remotes (E2E-FLAKE).
 *
 * WHY: page routes inside the remotes are `React.lazy` code-split
 * (PERF-HIGH-004), so a sidebar click first lands in the remote's Suspense
 * fallback until the target chunk downloads. Playwright tests (and impatient
 * users) click during exactly that window and time out because the page's
 * buttons are not in the DOM yet. Hovering a sidebar entry is a strong intent
 * signal — the shell uses it to warm the destination chunk so the subsequent
 * click renders the page immediately.
 *
 * HOW: the farm remote exposes a `preloadFarmRoute(path)` named export next to
 * its default component (Module Federation exposes the whole module namespace,
 * so named exports cross the remote boundary). Importing `farmModule/Module`
 * here resolves to the SAME module instance App.tsx's `lazy()` already uses —
 * when the user navigates, React.lazy's loader and this preload share one
 * chunk fetch. Other remotes can grow the same contract; until then their
 * paths simply do not match and preload nothing.
 */

export function preloadRoute(path: string): void {
  // Only the farm remote publishes a preload manifest today; anything else is
  // a no-op so the prop stays safe to wire to every sidebar entry.
  if (!path.startsWith('/sites/')) return;

  void import('farmModule/Module')
    .then((remote) => remote.preloadFarmRoute(path))
    .catch(() => {
      /* Speculative fetch: a remote that fails to load here must not surface
         as an unhandled rejection — the real navigation retries and reports
         through its Suspense/ErrorBoundary path. */
    });
}

export default preloadRoute;
