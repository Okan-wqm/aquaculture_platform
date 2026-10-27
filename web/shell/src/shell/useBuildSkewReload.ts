/**
 * useBuildSkewReload — an open console tab reloads onto a newly deployed build
 * (FE-MEDIUM-380, PKG-42).
 *
 * WHY: the shell never knew which build a tab ran, so after a deploy the old tab broke on its
 * next lazily loaded page or, after a BREAKING GraphQL release, on every query, until the user
 * reloaded by hand (ADR-051 C1, C6).
 *
 * WHAT: wires buildSkew.ts's monitor (the decision) to the three moments the plan names:
 *   - the tab regaining focus (`focus` on window, `visibilitychange` to visible);
 *   - a navigation (the router's pathname changing; the first render is not one);
 *   - a GraphQL validation failure, which shared-ui's clients report through one signal — a
 *     federation singleton, so a failure in any remote reaches this listener.
 * Mounted once, by App, inside the router.
 */
import { onGraphqlValidationFailure } from '@aquaculture/shared-ui';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { browserBuildSkewDeps, createBuildSkewMonitor, type BuildSkewMonitor } from './buildSkew';

export function useBuildSkewReload(): void {
  const [monitor] = useState<BuildSkewMonitor>(() =>
    createBuildSkewMonitor(browserBuildSkewDeps()),
  );
  const { pathname } = useLocation();
  const lastPathname = useRef(pathname);

  useEffect(() => {
    const onFocus = (): void => {
      void monitor.check('focus');
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') void monitor.check('focus');
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unsubscribe = onGraphqlValidationFailure(() => {
      void monitor.check('validation-failure');
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
    };
  }, [monitor]);

  useEffect(() => {
    if (lastPathname.current === pathname) return;
    lastPathname.current = pathname;
    void monitor.check('navigation');
  }, [monitor, pathname]);
}
