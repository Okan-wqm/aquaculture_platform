import { useState, useEffect, useRef } from 'react';

// BUG-15: navigator.onLine returns true whenever any network interface is active,
// even WiFi with no internet routing. This is common in field deployments.
// We use a periodic connectivity probe against the health endpoint to determine
// actual server reachability, with navigator.onLine as a fast "definitely offline" signal.
//
// BUG-17: The probe previously used HEAD /graphql, which returned 503 because the
// GraphQL module only handles POST requests. NestJS Apollo does not respond to HEAD
// by default, and while a middleware workaround existed in the gateway, it was fragile
// (ordering-sensitive, not always deployed). Using the dedicated /health/live liveness
// endpoint is architecturally correct -- it is a lightweight, unauthenticated GET
// endpoint that returns 200 as long as the gateway process is running and the
// supergraph is composed. This also avoids unnecessary load on the GraphQL pipeline.

const PROBE_URL = '/health/live';
const PROBE_INTERVAL_MS = 30_000; // 30 seconds
const PROBE_TIMEOUT_MS = 5_000; // 5 seconds per probe

async function probeConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(PROBE_URL, {
      method: 'GET',
      signal: controller.signal,
      // No credentials/auth — just checking reachability
      cache: 'no-store',
    });
    clearTimeout(timeout);
    // Any HTTP response (including 4xx) means the server is reachable
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

export function useNetworkStatus(): boolean {
  // BUG-15: Removed SSR guard (typeof navigator !== 'undefined') — this is a
  // client-only PWA built with Vite, SSR will never occur.
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // WHY define scheduleProbe inside the effect: it has no external dependency
    // (it closes only over the stable setIsOnline setter and the ref), so the
    // effect's dependency array is genuinely empty — the probe loop owns the
    // network-status lifecycle for the component's whole lifetime. Keeping it
    // local removes the only reason the old code needed a deps-array suppression.
    const scheduleProbe = (delay: number): void => {
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
      // WHY void + inner async: setTimeout expects a void-returning callback, so
      // the async probe runs as a fire-and-forget task explicitly marked with
      // `void` rather than returning a floating Promise to setTimeout.
      probeTimerRef.current = setTimeout(() => {
        void (async (): Promise<void> => {
          const reachable = await probeConnectivity();
          setIsOnline(reachable);
          // Reschedule — probe more frequently when offline to detect reconnection sooner
          scheduleProbe(reachable ? PROBE_INTERVAL_MS : 10_000);
        })();
      }, delay);
    };

    const handleOnline = (): void => {
      // navigator.onLine just became true — probe immediately to confirm
      scheduleProbe(500);
    };

    const handleOffline = (): void => {
      // navigator.onLine went false — we're definitely offline
      setIsOnline(false);
      scheduleProbe(10_000); // keep probing to detect reconnect
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial probe on mount
    scheduleProbe(0);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (probeTimerRef.current) clearTimeout(probeTimerRef.current);
    };
  }, []);

  return isOnline;
}
